import type { Editor } from "@tiptap/core";
import { Fragment, type Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export type TextMatch = { from: number; to: number };
export type FindSearchMode = "literal" | "wildcard" | "regex";
export type FindSearchResult = { matches: TextMatch[]; error: string | null };
export type ReplaceCurrentResult = { caretPosition: number; replaced: boolean };

export type FindOptions = {
  interpretSpecialCodes?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  searchMode?: FindSearchMode;
  /** @deprecated Kept for callers persisted before searchMode was introduced. */
  useRegex?: boolean;
};

type SearchUnit = { start: number; end: number; from: number; to: number; linear: boolean };
export type SearchChunk = { text: string; units: SearchUnit[] };
export type DetailedMatch = TextMatch & {
  context?: { chunk: number; start: number; end: number };
  matchedText: string;
  captures: Array<string | undefined>;
  namedCaptures: Record<string, string | undefined> | undefined;
  prefixText: string;
  suffixText: string;
};
type CompiledQuery = { regex: RegExp | null; error: string | null };
export type DetailedSearchResult = { matches: DetailedMatch[]; error: string | null };

const HARD_BREAK_SENTINEL = "\u{f0000}";
const PAGE_BREAK_SENTINEL = "\u{f0001}";
const STRUCTURAL_SENTINELS = `${HARD_BREAK_SENTINEL}${PAGE_BREAK_SENTINEL}`;
const ANY_TEXT_CHARACTER = `[^${STRUCTURAL_SENTINELS}]`;
export const CHINESE_PUNCTUATION_PATTERN =
  "[\\u3001\\u3002\\u3008-\\u3011\\u3014-\\u301f\\u3030\\u303d\\u30fb\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function effectiveSearchMode(options: FindOptions): FindSearchMode {
  return options.searchMode ?? (options.useRegex ? "regex" : "literal");
}

function isCJKChar(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

// Bound the cache to one document without keeping a closed editor/history alive.
let chunkCache: { doc: WeakRef<ProseMirrorNode>; modes: Map<boolean, SearchChunk[]> } | undefined;

function searchChunks(doc: ProseMirrorNode, includeStructuralNodes: boolean): SearchChunk[] {
  if (chunkCache?.doc.deref() !== doc) chunkCache = { doc: new WeakRef(doc), modes: new Map() };
  const cached = chunkCache.modes.get(includeStructuralNodes);
  if (cached) return cached;
  const chunks: SearchChunk[] = [];
  let current: SearchChunk = { text: "", units: [] };
  const flush = () => {
    if (current.text) chunks.push(current);
    current = { text: "", units: [] };
  };
  const append = (text: string, from: number, to: number, linear = false) => {
    const start = current.text.length;
    current.text += text;
    current.units.push({ start, end: current.text.length, from, to, linear });
  };

  doc.descendants((node, position) => {
    if (node.isTextblock) flush();
    if (
      ["inlineMath", "blockMath", "figure", "inlineFigure", "chemicalStructure"].includes(
        node.type.name,
      )
    ) {
      flush();
      return false;
    }
    if (node.type.name === "hardBreak") {
      if (includeStructuralNodes) append(HARD_BREAK_SENTINEL, position, position + node.nodeSize);
      else flush();
      return false;
    }
    if (node.type.name === "pageBreak") {
      flush();
      if (includeStructuralNodes) {
        append(PAGE_BREAK_SENTINEL, position, position + node.nodeSize);
        flush();
      }
      return false;
    }
    if (node.isText && node.text) {
      append(node.text, position, position + node.text.length, true);
    }
    return true;
  });
  flush();
  chunkCache.modes.set(includeStructuralNodes, chunks);
  return chunks;
}

export function prepareFindSearch(doc: ProseMirrorNode, options: FindOptions): SearchChunk[] {
  return searchChunks(doc, effectiveSearchMode(options) !== "regex");
}

function unitAt(units: SearchUnit[], position: number): SearchUnit | undefined {
  let low = 0;
  let high = units.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (units[mid]!.end <= position) low = mid + 1;
    else high = mid;
  }
  const unit = units[low];
  return unit && position >= unit.start ? unit : undefined;
}

