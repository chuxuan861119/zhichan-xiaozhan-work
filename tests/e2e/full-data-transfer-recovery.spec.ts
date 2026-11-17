import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  DataImportJournalPathIdentities,
  DataImportJournalPhase,
  DataImportJournalRecord,
} from "../../src/main/data-transfer/data-import-journal.js";
import { DataImportJournal } from "../../src/main/data-transfer/data-import-journal.js";
import {
  type DataImportRecoveryJournal,
  DataImportRecoveryService,
} from "../../src/main/data-transfer/data-import-recovery-service.js";
import {
  type EmptyLibraryInspectOptions,
  EmptyLibraryInspector,
} from "../../src/main/data-transfer/empty-library-inspector.js";
import type { PreparedFullDataImport } from "../../src/main/data-transfer/full-data-import-service.js";
import {
  LibraryImportSwapCoordinator,
  type LibraryImportSwapFailurePoint,
} from "../../src/main/data-transfer/library-import-swap-coordinator.js";
import { DraftService } from "../../src/main/drafts/draft-service.js";
import { LibraryDatabase } from "../../src/main/library/library-database.js";
import { SettingsService } from "../../src/main/settings/settings-service.js";
import { APPLICATION_DATA_DIRECTORY } from "../../src/shared/branding.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";
import { expect, test, type WorkbenchHarness } from "./helpers/workbench.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000091";

function identity(path: string) {
  const value = lstatSync(path, { bigint: true });
  return {
    device: String(value.dev),
    inode: String(value.ino),
    birthtimeNs: String(value.birthtimeNs),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
  };
}

async function createCrashLayout() {
  const root = await mkdtemp(join(tmpdir(), "data-transfer-recovery-e2e-"));
  const applicationDataRoot = join(root, "application-data");
  const libraryPath = join(applicationDataRoot, "Library");
  const userDataRoot = join(root, "user-data");
  const draftsPath = join(userDataRoot, "drafts");
  const stagingPath = join(applicationDataRoot, `.import-staging-${OPERATION_ID}`);
  const stagingLibraryPath = join(stagingPath, "library");
  const stagingUserDataRoot = join(root, `.import-user-data-${OPERATION_ID}`);
  const stagingDraftsPath = join(stagingUserDataRoot, "drafts");
  const settingsCandidatePath = join(
    stagingUserDataRoot,
    `settings-candidate-${OPERATION_ID}.json`,
  );
  const rollbackLibraryPath = join(applicationDataRoot, `.import-rollback-${OPERATION_ID}`);
  const rollbackDraftsPath = join(userDataRoot, `.drafts-rollback-${OPERATION_ID}`);
  const settingsPath = join(userDataRoot, "settings.json");
  const rollbackSettingsPath = join(userDataRoot, `settings-rollback-${OPERATION_ID}.json`);
  await Promise.all([
    mkdir(libraryPath, { recursive: true }),
    mkdir(draftsPath, { recursive: true }),
    mkdir(stagingLibraryPath, { recursive: true }),
    mkdir(stagingDraftsPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(libraryPath, "state.txt"), "original-library"),
    writeFile(join(draftsPath, "state.txt"), "original-drafts"),
    writeFile(settingsPath, "original-settings"),
    writeFile(join(stagingLibraryPath, "state.txt"), "imported-library"),
    writeFile(join(stagingDraftsPath, "state.txt"), "imported-drafts"),
    writeFile(settingsCandidatePath, "imported-settings"),
  ]);
  const pathIdentities: DataImportJournalPathIdentities = {
    stagingRoot: identity(stagingPath),
    stagingLibrary: identity(stagingLibraryPath),
    library: identity(libraryPath),
    stagingDraftsRoot: identity(stagingUserDataRoot),
    stagingDrafts: identity(stagingDraftsPath),
    drafts: identity(draftsPath),
    settingsCandidate: identity(settingsCandidatePath),
    settings: identity(settingsPath),
  };
  const record = (phase: DataImportJournalPhase): DataImportJournalRecord => ({
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
    settingsContentSha256: createHash("sha256").update("imported-settings").digest("hex"),
    pathIdentities,
    packageSummary: {
      packageId: "00000000-0000-4000-8000-000000000092",
      packageFormatVersion: 2,
      payloadSha256: "9".repeat(64),
      totalOriginalBytes: 48,
      exportedAt: "2026-08-17T00:00:00.000Z",
    },
  });
  return {
    root,
    applicationDataRoot,
    libraryPath,
    userDataRoot,
    draftsPath,
    stagingPath,
    stagingLibraryPath,
    stagingDraftsPath,
    settingsCandidatePath,
    rollbackLibraryPath,
    rollbackDraftsPath,
    settingsPath,
    rollbackSettingsPath,
    record,
  };
}

