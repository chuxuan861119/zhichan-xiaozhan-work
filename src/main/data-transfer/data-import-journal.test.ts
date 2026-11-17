import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DATA_IMPORT_JOURNAL_FILE_NAME,
  DataImportJournal,
  type DataImportJournalRecordInput,
} from "./data-import-journal.js";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "data-import-journal-"));
  directories.push(root);
  const applicationDataRoot = join(root, "application-data");
  const libraryRoot = join(applicationDataRoot, "Library");
  const userDataRoot = join(root, "user-data");
  const operationId = "00000000-0000-4000-8000-000000000019";
  await mkdir(applicationDataRoot, { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  const record: DataImportJournalRecordInput = {
    operationId,
    phase: "prepared",
    createdAt: "2026-08-16T12:00:00.000Z",
    stagingPath: join(applicationDataRoot, `.import-staging-${operationId}`),
    libraryPath: libraryRoot,
    rollbackLibraryPath: join(applicationDataRoot, `.import-rollback-${operationId}`),
    stagingDraftsPath: join(dirname(userDataRoot), `.import-user-data-${operationId}`, "drafts"),
    draftsPath: join(userDataRoot, "drafts"),
    rollbackDraftsPath: join(userDataRoot, `.drafts-rollback-${operationId}`),
    settingsCandidatePath: join(
      dirname(userDataRoot),
      `.import-user-data-${operationId}`,
      `settings-candidate-${operationId}.json`,
    ),
    settingsPath: join(userDataRoot, "settings.json"),
    rollbackSettingsPath: join(userDataRoot, `settings-rollback-${operationId}.json`),
    packageSummary: {
      packageId: "00000000-0000-4000-8000-000000000020",
      packageFormatVersion: 2,
      payloadSha256: "a".repeat(64),
      totalOriginalBytes: 123,
      exportedAt: "2026-08-16T11:00:00.000Z",
    },
  };
  return {
    root,
    applicationDataRoot,
    libraryRoot,
    userDataRoot,
    operationId,
    record,
    journal: new DataImportJournal({ applicationDataRoot, libraryRoot, userDataRoot }),
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DataImportJournal", () => {
  test("a malformed read does not prevent preserving the journal through quarantine", async () => {
    const value = await fixture();
    const journalPath = join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    await writeFile(journalPath, '{"broken":');
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    const retained = await value.journal.quarantine();
    expect(retained).toBeDefined();
    expect(await readFile(retained!, "utf8")).toBe('{"broken":');
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
  });
  test("startup recovery retires a dead writer lock and partial, retaining the last durable phase", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    const partial = `.${DATA_IMPORT_JOURNAL_FILE_NAME}.${value.operationId}.00000000-0000-4000-8000-000000000022.partial`;
    await writeFile(join(value.applicationDataRoot, partial), '{"phase":"committed"');
    await writeFile(
      join(value.applicationDataRoot, "data-import-journal.lock"),
      JSON.stringify({ pid: 2147483647, token: "00000000-0000-4000-8000-000000000023" }),
    );
    await expect(value.journal.recover({ exclusiveStartup: true })).resolves.toMatchObject({
      phase: "prepared",
    });
    expect(await readdir(value.applicationDataRoot)).toEqual([DATA_IMPORT_JOURNAL_FILE_NAME]);
    await expect(value.journal.advance("rolled-back")).resolves.toMatchObject({
      phase: "rolled-back",
    });
  });

  test("startup recovery never removes a live writer lock", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    const lock = JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000023",
    });
    await writeFile(join(value.applicationDataRoot, "data-import-journal.lock"), lock);
    await expect(value.journal.recover({ exclusiveStartup: true })).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
    expect(
      await readFile(join(value.applicationDataRoot, "data-import-journal.lock"), "utf8"),
    ).toBe(lock);
  });
  test("allows only the next durable phase and preserves the first error", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    await value.journal.advance("old-library-moved");
    await expect(value.journal.advance("prepared")).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
      message: "Invalid import journal transition",
    });
    await expect(value.journal.advance("settings-installed")).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
      message: "Invalid import journal transition",
    });
    await expect(value.journal.read()).resolves.toMatchObject({ phase: "old-library-moved" });
  });

  test("rejects a journal whose staging path leaves the library parent boundary", async () => {
    const value = await fixture();
    const forged = { ...value.record, stagingPath: "C:\\Windows" };
    await writeFile(
      join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME),
      JSON.stringify(forged),
    );
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
  });

  test("accepts only the fixed staging roots and child names", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    await value.journal.clear();
    const journalPath = join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    const invalidRecords = [
      {
        ...value.record,
        stagingPath: join(value.applicationDataRoot, `.import-staging-${value.operationId}-other`),
      },
      {
        ...value.record,
        stagingDraftsPath: join(
          dirname(value.userDataRoot),
          `.import-user-data-${value.operationId}-other`,
          "drafts",
        ),
      },
      {
        ...value.record,
        stagingDraftsPath: join(
          value.userDataRoot,
          `.import-user-data-${value.operationId}`,
          "drafts",
        ),
      },
      {
        ...value.record,
        stagingDraftsPath: join(
          dirname(value.userDataRoot),
          `.import-user-data-${value.operationId}`,
          "other",
        ),
      },
      {
        ...value.record,
        settingsCandidatePath: join(
          dirname(value.userDataRoot),
          `.import-user-data-${value.operationId}`,
          `settings-candidate-${value.operationId}-other.json`,
        ),
      },
      {
        ...value.record,
        rollbackSettingsPath: join(
          value.userDataRoot,
          "forged-owned-candidate",
          `settings-rollback-${value.operationId}.json`,
        ),
        pathIdentities: {
          rollbackSettings: {
            device: "1",
            inode: "2",
            birthtimeNs: "3",
            size: "4",
            mtimeNs: "5",
            ctimeNs: "6",
          },
        },
      },
      {
        ...value.record,
        rollbackSettingsPath: join(
          value.userDataRoot,
          `.settings-rollback-${value.operationId}.json`,
        ),
      },
    ];
    for (const record of invalidRecords) {
      await writeFile(journalPath, JSON.stringify(record));
      await expect(value.journal.read()).rejects.toMatchObject({
        code: "IMPORT_RECOVERY_REQUIRED",
      });
    }
  });

  test("rejects malformed, unknown-phase, mixed-task, and temporary journals without exposing data", async () => {
    const value = await fixture();
    const journalPath = join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    await writeFile(journalPath, "not-json");
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    await writeFile(journalPath, JSON.stringify({ ...value.record, phase: "unknown" }));
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    await writeFile(
      journalPath,
      JSON.stringify({
        ...value.record,
        rollbackDraftsPath: join(
          value.userDataRoot,
          `.drafts-rollback-00000000-0000-4000-8000-000000000021`,
        ),
      }),
    );
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    await writeFile(
      join(value.applicationDataRoot, `${DATA_IMPORT_JOURNAL_FILE_NAME}.partial`),
      "{}",
    );
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    const error = await value.journal.read().catch((failure: unknown) => failure);
    expect(JSON.stringify(error)).not.toContain(value.libraryRoot);
  });

  test("read and recover are idempotent and create never overwrites an existing journal", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    const first = await value.journal.read();
    expect(await value.journal.recover()).toEqual(first);
    await expect(value.journal.create(value.record)).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
    const files = await readdir(value.applicationDataRoot);
    expect(files).toContain(DATA_IMPORT_JOURNAL_FILE_NAME);
    expect(
      await readFile(join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME), "utf8"),
    ).not.toContain("password");
  });

  test("persists the manifest anchor and path identities for an external library root", async () => {
    const value = await fixture();
    const externalParent = join(value.root, "external");
    const externalLibrary = join(externalParent, "Library");
    const externalStaging = join(externalParent, `.import-staging-${value.operationId}`);
    await mkdir(externalParent, { recursive: true });
    const record = {
      ...value.record,
      stagingPath: externalStaging,
      libraryPath: externalLibrary,
      rollbackLibraryPath: join(externalParent, `.import-rollback-${value.operationId}`),
      manifestPath: join(externalStaging, `.import-manifest-${value.operationId}.json`),
      pathIdentities: {
        library: {
          device: "1",
          inode: "2",
          birthtimeNs: "3",
          size: "4",
          mtimeNs: "5",
          ctimeNs: "6",
        },
      },
    };

    const journal = new DataImportJournal({
      applicationDataRoot: value.applicationDataRoot,
      libraryRoot: externalLibrary,
      userDataRoot: value.userDataRoot,
    });
    await journal.create(record);

    await expect(journal.read()).resolves.toMatchObject({
      libraryPath: externalLibrary,
      manifestPath: record.manifestPath,
      pathIdentities: record.pathIdentities,
    });
  });

  test("requires prepared as the initial phase and rejects a UUID only in a parent directory", async () => {
    const value = await fixture();
    await expect(
      value.journal.create({ ...value.record, phase: "old-library-moved" }),
    ).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
      message: "Invalid import journal transition",
    });
    const journalPath = join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    await writeFile(
      journalPath,
      JSON.stringify({
        ...value.record,
        stagingPath: join(
          value.applicationDataRoot,
          `.import-staging-${value.operationId}`,
          "library",
        ),
      }),
    );
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
  });

  test("serializes two instances with an exclusive owner lock", async () => {
    const value = await fixture();
    const second = new DataImportJournal({
      applicationDataRoot: value.applicationDataRoot,
      libraryRoot: value.libraryRoot,
      userDataRoot: value.userDataRoot,
    });
    const results = await Promise.allSettled([
      value.journal.create(value.record),
      second.create(value.record),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await value.journal.read()).toMatchObject({ phase: "prepared" });
    expect(await readdir(value.applicationDataRoot)).toEqual([DATA_IMPORT_JOURNAL_FILE_NAME]);
  });

  test("keeps the losing instance readable after a 20-round lock race", async () => {
    const noProbe = () => ({ assertSafe: async () => {}, close: async () => {} });
    for (let round = 0; round < 20; round += 1) {
      const value = await fixture();
      const options = {
        applicationDataRoot: value.applicationDataRoot,
        libraryRoot: value.libraryRoot,
        userDataRoot: value.userDataRoot,
        createReparsePointProbe: noProbe,
      };
      const first = new DataImportJournal(options);
      const second = new DataImportJournal(options);
      const results = await Promise.allSettled([
        first.create(value.record),
        second.create(value.record),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(first.read()).resolves.toMatchObject({ phase: "prepared" });
      await expect(second.read()).resolves.toMatchObject({ phase: "prepared" });
    }
  });

  test("treats a residual lock after a crash as recovery-required", async () => {
    const value = await fixture();
    await writeFile(join(value.applicationDataRoot, "data-import-journal.lock"), "owner-token");
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    await expect(value.journal.recover()).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
  });

  test("sanitizes a reparse probe close failure and keeps it as the first error", async () => {
    const value = await fixture();
    const journal = new DataImportJournal({
      applicationDataRoot: value.applicationDataRoot,
      libraryRoot: value.libraryRoot,
      userDataRoot: value.userDataRoot,
      createReparsePointProbe: () => ({
        assertSafe: async () => {},
        close: async () => {
          throw new Error("secret probe close path");
        },
      }),
    });
    const failure = await journal.create(value.record).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    expect(JSON.stringify(failure)).not.toContain("secret probe close path");
  });

  test("quarantines the journal by renaming it without deleting its content", async () => {
    const value = await fixture();
    await value.journal.create(value.record);
    const journalPath = join(value.applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    const before = await readFile(journalPath, "utf8");

    const quarantinePath = await value.journal.quarantine().catch((error: unknown) => {
      console.log("QUARANTINE-REJECTED:", error);
      console.log("STACK:", error instanceof Error ? error.stack : "");
      return undefined;
    });
    expect(quarantinePath).toBeDefined();
    expect(quarantinePath).toMatch(/pending-data-import\.json\.failed-[0-9a-f-]{36}$/u);

    // 原始字节隔离，但未解决的恢复任务不能被下一次启动遗忘。
    await expect(value.journal.read()).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    const restarted = new DataImportJournal({
      applicationDataRoot: value.applicationDataRoot,
      libraryRoot: value.libraryRoot,
      userDataRoot: value.userDataRoot,
    });
    await expect(restarted.recover({ exclusiveStartup: true })).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
    await expect(restarted.create(value.record)).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
    await expect(readFile(quarantinePath as string, "utf8")).resolves.toBe(before);

    // 无 journal 时隔离是幂等空操作。
    await expect(value.journal.quarantine()).resolves.toBeUndefined();
  });
});
