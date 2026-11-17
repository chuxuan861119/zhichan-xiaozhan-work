import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type DataTransferLibraryInspection,
  DataTransferLibraryInspectionSchema,
  DataTransferLibrarySummarySchema,
  DataTransferOperationIdSchema,
  DataTransferOperationKindSchema,
  DataTransferPhaseSchema,
  type DataTransferProgress,
  DataTransferProgressSchema,
  FullDataExportRequestSchema,
  FullDataExportResultSchema,
  FullDataImportCommitRequestSchema,
  FullDataImportPrepareRequestSchema,
  FullDataImportPreviewSchema,
  TransferDestinationSelectionSchema,
  type TransferManifest,
  type TransferManifestEntry,
  TransferManifestEntrySchema,
  TransferManifestSchema,
  TransferSourceSelectionSchema,
} from "./model.js";

function assertReadonlyContracts(
  transferProgress: DataTransferProgress,
  inspection: DataTransferLibraryInspection,
  transferManifest: TransferManifest,
) {
  // @ts-expect-error Cross-process progress snapshots are immutable.
  transferProgress.phase = "completed";
  // @ts-expect-error Nested summaries remain immutable through their parent contract.
  inspection.summary.activePatents = 2;
  // @ts-expect-error Blocker collections are immutable snapshots.
  inspection.blockers.push({ kind: "documents", count: 1 });

  const blocker = inspection.blockers[0];
  if (blocker) {
    // @ts-expect-error Blocker elements are immutable records.
    blocker.count = 2;
  }

  const manifestEntry = transferManifest.entries[0];
  if (manifestEntry) {
    // @ts-expect-error Manifest entries are immutable records.
    manifestEntry.logicalPath = "changed";
  }
}

void assertReadonlyContracts;

const operationId = "00000000-0000-4000-8000-000000000001";
const packageId = "00000000-0000-4000-8000-000000000002";
const sha256 = "a".repeat(64);
const timestamp = "2026-08-16T09:30:00.000Z";

const summary = {
  activePatents: 1,
  trashedPatents: 2,
  documents: 3,
  legacyDrafts: 4,
  snapshots: 5,
  assets: 6,
  flowchartProjects: 7,

  totalBytes: 9,
};

const progress = {
  operationId,
  kind: "full-data-export" as const,
  phase: "collecting-data" as const,
  completedBytes: 0,
  totalBytes: null,
  currentCategory: "database" as const,
  elapsedMs: 0,
  remainingMs: null,
  cancellable: true,
};

const entry = {
  ordinal: 0,
  logicalPath: "database/library.sqlite",
  kind: "database" as const,
  compression: "deflate-raw" as const,
  originalBytes: 0,
  compressedBytes: 0,
  sha256,
  chunkCount: 0,
};

const manifest = {
  packageFormatVersion: 2 as const,
  packageId,
  exportedByVersion: "0.1.0",
  minimumImporterVersion: "0.1.0",
  databaseSchemaVersion: 0,
  databaseSchemaFingerprint: "schema-v0",
  canonicalPatentFormatVersion: 0,
  exportedAt: timestamp,
  cutoffAt: timestamp,
  summary,
  entries: [entry],
  portableSettingKeys: ["editor.font-size"],
  excludedMachineSettingCategories: ["printer"],
  totalOriginalBytes: 0,
  totalChunkCount: 0,
  payloadSha256: sha256,
};

