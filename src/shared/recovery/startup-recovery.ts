import { z } from "zod";

export const PreviousShutdownStatusSchema = z.enum(["first-run", "clean", "unclean", "unknown"]);
export type PreviousShutdownStatus = z.infer<typeof PreviousShutdownStatusSchema>;
export const DataImportRecoveryStatusSchema = z.enum([
  "none",
  "abandoned",
  "rolled-back",
  "recovered",
  "manual-safe-recovery",
]);
export type DataImportRecoveryStatus = z.infer<typeof DataImportRecoveryStatusSchema>;
export const LibraryInitializationFailureSchema = z.enum([
  "incomplete-library",
  "invalid-library-root",
  "backup-failed",
  "migration-failed",
  "validation-failed",
  "unknown",
]);
export type LibraryInitializationFailure = z.infer<typeof LibraryInitializationFailureSchema>;
export const StartupRecoveryReportSchema = z
  .object({
    previousShutdown: PreviousShutdownStatusSchema,
    mode: z.enum(["read-write", "read-only"]),
    replayedEditCount: z.number().int().nonnegative(),
    recoveredPatentCount: z.number().int().nonnegative(),
    quarantinedPatentCount: z.number().int().nonnegative(),
    backupCreated: z.boolean(),
    recoverySourcesUnavailable: z.boolean().optional(),
    libraryInitializationFailure: LibraryInitializationFailureSchema.optional(),
    historyCleanupPendingCount: z.number().int().nonnegative().optional(),
    assetIsolationPending: z.boolean().optional(),
    dataImportRecovery: DataImportRecoveryStatusSchema.optional(),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type StartupRecoveryReport = z.infer<typeof StartupRecoveryReportSchema>;

type RecoverySummarySource = {
  mode: "read-write" | "read-only";
  recoveredPatentIds: readonly string[];
  quarantinedPatentIds: readonly string[];
  replayedEditCount: number;
  backupPath: string | null;
  historyCleanupPendingPatentIds?: readonly string[];
  assetIsolationPending?: boolean;
};

export function createStartupRecoveryReport(input: {
  previousShutdown: PreviousShutdownStatus;
  recovery: RecoverySummarySource;
  dataImportRecovery?: DataImportRecoveryStatus;
  checkedAt: string;
}): StartupRecoveryReport {
  return StartupRecoveryReportSchema.parse({
    previousShutdown: input.previousShutdown,
    mode: input.recovery.mode,
    replayedEditCount: input.recovery.replayedEditCount,
    recoveredPatentCount: input.recovery.recoveredPatentIds.length,
    quarantinedPatentCount: input.recovery.quarantinedPatentIds.length,
    backupCreated: input.recovery.backupPath !== null,
    ...(input.recovery.historyCleanupPendingPatentIds?.length
      ? { historyCleanupPendingCount: input.recovery.historyCleanupPendingPatentIds.length }
      : {}),
    ...(input.recovery.assetIsolationPending ? { assetIsolationPending: true } : {}),
    ...(input.dataImportRecovery ? { dataImportRecovery: input.dataImportRecovery } : {}),
    checkedAt: input.checkedAt,
  });
}

/** Initialization did not establish a usable runtime; no recovery result is inferred. */
export function createLibraryInitializationFailureReport(
  reason: LibraryInitializationFailure,
  checkedAt: string,
): StartupRecoveryReport {
  return StartupRecoveryReportSchema.parse({
    previousShutdown: "unknown",
    mode: "read-only",
    replayedEditCount: 0,
    recoveredPatentCount: 0,
    quarantinedPatentCount: 0,
    backupCreated: false,
    recoverySourcesUnavailable: true,
    libraryInitializationFailure: reason,
    checkedAt,
  });
}
