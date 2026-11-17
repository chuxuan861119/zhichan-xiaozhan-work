import type { PatentBookDocument } from "../../../shared/document/model";
import {
  classifyDescriptionChapterBlock,
  descriptionInventionTitle,
} from "../../../shared/patent/description";
import {
  buildDocumentStructureRulerModel,
  type DocumentStructureRulerModel,
} from "../../../shared/patent/document-structure-ruler";

// The description ruler depends on order/identity, chapter labels, title presence
// and whether a paragraph is empty, not on ordinary body wording or formatting.
// Keep this key aligned with buildDescriptionModel and its regression tests.
function descriptionStructureKey(document: PatentBookDocument): string {
  return JSON.stringify([
    Boolean(descriptionInventionTitle(document)),
    document.content.map((block) => {
      const chapter = classifyDescriptionChapterBlock(block);
      const text =
        block.type === "paragraph" || block.type === "heading"
          ? block.content
              .map((inline) =>
                inline.type === "text"
                  ? inline.text
                  : inline.type === "inline-formula"
                    ? inline.source
                    : "",
              )
              .join("")
              .trim()
          : "";
      return [block.id, block.type, chapter, chapter ? text : Boolean(text)];
    }),
  ]);
}

export function createRulerModelCalculator() {
  let key: string | null = null;
  let model: DocumentStructureRulerModel | null = null;
  return (document: PatentBookDocument, bookKind: "claims" | "description") => {
    const nextKey = bookKind === "description" ? descriptionStructureKey(document) : null;
    if (nextKey !== null && key === nextKey && model) return model;
    key = nextKey;
    model = buildDocumentStructureRulerModel(document, bookKind);
    return model;
  };
}
