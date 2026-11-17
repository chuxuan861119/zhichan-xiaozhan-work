import type { BlockNode, ParagraphNode, PatentBookDocument } from "../document/model.js";
import { classifyDescriptionChapterBlock, type DescriptionChapterKind } from "./description.js";
import { firstReferenceMarkOccurrenceIndex } from "./reference-mark-text.js";
import { type PatentReferenceMark, parseReferenceLegendText } from "./reference-marks.js";

export function referenceLegendText(
  block: Extract<BlockNode, { type: "paragraph" | "heading" }>,
): string {
  return block.content.map((node) => (node.type === "text" ? node.text : "")).join("");
}

export function isSystemReferenceLegendPlaceholder(text: string): boolean {
  return /^其中[，,：:]\s*_+[。.]*$/u.test(text.trim());
}

/** 纯文本模式判断：段落是否以“其中”开头（图例段落的唯一识别依据，无特殊标记）。 */
export function isLegendParagraph(block: BlockNode): block is ParagraphNode {
  if (block.type !== "paragraph") return false;
  const text = referenceLegendText(block);
  return isSystemReferenceLegendPlaceholder(text) || parseReferenceLegendText(text).ok;
}

function chapterIndices(
  description: PatentBookDocument,
  chapterKind: DescriptionChapterKind,
): number[] {
  return description.content.flatMap((block, index) =>
    classifyDescriptionChapterBlock(block) === chapterKind ? [index] : [],
  );
}

function firstChapterIndexAfter(
  description: PatentBookDocument,
  afterIndex: number,
  chapterKind: DescriptionChapterKind,
): number {
  return chapterIndices(description, chapterKind).find((index) => index > afterIndex) ?? -1;
}

function locateDrawingHeadingIndex(description: PatentBookDocument): number {
  const candidates = chapterIndices(description, "drawing-explanation");
  if (candidates.length === 1) return candidates[0] ?? -1;
  if (candidates.length === 0) return -1;

  const beneficialIndices = chapterIndices(description, "beneficial-effects");
  const embodimentsIndices = chapterIndices(description, "detailed-embodiments");
  const contextualCandidates = candidates.filter(
    (candidate) =>
      beneficialIndices.some((index) => index < candidate) &&
      embodimentsIndices.some((index) => index > candidate),
  );
  return contextualCandidates.length === 1 ? (contextualCandidates[0] ?? -1) : -1;
}

/**
 * 判断说明书是否仍保有可识别的独立“附图说明”章节标题。
 * 与附图标记同步使用同一套版式和精确标题规则，避免两处口径不一致。
 */
export function hasDrawingExplanationHeading(description: PatentBookDocument | undefined): boolean {
  return description !== undefined && locateDrawingHeadingIndex(description) >= 0;
}

export type DrawingExplanationSegment = { start: number; end: number };

/**
 * 附图说明部分的段落范围：标题之后、“具体实施方式”标题之前
 * （没有“具体实施方式”时延伸到文档末尾）。
 */
export function drawingExplanationSegment(
  description: PatentBookDocument,
): DrawingExplanationSegment | null {
  const drawingsIndex = locateDrawingHeadingIndex(description);
  if (drawingsIndex < 0) return null;
  const embodimentsIndex = firstChapterIndexAfter(
    description,
    drawingsIndex,
    "detailed-embodiments",
  );
  return {
    start: drawingsIndex + 1,
    end: embodimentsIndex < 0 ? description.content.length : embodimentsIndex,
  };
}

/**
 * 附图说明章节内的“图例”段落（纯文本模式，无特殊标记）：以“其中”开头的段落。
 * 无附图说明标题时返回空数组。
 */
export function legendParagraphsInSegment(description: PatentBookDocument): ParagraphNode[] {
  const segment = drawingExplanationSegment(description);
  if (!segment) return [];
  return description.content.slice(segment.start, segment.end).filter(isLegendParagraph);
}

/** Suspected number-first legends must not disappear from validation merely because parsing fails. */
export function invalidLegendParagraphsInSegment(description: PatentBookDocument): ParagraphNode[] {
  const segment = drawingExplanationSegment(description);
  if (!segment) return [];
  return description.content
    .slice(segment.start, segment.end)
    .filter(
      (block): block is ParagraphNode =>
        block.type === "paragraph" &&
        /^其中[：:,，]\s*[0-9０-９]/u.test(referenceLegendText(block).trim()) &&
        !isLegendParagraph(block),
    );
}

/** 附图说明章节内最后一个“其中”段；无标题或不存在时返回 null。 */
export function lastLegendParagraph(description: PatentBookDocument): ParagraphNode | null {
  return legendParagraphsInSegment(description).at(-1) ?? null;
}

/**
 * 全文档范围内最后一个“其中”段：优先附图说明章节，章节不存在（缺标题）时
 * 退化为全文档扫描。仅用于迁移等兜底场景，不用于运行期同步判断。
 */
export function lastLegendParagraphAnywhere(description: PatentBookDocument): ParagraphNode | null {
  const segment = drawingExplanationSegment(description);
  if (segment) {
    for (let index = segment.end - 1; index >= segment.start; index -= 1) {
      const block = description.content[index];
      if (block && isLegendParagraph(block)) return block;
    }
  }
  for (let index = description.content.length - 1; index >= 0; index -= 1) {
    const block = description.content[index];
    if (block && isLegendParagraph(block)) return block;
  }
  return null;
}

export function sortReferenceMarks<T extends Pick<PatentReferenceMark, "number">>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => left.number - right.number);
}

/**
 * 按关键词在权利要求书中的出现先后排序（而非编号数字大小）。
 * 未在权利要求书中出现的关键词排在已出现的之后，并按编号数字兜底；
 * 权利要求书缺失时退化为按编号排序。
 */
export function sortReferenceMarksByAppearance<
  T extends Pick<PatentReferenceMark, "number" | "keyword">,
>(entries: readonly T[], claimsDocument: PatentBookDocument | undefined): T[] {
  const positions = new Map<string, number>();
  if (claimsDocument) {
    for (const entry of entries) {
      const index = firstReferenceMarkOccurrenceIndex(claimsDocument, entry, entries);
      if (index !== null) positions.set(entry.keyword, index);
    }
  }
  return [...entries].sort((left, right) => {
    const leftPosition = positions.get(left.keyword);
    const rightPosition = positions.get(right.keyword);
    if (leftPosition !== undefined && rightPosition !== undefined) {
      return leftPosition - rightPosition;
    }
    if (leftPosition !== undefined) return -1;
    if (rightPosition !== undefined) return 1;
    return left.number - right.number;
  });
}
