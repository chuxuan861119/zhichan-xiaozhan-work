import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { DraftService } from "../drafts/draft-service.js";
import { SettingsService } from "../settings/settings-service.js";
import type {
  DataImportJournalPhase,
  DataImportJournalRecordInput,
} from "./data-import-journal.js";
import { DataImportJournal } from "./data-import-journal.js";
import { DataImportRecoveryService } from "./data-import-recovery-service.js";
import type { PreparedFullDataImport } from "./full-data-import-service.js";
import {
  LibraryImportSwapCoordinator,
  type LibraryImportSwapCoordinatorOptions,
  type LibraryImportSwapFailurePoint,
} from "./library-import-swap-coordinator.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PACKAGE_ID = "223e4567-e89b-42d3-a456-426614174000";
const createdRoots: string[] = [];
// These fault-injection cases repeatedly use Windows' real no-replace PowerShell move and flush.
const durableWindowsRoundTripTimeout = process.platform === "win32" ? 25_000 : 5_000;

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "library-import-swap-"));
  createdRoots.push(root);
  const applicationDataRoot = path.join(root, "application-data");
  const libraryParent = path.join(applicationDataRoot, "store");
  const libraryRoot = path.join(libraryParent, "Library");
  const userDataRoot = path.join(root, "user-data");
  const stagingRoot = path.join(libraryParent, `.import-staging-${OPERATION_ID}`);
  const stagingLibraryPath = path.join(stagingRoot, "library");
  const stagingUserRoot = path.join(
    path.dirname(userDataRoot),
    `.import-user-data-${OPERATION_ID}`,
  );
  const stagingDraftsPath = path.join(stagingUserRoot, "drafts");
  const settingsCandidatePath = path.join(
    stagingUserRoot,
    `settings-candidate-${OPERATION_ID}.json`,
  );
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(path.join(libraryRoot, "library"), { recursive: true });
  await mkdir(path.join(stagingLibraryPath, "library"), { recursive: true });
  await mkdir(stagingDraftsPath, { recursive: true });
  await mkdir(path.join(userDataRoot, "drafts"), { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(path.join(libraryRoot, "library", "old.txt"), "old");
  await writeFile(path.join(stagingLibraryPath, "library", "new.txt"), "new");
  await writeFile(stagingDraftsPath, "").catch(() => undefined);
  await writeFile(settingsCandidatePath, '{"candidate":true}\n');
  await writeFile(path.join(userDataRoot, "settings.json"), '{"current":true}\n');
  const stagingInfo = await lstat(stagingRoot, { bigint: true });
  const stagingUserInfo = await lstat(stagingUserRoot, { bigint: true });

  const phases: string[] = [];
  const journal = {
    async create(record: DataImportJournalRecordInput) {
      phases.push(`${record.phase}:${record.operationId}`);
      return record;
    },
    async advance(phase: DataImportJournalPhase) {
      phases.push(phase);
      return { phase };
    },
  };
  const prepared = {
    operationId: OPERATION_ID,
    packageId: PACKAGE_ID,
    manifest: {
      packageId: PACKAGE_ID,
      packageFormatVersion: 2,
      payloadSha256: "a".repeat(64),
      totalOriginalBytes: 1,
      exportedAt: "2026-08-16T00:00:00.000Z",
      summary: {
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 0,
      },
    },
    preview: {} as PreparedFullDataImport["preview"],
    stagingLibraryPath,
    stagingDraftsPath,
    settingsCandidatePath,
    settingsCandidateIntegrity: {
      sha256: "a".repeat(64),
    } as PreparedFullDataImport["settingsCandidateIntegrity"],
    stagingDatabaseIntegrity: {
      size: "1",
      sha256: "b".repeat(64),
    } as PreparedFullDataImport["stagingDatabaseIntegrity"],
    libraryStagingCapability: {
      root: stagingRoot,
      identity: {
        device: String(stagingInfo.dev),
        inode: String(stagingInfo.ino),
        birthtimeNs: String(stagingInfo.birthtimeNs),
      },
    },
    userDataStagingCapability: {
      root: stagingUserRoot,
      identity: {
        device: String(stagingUserInfo.dev),
        inode: String(stagingUserInfo.ino),
        birthtimeNs: String(stagingUserInfo.birthtimeNs),
      },
    },
  } as PreparedFullDataImport;
  const options: LibraryImportSwapCoordinatorOptions = {
    libraryRoot,
    userDataRoot,
    applicationDataRoot,
    prepared,
    journal,
    ensureCurrentState: async () => undefined,
    inspectEmptyLibrary: async () => ({ empty: true, blockers: [] }),
    validateStaging: async (prepared) => prepared.manifest.summary,
    closeRuntime: async () => undefined,
  };
  return { options, phases, libraryRoot, userDataRoot, stagingRoot };
}

describe.sequential("LibraryImportSwapCoordinator", () => {
  test.sequential.each(
    (["library", "drafts", "settings"] as const).flatMap((root) =>
      (["before-restore", "after-restore", "unknown-replacement"] as const).map((point) => ({
        root,
        point,
      })),
    ),
  )(
    "resumes rollback safely at $root / $point",
    async ({ root: restoredRoot, point }) => {
      const value = await fixture();
      await writeFile(path.join(value.userDataRoot, "drafts", "old.txt"), "old-draft");
      const journal = new DataImportJournal({
        applicationDataRoot: value.options.applicationDataRoot,
        libraryRoot: value.libraryRoot,
        userDataRoot: value.userDataRoot,
      });
      await new LibraryImportSwapCoordinator({
        ...value.options,
        journal,
      }).commit();
      const targets = {
        library: value.libraryRoot,
        drafts: path.join(value.userDataRoot, "drafts"),
        settings: path.join(value.userDataRoot, "settings.json"),
      };
      const recoveryOptions = {
        journal,
        libraryRoot: value.libraryRoot,
        userDataRoot: value.userDataRoot,
        applicationDataRoot: value.options.applicationDataRoot,
      };
      const interrupted = await new DataImportRecoveryService({
        ...recoveryOptions,
        validateInstalled: async () => false,
        fileSystem: {
          rename: async (source, target) => {
            if (target === targets[restoredRoot] && point === "before-restore")
              throw new Error("interrupted before restore");
            await rename(source, target);
            if (target === targets[restoredRoot]) throw new Error("interrupted after restore");
          },
        },
      }).recover();
      expect(interrupted.status).toBe("manual-safe-recovery");
      expect((await journal.read())?.phase).toBe("restart-validation-pending");
      if (point === "unknown-replacement") {
        const target = targets[restoredRoot];
        await rename(target, `${target}.preserved`);
        if (restoredRoot === "settings") await writeFile(target, "unknown");
        else {
          await mkdir(target);
          await writeFile(path.join(target, "unknown.txt"), "unknown");
        }
      }
      const validateInstalled = vi.fn(async () => true);
      const recovered = await new DataImportRecoveryService({
        ...recoveryOptions,
        validateInstalled,
      }).recover();
      if (point === "unknown-replacement") {
        expect(recovered.status).toBe("manual-safe-recovery");
        expect(validateInstalled).not.toHaveBeenCalled();
        expect(
          await readFile(
            restoredRoot === "settings"
              ? targets.settings
              : path.join(targets[restoredRoot], "unknown.txt"),
            "utf8",
          ),
        ).toBe("unknown");
        expect((await journal.read())?.phase).toBe("restart-validation-pending");
        return;
      }
      expect(recovered.status).toBe("rolled-back");
      expect(validateInstalled).not.toHaveBeenCalled();
      expect(await readFile(path.join(value.libraryRoot, "library", "old.txt"), "utf8")).toBe(
        "old",
      );
      expect(await readFile(path.join(targets.drafts, "old.txt"), "utf8")).toBe("old-draft");
      expect(await readFile(targets.settings, "utf8")).toBe('{"current":true}\n');
      expect(await journal.read()).toBeUndefined();
    },
    durableWindowsRoundTripTimeout,
  );
  test.sequential.each([
    undefined,
    "after-old-polish-history-move",
    "after-new-polish-history-install",
  ] as const)(
    "includes polish history in durable swap and failed-validation rollback (%s)",
    async (failurePoint) => {
      const value = await fixture();
      const live = path.join(value.userDataRoot, "text-polish-history");
      const staged = path.join(
        path.dirname(value.options.prepared.stagingDraftsPath),
        "text-polish-history",
      );
      await mkdir(live);
      await mkdir(staged);
      await writeFile(path.join(live, "old.txt"), "old-history");
      await writeFile(path.join(staged, "new.txt"), "new-history");
      const journal = new DataImportJournal({
        applicationDataRoot: value.options.applicationDataRoot,
        libraryRoot: value.libraryRoot,
        userDataRoot: value.userDataRoot,
      });
      const coordinator = new LibraryImportSwapCoordinator({
        ...value.options,
        prepared: { ...value.options.prepared, stagingPolishHistoryPath: staged },
        journal,
      });
      if (failurePoint)
        await expect(coordinator.commit({ failurePoint })).rejects.toMatchObject({
          code: "IMPORT_RECOVERY_REQUIRED",
        });
      else {
        await coordinator.commit();
        expect(await readFile(path.join(live, "new.txt"), "utf8")).toBe("new-history");
      }
      if (!failurePoint) {
        const interrupted = await new DataImportRecoveryService({
          journal,
          libraryRoot: value.libraryRoot,
          userDataRoot: value.userDataRoot,
          applicationDataRoot: value.options.applicationDataRoot,
          validateInstalled: async () => false,
          fileSystem: {
            remove: async (target) => {
              if (target === value.libraryRoot) throw new Error("synthetic interrupted rollback");
              await rm(target, { recursive: true, force: false });
            },
          },
        }).recover();
        expect(interrupted.status).toBe("manual-safe-recovery");
        expect(await readFile(path.join(live, "old.txt"), "utf8")).toBe("old-history");
      }
      const recovered = await new DataImportRecoveryService({
        journal,
        libraryRoot: value.libraryRoot,
        userDataRoot: value.userDataRoot,
        applicationDataRoot: value.options.applicationDataRoot,
        validateInstalled: async () => false,
      }).recover();
      expect(recovered.status).toBe("rolled-back");
      expect(await readFile(path.join(live, "old.txt"), "utf8")).toBe("old-history");
      await expect(readFile(path.join(live, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    durableWindowsRoundTripTimeout,
  );
  test.sequential("finishes live empty-library inspection before closing its database runtime", async () => {
    const value = await fixture();
    let runtimeOpen = true;
    const inspectEmptyLibrary = vi.fn(async () => {
      if (!runtimeOpen) throw new Error("database runtime already closed");
      return { empty: true, blockers: [] };
    });
    const closeRuntime = vi.fn(async () => {
      runtimeOpen = false;
    });

    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        inspectEmptyLibrary,
        closeRuntime,
      }).commit(),
    ).resolves.toMatchObject({ phase: "restart-validation-pending" });
    expect(inspectEmptyLibrary).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(inspectEmptyLibrary.mock.invocationCallOrder[0]).toBeLessThan(
      closeRuntime.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test.sequential("distinguishes preflight rejection from a failure after runtime shutdown", async () => {
    const value = await fixture();
    const release = vi.fn(async () => {});
    const closeRuntime = vi.fn(async () => {});
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        lease: { prepared: value.options.prepared, release },
        closeRuntime,
        inspectEmptyLibrary: async () => ({ empty: false, blockers: [] }),
      }).commit(),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_EMPTY", restartRequired: false });
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("retryable", { settingsCandidateConsumed: false });
    release.mockClear();
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        lease: { prepared: value.options.prepared, release },
        closeRuntime: async () => {
          throw new Error("shutdown failed");
        },
      }).commit(),
    ).rejects.toMatchObject({ restartRequired: true });
    expect(release).toHaveBeenCalledWith("recovery-required", {
      settingsCandidateConsumed: false,
    });
  });

  test.sequential("atomically installs library, drafts and settings and leaves a release handoff", async () => {
    const value = await fixture();
    const result = await new LibraryImportSwapCoordinator(value.options).commit();
    expect(result).toMatchObject({
      operationId: OPERATION_ID,
      phase: "restart-validation-pending",
    });
    expect(value.phases).toEqual([
      `prepared:${OPERATION_ID}`,
      "old-library-moved",
      "new-library-installed",
      "drafts-installed",
      "settings-installed",
      "restart-validation-pending",
    ]);
    await expect(
      readFile(path.join(value.libraryRoot, "library", "new.txt"), "utf8"),
    ).resolves.toBe("new");
    await expect(readFile(path.join(value.userDataRoot, "settings.json"), "utf8")).resolves.toBe(
      '{"candidate":true}\n',
    );
  });

  test.sequential("materializes fresh-profile settings before the journal identity preflight", async () => {
    const value = await fixture();
    const settingsPath = path.join(value.userDataRoot, "settings.json");
    await unlink(settingsPath);
    await rm(path.join(value.userDataRoot, "drafts"), { recursive: true });
    const ensureCurrentState = vi.fn(async () => {
      await new SettingsService(settingsPath).ensurePersisted();
      await new DraftService(path.join(value.userDataRoot, "drafts")).ensureRoot();
    });

    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        ensureCurrentState,
      }).commit(),
    ).resolves.toMatchObject({ phase: "restart-validation-pending" });
    expect(ensureCurrentState).toHaveBeenCalledOnce();
    expect(value.phases[0]).toBe(`prepared:${OPERATION_ID}`);
  });

  test.sequential("commits a prepared import through the real durable journal", async () => {
    const value = await fixture();
    const journal = new DataImportJournal({
      applicationDataRoot: value.options.applicationDataRoot,
      libraryRoot: value.options.libraryRoot,
      userDataRoot: value.options.userDataRoot,
      createReparsePointProbe: () => ({
        assertSafe: async () => undefined,
        close: async () => undefined,
      }),
    });
    const result = await new LibraryImportSwapCoordinator({
      ...value.options,
      journal,
    }).commit();
    expect(result.phase).toBe("restart-validation-pending");
    await expect(journal.read()).resolves.toMatchObject({
      operationId: OPERATION_ID,
      phase: "restart-validation-pending",
      stagingDraftsPath: path.join(
        path.dirname(value.userDataRoot),
        `.import-user-data-${OPERATION_ID}`,
        "drafts",
      ),
    });
  });

  test.sequential("releases a prepared import lease after successful handoff", async () => {
    const value = await fixture();
    const release = vi.fn(async () => {});
    const result = await new LibraryImportSwapCoordinator({
      ...value.options,
      lease: { prepared: value.options.prepared, release },
    }).commit();
    expect(result.phase).toBe("restart-validation-pending");
    expect(release).not.toHaveBeenCalled();
    await result.releaseHandoff.release();
    expect(release).toHaveBeenCalledWith("released", { settingsCandidateConsumed: true });
  });

  test.sequential("fails closed when the platform lacks an atomic no-replace swap", async () => {
    const value = await fixture();
    await expect(
      new LibraryImportSwapCoordinator({ ...value.options, platform: "linux" }).commit(),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ATOMIC_SWAP" });
    expect(value.phases).toContain(`prepared:${OPERATION_ID}`);
    await expect(
      readFile(path.join(value.libraryRoot, "library", "old.txt"), "utf8"),
    ).resolves.toBe("old");
    await expect(
      readFile(path.join(value.stagingRoot, "library", "library", "new.txt"), "utf8"),
    ).resolves.toBe("new");
  });

  test.sequential("lets post-start validation hand off recovery-required", async () => {
    const value = await fixture();
    const release = vi.fn(async () => {});
    const result = await new LibraryImportSwapCoordinator({
      ...value.options,
      lease: { prepared: value.options.prepared, release },
    }).commit();
    await result.releaseHandoff.release("recovery-required");
    expect(release).toHaveBeenCalledWith("recovery-required", {
      settingsCandidateConsumed: true,
    });
  });

  test.sequential("retains recovery ownership when the first swap is blocked after shutdown", async () => {
    const value = await fixture();
    await mkdir(path.join(path.dirname(value.libraryRoot), `.import-rollback-${OPERATION_ID}`), {
      recursive: true,
    });
    const release = vi.fn(async () => {});
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        lease: { prepared: value.options.prepared, release },
      }).commit(),
    ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE", restartRequired: true });
    expect(value.phases).toEqual([`prepared:${OPERATION_ID}`]);
    expect(release).toHaveBeenCalledWith("recovery-required", {
      settingsCandidateConsumed: false,
    });
  });

  test.sequential("rejects a staging summary that does not match the prepared manifest", async () => {
    const value = await fixture();
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        validateStaging: async () => ({
          ...value.options.prepared.manifest.summary,
          documents: 1,
        }),
      }).commit(),
    ).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    expect(value.phases).toEqual([]);
  });

  test.sequential("checks cancellation again after the final pre-rename await", async () => {
    const value = await fixture();
    const controller = new AbortController();
    const validateStaging = async () => {
      controller.abort();
      return value.options.prepared.manifest.summary;
    };
    await expect(
      new LibraryImportSwapCoordinator({ ...value.options, validateStaging }).commit({
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(value.phases).toEqual([]);
  });

  test.sequential.each([
    "after-journal",
    "after-old-library-move",
    "after-new-library-install",
    "after-old-drafts-move",
    "after-new-drafts-install",
    "after-settings-backup",
    "after-settings-install",
  ] as LibraryImportSwapFailurePoint[])("persists recoverable state %s", async (failurePoint) => {
    const value = await fixture();
    const coordinator = new LibraryImportSwapCoordinator(value.options);
    await expect(coordinator.commit({ failurePoint })).rejects.toThrow();
    expect(value.phases.some((phase) => phase.startsWith("prepared:"))).toBe(true);
  });

  test.sequential("does not begin switching when cancellation is already requested", async () => {
    const value = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new LibraryImportSwapCoordinator(value.options).commit({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(value.phases).toEqual([]);
  });

  test.sequential("rejects a cross-volume staging library before writing the journal", async () => {
    const value = await fixture();
    const stagingPath = value.options.prepared.stagingLibraryPath;
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        fileSystem: {
          lstat: async (filePath) => {
            const info = await lstat(filePath, { bigint: true });
            if (filePath === stagingPath) {
              const altered = Object.create(info) as typeof info;
              Object.defineProperty(altered, "dev", { value: info.dev + 1n });
              return altered as never;
            }
            return info as never;
          },
        },
      }).commit(),
    ).rejects.toMatchObject({ code: "CROSS_VOLUME" });
    expect(value.phases).toEqual([]);
  });

  test.sequential("does not overwrite a pre-existing rollback directory", async () => {
    const value = await fixture();
    const rollbackPath = path.join(
      path.dirname(value.libraryRoot),
      `.import-rollback-${OPERATION_ID}`,
    );
    await mkdir(rollbackPath, { recursive: true });
    await expect(new LibraryImportSwapCoordinator(value.options).commit()).rejects.toMatchObject({
      code: "UNSAFE_OVERWRITE",
    });
    expect(value.phases.some((phase) => phase.startsWith("prepared:"))).toBe(true);
  });

  test.sequential("preserves a target created during the no-replace move", async () => {
    const value = await fixture();
    const rollbackPath = path.join(
      path.dirname(value.libraryRoot),
      `.import-rollback-${OPERATION_ID}`,
    );
    const competitorPath = path.join(rollbackPath, "competitor.txt");
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        fileSystem: {
          moveNoReplace: async () => {
            await mkdir(rollbackPath, { recursive: true });
            await writeFile(competitorPath, "competitor");
            throw Object.assign(new Error("target appeared"), { code: "EEXIST" });
          },
        },
      }).commit(),
    ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
    await expect(readFile(competitorPath, "utf8")).resolves.toBe("competitor");
    await expect(
      readFile(path.join(value.libraryRoot, "library", "old.txt"), "utf8"),
    ).resolves.toBe("old");
  });

  test.sequential("requires syncing both parents after a cross-parent move", async () => {
    const value = await fixture();
    const sourceParent = path.dirname(value.options.prepared.stagingLibraryPath);
    let sourceSyncAttempted = false;
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        fileSystem: {
          open: async (filePath, flags, mode) => {
            if (filePath === sourceParent) {
              sourceSyncAttempted = true;
              throw Object.assign(new Error("source parent sync failed"), { code: "EIO" });
            }
            return await open(filePath, flags, mode);
          },
        },
      }).commit(),
    ).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
    expect(sourceSyncAttempted).toBe(true);
  });

  test.sequential("preserves a settings target created during the no-replace move", async () => {
    const value = await fixture();
    const settingsPath = path.join(value.userDataRoot, "settings.json");
    const rollbackSettingsPath = path.join(
      value.userDataRoot,
      `settings-rollback-${OPERATION_ID}.json`,
    );
    let moveCount = 0;
    await expect(
      new LibraryImportSwapCoordinator({
        ...value.options,
        fileSystem: {
          moveNoReplace: async (source, target) => {
            moveCount += 1;
            if (target === settingsPath) {
              await writeFile(settingsPath, "competing settings\n");
              throw Object.assign(new Error("settings target appeared"), { code: "EEXIST" });
            }
            await rename(source, target);
          },
        },
      }).commit(),
    ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
    expect(moveCount).toBe(6);
    await expect(readFile(settingsPath, "utf8")).resolves.toBe("competing settings\n");
    await expect(readFile(rollbackSettingsPath, "utf8")).resolves.toBe('{"current":true}\n');
  });

  test.sequential.each(["library", "drafts", "settings"] as const)(
    "rejects a prepared import whose %s staging child is outside its owned root",
    async (child) => {
      const value = await fixture();
      const prepared = value.options.prepared;
      const alteredPrepared =
        child === "library"
          ? { ...prepared, stagingLibraryPath: path.join(value.stagingRoot, "other") }
          : child === "drafts"
            ? {
                ...prepared,
                stagingDraftsPath: path.join(path.dirname(prepared.stagingDraftsPath), "other"),
              }
            : {
                ...prepared,
                settingsCandidatePath: path.join(
                  path.dirname(prepared.settingsCandidatePath),
                  `settings-other-${OPERATION_ID}.json`,
                ),
              };
      if (child === "library") await mkdir(alteredPrepared.stagingLibraryPath, { recursive: true });
      if (child === "drafts") await mkdir(alteredPrepared.stagingDraftsPath, { recursive: true });
      if (child === "settings") await writeFile(alteredPrepared.settingsCandidatePath, "{}\n");
      await expect(
        new LibraryImportSwapCoordinator({
          ...value.options,
          prepared: alteredPrepared,
        }).commit(),
      ).rejects.toMatchObject({ code: "IMPORT_RECOVERY_REQUIRED" });
      expect(value.phases).toEqual([]);
    },
  );
});