const SPECIAL_FIND_CODES: ReadonlyArray<readonly [string, string]> = [
  ["^中标", CHINESE_PUNCTUATION_PATTERN],
  ["^^", "\\^"],
  ["^#", "\\p{Nd}"],
  ["^$", "\\p{L}"],
  ["^?", ANY_TEXT_CHARACTER],
  ["^汉", "\\p{Script=Han}"],
  ["^w", "[ \\t\\u00a0]+"],
  ["^t", "\\t"],
  ["^s", "\\u00a0"],
  ["^l", HARD_BREAK_SENTINEL],
  ["^m", PAGE_BREAK_SENTINEL],
];

function specialCodeAt(query: string, index: number): readonly [string, string] | null {
  return SPECIAL_FIND_CODES.find(([code]) => query.startsWith(code, index)) ?? null;
}

function literalPattern(query: string, interpretSpecialCodes = true): string {
  let pattern = "";
  for (let index = 0; index < query.length; ) {
    const special = interpretSpecialCodes ? specialCodeAt(query, index) : null;
    if (special) {
      pattern += special[1];
      index += special[0].length;
      continue;
    }
    const character = String.fromCodePoint(query.codePointAt(index) ?? 0);
    pattern += escapeRegExp(character);
    index += character.length;
  }
  return pattern;
}

function wildcardPattern(query: string): string {
  let pattern = "";
  for (let index = 0; index < query.length; ) {
    const special = specialCodeAt(query, index);
    if (special) {
      pattern += special[1];
      index += special[0].length;
      continue;
    }
    const character = query[index] ?? "";
    if (character === "\\") {
      const escaped = query[index + 1];
      if (!escaped) throw new Error("反斜杠后缺少要转义的字符");
      pattern += escapeRegExp(escaped);
      index += 2;
      continue;
    }
    if (character === "[") {
      const end = query.indexOf("]", index + 1);
      if (end < 0) throw new Error("字符范围缺少右方括号 ]");
      let content = query.slice(index + 1, end);
      if (!content) throw new Error("字符范围不能为空");
      if (content.startsWith("!")) content = `^${STRUCTURAL_SENTINELS}${content.slice(1)}`;
      pattern += `[${content}]`;
      index = end + 1;
      continue;
    }
    if (character === "{") {
      const end = query.indexOf("}", index + 1);
      if (end < 0) throw new Error("重复次数缺少右花括号 }");
      const content = query.slice(index + 1, end).replaceAll(" ", "");
      if (!/^\d+(?:,\d*)?$/.test(content)) throw new Error("重复次数格式应为 {n}、{n,} 或 {n,m}");
      pattern += `{${content}}`;
      index = end + 1;
      continue;
    }
    if (character === "?") pattern += ANY_TEXT_CHARACTER;
    else if (character === "*") pattern += `${ANY_TEXT_CHARACTER}*`;
    else if (character === "@") pattern += "+";
    else if (character === "<") pattern += "(?<![\\p{L}\\p{N}_])";
    else if (character === ">") pattern += "(?![\\p{L}\\p{N}_])";
    else if (character === "(" || character === ")") pattern += character;
    else pattern += escapeRegExp(character);
    index += 1;
  }
  return pattern;
}

