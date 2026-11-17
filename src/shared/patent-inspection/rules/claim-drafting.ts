import type { ClaimFact, ClaimGraph } from "../claim-graph.js";
import type { PatentFactIndex } from "../facts.js";
import { OFFICIAL_RULE, OFFICIAL_SOURCES, PRODUCT_POLICY } from "../rule-provenance.js";
import type {
  InspectionCategory,
  InspectionIssueDraft,
  InspectionRuleProvenance,
  PatentInspectionRule,
  PatentIssueCode,
} from "../types.js";
import { InspectionUnavailableError } from "../types.js";

const CLAIM_DRAFTING_CATEGORY: InspectionCategory = "claim-structure";

export class ClaimDraftingFactsError extends Error {
  constructor(message = "权利要求撰写检查需要完整事实索引。") {
    super(message);
    this.name = "ClaimDraftingFactsError";
  }
}

function requireClaimGraph(facts: PatentFactIndex): ClaimGraph {
  const graph = facts.full?.claimGraph;
  if (!graph) {
    const numbers = facts.claims.map((claim) => claim.number);
    if (new Set(numbers).size !== numbers.length)
      throw new InspectionUnavailableError(
        "权利要求编号重复，引用关系检查暂时无法完成。请先修正编号，再重新检查。",
      );
    throw new ClaimDraftingFactsError();
  }
  return graph;
}

function locationForClaim(claim: ClaimFact) {
  return {
    kind: "book" as const,
    bookKind: "claims" as const,
    targetId: claim.paragraphId || null,
  };
}

function issue(
  claim: ClaimFact,
  legacyCode: PatentIssueCode,
  summary: string,
  severity: "warning" | "suggestion" = "warning",
  identityKey?: string,
): InspectionIssueDraft {
  const location = locationForClaim(claim);
  return {
    legacyCode,
    ...(identityKey === undefined ? {} : { identityKey }),
    severity,
    confidence: "certain",
    summary,
    evidence: [{ location, excerpt: claim.text }],
    locations: [location],
    recommendation: null,
  };
}

function createClaimDraftingRule(
  config: Readonly<{
    id: string;
    code: PatentIssueCode;
    provenance: InspectionRuleProvenance;
    inspect: (facts: PatentFactIndex) => readonly InspectionIssueDraft[];
  }>,
): PatentInspectionRule {
  return {
    id: config.id,
    version: 1,
    category: CLAIM_DRAFTING_CATEGORY,
    defaultSeverity: "warning",
    cost: "full",
    dependencies: ["claims"],
    provenance: config.provenance,
    appliesTo: () => true,
    inspect: (_context, facts) => config.inspect(facts),
  };
}

function multipleReferenceChoiceIssues(facts: PatentFactIndex): readonly InspectionIssueDraft[] {
  const graph = requireClaimGraph(facts);
  return facts.claims
    .filter((claim) => graph.multipleDependentNumbers.has(claim.number))
    .filter((claim) => !claim.alternativeReference)
    .map((claim) =>
      issue(
        claim,
        "claim-multiple-reference-choice",
        `权利要求${claim.number}为多项从属，引用多个权利要求时应使用“或”或“任一项”等择一表述。`,
        "warning",
        `claim:${claim.number}:choice`,
      ),
    );
}

function multipleReferenceBaseIssues(facts: PatentFactIndex): readonly InspectionIssueDraft[] {
  const graph = requireClaimGraph(facts);
  const issues: InspectionIssueDraft[] = [];
  for (const claim of facts.claims) {
    if (!graph.multipleDependentNumbers.has(claim.number)) continue;
    const invalidParents: number[] = [];
    for (const referencedNumber of claim.referencedNumbers) {
      const parent = graph.byNumber.get(referencedNumber);
      if (!parent?.multipleDependent) continue;
      invalidParents.push(referencedNumber);
    }
    if (invalidParents.length > 0) {
      issues.push(
        issue(
          claim,
          "claim-multiple-reference-base",
          `权利要求${claim.number}为多项从属，不得引用前一多项从属权利要求${invalidParents.slice(0, 20).join("、")}${invalidParents.length > 20 ? `等${invalidParents.length}项` : ""}。`,
          "warning",
          `claim:${claim.number}:base`,
        ),
      );
    }
  }
  return issues;
}

