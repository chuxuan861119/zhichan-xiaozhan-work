import { z } from "zod";

export const BackupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    folder: z.string().min(1).max(32_767).nullable(),
    intervalMinutes: z.number().int().min(1).max(1440),
    waitOnExit: z.boolean().optional(),
  })
  .strict();
export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

export const BackupConfigureRequestSchema = BackupSettingsSchema.extend({
  migrateExisting: z.boolean().optional(),
  expectedSourceFolder: z.string().nullable().optional(),
});
export type BackupConfigureRequest = z.infer<typeof BackupConfigureRequestSchema>;
export const BackupMigrationReportSchema = z
  .object({
    migratedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    retainedSourceCount: z.number().int().nonnegative(),
  })
  .strict();
export type BackupMigrationReport = z.infer<typeof BackupMigrationReportSchema>;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  folder: null,
  intervalMinutes: 5,
};

export const BACKUP_INTERVAL_OPTIONS = [
  { value: 1, label: "每 1 分钟" },
  { value: 3, label: "每 3 分钟" },
  { value: 5, label: "每 5 分钟" },
  { value: 10, label: "每 10 分钟" },
  { value: 15, label: "每 15 分钟" },
  { value: 30, label: "每 30 分钟" },
] as const;

export const BackupDocumentTypeSchema = z.enum(["library_document", "patent"]);
export type BackupDocumentType = z.infer<typeof BackupDocumentTypeSchema>;

export const BackupTriggerSchema = z.enum([
  "scheduled",
  "idle",
  "patent-close",
  "application-close",
  "manual",
]);
export type BackupTrigger = z.infer<typeof BackupTriggerSchema>;

export const BackupTargetSchema = z
  .object({
    documentType: BackupDocumentTypeSchema,
    documentId: z.string().uuid(),
  })
  .strict();
export type BackupTarget = z.infer<typeof BackupTargetSchema>;

export const BackupRunFailureSchema = z
  .object({
    target: BackupTargetSchema,
    displayName: z.string().min(1).max(500),
    message: z.string().min(1).max(2_000),
  })
  .strict();
export type BackupRunFailure = z.infer<typeof BackupRunFailureSchema>;

export const BackupRunResultSchema = z
  .object({
    trigger: BackupTriggerSchema,
    attemptedCount: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failures: z.array(BackupRunFailureSchema),
    cancelled: z.boolean(),
    completedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.successCount + value.failures.length !== value.attemptedCount) {
      context.addIssue({ code: "custom", message: "备份结果数量不一致" });
    }
  });
export type BackupRunResult = z.infer<typeof BackupRunResultSchema>;

export const BackupOperationStatusSchema = z
  .object({
    running: z.boolean(),
    trigger: BackupTriggerSchema.nullable(),
    totalCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    currentDisplayName: z.string().min(1).max(500).nullable(),
    cancelRequested: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completedCount > value.totalCount) {
      context.addIssue({ code: "custom", message: "备份进度不一致" });
    }
    if (!value.running && (value.trigger !== null || value.currentDisplayName !== null)) {
      context.addIssue({ code: "custom", message: "空闲备份不应暴露运行对象" });
    }
  });
export type BackupOperationStatus = z.infer<typeof BackupOperationStatusSchema>;

export const BackupEnsureCurrentRequestSchema = BackupTargetSchema;
export type BackupEnsureCurrentRequest = z.infer<typeof BackupEnsureCurrentRequestSchema>;

export const BackupFinalizationRequestSchema = z.object({}).strict();

export const BackupEntryStatusSchema = z.enum(["healthy", "damaged"]);
export type BackupEntryStatus = z.infer<typeof BackupEntryStatusSchema>;

export const BackupEntrySchema = z
  .object({
    fileName: z.string().min(1).max(255),
    displayName: z.string().min(1).max(500),
    documentType: BackupDocumentTypeSchema.nullable(),
    documentId: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    backedUpAt: z.string().datetime(),
    managed: z.boolean(),
    status: BackupEntryStatusSchema,
    errorMessage: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type BackupEntry = z.infer<typeof BackupEntrySchema>;

export const BackupStatusSchema = z
  .object({
    enabled: z.boolean(),
    folder: z.string().nullable(),
    intervalMinutes: z.number().int(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastBackupAt: z.string().datetime().nullable(),
    nextBackupAt: z.string().datetime().nullable(),
    lastRunSuccessCount: z.number().int().nonnegative(),
    lastRunFailureCount: z.number().int().nonnegative(),
    lastError: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const BackupRestoreResultSchema = z
  .object({
    documentType: BackupDocumentTypeSchema,
    documentId: z.string().min(1),
    displayName: z.string().min(1).max(500),
    warning: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type BackupRestoreResult = z.infer<typeof BackupRestoreResultSchema>;
