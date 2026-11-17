import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  aiContentBlocks,
  type MixedSpan,
  mixedSelection,
} from "../../../../shared/ai-correction/mixed-content";
import { tiptapToDocumentBlocks } from "../../editor/model-adapter";

const cache = new WeakMap<ProseMirrorNode, ReturnType<typeof readDocument>>();
function readDocument(doc: ProseMirrorNode) {
  const parsed = tiptapToDocumentBlocks(doc.toJSON());
  if (!parsed.ok) throw new Error(parsed.error.message);
  const blocks = aiContentBlocks(parsed.value);
  const positions = new Map<string, { node: ProseMirrorNode; position: number }>();
  doc.descendants((node, position) => {
    if (typeof node.attrs.nodeId === "string") positions.set(node.attrs.nodeId, { node, position });
  });
  return { blocks, positions };
}
export function mixedEditorDocument(editor: Editor) {
  let value = cache.get(editor.state.doc);
  if (!value) {
    value = readDocument(editor.state.doc);
    cache.set(editor.state.doc, value);
  }
  return value;
}
export function inspectMixedSelection(editor: Editor) {
  const { blocks, positions } = mixedEditorDocument(editor);
  const spans: MixedSpan[] = [];
  for (const block of blocks) {
    const location = positions.get(block.id);
    if (!location) continue;
    const { node, position } = location;
    const contentStart = position + (block.type === "object" ? 0 : 1);
    const size = block.type === "object" ? node.nodeSize : node.content.size;
    const intersections = editor.state.selection.ranges.filter(
      (range) =>
        (range.$from.pos < contentStart + size && range.$to.pos > contentStart) ||
        (size === 0 && range.$from.pos <= contentStart && range.$to.pos >= contentStart),
    );
    if (!intersections.length) continue;
    const from = Math.max(contentStart, Math.min(...intersections.map((r) => r.$from.pos)));
    const to = Math.min(contentStart + size, Math.max(...intersections.map((r) => r.$to.pos)));
    spans.push({
      blockId: block.id,
      blockType: block.type,
      startOffset: block.type === "object" ? 0 : from - contentStart,
      endOffset: block.type === "object" ? 1 : to - contentStart,
    });
  }
  return { ...mixedSelection(blocks, spans), spans };
}
