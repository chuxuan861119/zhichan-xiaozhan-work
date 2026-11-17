import {
  inspectDrawingExplanationSync,
  listVisibleDrawingExplanations,
} from "../../patent/drawing-explanations.js";
import { hasDrawingExplanationHeading } from "../../patent/reference-mark-legend.js";
import { visibleBlockText } from "../../patent/text.js";
import { descriptionInput } from "../description-input.js";
import { drawingReferences } from "../drawing-references.js";
import { OFFICIAL_RULE, OFFICIAL_SOURCES } from "../rule-provenance.js";
import type {
  InspectionIssueDraft,
  InspectionRuleProvenance,
  PatentInspectionContext,
  PatentInspectionRule,
  PatentIssueCode,
  PatentLocation,
} from "../types.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

function drawingAvailabilityIssues(
  ...[context, facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const description = context.patent.books.find((book) => book.kind === "description");
  if (!description) return [];
  if (!context.patent.drawingBooksEnabled) {
    const descriptionText = facts.books.get("description")?.visibleText ?? "";
    const hasDrawingReference = drawingReferences(descriptionText).length > 0;
    return hasDrawingReference
      ? [
          {
            severity: "error",
            code: "drawing-reference-without-drawing-books",
            bookKind: "description",
            targetId: null,
            message: "已删除说明书附图和摘要附图，但说明书仍包含附图说明或附图引用。",
          },
        ]
      : [];
  }

  const issues: LegacyIssueShape[] = [];
  if (
    context.patent.figures.length > 0 &&
    !hasDrawingExplanationHeading(descriptionInput(description.document))
  ) {
    issues.push({
      severity: "error",
      code: "missing-drawing-explanation-heading",
      bookKind: "description",
      targetId: null,
      message: "已有附图，但未找到“附图说明”标题。",
      recommendation: "在说明书中补充附图说明。",
    });
  }
  for (const kind of ["description-drawings", "abstract-drawing"] as const) {
    if (!context.patent.books.some((book) => book.kind === kind)) {
      issues.push({
        severity: "error",
        code: "missing-drawing-book",
        bookKind: kind,
        targetId: null,
        message: `${kind === "description-drawings" ? "说明书附图" : "摘要附图"}不存在，请重新添加附图书。`,
      });
    }
  }
  return issues;
}

function figureIssues(
  ...[context]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const { patent } = context;
  const issues: LegacyIssueShape[] = [];
  if (patent.patentType === "utility-model" && patent.figures.length === 0) {
    issues.push({
      severity: "warning",
      code: "missing-figure-explanation",
      bookKind: "description-drawings",
      targetId: null,
      message: "实用新型还没有说明书附图。",
      recommendation: "添加产品结构附图。",
    });
  }
  if (
    patent.figures.length > 0 &&
    patent.patentType === "utility-model" &&
    patent.abstractDrawingFigureId === null
  ) {
    issues.push({
      severity: "warning",
      code: "missing-abstract-drawing",
      bookKind: "abstract-drawing",
      targetId: null,
      message: "实用新型需要选择摘要附图。",
    });
  }
  if (
    patent.patentType === "invention" &&
    patent.figures.length > 0 &&
    patent.abstractDrawingFigureId === null
  ) {
    issues.push({
      severity: "warning",
      code: "missing-abstract-drawing",
      bookKind: "abstract-drawing",
      targetId: null,
      message: "已有说明书附图时，请确认是否选择摘要附图。",
    });
  }
  return issues;
}

function explanationSyncIssues(
  ...[context]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const { patent } = context;
  if (!patent.drawingBooksEnabled || patent.figures.length === 0) return [];
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) return [];
  const sync = inspectDrawingExplanationSync(
    descriptionInput(description.document),
    patent.figures.map((figure) => figure.figureId),
  );
  return sync.status === "paused"
    ? [
        {
          severity: "warning",
          code: "drawing-explanation-sync-paused",
          bookKind: "description",
          targetId: null,
          message: "附图说明与现有附图存在缺失、重复、越界或顺序问题，请核对。",
        },
      ]
    : [];
}

