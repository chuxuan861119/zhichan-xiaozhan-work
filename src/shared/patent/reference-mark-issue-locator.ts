import type { InlineNode, PatentBookDocument } from "../document/model.js";
import type { CanonicalPatent, PatentBookKind } from "./model.js";
import {
  descriptionReferenceNumberRanges,
  descriptionReferenceNumberSuffix,
} from "./reference-mark-description-number.js";
import { legendParagraphsInSegment } from "./reference-mark-legend.js";
import {
  cutsProtectedKeyword,
  protectedClaimsKeywordSearches,
  protectedReferenceMarkKeywordSearches,
} from "./reference-mark-text.js";

export type ReferenceMarkIssueReason =
  | "missing-number"
  | "wrong-number"
  | "nonstandard-number"
  | "detached-number";

export type ReferenceMarkIssueLocation = Readonly<{
  locationId: string;
  referenceMarkId: string;
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">;
  nodeId: string;
  from: number;
  to: number;
  text: string;
  reason: ReferenceMarkIssueReason;
}>;

type TextRange = { start: number; end: number };
type TextContainer = Readonly<{
  nodeId: string;
  text: string;
  tokenRanges: readonly TextRange[];
}>;

const TEXT_BOOK_ORDER = ["claims", "description", "abstract"] as const;
const NUMBER_SUFFIX = /^[\t \u3000]*([（(])[\t \u3000]*([0-9０-９]+)[\t \u3000]*([)）])/u;

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode("0".charCodeAt(0) + digit.charCodeAt(0) - "０".charCodeAt(0)),
  );
}

function textRanges(text: string, searches: readonly string[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const search of searches) {
    if (!search) continue;
    let start = text.indexOf(search);
    while (start >= 0) {
      ranges.push({ start, end: start + search.length });
      start = text.indexOf(search, start + Math.max(search.length, 1));
    }
  }
  return ranges;
}

function inlineContainer(
  nodeId: string,
  content: readonly InlineNode[],
  number: number,
): TextContainer {
  let text = "";
  const tokenRanges: TextRange[] = [];
  let openTokenStart: number | null = null;
  const closeToken = () => {
    if (openTokenStart === null) return;
    tokenRanges.push({ start: openTokenStart, end: text.length });
    openTokenStart = null;
  };
  for (const node of content) {
    const carriesToken =
      node.type === "text" &&
      node.marks.some((mark) => mark.type === "reference-mark-token" && mark.number === number);
    if (carriesToken && openTokenStart === null) openTokenStart = text.length;
    if (!carriesToken) closeToken();
    text += node.type === "text" ? node.text : " ";
  }
  closeToken();
  return { nodeId, text, tokenRanges };
}

function documentTextContainers(document: PatentBookDocument, number: number): TextContainer[] {
  return document.content.flatMap((block) => {
    if (block.type === "paragraph" || block.type === "heading") {
      return [inlineContainer(block.id, block.content, number)];
    }
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      return block.items.flatMap((item) =>
        item.content.map((paragraph) => inlineContainer(paragraph.id, paragraph.content, number)),
      );
    }
    if (block.type === "table") {
      return block.rows.flatMap((row) =>
        row.cells.flatMap((cell) =>
          cell.content.map((paragraph) => inlineContainer(paragraph.id, paragraph.content, number)),
        ),
      );
    }
    return [];
  });
}

function overlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Extend only when the registered keyword can be recovered by ignoring inserted spaces. */
function descriptionKeywordStart(text: string, numberStart: number, keyword: string): number {
  let cursor = numberStart;
  for (let index = keyword.length - 1; index >= 0; index -= 1) {
    const expected = keyword[index];
    if (expected === undefined) return numberStart;
    if (!/[^\S\r\n]/u.test(expected)) {
      while (cursor > 0 && /[^\S\r\n]/u.test(text[cursor - 1] ?? "")) cursor -= 1;
    }
    if (cursor === 0 || text[cursor - 1] !== expected) return numberStart;
    cursor -= 1;
  }
  return cursor;
}