function compileQuery(
  query: string,
  options: FindOptions,
  guardSynchronousExecution = true,
): CompiledQuery {
  const mode = effectiveSearchMode(options);
  try {
    const pattern =
      mode === "regex"
        ? query
        : mode === "wildcard"
          ? wildcardPattern(query)
          : literalPattern(query, options.interpretSpecialCodes);
    if (
      guardSynchronousExecution &&
      mode !== "literal" &&
      hasNestedRepetition(pattern, options.caseSensitive ?? false)
    ) {
      throw new Error("表达式包含嵌套重复，可能导致界面无响应，请改写后重试");
    }
    return {
      regex: new RegExp(pattern, (options.caseSensitive ?? false) ? "gu" : "giu"),
      error: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "语法无效";
    return {
      regex: null,
      error: `${mode === "wildcard" ? "通配符" : "正则表达式"}语法有误：${detail}`,
    };
  }
}

function hasNestedRepetition(pattern: string, caseSensitive: boolean): boolean {
  type GroupState = {
    containsRepeat: boolean;
    containsAlternation: boolean;
    contentStart: number;
    contentEnd: number;
  };
  const groups: GroupState[] = [];
  let escaped = false;
  let inCharacterClass = false;
  let previousGroup: GroupState | null = null;

  const isQuantifierStart = (character: string) =>
    character === "*" || character === "+" || character === "?" || character === "{";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (escaped) {
      escaped = false;
      previousGroup = null;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      previousGroup = null;
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      previousGroup = null;
      continue;
    }
    if (character === "(") {
      groups.push({
        containsRepeat: false,
        containsAlternation: false,
        contentStart: index + 1,
        contentEnd: index + 1,
      });
      previousGroup = null;
      continue;
    }
    if (character === "|") {
      const current = groups.at(-1);
      if (current) current.containsAlternation = true;
      previousGroup = null;
      continue;
    }
    if (character === ")") {
      previousGroup = groups.pop() ?? null;
      if (previousGroup) previousGroup.contentEnd = index;
      continue;
    }
    if (character === "?" && pattern[index - 1] === "(") {
      previousGroup = null;
      continue;
    }
    if (isQuantifierStart(character)) {
      if (previousGroup?.containsRepeat) return true;
      if (
        previousGroup?.containsAlternation &&
        !hasClearlyDisjointLiteralAlternatives(
          pattern.slice(previousGroup.contentStart, previousGroup.contentEnd),
          caseSensitive,
        )
      )
        return true;
      for (const group of groups) group.containsRepeat = true;
      previousGroup = null;
      continue;
    }
    previousGroup = null;
  }
  return false;
}

function hasClearlyDisjointLiteralAlternatives(
  groupPattern: string,
  caseSensitive: boolean,
): boolean {
  const body = groupPattern.startsWith("?:") ? groupPattern.slice(2) : groupPattern;
  const alternatives = body.split("|");
  if (alternatives.length < 2) return false;
  if (alternatives.some((alternative) => !alternative || /[\\[\]().*+?{}^$]/u.test(alternative)))
    return false;
  const starts = alternatives.map((alternative) => {
    const start = Array.from(alternative)[0] ?? "";
    return caseSensitive ? start : start.toLocaleLowerCase();
  });
  return new Set(starts).size === alternatives.length;
}

export function findQueryError(
  query: string,
  options: FindOptions = {},
  doc?: ProseMirrorNode,
): string | null {
  if (!query) return null;
  const compiled = compileQuery(query, options);
  if (compiled.error) return compiled.error;
  if (!doc) return null;
  return detailedSearch(doc, query, options, compiled).error;
}

export function findMatchesWithError(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions = {},
): FindSearchResult {
  const result = detailedSearch(doc, query, options, undefined, false);
  return {
    matches: result.matches.map(({ from, to }) => ({ from, to })),
    error: result.error,
  };
}

function detailedSearch(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions = {},
  compiled = compileQuery(query, options),
  includeReplacementContext = true,
): DetailedSearchResult {
  return searchPreparedChunks(
    prepareFindSearch(doc, options),
    query,
    options,
    compiled,
    includeReplacementContext,
  );
}

