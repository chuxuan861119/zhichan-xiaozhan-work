import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../../../shared/document/defaults";
import type {
  AssetDescriptor,
  InlineNode,
  ParagraphNode,
  PatentBookDocument,
} from "../../../../shared/document/model";
import {
  type PatentDescriptionEditorState,
  PatentDescriptionEditorStateSchema,
} from "../../../../shared/ipc/contract";
import { classifyDescriptionChapterBlock } from "../../../../shared/patent/description";
import {
  type DrawingExplanationSync,
  inspectDrawingExplanationSync,
  listVisibleDrawingExplanations,
  type UnlinkedDrawingExplanation,
} from "../../../../shared/patent/drawing-explanations";
import { PATENT_BODY_PARAGRAPH_ATTRIBUTES } from "../../../../shared/patent/formatting";
import type { PatentFigure } from "../../../../shared/patent/model";
import { hasDrawingExplanationHeading } from "../../../../shared/patent/reference-mark-legend";

const DRAWING_EXPLANATION_COLOR = "#D92D20";

export type DrawingExplanationFillChange = Readonly<{
  target: {
    figureId: string;
    figureNumber: number;
    paragraphId: string | null;
  };
  content: InlineNode[];
}>;

export type DrawingExplanationDrafts = Record<string, { figureNumber: number; value: string }>;

export function readDrawingExplanationDrafts(value: unknown): DrawingExplanationDrafts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, draft]) =>
        draft &&
        typeof draft === "object" &&
        typeof draft.value === "string" &&
        Number.isInteger(draft.figureNumber) &&
        draft.figureNumber > 0,
    ),
  );
}

export function existingDrawingExplanationParagraphs(
  document: PatentBookDocument,
): ParagraphNode[] {
  const result: ParagraphNode[] = [];
  const heading = document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
  );
  if (heading < 0) return result;
  for (const block of document.content.slice(heading + 1)) {
    if (classifyDescriptionChapterBlock(block) !== null) break;
    if (
      block.type === "paragraph" &&
      paragraphText(block).trim() &&
      !/^其中/u.test(paragraphText(block).trim())
    )
      result.push(block);
  }
  return result;
}

export type DrawingSyncSnapshot = {
  sync: DrawingExplanationSync;
  unlinked: readonly UnlinkedDrawingExplanation[];
  entries: DrawingExplanationRailEntry[];
};

export type DrawingFigureEdit = {
  figures: PatentFigure[];
  abstractDrawingFigureId: string | null;
  assets: AssetDescriptor[];
};

export type DrawingExplanationRailEntry =
  | {
      figureId: string;
      figureNumber: number;
      status: "editable";
      paragraph: ParagraphNode;
    }
  | {
      figureId: string;
      figureNumber: number;
      status: "missing" | "missing-heading" | "duplicate";
      paragraph: null;
      message: string;
    };

export function appendImportedFigures(input: {
  figures: readonly PatentFigure[];
  assets: readonly AssetDescriptor[];
  importedFigures: readonly PatentFigure[];
  importedAssets: readonly AssetDescriptor[];
  abstractDrawingFigureId: string | null;
}): DrawingFigureEdit {
  const assetsById = new Map(input.assets.map((asset) => [asset.assetId, structuredClone(asset)]));
  for (const asset of input.importedAssets) {
    assetsById.set(asset.assetId, structuredClone(asset));
  }
  return {
    figures: cloneFigures([...input.figures, ...input.importedFigures]),
    abstractDrawingFigureId: input.abstractDrawingFigureId,
    assets: [...assetsById.values()],
  };
}

export function reorderFigures(input: {
  orderedFigures: readonly PatentFigure[];
  assets: readonly AssetDescriptor[];
  abstractDrawingFigureId: string | null;
}): DrawingFigureEdit {
  const figures = cloneFigures(input.orderedFigures);
  return {
    figures,
    abstractDrawingFigureId:
      input.abstractDrawingFigureId &&
      figures.some((figure) => figure.figureId === input.abstractDrawingFigureId)
        ? input.abstractDrawingFigureId
        : null,
    assets: cloneAssets(input.assets),
  };
}

