import { createHash } from "node:crypto";
import type {
  AiCorrectionBookKind,
  AiCorrectionScope,
} from "../../shared/ai-correction/contract.js";
import { aiContentBlocks, mixedSelection } from "../../shared/ai-correction/mixed-content.js";
import type { TextPolishSelectionScope } from "../../shared/ai-correction/text-polish-contract.js";
import type { BlockNode, InlineNode, ParagraphNode } from "../../shared/document/model.js";
import { parseClaimParagraphs } from "../../shared/patent/claim-text-tools.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import type { ProviderSegment } from "./prompt.js";
import { calculateDocumentCoverage } from "./prompt-context.js";

export type PatentCorrectionSegment = ProviderSegment &
  Readonly<{
    segmentId: string;
    blockId: string;
    bookKind: AiCorrectionBookKind;
    sourceStartOffset: number;
    text: string;
  }>;

export class PatentContextError extends Error {
  readonly code: "INVALID_SELECTION" | "CONTENT_TOO_LARGE" | "BOOK_NOT_FOUND";
  constructor(code: PatentContextError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PatentContextError";
  }
}

function inlineText(content: readonly InlineNode[]): string {
  return content
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "hard-break") return "\n";
      return "\uFFFC";
    })
    .join("");
}

function textBlocks(
  block: BlockNode,
): Array<{ id: string; type: "paragraph" | "heading"; text: string; structure: string }> {
  if (block.type === "paragraph" || block.type === "heading") {
    return [
      { id: block.id, type: block.type, text: inlineText(block.content), structure: block.type },
    ];
  }
  if (block.type === "bullet-list" || block.type === "ordered-list") {
    return block.items.flatMap((item, itemIndex) =>
      item.content.map((paragraph: ParagraphNode) => ({
        id: paragraph.id,
        type: "paragraph" as const,
        text: inlineText(paragraph.content),
        structure: `${block.type} 项${block.type === "ordered-list" ? block.start + itemIndex : itemIndex + 1}`,
      })),
    );
  }
  if (block.type === "table") {
    return block.rows.flatMap((row, rowIndex) =>
      row.cells.flatMap((cell, cellIndex) =>
        cell.content.map((paragraph) => ({
          id: paragraph.id,
          type: "paragraph" as const,
          text: inlineText(paragraph.content),
          structure: `table:row-${rowIndex + 1}:cell-${cellIndex + 1}`,
        })),
      ),
    );
  }
  return [];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildPatentCorrectionContext(
  patent: CanonicalPatent,
  scope: AiCorrectionScope,
  maxCharacters: number,
): {
  segments: PatentCorrectionSegment[];
  characterCount: number;
  sourceTexts: Record<string, string>;
  documentComplete: boolean;
} {
  const book = patent.books.find((candidate) => candidate.kind === scope.bookKind);
  if (!book) throw new PatentContextError("BOOK_NOT_FOUND", "未找到需要检查的专利书册。");
  const legacy = new Map(book.document.content.flatMap(textBlocks).map((b) => [b.id, b]));
  const contentBlocks = aiContentBlocks(book.document.content);
  const blocks = contentBlocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.parts.map((p) => p.text).join(""),
    structure:
      block.type === "paragraph" && block.structure === "正文"
        ? "paragraph"
        : block.type === "heading"
          ? "heading"
          : block.structure,
    ...legacy.get(block.id),
    objectContext: block.parts.flatMap((part, index) =>
      part.description
        ? [
            {
              offset: block.parts.slice(0, index).reduce((n, p) => n + p.text.length, 0),
              description: part.description,
            },
          ]
        : [],
    ),
    mixedStructure: block.structure,
  }));
  const claimMetadata = new Map<string, NonNullable<ProviderSegment["claim"]>>();
  if (scope.bookKind === "claims") {
    let run: typeof blocks = [];
    const flush = () => {
      if (run.length === 0) return;
      const parsed = parseClaimParagraphs(run.map((block) => block.text));
      for (const claim of parsed.claims) {
        const claimBlocks = run
          .slice(claim.startParagraphIndex, claim.endParagraphIndex)
          .filter((block) => block.text.trim().length > 0);
        for (const [paragraphIndex, block] of claimBlocks.entries()) {
          claimMetadata.set(block.id, {
            number: String(claim.number),
            paragraphIndex: paragraphIndex + 1,
            paragraphCount: claimBlocks.length,
            groupId: `claim-${claimBlocks[0]?.id ?? block.id}`,
          });
        }
      }
      run = [];
    };
    for (const block of blocks) {
      if (block.type !== "paragraph" || block.structure !== "paragraph") {
        flush();
        continue;
      }
      run.push(block);
    }
    flush();
  }
  let selected: Array<{
    id: string;
    text: string;
    bookKind: AiCorrectionBookKind;
    sourceStartOffset: number;
  }>;
  if (scope.kind === "selection") {
    let previousIndex = -1;
    selected = scope.blocks.map((span) => {
      const index = blocks.findIndex((candidate) => candidate.id === span.blockId);
      const block = blocks[index];
      if (
        !block ||
        block.type !== span.blockType ||
        (previousIndex >= 0 &&
          (scope.formatVersion === 2 ? index <= previousIndex : index !== previousIndex + 1)) ||
        span.startOffset > span.endOffset ||
        span.endOffset > block.text.length
      ) {
        throw new PatentContextError("INVALID_SELECTION", "选中文字已变化，请重新选择后检查。");
      }
      previousIndex = index;
      return {
        id: block.id,
        text: block.text.slice(span.startOffset, span.endOffset),
        bookKind: scope.bookKind,
        sourceStartOffset: span.startOffset,
      };
    });
    const selectedText =
      scope.formatVersion === 2
        ? mixedSelection(contentBlocks, scope.blocks).text
        : selected.map(({ text }) => text).join("\n");
    if (!selectedText.trim() || sha256(selectedText) !== scope.selectedTextHash) {
      throw new PatentContextError("INVALID_SELECTION", "选中文字已变化，请重新选择后检查。");
    }
  } else {
    selected = blocks
      .filter(({ text }) => text.length > 0)
      .map((block) => ({ ...block, bookKind: scope.bookKind, sourceStartOffset: 0 }));
  }
  const coverageSpans =
    scope.kind === "selection"
      ? scope.blocks
      : selected.map((block) => ({
          blockId: block.id,
          startOffset: 0,
          endOffset: block.text.length,
        }));
  const documentComplete = calculateDocumentCoverage(blocks, coverageSpans).completeDocument;
  const characterCount = selected.reduce(
    (total, segment) =>
      total +
      segment.text.length +
      (blocks
        .find((b) => b.id === segment.id)
        ?.objectContext.filter(
          (o) =>
            o.offset >= segment.sourceStartOffset &&
            o.offset < segment.sourceStartOffset + segment.text.length,
        )
        .reduce((n, o) => n + o.description.length, 0) ?? 0),
    0,
  );
  if (characterCount === 0) {
    throw new PatentContextError("INVALID_SELECTION", "当前范围没有可检查的文字。");
  }
  if (scope.kind === "current-book" && characterCount > maxCharacters) {
    throw new PatentContextError(
      "CONTENT_TOO_LARGE",
      "当前范围超过单次最大提交字符数，请缩小范围。",
    );
  }
  return {
    sourceTexts: Object.fromEntries(
      blocks
        .filter((block) => selected.some((span) => span.id === block.id))
        .map((block) => [block.id, block.text]),
    ),
    segments: selected.map((segment, index) => ({
      segmentId: `segment-${index + 1}`,
      blockId: segment.id,
      bookKind: segment.bookKind,
      sourceStartOffset: segment.sourceStartOffset,
      text: segment.text,
      boundary: {
        startsAtParagraphStart: segment.sourceStartOffset === 0,
        endsAtParagraphEnd:
          segment.sourceStartOffset + segment.text.length ===
          blocks.find((block) => block.id === segment.id)?.text.length,
      },
      structure:
        blocks.find((block) => block.id === segment.id)?.mixedStructure === "正文"
          ? "paragraph"
          : blocks.find((block) => block.id === segment.id)?.structure,
      ...(blocks.find((block) => block.id === segment.id)?.objectContext.length
        ? {
            objects: blocks
              .find((block) => block.id === segment.id)!
              .objectContext.filter(
                (o) =>
                  o.offset >= segment.sourceStartOffset &&
                  o.offset < segment.sourceStartOffset + segment.text.length,
              )
              .map((o) => ({ ...o, offset: o.offset - segment.sourceStartOffset })),
          }
        : {}),
      ...(blocks.find((block) => block.id === segment.id)?.mixedStructure.startsWith("表")
        ? { tableStructure: blocks.find((block) => block.id === segment.id)!.mixedStructure }
        : {}),
      claim: claimMetadata.get(segment.id),
    })),
    characterCount,
    documentComplete,
  };
}