function hasValidTokenAssociation(
  text: string,
  tokenRange: TextRange,
  keyword: string,
  number: number,
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
): boolean {
  let start = text.indexOf(keyword);
  while (start >= 0) {
    const keywordEnd = start + keyword.length;
    const suffix = text.slice(keywordEnd);
    if (bookKind !== "claims") {
      const matched = descriptionReferenceNumberSuffix(suffix);
      if (
        matched?.number === number &&
        overlaps({ start, end: keywordEnd + matched.text.length }, tokenRange)
      )
        return true;
      start = text.indexOf(keyword, start + Math.max(keyword.length, 1));
      continue;
    }
    const parenthesized = suffix.match(NUMBER_SUFFIX);
    if (parenthesized) {
      const complete = parenthesized[0] ?? "";
      const parsed = Number(toAsciiDigits(parenthesized[2] ?? ""));
      const occurrence = { start, end: keywordEnd + complete.length };
      if (parsed === number && overlaps(occurrence, tokenRange)) return true;
    }
    if (bookKind !== "claims") {
      const unparenthesized = suffix.match(new RegExp(`^[\\t \\u3000]*${number}(?![0-9])`, "u"));
      if (unparenthesized) {
        const occurrence = { start, end: keywordEnd + (unparenthesized[0]?.length ?? 0) };
        if (overlaps(occurrence, tokenRange)) return true;
      }
    }
    start = text.indexOf(keyword, start + Math.max(keyword.length, 1));
  }
  return false;
}

function issueLocation(
  referenceMarkId: string,
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  nodeId: string,
  text: string,
  range: TextRange,
  reason: ReferenceMarkIssueReason,
): ReferenceMarkIssueLocation {
  return {
    locationId: `${bookKind}:${nodeId}:${range.start}:${range.end}:${reason}`,
    referenceMarkId,
    bookKind,
    nodeId,
    from: range.start,
    to: range.end,
    text: text.slice(range.start, range.end),
    reason,
  };
}