export function deleteFigures(input: {
  figures: readonly PatentFigure[];
  assets: readonly AssetDescriptor[];
  abstractDrawingFigureId: string | null;
  figureIds: readonly string[];
}): DrawingFigureEdit {
  const removed = new Set(input.figureIds);
  const figures = input.figures.filter((figure) => !removed.has(figure.figureId));
  return {
    figures: cloneFigures(figures),
    abstractDrawingFigureId:
      input.abstractDrawingFigureId && removed.has(input.abstractDrawingFigureId)
        ? null
        : input.abstractDrawingFigureId,
    assets: cloneAssets(input.assets),
  };
}

export function drawingExplanationProjection(input: {
  figures: readonly PatentFigure[];
  descriptionDocument: PatentBookDocument;
}): DrawingExplanationRailEntry[] {
  const headingExists = hasDrawingExplanationHeading(input.descriptionDocument);
  const candidates = new Map<number, ParagraphNode[]>();
  for (const entry of listVisibleDrawingExplanations(input.descriptionDocument)) {
    const current = candidates.get(entry.figureNumber) ?? [];
    current.push(structuredClone(entry.paragraph));
    candidates.set(entry.figureNumber, current);
  }

  return input.figures.map((figure, index) => {
    const figureNumber = index + 1;
    if (!headingExists) {
      return {
        figureId: figure.figureId,
        figureNumber,
        status: "missing-heading" as const,
        paragraph: null,
        message: "说明书中缺少“附图说明”章节，请在说明书中补充后再编辑。",
      };
    }
    const matches = candidates.get(figureNumber) ?? [];
    if (matches.length === 1) {
      return {
        figureId: figure.figureId,
        figureNumber,
        status: "editable" as const,
        paragraph: matches[0] as ParagraphNode,
      };
    }
    return {
      figureId: figure.figureId,
      figureNumber,
      status: matches.length === 0 ? ("missing" as const) : ("duplicate" as const),
      paragraph: null,
      message:
        matches.length === 0
          ? `说明书中缺少图${figureNumber}的附图说明。`
          : `说明书中存在多条图${figureNumber}的附图说明，请在说明书中处理重复项。`,
    };
  });
}

export function updateDrawingExplanationParagraph(input: {
  document: PatentBookDocument;
  paragraphId: string;
  content: InlineNode[];
}): PatentBookDocument {
  return {
    ...structuredClone(input.document),
    content: input.document.content.map((block) =>
      block.type === "paragraph" && block.id === input.paragraphId
        ? {
            ...structuredClone(block),
            content: structuredClone(applyExistingColorMarks(block, input.content)),
          }
        : structuredClone(block),
    ),
  };
}

export function fillDrawingExplanationParagraph(input: {
  document: PatentBookDocument;
  paragraphId: string | null;
  content: InlineNode[];
  createId(): string;
}): PatentBookDocument {
  if (input.paragraphId) {
    return updateDrawingExplanationParagraph({
      document: input.document,
      paragraphId: input.paragraphId,
      content: input.content,
    });
  }

  const headingIndex = input.document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
  );
  if (headingIndex < 0) {
    throw new Error("说明书中缺少“附图说明”章节，无法填入附图说明。");
  }

  let insertionIndex = input.document.content.length;
  for (let index = headingIndex + 1; index < input.document.content.length; index += 1) {
    const block = input.document.content[index];
    if (!block) continue;
    if (classifyDescriptionChapterBlock(block) !== null) {
      insertionIndex = index;
      break;
    }
    if (block.type === "paragraph" && /^其中(?:[，,:：]|$)/u.test(paragraphText(block).trim())) {
      insertionIndex = index;
      break;
    }
  }

  const existingExplanations = listVisibleDrawingExplanations(input.document);
  const inheritedAttributes = existingExplanations.at(-1)?.paragraph.attrs;
  const next = structuredClone(input.document);
  next.content.splice(insertionIndex, 0, {
    id: input.createId(),
    type: "paragraph",
    attrs: structuredClone(inheritedAttributes ?? DEFAULT_PARAGRAPH_ATTRIBUTES),
    content: structuredClone(input.content),
  });
  return next;
}