export function searchPreparedChunks(
  chunks: SearchChunk[],
  query: string,
  options: FindOptions = {},
  compiled = compileQuery(query, options, false),
  includeReplacementContext = true,
  includeSurroundingText = true,
): DetailedSearchResult {
  if (!query) return { matches: [], error: null };
  const regex = compiled.regex;
  if (!regex) return { matches: [], error: compiled.error };
  const matches: DetailedMatch[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    for (const result of chunk.text.matchAll(regex)) {
      const start = result.index ?? -1;
      const length = result[0]?.length ?? 0;
      if (start < 0) continue;
      if (length === 0) {
        return { matches: [], error: "当前表达式会产生零宽匹配，暂不支持查找或替换" };
      }
      if (options.wholeWord && !isWholeWord(chunk.text, start, length)) continue;
      const first = unitAt(chunk.units, start);
      const last = unitAt(chunk.units, start + length - 1);
      const from = first && (first.linear ? first.from + start - first.start : first.from);
      const to = last && (last.linear ? last.from + start + length - last.start : last.to);
      if (from !== undefined && to !== undefined)
        matches.push({
          from,
          to,
          matchedText: result[0],
          captures: includeReplacementContext ? result.slice(1) : [],
          namedCaptures: includeReplacementContext ? result.groups : undefined,
          prefixText:
            includeReplacementContext && includeSurroundingText ? chunk.text.slice(0, start) : "",
          suffixText:
            includeReplacementContext && includeSurroundingText
              ? chunk.text.slice(start + length)
              : "",
          ...(!includeSurroundingText
            ? { context: { chunk: chunkIndex, start, end: start + length } }
            : {}),
        });
    }
  }
  return { matches, error: null };
}

export function withReplacementContext(
  matches: DetailedMatch[],
  chunks: SearchChunk[],
  replacement: string,
): DetailedMatch[] {
  if (!/\$[`']/u.test(replacement)) return matches;
  return matches.map((match) => {
    const context = match.context;
    const text = context && chunks[context.chunk]?.text;
    return context && text !== undefined
      ? { ...match, prefixText: text.slice(0, context.start), suffixText: text.slice(context.end) }
      : match;
  });
}

function detailedMatches(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions = {},
): DetailedMatch[] {
  return detailedSearch(doc, query, options).matches;
}

export function findLiteralMatches(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions = {},
): TextMatch[] {
  return findMatchesWithError(doc, query, options).matches;
}

function isWholeWord(source: string, start: number, length: number): boolean {
  const isWord = (value: string | undefined) =>
    value !== undefined && !isCJKChar(value) && /[\p{L}\p{N}_]/u.test(value);
  return !isWord(source[start - 1]) && !isWord(source[start + length]);
}

export function selectWrappedMatch(
  matches: TextMatch[],
  position: number,
  direction: "next" | "previous",
): TextMatch | null {
  if (matches.length === 0) return null;
  if (direction === "next")
    return matches.find((match) => match.from >= position) ?? matches[0] ?? null;
  return [...matches].reverse().find((match) => match.to <= position) ?? matches.at(-1) ?? null;
}

function replacementValue(
  replacement: string,
  mode: FindSearchMode,
  matchedText: string,
  captures: Array<string | undefined>,
  namedCaptures: Record<string, string | undefined> | undefined = undefined,
  prefixText = "",
  suffixText = "",
): string {
  let value = "";
  for (let index = 0; index < replacement.length; ) {
    if (replacement.startsWith("^&", index)) {
      value += matchedText;
      index += 2;
      continue;
    }
    if (replacement.startsWith("^^", index)) {
      value += "^";
      index += 2;
      continue;
    }
    if (replacement.startsWith("^t", index)) {
      value += "\t";
      index += 2;
      continue;
    }
    if (replacement.startsWith("^s", index)) {
      value += "\u00a0";
      index += 2;
      continue;
    }
    if (replacement.startsWith("^l", index)) {
      value += HARD_BREAK_SENTINEL;
      index += 2;
      continue;
    }
    if (replacement.startsWith("^m", index)) {
      value += PAGE_BREAK_SENTINEL;
      index += 2;
      continue;
    }
    if (mode === "wildcard" && replacement[index] === "\\") {
      const group = replacement[index + 1];
      if (group && /[1-9]/.test(group)) {
        const captureIndex = Number(group) - 1;
        value += captureIndex < captures.length ? (captures[captureIndex] ?? "") : `\\${group}`;
        index += 2;
        continue;
      }
    }
    if (mode === "regex" && replacement[index] === "$") {
      const next = replacement[index + 1];
      if (next === "$") {
        value += "$";
        index += 2;
        continue;
      }
      if (next === "&") {
        value += matchedText;
        index += 2;
        continue;
      }
      if (next === "`") {
        value += prefixText;
        index += 2;
        continue;
      }
      if (next === "'") {
        value += suffixText;
        index += 2;
        continue;
      }
      if (next === "<" && namedCaptures) {
        const end = replacement.indexOf(">", index + 2);
        if (end >= 0) {
          const name = replacement.slice(index + 2, end);
          value += Object.hasOwn(namedCaptures, name) ? (namedCaptures[name] ?? "") : "";
          index = end + 1;
          continue;
        }
      }
      if (next && /\d/.test(next)) {
        const secondDigit = replacement[index + 2];
        const digits = secondDigit && /\d/.test(secondDigit) ? `${next}${secondDigit}` : next;
        const captureNumber = Number(digits);
        if (captureNumber > 0 && captureNumber <= captures.length) {
          value += captures[captureNumber - 1] ?? "";
          index += 1 + digits.length;
          continue;
        }
        const firstCaptureNumber = Number(next);
        if (
          digits.length === 2 &&
          firstCaptureNumber > 0 &&
          firstCaptureNumber <= captures.length
        ) {
          value += `${captures[firstCaptureNumber - 1] ?? ""}${secondDigit}`;
          index += 3;
          continue;
        }
      }
    }
    const character = String.fromCodePoint(replacement.codePointAt(index) ?? 0);
    value += character;
    index += character.length;
  }
  return value;
}