function memoryJournal(record: DataImportJournalRecord) {
  let current = record;
  let cleared = false;
  let quarantined = false;
  const journal: DataImportRecoveryJournal = {
    read: async () => (cleared || quarantined ? undefined : current),
    advance: async (phase) => {
      current = { ...current, phase };
      return current;
    },
    clear: async () => {
      cleared = true;
    },
    quarantine: async () => {
      quarantined = true;
      return `${process.cwd()}/quarantined-journal`;
    },
  };
  return { journal, isCleared: () => cleared, isQuarantined: () => quarantined };
}

async function state(path: string): Promise<string | null> {
  return await readFile(join(path, "state.txt"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

type DurableCrashTopology = Readonly<{
  liveLibrary: string | null;
  rollbackLibrary: string | null;
  stagingLibrary: string | null;
  liveDrafts: string | null;
  rollbackDrafts: string | null;
  stagingDrafts: string | null;
  settingsZoom: number | null;
  rollbackSettingsZoom: number | null;
  candidateSettingsZoom: number | null;
}>;

type DurableCrashWindow = Readonly<{
  name: string;
  failurePoint?: LibraryImportSwapFailurePoint;
  journalPhase: DataImportJournalPhase;
  recoveryStatus: "abandoned" | "rolled-back";
  topology: DurableCrashTopology;
}>;

const ORIGINAL_ZOOM = DEFAULT_APP_SETTINGS.zoomPercent;
const IMPORTED_ZOOM = 150;

const DURABLE_CRASH_WINDOWS: readonly DurableCrashWindow[] = [
  {
    name: "after-journal",
    failurePoint: "after-journal",
    journalPhase: "prepared",
    recoveryStatus: "abandoned",
    topology: {
      liveLibrary: "original-library",
      rollbackLibrary: null,
      stagingLibrary: "imported-library",
      liveDrafts: "original-drafts",
      rollbackDrafts: null,
      stagingDrafts: "imported-drafts",
      settingsZoom: ORIGINAL_ZOOM,
      rollbackSettingsZoom: null,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-old-library-move",
    failurePoint: "after-old-library-move",
    journalPhase: "prepared",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: null,
      rollbackLibrary: "original-library",
      stagingLibrary: "imported-library",
      liveDrafts: "original-drafts",
      rollbackDrafts: null,
      stagingDrafts: "imported-drafts",
      settingsZoom: ORIGINAL_ZOOM,
      rollbackSettingsZoom: null,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-new-library-install",
    failurePoint: "after-new-library-install",
    journalPhase: "new-library-installed",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: "original-drafts",
      rollbackDrafts: null,
      stagingDrafts: "imported-drafts",
      settingsZoom: ORIGINAL_ZOOM,
      rollbackSettingsZoom: null,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-old-drafts-move",
    failurePoint: "after-old-drafts-move",
    journalPhase: "new-library-installed",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: null,
      rollbackDrafts: "original-drafts",
      stagingDrafts: "imported-drafts",
      settingsZoom: ORIGINAL_ZOOM,
      rollbackSettingsZoom: null,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-new-drafts-install",
    failurePoint: "after-new-drafts-install",
    journalPhase: "drafts-installed",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: "imported-drafts",
      rollbackDrafts: "original-drafts",
      stagingDrafts: null,
      settingsZoom: ORIGINAL_ZOOM,
      rollbackSettingsZoom: null,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-settings-backup",
    failurePoint: "after-settings-backup",
    journalPhase: "drafts-installed",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: "imported-drafts",
      rollbackDrafts: "original-drafts",
      stagingDrafts: null,
      settingsZoom: null,
      rollbackSettingsZoom: ORIGINAL_ZOOM,
      candidateSettingsZoom: IMPORTED_ZOOM,
    },
  },
  {
    name: "after-settings-install-before-restart-validation-pending",
    failurePoint: "after-settings-install",
    journalPhase: "settings-installed",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: "imported-drafts",
      rollbackDrafts: "original-drafts",
      stagingDrafts: null,
      settingsZoom: IMPORTED_ZOOM,
      rollbackSettingsZoom: ORIGINAL_ZOOM,
      candidateSettingsZoom: null,
    },
  },
  {
    name: "after-restart-validation-pending",
    journalPhase: "restart-validation-pending",
    recoveryStatus: "rolled-back",
    topology: {
      liveLibrary: "imported-library",
      rollbackLibrary: "original-library",
      stagingLibrary: null,
      liveDrafts: "imported-drafts",
      rollbackDrafts: "original-drafts",
      stagingDrafts: null,
      settingsZoom: IMPORTED_ZOOM,
      rollbackSettingsZoom: ORIGINAL_ZOOM,
      candidateSettingsZoom: null,
    },
  },
];

async function settingsZoom(path: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { zoomPercent?: unknown };
    return typeof parsed.zoomPercent === "number" ? parsed.zoomPercent : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function durableLibraryState(
  path: string,
  originalIdentity: Readonly<{ dev: bigint; ino: bigint }>,
): Promise<string | null> {
  const marker = await state(path);
  if (marker !== null) return marker;
  try {
    const value = await lstat(path, { bigint: true });
    return value.dev === originalIdentity.dev && value.ino === originalIdentity.ino
      ? "original-library"
      : "unknown-library";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function durableDraftsState(
  path: string,
  originalIdentity: Readonly<{ dev: bigint; ino: bigint }>,
): Promise<string | null> {
  const marker = await state(path);
  if (marker !== null) return marker;
  try {
    const value = await lstat(path, { bigint: true });
    return value.dev === originalIdentity.dev && value.ino === originalIdentity.ino
      ? "original-drafts"
      : "unknown-drafts";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function expectDurableTopology(
  paths: Readonly<{
    library: string;
    rollbackLibrary: string;
    stagingLibrary: string;
    drafts: string;
    rollbackDrafts: string;
    stagingDrafts: string;
    settings: string;
    rollbackSettings: string;
    settingsCandidate: string;
  }>,
  originalLibraryIdentity: Readonly<{ dev: bigint; ino: bigint }>,
  originalDraftsIdentity: Readonly<{ dev: bigint; ino: bigint }>,
  expected: DurableCrashTopology,
): Promise<void> {
  expect({
    liveLibrary: await durableLibraryState(paths.library, originalLibraryIdentity),
    rollbackLibrary: await durableLibraryState(paths.rollbackLibrary, originalLibraryIdentity),
    stagingLibrary: await durableLibraryState(paths.stagingLibrary, originalLibraryIdentity),
    liveDrafts: await durableDraftsState(paths.drafts, originalDraftsIdentity),
    rollbackDrafts: await durableDraftsState(paths.rollbackDrafts, originalDraftsIdentity),
    stagingDrafts: await durableDraftsState(paths.stagingDrafts, originalDraftsIdentity),
    settingsZoom: await settingsZoom(paths.settings),
    rollbackSettingsZoom: await settingsZoom(paths.rollbackSettings),
    candidateSettingsZoom: await settingsZoom(paths.settingsCandidate),
  }).toEqual(expected);
}

function stableIdentity(value: BigIntStats) {
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}

async function createDurableCrashFixture(workbench: WorkbenchHarness) {
  const profile = await workbench.launchProfile("durable-recovery");
  await profile.application.firstWindow();
  await profile.application.close();
  await workbench.removeTransientProfileMarkers(profile);
  const applicationDataRoot = join(profile.localAppData, APPLICATION_DATA_DIRECTORY);
  const stagingRoot = join(dirname(profile.libraryRoot), `.import-staging-${OPERATION_ID}`);
  const stagingLibraryPath = join(stagingRoot, "library");
  const stagingUserDataRoot = join(dirname(profile.userData), `.import-user-data-${OPERATION_ID}`);
  const stagingDraftsPath = join(stagingUserDataRoot, "drafts");
  const settingsCandidatePath = join(
    stagingUserDataRoot,
    `settings-candidate-${OPERATION_ID}.json`,
  );
  const draftsPath = join(profile.userData, "drafts");
  const settingsPath = join(profile.userData, "settings.json");
  const rollbackLibraryPath = join(
    dirname(profile.libraryRoot),
    `.import-rollback-${OPERATION_ID}`,
  );
  const rollbackDraftsPath = join(profile.userData, `.drafts-rollback-${OPERATION_ID}`);
  const rollbackSettingsPath = join(profile.userData, `settings-rollback-${OPERATION_ID}.json`);
  await Promise.all([
    new DraftService(draftsPath).ensureRoot(),
    new SettingsService(settingsPath).ensurePersisted(),
    mkdir(stagingLibraryPath, { recursive: true }),
    mkdir(stagingDraftsPath, { recursive: true }),
  ]);
  const importedSettings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
  importedSettings.zoomPercent = IMPORTED_ZOOM;
  const importedSettingsBytes = `${JSON.stringify(importedSettings, null, 2)}\n`;
  await Promise.all([
    writeFile(join(stagingLibraryPath, "state.txt"), "imported-library"),
    writeFile(join(stagingDraftsPath, "state.txt"), "imported-drafts"),
    writeFile(settingsCandidatePath, importedSettingsBytes, "utf8"),
  ]);
  const [stagingIdentity, stagingUserIdentity, originalLibrary, originalDrafts, originalSettings] =
    await Promise.all([
      lstat(stagingRoot, { bigint: true }),
      lstat(stagingUserDataRoot, { bigint: true }),
      lstat(profile.libraryRoot, { bigint: true }),
      lstat(draftsPath, { bigint: true }),
      lstat(settingsPath, { bigint: true }),
    ]);
  const summary = {
    activePatents: 0,
    trashedPatents: 0,
    documents: 0,
    legacyDrafts: 0,
    snapshots: 0,
    assets: 0,
    flowchartProjects: 0,
    totalBytes: 0,
  };
  const prepared = {
    operationId: OPERATION_ID,
    packageId: "00000000-0000-4000-8000-000000000092",
    manifest: {
      packageId: "00000000-0000-4000-8000-000000000092",
      packageFormatVersion: 2,
      payloadSha256: "9".repeat(64),
      totalOriginalBytes: 0,
      exportedAt: "2026-08-17T00:00:00.000Z",
      summary,
    },
    preview: {} as PreparedFullDataImport["preview"],
    stagingLibraryPath,
    stagingDraftsPath,
    settingsCandidatePath,
    settingsCandidateIntegrity: {
      sha256: createHash("sha256").update(importedSettingsBytes).digest("hex"),
    } as PreparedFullDataImport["settingsCandidateIntegrity"],
    stagingDatabaseIntegrity: {
      size: "0",
      sha256: "b".repeat(64),
    } as PreparedFullDataImport["stagingDatabaseIntegrity"],
    libraryStagingCapability: {
      root: stagingRoot,
      identity: {
        device: String(stagingIdentity.dev),
        inode: String(stagingIdentity.ino),
        birthtimeNs: String(stagingIdentity.birthtimeNs),
      },
    },
    userDataStagingCapability: {
      root: stagingUserDataRoot,
      identity: {
        device: String(stagingUserIdentity.dev),
        inode: String(stagingUserIdentity.ino),
        birthtimeNs: String(stagingUserIdentity.birthtimeNs),
      },
    },
  } as unknown as PreparedFullDataImport;
  const inspectEmptyLibrary = async (options: EmptyLibraryInspectOptions = {}) => {
    const database = LibraryDatabase.openReadOnly(join(profile.libraryRoot, "library.sqlite3"));
    try {
      database.read((connection) => connection.prepare("SELECT 1").get());
      return await new EmptyLibraryInspector({
        libraryRoot: profile.libraryRoot,
        userDataRoot: profile.userData,
        applicationDataRoot,
        database,
      }).inspect(options);
    } finally {
      database.close();
    }
  };
  const initialInspection = await inspectEmptyLibrary({
    ownedImportStaging: prepared.libraryStagingCapability,
  });
  const journal = new DataImportJournal({
    applicationDataRoot,
    libraryRoot: profile.libraryRoot,
    userDataRoot: profile.userData,
  });
  const coordinator = new LibraryImportSwapCoordinator({
    libraryRoot: profile.libraryRoot,
    userDataRoot: profile.userData,
    applicationDataRoot,
    prepared,
    journal,
    ensureCurrentState: async () => {
      await Promise.all([
        new SettingsService(settingsPath).ensurePersisted(),
        new DraftService(draftsPath).ensureRoot(),
      ]);
    },
    inspectEmptyLibrary,
    validateStaging: async () => summary,
    closeRuntime: async () => undefined,
  });
  return {
    profile,
    applicationDataRoot,
    journal,
    coordinator,
    initialInspection,
    paths: {
      library: profile.libraryRoot,
      rollbackLibrary: rollbackLibraryPath,
      stagingLibrary: stagingLibraryPath,
      drafts: draftsPath,
      rollbackDrafts: rollbackDraftsPath,
      stagingDrafts: stagingDraftsPath,
      settings: settingsPath,
      rollbackSettings: rollbackSettingsPath,
      settingsCandidate: settingsCandidatePath,
    },
    originalIdentities: {
      library: stableIdentity(originalLibrary),
      drafts: stableIdentity(originalDrafts),
      settings: stableIdentity(originalSettings),
    },
  };
}

test.describe("full data import crash recovery", () => {
  test("profile relaunch rejects a self-consistent path outside its isolated profile container", async ({
    workbench,
  }) => {
    const forgedRoot = resolve(workbench.root, "outside-profiles");
    let unexpectedLaunch: Awaited<ReturnType<typeof workbench.relaunchProfile>> | undefined;
    let rejection: unknown;
    try {
      unexpectedLaunch = await workbench.relaunchProfile({
        name: "..\\outside-profiles",
        root: forgedRoot,
        userData: join(forgedRoot, "user-data"),
        localAppData: join(forgedRoot, "local-app-data"),
        libraryRoot: join(forgedRoot, "library"),
        netLog: join(forgedRoot, "net-log.json"),
        application: undefined as never,
      });
    } catch (error) {
      rejection = error;
    } finally {
      await unexpectedLaunch?.application.close().catch(() => undefined);
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("隔离配置名称无效");
  });

  test("recovers every durable swap boundary without mixing original and imported roots", async () => {
    const phases = [
      "prepared",
      "old-library-moved",
      "new-library-installed",
      "settings-installed",
      "restart-validation-pending",
    ] as const;

    for (const phase of phases) {
      const fixture = await createCrashLayout();
      try {
        if (phase !== "prepared") {
          await rename(fixture.libraryPath, fixture.rollbackLibraryPath);
        }
        if (
          phase === "new-library-installed" ||
          phase === "settings-installed" ||
          phase === "restart-validation-pending"
        ) {
          await rename(fixture.stagingLibraryPath, fixture.libraryPath);
        }
        if (phase === "settings-installed" || phase === "restart-validation-pending") {
          await rename(fixture.draftsPath, fixture.rollbackDraftsPath);
          await rename(fixture.stagingDraftsPath, fixture.draftsPath);
          await rename(fixture.settingsPath, fixture.rollbackSettingsPath);
          await rename(fixture.settingsCandidatePath, fixture.settingsPath);
        }
        const journal = memoryJournal(fixture.record(phase));
        const result = await new DataImportRecoveryService({
          journal: journal.journal,
          libraryRoot: fixture.libraryPath,
          userDataRoot: fixture.userDataRoot,
          applicationDataRoot: fixture.applicationDataRoot,
          isFormalLibraryEmpty: async () => true,
          validateInstalled: async () => true,
        }).recover();

        const roots = [await state(fixture.libraryPath), await state(fixture.draftsPath)];
        if (result.status === "recovered") {
          expect(roots).toEqual(["imported-library", "imported-drafts"]);
          await expect(readFile(fixture.settingsPath, "utf8")).resolves.toBe("imported-settings");
        } else {
          expect(["abandoned", "rolled-back"]).toContain(result.status);
          expect(roots).toEqual(["original-library", "original-drafts"]);
          await expect(readFile(fixture.settingsPath, "utf8")).resolves.toBe("original-settings");
        }
        expect(roots).not.toEqual(["imported-library", "original-drafts"]);
        expect(roots).not.toEqual(["original-library", "imported-drafts"]);
        expect(journal.isCleared()).toBe(true);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("damaged recovery journal enters manual-safe mode and retains every candidate", async () => {
    const fixture = await createCrashLayout();
    try {
      const candidates = [
        fixture.libraryPath,
        fixture.stagingPath,
        fixture.stagingDraftsPath,
        fixture.settingsCandidatePath,
      ];
      const journal: DataImportRecoveryJournal = {
        read: async () => {
          throw new Error("damaged journal");
        },
        advance: async () => {
          throw new Error("advance must not run");
        },
        clear: async () => {
          throw new Error("clear must not run");
        },
        quarantine: async () => `${fixture.applicationDataRoot}/quarantined-journal`,
      };
      const before = await Promise.all(candidates.map(async (path) => (await stat(path)).isFile()));
      const result = await new DataImportRecoveryService({
        journal,
        libraryRoot: fixture.libraryPath,
        userDataRoot: fixture.userDataRoot,
        applicationDataRoot: fixture.applicationDataRoot,
      }).recover();

      expect(result.status).toBe("manual-safe-recovery");
      expect(
        await Promise.all(candidates.map(async (path) => (await stat(path)).isFile())),
      ).toEqual(before);
      expect(dirname(fixture.settingsCandidatePath)).toBe(dirname(fixture.stagingDraftsPath));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("corrupt durable journal starts the application read-only and keeps recovery candidates", async ({
    workbench,
  }) => {
    const first = await workbench.launchProfile("manual-safe-recovery");
    await first.application.close();
    const applicationDataRoot = join(first.localAppData, APPLICATION_DATA_DIRECTORY);
    const journalPath = join(applicationDataRoot, "pending-data-import.json");
    const stagingCandidate = join(applicationDataRoot, `.import-staging-${OPERATION_ID}`);
    const draftCandidate = join(first.userData, `.drafts-rollback-${OPERATION_ID}`);
    await Promise.all([
      mkdir(stagingCandidate, { recursive: true }),
      mkdir(draftCandidate, { recursive: true }),
      writeFile(journalPath, "{not-valid-json", "utf8"),
    ]);

    const restarted = await workbench.launchProfile("manual-safe-recovery");
    try {
      const page = await restarted.application.firstWindow();
      const report = await page.evaluate(async () => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        return await api.application.getStartupRecoveryReport?.();
      });
      expect(report).toMatchObject({
        ok: true,
        value: { mode: "read-only", dataImportRecovery: "manual-safe-recovery" },
      });
      await expect(page.getByRole("alert", { name: "完整数据迁移需要人工恢复" })).toBeVisible();
      await expect(stat(stagingCandidate)).resolves.toBeDefined();
      await expect(stat(draftCandidate)).resolves.toBeDefined();
      const quarantined = (await readdir(applicationDataRoot)).filter((name) =>
        name.startsWith("pending-data-import.json.failed-"),
      );
      expect(quarantined).toHaveLength(1);
      await expect(readFile(join(applicationDataRoot, quarantined[0]!), "utf8")).resolves.toBe(
        "{not-valid-json",
      );
      await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
      // Exercise the user's window-close path and keep the inspector connected
      // until async shutdown ends (ElectronApplication.close disconnects it early).
      const recoveryProcess = restarted.application.process();
      await restarted.application.evaluate(({ BaseWindow }) => {
        const window = BaseWindow.getAllWindows()[0];
        if (!window) throw new Error("recovery window missing");
        window.close();
      });
      if (process.platform === "darwin") {
        await restarted.application.evaluate(({ app }) => app.quit());
      }
      await expect.poll(() => recoveryProcess.exitCode, { timeout: 10_000 }).not.toBeNull();
    } finally {
      await restarted.application.close().catch(() => undefined);
    }
  });

  for (const crashWindow of DURABLE_CRASH_WINDOWS) {
    test(`a new application process recovers the durable ${crashWindow.name} window without mixed state`, async ({
      workbench,
    }) => {
      const fixture = await createDurableCrashFixture(workbench);
      expect(fixture.initialInspection).toEqual({ empty: true, blockers: [] });
      if (crashWindow.failurePoint) {
        await expect(
          fixture.coordinator.commit({ failurePoint: crashWindow.failurePoint }),
        ).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
      } else {
        await expect(fixture.coordinator.commit()).resolves.toMatchObject({
          phase: "restart-validation-pending",
        });
      }
      await expect(fixture.journal.read()).resolves.toMatchObject({
        phase: crashWindow.journalPhase,
      });
      await expectDurableTopology(
        fixture.paths,
        fixture.originalIdentities.library,
        fixture.originalIdentities.drafts,
        crashWindow.topology,
      );

      const restarted = await workbench.relaunchProfile(fixture.profile);
      try {
        const page = await restarted.application.firstWindow();
        const report = await page.evaluate(async () => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          return await api.application.getStartupRecoveryReport?.();
        });
        expect(report).toMatchObject({
          ok: true,
          value: {
            mode: "read-write",
            dataImportRecovery: crashWindow.recoveryStatus,
          },
        });
        const finalState = [
          await durableLibraryState(fixture.paths.library, fixture.originalIdentities.library),
          await durableDraftsState(fixture.paths.drafts, fixture.originalIdentities.drafts),
          await settingsZoom(fixture.paths.settings),
        ];
        expect([
          ["original-library", "original-drafts", ORIGINAL_ZOOM],
          ["imported-library", "imported-drafts", IMPORTED_ZOOM],
        ]).toContainEqual(finalState);
        if (
          crashWindow.recoveryStatus === "rolled-back" ||
          crashWindow.recoveryStatus === "abandoned"
        ) {
          expect(finalState).toEqual(["original-library", "original-drafts", ORIGINAL_ZOOM]);
          const [library, drafts, settings] = await Promise.all([
            lstat(fixture.paths.library, { bigint: true }),
            lstat(fixture.paths.drafts, { bigint: true }),
            lstat(fixture.paths.settings, { bigint: true }),
          ]);
          expect({
            library: stableIdentity(library),
            drafts: stableIdentity(drafts),
            settings: stableIdentity(settings),
          }).toEqual(fixture.originalIdentities);
        }
        await expect(
          stat(join(fixture.applicationDataRoot, "pending-data-import.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(fixture.paths.rollbackLibrary)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(fixture.paths.rollbackDrafts)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(fixture.paths.rollbackSettings)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await restarted.application.close().catch(() => undefined);
      }
    });
  }
});
