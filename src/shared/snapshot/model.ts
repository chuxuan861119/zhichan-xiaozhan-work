import { z } from "zod";
import { ImageRotationSchema, PatentBookDocumentSchema } from "../document/model.js";
import { PatentBookKindSchema } from "../patent/model.js";

export const SnapshotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.union([
      z.literal(3),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
  })
  .strict();
export type SnapshotSettings = z.infer<typeof SnapshotSettingsSchema>;

export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotSettings = {
  enabled: true,
  intervalMinutes: 5,
};

export const SNAPSHOT_INTERVAL_OPTIONS = [
  { value: 3, label: "每 3 分钟" },
  { value: 5, label: "每 5 分钟" },
  { value: 10, label: "每 10 分钟" },
  { value: 15, label: "每 15 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 60, label: "每 60 分钟" },
] as const;

export const SnapshotSourceSchema = z.enum([
  "initial",
  "automatic",
  "manual-save",
  "manual-create",
  "patent-close",
  "application-close",
  "historical",
]);
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;

export const ExplicitSnapshotSourceSchema = z.enum([
  "manual-save",
  "manual-create",
  "patent-close",
  "application-close",
]);
export type ExplicitSnapshotSource = z.infer<typeof ExplicitSnapshotSourceSchema>;

// Reserved for the source-aware snapshot service; the current create IPC still returns void.
export const SnapshotCreationResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("created"),
      revision: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
      source: SnapshotSourceSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("already-exists"),
      revision: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
      source: SnapshotSourceSchema,
    })
    .strict(),
]);
export type SnapshotCreationResult = z.infer<typeof SnapshotCreationResultSchema>;

export const SnapshotDeletionResultSchema = z
  .object({
    cleanupError: z.string().max(2000).nullable(),
  })
  .strict();
export type SnapshotDeletionResult = z.infer<typeof SnapshotDeletionResultSchema>;

export const SnapshotDocumentTypeSchema = z.enum(["library_document", "patent"]);
export type SnapshotDocumentType = z.infer<typeof SnapshotDocumentTypeSchema>;

export const SnapshotBookSummarySchema = z
  .object({
    kind: PatentBookKindSchema,
    characterCount: z.number().int().nonnegative(),
    preview: z.string().max(160),
  })
  .strict();
export type SnapshotBookSummary = z.infer<typeof SnapshotBookSummarySchema>;

export const SnapshotContentSummarySchema = z
  .object({
    books: z.array(SnapshotBookSummarySchema).length(5),
    figureCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    flowchartCount: z.number().int().nonnegative(),

    referenceMarkCount: z.number().int().nonnegative(),
  })
  .strict();
export type SnapshotContentSummary = z.infer<typeof SnapshotContentSummarySchema>;

export const SnapshotContentPreviewRequestSchema = z
  .object({
    documentType: z.literal("patent"),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type SnapshotContentPreviewRequest = z.infer<typeof SnapshotContentPreviewRequestSchema>;

export const SnapshotPreviewAssetRequestSchema = SnapshotContentPreviewRequestSchema.extend({
  assetId: z.string().uuid(),
}).strict();
export type SnapshotPreviewAssetRequest = z.infer<typeof SnapshotPreviewAssetRequestSchema>;

export const SnapshotPreviewBookSchema = z
  .object({
    kind: PatentBookKindSchema,
    document: PatentBookDocumentSchema,
  })
  .strict();
export type SnapshotPreviewBook = z.infer<typeof SnapshotPreviewBookSchema>;

export const SnapshotPreviewFigureSchema = z
  .object({
    figureId: z.string().uuid(),
    assetId: z.string().uuid(),
    widthMm: z.number().positive(),
    // 向后兼容：旧快照预览没有记录附图旋转角度。
    rotationDeg: ImageRotationSchema.optional(),
  })
  .strict();
export type SnapshotPreviewFigure = z.infer<typeof SnapshotPreviewFigureSchema>;

export const SnapshotPreviewVersionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    books: z.array(SnapshotPreviewBookSchema).length(5),
    auxiliaryDocuments: z
      .array(
        z
          .object({
            auxiliaryDocumentId: z.string().uuid(),
            title: z.string().min(1).max(200),
            document: PatentBookDocumentSchema,
          })
          .strict(),
      )
      .optional(),
    // 向后兼容：旧快照没有附图字段，缺省为空数组。
    figures: z.array(SnapshotPreviewFigureSchema).optional(),
    abstractDrawingFigureId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type SnapshotPreviewVersion = z.infer<typeof SnapshotPreviewVersionSchema>;

export const SnapshotContentPreviewSchema = z
  .object({
    current: SnapshotPreviewVersionSchema,
    baseline: SnapshotPreviewVersionSchema.nullable(),
    comparison: z.enum(["compared", "initial", "no-readable-baseline"]),
    skippedRevisions: z.array(z.number().int().nonnegative()),
  })
  .strict();
export type SnapshotContentPreview = z.infer<typeof SnapshotContentPreviewSchema>;

export const SnapshotEntrySchema = z
  .object({
    documentType: SnapshotDocumentTypeSchema,
    documentId: z.string().min(1),
    displayName: z.string().min(1).max(500),
    revision: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    source: SnapshotSourceSchema,
    status: z.enum(["healthy", "resource-missing", "damaged"]),
    errorMessage: z.string().min(1).max(2_000).nullable(),
    deletable: z.boolean(),
    contentSummary: SnapshotContentSummarySchema.nullable(),
  })
  .strict();
export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

export const SnapshotListWarningSchema = z
  .object({
    documentType: SnapshotDocumentTypeSchema,
    documentId: z.string().min(1),
    displayName: z.string().min(1).max(500),
    message: z.string().min(1).max(2_000),
  })
  .strict();
export type SnapshotListWarning = z.infer<typeof SnapshotListWarningSchema>;

export const SnapshotListResultSchema = z
  .object({
    entries: z.array(SnapshotEntrySchema),
    warnings: z.array(SnapshotListWarningSchema),
  })
  .strict();
export type SnapshotListResult = z.infer<typeof SnapshotListResultSchema>;

export const SnapshotCreateRequestSchema = z
  .object({
    documentType: SnapshotDocumentTypeSchema,
    documentId: z.string().min(1),
    source: ExplicitSnapshotSourceSchema,
  })
  .strict();
export type SnapshotCreateRequest = z.infer<typeof SnapshotCreateRequestSchema>;

export const SnapshotRestoreRequestSchema = z
  .object({
    documentType: SnapshotDocumentTypeSchema,
    documentId: z.string().min(1),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type SnapshotRestoreRequest = z.infer<typeof SnapshotRestoreRequestSchema>;

export const SnapshotStatusSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: SnapshotSettingsSchema.shape.intervalMinutes,
    openPatentCount: z.number().int().nonnegative(),
    lastCheckAt: z.string().datetime().nullable(),
    lastAutomaticSnapshotAt: z.string().datetime().nullable(),
    nextCheckAt: z.string().datetime().nullable(),
    lastError: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type SnapshotStatus = z.infer<typeof SnapshotStatusSchema>;
