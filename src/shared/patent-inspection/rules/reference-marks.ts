import { inspectReferenceMarkDescriptionState } from "../../patent/reference-mark-operations.js";
import {
  countKeyword,
  protectedReferenceMarkKeywordSearches,
} from "../../patent/reference-mark-text.js";
import { descriptionInput } from "../description-input.js";
import { OFFICIAL_RULE, OFFICIAL_SOURCES } from "../rule-provenance.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

function referenceMarkIssues(
  ...[context]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const patent = {
    ...context.patent,
    books: context.patent.books.map((book) =>
      book.kind === "description" ? { ...book, document: descriptionInput(book.document) } : book,
    ),
  };
  if (!patent.drawingBooksEnabled) return [];
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) return [];
  const missing = patent.referenceMarks.flatMap((entry) =>
    countKeyword(description.document, entry.keyword, {
      excludeLegend: true,
      protectedSearches: protectedReferenceMarkKeywordSearches(
        description.document,
        entry.keyword,
        patent.referenceMarks,
        { includeUnparenthesizedNumbers: true },
      ),
    }) > 0
      ? []
      : [
          {
            severity: "warning" as const,
            code: "reference-mark-missing-in-description" as const,
            bookKind: "description" as const,
            targetId: null,
            confidence: "likely" as const,
            recommendation: "在说明书正文补充部件名称，或删除不用的标记。",
            message: `说明书中未找到附图标记“${entry.keyword}”（${entry.number}）。`,
          },
        ],
  );
  const state = inspectReferenceMarkDescriptionState(patent);
  const mismatch: LegacyIssueShape[] =
    state.status === "different" || state.status === "invalid"
      ? [
          {
            severity: "warning",
            code: "reference-mark-description-mismatch",
            bookKind: "description",
            targetId: null,
            message: "说明书中的附图标记与附图标记组件不一致。",
          },
        ]
      : [];
  return [...missing, ...mismatch];
}

export const referenceMarkDescriptionPresenceRule = createInspectionRule(
  {
    id: "core.reference-marks.description-presence",
    category: "drawing-reference",
    cost: "instant",
    dependencies: [
      "description",
      "description-drawings",
      "abstract-drawing",
      "figures",
      "reference-marks",
      "patent-metadata",
    ],
    provenance: OFFICIAL_RULE(
      OFFICIAL_SOURCES.examinationGuidelines2023,
      "附图标记的使用和说明要求",
    ),
    code: "reference-mark-missing-in-description",
  },
  referenceMarkIssues,
);
export const referenceMarkLegendMatchRule = createInspectionRule(
  {
    id: "core.reference-marks.legend-match",
    category: "drawing-reference",
    cost: "instant",
    dependencies: [
      "description",
      "description-drawings",
      "abstract-drawing",
      "figures",
      "reference-marks",
      "patent-metadata",
    ],
    provenance: OFFICIAL_RULE(
      OFFICIAL_SOURCES.examinationGuidelines2023,
      "附图标记与说明书附图说明一致性要求",
    ),
    code: "reference-mark-description-mismatch",
  },
  referenceMarkIssues,
);