export function expandReplacement(
  query: string,
  options: FindOptions,
  matchedText: string,
  replacement: string,
): string {
  const mode = effectiveSearchMode(options);
  const regex = mode === "literal" ? null : compileQuery(query, options).regex;
  const result = regex?.exec(matchedText);
  return replacementValue(
    replacement,
    mode,
    matchedText,
    result?.slice(1) ?? [],
    result?.groups,
    result ? matchedText.slice(0, result.index) : "",
    result ? matchedText.slice(result.index + result[0].length) : "",
  );
}

function replacementFragment(editor: Editor, value: string, marks: readonly Mark[] = []): Fragment {
  const nodes: ProseMirrorNode[] = [];
  let text = "";
  const flushText = () => {
    if (text) nodes.push(editor.schema.text(text, marks));
    text = "";
  };
  for (let index = 0; index < value.length; ) {
    if (value.startsWith(HARD_BREAK_SENTINEL, index)) {
      flushText();
      const hardBreak = editor.schema.nodes.hardBreak;
      if (!hardBreak) throw new Error("当前文档不支持手动换行");
      nodes.push(hardBreak.create());
      index += HARD_BREAK_SENTINEL.length;
    } else if (value.startsWith(PAGE_BREAK_SENTINEL, index)) {
      flushText();
      const pageBreak = editor.schema.nodes.pageBreak;
      if (!pageBreak) throw new Error("当前文档不支持分页符");
      nodes.push(pageBreak.create());
      index += PAGE_BREAK_SENTINEL.length;
    } else {
      const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
      text += character;
      index += character.length;
    }
  }
  flushText();
  return Fragment.fromArray(nodes);
}

function unchangedTextBoundaries(
  original: string,
  replacement: string,
): { prefixCodeUnits: number; suffixCodeUnits: number } {
  const originalCharacters = Array.from(original);
  const replacementCharacters = Array.from(replacement);
  let prefixCharacters = 0;
  while (
    prefixCharacters < originalCharacters.length &&
    prefixCharacters < replacementCharacters.length &&
    originalCharacters[prefixCharacters] === replacementCharacters[prefixCharacters]
  ) {
    prefixCharacters += 1;
  }
  let suffixCharacters = 0;
  while (
    suffixCharacters < originalCharacters.length - prefixCharacters &&
    suffixCharacters < replacementCharacters.length - prefixCharacters &&
    originalCharacters[originalCharacters.length - suffixCharacters - 1] ===
      replacementCharacters[replacementCharacters.length - suffixCharacters - 1]
  ) {
    suffixCharacters += 1;
  }
  return {
    prefixCodeUnits: originalCharacters.slice(0, prefixCharacters).join("").length,
    suffixCodeUnits:
      suffixCharacters === 0
        ? 0
        : originalCharacters.slice(originalCharacters.length - suffixCharacters).join("").length,
  };
}