function referenceCycleIssues(facts: PatentFactIndex): readonly InspectionIssueDraft[] {
  const graph = requireClaimGraph(facts);
  return graph.cycles.flatMap((cycle) => {
    const firstClaimNumber = cycle[0];
    const firstClaim =
      firstClaimNumber === undefined ? undefined : graph.byNumber.get(firstClaimNumber);
    if (!firstClaim) return [];
    return [
      issue(
        firstClaim,
        "claim-reference-cycle",
        `权利要求引用关系形成循环（${cycle.join("、")}），请断开循环引用。`,
        "warning",
        `cycle:${cycle.join(",")}`,
      ),
    ];
  });
}

function paragraphEndingIssues(facts: PatentFactIndex): readonly InspectionIssueDraft[] {
  if (!facts.full) throw new ClaimDraftingFactsError();
  const issues: InspectionIssueDraft[] = [];

  for (const claim of facts.claims) {
    const paragraphs = claim.paragraphs.filter((paragraph) => paragraph.text.trim().length > 0);
    const finalParagraph = paragraphs.at(-1);
    if (!finalParagraph) continue;

    for (const paragraph of paragraphs.slice(0, -1)) {
      const text = paragraph.text.trim();
      const firstPeriod = text.indexOf("。");
      if (firstPeriod < 0) continue;
      const location = {
        kind: "book" as const,
        bookKind: "claims" as const,
        targetId: paragraph.paragraphId || null,
      };
      issues.push({
        legacyCode: "claim-paragraph-ending",
        identityKey: `claim:${claim.number}:paragraph:${paragraph.paragraphId}:middle-period`,
        severity: "warning",
        confidence: "certain",
        summary:
          firstPeriod < text.length - 1
            ? `权利要求${claim.number}的非末段包含中文句号“。”且其后仍有文字，请将句号保留在权利要求末段。`
            : `权利要求${claim.number}的非末段以中文句号“。”结束，请将句号保留在权利要求末段。`,
        evidence: [{ location, excerpt: paragraph.text }],
        locations: [location],
        recommendation: null,
      });
    }

    if (finalParagraph.text.trim().endsWith("。")) continue;
    const location = {
      kind: "book" as const,
      bookKind: "claims" as const,
      targetId: finalParagraph.paragraphId || null,
    };
    issues.push({
      legacyCode: "claim-paragraph-ending",
      identityKey: `claim:${claim.number}:paragraph:${finalParagraph.paragraphId}:missing-period`,
      severity: "suggestion",
      confidence: "certain",
      summary: `权利要求${claim.number}末段缺少中文句号“。”，建议补充。`,
      evidence: [{ location, excerpt: finalParagraph.text }],
      locations: [location],
      recommendation: null,
    });
  }

  return issues;
}

export const claimMultipleReferenceChoiceRule = createClaimDraftingRule({
  id: "core.claims.multiple-reference-choice",
  code: "claim-multiple-reference-choice",
  provenance: OFFICIAL_RULE(
    OFFICIAL_SOURCES.examinationGuidelines2023,
    "多项从属权利要求的择一引用要求",
  ),
  inspect: multipleReferenceChoiceIssues,
});

export const claimMultipleReferenceBaseRule = createClaimDraftingRule({
  id: "core.claims.multiple-reference-base",
  code: "claim-multiple-reference-base",
  provenance: OFFICIAL_RULE(
    OFFICIAL_SOURCES.examinationGuidelines2023,
    "多项从属权利要求的引用基础要求",
  ),
  inspect: multipleReferenceBaseIssues,
});

export const claimReferenceCycleRule = createClaimDraftingRule({
  id: "core.claims.reference-cycle",
  code: "claim-reference-cycle",
  provenance: OFFICIAL_RULE(
    OFFICIAL_SOURCES.examinationGuidelines2023,
    "权利要求引用关系不得形成循环",
  ),
  inspect: referenceCycleIssues,
});

export const claimParagraphEndingRule = createClaimDraftingRule({
  id: "core.claims.paragraph-ending",
  code: "claim-paragraph-ending",
  provenance: PRODUCT_POLICY.claimPunctuation,
  inspect: paragraphEndingIssues,
});