describe("data transfer operation progress", () => {
  test("locks operation kinds and phases to the shared protocol", () => {
    expect(DataTransferOperationKindSchema.options).toEqual([
      "full-data-export",
      "full-data-import",
      "library-swap",
    ]);
    expect(DataTransferPhaseSchema.options).toEqual([
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
  });

  test("accepts only UUID operation IDs and non-negative integer counters", () => {
    expect(DataTransferOperationIdSchema.safeParse(operationId).success).toBe(true);
    expect(DataTransferOperationIdSchema.safeParse("operation-1").success).toBe(false);
    expect(DataTransferProgressSchema.parse(progress)).toEqual(progress);

    for (const invalid of [
      { completedBytes: -1 },
      { completedBytes: 0.5 },
      { totalBytes: -1 },
      { elapsedMs: -1 },
      { remainingMs: 0.5 },
    ]) {
      expect(DataTransferProgressSchema.safeParse({ ...progress, ...invalid }).success).toBe(false);
    }
  });

  test.each(["绝密专利标题", "D:\\客户资料\\绝密专利.patdoc"])(
    "rejects sensitive progress category %j",
    (currentCategory) => {
      expect(DataTransferProgressSchema.safeParse({ ...progress, currentCategory }).success).toBe(
        false,
      );
    },
  );

  test("rejects path and patent metadata as extra progress fields", () => {
    expect(
      DataTransferProgressSchema.safeParse({
        ...progress,
        currentPath: "D:\\客户资料\\绝密专利.patdoc",
      }).success,
    ).toBe(false);
    expect(
      DataTransferProgressSchema.safeParse({ ...progress, patentTitle: "绝密专利标题" }).success,
    ).toBe(false);
  });
});

describe("data transfer library inspection", () => {
  test("keeps an empty library inspection and structured blocker list explicit", () => {
    const inspection = { empty: true, blockers: [], summary: { ...summary, activePatents: 0 } };
    expect(DataTransferLibraryInspectionSchema.parse(inspection)).toEqual(inspection);

    expect(
      DataTransferLibraryInspectionSchema.safeParse({
        ...inspection,
        empty: false,
        blockers: [{ kind: "pending-operation", count: 1 }],
      }).success,
    ).toBe(true);
    expect(
      DataTransferLibraryInspectionSchema.safeParse({
        ...inspection,
        blockers: [{ kind: "pending-operation", count: 1, path: "D:\\private" }],
      }).success,
    ).toBe(false);
  });

  test("rejects negative, fractional, and extra summary fields", () => {
    expect(DataTransferLibrarySummarySchema.safeParse(summary).success).toBe(true);
    expect(
      DataTransferLibrarySummarySchema.safeParse({ ...summary, activePatents: -1 }).success,
    ).toBe(false);
    expect(DataTransferLibrarySummarySchema.safeParse({ ...summary, assets: 1.5 }).success).toBe(
      false,
    );
    expect(DataTransferLibrarySummarySchema.safeParse({ ...summary, unknown: 1 }).success).toBe(
      false,
    );
  });
});

describe("data transfer selections and requests", () => {
  test("requires non-empty opaque selection IDs and display fields", () => {
    expect(
      TransferDestinationSelectionSchema.safeParse({
        selectionId: "selection-1",
        displayPath: "D:\\exports",
        suggestedFileName: "完整数据备份.patbackup",
      }).success,
    ).toBe(true);
    expect(
      TransferDestinationSelectionSchema.safeParse({
        selectionId: "",
        displayPath: "D:\\exports",
        suggestedFileName: "完整数据备份.patbackup",
      }).success,
    ).toBe(false);

    const source = {
      selectionId: "selection-2",
      fileName: "完整数据备份.patbackup",
      sizeBytes: 0,
      packageFormatVersion: 2,
      minimumImporterVersion: "0.1.0",
      passwordHint: null,
    };
    expect(TransferSourceSelectionSchema.parse(source)).toEqual(source);
    expect(TransferSourceSelectionSchema.safeParse({ ...source, sizeBytes: -1 }).success).toBe(
      false,
    );
    expect(
      TransferSourceSelectionSchema.safeParse({ ...source, packageFormatVersion: 2.5 }).success,
    ).toBe(false);
  });

  test("locks export and import acknowledgements to true literals", () => {
    const exportRequest = {
      operationId,
      destinationSelectionId: "selection-1",
      password: "test-password",
      passwordHint: null,
      passwordRecorded: true as const,
    };
    expect(FullDataExportRequestSchema.parse(exportRequest)).toEqual(exportRequest);
    expect(
      FullDataExportRequestSchema.safeParse({ ...exportRequest, passwordRecorded: false }).success,
    ).toBe(false);
    expect(FullDataExportRequestSchema.safeParse({ ...exportRequest, password: "" }).success).toBe(
      false,
    );

    expect(
      FullDataImportPrepareRequestSchema.safeParse({
        operationId,
        sourceSelectionId: "selection-2",
        password: "test-password",
      }).success,
    ).toBe(true);
    expect(
      FullDataImportCommitRequestSchema.safeParse({
        operationId,
        acknowledgedEmptyLibraryAndRestart: true,
      }).success,
    ).toBe(true);
    expect(
      FullDataImportCommitRequestSchema.safeParse({
        operationId,
        acknowledgedEmptyLibraryAndRestart: false,
      }).success,
    ).toBe(false);
  });

  test("locks result versions, verification flags, and ISO datetimes", () => {
    const result = {
      operationId,
      displayPath: "D:\\exports\\完整数据备份.patbackup",
      sizeBytes: 0,
      cutoffAt: timestamp,
      packageFormatVersion: 2 as const,
      summary,
      fullVerificationPassed: true as const,
    };
    expect(FullDataExportResultSchema.parse(result)).toEqual(result);
    expect(
      FullDataExportResultSchema.safeParse({ ...result, packageFormatVersion: 1 }).success,
    ).toBe(false);
    expect(
      FullDataExportResultSchema.safeParse({ ...result, fullVerificationPassed: false }).success,
    ).toBe(false);
    expect(FullDataExportResultSchema.safeParse({ ...result, cutoffAt: "yesterday" }).success).toBe(
      false,
    );
  });

  test("requires the exact fixed setup tuple in import previews", () => {
    const preview = {
      operationId,
      packageId,
      exportedAt: timestamp,
      summary,
      packageVerified: true as const,
      versionCompatible: true as const,
      targetLibraryEmpty: true as const,
      settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"] as const,
    };
    expect(FullDataImportPreviewSchema.parse(preview)).toEqual(preview);

    for (const settingsRequiringSetup of [
      ["backup-folder", "printer"],
      ["printer", "ai-credentials", "backup-folder"],
      ["backup-folder", "ai-credentials", "printer", "cloud"],
    ]) {
      expect(
        FullDataImportPreviewSchema.safeParse({ ...preview, settingsRequiringSetup }).success,
      ).toBe(false);
    }
    expect(
      FullDataImportPreviewSchema.safeParse({ ...preview, packageVerified: false }).success,
    ).toBe(false);
  });
});

describe("data transfer manifest", () => {
  test("accepts strict entries and rejects unsafe numeric and hash boundaries", () => {
    expect(TransferManifestEntrySchema.parse(entry)).toEqual(entry);
    for (const invalid of [
      { ordinal: -1 },
      { chunkCount: 0.5 },
      { originalBytes: -1 },
      { compressedBytes: 0.5 },
      { sha256: "A".repeat(64) },
      { sha256: "a".repeat(63) },
      { kind: "patent" },
      { compression: "deflate" },
      { logicalPath: "" },
    ]) {
      expect(TransferManifestEntrySchema.safeParse({ ...entry, ...invalid }).success).toBe(false);
    }
    expect(TransferManifestEntrySchema.safeParse({ ...entry, path: "D:\\private" }).success).toBe(
      false,
    );
  });

  test("accepts a strict version-two manifest with readonly inferred arrays", () => {
    expect(TransferManifestSchema.parse(manifest)).toEqual(manifest);
    expectTypeOf<TransferManifest["entries"]>().toEqualTypeOf<readonly TransferManifestEntry[]>();
    expectTypeOf<TransferManifest["portableSettingKeys"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<TransferManifest["excludedMachineSettingCategories"]>().toEqualTypeOf<
      readonly string[]
    >();
  });

  test("rejects invalid manifest literals, dates, totals, hashes, and extra fields", () => {
    for (const invalid of [
      { packageFormatVersion: 1 },
      { packageId: "package-1" },
      { exportedAt: "2026-08-16" },
      { cutoffAt: "not-a-date" },
      { databaseSchemaVersion: -1 },
      { canonicalPatentFormatVersion: 0.5 },
      { totalOriginalBytes: -1 },
      { totalChunkCount: 0.5 },
      { payloadSha256: "0".repeat(65) },
      { exportedByVersion: "" },
      { databaseSchemaFingerprint: "" },
    ]) {
      expect(TransferManifestSchema.safeParse({ ...manifest, ...invalid }).success).toBe(false);
    }
    expect(TransferManifestSchema.safeParse({ ...manifest, password: "secret" }).success).toBe(
      false,
    );
  });
});

describe("immutable data transfer contracts", () => {
  test("freezes representative top-level and nested progress and inspection snapshots", () => {
    const parsedProgress = DataTransferProgressSchema.parse(progress);
    const parsedInspection = DataTransferLibraryInspectionSchema.parse({
      empty: false,
      blockers: [{ kind: "pending-operation", count: 1 }],
      summary,
    });

    expect(Object.isFrozen(parsedProgress)).toBe(true);
    expect(Object.isFrozen(parsedInspection)).toBe(true);
    expect(Object.isFrozen(parsedInspection.summary)).toBe(true);
    expect(Object.isFrozen(parsedInspection.blockers)).toBe(true);
    expect(Object.isFrozen(parsedInspection.blockers[0])).toBe(true);
  });

  test("freezes manifest records and every nested snapshot collection", () => {
    const parsedManifest = TransferManifestSchema.parse(manifest);

    expect(Object.isFrozen(parsedManifest)).toBe(true);
    expect(Object.isFrozen(parsedManifest.summary)).toBe(true);
    expect(Object.isFrozen(parsedManifest.entries)).toBe(true);
    expect(Object.isFrozen(parsedManifest.entries[0])).toBe(true);
    expect(Object.isFrozen(parsedManifest.portableSettingKeys)).toBe(true);
    expect(Object.isFrozen(parsedManifest.excludedMachineSettingCategories)).toBe(true);
  });
});
