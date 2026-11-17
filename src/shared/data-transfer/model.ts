import { z } from "zod";

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonEmptyStringSchema = z.string().min(1);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDateTimeSchema = z.string().datetime();

export const DataTransferOperationIdSchema = z.string().uuid();
export type DataTransferOperationId = z.infer<typeof DataTransferOperationIdSchema>;

export const DataTransferOperationKindSchema = z.enum([
  "full-data-export",
  "full-data-import",
  "library-swap",
]);
export type DataTransferOperationKind = z.infer<typeof DataTransferOperationKindSchema>;

export const DataTransferPhaseSchema = z.enum([
  "idle",
  "inspecting",
  "quiescing-writes",
  "checkpointing",
  "collecting-data",
  "compressing",
  "encrypting",
  "verifying-package",
  "publishing-package",
  "reading-header",
  "decrypting",
  "extracting-to-staging",
  "validating-files",
  "validating-database",
  "validating-domain-data",
  "preparing-local-data",
  "preview-ready",
  "preparing-swap",
  "swapping",
  "restart-pending",
  "post-start-validation",
  "completed",
  "cancelled",
  "failed",
]);
export type DataTransferPhase = z.infer<typeof DataTransferPhaseSchema>;

export const DataTransferProgressSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    kind: DataTransferOperationKindSchema,
    phase: DataTransferPhaseSchema,
    completedBytes: NonNegativeIntegerSchema,
    totalBytes: NonNegativeIntegerSchema.nullable(),
    currentCategory: z.enum(["database", "assets", "settings", "verification", "switching"]),
    elapsedMs: NonNegativeIntegerSchema,
    remainingMs: NonNegativeIntegerSchema.nullable(),
    cancellable: z.boolean(),
  })
  .strict()
  .readonly();
export type DataTransferProgress = z.infer<typeof DataTransferProgressSchema>;

const CurrentDataTransferLibrarySummarySchema = z
  .object({
    activePatents: NonNegativeIntegerSchema,
    trashedPatents: NonNegativeIntegerSchema,
    documents: NonNegativeIntegerSchema,
    legacyDrafts: NonNegativeIntegerSchema,
    snapshots: NonNegativeIntegerSchema,
    assets: NonNegativeIntegerSchema,
    flowchartProjects: NonNegativeIntegerSchema,

    totalBytes: NonNegativeIntegerSchema,
  })
  .strict()
  .readonly();
export const DataTransferLibrarySummarySchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) return input;
  const { scientificChartProjects: _retiredCount, ...summary } = input as Record<string, unknown>;
  return summary;
}, CurrentDataTransferLibrarySummarySchema);
export type DataTransferLibrarySummary = z.infer<typeof DataTransferLibrarySummarySchema>;

const DataTransferLibraryBlockerSchema = z
  .object({
    kind: z.enum([
      "patents",
      "documents",
      "legacy-drafts",
      "snapshots",
      "edit-logs",
      "assets",
      "projects",
      "library-state",
      "pending-operation",
      "unknown-files",
      "unreadable-library",
    ]),
    count: NonNegativeIntegerSchema,
  })
  .strict()
  .readonly();

export const DataTransferLibraryInspectionSchema = z
  .object({
    empty: z.boolean(),
    blockers: z.array(DataTransferLibraryBlockerSchema).readonly(),
    summary: DataTransferLibrarySummarySchema,
  })
  .strict()
  .readonly();
export type DataTransferLibraryInspection = z.infer<typeof DataTransferLibraryInspectionSchema>;

export const TransferDestinationSelectionSchema = z
  .object({
    selectionId: NonEmptyStringSchema,
    displayPath: NonEmptyStringSchema,
    suggestedFileName: NonEmptyStringSchema,
  })
  .strict()
  .readonly();
export type TransferDestinationSelection = z.infer<typeof TransferDestinationSelectionSchema>;

export const TransferSourceSelectionSchema = z
  .object({
    selectionId: NonEmptyStringSchema,
    fileName: NonEmptyStringSchema,
    sizeBytes: NonNegativeIntegerSchema,
    packageFormatVersion: NonNegativeIntegerSchema,
    minimumImporterVersion: NonEmptyStringSchema,
    passwordHint: z.string().nullable(),
  })
  .strict()
  .readonly();
