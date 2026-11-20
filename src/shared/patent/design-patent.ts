import { z } from "zod";
import {
  DesignBriefDetailsSchema,
  designPointSentence,
  getDesignBriefDetails,
  getDesignProductName,
  inspectAdvancedBrief,
  renderAdvancedBriefLines,
} from "./design-brief-details.js";
import { DesignEditorStateSchema } from "./design-editor-state.js";
import {
  ORTHOGRAPHIC_LABELS,
  type OrthographicKind,
  resolveOmissionSource,
} from "./design-view-omissions.js";

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
  "perspective-2",
  "perspective-3",
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
  "unassigned",
  "multi-image",
]);
export type DesignPatentViewKind = z.infer<typeof DesignPatentViewKindSchema>;

const UNIQUE_PRIMARY_VIEW_KINDS = new Set<DesignPatentViewKind>([
  "perspective",
  "perspective-2",
  "perspective-3",
  "front",
  "rear",
  "left",
  "right",
  "top",
  "bottom",
]);

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
    subjectBoundsSource: z.enum(["automatic", "manual"]).nullable(),
    subjectBoundsConfirmed: z.boolean(),
    assignmentStatus: z.enum(["confirmed", "pending-auto"]).optional(),
    assignmentEvidence: z.string().trim().min(1).max(200).nullable().optional(),
    operations: z.array(DesignPatentImageOperationSchema).max(100),
    editor: DesignEditorStateSchema.optional(),
    note: z.string().trim().max(500).nullable(),
  })
  .strict();
export type DesignPatentView = z.infer<typeof DesignPatentViewSchema>;

/** Fixed slots and explicit multi-mode pictures participate; holding images never do. */
export function isAssignedDesignView<T extends { kind: DesignPatentViewKind }>(
  view: T,
): view is T & { kind: DesignPatentPrimarySlot | "multi-image" } {
  return view.kind === "multi-image" || UNIQUE_PRIMARY_VIEW_KINDS.has(view.kind);
}

/** Adds missing v11/v12 design view fields to legacy local state without validating it. */
export function normalizeDesignPatentMeasurementStatus(input: unknown): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray((input as { views?: unknown }).views)
  ) {
    return input;
  }
  const designPatent = input as Record<string, unknown>;
  return {
    ...designPatent,
    views: (designPatent.views as unknown[]).map((view) => {
      if (typeof view !== "object" || view === null) return view;
      const record = view as Record<string, unknown>;
      const hasSource = Object.hasOwn(record, "subjectBoundsSource");
      const hasConfirmation = Object.hasOwn(record, "subjectBoundsConfirmed");
      const hasAssignmentStatus = Object.hasOwn(record, "assignmentStatus");
      const hasAssignmentEvidence = Object.hasOwn(record, "assignmentEvidence");
      if (hasSource && hasConfirmation && hasAssignmentStatus && hasAssignmentEvidence)
        return record;
      const hasBounds = record.subjectBounds !== null && record.subjectBounds !== undefined;
      return {
        ...record,
        ...(hasSource ? {} : { subjectBoundsSource: hasBounds ? "automatic" : null }),
        ...(hasConfirmation ? {} : { subjectBoundsConfirmed: false }),
        ...(hasAssignmentStatus ? {} : { assignmentStatus: "confirmed" }),
        ...(hasAssignmentEvidence ? {} : { assignmentEvidence: null }),
      };
    }),
  };
}

