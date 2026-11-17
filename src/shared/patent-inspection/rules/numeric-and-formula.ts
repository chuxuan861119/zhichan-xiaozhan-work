import { visibleBlockText } from "../../patent/text.js";
import { inspectionTextBlocks, nestedBlocks } from "../blocks.js";
import type { PatentFactIndex } from "../facts.js";
import type { FormulaFact } from "../formula-facts.js";
import type { NumericFact } from "../numeric-facts.js";
import { HEURISTIC_RULE, OFFICIAL_RULE, OFFICIAL_SOURCES } from "../rule-provenance.js";
import type {
  InspectionIssueDraft,
  InspectionRuleProvenance,
  PatentInspectionContext,
  PatentInspectionRule,
  PatentIssueCode,
  PatentLocation,
} from "../types.js";

type TextBlock = Readonly<{
  bookKind: PatentInspectionContext["patent"]["books"][number]["kind"];
  targetId: string;
  scope: string;
  text: string;
  index: number;
}>;

type Measurement = Readonly<{
  parameter: string;
  value: number;
  unit: string;
  location: PatentLocation;
}>;

type NamedRange = Readonly<{
  parameter: string;
  lower: number;
  upper: number;
  dimension: string;
  raw: string;
  relation: "parent" | "child" | "neutral";
  location: PatentLocation;
}>;

type FormulaEntry = Readonly<{
  source: string;
  formulaKind: "math" | "chemistry";
  symbols: readonly string[];
  location: PatentLocation;
  bookKind: TextBlock["bookKind"];
  blockIndex: number;
}>;

const UNIT_PATTERN =
  "(?:℃|°C|kHz|kPa|MPa|mV|mA|mm|cm|μm|nm|mg|kg|ms|min|毫米|厘米|微米|纳米|毫克|千克|毫秒|分钟|小时|Pa|Hz|米|克|K|V|A|m|g|s|h|秒|°|度)";
const NUMBER_PATTERN = "-?\\d+(?:\\.\\d+)?";

function createNumericRule(
  config: Readonly<{
    id: string;
    code: PatentIssueCode;
    provenance: InspectionRuleProvenance;
    inspect: (
      context: PatentInspectionContext,
      facts: PatentFactIndex,
    ) => readonly InspectionIssueDraft[];
  }>,
): PatentInspectionRule {
  return {
    id: config.id,
    version: 1,
    category: "numeric",
    defaultSeverity: "warning",
    cost: "full",
    dependencies: [
      "claims",
      "description",
      "abstract",
      "description-drawings",
      "abstract-drawing",
      "patent-metadata",
    ],
    provenance: config.provenance,
    appliesTo: () => true,
    inspect: config.inspect,
  };
}

function locationForBlock(block: TextBlock, start = 0, length = block.text.length): PatentLocation {
  return {
    kind: "book",
    bookKind: block.bookKind,
    targetId: block.targetId,
    startOffset: start,
    endOffset: start + length,
  };
}

function issue(
  code: PatentIssueCode,
  location: PatentLocation,
  summary: string,
  confidence: "certain" | "likely",
  severity: "error" | "suggestion" = confidence === "certain" ? "error" : "suggestion",
  identityKey?: string,
  excerpt?: string | null,
): InspectionIssueDraft {
  return {
    legacyCode: code,
    ...(identityKey === undefined ? {} : { identityKey }),
    severity,
    confidence,
    summary,
    evidence: [{ location, excerpt: excerpt ?? null }],
    locations: [location],
    recommendation: confidence === "likely" ? "建议结合技术语境人工核对。" : null,
  };
}

function textBlocks(context: PatentInspectionContext): TextBlock[] {
  return context.patent.books.flatMap((book) =>
    inspectionTextBlocks(book.document.content, true).map((block, index) => ({
      bookKind: book.kind,
      targetId: block.id,
      text: block.text,
      scope: block.key,
      index,
    })),
  );
}

function fullNumericFacts(facts: PatentFactIndex): readonly NumericFact[] {
  return facts.full?.numeric ?? [];
}