export const drawingDisabledReferenceRule = createInspectionRule(
  {
    id: "core.drawings.disabled-references",
    category: "drawing-reference",
    cost: "instant",
    dependencies: [
      "description",
      "description-drawings",
      "abstract-drawing",
      "figures",
      "patent-metadata",
    ],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "附图说明和附图引用要求"),
    code: "drawing-reference-without-drawing-books",
  },
  drawingAvailabilityIssues,
);
export const drawingExplanationHeadingRule = createInspectionRule(
  {
    id: "core.drawings.explanation-heading",
    category: "drawing-reference",
    cost: "instant",
    dependencies: [
      "description",
      "description-drawings",
      "abstract-drawing",
      "figures",
      "patent-metadata",
    ],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "附图说明章节要求"),
    code: "missing-drawing-explanation-heading",
  },
  drawingAvailabilityIssues,
);
export const drawingBooksPresentRule = createInspectionRule(
  {
    id: "core.drawings.books-present",
    category: "drawing-reference",
    cost: "instant",
    dependencies: ["description", "description-drawings", "abstract-drawing", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "申请文件附图组成要求"),
    code: "missing-drawing-book",
  },
  drawingAvailabilityIssues,
);
export const drawingFigureRequiredRule = createInspectionRule(
  {
    id: "core.drawings.figure-required",
    category: "drawing-reference",
    cost: "instant",
    dependencies: ["figures", "description-drawings", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "实用新型附图要求"),
    code: "missing-figure-explanation",
  },
  figureIssues,
);
export const abstractDrawingSelectionRule = createInspectionRule(
  {
    id: "core.drawings.abstract-selection",
    category: "drawing-reference",
    cost: "instant",
    dependencies: ["figures", "abstract-drawing", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "摘要附图选择要求"),
    code: "missing-abstract-drawing",
  },
  figureIssues,
);
export const drawingExplanationSyncRule = createInspectionRule(
  {
    id: "core.drawings.explanation-sync",
    category: "drawing-reference",
    cost: "instant",
    dependencies: ["description", "description-drawings", "figures", "patent-metadata"],
    provenance: OFFICIAL_RULE(
      OFFICIAL_SOURCES.examinationGuidelines2023,
      "附图说明与附图一致性要求",
    ),
    code: "drawing-explanation-sync-paused",
  },
  explanationSyncIssues,
);

export const DRAWING_RULE_IDS = [
  "core.drawings.missing-figure",
  "core.drawings.duplicate-label",
  "core.drawings.explanation-mismatch",
  "core.drawings.abstract-selection-mismatch",
] as const;

type DrawingExplanation = Readonly<{
  blockId: string;
  figureId: string | null;
  visibleNumber: number;
  sequenceNumber: number;
  text: string;
}>;

function drawingExplanations(context: PatentInspectionContext): DrawingExplanation[] {
  const description = context.patent.books.find((book) => book.kind === "description");
  if (!description) return [];
  return listVisibleDrawingExplanations(descriptionInput(description.document)).map(
    (entry, index) => ({
      blockId: entry.paragraph.id,
      figureId: context.patent.figures[entry.figureNumber - 1]?.figureId ?? null,
      visibleNumber: entry.figureNumber,
      sequenceNumber: index + 1,
      text: visibleBlockText(entry.paragraph),
    }),
  );
}

function drawingLocation(
  bookKind: Exclude<PatentLocation["bookKind"], null>,
  targetId: string | null,
  startOffset?: number,
  endOffset?: number,
): PatentLocation {
  return {
    kind: "book",
    bookKind,
    targetId,
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
  };
}

