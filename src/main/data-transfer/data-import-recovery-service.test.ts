import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { PatentTemplateService } from "../library/patent-template-service.js";
import type {
  DataImportJournalPathIdentities,
  DataImportJournalPhase,
  DataImportJournalRecord,
} from "./data-import-journal.js";
import { DataImportJournalError } from "./data-import-journal.js";
import {
  type DataImportRecoveryJournal,
  DataImportRecoveryService,
  validateRecoveredSettingsContent,
} from "./data-import-recovery-service.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000021";

function pathIdentity(path: string) {
  const metadata = lstatSync(path, { bigint: true });
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtimeNs: String(metadata.birthtimeNs),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
  };
}

async function createLayout() {
  const root = await mkdtemp(join(tmpdir(), "data-import-recovery-"));
  const applicationDataRoot = join(root, "app-data");
  const libraryPath = join(applicationDataRoot, "Library");
  const userDataRoot = join(root, "user-data");
  const userDataParent = join(root);
  const draftsPath = join(userDataRoot, "drafts");
  const stagingPath = join(applicationDataRoot, `.import-staging-${OPERATION_ID}`);
  const stagingDraftsPath = join(userDataParent, `.import-user-data-${OPERATION_ID}`, "drafts");
  const settingsCandidatePath = join(
    userDataParent,
    `.import-user-data-${OPERATION_ID}`,
    `settings-candidate-${OPERATION_ID}.json`,
  );
  const rollbackLibraryPath = join(applicationDataRoot, `.import-rollback-${OPERATION_ID}`);
  const rollbackDraftsPath = join(userDataRoot, `.drafts-rollback-${OPERATION_ID}`);
  const settingsPath = join(userDataRoot, "settings.json");
  const rollbackSettingsPath = join(userDataRoot, `settings-rollback-${OPERATION_ID}.json`);
  await mkdir(libraryPath, { recursive: true });
  await mkdir(draftsPath, { recursive: true });
  await mkdir(join(stagingPath, "library"), { recursive: true });
  await mkdir(stagingDraftsPath, { recursive: true });
  await writeFile(settingsPath, "old-settings\n");
  await writeFile(settingsCandidatePath, "new-settings\n");
  const pathIdentities: DataImportJournalPathIdentities = {
    stagingRoot: pathIdentity(stagingPath),
    stagingLibrary: pathIdentity(join(stagingPath, "library")),
    library: pathIdentity(libraryPath),
    stagingDraftsRoot: pathIdentity(join(userDataParent, `.import-user-data-${OPERATION_ID}`)),
    stagingDrafts: pathIdentity(stagingDraftsPath),
    drafts: pathIdentity(draftsPath),
    settingsCandidate: pathIdentity(settingsCandidatePath),
    settings: pathIdentity(settingsPath),
  };
  const record = (phase: DataImportJournalPhase): DataImportJournalRecord =>
    ({
      version: 1,
      operationId: OPERATION_ID,
      phase,
      createdAt: "2026-08-17T00:00:00.000Z",
      stagingPath,
      libraryPath,
      rollbackLibraryPath,
      stagingDraftsPath,
      draftsPath,
      rollbackDraftsPath,
      settingsCandidatePath,
      settingsPath,
      rollbackSettingsPath,
      settingsContentSha256: createHash("sha256").update("new-settings\n").digest("hex"),
      pathIdentities,
      packageSummary: {
        packageId: "00000000-0000-4000-8000-000000000022",
        packageFormatVersion: 2,
        payloadSha256: "a".repeat(64),
        totalOriginalBytes: 0,
        exportedAt: "2026-08-17T00:00:00.000Z",
      },
    }) as DataImportJournalRecord;
  return {
    root,
    applicationDataRoot,
    libraryPath,
    userDataRoot,
    draftsPath,
    stagingPath,
    stagingDraftsPath,
    settingsCandidatePath,
    rollbackLibraryPath,
    rollbackDraftsPath,
    settingsPath,
    rollbackSettingsPath,
    record,
  };
}

function journalFor(record: DataImportJournalRecord): DataImportRecoveryJournal & {
  read: ReturnType<typeof vi.fn>;
  advance: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  quarantine: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn(async () => record),
    advance: vi.fn(async (phase: DataImportJournalPhase) => ({ ...record, phase })),
    clear: vi.fn(async () => undefined),
    quarantine: vi.fn(async () => undefined),
  };
}