function reversedRangeIssues(
  _context: PatentInspectionContext,
  facts: PatentFactIndex,
): readonly InspectionIssueDraft[] {
  return fullNumericFacts(facts).flatMap((fact) => {
    if (fact.kind !== "range" || fact.lower === null || fact.upper === null) return [];
    const lower = normalizedMeasurement(fact.lower, fact.lowerUnit ?? fact.upperUnit);
    const upper = normalizedMeasurement(fact.upper, fact.upperUnit ?? fact.lowerUnit);
    const comparable = lower.dimension === upper.dimension;
    if (comparable && !greaterThan(lower.value, upper.value)) return [];
    const summary = comparable
      ? `范围“${fact.raw}”的下限大于上限。`
      : `范围“${fact.raw}”的上下限单位量纲不同。`;
    return [
      issue(
        "numeric-range-reversed",
        fact.location,
        summary,
        comparable ? "certain" : "likely",
        comparable ? "error" : "suggestion",
        `range:${fact.location.targetId}:${fact.location.startOffset ?? 0}`,
        fact.raw,
      ),
    ];
  });
}

function percentageIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  const issues: InspectionIssueDraft[] = [];
  for (const block of textBlocks(context)) {
    const sentences = splitSentences(block.text);
    let sentenceOffset = 0;
    for (const sentence of sentences) {
      const matches = [...sentence.matchAll(new RegExp(`${NUMBER_PATTERN}\\s*[%％]`, "gu"))];
      const hasSeparatedObjects = /第[一二三四五六七八九十\d]+|另一|不同|各自|分别/u.test(sentence);
      const hasExplicitSameCollection =
        /同一(?:个|批)?(?:整体|集合|总体|混合物)|同一个(?:整体|集合|总体|批次|混合物)|同一批/u.test(
          sentence,
        );
      const hasSingleUnnumberedWhole =
        /(?:^|[，,、；;])\s*(?:该|所述|某|一种)?(?:混合物(?:的)?整体|整体|集合|总体)\s*(?:包括|包含|含有)/u.test(
          sentence,
        );
      const hasSameCollection = hasExplicitSameCollection || hasSingleUnnumberedWhole;
      const aggregateMarkerCount = (sentence.match(/整体|总量|总和|合计|总百分比/gu) ?? []).length;
      const hasIndependentCollections =
        hasSeparatedObjects || (!hasSameCollection && aggregateMarkerCount >= 2);
      const hasExplicitAggregate = hasSameCollection || /总和|合计|总百分比/u.test(sentence);
      const total = matches.reduce((sum, match) => sum + Number.parseFloat(match[0]), 0);
      const hasRange = /\d+(?:\.\d+)?\s*[%％]?\s*(?:至|到|～|~|—|-)\s*\d+(?:\.\d+)?\s*[%％]/u.test(
        sentence,
      );
      if (
        matches.length >= 2 &&
        hasExplicitAggregate &&
        !hasIndependentCollections &&
        !hasRange &&
        total > 100 + 1e-6
      ) {
        const first = matches[0];
        const start = sentenceOffset + (first?.index ?? 0);
        issues.push(
          issue(
            "numeric-percentage-total",
            locationForBlock(block, sentenceOffset, sentence.length),
            `百分比合计${Math.round(total * 1000) / 1000}%，超过100%。`,
            "likely",
            "suggestion",
            `percentage:${block.targetId}:${start}`,
            sentence,
          ),
        );
      }
      sentenceOffset += sentence.length;
    }
  }
  return issues;
}

function quantityMappingIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  return textBlocks(context).flatMap((block) => {
    const sentence = splitSentences(block.text).find(
      (text) =>
        /(?:一一对应|一一匹配|一对一(?:地)?(?:对应|连接)|逐一对应)/u.test(text) &&
        countNamedQuantity(text, "入口") > 0 &&
        countNamedQuantity(text, "通道") > 0,
    );
    if (!sentence) return [];
    const entryCount = countNamedQuantity(sentence, "入口");
    const channelCount = countNamedQuantity(sentence, "通道");
    if (entryCount <= 0 || channelCount <= 0 || channelCount === entryCount) return [];
    const location = locationForBlock(block);
    return [
      issue(
        "numeric-quantity-mapping",
        location,
        `一一对应的数量不同：${entryCount}个入口、${channelCount}个通道。`,
        "likely",
        "suggestion",
        `quantity:${block.targetId}`,
        sentence,
      ),
    ];
  });
}

function unitMismatchIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  const measurements = collectMeasurements(context);
  const byParameter = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = `${measurement.location.bookKind}:${measurement.parameter}`;
    byParameter.set(key, [...(byParameter.get(key) ?? []), measurement]);
  }
  const issues: InspectionIssueDraft[] = [];
  for (const [key, values] of byParameter) {
    const dimensions = new Set(values.map((value) => unitDimension(value.unit)));
    if (dimensions.size <= 1) continue;
    const second = values[1];
    if (!second) continue;
    issues.push(
      issue(
        "numeric-unit-mismatch",
        second.location,
        `参数“${values[0]?.parameter}”出现不同量纲单位（${values.map((value) => value.unit).join("、")}），请人工核对。`,
        "likely",
        "suggestion",
        `unit:${key}`,
      ),
    );
  }
  return issues;
}

function subrangeIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  const ranges = collectNamedRanges(context);
  const issues: InspectionIssueDraft[] = [];
  for (const [index, candidate] of ranges.entries()) {
    if (candidate.relation !== "child") continue;
    const parent = ranges
      .slice(0, index)
      .reverse()
      .find(
        (other) =>
          other.parameter === candidate.parameter &&
          other.location.bookKind === candidate.location.bookKind &&
          other.dimension === candidate.dimension &&
          (other.relation === "parent" || other.relation === "neutral"),
      );
    if (!parent) continue;
    if (greaterThan(parent.lower, candidate.lower) || greaterThan(candidate.upper, parent.upper)) {
      issues.push(
        issue(
          "numeric-subrange-out-of-bounds",
          candidate.location,
          `“${candidate.parameter}”的子范围可能超出总范围。`,
          "likely",
          "suggestion",
          `subrange:${candidate.parameter}:${candidate.location.targetId}:${candidate.location.startOffset ?? 0}`,
          `总范围：${parent.raw}；子范围：${candidate.raw}`,
        ),
      );
    }
  }
  return issues;
}

function formulaEntries(context: PatentInspectionContext, facts: PatentFactIndex): FormulaEntry[] {
  const factByTarget = new Map<string, FormulaFact>(
    (facts.full?.formulas ?? []).map((fact) => [fact.location.targetId ?? "", fact]),
  );
  return context.patent.books.flatMap((book) =>
    nestedBlocks(book.document.content).flatMap((block, blockIndex) => {
      if (block.type === "block-formula") {
        const fact = factByTarget.get(block.id);
        return [
          {
            source: block.source,
            formulaKind: block.formulaKind,
            symbols: fact?.symbols ?? symbolsFromFormula(block.source),
            location: {
              kind: "book" as const,
              bookKind: book.kind,
              targetId: block.id,
            },
            bookKind: book.kind,
            blockIndex,
          },
        ];
      }
      if (block.type !== "paragraph" && block.type !== "heading") return [];
      const inlineEntries = block.content.flatMap((inline) =>
        inline.type === "inline-formula"
          ? [
              {
                source: inline.source,
                formulaKind: inline.formulaKind,
                symbols: symbolsFromFormula(inline.source),
                location: {
                  kind: "book" as const,
                  bookKind: book.kind,
                  targetId: block.id,
                },
                bookKind: book.kind,
                blockIndex,
              },
            ]
          : [],
      );
      if (inlineEntries.length > 0) return inlineEntries;
      const text = visibleBlockText(block).trim();
      if (!/(?:\\(?:d?frac|tfrac)|[A-Za-z]\s*[+\-*\\/]\s*[A-Za-z0-9])/u.test(text)) return [];
      return [
        {
          source: text,
          formulaKind: "math" as const,
          symbols: symbolsFromFormula(text),
          location: {
            kind: "book" as const,
            bookKind: book.kind,
            targetId: block.id,
          },
          bookKind: book.kind,
          blockIndex,
        },
      ];
    }),
  );
}

function literalZeroDenominatorIssues(
  context: PatentInspectionContext,
  facts: PatentFactIndex,
): readonly InspectionIssueDraft[] {
  return formulaEntries(context, facts).flatMap((formula) => {
    if (formula.formulaKind === "chemistry") return [];
    const hasSlashZero = /\/\s*0(?![\d.])/u.test(formula.source);
    const hasFracZero = /\\(?:d?frac|tfrac)\s*\{[^{}]*\}\s*\{\s*0\s*\}/u.test(formula.source);
    return hasSlashZero || hasFracZero
      ? [
          issue(
            "formula-literal-zero-denominator",
            formula.location,
            "数学公式包含字面量零分母。",
            "certain",
            "error",
            `zero-denominator:${formula.location.targetId}`,
            formula.source,
          ),
        ]
      : [];
  });
}

