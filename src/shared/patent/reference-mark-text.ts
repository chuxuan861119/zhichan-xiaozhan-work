import type {
  BlockNode,
  InlineNode,
  ParagraphNode,
  PatentBookDocument,
  TextMark,
} from "../document/model.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import { descriptionReferenceNumberSuffix } from "./reference-mark-description-number.js";
import {
  AUTOMATIC_EDIT_RED,
  parseReferenceLegendText,
  referenceNumberColor,
} from "./reference-marks.js";

export type DocumentMutation = { document: PatentBookDocument; replacementCount: number };

export type ReferenceMarkKeyword = Readonly<{ keyword: string; number: number }>;

export type InterruptedKeywordMatches = Readonly<{
  forms: readonly string[];
  matchCount: number;
  contexts: readonly string[];
}>;

export type KeywordNumberInspection = Readonly<{
  keywordCount: number;
  numberedCount: number;
  unnumberedCount: number;
  nonstandardCount: number;
  numbers: readonly number[];
}>;

type ReplacementMark = Extract<
  TextMark,
  { type: "color" | "background-color" | "reference-mark-token" }
>;

function automaticEditMark(): ReplacementMark {
  return { type: "color", value: AUTOMATIC_EDIT_RED };
}

function referenceTokenMark(number: number): ReplacementMark {
  return { type: "reference-mark-token", number };
}

export function numberClaimsKeyword(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  options: { protectedSearches?: readonly string[] } = {},
): DocumentMutation {
  // 已有“关键词(序号)”或旧格式“关键词（序号）”时不重复添加括号。
  return replaceLiteral(document, keyword, `${keyword}(${number})`, referenceTokenMark(number), {
    skipFollowing: [`(${number})`, `（${number}）`],
    skipFollowingNumber: true,
    ...(options.protectedSearches ? { protectedSearches: options.protectedSearches } : {}),
  });
}

/**
 * 返回正文中被既有较短附图标记打断的目标关键词。
 * 例如目标为“自行车把手”，既有“自行车(1)”时识别“自行车(1)把手”。
 */
