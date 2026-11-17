import { scanPatentTerminology } from "../../patent/terminology.js";
import { countUnicodeCharacters, visibleBlockText } from "../../patent/text.js";
import { inspectionTextBlocks } from "../blocks.js";
import type { PatentFactIndex } from "../facts.js";
import {
  HEURISTIC_RULE,
  OFFICIAL_RULE,
  OFFICIAL_SOURCES,
  PRODUCT_POLICY,
} from "../rule-provenance.js";
import type {
  InspectionIssueDraft,
  InspectionRuleProvenance,
  PatentInspectionContext,
  PatentInspectionRule,
  PatentIssueCode,
} from "../types.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

function abstractIssues(
  ...[context, facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const abstract = context.patent.books.find((book) => book.kind === "abstract");
  if (!abstract) return [];
  // The patent name is a separately persisted field. Templates normally place
  // it in the visible abstract text already, while imported/custom documents
  // may omit it. Include it only when absent so the final export stream counts
  // the name exactly once.
  const visibleText = facts.books.get("abstract")?.visibleText ?? "";
  const name = context.patent.name?.trim() ?? "";
  const text = name && !visibleText.includes(name) ? `${name}${visibleText}` : visibleText;
  return countUnicodeCharacters(text) > 300
    ? [
        {
          severity: "warning",
          code: "abstract-too-long",
          bookKind: "abstract",
          targetId: null,
          message: "摘要超过 300 字，请人工压缩。",
        },
      ]
    : [];
}

function tableIssues(
  ...[context]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const description = context.patent.books.find((book) => book.kind === "description");
  if (!description) return [];
  return description.document.content.flatMap((block) => {
    if (block.type !== "table") return [];
    return block.rows.flatMap((row) => {
      const hasVisibleContent = row.cells.some((cell) =>
        cell.content.some((paragraph) => visibleBlockText(paragraph).trim().length > 0),
      );
      return row.rowHeightMm !== undefined && row.rowHeightRule === "exact" && hasVisibleContent
        ? [
            {
              severity: "suggestion" as const,
              confidence: "likely" as const,
              code: "table-fixed-row-height-warning" as const,
              bookKind: "description" as const,
              targetId: row.id,
              message: "表格使用固定行高。",
              recommendation: "导出预览时确认文字完整；没有遮挡即可保留。",
            },
          ]
        : [];
    });
  });
}

function terminologyIssues(
  ...[context]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  return context.patent.books
    .filter((book) => ["claims", "description", "abstract"].includes(book.kind))
    .flatMap((book) =>
      inspectionTextBlocks(book.document.content).flatMap((block) => {
        const text = block.text;
        return scanPatentTerminology(text, context.patent.patentType).map((replacement) => ({
          identityKey: `${book.kind}:${block.key}:${replacement.from}:${replacement.source}`,
          severity: "suggestion" as const,
          confidence: "likely" as const,
          code: "terminology-mismatch" as const,
          bookKind: book.kind,
          targetId: block.id,
          startOffset: replacement.from,
          endOffset: replacement.to,
          excerpt: replacement.source,
          recommendation: `请结合语境核实是否改为“${replacement.replacement}”。`,
          message: `发现与当前专利类型可能不一致的术语“${replacement.source}”。`,
        }));
      }),
    );
}

export const abstractLengthRule = createInspectionRule(
  {
    id: "core.abstract.length",
    category: "formal",
    cost: "instant",
    dependencies: ["abstract", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "摘要的字数和内容要求"),
    code: "abstract-too-long",
  },
  abstractIssues,
);

export function issuesForTitle(name: string | null | undefined): InspectionIssueDraft[] {
  const value = name ?? "";
  if (countUnicodeCharacters(value) <= 25) return [];
  const location = {
    kind: "book" as const,
    bookKind: "abstract" as const,
    targetId: null,
    metadataField: "patent-name" as const,
  };
  const tooLong = countUnicodeCharacters(value) > 60;
  return [
    {
      legacyCode: "patent-name-too-long",
      identityKey: tooLong ? "over-60" : "over-25",
      severity: tooLong ? "warning" : "suggestion",
      confidence: "certain",
      summary: tooLong ? "名称超过60个字" : "名称超过25个字，请核实是否确有必要",
      evidence: [{ location, excerpt: value }],
      locations: [location],
      recommendation: null,
    },
  ];
}

function createContentRule(
  config: Readonly<{
    id: string;
    category: "formal" | "consistency";
    cost: "instant" | "full";
    dependencies: readonly PatentInspectionRule["dependencies"][number][];
    provenance: InspectionRuleProvenance;
    code: PatentIssueCode;
    inspect: (
      context: PatentInspectionContext,
      facts: PatentFactIndex,
    ) => readonly InspectionIssueDraft[];
  }>,
): PatentInspectionRule {
  return {
    id: config.id,
    version: 1,
    category: config.category,
    defaultSeverity: "warning",
    cost: config.cost,
    dependencies: config.dependencies,
    provenance: config.provenance,
    appliesTo: () => true,
    inspect: config.inspect,
  };
}

export const patentNameLengthRule = createContentRule({
  id: "core.patent-name.length",
  category: "formal",
  cost: "instant",
  dependencies: ["patent-metadata"],
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "发明名称的撰写要求"),
  code: "patent-name-too-long",
  inspect: (context) => issuesForTitle(context.patent.name),
});