function undefinedSymbolIssues(
  context: PatentInspectionContext,
  facts: PatentFactIndex,
): readonly InspectionIssueDraft[] {
  const entries = formulaEntries(context, facts);
  const issues: InspectionIssueDraft[] = [];
  const textByBook = new Map(
    context.patent.books.map((book) => [
      book.kind,
      book.document.content.map(visibleBlockText).join(" "),
    ]),
  );
  const definitions = new Map<string, boolean>();
  const defined = (bookKind: FormulaEntry["bookKind"], symbol: string) => {
    const key = `${bookKind}:${symbol}`;
    if (!definitions.has(key))
      definitions.set(key, explicitDefinition(textByBook.get(bookKind) ?? "", symbol));
    return definitions.get(key) === true;
  };
  for (const formula of entries) {
    if (formula.formulaKind === "chemistry") continue;
    for (const symbol of formula.symbols) {
      if (
        isFormulaWord(symbol) ||
        defined(formula.bookKind, symbol) ||
        (/^[A-Za-z]{2,3}$/u.test(symbol) &&
          [...symbol].every((part) => defined(formula.bookKind, part)))
      )
        continue;
      issues.push(
        issue(
          "formula-undefined-symbol",
          formula.location,
          `未找到公式符号“${symbol}”的说明。`,
          "likely",
          "suggestion",
          `undefined:${formula.location.targetId}:${symbol}`,
          formula.source,
        ),
      );
    }
  }
  return issues;
}

function duplicateDefinitionIssues(
  context: PatentInspectionContext,
): readonly InspectionIssueDraft[] {
  const definitions = new Map<
    string,
    { symbol: string; values: Set<string>; blocks: TextBlock[] }
  >();
  for (const block of textBlocks(context)) {
    if (/(?:分别|依次|取值|由.+变|当.+时)/u.test(block.text)) continue;
    for (const match of block.text.matchAll(
      /\b([A-Za-z])\s*=\s*(-?\d+(?:\.\d+)?)(?![\d.A-Za-z])/gu,
    )) {
      const symbol = match[1];
      if (!symbol) continue;
      const scope = `${block.bookKind}:${block.scope}`;
      const key = `${scope}:${symbol}`;
      const current = definitions.get(key);
      definitions.set(key, {
        symbol,
        values: new Set([...(current?.values ?? []), String(Number(match[2]))]),
        blocks: [...(current?.blocks ?? []), block],
      });
    }
  }
  return [...definitions.values()].flatMap(({ symbol, values, blocks }) => {
    if (values.size < 2) return [];
    const block = blocks[0];
    if (!block) return [];
    return [
      issue(
        "formula-duplicate-definition",
        locationForBlock(block),
        `同一段中“${symbol}”被赋予不同数值：${[...values].join("、")}。`,
        "likely",
        "suggestion",
        `definition:${block.bookKind}:${block.targetId}:${symbol}`,
        block.text,
      ),
    ];
  });
}

function collectMeasurements(context: PatentInspectionContext): Measurement[] {
  return textBlocks(context).flatMap((block) => {
    const result: Measurement[] = [];
    const pattern = new RegExp(
      `([A-Za-z\\p{Script=Han}][A-Za-z_\\p{Script=Han}]{0,15})\\s*(?:范围|区间)?\\s*(?:(?:为|是|可为)\\s*)?(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})`,
      "gu",
    );
    for (const match of block.text.matchAll(pattern)) {
      const parameter = normalizeParameter(match[1] ?? "");
      const value = Number(match[2]);
      const unit = match[3] ?? "";
      if (!parameter || /^(?:至|到|上限|下限|最大值|最小值|范围|区间)$/u.test(parameter) || !unit)
        continue;
      result.push({
        parameter,
        value,
        unit,
        location: locationForBlock(block, match.index ?? 0, match[0]?.length ?? 0),
      });
    }
    return result;
  });
}