export function buildPatentPolishSelection(
  patent: CanonicalPatent,
  scope: TextPolishSelectionScope,
  maxCharacters: number,
): { text: string; blocks: TextPolishSelectionScope["blocks"]; formatVersion?: 2 } {
  const book = patent.books.find((candidate) => candidate.kind === scope.bookKind);
  if (!book) throw new PatentContextError("BOOK_NOT_FOUND", "未找到需要润色的专利书册。");
  if (scope.formatVersion === 2) {
    const mixed = mixedSelection(aiContentBlocks(book.document.content), scope.blocks);
    if (!mixed.text.trim() || sha256(mixed.text) !== scope.selectedTextHash)
      throw new PatentContextError("INVALID_SELECTION", "选区内容或结构已变化，请重新选择。");
    if (mixed.text.length > maxCharacters)
      throw new PatentContextError(
        "CONTENT_TOO_LARGE",
        "选区超过当前处理容量，请分段选择；公式和表格无需转换图片。",
      );
    return { text: mixed.text, blocks: scope.blocks, formatVersion: 2 };
  }
  const blocks = book.document.content.flatMap((block, sourceIndex) =>
    block.type === "paragraph" || block.type === "heading"
      ? [
          {
            id: block.id,
            type: block.type,
            text: inlineText(block.content),
            content: block.content,
            sourceIndex,
          },
        ]
      : [],
  );
  let previousIndex = -1;
  const snippets = scope.blocks.map((span) => {
    const index = blocks.findIndex((candidate) => candidate.id === span.blockId);
    const block = blocks[index];
    if (
      !block ||
      block.type !== span.blockType ||
      (previousIndex >= 0 && block.sourceIndex !== previousIndex + 1) ||
      span.startOffset > span.endOffset ||
      span.endOffset > block.text.length
    ) {
      throw new PatentContextError("INVALID_SELECTION", "选中文字已变化，请重新选择后润色。");
    }
    previousIndex = block.sourceIndex;
    let offset = 0;
    for (const node of block.content) {
      const end = offset + (node.type === "text" ? node.text.length : 1);
      if (node.type !== "text" && span.startOffset < end && span.endOffset > offset) {
        throw new PatentContextError("INVALID_SELECTION", "选区不能包含公式、换行或其他对象。");
      }
      offset = end;
    }
    return block.text.slice(span.startOffset, span.endOffset);
  });
  const text = snippets.join("\n");
  if (!text.trim() || sha256(text) !== scope.selectedTextHash) {
    throw new PatentContextError("INVALID_SELECTION", "选中文字已变化，请重新选择后润色。");
  }
  if (text.length > maxCharacters) {
    throw new PatentContextError(
      "CONTENT_TOO_LARGE",
      "当前选区超过单次最大提交字符数，请缩小范围。",
    );
  }
  return { text, blocks: scope.blocks };
}
