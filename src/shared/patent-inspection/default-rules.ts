import { resourceHealthRule } from "./resource-health.js";
import {
  descriptionChapterBodyRule,
  descriptionChapterStructureRule,
  requiredBooksRule,
  unresolvedTemplatePlaceholderRule,
} from "./rules/books.js";
import {
  claimMultipleReferenceBaseRule,
  claimMultipleReferenceChoiceRule,
  claimParagraphEndingRule,
  claimReferenceCycleRule,
} from "./rules/claim-drafting.js";
import {
  claimInternalPunctuationRule,
  claimKeywordReferenceRule,
  claimMethodWordingRule,
  claimNumberingRule,
  claimReferenceRule,
} from "./rules/claims.js";
import {
  abstractLengthRule,
  patentNameLengthRule,
  patentTypeTerminologyRule,
  promotionalLanguageRule,
  tableFixedRowHeightRule,
} from "./rules/content.js";
import { draftingQualityRules } from "./rules/drafting-quality.js";
import {
  abstractDrawingSelectionRule,
  drawingBooksPresentRule,
  drawingDisabledReferenceRule,
  drawingExplanationHeadingRule,
  drawingExplanationSyncRule,
  drawingFigureRequiredRule,
  structuredDrawingRules,
} from "./rules/drawings.js";
import { numericAndFormulaRules } from "./rules/numeric-and-formula.js";
import { repeatedPunctuationRule } from "./rules/punctuation.js";
import {
  referenceMarkDescriptionPresenceRule,
  referenceMarkLegendMatchRule,
} from "./rules/reference-marks.js";
import type { PatentInspectionRule } from "./types.js";

export const DEFAULT_PATENT_INSPECTION_RULES = [
  requiredBooksRule,
  descriptionChapterBodyRule,
  descriptionChapterStructureRule,
  unresolvedTemplatePlaceholderRule,
  claimNumberingRule,
  claimInternalPunctuationRule,
  repeatedPunctuationRule,
  claimReferenceRule,
  claimMultipleReferenceChoiceRule,
  claimMultipleReferenceBaseRule,
  claimReferenceCycleRule,
  claimParagraphEndingRule,
  claimMethodWordingRule,
  abstractLengthRule,
  patentNameLengthRule,
  promotionalLanguageRule,
  patentTypeTerminologyRule,
  claimKeywordReferenceRule,
  drawingDisabledReferenceRule,
  drawingExplanationHeadingRule,
  drawingBooksPresentRule,
  drawingFigureRequiredRule,
  abstractDrawingSelectionRule,
  drawingExplanationSyncRule,
  ...structuredDrawingRules,
  referenceMarkDescriptionPresenceRule,
  referenceMarkLegendMatchRule,
  ...numericAndFormulaRules,
  tableFixedRowHeightRule,
  ...draftingQualityRules,
  resourceHealthRule,
] as const satisfies readonly PatentInspectionRule[];
