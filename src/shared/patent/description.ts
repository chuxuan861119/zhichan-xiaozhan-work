import type {
  BlockNode,
  HeadingNode,
  ParagraphNode,
  PatentBookDocument,
} from "../document/model.js";
import { randomUuid } from "../id.js";
import type { PatentType } from "./model.js";
import { instantiateBookTemplate, type PatentTemplateSettings } from "./templates.js";

export type DescriptionChapterKind =
  | "technical-field"
  | "background-art"
  | "invention-content"
  | "technical-problem"
  | "technical-solution"
  | "beneficial-effects"
  | "drawing-explanation"
  | "detailed-embodiments";

export const DESCRIPTION_CHAPTER_ORDER = [
  "technical-field",
  "background-art",
  "invention-content",
  "beneficial-effects",
  "drawing-explanation",
  "detailed-embodiments",
] as const satisfies readonly DescriptionChapterKind[];

const STATIC_CHAPTER_LABELS: Record<
  Exclude<DescriptionChapterKind, "invention-content">,
  string
> = {
  "technical-field": "技术领域",
  "background-art": "背景技术",
  "technical-problem": "要解决的技术问题",
  "technical-solution": "技术方案",
  "beneficial-effects": "有益效果",
  "drawing-explanation": "附图说明",
  "detailed-embodiments": "具体实施方式",
};

export function descriptionChapterKinds(document: PatentBookDocument): DescriptionChapterKind[] {
  return document.content.flatMap((block) => {
    const kind = classifyDescriptionChapterBlock(block);
    return kind ? [kind] : [];
  });
}

export function descriptionInventionTitle(document: PatentBookDocument): string | null {
  const firstBlock = document.content[0];
  if (!isDescriptionTextBlock(firstBlock) || firstBlock.attrs.alignment !== "center") return null;

  return textBlockText(firstBlock).trim() || null;
}

export function missingDescriptionChapters(
  document: PatentBookDocument,
  patentType: PatentType,
): DescriptionChapterKind[] {
  const present = new Set(descriptionChapterKinds(document));
  void patentType;
  return DESCRIPTION_CHAPTER_ORDER.filter((kind) => !present.has(kind));
}

export function insertMissingDescriptionChapters(
  document: PatentBookDocument,
  patentType: PatentType,
  templates: PatentTemplateSettings,
): PatentBookDocument {
  const missing = new Set(missingDescriptionChapters(document, patentType));
  if (missing.size === 0) return document;
  const templateDocument = instantiateBookTemplate({
    template: templates[patentType].description,
    kind: "description",
    patentName: null,
    patentType,
    timestamp: new Date().toISOString(),
    createId: randomUuid,
  });
  const additions = templateDocument.content.filter((block) => {
    const kind = classifyDescriptionChapterBlock(block);
    return kind ? missing.has(kind) : false;
  });

  return {
    ...document,
    modifiedAt: new Date().toISOString(),
    content: [...document.content, ...additions],
  };
}

export function classifyDescriptionChapterBlock(block: BlockNode): DescriptionChapterKind | null {
  if (!isDescriptionTextBlock(block)) return null;
  if (block.attrs.alignment !== "left" || block.attrs.paragraphIndentMm !== 0) return null;

  return descriptionChapterKindFromText(textBlockText(block).trim());
}

export function descriptionChapterKindFromText(text: string): DescriptionChapterKind | null {
  if (text === "发明内容" || text === "实用新型内容") return "invention-content";
  for (const [kind, label] of Object.entries(STATIC_CHAPTER_LABELS)) {
    if (text === label) return kind as DescriptionChapterKind;
  }

  return null;
}

function isDescriptionTextBlock(
  block: BlockNode | undefined,
): block is ParagraphNode | HeadingNode {
  return block?.type === "paragraph" || block?.type === "heading";
}

function textBlockText(block: ParagraphNode | HeadingNode): string {
  return block.content
    .filter((inline) => inline.type === "text")
    .map((inline) => inline.text)
    .join("");
}
