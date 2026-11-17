import { describe, expect, test } from "vitest";
import {
  BackupEntrySchema,
  BackupFinalizationRequestSchema,
  BackupOperationStatusSchema,
  BackupRunResultSchema,
  BackupStatusSchema,
} from "./model.js";

describe("backup model", () => {
  test("represents a damaged backup without inventing document metadata", () => {
    expect(
      BackupEntrySchema.safeParse({
        fileName: "broken.patdoc",
        displayName: "broken",
        documentType: null,
        documentId: null,
        revision: null,
        sizeBytes: 12,
        backedUpAt: "2026-08-09T00:00:00.000Z",
        managed: false,
        status: "damaged",
        errorMessage: "文件损坏",
      }).success,
    ).toBe(true);
  });

  test("reports attempts separately from fully successful backups", () => {
    expect(
      BackupStatusSchema.safeParse({
        enabled: true,
        folder: "D:\\backups",
        intervalMinutes: 5,
        lastAttemptAt: "2026-08-09T00:00:00.000Z",
        lastBackupAt: null,
        nextBackupAt: "2026-08-09T00:05:00.000Z",
        lastRunSuccessCount: 0,
        lastRunFailureCount: 1,
        lastError: "磁盘已满",
      }).success,
    ).toBe(true);
  });

  test("represents an in-progress final backup without exposing file paths", () => {
    expect(
      BackupOperationStatusSchema.parse({
        running: true,
        trigger: "application-close",
        totalCount: 2,
        completedCount: 1,
        currentDisplayName: "一种装置",
        cancelRequested: false,
      }),
    ).toMatchObject({ trigger: "application-close", completedCount: 1 });
  });

  test("rejects impossible final backup progress", () => {
    expect(
      BackupOperationStatusSchema.safeParse({
        running: true,
        trigger: "application-close",
        totalCount: 1,
        completedCount: 2,
        currentDisplayName: "一种装置",
        cancelRequested: false,
      }).success,
    ).toBe(false);
  });

  test("reports a completed final backup result", () => {
    expect(
      BackupRunResultSchema.parse({
        trigger: "application-close",
        attemptedCount: 2,
        successCount: 1,
        skippedCount: 0,
        failures: [
          {
            target: { documentType: "patent", documentId: "550e8400-e29b-41d4-a716-446655440000" },
            displayName: "一种装置",
            message: "备份文件夹不可写",
          },
        ],
        cancelled: false,
        completedAt: "2026-08-23T01:00:00.000Z",
      }),
    ).toMatchObject({ attemptedCount: 2, successCount: 1 });
  });

  test("only accepts the finalization operation request", () => {
    expect(BackupFinalizationRequestSchema.safeParse({}).success).toBe(true);
    expect(BackupFinalizationRequestSchema.safeParse({ path: "D:\\unsafe" }).success).toBe(false);
  });
});