export const DesignPatentOmissionReasonSchema = z.enum([
  "same",
  "symmetric",
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
            referenceKind: z.enum(["front", "rear", "left", "right", "top", "bottom"]).optional(),
            rotationDegrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
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
    details: DesignBriefDetailsSchema.optional(),
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
    imageMode: z.enum(["six-view", "multi-image"]).optional(),
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
    const primaryViewKinds = new Set<DesignPatentViewKind>();
    for (const [index, view] of designPatent.views.entries()) {
      if ((designPatent.imageMode === "multi-image") !== (view.kind === "multi-image")) {
        ctx.addIssue({
          code: "custom",
          message: "图片类型与当前组织模式不一致。",
          path: ["views", index, "kind"],
        });
      }
      if (viewIds.has(view.viewId)) {
        ctx.addIssue({
          code: "custom",
          message: "外观设计视图编号重复。",
          path: ["views", index, "viewId"],
        });
      }
      viewIds.add(view.viewId);
      if (UNIQUE_PRIMARY_VIEW_KINDS.has(view.kind)) {
        if (primaryViewKinds.has(view.kind)) {
          ctx.addIssue({
            code: "custom",
            message: "立体图和六个标准视图的类型不能重复。",
            path: ["views", index, "kind"],
          });
        }
        primaryViewKinds.add(view.kind);
      }
      if (
        view.subjectBounds === null &&
        (view.subjectBoundsSource !== null || view.subjectBoundsConfirmed)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "未识别产品主体时不能保留测量来源或确认状态。",
          path: ["views", index, "subjectBounds"],
        });
      }
      if (view.subjectBoundsSource === "automatic" && view.subjectBoundsConfirmed) {
        ctx.addIssue({
          code: "custom",
          message: "自动识别的产品主体边界需要人工确认。",
          path: ["views", index, "subjectBoundsConfirmed"],
        });
      }
      if (view.subjectBoundsConfirmed && view.subjectBoundsSource !== "manual") {
        ctx.addIssue({
          code: "custom",
          message: "确认的产品主体边界必须是人工测量结果。",
          path: ["views", index, "subjectBoundsSource"],
        });
      }
      if (view.assignmentStatus === undefined || view.assignmentEvidence === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "外观图片缺少分配确认状态。",
          path: ["views", index, "assignmentStatus"],
        });
      }
      if (view.assignmentStatus === "pending-auto" && view.assignmentEvidence === null) {
        ctx.addIssue({
          code: "custom",
          message: "自动匹配待确认的图片必须保留目标视图和识别依据。",
          path: ["views", index, "assignmentStatus"],
        });
      }
      if (view.assignmentStatus === "confirmed" && view.assignmentEvidence !== null) {
        ctx.addIssue({
          code: "custom",
          message: "已确认的图片不能保留自动匹配依据。",
          path: ["views", index, "assignmentEvidence"],
        });
      }
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
  | "missing-images"
  | "missing-product-use"
  | "missing-design-point"
  | "missing-representative-view"
  | "missing-view-explanation"
  | "missing-partial-design-description"
  | "invalid-design-color"
  | "invalid-design-brief-text"
  | "invalid-design-group"
  | "incomplete-gui-brief"
  | "invalid-brief-combination"
  | "missing-omission-reason"
  | "invalid-view-omission"
  | "unassigned-images"
  | "subject-bounds-unavailable"
  | "subject-bounds-unconfirmed"
  | "view-width-mismatch"
  | "view-height-mismatch"
  | "view-depth-mismatch";

export type DesignPatentIssue = {
  severity: "warning";
  code: DesignPatentIssueCode;
  message: string;
  viewIds?: string[];
};

export type DesignPatentPrimarySlot = Extract<
  DesignPatentViewKind,
  | "perspective"
  | "perspective-2"
  | "perspective-3"
  | "front"
  | "rear"
  | "left"
  | "right"
  | "top"
  | "bottom"
>;

const DESIGN_VIEW_FILENAME_MARKERS: ReadonlyArray<
  readonly [DesignPatentPrimarySlot, readonly RegExp[]]
> = [
  ["perspective-2", [/立体图\s*(?:2|二)/u, /透视图\s*(?:2|二)/u, /\bperspective\s*(?:2|two)\b/u]],
  ["perspective-3", [/立体图\s*(?:3|三)/u, /透视图\s*(?:3|三)/u, /\bperspective\s*(?:3|three)\b/u]],
  [
    "perspective",
    [
      /立体图(?!\s*(?:2|3|二|三))/u,
      /透视图(?!\s*(?:2|3|二|三))/u,
      /\bperspective(?!\s*(?:2|3|two|three)\b)(?:\s*(?:1|one))?\b/u,
    ],
  ],
  ["front", [/主视图/u, /正视图/u, /\bfront(?:\s*view)?\b/u]],
  ["rear", [/后视图/u, /背视图/u, /\b(?:rear|back)(?:\s*view)?\b/u]],
  ["left", [/左视图/u, /\bleft(?:\s*view)?\b/u]],
  ["right", [/右视图/u, /\bright(?:\s*view)?\b/u]],
  ["top", [/俯视图/u, /顶视图/u, /\btop(?:\s*view)?\b/u]],
  ["bottom", [/仰视图/u, /底视图/u, /\bbottom(?:\s*view)?\b/u]],
];