function collectNamedRanges(context: PatentInspectionContext): NamedRange[] {
  const lastParameterByBook = new Map<TextBlock["bookKind"], string>();
  return textBlocks(context).flatMap((block) => {
    const result: NamedRange[] = [];
    const pattern = new RegExp(
      `([A-Za-z\\p{Script=Han}][A-Za-z_\\p{Script=Han}]{0,15})\\s*(?:范围|区间)?\\s*(?:(?:为|是|可为)\\s*)?(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})?\\s*(?:至|到|～|~|—|－|-)\\s*(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})?`,
      "gu",
    );
    for (const match of block.text.matchAll(pattern)) {
      const rawParameter = match[1] ?? "";
      const start = match.index ?? 0;
      const contextBeforeMatch = block.text.slice(Math.max(0, start - 40), start);
      const relation = rangeRelation(contextBeforeMatch, rawParameter);
      let parameter = normalizeParameter(rawParameter);
      if (relation === "child" && isRangeRelationText(parameter)) {
        parameter = lastParameterByBook.get(block.bookKind) ?? parameter;
      }
      if (!parameter) continue;
      const lower = normalizedMeasurement(Number(match[2]), match[3] ?? match[5] ?? null);
      const upper = normalizedMeasurement(Number(match[4]), match[5] ?? match[3] ?? null);
      if (lower.dimension !== upper.dimension || greaterThan(lower.value, upper.value)) continue;
      lastParameterByBook.set(block.bookKind, parameter);
      result.push({
        parameter,
        lower: lower.value,
        upper: upper.value,
        dimension: lower.dimension,
        raw: match[0],
        relation,
        location: locationForBlock(block, start, match[0]?.length ?? 0),
      });
    }
    return result;
  });
}

function normalizeParameter(value: string): string {
  return value
    .replace(/(?:可为|为|是)$/u, "")
    .replace(/^(?:父|子)?(?:范围|区间)/u, "")
    .replace(/(?:的)?(?:范围|区间)$/u, "")
    .trim();
}

function rangeRelation(prefix: string, rawParameter: string): "parent" | "child" | "neutral" {
  const source = `${prefix}${rawParameter}`;
  if (/(?:在上述范围内|进一步限定|子范围)/u.test(source)) return "child";
  if (/父范围/u.test(source)) return "parent";
  return "neutral";
}

function isRangeRelationText(parameter: string): boolean {
  return /(?:上述|进一步|限定|优选|范围内|子范围)/u.test(parameter);
}

function unitDimension(unit: string): string {
  if (/^(?:mm|cm|μm|nm|毫米|厘米|微米|纳米|米|m)$/u.test(unit)) return "length";
  if (/^(?:mg|kg|毫克|千克|克|g)$/u.test(unit)) return "mass";
  if (/^(?:℃|°C|K|°|度)$/u.test(unit)) return "temperature";
  if (/^(?:Pa|kPa|MPa)$/u.test(unit)) return "pressure";
  if (/^(?:ms|min|分钟|毫秒|小时|s|秒|h)$/u.test(unit)) return "time";
  if (/^(?:Hz|kHz)$/u.test(unit)) return "frequency";
  if (/^(?:V|mV)$/u.test(unit)) return "voltage";
  if (/^(?:A|mA)$/u.test(unit)) return "current";
  return unit;
}

function normalizedMeasurement(
  value: number,
  unit: string | null,
): { value: number; dimension: string } {
  if (!unit) return { value, dimension: "unitless" };
  const canonical = canonicalRangeUnit(unit);
  const scale: Readonly<Record<string, number>> = {
    millimetre: 0.001,
    centimetre: 0.01,
    micrometre: 1e-6,
    nanometre: 1e-9,
    milligram: 0.001,
    kilogram: 1000,
    millisecond: 0.001,
    minute: 60,
    hour: 3600,
    kPa: 1000,
    MPa: 1e6,
    kHz: 1000,
    mV: 0.001,
    mA: 0.001,
  };
  return {
    value: value * (scale[canonical] ?? 1) - (unit === "K" ? 273.15 : 0),
    dimension: unitDimension(unit),
  };
}

function greaterThan(left: number, right: number): boolean {
  const tolerance = Math.max(Math.abs(left), Math.abs(right)) * Number.EPSILON * 16;
  return left - right > tolerance;
}

