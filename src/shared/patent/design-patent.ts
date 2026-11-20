import { z } from "zod";
import { DesignEditorStateSchema } from "./design-editor-state.js";

export const MAX_DESIGN_IMAGE_EDGE_PX = 6_000;
export const MAX_DESIGN_IMAGE_PIXELS = 16_000_000;
export const MAX_DESIGN_IMAGE_SOURCE_EDGE_PX = 10_000;
export const MAX_DESIGN_IMAGE_SOURCE_PIXELS = 40_000_000;
export const MAX_DESIGN_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;

export const DesignPatentSubjectSchema = z.enum(["whole-product", "partial-design"]);
export type DesignPatentSubject = z.infer<typeof DesignPatentSubjectSchema>;

export const DesignPatentExpressionSchema = z.enum(["line-drawing", "photo", "cad-render"]);
export type DesignPatentExpression = z.infer<typeof DesignPatentExpressionSchema>;

export const DesignPatentViewKindSchema = z.enum([
  "perspective",
  "front",
  "rear",
  "left",
  "right",
  "top",
  "bottom",
  "reference",
  "enlarged",
  "section",
  "other",
]);
export type DesignPatentViewKind = z.infer<typeof DesignPatentViewKindSchema>;

export const DesignPatentImageOperationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("trim"),
        left: z.number().int().nonnegative(),
        top: z.number().int().nonnegative(),
        width: z.number().int().positive().max(MAX_DESIGN_IMAGE_EDGE_PX),
        height: z.number().int().positive().max(MAX_DESIGN_IMAGE_EDGE_PX),
      })
      .strict(),
    z.object({ kind: z.literal("rotate"), degrees: z.number().min(-180).max(180) }).strict(),
    z
      .object({
        kind: z.literal("affine"),
        xSkew: z.number().min(-0.25).max(0.25),
        ySkew: z.number().min(-0.25).max(0.25),
      })
      .strict(),
    z
      .object({
        kind: z.literal("canvas"),
        width: z.number().int().positive().max(MAX_DESIGN_IMAGE_EDGE_PX),
        height: z.number().int().positive().max(MAX_DESIGN_IMAGE_EDGE_PX),
        fit: z.enum(["contain", "fill"]),
      })
      .strict(),
  ])
  .superRefine((operation, ctx) => {
    if (
      (operation.kind === "trim" || operation.kind === "canvas") &&
      operation.width * operation.height > MAX_DESIGN_IMAGE_PIXELS
    ) {
      ctx.addIssue({ code: "custom", message: "图片处理后的像素总量超过安全上限。" });
    }
  });
export type DesignPatentImageOperation = z.infer<typeof DesignPatentImageOperationSchema>;