export function interruptedClaimsKeywordMatches(
  document: PatentBookDocument,
  keyword: string,
  referenceMarks: readonly ReferenceMarkKeyword[],
  options: { includeUnparenthesizedNumbers?: boolean } = {},
): InterruptedKeywordMatches {
  const text = documentText(document);
  const protectedSearches = protectedReferenceMarkKeywordSearches(
    document,
    keyword,
    referenceMarks,
    options,
  );
  const protectedRanges = textRanges(text, protectedSearches);
  const matches = rawInterruptedKeywordMatches(text, keyword, referenceMarks, options).filter(
    (match) =>
      !protectedRanges.some((range) =>
        cutsProtectedKeyword(match.index, match.index + match.text.length, range.start, range.end),
      ),
  );
  return {
    forms: [...new Set(matches.map((match) => match.text))],
    matchCount: matches.length,
    contexts: [
      ...new Set(
        matches.slice(0, 3).map((match) => {
          const start = Math.max(0, match.index - 16);
          const end = Math.min(text.length, match.index + match.text.length + 16);
          return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\n/gu, " ")}${
            end < text.length ? "…" : ""
          }`;
        }),
      ),
    ],
  };
}

/** 其他已登记关键词及其被编号打断的实际形式，用于检查匹配是否切入关键词。 */
export function protectedClaimsKeywordSearches(
  document: PatentBookDocument,
  keyword: string,
  referenceMarks: readonly ReferenceMarkKeyword[],
): string[] {
  return protectedReferenceMarkKeywordSearches(document, keyword, referenceMarks);
}

/**
 * 其他已登记关键词及其被更短编号打断的实际形式。
 * 说明书实施例允许无括号编号（例如“自行车1把手2”），因此调用方可额外保护该形式。
 */
export function protectedReferenceMarkKeywordSearches(
  document: PatentBookDocument,
  keyword: string,
  referenceMarks: readonly ReferenceMarkKeyword[],
  options: { includeUnparenthesizedNumbers?: boolean } = {},
): string[] {
  const text = documentText(document);
  const searches = new Set<string>();
  for (const mark of referenceMarks) {
    if (mark.keyword === keyword) continue;
    searches.add(mark.keyword);
    for (const match of rawInterruptedKeywordMatches(text, mark.keyword, referenceMarks, options)) {
      searches.add(match.text);
    }
  }
  return [...searches];
}

/** 返回附图标记在权利要求书中的首次独立出现位置。 */
export function firstReferenceMarkOccurrenceIndex(
  document: PatentBookDocument,
  target: ReferenceMarkKeyword,
  referenceMarks: readonly ReferenceMarkKeyword[],
): number | null {
  const text = documentText(document);
  const protectedRanges = textRanges(
    text,
    protectedClaimsKeywordSearches(document, target.keyword, referenceMarks),
  );
  const forms = [
    target.keyword,
    ...rawInterruptedKeywordMatches(text, target.keyword, referenceMarks).map(
      (match) => match.text,
    ),
  ];
  const isProtected = (start: number, end: number): boolean =>
    protectedRanges.some((range) => cutsProtectedKeyword(start, end, range.start, range.end));
  const positions = (searches: readonly string[]): number[] => {
    const result: number[] = [];
    for (const search of searches) {
      let start = text.indexOf(search);
      while (start >= 0) {
        if (!isProtected(start, start + search.length)) result.push(start);
        start = text.indexOf(search, start + 1);
      }
    }
    return result;
  };
  const occurrences = positions(forms);
  return occurrences.length > 0 ? Math.min(...occurrences) : null;
}

/** 按用户确认，把被旧编号打断的实际形式改为新的完整关键词编号。 */
export function repairInterruptedClaimsKeyword(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  forms: readonly string[],
  protectedSearches: readonly string[] = [],
): DocumentMutation {
  let mutation: DocumentMutation = { document, replacementCount: 0 };
  for (const form of forms) {
    const current = replaceLiteral(
      mutation.document,
      form,
      `${keyword}(${number})`,
      referenceTokenMark(number),
      { protectedSearches },
    );
    mutation = combineMutations(mutation, current);
  }
  return mutation;
}

export function cancelClaimsKeywordNumber(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  options: { protectedSearches?: readonly string[] } = {},
): DocumentMutation {
  const current = replaceLiteral(document, `${keyword}(${number})`, keyword, automaticEditMark(), {
    removeMarkTypes: ["color", "background-color", "reference-mark-token"],
    ...(options.protectedSearches ? { protectedSearches: options.protectedSearches } : {}),
  });
  const legacy = replaceLiteral(
    current.document,
    `${keyword}（${number}）`,
    keyword,
    automaticEditMark(),
    {
      removeMarkTypes: ["color", "background-color", "reference-mark-token"],
      ...(options.protectedSearches ? { protectedSearches: options.protectedSearches } : {}),
    },
  );
  return combineMutations(current, legacy);
}

export function recolorClaimsKeywordNumber(
  document: PatentBookDocument,
  keyword: string,
  number: number,
): DocumentMutation {
  const current = replaceLiteral(
    document,
    `${keyword}(${number})`,
    `${keyword}(${number})`,
    referenceTokenMark(number),
    { removeBackgroundColors: [referenceNumberColor(number)] },
  );
  const legacy = replaceLiteral(
    current.document,
    `${keyword}（${number}）`,
    `${keyword}(${number})`,
    referenceTokenMark(number),
    { removeBackgroundColors: [referenceNumberColor(number)] },
  );
  return combineMutations(current, legacy);
}

export function renameKeyword(
  document: PatentBookDocument,
  oldKeyword: string,
  newKeyword: string,
  options: { protectedSearches?: readonly string[]; excludedBlockIds?: readonly string[] } = {},
): DocumentMutation {
  return replaceLiteral(document, oldKeyword, newKeyword, automaticEditMark(), options);
}

export function renumberClaimsKeyword(
  document: PatentBookDocument,
  keyword: string,
  oldNumber: number,
  newNumber: number,
  options: { protectedSearches?: readonly string[] } = {},
): DocumentMutation {
  const current = replaceLiteral(
    document,
    `${keyword}(${oldNumber})`,
    `${keyword}(${newNumber})`,
    referenceTokenMark(newNumber),
    {
      ...options,
      removeReferenceTokenNumbers: [oldNumber, newNumber],
      removeBackgroundColors: [referenceNumberColor(oldNumber), referenceNumberColor(newNumber)],
    },
  );
  const legacy = replaceLiteral(
    current.document,
    `${keyword}（${oldNumber}）`,
    `${keyword}(${newNumber})`,
    referenceTokenMark(newNumber),
    {
      ...options,
      removeReferenceTokenNumbers: [oldNumber, newNumber],
      removeBackgroundColors: [referenceNumberColor(oldNumber), referenceNumberColor(newNumber)],
    },
  );
  return combineMutations(current, legacy);
}

/** Panel edits cover the entire book, while preserving optional numbering and its notation. */
export function renumberTextBookKeyword(
  document: PatentBookDocument,
  keyword: string,
  oldNumber: number,
  newNumber: number,
  options: { protectedSearches?: readonly string[]; excludedBlockIds?: readonly string[] } = {},
): DocumentMutation {
  if (oldNumber === newNumber) return { document, replacementCount: 0 };
  const text = documentText(document);
  const suffixes = new Set<string>();
  let offset = text.indexOf(keyword);
  while (offset >= 0) {
    const suffix = descriptionReferenceNumberSuffix(text.slice(offset + keyword.length));
    if (suffix?.number === oldNumber) suffixes.add(suffix.text);
    offset = text.indexOf(keyword, offset + keyword.length);
  }
  let mutation: DocumentMutation = { document, replacementCount: 0 };
  for (const suffix of suffixes) {
    const updatedSuffix = suffix.replace(/[0-9０-９]+/u, (digits) =>
      /^[０-９]+$/u.test(digits)
        ? String(newNumber).replace(/[0-9]/gu, (digit) =>
            String.fromCharCode(digit.charCodeAt(0) + "０".charCodeAt(0) - "0".charCodeAt(0)),
          )
        : String(newNumber),
    );
    const changed = replaceLiteral(
      mutation.document,
      `${keyword}${suffix}`,
      `${keyword}${updatedSuffix}`,
      referenceTokenMark(newNumber),
      {
        ...options,
        // The same literal can occur both as a mark and as a quantity (e.g. 壳5 / 壳5mm).
        acceptMatch: (run, start) =>
          descriptionReferenceNumberSuffix(run.slice(start + keyword.length))?.text === suffix,
        removeReferenceTokenNumbers: [oldNumber, newNumber],
        removeBackgroundColors: [referenceNumberColor(oldNumber), referenceNumberColor(newNumber)],
      },
    );
    mutation = combineMutations(mutation, changed);
  }
  return mutation;
}

export function renumberEmbodimentKeyword(
  document: PatentBookDocument,
  keyword: string,
  oldNumber: number,
  newNumber: number,
  options: { protectedSearches?: readonly string[] } = {},
): DocumentMutation {
  const blockRange = descriptionEmbodimentBlockRange(document);
  return replaceLiteral(
    document,
    `${keyword}${oldNumber}`,
    `${keyword}${newNumber}`,
    referenceTokenMark(newNumber),
    {
      trailingNumberBoundary: true,
      blockRange,
      ...(options.protectedSearches ? { protectedSearches: options.protectedSearches } : {}),
    },
  );
}

export const SUPPLEMENT_REFERENCE_NUMBER_COLOR = "#7C3AED";

/** Explicit numbering uses semantic marks; supplemental numbering keeps its purple edit color. */
export function numberDescriptionKeyword(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  blockRange: { start: number; end: number },
  protectedSearches: readonly string[],
): DocumentMutation {
  const text = documentText({
    ...document,
    content: document.content.slice(blockRange.start, blockRange.end),
  });
  const suffixes = new Set<string>();
  for (
    let offset = text.indexOf(keyword);
    offset >= 0;
    offset = text.indexOf(keyword, offset + keyword.length)
  ) {
    const suffix = descriptionReferenceNumberSuffix(text.slice(offset + keyword.length));
    if (suffix?.number === number) suffixes.add(suffix.text);
  }
  let mutation: DocumentMutation = { document, replacementCount: 0 };
  for (const suffix of suffixes) {
    mutation = combineMutations(
      mutation,
      replaceLiteral(
        mutation.document,
        `${keyword}${suffix}`,
        `${keyword}${number}`,
        referenceTokenMark(number),
        {
          blockRange,
          protectedSearches,
          acceptMatch: (run, start) =>
            descriptionReferenceNumberSuffix(run.slice(start + keyword.length))?.text === suffix,
        },
      ),
    );
  }
  return combineMutations(
    mutation,
    replaceLiteral(mutation.document, keyword, `${keyword}${number}`, referenceTokenMark(number), {
      blockRange,
      protectedSearches,
      skipFollowingNumber: true,
      skipFollowingBareNumber: true,
      acceptMatch: (run, start) =>
        !/^[\t \u3000]*(?:[（(][\t \u3000]*)?[0-9０-９]/u.test(run.slice(start + keyword.length)),
    }),
  );
}

export function supplementEmbodimentKeyword(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  blockRange: { start: number; end: number },
  protectedSearches: readonly string[],
): DocumentMutation {
  return replaceLiteral(document, keyword, `${keyword}${number}`, referenceTokenMark(number), {
    blockRange,
    protectedSearches,
    skipFollowingNumber: true,
    skipFollowingBareNumber: true,
    removeMarkTypes: ["color", "reference-mark-token"],
    additionalMarks: [{ type: "color", value: SUPPLEMENT_REFERENCE_NUMBER_COLOR }],
    acceptMatch: (text, start) =>
      !/^[\t \u3000]*(?:[（(][\t \u3000]*)?[0-9０-９]/u.test(text.slice(start + keyword.length)),
  });
}

export function cancelEmbodimentKeywordNumber(
  document: PatentBookDocument,
  keyword: string,
  number: number,
  options: { protectedSearches?: readonly string[] } = {},
): DocumentMutation {
  const blockRange = descriptionEmbodimentBlockRange(document);
  return replaceLiteral(document, `${keyword}${number}`, keyword, automaticEditMark(), {
    trailingNumberBoundary: true,
    blockRange,
    removeMarkTypes: ["color", "background-color", "reference-mark-token"],
    ...(options.protectedSearches ? { protectedSearches: options.protectedSearches } : {}),
  });
}

function descriptionEmbodimentBlockRange(document: PatentBookDocument): {
  start: number;
  end: number;
} {
  const headingIndex = document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
  );
  if (headingIndex < 0) return { start: 0, end: 0 };
  const nextSectionOffset = document.content
    .slice(headingIndex + 1)
    .findIndex((block) => classifyDescriptionChapterBlock(block) !== null);
  return {
    start: headingIndex + 1,
    end: nextSectionOffset < 0 ? document.content.length : headingIndex + 1 + nextSectionOffset,
  };
}

export function countKeyword(
  document: PatentBookDocument,
  keyword: string,
  options: { excludeLegend?: boolean; protectedSearches?: readonly string[] } = {},
): number {
  if (!keyword) return 0;
  const text = documentText(document, options.excludeLegend);
  const protectedRanges = textRanges(text, options.protectedSearches ?? []);
  let count = 0;
  let start = text.indexOf(keyword);
  while (start >= 0) {
    const end = start + keyword.length;
    if (!protectedRanges.some((range) => cutsProtectedKeyword(start, end, range.start, range.end)))
      count += 1;
    start = text.indexOf(keyword, start + keyword.length);
  }
  return count;
}

export function keywordNumbers(document: PatentBookDocument, keyword: string): number[] {
  return [...inspectKeywordNumbers(document, keyword).numbers];
}

export function countDetachedKeywordNumber(
  document: PatentBookDocument,
  keyword: string,
  number: number,
): number {
  let detached = 0;
  const expectedHighlight = referenceNumberColor(number);
  for (const content of documentInlineContainers(document)) {
    let text = "";
    const highlightedRanges: Array<{ start: number; end: number }> = [];
    for (const node of content) {
      const start = text.length;
      text += node.type === "text" ? node.text : " ";
      if (
        node.type === "text" &&
        node.marks.some(
          (mark) =>
            (mark.type === "reference-mark-token" && mark.number === number) ||
            (mark.type === "background-color" && mark.value === expectedHighlight),
        )
      ) {
        highlightedRanges.push({ start, end: text.length });
      }
    }
    for (const match of text.matchAll(/[（(][\t \u3000]*([0-9０-９]+)[\t \u3000]*[)）]/gu)) {
      const parsed = Number(toAsciiDigits(match[1] ?? ""));
      const start = match.index;
      const end = start === undefined ? undefined : start + (match[0]?.length ?? 0);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed !== number ||
        start === undefined ||
        end === undefined ||
        !highlightedRanges.some((range) => start < range.end && end > range.start)
      ) {
        continue;
      }
      const prefix = text.slice(0, start).replace(/[\t \u3000]+$/u, "");
      if (!prefix.endsWith(keyword)) detached += 1;
    }
  }
  return detached;
}

function documentInlineContainers(
  document: PatentBookDocument,
): readonly (readonly InlineNode[])[] {
  return document.content.flatMap((block) => {
    if (block.type === "paragraph" || block.type === "heading") return [block.content];
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      return block.items.flatMap((item) => item.content.map((paragraph) => paragraph.content));
    }
    if (block.type === "table") {
      return block.rows.flatMap((row) =>
        row.cells.flatMap((cell) => cell.content.map((paragraph) => paragraph.content)),
      );
    }
    return [];
  });
}

export function inspectKeywordNumbers(
  document: PatentBookDocument,
  keyword: string,
  options: { protectedSearches?: readonly string[]; includeUnparenthesizedNumbers?: boolean } = {},
): KeywordNumberInspection {
  if (!keyword) {
    return {
      keywordCount: 0,
      numberedCount: 0,
      unnumberedCount: 0,
      nonstandardCount: 0,
      numbers: [],
    };
  }
  const text = documentText(document);
  const protectedRanges = textRanges(text, options.protectedSearches ?? []);
  const numbers: number[] = [];
  let keywordCount = 0;
  let numberedCount = 0;
  let nonstandardCount = 0;
  let start = text.indexOf(keyword);
  while (start >= 0) {
    const end = start + keyword.length;
    const protectedOccurrence = protectedRanges.some((range) =>
      cutsProtectedKeyword(start, end, range.start, range.end),
    );
    if (!protectedOccurrence) {
      keywordCount += 1;
      const suffix = text.slice(end);
      const matched = suffix.match(
        /^[\t \u3000]*([（(])[\t \u3000]*([0-9０-９]+)[\t \u3000]*([)）])/u,
      );
      if (matched) {
        const numberText = toAsciiDigits(matched[2] ?? "");
        const number = Number(numberText);
        if (Number.isSafeInteger(number)) {
          numberedCount += 1;
          numbers.push(number);
          const complete = matched[0] ?? "";
          if (
            !options.includeUnparenthesizedNumbers &&
            complete !== `(${number})` &&
            complete !== `（${number}）`
          )
            nonstandardCount += 1;
        }
      } else if (options.includeUnparenthesizedNumbers) {
        const bare = descriptionReferenceNumberSuffix(suffix);
        if (bare) {
          numberedCount += 1;
          numbers.push(bare.number);
        } else if (/^[\t \u3000]*[（(][\t \u3000]*[0-9０-９]/u.test(suffix)) nonstandardCount += 1;
      }
    }
    start = text.indexOf(keyword, start + Math.max(keyword.length, 1));
  }
  return {
    keywordCount,
    numberedCount,
    unnumberedCount: Math.max(keywordCount - numberedCount, 0),
    nonstandardCount,
    numbers,
  };
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode("0".charCodeAt(0) + digit.charCodeAt(0) - "０".charCodeAt(0)),
  );
}

export function maxParenthesizedNumber(document: PatentBookDocument): number | null {
  const numbers = [...documentText(document).matchAll(/(?:\((\d+)\)|（(\d+)）)/gu)]
    .map((match) => Number(match[1] ?? match[2]))
    .filter(Number.isSafeInteger);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

export function documentText(document: PatentBookDocument, excludeLegend = false): string {
  const paragraphText = (paragraph: { content: readonly InlineNode[] }) =>
    paragraph.content.map((node) => (node.type === "text" ? node.text : " ")).join("");
  const excludedLegendIds = excludeLegend ? drawingLegendParagraphIds(document) : new Set<string>();
  return document.content
    .flatMap((block) => {
      if (excludedLegendIds.has(block.id)) return [];
      if (block.type === "paragraph" || block.type === "heading") return [paragraphText(block)];
      if (block.type === "bullet-list" || block.type === "ordered-list")
        return block.items.flatMap((item) => item.content.map(paragraphText));
      if (block.type === "table")
        return block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => cell.content.map(paragraphText)),
        );
      return [];
    })
    .join("\n");
}

function drawingLegendParagraphIds(document: PatentBookDocument): Set<string> {
  const drawingCandidates = document.content.flatMap((block, index) =>
    classifyDescriptionChapterBlock(block) === "drawing-explanation" ? [index] : [],
  );
  let drawingIndex = drawingCandidates.length === 1 ? (drawingCandidates[0] ?? -1) : -1;
  if (drawingCandidates.length > 1) {
    const beneficial = document.content.flatMap((block, index) =>
      classifyDescriptionChapterBlock(block) === "beneficial-effects" ? [index] : [],
    );
    const embodiments = document.content.flatMap((block, index) =>
      classifyDescriptionChapterBlock(block) === "detailed-embodiments" ? [index] : [],
    );
    const contextual = drawingCandidates.filter(
      (candidate) =>
        beneficial.some((index) => index < candidate) &&
        embodiments.some((index) => index > candidate),
    );
    drawingIndex = contextual.length === 1 ? (contextual[0] ?? -1) : -1;
  }
  if (drawingIndex < 0) return new Set();
  const nextEmbodimentsOffset = document.content
    .slice(drawingIndex + 1)
    .findIndex((block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments");
  const end =
    nextEmbodimentsOffset < 0 ? document.content.length : drawingIndex + 1 + nextEmbodimentsOffset;
  return new Set(
    document.content.slice(drawingIndex + 1, end).flatMap((block) => {
      if (block.type !== "paragraph") return [];
      const text = paragraphTextValue(block).trim();
      return isSystemReferenceLegendPlaceholderText(text) || parseReferenceLegendText(text).ok
        ? [block.id]
        : [];
    }),
  );
}

function paragraphTextValue(block: Extract<BlockNode, { type: "paragraph" }>): string {
  return block.content.map((node) => (node.type === "text" ? node.text : "")).join("");
}

function isSystemReferenceLegendPlaceholderText(text: string): boolean {
  return /^其中[，,：:]\s*_+[。.]*$/u.test(text);
}

function replaceLiteral(
  document: PatentBookDocument,
  search: string,
  replacement: string,
  replacementMark: ReplacementMark,
  options: {
    trailingNumberBoundary?: boolean;
    skipFollowing?: string | readonly string[];
    skipFollowingNumber?: boolean;
    skipFollowingBareNumber?: boolean;
    blockRange?: { start: number; end: number };
    removeMarkTypes?: readonly TextMark["type"][];
    protectedSearches?: readonly string[];
    removeBackgroundColors?: readonly string[];
    removeReferenceTokenNumbers?: readonly number[];
    acceptMatch?: (text: string, start: number) => boolean;
    excludedBlockIds?: readonly string[];
    additionalMarks?: readonly TextMark[];
  } = {},
): DocumentMutation {
  const { trailingNumberBoundary = false, skipFollowing, blockRange } = options;
  const removedMarkTypes = new Set(options.removeMarkTypes ?? [replacementMark.type]);
  const removedBackgroundColors = new Set(options.removeBackgroundColors ?? []);
  const removedReferenceTokenNumbers = new Set(options.removeReferenceTokenNumbers ?? []);
  let sharedPrefix = 0;
  while (
    sharedPrefix < Math.min(search.length, replacement.length) &&
    search[sharedPrefix] === replacement[sharedPrefix]
  )
    sharedPrefix += 1;
  let sharedSuffix = 0;
  while (
    sharedSuffix < Math.min(search.length, replacement.length) - sharedPrefix &&
    search[search.length - 1 - sharedSuffix] === replacement[replacement.length - 1 - sharedSuffix]
  )
    sharedSuffix += 1;
  let replacementCount = 0;
  const sameMarks = (left: readonly TextMark[], right: readonly TextMark[]) =>
    JSON.stringify(left) === JSON.stringify(right);
  const mapTextRun = (nodes: Extract<InlineNode, { type: "text" }>[]): InlineNode[] => {
    const text = nodes.map((node) => node.text).join("");
    if (!text.includes(search)) return nodes;
    const protectedRanges = textRanges(text, options.protectedSearches ?? []);
    if (options.skipFollowingBareNumber) {
      const numbered = new RegExp(`${escapeRegExp(search)}[\\t \\u3000]*[0-9０-９]+`, "gu");
      for (const match of text.matchAll(numbered))
        protectedRanges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (options.skipFollowingNumber) {
      // 重复字词可能使未编号匹配与同名已编号匹配部分重叠，不能插入到后者内部。
      const numbered = new RegExp(
        `${escapeRegExp(search)}[\\t \\u3000]*[（(][\\t \\u3000]*[0-9０-９]+[\\t \\u3000]*[)）]`,
        "gu",
      );
      for (const match of text.matchAll(numbered)) {
        protectedRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
    const spans: Array<{ start: number; end: number; marks: TextMark[] }> = [];
    let offset = 0;
    for (const node of nodes) {
      spans.push({ start: offset, end: offset + node.text.length, marks: node.marks });
      offset += node.text.length;
    }
    const result: Extract<InlineNode, { type: "text" }>[] = [];
    const append = (value: string, marks: TextMark[]) => {
      if (!value) return;
      const previous = result.at(-1);
      if (previous && sameMarks(previous.marks, marks)) previous.text += value;
      else result.push({ type: "text", text: value, marks: structuredClone(marks) });
    };
    const appendOriginal = (start: number, end: number) => {
      for (const span of spans) {
        const from = Math.max(start, span.start);
        const to = Math.min(end, span.end);
        if (from < to) append(text.slice(from, to), span.marks);
      }
    };
    let cursor = 0;
    while (cursor < text.length) {
      const match = text.indexOf(search, cursor);
      if (match < 0) {
        appendOriginal(cursor, text.length);
        break;
      }
      // 实施例序号替换要求旧序号不能是更长数字的一部分：紧随其后的字符不得是数字。
      // 跳过时原样保留匹配串本身（含其原有格式），再继续向后搜索。
      const following = text[match + search.length] ?? "";
      if (
        protectedRanges.some((range) =>
          cutsProtectedKeyword(match, match + search.length, range.start, range.end),
        )
      ) {
        appendOriginal(cursor, match + search.length);
        cursor = match + search.length;
        continue;
      }
      if (trailingNumberBoundary && /[0-9]/u.test(following)) {
        appendOriginal(cursor, match + search.length);
        cursor = match + search.length;
        continue;
      }
      if (options.acceptMatch && !options.acceptMatch(text, match)) {
        appendOriginal(cursor, match + search.length);
        cursor = match + search.length;
        continue;
      }
      // 关键词已带同一编号时不重复添加括号，兼容英文括号和旧中文括号。
      const skippedSuffixes =
        typeof skipFollowing === "string" ? [skipFollowing] : (skipFollowing ?? []);
      if (skippedSuffixes.some((suffix) => text.startsWith(suffix, match + search.length))) {
        appendOriginal(cursor, match + search.length);
        cursor = match + search.length;
        continue;
      }
      if (
        options.skipFollowingNumber &&
        /^[\t \u3000]*[（(][\t \u3000]*[0-9０-９]+[\t \u3000]*[)）]/u.test(
          text.slice(match + search.length),
        )
      ) {
        appendOriginal(cursor, match + search.length);
        cursor = match + search.length;
        continue;
      }
      appendOriginal(cursor, match);
      for (let index = 0; index < replacement.length; index += 1) {
        // Keep unchanged prefix/suffix styles; changed text inherits the corresponding source run.
        const sourceIndex =
          index < sharedPrefix
            ? index
            : index >= replacement.length - sharedSuffix
              ? search.length - (replacement.length - index)
              : Math.min(
                  index,
                  Math.max(sharedPrefix, search.length - sharedSuffix - 1),
                  search.length - 1,
                );
        const sourceOffset = match + sourceIndex;
        const sourceMarks =
          spans.find((span) => sourceOffset >= span.start && sourceOffset < span.end)?.marks ?? [];
        append(replacement[index] ?? "", [
          ...sourceMarks.filter(
            (mark) =>
              !removedMarkTypes.has(mark.type) &&
              !(mark.type === "background-color" && removedBackgroundColors.has(mark.value)) &&
              !(
                mark.type === "reference-mark-token" &&
                removedReferenceTokenNumbers.has(mark.number)
              ),
          ),
          replacementMark,
          ...(options.additionalMarks ?? []),
        ]);
      }
      replacementCount += 1;
      cursor = match + search.length;
    }
    return result;
  };
  const mapContent = (content: readonly InlineNode[]): InlineNode[] => {
    const result: InlineNode[] = [];
    let run: Extract<InlineNode, { type: "text" }>[] = [];
    const flush = () => {
      if (run.length > 0) result.push(...mapTextRun(run));
      run = [];
    };
    for (const node of content) {
      if (node.type === "text") run.push(node);
      else {
        flush();
        result.push(node);
      }
    }
    flush();
    return result;
  };
  const mapParagraph = (paragraph: ParagraphNode): ParagraphNode => ({
    ...paragraph,
    content: mapContent(paragraph.content),
  });
  const mapBlock = (block: BlockNode): BlockNode => {
    if (block.type === "paragraph") return mapParagraph(block);
    if (block.type === "heading") return { ...block, content: mapContent(block.content) };
    if (block.type === "bullet-list" || block.type === "ordered-list")
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, content: item.content.map(mapParagraph) })),
      };
    if (block.type === "table")
      return {
        ...block,
        rows: block.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, content: cell.content.map(mapParagraph) })),
        })),
      };
    return block;
  };
  return {
    document: {
      ...document,
      content: document.content.map((block, index) =>
        !options.excludedBlockIds?.includes(block.id) &&
        (!blockRange || (index >= blockRange.start && index < blockRange.end))
          ? mapBlock(block)
          : block,
      ),
    },
    replacementCount,
  };
}

function rawInterruptedKeywordMatches(
  text: string,
  keyword: string,
  referenceMarks: readonly ReferenceMarkKeyword[],
  options: { includeUnparenthesizedNumbers?: boolean } = {},
): Array<{ text: string; index: number }> {
  const boundarySuffixes = new Map<number, Set<string>>();
  for (const mark of referenceMarks) {
    if (!mark.keyword || mark.keyword.length >= keyword.length) continue;
    let start = keyword.indexOf(mark.keyword);
    while (start >= 0) {
      const boundary = start + mark.keyword.length;
      const suffixes = boundarySuffixes.get(boundary) ?? new Set<string>();
      suffixes.add(`\\(${mark.number}\\)`);
      suffixes.add(`（${mark.number}）`);
      if (options.includeUnparenthesizedNumbers) suffixes.add(String(mark.number));
      boundarySuffixes.set(boundary, suffixes);
      start = keyword.indexOf(mark.keyword, start + 1);
    }
  }
  if (boundarySuffixes.size === 0) return [];

  let source = "";
  for (let index = 0; index < keyword.length; index += 1) {
    source += escapeRegExp(keyword[index] ?? "");
    const suffixes = boundarySuffixes.get(index + 1);
    if (suffixes && suffixes.size > 0) {
      source += `(?:${[...suffixes].join("|")})?`;
    }
  }
  const pattern = new RegExp(source, "gu");
  return [...text.matchAll(pattern)]
    .filter((match) => match[0] !== keyword && match.index !== undefined)
    .map((match) => ({ text: match[0], index: match.index as number }));
}

function textRanges(
  text: string,
  searches: readonly string[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const search of searches) {
    if (!search) continue;
    let start = text.indexOf(search);
    while (start >= 0) {
      ranges.push({ start, end: start + search.length });
      start = text.indexOf(search, start + 1);
    }
  }
  return ranges;
}

/** 完整包含较短词允许显式扩展；从任一侧切入、或落在其他关键词内部均受保护。 */
export function cutsProtectedKeyword(
  start: number,
  end: number,
  protectedStart: number,
  protectedEnd: number,
): boolean {
  return (
    start < protectedEnd && end > protectedStart && (start > protectedStart || end < protectedEnd)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function combineMutations(first: DocumentMutation, second: DocumentMutation): DocumentMutation {
  return {
    document: second.document,
    replacementCount: first.replacementCount + second.replacementCount,
  };
}
