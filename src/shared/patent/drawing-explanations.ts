import { z } from "zod";
import type { HeadingNode, ParagraphNode, PatentBookDocument } from "../document/model.js";
import { ParagraphNodeSchema } from "../document/model.js";
import { classifyDescriptionChapterBlock } from "./description.js";

export type LinkedDrawingExplanation = {
  figureId: string;
  paragraph: ParagraphNode;
  index: number;
};

export type VisibleDrawingExplanation = {
  figureNumber: number;
  paragraph: ParagraphNode;
  index: number;
};

export type DrawingExplanationSyncIssueCode =
  | "missing-heading"
  | "duplicate-figure"
  | "missing-figure"
  | "unknown-figure"
  | "out-of-order-explanation"
  | "merged-explanation-line";

export type DrawingExplanationSyncIssue = {
  code: DrawingExplanationSyncIssueCode;
  message: string;
  figureId?: string;
  paragraphId?: string;
};

export type DrawingExplanationSync =
  | {
      status: "active";
      headingId: string;
      linked: LinkedDrawingExplanation[];
      legend: ParagraphNode | null;
    }
  | { status: "paused"; issues: DrawingExplanationSyncIssue[] };

/**
 * Older releases could detach an explanation while deleting a figure. New edits no longer create
 * these records, but the schema remains readable so existing patents and recovery logs can open.
 */
export type UnlinkedDrawingExplanation = {
  unlinkedId: string;
  sourceFigureId: string;
  removedAt: string;
  paragraph: ParagraphNode;
};

export const UnlinkedDrawingExplanationSchema = z
  .object({
    unlinkedId: z.string().uuid(),
    sourceFigureId: z.string().uuid(),
    removedAt: z.string().datetime(),
    paragraph: ParagraphNodeSchema,
  })
  .strict();

const FIGURE_TOKEN_PATTERN = /^(?:附图|图)\s*(\d+)/u;

/**
 * Read-only consistency inspection for visible paragraphs in the “附图说明” chapter. This helper
 * never adds, deletes, reorders, renumbers, or writes hidden links into the description document.
 */
export function inspectDrawingExplanationSync(
  document: PatentBookDocument,
  orderedFigureIds: readonly string[],
): DrawingExplanationSync {
  const headingIndex = findDrawingHeadingIndex(document);
  if (headingIndex < 0) {
    return {
      status: "paused",
      issues: [{ code: "missing-heading", message: "缺少“附图说明”标题。" }],
    };
  }

  const issues: DrawingExplanationSyncIssue[] = [];
  const entries = listVisibleDrawingExplanations(document);
  const linked: LinkedDrawingExplanation[] = [];
  const totalFigures = orderedFigureIds.length;
  const seen = new Set<number>();
  let hasUnknownFigure = false;
  let hasDuplicateFigure = false;

  entries.forEach((entry, entryIndex) => {
    const text = paragraphText(entry.paragraph).trim();
    const figureTokens = text.match(/(?:附图|图)\s*\d+/gu) ?? [];
    const figureId = figureIdForNumber(orderedFigureIds, entry.figureNumber);
    if (figureTokens.length > 1) {
      issues.push({
        code: "merged-explanation-line",
        message: `第 ${entryIndex + 1} 段含多个图号，每段只能写一张图。`,
        ...(figureId ? { figureId } : {}),
        paragraphId: entry.paragraph.id,
      });
    }
    if (entry.figureNumber > totalFigures) {
      hasUnknownFigure = true;
      issues.push({
        code: "unknown-figure",
        message: `图${entry.figureNumber} 不存在（共 ${totalFigures} 张图）。`,
        paragraphId: entry.paragraph.id,
      });
    } else if (seen.has(entry.figureNumber)) {
      hasDuplicateFigure = true;
      issues.push({
        code: "duplicate-figure",
        message: `图${entry.figureNumber} 出现多次，每张图只能有一条说明。`,
        ...(figureId ? { figureId } : {}),
        paragraphId: entry.paragraph.id,
      });
    } else {
      seen.add(entry.figureNumber);
      if (figureId) linked.push({ figureId, paragraph: entry.paragraph, index: entry.index });
    }
  });

  let hasMissingFigure = false;
  for (let number = 1; number <= totalFigures; number += 1) {
    if (seen.has(number)) continue;
    hasMissingFigure = true;
    const missingFigureId = orderedFigureIds[number - 1];
    issues.push({
      code: "missing-figure",
      message: `缺少图${number} 的说明。`,
      ...(missingFigureId ? { figureId: missingFigureId } : {}),
    });
  }

  if (!hasMissingFigure && !hasDuplicateFigure && !hasUnknownFigure) {
    entries.forEach((entry, entryIndex) => {
      if (entry.figureNumber === entryIndex + 1) return;
      const figureId = figureIdForNumber(orderedFigureIds, entry.figureNumber);
      issues.push({
        code: "out-of-order-explanation",
        message: `第 ${entryIndex + 1} 段图号应为图${entryIndex + 1}（当前为图${entry.figureNumber}）。`,
        ...(figureId ? { figureId } : {}),
        paragraphId: entry.paragraph.id,
      });
    });
  }

  if (issues.length > 0) return { status: "paused", issues };
  return {
    status: "active",
    headingId: document.content[headingIndex]?.id ?? "",
    linked,
    legend: drawingLegend(document),
  };
}

function findDrawingHeadingIndex(document: PatentBookDocument): number {
  return document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
  );
}

export function listVisibleDrawingExplanations(
  document: PatentBookDocument,
): VisibleDrawingExplanation[] {
  const headingIndex = findDrawingHeadingIndex(document);
  if (headingIndex < 0) return [];
  const entries: VisibleDrawingExplanation[] = [];
  for (let index = headingIndex + 1; index < document.content.length; index += 1) {
    const block = document.content[index];
    if (!block) continue;
    if (classifyDescriptionChapterBlock(block) !== null) break;
    if (block.type !== "paragraph") continue;
    const match = FIGURE_TOKEN_PATTERN.exec(paragraphText(block).trim());
    if (!match) continue;
    entries.push({ figureNumber: Number(match[1]), paragraph: block, index });
  }
  return entries;
}

function drawingLegend(document: PatentBookDocument): ParagraphNode | null {
  const headingIndex = findDrawingHeadingIndex(document);
  if (headingIndex < 0) return null;
  let legend: ParagraphNode | null = null;
  for (let index = headingIndex + 1; index < document.content.length; index += 1) {
    const block = document.content[index];
    if (!block) continue;
    if (classifyDescriptionChapterBlock(block) !== null) break;
    if (block.type === "paragraph" && /^其中/u.test(paragraphText(block).trim())) legend = block;
  }
  return legend;
}

function figureIdForNumber(
  orderedFigureIds: readonly string[],
  figureNumber: number,
): string | undefined {
  return figureNumber >= 1 && figureNumber <= orderedFigureIds.length
    ? orderedFigureIds[figureNumber - 1]
    : undefined;
}

function paragraphText(block: ParagraphNode | HeadingNode): string {
  return block.content
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "hard-break") return "\n";
      if (node.type === "inline-formula") return node.source;
      return "";
    })
    .join("");
}
