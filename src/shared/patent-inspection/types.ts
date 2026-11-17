import type { CanonicalPatent, PatentBookKind } from "../patent/model.js";
import type { PatentFactIndex } from "./facts.js";

export const PATENT_INSPECTION_ENGINE_VERSION = 12 as const;

export type PatentIssueCode =
  | "claim-ordinary-image"
  | "reference-mark-number-mismatch"
  | "unbalanced-text-pair"
  | "duplicate-drafting-content"
  | "table-number-duplicate"
  | "table-reference-missing"
  | "formula-invalid-syntax"
  | "cross-book-reference"
  | "unfinished-editing-marker"
  | "asset-unreadable"
  | "repeated-punctuation"
  | "empty-required-book"
  | "missing-description-chapter"
  | "description-chapter-duplicate"
  | "description-chapter-order"
  | "unresolved-template-placeholder"
  | "abstract-too-long"
  | "patent-name-too-long"
  | "promotional-language"
  | "numeric-range-reversed"
  | "numeric-percentage-total"
  | "numeric-quantity-mapping"
  | "numeric-unit-mismatch"
  | "numeric-subrange-out-of-bounds"
  | "formula-literal-zero-denominator"
  | "formula-undefined-symbol"
  | "formula-duplicate-definition"
  | "drawing-missing-figure"
  | "drawing-duplicate-label"
  | "drawing-explanation-mismatch"
  | "drawing-abstract-selection-mismatch"
  | "claim-numbering-warning"
  | "claim-reference-warning"
  | "claim-keyword-reference-warning"
  | "claim-multiple-reference-choice"
  | "claim-multiple-reference-base"
  | "claim-reference-cycle"
  | "claim-paragraph-ending"
  | "utility-model-method-wording"
  | "drawing-explanation-sync-paused"
  | "missing-figure-explanation"
  | "missing-abstract-drawing"
  | "table-fixed-row-height-warning"
  | "reference-mark-missing-in-description"
  | "reference-mark-description-mismatch"
  | "terminology-mismatch"
  | "drawing-reference-without-drawing-books"
  | "missing-drawing-explanation-heading"
  | "missing-drawing-book";

export type InspectionMode = "instant" | "full";
export type InspectionRuleCost = "instant" | "full";
export type InspectionDependency =
  | PatentBookKind
  | "patent-metadata"
  | "figures"
  | "assets"
  | "reference-marks";
export type InspectionRuleAuthority = "official" | "product-policy" | "heuristic";
export type InspectionRuleProvenance = Readonly<{
  authority: InspectionRuleAuthority;
  basisLabel: string;
  reference: string | null;
  basisUrl: string | null;
  effectiveFrom: string | null;
}>;
export type InspectionCategory =
  | "completeness"
  | "claims"
  | "drawings"
  | "reference-marks"
  | "content"
  | "spelling"
  | "grammar"
  | "punctuation"
  | "terminology"
  | "claim-structure"
  | "reference"
  | "formal"
  | "consistency"
  | "numeric"
  | "logic"
  | "support"
  | "drawing-reference"
  | "export";

export type InspectionSeverity = "error" | "warning" | "suggestion";

export type PatentLocation = Readonly<{
  kind?: "book" | undefined;
  bookKind: PatentBookKind;
  targetId: string | null;
  startOffset?: number | undefined;
  endOffset?: number | undefined;
  metadataField?: "patent-name" | undefined;
}>;

export type InspectionEvidence = Readonly<{
  location: PatentLocation;
  excerpt: string | null;
}>;

export type InspectionIssueDraft = Readonly<{
  legacyCode: PatentIssueCode;
  identityKey?: string | undefined;
  severity: InspectionSeverity;
  confidence: "certain" | "likely" | "uncertain";
  summary: string;
  evidence: readonly InspectionEvidence[];
  locations: readonly PatentLocation[];
  recommendation: string | null;
  legalBasis?: null | Readonly<{ title: string; reference: string }> | undefined;
}>;

export type InspectionIssue = InspectionIssueDraft &
  Readonly<{
    fingerprint: string;
    ruleId: string;
    ruleVersion: number;
    source: "deterministic";
    category: InspectionCategory;
    provenance?: InspectionRuleProvenance | undefined;
  }>;

export type PatentInspectionContext = Readonly<{
  patent: CanonicalPatent;
  mode: InspectionMode;
}>;

export type PatentInspectionRule = Readonly<{
  id: string;
  version: number;
  category: InspectionCategory;
  defaultSeverity: InspectionSeverity;
  cost: InspectionRuleCost;
  dependencies: readonly InspectionDependency[];
  provenance: InspectionRuleProvenance;
  appliesTo(context: PatentInspectionContext): boolean;
  inspect(
    context: PatentInspectionContext,
    facts: PatentFactIndex,
  ): readonly InspectionIssueDraft[];
}>;

export type PatentInspectionReport = Readonly<{
  engineVersion: number;
  patentId: string;
  patentRevision: number;
  mode: InspectionMode;
  checkedAt: string;
  issues: readonly InspectionIssue[];
  degradedRules: readonly Readonly<{ ruleId: string; message: string }>[];
}>;

export class InspectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionUnavailableError";
  }
}
