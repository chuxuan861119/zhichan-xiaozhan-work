import type { EditorView } from "@tiptap/pm/view";

/** Preserve the upstream affinity which a document position alone cannot express. */
export function preserveClickedLineEnd(
  view: EditorView,
  position: number,
  point: { x: number; y: number },
): void {
  if (view.isDestroyed || view.composing || !view.state.selection.empty) return;
  const resolved = view.state.doc.resolve(position);
  // Only a soft wrap within text, never a paragraph boundary, hard break or atom.
  if (!resolved.nodeBefore?.isText || !resolved.nodeAfter?.isText) return;
  const upstream = view.coordsAtPos(position, -1);
  const downstream = view.coordsAtPos(position, 1);
  if (upstream.bottom >= downstream.top || point.y < upstream.top || point.y > upstream.bottom)
    return;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount || typeof selection.modify !== "function")
    return;
  const original = selection.getRangeAt(0).cloneRange();
  // Moving back by one grapheme and using native End keeps the same model offset,
  // but tells Chromium to paint the caret at the end of the clicked visual line.
  selection.modify("move", "backward", "character");
  selection.modify("move", "forward", "lineboundary");
  if (
    !selection.focusNode ||
    !view.dom.contains(selection.focusNode) ||
    view.posAtDOM(selection.focusNode, selection.focusOffset) !== position
  ) {
    selection.removeAllRanges();
    selection.addRange(original);
  }
}