export function inferDesignPatentViewKindFromFilename(
  filename: string,
): DesignPatentPrimarySlot | null {
  const normalized = filename
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\.[^.]+$/u, "")
    .replace(/[_\-()[\]{}（）【】]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const matches = DESIGN_VIEW_FILENAME_MARKERS.filter(([, patterns]) =>
    patterns.some((pattern) => pattern.test(normalized)),
  ).map(([kind]) => kind);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

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
    (view) => view.viewId === designPatent.representativeViewId && isAssignedDesignView(view),
  );
  const details = getDesignBriefDetails(brief);
  return [
    `产品名称：${getDesignProductName(productName, brief)}。`,
    designPatent.subject === "partial-design" ? "本外观设计为请求保护产品的局部外观设计。" : "",
    designPatent.subject === "partial-design" && brief.partialDesignDescription.trim()
      ? `局部设计保护的部分及表示方式：${brief.partialDesignDescription.trim()}`
      : "",
    brief.productUse.trim() ? `本外观设计产品的用途：${brief.productUse.trim()}` : "",
    designPointSentence(designPatent),
    brief.colorProtectionRequested ? "请求保护的外观设计包含色彩。" : "",
    representativeView ? `最能表明设计要点的图片或照片：${representativeView.label}。` : "",
    ...brief.omissions.map((omission) => renderDesignPatentOmission(omission)),
    brief.elongatedObjectLengthOmitted ? "本外观设计产品为细长物品，视图中省略长度。" : "",
    brief.continuousSurface
      ? `本外观设计产品中的单元图案${{ "up-down": "上下两方连续", "left-right": "左右两方连续", "all-sides": "四方连续" }[brief.continuousSurface]}，无特定边界。`
      : "",
    brief.materialDescription,
    brief.excludedInteriorDescription,
    ...renderAdvancedBriefLines(designPatent),
    !brief.details || details.gui.kind !== "none" ? brief.guiDescription : "",
    !brief.details || ["set", "component"].includes(details.applicationType)
      ? brief.setDescription
      : "",
    brief.otherDescription,
  ]
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderDesignPatentOmission(omission: DesignPatent["brief"]["omissions"][number]): string {
  const view = {
    perspective: "立体图",
    "perspective-2": "立体图2",
    "perspective-3": "立体图3",
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
    unassigned: "暂存图片",
    "multi-image": "图片",
  }[omission.viewKind];
  if (omission.reason === "same" || omission.reason === "symmetric") {
    const reference = omission.referenceKind
      ? ORTHOGRAPHIC_LABELS[omission.referenceKind]
      : "未指定视图";
    return `${view}与${reference}${omission.reason === "same" ? "相同" : "对称"}，省略${view}。`;
  }
  if (omission.reason === "same-or-symmetric") return `${view}与主视图相同或对称，省略${view}。`;
  if (omission.reason === "rotationally-identical")
    return omission.referenceKind && omission.rotationDegrees
      ? `${view}顺时针旋转${omission.rotationDegrees}°后与${ORTHOGRAPHIC_LABELS[omission.referenceKind]}相同，省略${view}。`
      : `${view}旋转后与其他视图相同，省略${view}。`;
  if (omission.reason === "flat-or-thin") return `产品在${view}方向无设计要点，省略${view}。`;
  if (omission.reason === "not-visible-during-use")
    return `${view}在使用时不容易看到，省略${view}。`;
  return omission.otherReason ? `${omission.otherReason}，省略${view}。` : `省略${view}。`;
}

