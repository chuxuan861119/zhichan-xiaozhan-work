import type { PatentBookKind } from "../patent/model.js";
import type { PatentLocation } from "./types.js";

export type SemanticCandidateKind =
  | "ambiguous-expression"
  | "functional-expression"
  | "abbreviation"
  | "object-name";

export type SemanticCandidateFact = Readonly<{
  kind: SemanticCandidateKind;
  location: PatentLocation;
  raw: string;
  nearbyText: string;
}>;

export type SemanticBookText = Readonly<{
  bookKind: PatentBookKind;
  targetId: string | null;
  text: string;
}>;

const AMBIGUOUS_PATTERN =
  /(?<![A-Za-z0-9_])约(?=\s*(?:为\s*)?[\d一二三四五六七八九十百千万<≤])|适当|较大|优选/gu;
const FUNCTIONAL_PATTERN = /用于|用以|使得|实现/gu;
const ABBREVIATION_PATTERN = /(?:以下简称|简称为|记为|称为)\s*[“"「『]?([^”"」』，。；：\s]+)/gu;
const OBJECT_PATTERN = /(?:一种|一项|一套|多个|若干)\s*([^，,：:。；;]+)/gu;
const OBJECT_SUFFIX_PATTERN =
  /(?:装置|系统|方法|设备|组件|机构|结构|模块|部件|单元|控制器|电路|平台|产品)$/u;

export function extractSemanticCandidateFacts(
  text: string,
  location: PatentLocation,
): readonly SemanticCandidateFact[] {
  const facts: SemanticCandidateFact[] = [];
  collectNonAbbreviationCandidates(facts, text, location);
  appendAbbreviationFacts(facts, text, location, new Set());
  return facts;
}

export function extractSemanticCandidateFactsForBooks(
  books: readonly SemanticBookText[],
): readonly SemanticCandidateFact[] {
  const facts: SemanticCandidateFact[] = [];
  const definedAbbreviations = new Set<string>();

  for (const book of books) {
    const location: PatentLocation = {
      kind: "book",
      bookKind: book.bookKind,
      targetId: book.targetId,
    };
    collectNonAbbreviationCandidates(facts, book.text, location);
    appendAbbreviationFacts(facts, book.text, location, definedAbbreviations);
  }

  return facts;
}

export const extractSemanticCandidates = extractSemanticCandidateFacts;

function collectNonAbbreviationCandidates(
  facts: SemanticCandidateFact[],
  text: string,
  location: PatentLocation,
): void {
  collectMatches(
    facts,
    text,
    location,
    AMBIGUOUS_PATTERN,
    "ambiguous-expression",
    (match) => match[0],
  );
  collectMatches(
    facts,
    text,
    location,
    FUNCTIONAL_PATTERN,
    "functional-expression",
    (match) => match[0],
  );

  for (const match of text.matchAll(OBJECT_PATTERN)) {
    const raw = normalizeObjectName(match[1] ?? "");
    if (!OBJECT_SUFFIX_PATTERN.test(raw)) continue;
    if (!raw) continue;
    const start = (match.index ?? 0) + (match[0]?.indexOf(raw) ?? 0);
    facts.push(candidate("object-name", raw, text, location, start));
  }
}

function collectMatches(
  facts: SemanticCandidateFact[],
  text: string,
  location: PatentLocation,
  pattern: RegExp,
  kind: SemanticCandidateKind,
  rawOf: (match: RegExpMatchArray) => string,
) {
  for (const match of text.matchAll(pattern)) {
    const raw = rawOf(match);
    if (!raw) continue;
    facts.push(candidate(kind, raw, text, location, match.index ?? 0));
  }
}

function appendAbbreviationFacts(
  facts: SemanticCandidateFact[],
  text: string,
  location: PatentLocation,
  definedAbbreviations: Set<string>,
): void {
  const seen = new Set<string>();
  let cursor = 0;

  for (const match of text.matchAll(ABBREVIATION_PATTERN)) {
    const markerStart = match.index ?? 0;
    appendDefinedOccurrences(
      facts,
      seen,
      text,
      location,
      definedAbbreviations,
      cursor,
      markerStart,
    );

    const abbreviation = match[1]?.trim() ?? "";
    if (!abbreviation) continue;
    const rawStart = markerStart + (match[0]?.indexOf(abbreviation) ?? 0);
    addAbbreviationCandidate(facts, seen, text, location, abbreviation, rawStart);
    definedAbbreviations.add(abbreviation);
    cursor = rawStart + abbreviation.length;
  }

  appendDefinedOccurrences(facts, seen, text, location, definedAbbreviations, cursor, text.length);
}

function appendDefinedOccurrences(
  facts: SemanticCandidateFact[],
  seen: Set<string>,
  text: string,
  location: PatentLocation,
  definedAbbreviations: ReadonlySet<string>,
  start: number,
  end: number,
): void {
  for (const abbreviation of definedAbbreviations) {
    for (const offset of findAllOccurrences(text, abbreviation, start, end)) {
      addAbbreviationCandidate(facts, seen, text, location, abbreviation, offset);
    }
  }
}

function addAbbreviationCandidate(
  facts: SemanticCandidateFact[],
  seen: Set<string>,
  text: string,
  location: PatentLocation,
  abbreviation: string,
  start: number,
): void {
  const key = `${abbreviation}:${start}`;
  if (seen.has(key) || !hasAbbreviationBoundary(text, abbreviation, start)) return;
  seen.add(key);
  facts.push(candidate("abbreviation", abbreviation, text, location, start));
}

function candidate(
  kind: SemanticCandidateKind,
  raw: string,
  text: string,
  location: PatentLocation,
  start: number,
): SemanticCandidateFact {
  const end = start + raw.length;
  return {
    kind,
    raw,
    location: {
      ...location,
      startOffset: (location.startOffset ?? 0) + start,
      endOffset: (location.startOffset ?? 0) + end,
    },
    nearbyText: text.slice(Math.max(0, start - 16), Math.min(text.length, end + 16)),
  };
}

function findAllOccurrences(
  text: string,
  needle: string,
  start: number,
  end: number,
): readonly number[] {
  const offsets: number[] = [];
  let offset = text.indexOf(needle, start);
  while (offset >= 0 && offset + needle.length <= end) {
    offsets.push(offset);
    offset = text.indexOf(needle, offset + needle.length);
  }
  return offsets;
}

function hasAbbreviationBoundary(text: string, abbreviation: string, start: number): boolean {
  const end = start + abbreviation.length;
  const previous = text[start - 1] ?? "";
  const next = text[end] ?? "";
  if (isAsciiTokenCharacter(abbreviation[0] ?? "") && isAsciiTokenCharacter(previous)) {
    return false;
  }
  if (isAsciiTokenCharacter(abbreviation.at(-1) ?? "") && isAsciiTokenCharacter(next)) {
    return false;
  }
  return true;
}

function isAsciiTokenCharacter(value: string): boolean {
  return /^[A-Za-z0-9_]$/u.test(value);
}

function normalizeObjectName(value: string): string {
  let raw = value.trim();
  if (!raw) return raw;

  const relationStart = raw.search(/(?:包括|包含|具有|用于|实现)/u);
  if (relationStart > 0 && OBJECT_SUFFIX_PATTERN.test(raw.slice(0, relationStart).trim())) {
    raw = raw.slice(0, relationStart).trim();
  } else if (relationStart === 0) {
    raw = raw.replace(/^(?:包括|包含|具有|用于|实现)\s*/u, "").trim();
  }
  return raw;
}
