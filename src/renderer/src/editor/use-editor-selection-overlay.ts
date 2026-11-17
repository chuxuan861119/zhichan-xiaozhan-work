import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

export type EditorSelectionOverlayTone = "active" | "background";

type SelectionRectangle = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

function selectedDomRange(editor: Editor): Range | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const start = editor.view.domAtPos(from);
  const end = editor.view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

export function selectedTextClientRects(editor: Editor, lineHeightScale?: number): DOMRect[] {
  const selectionRange = selectedDomRange(editor);
  if (!selectionRange) return [];
  const rectangles: DOMRect[] = [];
  const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current.textContent && selectionRange.intersectsNode(current)) {
      const textRange = document.createRange();
      textRange.selectNodeContents(current);
      if (selectionRange.startContainer === current) {
        textRange.setStart(current, selectionRange.startOffset);
      }
      if (selectionRange.endContainer === current) {
        textRange.setEnd(current, selectionRange.endOffset);
      }
      if (!textRange.collapsed) {
        // Read from the text's owner, not hit testing: mirrored lines can be offscreen.
        const lineHeight =
          lineHeightScale !== undefined && current.parentElement
            ? Number.parseFloat(getComputedStyle(current.parentElement).lineHeight) *
              lineHeightScale
            : Number.NaN;
        for (const rect of textRange.getClientRects()) {
          rectangles.push(
            Number.isFinite(lineHeight) && lineHeight > rect.height
              ? DOMRect.fromRect({
                  x: rect.left,
                  y: rect.top - (lineHeight - rect.height) / 2,
                  width: rect.width,
                  height: lineHeight,
                })
              : rect,
          );
        }
      }
    }
    current = walker.nextNode();
  }
  return rectangles;
}

function lineBox(rectangle: DOMRect, scale: number): DOMRect {
  const element = document.elementFromPoint?.(
    Math.min(rectangle.right - 1, rectangle.left + 1),
    rectangle.top + rectangle.height / 2,
  );
  const lineHeight = element
    ? Number.parseFloat(getComputedStyle(element).lineHeight) * scale
    : Number.NaN;
  if (!Number.isFinite(lineHeight) || lineHeight <= rectangle.height) return rectangle;
  return DOMRect.fromRect({
    x: rectangle.left,
    y: rectangle.top - (lineHeight - rectangle.height) / 2,
    width: rectangle.width,
    height: lineHeight,
  });
}

function selectionRectangles(editor: Editor, host: HTMLElement): SelectionRectangle[] {
  const hostRectangle = host.getBoundingClientRect();
  const scale =
    host.offsetWidth > 0 && hostRectangle.width > 0 ? hostRectangle.width / host.offsetWidth : 1;
  return selectedTextClientRects(editor)
    .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
    .map((rectangle) => lineBox(rectangle, scale))
    .map((rectangle) => ({
      left: (rectangle.left - hostRectangle.left) / scale,
      top: (rectangle.top - hostRectangle.top) / scale,
      width: rectangle.width / scale,
      height: rectangle.height / scale,
    }));
}

export function useEditorSelectionOverlay({
  editor,
  enabled,
  tone,
}: {
  editor: Editor | null;
  enabled: boolean;
  tone: EditorSelectionOverlayTone;
}): void {
  useEffect(() => {
    if (!editor || editor.isDestroyed || !enabled) return undefined;
    const host = editor.view.dom.parentElement;
    if (!host) return undefined;
    const layer = document.createElement("div");
    layer.className = "editor-selection-overlay";
    layer.dataset.tone = tone;
    layer.setAttribute("aria-hidden", "true");
    host.classList.add("editor-selection-overlay-host");
    host.prepend(layer);
    let animationFrame = 0;

    const render = () => {
      animationFrame = 0;
      if (editor.isDestroyed || editor.view.hasFocus()) {
        layer.hidden = true;
        return;
      }
      const rectangles = selectionRectangles(editor, host);
      layer.replaceChildren(
        ...rectangles.map((rectangle) => {
          const element = document.createElement("span");
          element.className = "editor-selection-overlay__rect";
          element.style.left = `${rectangle.left}px`;
          element.style.top = `${rectangle.top}px`;
          element.style.width = `${rectangle.width}px`;
          element.style.height = `${rectangle.height}px`;
          return element;
        }),
      );
      layer.hidden = rectangles.length === 0;
    };
    const schedule = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(render);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(editor.view.dom);
    editor.on("focus", schedule);
    editor.on("blur", schedule);
    editor.on("transaction", schedule);
    document.addEventListener("focusin", schedule, true);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      editor.off("focus", schedule);
      editor.off("blur", schedule);
      editor.off("transaction", schedule);
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      layer.remove();
      if (!host.querySelector(".editor-selection-overlay")) {
        host.classList.remove("editor-selection-overlay-host");
      }
    };
  }, [editor, enabled, tone]);
}
