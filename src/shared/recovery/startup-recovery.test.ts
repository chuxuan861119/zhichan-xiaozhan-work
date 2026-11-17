import { describe, expect, test } from "vitest";
import {
  createLibraryInitializationFailureReport,
  createStartupRecoveryReport,
  StartupRecoveryReportSchema,
} from "./startup-recovery.js";

describe("createStartupRecoveryReport", () => {
  test("reports unfinished asset isolation without exposing error details or paths", () => {
    const recovery = {
      mode: "read-only" as const,
      recoveredPatentIds: [],
      quarantinedPatentIds: [],
      replayedEditCount: 0,
      backupPath: null,
      assetIsolationPending: true,
      assetIsolationFailure: new Error("D:/private/patent-library/assets/unreadable.asset"),
    };
    const report = createStartupRecoveryReport({
      previousShutdown: "clean",
      recovery,
      checkedAt: "2026-10-09T00:00:00.000Z",
    });
    expect(report.assetIsolationPending).toBe(true);
    expect(report.mode).toBe("read-only");
    expect(JSON.stringify(report)).not.toContain("assetIsolationFailure");
    expect(JSON.stringify(report)).not.toContain("D:/private");
  });
  test("reports pending history cleanup as a count without exposing patent identifiers", () => {
    const report = createStartupRecoveryReport({
      previousShutdown: "clean",
      recovery: {
        mode: "read-write",
        recoveredPatentIds: [],
        quarantinedPatentIds: [],
        replayedEditCount: 0,
        backupPath: null,
        historyCleanupPendingPatentIds: ["00000000-0000-4000-8000-000000000001"],
      },
      checkedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(report.historyCleanupPendingCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain("00000000");
  });
  test("includes a non-sensitive data import recovery state when startup recovery ran", () => {
    const report = createStartupRecoveryReport({
      previousShutdown: "clean",
      recovery: {
        mode: "read-only",
        recoveredPatentIds: [],
        quarantinedPatentIds: [],
        replayedEditCount: 0,
        backupPath: null,
      },
      dataImportRecovery: "manual-safe-recovery",
      checkedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(report.dataImportRecovery).toBe("manual-safe-recovery");
    expect(JSON.stringify(report)).not.toContain("C:\\");
  });

  test("summarizes an unclean startup without exposing document identifiers or paths", () => {
    const report = createStartupRecoveryReport({
      previousShutdown: "unclean",
      recovery: {
        mode: "read-write",
        recoveredPatentIds: ["00000000-0000-4000-8000-000000000001"],
        quarantinedPatentIds: ["00000000-0000-4000-8000-000000000002"],
        replayedEditCount: 3,
        backupPath: "D:/private/patent-backup",
      },
      checkedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report).toEqual({
      previousShutdown: "unclean",
      mode: "read-write",
      replayedEditCount: 3,
      recoveredPatentCount: 1,
      quarantinedPatentCount: 1,
      backupCreated: true,
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(JSON.stringify(report)).not.toContain("00000000");
    expect(JSON.stringify(report)).not.toContain("D:/private");
  });

  test("strictly rejects extra recovery metadata from the IPC boundary", () => {
    expect(
      StartupRecoveryReportSchema.safeParse({
        previousShutdown: "clean",
        mode: "read-write",
        replayedEditCount: 0,
        recoveredPatentCount: 0,
        quarantinedPatentCount: 0,
        backupCreated: false,
        checkedAt: "2026-08-11T00:00:00.000Z",
        patentName: "不得暴露",
      }).success,
    ).toBe(false);
  });
});

test.each([
  "incomplete-library",
  "invalid-library-root",
  "backup-failed",
  "migration-failed",
  "validation-failed",
  "unknown",
] as const)(
  "sanitizes initialization failure (%s) without suggesting completed data recovery",
  (reason) => {
    const report = createLibraryInitializationFailureReport(reason, "2026-10-14T00:00:00.000Z");
    expect(report).toMatchObject({
      mode: "read-only",
      libraryInitializationFailure: reason,
      recoverySourcesUnavailable: true,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
    });
    expect(
      StartupRecoveryReportSchema.safeParse({
        ...report,
        libraryInitializationFailure: "/private/patent",
      }).success,
    ).toBe(false);
  },
);