export type TransferSourceSelection = z.infer<typeof TransferSourceSelectionSchema>;

export const FullDataExportRequestSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    destinationSelectionId: NonEmptyStringSchema,
    password: NonEmptyStringSchema,
    passwordHint: z.string().nullable(),
    passwordRecorded: z.literal(true),
  })
  .strict()
  .readonly();
export type FullDataExportRequest = z.infer<typeof FullDataExportRequestSchema>;

export const FullDataExportResultSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    displayPath: NonEmptyStringSchema,
    sizeBytes: NonNegativeIntegerSchema,
    cutoffAt: IsoDateTimeSchema,
    packageFormatVersion: z.literal(2),
    summary: DataTransferLibrarySummarySchema,
    fullVerificationPassed: z.literal(true),
  })
  .strict()
  .readonly();
export type FullDataExportResult = z.infer<typeof FullDataExportResultSchema>;

export const FullDataImportPrepareRequestSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    sourceSelectionId: NonEmptyStringSchema,
    password: NonEmptyStringSchema,
  })
  .strict()
  .readonly();
export type FullDataImportPrepareRequest = z.infer<typeof FullDataImportPrepareRequestSchema>;

export const FullDataImportPreviewSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    packageId: z.string().uuid(),
    exportedAt: IsoDateTimeSchema,
    summary: DataTransferLibrarySummarySchema,
    packageVerified: z.literal(true),
    versionCompatible: z.literal(true),
    targetLibraryEmpty: z.literal(true),
    settingsRequiringSetup: z
      .tuple([z.literal("backup-folder"), z.literal("ai-credentials"), z.literal("printer")])
      .readonly(),
  })
  .strict()
  .readonly();
export type FullDataImportPreview = z.infer<typeof FullDataImportPreviewSchema>;

export const FullDataImportCommitRequestSchema = z
  .object({
    operationId: DataTransferOperationIdSchema,
    acknowledgedEmptyLibraryAndRestart: z.literal(true),
  })
  .strict()
  .readonly();
export type FullDataImportCommitRequest = z.infer<typeof FullDataImportCommitRequestSchema>;

export const TransferManifestEntrySchema = z
  .object({
    ordinal: NonNegativeIntegerSchema,
    logicalPath: NonEmptyStringSchema,
    kind: z.enum([
      "database",
      "asset",
      "legacy-draft",
      "text-polish-history",
      "settings",
      "verification",
    ]),
    compression: z.enum(["stored", "deflate-raw"]),
    originalBytes: NonNegativeIntegerSchema,
    compressedBytes: NonNegativeIntegerSchema,
    sha256: Sha256Schema,
    chunkCount: NonNegativeIntegerSchema,
  })
  .strict()
  .readonly();
export type TransferManifestEntry = z.infer<typeof TransferManifestEntrySchema>;

export const TransferManifestSchema = z
  .object({
    packageFormatVersion: z.literal(2),
    packageId: z.string().uuid(),
    exportedByVersion: NonEmptyStringSchema,
    minimumImporterVersion: NonEmptyStringSchema,
    databaseSchemaVersion: NonNegativeIntegerSchema,
    databaseSchemaFingerprint: NonEmptyStringSchema,
    canonicalPatentFormatVersion: NonNegativeIntegerSchema,
    exportedAt: IsoDateTimeSchema,
    cutoffAt: IsoDateTimeSchema,
    summary: DataTransferLibrarySummarySchema,
    entries: z.array(TransferManifestEntrySchema).readonly(),
    portableSettingKeys: z.array(z.string()).readonly(),
    excludedMachineSettingCategories: z.array(z.string()).readonly(),
    totalOriginalBytes: NonNegativeIntegerSchema,
    totalChunkCount: NonNegativeIntegerSchema,
    payloadSha256: Sha256Schema,
  })
  .strict()
  .readonly();
export type TransferManifest = z.infer<typeof TransferManifestSchema>;