function locateInDocument(
  document: PatentBookDocument,
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  target: CanonicalPatent["referenceMarks"][number],
  allMarks: CanonicalPatent["referenceMarks"],
): ReferenceMarkIssueLocation[] {
  const otherMarks = allMarks.filter((mark) => mark.referenceMarkId !== target.referenceMarkId);
  const protectedSearches =
    bookKind === "claims"
      ? protectedClaimsKeywordSearches(document, target.keyword, otherMarks)
      : protectedReferenceMarkKeywordSearches(document, target.keyword, otherMarks, {
          includeUnparenthesizedNumbers: true,
        });
  const excludedNodeIds =
    bookKind === "description"
      ? new Set(legendParagraphsInSegment(document).map((paragraph) => paragraph.id))
      : new Set<string>();
  const issues: ReferenceMarkIssueLocation[] = [];

  for (const container of documentTextContainers(document, target.number)) {
    if (excludedNodeIds.has(container.nodeId)) continue;
    const firstIssueIndex = issues.length;
    const descriptionNumbers =
      bookKind !== "claims" ? descriptionReferenceNumberRanges(container.text) : [];
    const protectedRanges = textRanges(container.text, protectedSearches);
    let keywordStart = container.text.indexOf(target.keyword);
    while (keywordStart >= 0) {
      const keywordEnd = keywordStart + target.keyword.length;
      const keywordRange = { start: keywordStart, end: keywordEnd };
      if (
        !protectedRanges.some((range) =>
          cutsProtectedKeyword(keywordStart, keywordEnd, range.start, range.end),
        )
      ) {
        const suffix = container.text.slice(keywordEnd);
        const parenthesized = suffix.match(NUMBER_SUFFIX);
        const matched =
          bookKind !== "claims"
            ? descriptionReferenceNumberSuffix(suffix)
            : parenthesized
              ? { text: parenthesized[0], number: Number(toAsciiDigits(parenthesized[2] ?? "")) }
              : null;
        if (!matched) {
          if (bookKind === "claims") {
            issues.push(
              issueLocation(
                target.referenceMarkId,
                bookKind,
                container.nodeId,
                container.text,
                keywordRange,
                "missing-number",
              ),
            );
          }
        } else {
          const complete = matched.text;
          const parsed = matched.number;
          const completeRange = { start: keywordStart, end: keywordEnd + complete.length };
          if (parsed !== target.number) {
            issues.push(
              issueLocation(
                target.referenceMarkId,
                bookKind,
                container.nodeId,
                container.text,
                completeRange,
                "wrong-number",
              ),
            );
          } else if (
            bookKind === "claims" &&
            complete !== `(${target.number})` &&
            complete !== `（${target.number}）`
          ) {
            issues.push(
              issueLocation(
                target.referenceMarkId,
                bookKind,
                container.nodeId,
                container.text,
                completeRange,
                "nonstandard-number",
              ),
            );
          }
        }
      }
      keywordStart = container.text.indexOf(
        target.keyword,
        keywordStart + Math.max(target.keyword.length, 1),
      );
    }

    if (bookKind !== "claims") {
      for (const range of descriptionNumbers) {
        if (range.number !== target.number) continue;
        const prefix = container.text.slice(0, range.from).trimEnd();
        // A recognized keyword is checked by its own entry, even if it carries another entry's number.
        if (allMarks.some((mark) => prefix.endsWith(mark.keyword))) continue;
        if (
          container.tokenRanges.some((token) =>
            overlaps(token, { start: range.from, end: range.to }),
          )
        )
          continue;
        issues.push(
          issueLocation(
            target.referenceMarkId,
            bookKind,
            container.nodeId,
            container.text,
            {
              start: descriptionKeywordStart(container.text, range.from, target.keyword),
              end: range.to,
            },
            "detached-number",
          ),
        );
      }
    }

    for (const tokenRange of container.tokenRanges) {
      // Removing an optional description number (or changing it into a quantity) is valid.
      if (
        bookKind !== "claims" &&
        !descriptionNumbers.some((range) =>
          overlaps(tokenRange, { start: range.from, end: range.to }),
        )
      )
        continue;
      if (
        issues.some(
          (issue) =>
            issue.nodeId === container.nodeId &&
            overlaps(tokenRange, {
              start: issue.from,
              end: issue.to,
            }),
        )
      ) {
        continue;
      }
      if (
        hasValidTokenAssociation(
          container.text,
          tokenRange,
          target.keyword,
          target.number,
          bookKind,
        )
      ) {
        continue;
      }
      const issueRange = { ...tokenRange };
      if (bookKind !== "claims") {
        for (const range of descriptionNumbers) {
          if (!overlaps(tokenRange, { start: range.from, end: range.to })) continue;
          issueRange.start = Math.min(
            issueRange.start,
            descriptionKeywordStart(container.text, range.from, target.keyword),
          );
          issueRange.end = Math.max(issueRange.end, range.to);
        }
      }
      issues.push(
        issueLocation(
          target.referenceMarkId,
          bookKind,
          container.nodeId,
          container.text,
          issueRange,
          "detached-number",
        ),
      );
    }
    const containerIssues = issues.splice(firstIssueIndex);
    issues.push(
      ...containerIssues.sort((left, right) => left.from - right.from || left.to - right.to),
    );
  }
  return issues;
}

export function locateReferenceMarkIssues(
  patent: CanonicalPatent,
  referenceMarkId: string,
): ReferenceMarkIssueLocation[] {
  const target = patent.referenceMarks.find((mark) => mark.referenceMarkId === referenceMarkId);
  if (!target) return [];
  return TEXT_BOOK_ORDER.flatMap((bookKind) => {
    const document = patent.books.find((book) => book.kind === bookKind)?.document;
    return document ? locateInDocument(document, bookKind, target, patent.referenceMarks) : [];
  });
}