const PROMOTIONAL_PHRASES = [
  "世界领先",
  "国际领先",
  "国内领先",
  "行业领先",
  "国内首创",
  "全球首创",
  "填补空白",
  "质量最佳",
  "性能最佳",
  "效果最佳",
  "绝对安全",
  "完全可靠",
  "保证达到",
] as const;

function promotionalLanguageIssues(
  context: PatentInspectionContext,
): readonly InspectionIssueDraft[] {
  const issues: InspectionIssueDraft[] = [];
  for (const book of context.patent.books) {
    if (!["claims", "description", "abstract"].includes(book.kind)) continue;
    for (const block of inspectionTextBlocks(book.document.content)) {
      const text = block.text;
      for (const phrase of PROMOTIONAL_PHRASES) {
        let start = text.indexOf(phrase);
        while (start >= 0) {
          const location = {
            kind: "book" as const,
            bookKind: book.kind,
            targetId: block.id,
            startOffset: start,
            endOffset: start + phrase.length,
          };
          issues.push({
            legacyCode: "promotional-language",
            identityKey: `${book.kind}:${block.key}:${phrase}:${start}`,
            severity: "suggestion",
            confidence: "likely",
            summary: `包含宣传性表述“${phrase}”，请人工核实。`,
            evidence: [{ location, excerpt: phrase }],
            locations: [location],
            recommendation: "建议改为可由技术特征和客观效果支持的中性表述。",
          });
          start = text.indexOf(phrase, start + phrase.length);
        }
      }
    }
  }
  return issues;
}

export const promotionalLanguageRule = createContentRule({
  id: "core.content.promotional-language",
  category: "consistency",
  cost: "instant",
  dependencies: ["claims", "description", "abstract", "patent-metadata"],
  provenance: HEURISTIC_RULE,
  code: "promotional-language",
  inspect: promotionalLanguageIssues,
});
export const tableFixedRowHeightRule = createInspectionRule(
  {
    id: "core.tables.fixed-row-height",
    category: "export",
    cost: "instant",
    dependencies: ["description", "assets"],
    provenance: PRODUCT_POLICY.exportSafety,
    code: "table-fixed-row-height-warning",
  },
  tableIssues,
);
export const patentTypeTerminologyRule = createInspectionRule(
  {
    id: "core.terminology.patent-type",
    category: "terminology",
    cost: "instant",
    dependencies: ["claims", "description", "abstract", "patent-metadata"],
    provenance: HEURISTIC_RULE,
    code: "terminology-mismatch",
  },
  terminologyIssues,
);
