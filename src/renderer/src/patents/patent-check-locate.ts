import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { PatentLocation } from "../../../shared/patent-inspection/types";
import { inspectionSelectionKey } from "../editor/extensions/inspection-selection";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";

/**
 * Maps a patent-inspection location (block id + optional character offsets
 * within the block's visible text) to an editor selection range. The offsets
 * are computed against the canonical document's flattened text, so they line
 * up with the rich-text editor only while the block is unchanged. Every exact
 * range is verified against the inspection excerpt before it is returned; any
 * mismatch first searches for a unique excerpt within the same block, then
 * degrades to the whole block instead of guessing an ambiguous partial range.
 */
export type PatentIssueRange =
  | { status: "exact"; from: number; to: number }
  | { status: "paragraph"; from: number; to: number }
  | { status: "missing" };

export type PatentIssueLocateOutcome = "exact" | "paragraph" | "missing";

function findNodePositionById(editor: Editor, nodeId: string): number | null {
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.nodeId !== nodeId) return true;
    position = pos;
    return false;
  });
  return position;
}

function canonicalRange(node: ProseMirrorNode, start: number, end: number) {
  if (!node.isTextblock || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  let offset = 0;
  let from: number | undefined;
  let to: number | undefined;
  node.forEach((child, position) => {
    const length = child.isText
      ? (child.text?.length ?? 0)
      : child.type.name === "hardBreak"
        ? 1
        : child.type.name === "inlineMath" && typeof child.attrs.latex === "string"
          ? child.attrs.latex.length
          : 0;
    if (start >= offset && start < offset + length)
      from = position + (child.isText ? start - offset : 0);
    if (end > offset && end <= offset + length)
      to = position + (child.isText ? end - offset : child.nodeSize);
    offset += length;
  });
  return from === undefined || to === undefined ? null : { from, to };
}

export function resolvePatentIssueRange(
  editor: Editor,
  location: PatentLocation,
  excerpt: string | null,
): PatentIssueRange {
  const targetId = location.targetId;
  if (!targetId) return { status: "missing" };
  const nodePosition = findNodePositionById(editor, targetId);
  if (nodePosition === null) return { status: "missing" };
  const node = editor.state.doc.nodeAt(nodePosition);
  if (!node) return { status: "missing" };

  const blockFrom = nodePosition + 1;
  const blockTo = nodePosition + node.nodeSize - 1;
  const { startOffset, endOffset } = location;
  if (typeof startOffset === "number" && typeof endOffset === "number" && endOffset > startOffset) {
    const mapped = canonicalRange(node, startOffset, endOffset);
    const from = blockFrom + (mapped?.from ?? -1);
    const to = blockFrom + (mapped?.to ?? -1);
    if (mapped && from >= blockFrom && to <= blockTo && to > from) {
      const text = editor.state.doc.textBetween(from, to, "\n", "\n");
      if (excerpt === null || text === excerpt) return { status: "exact", from, to };
    }
  }

  if (excerpt) {
    let text = "";
    const positions: number[] = [];
    node.descendants((child, position) => {
      if (!child.isText && !child.isLeaf) return true;
      const value = child.isText
        ? (child.text ?? "")
        : child.type.name === "hardBreak"
          ? "\n"
          : "\uFFFC".repeat(child.nodeSize);
      for (let index = 0; index < value.length; index++)
        positions.push(blockFrom + position + index);
      text += value;
      return false;
    });
    const offset = text.indexOf(excerpt);
    if (offset >= 0 && text.indexOf(excerpt, offset + 1) < 0) {
      const from = positions[offset];
      const last = positions[offset + excerpt.length - 1];
      if (
        from !== undefined &&
        last !== undefined &&
        editor.state.doc.textBetween(from, last + 1, "\n", "\n") === excerpt
      ) {
        return { status: "exact", from, to: last + 1 };
      }
    }
  }

  // Safe paragraph-level fallback: select the whole text block, or position the
  // cursor at a non-text block (table, figure, formula) without selecting text.
  if (node.isTextblock) return { status: "paragraph", from: blockFrom, to: blockTo };
  return { status: "paragraph", from: nodePosition, to: nodePosition };
}

export function selectPatentIssueInEditor(
  editor: Editor,
  location: PatentLocation,
  excerpt: string | null,
): PatentIssueLocateOutcome {
  const range = resolvePatentIssueRange(editor, location, excerpt);
  if (range.status === "missing") return "missing";
  const applied = editor
    .chain()
    .setMeta(inspectionSelectionKey, true)
    .focus(undefined, { scrollIntoView: false })
    .setTextSelection({ from: range.from, to: range.to })
    .run();
  if (applied) centerPatentIssue(editor, range.from, range.to);
  return applied ? range.status : "missing";
}

export function centerPatentIssue(
  editor: Editor,
  from: number,
  to: number,
  motion: "instant" | "smooth" = "instant",
): void {
  if (motion === "smooth") {
    const dom = editor.view.domAtPos(Math.min(from + 1, to)).node;
    const target = dom instanceof HTMLElement ? dom : dom.parentElement;
    const reducedMotion = isMotionReduced();
    target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    return;
  }
  for (let parent = editor.view.dom.parentElement; parent; parent = parent.parentElement) {
    if (
      !/auto|scroll/.test(getComputedStyle(parent).overflowY) ||
      parent.clientHeight <= 0 ||
      parent.scrollHeight <= parent.clientHeight
    )
      continue;
    const rect = parent.getBoundingClientRect();
    const scale = parent.offsetHeight > 0 ? rect.height / parent.offsetHeight : 1;
    if (scale <= 0) continue;
    const top = Math.max(0, rect.top + parent.clientTop * scale);
    const bottom = Math.min(
      window.innerHeight,
      rect.top + (parent.clientTop + parent.clientHeight) * scale,
    );
    if (bottom <= top) continue;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    // A long selection may exceed the viewport: keep its beginning readable.
    const target =
      end.bottom - start.top > bottom - top
        ? (start.top + start.bottom) / 2
        : (start.top + end.bottom) / 2;
    const destination = Math.max(
      0,
      Math.min(
        parent.scrollHeight - parent.clientHeight,
        parent.scrollTop + (target - (top + bottom) / 2) / scale,
      ),
    );
    parent.scrollTop = destination;
    return;
  }
}