export function fillDrawingExplanationParagraphs(input: {
  document: PatentBookDocument;
  changes: readonly DrawingExplanationFillChange[];
  createId(): string;
}): { document: PatentBookDocument; firstParagraphId: string } {
  if (input.changes.length === 0) {
    throw new Error("没有可填入的附图说明。");
  }
  const headingId = input.document.content.find(
    (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
  )?.id;
  if (!headingId) {
    throw new Error("说明书中缺少“附图说明”标题。");
  }

  const existingById = new Map(
    input.document.content.flatMap((block) =>
      block.type === "paragraph" ? ([[block.id, block]] as const) : [],
    ),
  );
  const replacedIds = new Set(
    existingDrawingExplanationParagraphs(input.document).map((block) => block.id),
  );
  const content = input.document.content
    .filter((block) => !replacedIds.has(block.id))
    .map((block) => structuredClone(block));
  const headingIndex = content.findIndex((block) => block.id === headingId);
  const insertionIndex = headingIndex + 1;
  const paragraphs = input.changes.map((change) => {
    const existing = change.target.paragraphId
      ? existingById.get(change.target.paragraphId)
      : undefined;
    return {
      id: existing?.id ?? input.createId(),
      type: "paragraph" as const,
      semanticRole: "description-drawing-explanation" as const,
      figureId: change.target.figureId,
      attrs: {
        ...(existing?.attrs ?? PATENT_BODY_PARAGRAPH_ATTRIBUTES),
        paragraphIndentMm: PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm,
      },
      content: forceDrawingExplanationColor(change.content),
    };
  });
  content.splice(insertionIndex, 0, ...paragraphs);

  const { content: _originalContent, ...documentMetadata } = input.document;
  return {
    document: { ...structuredClone(documentMetadata), content },
    firstParagraphId: paragraphs[0]?.id ?? "",
  };
}

export function normalizeDescriptionEditorState(
  editorState: unknown,
): PatentDescriptionEditorState {
  const parsed = PatentDescriptionEditorStateSchema.safeParse(editorState);
  return parsed.success ? parsed.data : { unlinkedFigureExplanations: [] };
}

export function drawingSyncSnapshot(input: {
  figures: readonly PatentFigure[];
  descriptionDocument: PatentBookDocument;
  descriptionEditorState: unknown;
}): DrawingSyncSnapshot {
  const editorState = normalizeDescriptionEditorState(input.descriptionEditorState);
  return {
    sync: inspectDrawingExplanationSync(
      input.descriptionDocument,
      input.figures.map((figure) => figure.figureId),
    ),
    unlinked: editorState.unlinkedFigureExplanations,
    entries: drawingExplanationProjection({
      figures: input.figures,
      descriptionDocument: input.descriptionDocument,
    }),
  };
}

function cloneFigures(figures: readonly PatentFigure[]): PatentFigure[] {
  return figures.map((figure) => structuredClone(figure));
}

function cloneAssets(assets: readonly AssetDescriptor[]): AssetDescriptor[] {
  return assets.map((asset) => structuredClone(asset));
}

// 右侧附图说明输入框提交的是纯文本（marks: []）；保留原段落颜色，避免
// 用户编辑既有的带色文字时意外丢失格式。
function applyExistingColorMarks(paragraph: ParagraphNode, content: InlineNode[]): InlineNode[] {
  const firstText = paragraph.content.find((node) => node.type === "text");
  const colorMarks =
    firstText?.type === "text" ? firstText.marks.filter((mark) => mark.type === "color") : [];
  if (colorMarks.length === 0) return content;
  return content.map((node) =>
    node.type === "text" ? { ...node, marks: [...node.marks, ...colorMarks] } : node,
  );
}

function forceDrawingExplanationColor(content: readonly InlineNode[]): InlineNode[] {
  return content.map((node) =>
    node.type === "text"
      ? {
          ...structuredClone(node),
          marks: [
            ...node.marks.filter((mark) => mark.type !== "color"),
            { type: "color" as const, value: DRAWING_EXPLANATION_COLOR },
          ],
        }
      : structuredClone(node),
  );
}

function paragraphText(paragraph: ParagraphNode): string {
  return inlineText(paragraph.content);
}

function inlineText(content: readonly InlineNode[]): string {
  return content
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "hard-break") return "\n";
      if (node.type === "inline-formula") return node.source;
      return "";
    })
    .join("");
}