describe("DataImportRecoveryService", () => {
  test.each([false, true])(
    "prepared recovery protects actual template data (custom=%s)",
    async (custom) => {
      const fixture = await createLayout();
      const prepared = await new LibraryMigrationService(fixture.libraryPath).prepare();
      if (prepared.status !== "ready") throw new Error("library fixture");
      new PatentTemplateService({ database: prepared.database }).initializeFromLegacySettings(
        custom ? structuredClone(DEFAULT_APP_SETTINGS) : null,
      );
      prepared.database.close();
      const record = fixture.record("prepared");
      const journal = journalFor(record);
      const result = await new DataImportRecoveryService({
        journal,
        libraryRoot: fixture.libraryPath,
        userDataRoot: fixture.userDataRoot,
        applicationDataRoot: fixture.applicationDataRoot,
      }).recover();
      expect(result.status).toBe(custom ? "manual-safe-recovery" : "abandoned");
      expect(journal.clear).toHaveBeenCalledTimes(custom ? 0 : 1);
      await expect(stat(join(fixture.libraryPath, "library.sqlite3"))).resolves.toBeDefined();
      if (custom) await expect(stat(fixture.stagingPath)).resolves.toBeDefined();
      else await expect(stat(fixture.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("abandons prepared staging without deleting or overwriting the empty live library", async () => {
    const fixture = await createLayout();
    const journal = journalFor(fixture.record("prepared"));
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      isFormalLibraryEmpty: async () => true,
    }).recover();

    expect(result.status).toBe("abandoned");
    expect(journal.clear).toHaveBeenCalledOnce();
    await expect(stat(fixture.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.libraryPath)).resolves.toBeDefined();
  });

  test("treats a freshly migrated database with only system templates as an empty live library", async () => {
    const fixture = await createLayout();
    const prepared = await new LibraryMigrationService(fixture.libraryPath).prepare();
    if (prepared.status !== "ready") throw new Error("test library migration failed");
    prepared.database.close();
    const baseRecord = fixture.record("prepared");
    const record = {
      ...baseRecord,
      pathIdentities: {
        ...baseRecord.pathIdentities,
        library: pathIdentity(fixture.libraryPath),
      },
    };
    const journal = journalFor(record);

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    }).recover();

    expect(result.status).toBe("abandoned");
    expect(journal.clear).toHaveBeenCalledOnce();
  });

  test("restores the old library when the process stopped after moving it", async () => {
    const fixture = await createLayout();
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await writeFile(join(fixture.rollbackLibraryPath, "sentinel.txt"), "old");
    const journal = journalFor(fixture.record("old-library-moved"));
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    }).recover();

    expect(result.status).toBe("rolled-back");
    await expect(readFile(join(fixture.libraryPath, "sentinel.txt"), "utf8")).resolves.toBe("old");
    expect(journal.clear).toHaveBeenCalledOnce();
  });

  test("restores the old library when a prepared journal sees the live library already moved", async () => {
    const fixture = await createLayout();
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await writeFile(join(fixture.rollbackLibraryPath, "sentinel.txt"), "old");
    const journal = journalFor(fixture.record("prepared"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    }).recover();

    expect(result.status).toBe("rolled-back");
    await expect(readFile(join(fixture.libraryPath, "sentinel.txt"), "utf8")).resolves.toBe("old");
    expect(journal.clear).toHaveBeenCalledOnce();
  });

  test("accepts a valid external library root without forcing staging under application data", async () => {
    const fixture = await createLayout();
    const externalRoot = join(fixture.root, "external-library");
    const externalLibrary = join(externalRoot, "Library");
    await mkdir(externalLibrary, { recursive: true });
    const externalStaging = join(externalRoot, `.import-staging-${OPERATION_ID}`);
    const externalRollback = join(externalRoot, `.import-rollback-${OPERATION_ID}`);
    await mkdir(join(externalStaging, "library"), { recursive: true });
    const record = {
      ...fixture.record("prepared"),
      stagingPath: externalStaging,
      libraryPath: externalLibrary,
      rollbackLibraryPath: externalRollback,
      pathIdentities: {
        ...fixture.record("prepared").pathIdentities,
        stagingRoot: pathIdentity(externalStaging),
        stagingLibrary: pathIdentity(join(externalStaging, "library")),
        library: pathIdentity(externalLibrary),
      },
    };
    const journal = journalFor(record);

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: externalLibrary,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      isFormalLibraryEmpty: async () => true,
    }).recover();

    expect(result.status).toBe("abandoned");
    await expect(stat(externalLibrary)).resolves.toBeDefined();
    expect(journal.clear).toHaveBeenCalledOnce();
  });

  test("validates and commits a restart-pending import, then removes only journal-owned rollback paths", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
    await rename(fixture.settingsCandidatePath, fixture.settingsPath);
    const journal = journalFor(fixture.record("restart-validation-pending"));
    const validateInstalled = vi.fn(async () => true);
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled,
    }).recover();

    expect(result.status).toBe("recovered");
    expect(validateInstalled).toHaveBeenCalledOnce();
    expect(journal.clear).toHaveBeenCalledOnce();
    await expect(stat(fixture.rollbackLibraryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.rollbackDraftsPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.rollbackSettingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves rollback and validation bytes when the durable commit record fails", async () => {
    const fixture = await createLayout();
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
    await rename(fixture.settingsCandidatePath, fixture.settingsPath);
    const journal = journalFor(fixture.record("restart-validation-pending"));
    journal.advance.mockRejectedValueOnce(new Error("disk write interrupted"));
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();
    expect(result.status).toBe("manual-safe-recovery");
    await expect(stat(fixture.rollbackLibraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.stagingPath)).resolves.toBeDefined();
    expect(journal.clear).not.toHaveBeenCalled();
  });

  test("retains a committed journal until cleanup succeeds and retries without validating or rolling back", async () => {
    const fixture = await createLayout();
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
    await rename(fixture.settingsCandidatePath, fixture.settingsPath);
    const journal = journalFor(fixture.record("committed"));
    const validateInstalled = vi.fn();
    const service = new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled,
      fileSystem: {
        remove: async () => {
          throw new Error("sharing violation");
        },
      },
    });
    await service.recover();
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.rollbackLibraryPath)).resolves.toBeDefined();
    await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled,
    }).recover();
    expect(journal.clear).toHaveBeenCalledOnce();
    expect(validateInstalled).not.toHaveBeenCalled();
    await expect(stat(fixture.rollbackLibraryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("continues a crash between the old-drafts/settings moves and their journal updates", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
    const journal = journalFor(fixture.record("drafts-installed"));
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("recovered");
    await expect(stat(fixture.draftsPath)).resolves.toBeDefined();
    await expect(readFile(fixture.settingsPath, "utf8")).resolves.toBe("new-settings\n");
  });

  test("accepts a completed library rename before old-library-moved advances", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    const journal = journalFor(fixture.record("old-library-moved"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("recovered");
    expect(journal.advance.mock.calls.map(([phase]) => phase)).toEqual([
      "new-library-installed",
      "drafts-installed",
      "settings-installed",
      "restart-validation-pending",
      "committed",
    ]);
  });

  test("accepts a completed drafts rename before new-library-installed advances", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    const journal = journalFor(fixture.record("new-library-installed"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("recovered");
    expect(journal.advance.mock.calls.map(([phase]) => phase)).toEqual([
      "drafts-installed",
      "settings-installed",
      "restart-validation-pending",
      "committed",
    ]);
  });

  test("accepts a completed settings rename before drafts-installed advances", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
    await rename(fixture.settingsCandidatePath, fixture.settingsPath);
    const journal = journalFor(fixture.record("drafts-installed"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("recovered");
    expect(journal.advance.mock.calls.map(([phase]) => phase)).toEqual([
      "settings-installed",
      "restart-validation-pending",
      "committed",
    ]);
  });

  test("fails closed when a consumed source is missing but the target identity is wrong", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rm(fixture.libraryPath, { recursive: true, force: true });
    await mkdir(fixture.libraryPath, { recursive: true });
    const journal = journalFor(fixture.record("old-library-moved"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.advance).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.rollbackLibraryPath)).resolves.toBeDefined();
  });

  test("fails closed when the new-library-installed phase loses staged drafts", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rm(fixture.stagingDraftsPath, { recursive: true, force: true });
    const journal = journalFor(fixture.record("new-library-installed"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.advance).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.libraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.rollbackLibraryPath)).resolves.toBeDefined();
  });

  test("fails closed when the drafts-installed phase loses the settings candidate", async () => {
    const fixture = await createLayout();
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rm(fixture.settingsCandidatePath, { force: true });
    const journal = journalFor(fixture.record("drafts-installed"));

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.advance).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.libraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.rollbackLibraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.rollbackDraftsPath)).resolves.toBeDefined();
  });

  test("requires the final settings content to match the captured hash and schema", () => {
    const valid = Buffer.from(`${JSON.stringify(DEFAULT_APP_SETTINGS)}\n`, "utf8");
    const hash = createHash("sha256").update(valid).digest("hex");

    expect(validateRecoveredSettingsContent(valid, hash)).toBe(true);
    expect(validateRecoveredSettingsContent(Buffer.from(`${" ".repeat(1)}${valid}`), hash)).toBe(
      false,
    );
    expect(validateRecoveredSettingsContent(Buffer.from("{}\n"), hash)).toBe(false);
  });

  test("fails closed to manual-safe recovery on a damaged journal and never mutates candidates", async () => {
    const fixture = await createLayout();
    const journal: DataImportRecoveryJournal = {
      read: vi.fn(async () => {
        throw new Error("corrupt journal");
      }),
      advance: vi.fn(),
      clear: vi.fn(),
      quarantine: vi.fn(async () => undefined),
    };
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.libraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.stagingPath)).resolves.toBeDefined();
  });

  test("fails closed when a persisted journal has no stable path identities", async () => {
    const fixture = await createLayout();
    const { pathIdentities: _pathIdentities, ...record } = fixture.record("prepared");
    const journal = journalFor(record);
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(stat(fixture.libraryPath)).resolves.toBeDefined();
    await expect(stat(fixture.stagingPath)).resolves.toBeDefined();
  });

  test("does not recover when a journal path identity changed", async () => {
    const fixture = await createLayout();
    const journal = journalFor(fixture.record("restart-validation-pending"));
    await mkdir(fixture.rollbackLibraryPath, { recursive: true });
    await writeFile(join(fixture.rollbackLibraryPath, "old.txt"), "old");
    await writeFile(join(fixture.libraryPath, "new.txt"), "new");
    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      assertStable: async () => false,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.rollbackLibraryPath, "old.txt"), "utf8")).resolves.toBe(
      "old",
    );
  });

  test("rejects a forged rollback settings path even when its forged identity matches", async () => {
    const fixture = await createLayout();
    const forgedDirectory = join(fixture.userDataRoot, "forged-owned-candidate");
    const forgedRollbackSettings = join(forgedDirectory, `settings-rollback-${OPERATION_ID}.json`);
    await mkdir(forgedDirectory, { recursive: true });
    await writeFile(join(fixture.stagingPath, "library", "new.txt"), "new");
    await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
    await rename(join(fixture.stagingPath, "library"), fixture.libraryPath);
    await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
    await rename(fixture.stagingDraftsPath, fixture.draftsPath);
    await rename(fixture.settingsPath, forgedRollbackSettings);
    await rename(fixture.settingsCandidatePath, fixture.settingsPath);
    const base = fixture.record("restart-validation-pending");
    const forged = {
      ...base,
      rollbackSettingsPath: forgedRollbackSettings,
      pathIdentities: {
        ...base.pathIdentities,
        rollbackSettings: pathIdentity(forgedRollbackSettings),
      },
    };
    const journal = journalFor(forged);

    const result = await new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      validateInstalled: async () => true,
    }).recover();

    expect(result.status).toBe("manual-safe-recovery");
    expect(journal.advance).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
    await expect(readFile(forgedRollbackSettings, "utf8")).resolves.toBe("old-settings\n");
    await expect(readFile(fixture.settingsPath, "utf8")).resolves.toBe("new-settings\n");
  });

  test("quarantines an unreadable journal so later startups are not blocked forever", async () => {
    const fixture = await createLayout();
    const quarantine = vi.fn(async () => `${fixture.applicationDataRoot}/quarantined`);
    const read = vi
      .fn<() => Promise<DataImportJournalRecord | undefined>>()
      .mockRejectedValueOnce(new DataImportJournalError())
      .mockResolvedValueOnce(undefined);
    const journal: DataImportRecoveryJournal = {
      read,
      advance: vi.fn(),
      clear: vi.fn(),
      quarantine,
    };
    const service = new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    });

    const first = await service.recover();
    expect(first.status).toBe("manual-safe-recovery");
    expect(quarantine).toHaveBeenCalledOnce();

    // 隔离后再次启动不再被同一任务反复阻塞。
    const second = await service.recover();
    expect(second.status).toBe("none");
  });

  test("quarantines a journal anchored to another instance context", async () => {
    const fixture = await createLayout();
    const foreign = {
      ...fixture.record("prepared"),
      libraryPath: join(fixture.applicationDataRoot, "OtherLibrary"),
    } as DataImportJournalRecord;
    const quarantine = vi.fn(async () => `${fixture.applicationDataRoot}/quarantined`);
    const read = vi
      .fn<() => Promise<DataImportJournalRecord | undefined>>()
      .mockResolvedValueOnce(foreign)
      .mockResolvedValueOnce(undefined);
    const journal: DataImportRecoveryJournal = {
      read,
      advance: vi.fn(),
      clear: vi.fn(),
      quarantine,
    };
    const service = new DataImportRecoveryService({
      journal,
      libraryRoot: fixture.libraryPath,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
    });

    const first = await service.recover();
    expect(first.status).toBe("manual-safe-recovery");
    expect(quarantine).toHaveBeenCalledOnce();

    const second = await service.recover();
    expect(second.status).toBe("none");
  });
});