function canonicalRangeUnit(unit: string): string {
  const aliases: Record<string, string> = {
    "℃": "celsius",
    "°C": "celsius",
    度: "celsius",
    mm: "millimetre",
    毫米: "millimetre",
    cm: "centimetre",
    厘米: "centimetre",
    μm: "micrometre",
    微米: "micrometre",
    nm: "nanometre",
    纳米: "nanometre",
    m: "metre",
    米: "metre",
    mg: "milligram",
    毫克: "milligram",
    g: "gram",
    克: "gram",
    kg: "kilogram",
    千克: "kilogram",
    ms: "millisecond",
    毫秒: "millisecond",
    s: "second",
    秒: "second",
    h: "hour",
    小时: "hour",
    min: "minute",
    分钟: "minute",
  };
  return aliases[unit] ?? unit;
}

function countNamedQuantity(text: string, noun: string): number {
  const explicit = text.match(
    new RegExp(
      `(?<![第一二三四五六七八九十百千万两\\d])([一二三四五六七八九十两\\d]+)\\s*(?:个|条|路)?${noun}`,
      "u",
    ),
  );
  if (explicit?.[1]) return chineseNumber(explicit[1]);
  return 0;
}

function chineseNumber(value: string): number {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? (digits[tens] ?? 0) : 1) * 10 + (ones ? (digits[ones] ?? 0) : 0);
  }
  return digits[value] ?? 0;
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[。；;！？!?])/u).filter((sentence) => sentence.length > 0);
}

function symbolsFromFormula(source: string): readonly string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const match of source
    .replace(/\\[A-Za-z]+/gu, " ")
    .matchAll(/[A-Za-z](?:[A-Za-z0-9_]*)?/gu)) {
    const symbol = match[0] ?? "";
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return symbols;
}

function isFormulaWord(symbol: string): boolean {
  return new Set(["sin", "cos", "tan", "log", "ln", "exp", "max", "min", "sum"]).has(symbol);
}

function explicitDefinition(text: string, symbol: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${symbol}\\s*(?:=|表示|代表|指|为|是)`, "u").test(text);
}

export const numericRangeReversedRule = createNumericRule({
  id: "core.numeric.range-reversed",
  code: "numeric-range-reversed",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "数值范围应当清楚一致"),
  inspect: reversedRangeIssues,
});
export const numericPercentageRule = createNumericRule({
  id: "core.numeric.percentage-total",
  code: "numeric-percentage-total",
  provenance: HEURISTIC_RULE,
  inspect: percentageIssues,
});
export const numericQuantityMappingRule = createNumericRule({
  id: "core.numeric.quantity-mapping",
  code: "numeric-quantity-mapping",
  provenance: HEURISTIC_RULE,
  inspect: quantityMappingIssues,
});
export const numericUnitMismatchRule = createNumericRule({
  id: "core.numeric.unit-mismatch",
  code: "numeric-unit-mismatch",
  provenance: HEURISTIC_RULE,
  inspect: unitMismatchIssues,
});
export const numericSubrangeRule = createNumericRule({
  id: "core.numeric.subrange-out-of-bounds",
  code: "numeric-subrange-out-of-bounds",
  provenance: HEURISTIC_RULE,
  inspect: subrangeIssues,
});
export const formulaLiteralZeroDenominatorRule = createNumericRule({
  id: "core.formula.literal-zero-denominator",
  code: "formula-literal-zero-denominator",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "公式应当清楚、完整"),
  inspect: literalZeroDenominatorIssues,
});
export const formulaUndefinedSymbolRule = createNumericRule({
  id: "core.formula.undefined-symbol",
  code: "formula-undefined-symbol",
  provenance: HEURISTIC_RULE,
  inspect: undefinedSymbolIssues,
});
export const formulaDuplicateDefinitionRule = createNumericRule({
  id: "core.formula.duplicate-definition",
  code: "formula-duplicate-definition",
  provenance: HEURISTIC_RULE,
  inspect: duplicateDefinitionIssues,
});

export const numericAndFormulaRules = [
  numericRangeReversedRule,
  numericPercentageRule,
  numericQuantityMappingRule,
  numericUnitMismatchRule,
  numericSubrangeRule,
  formulaLiteralZeroDenominatorRule,
  formulaUndefinedSymbolRule,
  formulaDuplicateDefinitionRule,
] as const;
