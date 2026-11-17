import type { PatentBookKind } from "../../patent/model.js";
import type {
  InspectionCategory,
  InspectionDependency,
  InspectionIssueDraft,
  InspectionRuleCost,
  InspectionRuleProvenance,
  PatentInspectionRule,
  PatentIssueCode,
} from "../types.js";

export type LegacyIssueShape = Readonly<{
  identityKey?: string;
  severity: "warning" | "error" | "suggestion";
  confidence?: "certain" | "likely" | "uncertain";
  code: PatentIssueCode;
  bookKind: PatentBookKind;
  targetId: string | null;
  startOffset?: number;
  endOffset?: number;
  excerpt?: string | null;
  recommendation?: string | null;
  message: string;
}>;

export type InspectionRuleConfig = Readonly<{
  id: string;
  category: InspectionCategory;
  cost: InspectionRuleCost;
  dependencies: readonly InspectionDependency[];
  provenance: InspectionRuleProvenance;
  code: PatentIssueCode;
}>;

export function createInspectionRule(
  config: InspectionRuleConfig,
  inspect: (
    ...parameters: Parameters<PatentInspectionRule["inspect"]>
  ) => readonly LegacyIssueShape[],
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
    inspect: (context, facts) =>
      inspect(context, facts)
        .filter((issue) => issue.code === config.code)
        .map(toInspectionDraft),
  };
}

function toInspectionDraft(issue: LegacyIssueShape): InspectionIssueDraft {
  const location = {
    kind: "book" as const,
    bookKind: issue.bookKind,
    targetId: issue.targetId,
    ...(issue.startOffset === undefined ? {} : { startOffset: issue.startOffset }),
    ...(issue.endOffset === undefined ? {} : { endOffset: issue.endOffset }),
  };
  return {
    legacyCode: issue.code,
    ...(issue.identityKey === undefined ? {} : { identityKey: issue.identityKey }),
    severity: issue.severity,
    confidence: issue.confidence ?? "certain",
    summary: issue.message,
    evidence: issue.excerpt === undefined ? [] : [{ location, excerpt: issue.excerpt }],
    locations: [location],
    recommendation: issue.recommendation ?? null,
  };
}
