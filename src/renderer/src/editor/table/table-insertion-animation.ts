import type { Editor } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import {
  FIXED_MOTION_DURATIONS,
  keyframeMotionTiming,
  SPATIAL_MOTION_TIMING,
  synchronizePaintTimings,
} from "../../shared/spatial-motion";
import { tableElement } from "./table-insertion-feedback";

const active = new WeakMap<Editor, () => void>();
const tableEasing = "cubic-bezier(0.4, 0, 0.2, 1)";
// Only layout/paint properties used by document content. Enumerating every browser
// property on every node makes an ordinary table block the click for hundreds of ms.
const paintProperties = [
  "display",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin",
  "padding",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "table-layout",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "color",
  "background-color",
  "text-align",
  "vertical-align",
  "text-indent",
  "white-space",
  "overflow-wrap",
  "word-break",
  "letter-spacing",
  "text-decoration",
  "overflow",
  "object-fit",
  "object-position",
] as const;

export function isTableInsertionAnimating(editor: Editor): boolean {
  return active.has(editor);
}

// Freeze paint outside the editor: never change the live border model or scale strokes.
function paintCopy(table: HTMLTableElement): HTMLTableElement {
  const copy = table.cloneNode(true) as HTMLTableElement;
  const originals = [table, ...table.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  originals.forEach((source, i) => {
    const target = copies[i];
    if (!target) return;
    // Widgets are removed from the copy; do not compute or serialize their styles.
    if (source.closest(".ProseMirror-widget")) return;
    const style = getComputedStyle(source);
    target.style.cssText += paintProperties
      .map((property) => `${property}:${style.getPropertyValue(property)};`)
      .join("");
    target.removeAttribute("id");
    target.removeAttribute("contenteditable");
  });
  copy.querySelectorAll(".ProseMirror-widget").forEach((node) => {
    node.remove();
  });
  copy.style.margin = "0";
  copy.style.position = "static";
  return copy;
}

function paintViewport(table: HTMLTableElement) {
  const visible = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
  for (let parent = table.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const box = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      visible.left = Math.max(visible.left, box.left);
      visible.right = Math.min(visible.right, box.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      visible.top = Math.max(visible.top, box.top);
      visible.bottom = Math.min(visible.bottom, box.bottom);
    }
  }
  return visible;
}

export function prepareTableInsertionAnimation(
  editor: Editor,
  tableFrom: number,
  axis: "row" | "column",
  index: number,
): () => void {
  return prepareTableSectionAnimation(editor, tableFrom, axis, index);
}

export function prepareTableDeletionAnimation(
  editor: Editor,
  tableFrom: number,
  axis: "row" | "column",
  from: number,
  to: number,
): () => void {
  return prepareTableSectionAnimation(editor, tableFrom, axis, from, to);
}

function prepareTableSectionAnimation(
  editor: Editor,
  tableFrom: number,
  axis: "row" | "column",
  index: number,
  deletionEnd?: number,
): () => void {
  active.get(editor)?.();
  const table = tableElement(editor, tableFrom);
  if (!table || typeof table.animate !== "function" || isMotionReduced()) return () => {};
  const oldBounds = table.getBoundingClientRect();
  const deleting = deletionEnd !== undefined;
  const oldTracks = axis === "row" ? table.rows : table.querySelectorAll("col");
  const firstDeleted = deleting ? oldTracks[index]?.getBoundingClientRect() : null;
  const lastDeleted = deleting ? oldTracks[deletionEnd - 1]?.getBoundingClientRect() : null;
  if (deleting && (!firstDeleted || !lastDeleted)) return () => {};
  const deletedStart = firstDeleted
    ? axis === "row"
      ? firstDeleted.top - oldBounds.top
      : firstDeleted.left - oldBounds.left
    : 0;
  const deletedExtent =
    firstDeleted && lastDeleted
      ? axis === "row"
        ? lastDeleted.bottom - firstDeleted.top
        : lastDeleted.right - firstDeleted.left
      : 0;
  const oldCopy = deleting ? paintCopy(table) : null;
  const oldViewport = deleting ? paintViewport(table) : null;
  if (oldCopy) oldCopy.style.zoom = String(oldBounds.width / table.offsetWidth);
  const oldColumns = table.querySelectorAll("col");
  const oldBoundaryRatio =
    axis !== "column" || oldBounds.width <= 0
      ? 0
      : index <= 0
        ? 0
        : index >= oldColumns.length
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                (oldColumns[index]!.getBoundingClientRect().left - oldBounds.left) /
                  oldBounds.width,
              ),
            );
  const following = new Map<HTMLElement, DOMRect>();
  let block: HTMLElement = table;
  while (block.parentElement && block.parentElement !== editor.view.dom)
    block = block.parentElement;
  for (let next = block.nextElementSibling; next; next = next.nextElementSibling) {
    if (next instanceof HTMLElement) following.set(next, next.getBoundingClientRect());
  }
  return () => {
    const node = editor.state.doc.nodeAt(tableFrom);
    const nextTable = tableElement(editor, tableFrom);
    if (!node || !nextTable) return;
    const map = TableMap.get(node);
    const finalBounds = nextTable.getBoundingClientRect();
    const bounds = deleting ? oldBounds : finalBounds;
    if (!bounds.width || !bounds.height) return;
    const row = axis === "row";
    const offset = map.map[row ? index * map.width : index];
    if (!deleting && offset === undefined) return;
    const cell = offset === undefined ? null : editor.view.nodeDOM(tableFrom + 1 + offset);
    if (!deleting && !(cell instanceof HTMLElement)) return;
    const track = row ? nextTable.rows[index] : nextTable.querySelectorAll("col")[index];
    if (!deleting && !track) return;
    const rect = track?.getBoundingClientRect();
    const start = deleting ? deletedStart : row ? rect!.top - bounds.top : rect!.left - bounds.left;
    const extent = deleting ? deletedExtent : row ? rect!.height : rect!.width;
    const total = row ? bounds.height : bounds.width;
    const finalBoundary = row ? start : track ? rect!.left - finalBounds.left : finalBounds.width;
    const oldBoundary = deleting ? finalBoundary : oldBoundaryRatio * oldBounds.width;
    const copy = oldCopy ?? paintCopy(nextTable);
    const zoom = bounds.width / nextTable.offsetWidth;
    if (!deleting) copy.style.zoom = String(zoom);
    const layer = document.createElement("div");
    layer.className = "table-insertion-paint";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    Object.assign(layer.style, {
      position: "fixed",
      left: bounds.left + "px",
      top: bounds.top + "px",
      width: bounds.width + "px",
      height: bounds.height + "px",
      pointerEvents: "none",
      zIndex: "10",
      overflow: axis === "column" ? "visible" : "hidden",
    });
    // Respect the editor viewport and the table's horizontal scrolling container.
    const visible = oldViewport ?? paintViewport(nextTable);
    const paintWidth = row ? bounds.width : Math.max(oldBounds.width, finalBounds.width);
    const rightClip =
      Math.max(0, bounds.left + paintWidth - visible.right) - (paintWidth - bounds.width);
    layer.style.clipPath = `inset(${Math.max(0, visible.top - bounds.top)}px ${rightClip}px ${Math.max(0, bounds.bottom - visible.bottom)}px ${Math.max(0, visible.left - bounds.left)}px)`;
    const animations: Animation[] = [];
    const animate = (element: HTMLElement, frames: Keyframe[], id: string) => {
      const animation = element.animate(frames, {
        duration: FIXED_MOTION_DURATIONS.tableSection,
        easing: tableEasing,
      });
      animation.id = id;
      animations.push(animation);
    };
    if (!row) {
      const shift = oldBounds.left - finalBounds.left;
      animate(
        layer,
        [
          { transform: deleting ? "translateX(0)" : `translateX(${shift}px)` },
          { transform: deleting ? `translateX(${-shift}px)` : "translateX(0)" },
        ],
        "table-insert-position",
      );
    }
    const clip = (from: number, to: number) =>
      row
        ? "inset(" + from + "px 0px " + Math.max(0, total - to) + "px 0px)"
        : "inset(0px " + Math.max(0, total - to) + "px 0px " + from + "px)";
    for (const part of ["before", "inserted", "after"] as const) {
      const slice = document.createElement("div");
      slice.dataset.tableInsertionSlice = part;
      slice.style.cssText = "position:absolute;inset:0;pointer-events:none;";
      slice.append(copy.cloneNode(true));
      layer.append(slice);
      if (part === "before") {
        slice.style.clipPath = clip(0, start);
        if (!row && start > 0 && oldBoundary > 0)
          animate(
            slice,
            [
              {
                transformOrigin: "0 0",
                transform: deleting ? "scaleX(1)" : `scaleX(${oldBoundary / start})`,
              },
              {
                transformOrigin: "0 0",
                transform: deleting ? `scaleX(${oldBoundary / start})` : "scaleX(1)",
              },
            ],
            "table-insert-shift",
          );
      }
      if (part === "inserted") {
        slice.style.clipPath = clip(start, start + extent);
        const opening = row ? start : Math.max(start, Math.min(start + extent, oldBoundary));
        animate(
          slice,
          [
            { clipPath: deleting ? clip(start, start + extent) : clip(opening, opening) },
            { clipPath: deleting ? clip(opening, opening) : clip(start, start + extent) },
          ],
          deleting ? "table-delete-collapse" : "table-insert-expand",
        );
      }
      if (part === "after") {
        slice.style.clipPath = clip(start + extent, total);
        const finalAfterStart = start + extent;
        const finalAfterExtent = total - finalAfterStart;
        const initialAfterExtent = (deleting ? finalBounds.width : oldBounds.width) - oldBoundary;
        const initialScale =
          !row && finalAfterExtent > 0 ? initialAfterExtent / finalAfterExtent : 1;
        const initialOffset =
          !row && finalAfterExtent > 0 ? oldBoundary - finalAfterStart * initialScale : -extent;
        animate(
          slice,
          [
            {
              transformOrigin: "0 0",
              transform: deleting
                ? "translate(0, 0) scaleX(1)"
                : row
                  ? `translateY(${-extent}px)`
                  : `translateX(${initialOffset}px) scaleX(${initialScale})`,
            },
            {
              transformOrigin: "0 0",
              transform: deleting
                ? row
                  ? `translateY(${-extent}px)`
                  : `translateX(${initialOffset}px) scaleX(${initialScale})`
                : row
                  ? "translateY(0)"
                  : "translateX(0) scaleX(1)",
            },
          ],
          "table-insert-shift",
        );
      }
    }
    document.body.append(layer);
    animate(nextTable, [{ opacity: 0 }, { opacity: 0 }], "table-insert-original");
    for (const [element, before] of following) {
      if (!element.isConnected) continue;
      const after = element.getBoundingClientRect();
      const scale = element.offsetWidth ? after.width / element.offsetWidth : 1;
      if (scale > 0 && Math.abs(before.top - after.top) > 0.1)
        animate(
          element,
          [
            {
              transform: "translateY(" + (before.top - after.top) / scale + "px)",
            },
            { transform: "translateY(0)" },
          ],
          "table-insert-shift",
        );
    }
    const doc = editor.state.doc;
    const stop = () => {
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
      layer.remove();
      editor.off("transaction", onTransaction);
      editor.off("destroy", stop);
      editor.view.dom.removeEventListener("pointerdown", stop);
      window.removeEventListener("scroll", stop, true);
      window.removeEventListener("resize", stop);
      active.delete(editor);
    };
    const onTransaction = () => {
      if (editor.state.doc !== doc) stop();
    };
    let remaining = animations.length;
    for (const animation of animations)
      animation.onfinish = () => {
        if (--remaining === 0) stop();
      };
    editor.on("transaction", onTransaction);
    editor.on("destroy", stop);
    editor.view.dom.addEventListener("pointerdown", stop);
    window.addEventListener("scroll", stop, true);
    window.addEventListener("resize", stop);
    active.set(editor, stop);
  };
}