function createDrawingRule(
  config: Readonly<{
    id: (typeof DRAWING_RULE_IDS)[number];
    code: PatentIssueCode;
    provenance: InspectionRuleProvenance;
    inspect: (context: PatentInspectionContext) => readonly InspectionIssueDraft[];
  }>,
): PatentInspectionRule {
  return {
    id: config.id,
    version: 1,
    category: "drawing-reference",
    defaultSeverity: "warning",
    cost: "instant",
    dependencies: [
      "description",
      "description-drawings",
      "abstract-drawing",
      "figures",
      "patent-metadata",
    ],
    provenance: config.provenance,
    appliesTo: () => true,
    inspect: (context) => config.inspect(context),
  };
}

function missingFigureIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  if (!context.patent.drawingBooksEnabled) return [];
  const figureNumbers = new Set(context.patent.figures.map((_figure, index) => index + 1));
  const issues: InspectionIssueDraft[] = [];
  const description = context.patent.books.find((book) => book.kind === "description");
  const explanations = drawingExplanations(context);
  const explanationBlockIds = new Set(explanations.map((explanation) => explanation.blockId));
  for (const block of description?.document.content ?? []) {
    if (explanationBlockIds.has(block.id)) continue;
    const text = visibleBlockText(block);
    for (const match of drawingReferences(text)) {
      if (figureNumbers.has(match.first) && figureNumbers.has(match.last)) continue;
      const start = match.start;
      const location = drawingLocation("description", block.id, start, match.end);
      issues.push({
        legacyCode: "drawing-missing-figure",
        identityKey: `reference:${block.id}:${match.first}:${match.last}:${start}`,
        severity: "warning",
        confidence: "certain",
        summary:
          match.first === match.last
            ? `正文引用的图${match.first}不存在。`
            : `正文引用的图${match.first}至图${match.last}包含不存在的附图（当前共${figureNumbers.size}幅）。`,
        evidence: [{ location, excerpt: match.text }],
        locations: [location],
        recommendation: null,
      });
    }
  }

  const explained = new Set(
    explanations.flatMap((explanation) =>
      explanation.figureId === null ? [] : [explanation.figureId],
    ),
  );
  for (const [index, figure] of context.patent.figures.entries()) {
    if (explained.has(figure.figureId)) continue;
    const location = drawingLocation("description-drawings", figure.figureId);
    issues.push({
      legacyCode: "drawing-missing-figure",
      identityKey: `explanation:${figure.figureId}`,
      severity: "warning",
      confidence: "certain",
      summary: `图${index + 1}缺少附图说明。`,
      evidence: [{ location, excerpt: null }],
      locations: [location],
      recommendation: null,
    });
  }
  return issues;
}

function duplicateLabelIssues(context: PatentInspectionContext): readonly InspectionIssueDraft[] {
  if (!context.patent.drawingBooksEnabled) return [];
  const explanations = drawingExplanations(context);
  const byVisibleNumber = new Map<number, DrawingExplanation[]>();
  for (const explanation of explanations) {
    byVisibleNumber.set(explanation.visibleNumber, [
      ...(byVisibleNumber.get(explanation.visibleNumber) ?? []),
      explanation,
    ]);
  }
  const issues: InspectionIssueDraft[] = [];
  for (const [number, items] of byVisibleNumber) {
    if (items.length < 2) continue;
    issues.push({
      legacyCode: "drawing-duplicate-label",
      identityKey: `label:${number}`,
      severity: "warning",
      confidence: "certain",
      summary: `图${number}的附图说明标签重复。`,
      evidence: items.map((item) => ({
        location: drawingLocation("description", item.blockId),
        excerpt: item.text,
      })),
      locations: items.map((item) => drawingLocation("description", item.blockId)),
      recommendation: null,
    });
  }
  return issues;
}

