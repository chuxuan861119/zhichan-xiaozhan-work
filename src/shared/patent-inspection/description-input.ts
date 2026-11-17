import type { BlockNode, PatentBookDocument } from "../document/model.js";
import { descriptionChapterKindFromText } from "../patent/description.js";
import { visibleBlockText } from "../patent/text.js";

export function inspectionChapterKind(block: BlockNode) {
  if (block.type !== "paragraph" && block.type !== "heading") return null;
  const text = visibleBlockText(block).trim();
  return descriptionChapterKindFromText(text === "有益之处" ? "有益效果" : text);
}

// Inspection recognizes standalone chapter text independently of formatting.
// This is a read-only projection: never feed it into editing/synchronization writes.
export function descriptionInput(document: PatentBookDocument): PatentBookDocument {
  return {
    ...document,
    content: document.content.map((block) => {
      if (block.type !== "paragraph" && block.type !== "heading") return block;
      if (!descriptionChapterKindFromText(visibleBlockText(block).trim())) return block;
      return { ...block, attrs: { ...block.attrs, alignment: "left", paragraphIndentMm: 0 } };
    }),
  };
}