function replaceDetailedMatch(
  editor: Editor,
  transaction: Transaction,
  match: DetailedMatch,
  replacement: string,
  options: FindOptions,
): Transaction {
  const expanded = replacementValue(
    replacement,
    effectiveSearchMode(options),
    match.matchedText,
    match.captures,
    match.namedCaptures,
    match.prefixText,
    match.suffixText,
  );
  if (expanded === match.matchedText) return transaction;
  let replaceFrom = match.from;
  let replaceTo = match.to;
  let changedReplacement = expanded;
  if (
    !match.matchedText.includes(HARD_BREAK_SENTINEL) &&
    !match.matchedText.includes(PAGE_BREAK_SENTINEL) &&
    !expanded.includes(HARD_BREAK_SENTINEL) &&
    !expanded.includes(PAGE_BREAK_SENTINEL)
  ) {
    const { prefixCodeUnits, suffixCodeUnits } = unchangedTextBoundaries(
      match.matchedText,
      expanded,
    );
    replaceFrom += prefixCodeUnits;
    replaceTo -= suffixCodeUnits;
    changedReplacement = expanded.slice(
      prefixCodeUnits,
      suffixCodeUnits === 0 ? expanded.length : expanded.length - suffixCodeUnits,
    );
  }
  const marks =
    transaction.doc.nodeAt(replaceFrom)?.marks ?? transaction.doc.resolve(replaceFrom).marks();
  const content = replacementFragment(editor, changedReplacement, marks);
  if (content.eq(transaction.doc.slice(replaceFrom, replaceTo).content)) return transaction;
  const pageBreak = editor.schema.nodes.pageBreak;
  const containsPageBreak = content.content.some((node) => node.type === pageBreak);
  if (containsPageBreak) {
    const replacementNode = content.firstChild;
    if (!replacementNode || content.childCount !== 1 || replacementNode.type !== pageBreak) {
      throw new Error("分页符不能与普通文字同时作为一次替换内容");
    }
    return transaction.replaceRangeWith(replaceFrom, replaceTo, replacementNode);
  }
  const matchedNode = editor.state.doc.nodeAt(match.from);
  if (matchedNode?.type === pageBreak && content.size > 0) {
    const paragraph = editor.schema.nodes.paragraph;
    if (!paragraph) throw new Error("当前文档不能用普通文字替换分页符");
    return transaction.replaceWith(replaceFrom, replaceTo, paragraph.create(null, content));
  }
  return transaction.replaceWith(replaceFrom, replaceTo, content);
}

export function replaceCurrentMatch(
  editor: Editor,
  match: TextMatch,
  query: string,
  replacement: string,
  options: FindOptions = {},
  preparedMatches?: DetailedMatch[],
): ReplaceCurrentResult | null {
  const detailed = (preparedMatches ?? detailedMatches(editor.state.doc, query, options)).find(
    (candidate) => candidate.from === match.from && candidate.to === match.to,
  );
  if (!detailed) return null;
  const expanded = replacementValue(
    replacement,
    effectiveSearchMode(options),
    detailed.matchedText,
    detailed.captures,
    detailed.namedCaptures,
    detailed.prefixText,
    detailed.suffixText,
  );
  const replacementSize = replacementFragment(editor, expanded).size;
  const transaction = replaceDetailedMatch(editor, editor.state.tr, detailed, replacement, options);
  const replaced = transaction.steps.length > 0;
  if (replaced) editor.view.dispatch(transaction);
  return { caretPosition: detailed.from + replacementSize, replaced };
}

export function replaceAllLiteral(
  editor: Editor,
  query: string,
  replacement: string,
  options: FindOptions = {},
  preparedMatches?: DetailedMatch[],
): number {
  const matches = preparedMatches ?? detailedMatches(editor.state.doc, query, options);
  if (matches.length === 0) return 0;
  let transaction = editor.state.tr;
  let replaced = 0;
  for (const match of [...matches].reverse()) {
    const stepCount = transaction.steps.length;
    transaction = replaceDetailedMatch(editor, transaction, match, replacement, options);
    if (transaction.steps.length > stepCount) replaced += 1;
  }
  if (transaction.steps.length > 0) editor.view.dispatch(transaction);
  return replaced;
}