export function inspectDesignPatent(
  designPatent: DesignPatent,
  productName?: string | null,
): DesignPatentIssue[] {
  const issues: DesignPatentIssue[] = [];
  if (
    productName !== undefined &&
    !getDesignProductName(productName, designPatent.brief) &&
    designPatent.brief.details?.productName == null
  ) {
    issues.push({
      severity: "warning",
      code: "invalid-design-brief-text",
      message: "请填写外观设计产品名称，并与请求书中的产品名称保持一致。",
    });
  }
  if (!designPatent.brief.productUse.trim()) {
    issues.push({ severity: "warning", code: "missing-product-use", message: "请填写产品用途。" });
  }
  if (!designPointSentence(designPatent)) {
    issues.push({ severity: "warning", code: "missing-design-point", message: "请选择设计要点。" });
  }
  const representativeView = designPatent.views.find(
    (view) => view.viewId === designPatent.representativeViewId && isAssignedDesignView(view),
  );
  if (!representativeView) {
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
  const details = getDesignBriefDetails(designPatent.brief);
  const standardSixViews =
    details.productForm === "solid" &&
    details.applicationType === "single" &&
    (details.gui.kind === "none" || details.gui.scope === "interface-and-product");
  if (
    designPatent.imageMode !== "multi-image" &&
    standardSixViews &&
    unexplainedMissingViews.length > 0
  ) {
    issues.push({
      severity: "warning",
      code: "missing-view-explanation",
      message: `以下标准视图尚未导入，也未填写省略原因：${unexplainedMissingViews.join("、")}。`,
    });
  }
  issues.push(...inspectAdvancedBrief(designPatent, productName));
  if (designPatent.imageMode === "multi-image") {
    if (!designPatent.views.length)
      issues.push({
        severity: "warning",
        code: "missing-images",
        message: "请导入需要提交的图片。",
      });
    return issues;
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
  const omissionProblems: string[] = [];
  for (const omission of designPatent.brief.omissions) {
    const name = ORTHOGRAPHIC_LABELS[omission.viewKind as OrthographicKind] ?? omission.viewKind;
    const invalid =
      ["same", "symmetric"].includes(omission.reason) &&
      !resolveOmissionSource(designPatent, omission.viewKind);
    const conflict = designPatent.views.some((view) => view.kind === omission.viewKind);
    if (invalid || conflict)
      omissionProblems.push(
        invalid
          ? `${name}省略引用失效，请分配对应的真实来源图片，或修改省略方式。`
          : `${name}已上传图片但仍声明省略，请取消省略或移走图片。`,
      );
    if (
      omission.reason === "rotationally-identical" &&
      (!omission.rotationDegrees ||
        !omission.referenceKind ||
        !designPatent.views.some((view) => view.kind === omission.referenceKind))
    ) {
      omissionProblems.push(`${name}旋转省略需指定旋转角度和已上传的对应视图。`);
    }
    if (omission.reason === "same-or-symmetric" || omission.reason === "flat-or-thin")
      omissionProblems.push(
        `${name}使用历史省略原因，请核对实际相同、对称关系或使用时不可见的情况。`,
      );
  }
  if (omissionProblems.length)
    issues.push({
      severity: "warning",
      code: "invalid-view-omission",
      message: omissionProblems.join(" "),
    });
  const unassignedViewIds = designPatent.views
    .filter((view) => !isAssignedDesignView(view))
    .map((view) => view.viewId);
  if (unassignedViewIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "unassigned-images",
      message: `暂存区还有 ${unassignedViewIds.length} 张图片未分配，导出时将不会包含这些图片。`,
      viewIds: unassignedViewIds,
    });
  }
  if (!standardSixViews) return issues;
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
  const unconfirmedViewIds = designPatent.views
    .filter(
      (view) =>
        (["front", "rear", "left", "right", "top", "bottom"] as const).includes(
          view.kind as "front" | "rear" | "left" | "right" | "top" | "bottom",
        ) &&
        view.subjectBounds !== null &&
        !(view.subjectBoundsSource === "manual" && view.subjectBoundsConfirmed),
    )
    .map((view) => view.viewId);
  if (unconfirmedViewIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "subject-bounds-unconfirmed",
      message: "部分六视图的产品主体边界尚未完成人工确认，请确认后再核对长宽高一致性。",
      viewIds: unconfirmedViewIds,
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