export const DesignPatentViewSchema = z
  .object({
    viewId: z.string().uuid(),
    kind: DesignPatentViewKindSchema,
    label: z.string().trim().min(1).max(100),
    assetId: z.string().uuid(),
    expression: DesignPatentExpressionSchema,
    subjectBounds: z
      .object({
        leftPx: z.number().int().nonnegative(),
        topPx: z.number().int().nonnegative(),
        widthPx: z.number().int().positive(),
        heightPx: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    operations: z.array(DesignPatentImageOperationSchema).max(100),
    subjectBoundsSource: z.enum(["automatic", "manual"]).nullable().optional(),
    subjectBoundsConfirmed: z.boolean().optional(),
    editor: DesignEditorStateSchema.optional(),
    note: z.string().trim().max(500).nullable(),
  })
  .strict();
export type DesignPatentView = z.infer<typeof DesignPatentViewSchema>;

// All views in this workbench have a slot or supplemental role.
export function isAssignedDesignView(view: { kind: DesignPatentViewKind }): boolean {
  return DesignPatentViewKindSchema.safeParse(view.kind).success;
}

export function normalizeDesignPatentMeasurementStatus(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("views" in input) || !Array.isArray(input.views))
    return input;
  return {
    ...input,
    views: input.views.map((view: unknown) => {
      if (!view || typeof view !== "object" || !("subjectBounds" in view)) return view;
      return {
        subjectBoundsSource: view.subjectBounds ? "automatic" : null,
        subjectBoundsConfirmed: false,
        ...view,
      };
    }),
  };
}


export const DesignPatentOmissionReasonSchema = z.enum([
  "same-or-symmetric",
  "rotationally-identical",
  "flat-or-thin",
  "not-visible-during-use",
  "other",
]);

export const DesignPatentBriefSchema = z
  .object({
    productUse: z.string().trim().max(2_000),
    designPoints: z.array(z.enum(["shape", "pattern", "color"])).max(3),
    colorProtectionRequested: z.boolean(),
    omissions: z
      .array(
        z
          .object({
            viewKind: DesignPatentViewKindSchema,
            reason: DesignPatentOmissionReasonSchema,
            otherReason: z.string().trim().max(500).nullable(),
          })
          .strict(),
      )
      .max(20),
    continuousSurface: z.enum(["up-down", "left-right", "all-sides"]).nullable(),
    elongatedObjectLengthOmitted: z.boolean(),
    materialDescription: z.string().trim().max(2_000),
    partialDesignDescription: z.string().trim().max(2_000).default(""),
    excludedInteriorDescription: z.string().trim().max(2_000),
    guiDescription: z.string().trim().max(4_000),
    setDescription: z.string().trim().max(4_000),
    otherDescription: z.string().trim().max(4_000),
  })
  .strict();
export type DesignPatentBrief = z.infer<typeof DesignPatentBriefSchema>;

export const DesignPatentExportRecordSchema = z
  .object({
    exportedAt: z.string().datetime(),
    format: z.enum(["docx", "pdf"]),
    outputDirectory: z.string().min(1),
    documentPath: z.string().min(1),
    imagePaths: z.array(z.string().min(1)).max(100_000),
    zipped: z.boolean(),
    warningCodes: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();
export type DesignPatentExportRecord = z.infer<typeof DesignPatentExportRecordSchema>;

export const DesignPatentSchema = z
  .object({
    subject: DesignPatentSubjectSchema,
    primaryExpression: DesignPatentExpressionSchema.nullable(),
    representativeViewId: z.string().uuid().nullable(),
    dimensionReferenceViewId: z.string().uuid().nullable(),
    views: z.array(DesignPatentViewSchema).max(100_000),
    brief: DesignPatentBriefSchema,
    exports: z.array(DesignPatentExportRecordSchema).max(1_000),
  })
  .strict()
  .superRefine((designPatent, ctx) => {
    const viewIds = new Set<string>();
    for (const [index, view] of designPatent.views.entries()) {
      if (viewIds.has(view.viewId)) {
        ctx.addIssue({
          code: "custom",
          message: "外观设计视图编号重复。",
          path: ["views", index, "viewId"],
        });
      }
      viewIds.add(view.viewId);
    }
    for (const field of ["representativeViewId", "dimensionReferenceViewId"] as const) {
      const viewId = designPatent[field];
      if (viewId !== null && !viewIds.has(viewId)) {
        ctx.addIssue({ code: "custom", message: "所选视图不存在。", path: [field] });
      }
    }
  });
export type DesignPatent = z.infer<typeof DesignPatentSchema>;

export type DesignPatentIssueCode =
  | "missing-product-use"
  | "missing-design-point"
  | "missing-representative-view"
  | "missing-view-explanation"
  | "missing-partial-design-description"
  | "missing-omission-reason"
  | "mixed-primary-expression"
  | "subject-bounds-unavailable"
  | "view-width-mismatch"
  | "view-height-mismatch"
  | "view-depth-mismatch";

export type DesignPatentIssue = {
  severity: "warning";
  code: DesignPatentIssueCode;
  message: string;
  viewIds?: string[];
};

export function createBlankDesignPatent(): DesignPatent {
  return {
    subject: "whole-product",
    primaryExpression: null,
    representativeViewId: null,
    dimensionReferenceViewId: null,
    views: [],
    brief: {
      productUse: "",
      designPoints: [],
      colorProtectionRequested: false,
      omissions: [],
      continuousSurface: null,
      elongatedObjectLengthOmitted: false,
      materialDescription: "",
      partialDesignDescription: "",
      excludedInteriorDescription: "",
      guiDescription: "",
      setDescription: "",
      otherDescription: "",
    },
    exports: [],
  };
}

export function renderDesignPatentBriefLines(
  productName: string | null,
  designPatent: DesignPatent,
): string[] {
  const brief = designPatent.brief;
  const representativeView = designPatent.views.find(
    (view) => view.viewId === designPatent.representativeViewId,
  );
  const points = brief.designPoints.map(
    (point) => ({ shape: "形状", pattern: "图案", color: "色彩" })[point],
  );
  return [
    `产品名称：${productName ?? ""}。`,
    designPatent.subject === "partial-design" ? "本外观设计为请求保护产品的局部外观设计。" : "",
    designPatent.subject === "partial-design" && brief.partialDesignDescription
      ? `局部设计保护的部分及表示方式：${brief.partialDesignDescription}`
      : "",
    brief.productUse ? `本外观设计产品的用途：${brief.productUse}` : "",
    points.length > 0 ? `设计要点在于${points.join("和")}。` : "",
    brief.colorProtectionRequested ? "请求保护的外观设计包含色彩。" : "",
    representativeView ? `最能表明设计要点的图片或照片：${representativeView.label}。` : "",
    ...brief.omissions.map((omission) => renderDesignPatentOmission(omission)),
    brief.elongatedObjectLengthOmitted ? "本外观设计产品为细长物品，视图中省略长度。" : "",
    brief.continuousSurface
      ? `产品${{ "up-down": "上下", "left-right": "左右", "all-sides": "四周" }[brief.continuousSurface]}的设计连续变化。`
      : "",
    brief.materialDescription,
    brief.excludedInteriorDescription,
    brief.guiDescription,
    brief.setDescription,
    brief.otherDescription,
  ].filter(Boolean);
}

function renderDesignPatentOmission(omission: DesignPatent["brief"]["omissions"][number]): string {
  const view = {
    perspective: "立体图",
    front: "主视图",
    rear: "后视图",
    left: "左视图",
    right: "右视图",
    top: "俯视图",
    bottom: "仰视图",
    reference: "参考图",
    enlarged: "局部放大图",
    section: "剖视图",
    other: "其他视图",
  }[omission.viewKind];
  if (omission.reason === "same-or-symmetric") return `${view}与主视图相同或对称，省略${view}。`;
  if (omission.reason === "rotationally-identical")
    return `${view}旋转后与其他视图相同，省略${view}。`;
  if (omission.reason === "flat-or-thin") return `产品在${view}方向无设计要点，省略${view}。`;
  if (omission.reason === "not-visible-during-use")
    return `${view}在使用时不容易看到，省略${view}。`;
  return omission.otherReason ? `${omission.otherReason}，省略${view}。` : `省略${view}。`;
}

export function inspectDesignPatent(designPatent: DesignPatent): DesignPatentIssue[] {
  const issues: DesignPatentIssue[] = [];
  if (!designPatent.brief.productUse) {
    issues.push({ severity: "warning", code: "missing-product-use", message: "请填写产品用途。" });
  }
  if (designPatent.brief.designPoints.length === 0) {
    issues.push({ severity: "warning", code: "missing-design-point", message: "请选择设计要点。" });
  }
  if (designPatent.representativeViewId === null) {
    issues.push({
      severity: "warning",
      code: "missing-representative-view",
      message: "请选择最能表明设计要点的视图。",
    });
  }
  const standardViewLabels = {
    front: "主视图",
    rear: "后视图",
    left: "左视图",
    right: "右视图",
    top: "俯视图",
    bottom: "仰视图",
  } as const;
  const unexplainedMissingViews = Object.entries(standardViewLabels)
    .filter(
      ([kind]) =>
        !designPatent.views.some((view) => view.kind === kind) &&
        !designPatent.brief.omissions.some((omission) => omission.viewKind === kind),
    )
    .map(([, label]) => label);
  if (unexplainedMissingViews.length > 0) {
    issues.push({
      severity: "warning",
      code: "missing-view-explanation",
      message: `以下标准视图尚未导入，也未填写省略原因：${unexplainedMissingViews.join("、")}。`,
    });
  }
  if (designPatent.subject === "partial-design" && !designPatent.brief.partialDesignDescription) {
    issues.push({
      severity: "warning",
      code: "missing-partial-design-description",
      message: "局部设计需要说明请求保护的部分及其表示方式。",
    });
  }
  if (
    designPatent.brief.omissions.some(
      (omission) => omission.reason === "other" && !omission.otherReason?.trim(),
    )
  ) {
    issues.push({
      severity: "warning",
      code: "missing-omission-reason",
      message: "选择“其他原因”的省略视图还需要填写具体原因。",
    });
  }
  if (
    designPatent.primaryExpression !== null &&
    designPatent.views.some((view) => view.expression !== designPatent.primaryExpression)
  ) {
    issues.push({
      severity: "warning",
      code: "mixed-primary-expression",
      message: "图片表现方式与所选主表现方式不一致，请确认后继续。",
    });
  }
  const unmeasuredViewIds = designPatent.views
    .filter(
      (view) =>
        (["front", "rear", "left", "right", "top", "bottom"] as const).includes(
          view.kind as "front" | "rear" | "left" | "right" | "top" | "bottom",
        ) && view.subjectBounds === null,
    )
    .map((view) => view.viewId);
  if (unmeasuredViewIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "subject-bounds-unavailable",
      message: "部分六视图未识别到产品主体，无法完成对应的长宽高一致性检查。",
      viewIds: unmeasuredViewIds,
    });
  }
  return [
    ...issues,
    ...inspectDesignViewDimensions(
      designPatent.views,
      0.05,
      designPatent.dimensionReferenceViewId ?? undefined,
    ),
  ];
}

type DimensionCandidate =
  | Pick<DesignPatentView, "viewId" | "kind" | "subjectBounds">
  | {
      viewId: string;
      kind: DesignPatentViewKind;
      subjectWidthPx: number;
      subjectHeightPx: number;
    };

export function inspectDesignViewDimensions(
  views: readonly DimensionCandidate[],
  tolerance = 0.05,
  referenceViewId?: string,
): DesignPatentIssue[] {
  const dimensions = new Map(
    views.map((view) => [
      view.kind,
      {
        viewId: view.viewId,
        width: "subjectWidthPx" in view ? view.subjectWidthPx : view.subjectBounds?.widthPx,
        height: "subjectHeightPx" in view ? view.subjectHeightPx : view.subjectBounds?.heightPx,
      },
    ]),
  );
  return [
    compareDimensionGroup(
      "view-width-mismatch",
      "宽度",
      [
        dimensions.get("front"),
        dimensions.get("rear"),
        dimensions.get("top"),
        dimensions.get("bottom"),
      ].map((dimension) => dimension && { ...dimension, value: dimension.width }),
      tolerance,
      referenceViewId,
    ),
    compareDimensionGroup(
      "view-height-mismatch",
      "高度",
      [
        dimensions.get("front"),
        dimensions.get("rear"),
        dimensions.get("left"),
        dimensions.get("right"),
      ].map((dimension) => dimension && { ...dimension, value: dimension.height }),
      tolerance,
      referenceViewId,
    ),
    compareDimensionGroup(
      "view-depth-mismatch",
      "深度",
      [
        ...[dimensions.get("left"), dimensions.get("right")].map(
          (dimension) => dimension && { ...dimension, value: dimension.width },
        ),
        ...[dimensions.get("top"), dimensions.get("bottom")].map(
          (dimension) => dimension && { ...dimension, value: dimension.height },
        ),
      ],
      tolerance,
      referenceViewId,
    ),
  ].filter((issue): issue is DesignPatentIssue => issue !== null);
}

function compareDimensionGroup(
  code: Extract<
    DesignPatentIssueCode,
    "view-width-mismatch" | "view-height-mismatch" | "view-depth-mismatch"
  >,
  dimension: string,
  candidates: Array<{ viewId: string; value: number | undefined } | undefined>,
  tolerance: number,
  referenceViewId?: string,
): DesignPatentIssue | null {
  const measured = candidates.filter(
    (candidate): candidate is { viewId: string; value: number } =>
      candidate !== undefined && candidate.value !== undefined,
  );
  if (measured.length < 2) return null;
  const reference = measured.find((candidate) => candidate.viewId === referenceViewId);
  if (reference) {
    const compared = measured.filter((candidate) => candidate.viewId !== reference.viewId);
    const furthest = compared.reduce((current, candidate) =>
      Math.abs(candidate.value - reference.value) > Math.abs(current.value - reference.value)
        ? candidate
        : current,
    );
    const difference = Math.abs(furthest.value - reference.value) / reference.value;
    if (difference <= tolerance) return null;
    return {
      severity: "warning",
      code,
      viewIds: [reference.viewId, furthest.viewId],
      message: `${dimension}比例提示：相对所选基准视图相差 ${Math.round(difference * 100)}%，请检查裁白边、旋转透视或尺寸校准。`,
    };
  }
  const smallest = measured.reduce((current, candidate) =>
    candidate.value < current.value ? candidate : current,
  );
  const largest = measured.reduce((current, candidate) =>
    candidate.value > current.value ? candidate : current,
  );
  const difference = (largest.value - smallest.value) / largest.value;
  if (difference <= tolerance) return null;
  return {
    severity: "warning",
    code,
    viewIds: [smallest.viewId, largest.viewId],
    message: `${dimension}比例提示：视图主体尺寸相差 ${Math.round(difference * 100)}%，请检查裁白边、旋转透视或尺寸校准。`,
  };
}