function explanationMismatchIssues(
  context: PatentInspectionContext,
): readonly InspectionIssueDraft[] {
  if (!context.patent.drawingBooksEnabled) return [];
  return drawingExplanations(context).flatMap((explanation) => {
    const expected = explanation.sequenceNumber;
    if (explanation.figureId !== null && explanation.visibleNumber === expected) return [];
    const location = drawingLocation("description", explanation.blockId);
    return [
      {
        legacyCode: "drawing-explanation-mismatch" as const,
        identityKey: `${explanation.visibleNumber}:${explanation.blockId}`,
        severity: "warning" as const,
        confidence: "certain" as const,
        summary:
          explanation.figureId === null
            ? `附图说明引用的图${explanation.visibleNumber}不存在。`
            : `第${expected}条附图说明的图号为图${explanation.visibleNumber}，按顺序应为图${expected}。`,
        evidence: [{ location, excerpt: explanation.text }],
        locations: [location],
        recommendation: null,
      },
    ];
  });
}

function abstractSelectionMismatchIssues(
  context: PatentInspectionContext,
): readonly InspectionIssueDraft[] {
  if (!context.patent.drawingBooksEnabled) return [];
  const selected = context.patent.figures.find(
    (figure) => figure.figureId === context.patent.abstractDrawingFigureId,
  );
  const abstractBook = context.patent.books.find((book) => book.kind === "abstract-drawing");
  if (!abstractBook) return [];
  const abstractFigures = abstractBook.document.content.filter(
    (block) => block.type === "figure" && block.semanticRole === "abstract-drawing",
  );
  if (context.patent.abstractDrawingFigureId !== null && !selected) {
    const location = drawingLocation("abstract-drawing", null);
    return [
      {
        legacyCode: "drawing-abstract-selection-mismatch",
        identityKey: "selected-figure-missing",
        severity: "warning",
        confidence: "certain",
        summary: "原来选择的摘要附图已不存在，请重新选择。",
        evidence: [{ location, excerpt: null }],
        locations: [location],
        recommendation: null,
      },
    ];
  }
  if (!selected) return [];
  // Normal documents store only the selected figure id. Display/exports resolve
  // that selection from patent.figures, without duplicating it in book content.
  return abstractFigures.flatMap((figure) => {
    if (figure.type !== "figure" || figure.assetId === selected.assetId) return [];
    const location = drawingLocation("abstract-drawing", null);
    return [
      {
        legacyCode: "drawing-abstract-selection-mismatch" as const,
        identityKey: `asset:${figure.id}`,
        severity: "warning" as const,
        confidence: "certain" as const,
        summary: "摘要附图中另有一张图片，与当前选择不同，请核对。",
        evidence: [{ location, excerpt: null }],
        locations: [location],
        recommendation: null,
      },
    ];
  });
}

export const structuredDrawingMissingFigureRule = createDrawingRule({
  id: "core.drawings.missing-figure",
  code: "drawing-missing-figure",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "附图引用和附图说明要求"),
  inspect: missingFigureIssues,
});
export const structuredDrawingDuplicateLabelRule = createDrawingRule({
  id: "core.drawings.duplicate-label",
  code: "drawing-duplicate-label",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "附图说明应当清楚一致"),
  inspect: duplicateLabelIssues,
});
export const structuredDrawingExplanationMismatchRule = createDrawingRule({
  id: "core.drawings.explanation-mismatch",
  code: "drawing-explanation-mismatch",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "附图说明与附图顺序一致"),
  inspect: explanationMismatchIssues,
});
export const structuredDrawingAbstractSelectionRule = createDrawingRule({
  id: "core.drawings.abstract-selection-mismatch",
  code: "drawing-abstract-selection-mismatch",
  provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "摘要附图选择要求"),
  inspect: abstractSelectionMismatchIssues,
});

export const structuredDrawingRules = [
  structuredDrawingMissingFigureRule,
  structuredDrawingDuplicateLabelRule,
  structuredDrawingExplanationMismatchRule,
  structuredDrawingAbstractSelectionRule,
] as const;
