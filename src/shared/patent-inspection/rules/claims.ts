import type { PatentFactIndex } from "../facts.js";
import { HEURISTIC_RULE, OFFICIAL_RULE, OFFICIAL_SOURCES } from "../rule-provenance.js";
import type {
  InspectionIssueDraft,
  PatentInspectionContext,
  PatentInspectionRule,
} from "../types.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

function claimIssues(
  ...[_context, facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const claims = facts.claims;
  const availableNumbers = new Set(claims.map((claim) => claim.number));
  // Paragraph-ending ownership moved to the full-cost drafting rule. Keep the
  // remaining structure diagnostics here for the legacy numbering rule.
  const issues: LegacyIssueShape[] = facts.claimStructureWarnings
    .filter((warning) => {
      if (warning.kind === "missing-ending" || warning.kind === "trailing-text") return false;
      if (warning.kind !== "internal-full-stop") return true;
      const text = claims.find((claim) => claim.number === warning.claimNumber)?.text ?? "";
      // The duplicate-punctuation rule owns a repeated final full stop.
      return text.replace(/。+/gu, "。").trim().slice(0, -1).includes("。");
    })
    .map((warning) => ({
      identityKey: `structure:${warning.kind}:${warning.claimNumber ?? "preface"}:${warning.targetId ?? "document"}`,
      severity: "warning",
      code:
        warning.kind === "internal-full-stop"
          ? "claim-paragraph-ending"
          : "claim-numbering-warning",
      bookKind: "claims",
      targetId: warning.targetId,
      message: warning.message,
    }));

  // 标号分隔符允许 "."、"．"或"、"，但整份权利要求书必须统一使用同一种，不得掺杂。
  const separators = new Set<string>();
  for (const claim of claims) {
    const match = /^\s*\d+([.．、])/u.exec(claim.text);
    if (match?.[1]) separators.add(match[1]);
  }
  if (separators.size > 1) {
    issues.push({
      identityKey: "number-separator-inconsistent",
      severity: "warning",
      code: "claim-numbering-warning",
      bookKind: "claims",
      targetId: claims[0]?.paragraphId ?? null,
      message: "权利要求标号分隔符不一致，请统一使用“1.”或“1、”风格。",
    });
  }

  const seenNumbers = new Set<number>();
  claims.forEach((claim, index) => {
    if (seenNumbers.has(claim.number)) {
      issues.push({
        severity: "warning",
        code: "claim-numbering-warning",
        bookKind: "claims",
        targetId: claim.paragraphId,
        message: `权利要求编号${claim.number}重复，请先修正编号后重新检查引用关系。`,
      });
    }
    seenNumbers.add(claim.number);
    if (claim.referenceError) {
      issues.push({
        severity: "warning",
        code: "claim-reference-warning",
        bookKind: "claims",
        targetId: claim.paragraphId,
        message: `权利要求${claim.number}：${claim.referenceError}`,
      });
    }
    const expectedNumber = index + 1;
    if (claim.number !== expectedNumber) {
      issues.push({
        identityKey: `expected-number:${expectedNumber}`,
        severity: "warning",
        code: "claim-numbering-warning",
        bookKind: "claims",
        targetId: claim.paragraphId,
        message: `编号不连续：第${expectedNumber}项为${claim.number}，应为${expectedNumber}。`,
      });
    }
    for (const parentNumber of claim.referencedNumbers) {
      if (parentNumber === claim.number) {
        issues.push({
          identityKey: `self-reference:${parentNumber}`,
          severity: "warning",
          code: "claim-reference-warning",
          bookKind: "claims",
          targetId: claim.paragraphId,
          message: `权利要求${claim.number}引用了自身，请人工检查。`,
        });
      } else if (!availableNumbers.has(parentNumber)) {
        issues.push({
          identityKey: `missing-reference:${parentNumber}`,
          severity: "warning",
          code: "claim-reference-warning",
          bookKind: "claims",
          targetId: claim.paragraphId,
          message: `权利要求${claim.number}引用了不存在的权利要求${parentNumber}。`,
        });
      } else if (parentNumber > claim.number) {
        issues.push({
          identityKey: `forward-reference:${parentNumber}`,
          severity: "warning",
          code: "claim-reference-warning",
          bookKind: "claims",
          targetId: claim.paragraphId,
          message: `权利要求${claim.number}引用了后续权利要求${parentNumber}，请人工检查。`,
        });
      }
    }
  });
  return issues;
}

export const claimNumberingRule = createInspectionRule(
  {
    id: "core.claims.numbering",
    category: "claim-structure",
    cost: "instant",
    dependencies: ["claims"],
    provenance: OFFICIAL_RULE(
      OFFICIAL_SOURCES.examinationGuidelines2023,
      "权利要求书的撰写与编号要求",
    ),
    code: "claim-numbering-warning",
  },
  claimIssues,
);
export const claimReferenceRule = createInspectionRule(
  {
    id: "core.claims.reference-chain",
    category: "claim-structure",
    cost: "instant",
    dependencies: ["claims"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "权利要求之间的引用关系"),
    code: "claim-reference-warning",
  },
  claimIssues,
);

export const claimInternalPunctuationRule = createInspectionRule(
  {
    id: "core.claims.internal-punctuation",
    category: "punctuation",
    cost: "instant",
    dependencies: ["claims"],
    provenance: HEURISTIC_RULE,
    code: "claim-paragraph-ending",
  },
  claimIssues,
);

function methodWordingIssues(
  context: PatentInspectionContext,
  facts: PatentFactIndex,
): LegacyIssueShape[] {
  // 方法类表述在发明专利中合法，仅对实用新型提示人工确认。
  if (context.patent.patentType !== "utility-model") return [];
  return facts.claims
    .filter((claim) => /(?:方法|步骤|流程)$/u.test(claim.subjectName?.trim() ?? ""))
    .flatMap((claim) => {
      const paragraph = claim.paragraphs[0];
      if (!paragraph) return [];
      const match = /方法|步骤|流程/u.exec(paragraph.text);
      const start = match?.index ?? 0;
      return [
        {
          severity: "suggestion" as const,
          confidence: "likely" as const,
          code: "utility-model-method-wording" as const,
          bookKind: "claims" as const,
          targetId: paragraph.paragraphId,
          startOffset: start,
          endOffset: start + (match?.[0].length ?? 2),
          excerpt: match?.[0] ?? claim.subjectName,
          recommendation: "请确认该表述限定的是产品结构，而不是方法步骤。",
          message: `权利要求${claim.number}可能保护的是方法。`,
        },
      ];
    });
}

export const claimMethodWordingRule = createInspectionRule(
  {
    id: "core.claims.utility-method-wording",
    category: "terminology",
    cost: "instant",
    dependencies: ["claims", "patent-metadata"],
    provenance: HEURISTIC_RULE,
    code: "utility-model-method-wording",
  },
  methodWordingIssues,
);

export const claimKeywordReferenceRule: PatentInspectionRule = {
  id: "core.claims.keyword-reference",
  version: 1,
  category: "support",
  defaultSeverity: "suggestion",
  cost: "full",
  dependencies: ["claims", "description"],
  provenance: HEURISTIC_RULE,
  appliesTo: () => true,
  inspect: (_context, facts): readonly InspectionIssueDraft[] => {
    const description = facts.books.get("description")?.visibleText ?? "";
    if (!description.trim()) return [];
    return facts.claims.flatMap((claim) => {
      const subject = claim.subjectName?.trim() ?? "";
      if (subject.length < 2 || subject.includes("____") || description.includes(subject))
        return [];
      const paragraph = claim.paragraphs.find((item) => item.text.includes(subject));
      if (!paragraph) return [];
      const start = paragraph.text.indexOf(subject);
      const location = {
        kind: "book" as const,
        bookKind: "claims" as const,
        targetId: paragraph.paragraphId,
        startOffset: start,
        endOffset: start + subject.length,
      };
      return [
        {
          legacyCode: "claim-keyword-reference-warning" as const,
          identityKey: `${claim.number}:${subject}`,
          severity: "suggestion" as const,
          confidence: "uncertain" as const,
          summary: `权利要求${claim.number}的主题名称“${subject}”未在说明书中找到完全一致的表述。`,
          evidence: [{ location, excerpt: subject }],
          locations: [location],
          recommendation: "请核对说明书是否对该主题名称提供了对应记载；同义表述可人工忽略。",
        },
      ];
    });
  },
};