/** Paint-only crossfade for commands that reflow cells or replace a whole table. */
export function prepareTableLayoutAnimation(editor: Editor, tableFrom?: number): () => void {
  active.get(editor)?.();
  if (editor.isDestroyed || typeof editor.view.dom.animate !== "function" || isMotionReduced())
    return () => {};
  const root = editor.view.dom;
  const oldTable = tableFrom === undefined ? null : tableElement(editor, tableFrom);
  const oldBounds = oldTable?.getBoundingClientRect();
  const oldCopy = oldTable && oldBounds && oldBounds.width > 0 ? paintCopy(oldTable) : null;
  const oldViewport = oldTable ? paintViewport(oldTable) : null;
  const oldZoom =
    oldTable && oldBounds && oldTable.offsetWidth ? oldBounds.width / oldTable.offsetWidth : 1;
  const oldTables = new Set(root.querySelectorAll("table"));
  const blocks = new Map(
    Array.from(root.children, (element) => [element, element.getBoundingClientRect()] as const),
  );
  return () => {
    if (editor.isDestroyed) return;
    const nextTable = oldTable?.isConnected
      ? oldTable
      : Array.from(root.querySelectorAll("table")).find((table) => !oldTables.has(table));
    const nextBounds = nextTable?.getBoundingClientRect();
    const animations: Animation[] = [];
    let layer: HTMLElement | null = null;
    let groupDuration = SPATIAL_MOTION_TIMING.duration;
    const animate = (element: HTMLElement, frames: Keyframe[]) => {
      const timing = keyframeMotionTiming(element, frames);
      groupDuration = Math.max(groupDuration, timing.duration);
      const animation = element.animate(frames, timing);
      animation.id = "table-layout-motion";
      animations.push(animation);
    };
    if (oldCopy && oldBounds) {
      layer = document.createElement("div");
      layer.className = "table-layout-paint";
      layer.setAttribute("aria-hidden", "true");
      layer.inert = true;
      const viewport = oldViewport ?? { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
      Object.assign(layer.style, {
        position: "fixed",
        left: `${oldBounds.left}px`,
        top: `${oldBounds.top}px`,
        width: `${oldBounds.width}px`,
        height: `${oldBounds.height}px`,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "10",
        clipPath: `inset(${Math.max(0, viewport.top - oldBounds.top)}px ${Math.max(0, oldBounds.right - viewport.right)}px ${Math.max(0, oldBounds.bottom - viewport.bottom)}px ${Math.max(0, viewport.left - oldBounds.left)}px)`,
      });
      oldCopy.style.zoom = String(oldZoom);
      layer.append(oldCopy);
      document.body.append(layer);
      animate(layer, [
        {
          opacity: 1,
          transform: "translate(0, 0)",
          width: `${oldBounds.width}px`,
          height: `${oldBounds.height}px`,
        },
        {
          opacity: 0,
          transform: `translate(${(nextBounds?.left ?? oldBounds.left) - oldBounds.left}px, ${(nextBounds?.top ?? oldBounds.top) - oldBounds.top}px)`,
          width: `${nextBounds?.width ?? oldBounds.width}px`,
          height: `${nextBounds?.height ?? 0}px`,
        },
      ]);
    }
    if (nextTable && nextBounds) {
      const zoom = nextTable.offsetWidth ? nextBounds.width / nextTable.offsetWidth : 1;
      animate(nextTable, [
        {
          opacity: 0,
          transform: `translate(${((oldBounds?.left ?? nextBounds.left) - nextBounds.left) / zoom}px, ${((oldBounds?.top ?? nextBounds.top) - nextBounds.top) / zoom}px)`,
        },
        { opacity: 1, transform: "translate(0, 0)" },
      ]);
    }
    for (const [element, before] of blocks) {
      if (
        !(element instanceof HTMLElement) ||
        !element.isConnected ||
        element.contains(nextTable ?? null)
      )
        continue;
      const after = element.getBoundingClientRect();
      const zoom = element.offsetWidth ? after.width / element.offsetWidth : 1;
      if (zoom > 0 && Math.abs(before.top - after.top) > 0.1)
        animate(element, [
          { transform: `translateY(${(before.top - after.top) / zoom}px)` },
          { transform: "translateY(0)" },
        ]);
    }
    if (!animations.length) return;
    synchronizePaintTimings(animations, groupDuration);
    const doc = editor.state.doc;
    const stop = () => {
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
      layer?.remove();
      editor.off("transaction", changed);
      editor.off("destroy", stop);
      root.removeEventListener("pointerdown", stop);
      window.removeEventListener("scroll", stop, true);
      window.removeEventListener("resize", stop);
      if (active.get(editor) === stop) active.delete(editor);
    };
    const changed = () => {
      if (editor.state.doc !== doc) stop();
    };
    active.set(editor, stop);
    editor.on("transaction", changed);
    editor.on("destroy", stop);
    root.addEventListener("pointerdown", stop);
    window.addEventListener("scroll", stop, true);
    window.addEventListener("resize", stop);
    void Promise.all(animations.map((animation) => animation.finished)).then(stop, stop);
  };
}
