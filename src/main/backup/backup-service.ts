import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrowserWindow } from "electron";
import type {
  BackupConfigureRequest,
  BackupDocumentType,
  BackupEntry,
  BackupMigrationReport,
  BackupOperationStatus,
  BackupRestoreResult,
  BackupRunResult,
  BackupSettings,
  BackupStatus,
  BackupTarget,
  BackupTrigger,
} from "../../shared/backup/model.js";
import { APPLICATION_NAME } from "../../shared/branding.js";
import type { AppSettings } from "../../shared/settings/model.js";
import { AppOperationError } from "../app-operation-error.js";
import { installNewFileWithoutClobber } from "../documents/file-service.js";
import { usesHarmonyPublicFileCopy } from "../platform/harmony-public-files.js";
import type { SettingsService } from "../settings/settings-service.js";
import { backupFileError } from "./backup-errors.js";
import {
  type BackupNameInfo,
  backupNameToken,
  backupRelativeName,
  managedBackupIdentity,
  managedBackupTime,
} from "./backup-naming.js";

export type DocumentModifiedInfo = BackupNameInfo & {
  documentType: "library_document" | "patent";
  documentId: string;
  displayName: string;
  modifiedAt: string;
  revision: number;
};

export type BackupInspection = {
  documentType: BackupDocumentType;
  documentId: string;
  displayName: string;
  revision: number;
  createdAt?: string | undefined;
};

export type BackupDelegate = {
  listModified(): Promise<DocumentModifiedInfo[]>;
  backupOne(info: DocumentModifiedInfo, targetPath: string): Promise<void>;
  inspect(filePath: string): Promise<BackupInspection>;
  restoreOne(filePath: string): Promise<BackupRestoreResult>;
};

export type BackupServiceOptions = {
  beginBackgroundOperation?: () => () => void;
  settings: Pick<SettingsService, "read" | "update"> & Partial<Pick<SettingsService, "status">>;
  delegate: BackupDelegate;
};

export type BackupConfigurationGuard = {
  assertAuthorized(): void;
  beforeSettingsWrite(current: AppSettings): void;
};
export type BackupRunGuard = {
  assertAuthorized(): void;
  beforeRun(current: AppSettings): void;
};

type HealthyBackupBaseline = {
  revision: number;
  filePath: string;
  verifiedFileState?: string;
};

async function copyBackupExclusive(source: string, target: string): Promise<void> {
  if (usesHarmonyPublicFileCopy(target)) {
    await installNewFileWithoutClobber(source, target);
  } else {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

function backupModifiedAt(path: string, fallback: Date): Date {
  return (usesHarmonyPublicFileCopy(path) ? managedBackupTime(path) : undefined) ?? fallback;
}

function backupFileName(folder: string, info: BackupNameInfo, time: Date, token?: string): string {
  return backupRelativeName(info, time, token, usesHarmonyPublicFileCopy(folder));
}

async function preserveBackupTimes(path: string, atime: Date, mtime: Date): Promise<void> {
  // Public storage rejects both utime and futime. The managed filename carries
  // the backup time used by the UI; other filesystems retain their exact times.
  if (usesHarmonyPublicFileCopy(path) && managedBackupTime(path)) return;
  await utimes(path, atime, mtime);
}

async function backupFileState(filePath: string): Promise<string> {
  const value = await lstat(filePath, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink()) throw new Error("备份文件状态异常");
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

export class BackupService {
  readonly #settings: Pick<SettingsService, "read" | "update"> &
    Partial<Pick<SettingsService, "status">>;
  readonly #delegate: BackupDelegate;

  #timerId: ReturnType<typeof setInterval> | undefined;
  #initialTimerId: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #runInFlight: Promise<BackupRunResult> | undefined;
  #queuedRuns = new Set<{ trigger: BackupTrigger; cancelRequested: boolean }>();
  #publishingFiles = new Set<string>();
  #scheduledSettings: BackupSettings | undefined;
  #suspended = false;
  #resumeSettings: BackupSettings | undefined;
  #lastAttemptAt: string | null = null;
  #lastBackupAt: string | null = null;
  #nextBackupAt: string | null = null;
  #lastRunSuccessCount = 0;
  #lastRunFailureCount = 0;
  #lastError: string | null = null;
  #pendingFailures = new Map<string, string>();
  #configuring = false;
  #configurationDone: Promise<void> | undefined;
  #shuttingDown = false;
  #exitDrain: Promise<BackupRunResult> | undefined;
  #targetRuns = new Map<string, { again: boolean; promise: Promise<BackupRunResult> }>();
  #lastBackupPerDoc = new Map<string, HealthyBackupBaseline>();
  #operationStatus: BackupOperationStatus = {
    running: false,
    trigger: null,
    totalCount: 0,
    completedCount: 0,
    currentDisplayName: null,
    cancelRequested: false,
  };

  readonly beginBackgroundOperation: (() => () => void) | undefined;
  constructor(options: BackupServiceOptions) {
    this.beginBackgroundOperation = options.beginBackgroundOperation;
    this.#settings = options.settings;
    this.#delegate = options.delegate;
  }

  async status(settings?: BackupSettings): Promise<BackupStatus> {
    const bs = settings ?? (await this.#settings.read()).backup;
    const settingsWarning = this.#settings.status?.().message ?? null;
    return {
      enabled: bs.enabled,
      folder: bs.folder,
      intervalMinutes: bs.intervalMinutes,
      lastAttemptAt: this.#lastAttemptAt,
      lastBackupAt: this.#lastBackupAt,
      nextBackupAt: this.#nextBackupAt,
      lastRunSuccessCount: this.#lastRunSuccessCount,
      lastRunFailureCount: this.#lastRunFailureCount,
      lastError: (this.#lastError ?? settingsWarning)?.slice(0, 2_000) || null,
    };
  }

  async initialize(): Promise<void> {
    let appSettings: Awaited<ReturnType<BackupServiceOptions["settings"]["read"]>>;
    try {
      appSettings = await this.#settings.read();
    } catch (error) {
      this.#recordRunFailure(error);
      return;
    }
    const settings = appSettings.backup;
    if (!settings.folder) return;
    if (settings.enabled) {
      try {
        await this.#ensureWritableFolder(settings.folder);
      } catch (error) {
        this.#recordRunFailure(error);
        // Keep retrying when a removable drive or its permissions recover.
        this.start(settings);
        return;
      }
    }
    try {
      await this.#hydrateLatestHealthyBackup();
    } catch (error) {
      this.#recordRunFailure(error);
    }
    if (settings.enabled) this.start(settings);
  }

  async configure(
    request: BackupConfigureRequest,
    guard?: BackupConfigurationGuard,
  ): Promise<undefined | BackupMigrationReport> {
    guard?.assertAuthorized();
    if (this.#configuring || this.#suspended || this.#shuttingDown)
      throw new Error("备份正在处理，请稍后重试");
    this.#configuring = true;
    let finishConfiguration!: () => void;
    this.#configurationDone = new Promise<void>((resolve) => {
      finishConfiguration = resolve;
    });
    let resume: (() => Promise<void>) | undefined;
    try {
      const previous = (await this.#settings.read()).backup;
      const { migrateExisting, expectedSourceFolder, ...settings } = request;
      if (expectedSourceFolder !== undefined && expectedSourceFolder !== previous.folder) {
        throw new Error("备份位置已发生变化，请重新选择");
      }
      if (settings.folder === previous.folder) {
        await this.#applySettings(settings, guard);
        return;
      }
      resume = await this.suspend();
      let migration: Awaited<ReturnType<BackupService["prepareFolderMigration"]>> | undefined;
      if (migrateExisting && previous.folder && settings.folder) {
        migration = await this.prepareFolderMigration(previous.folder, settings.folder, guard);
      }
      await this.#applySettings(settings, guard);
      if (!migration) return;
      let retainedSourceCount = 0;
      // The settings commit is the boundary: cleanup failures must not switch back
      // to a source folder that may already have been partially cleaned up.
      for (const entry of migration.entries) {
        try {
          const source = await this.#safePath(previous.folder as string, entry.name);
          const target = await this.#safePath(settings.folder as string, entry.targetName);
          if (
            (await this.#fileHash(source)) !== entry.hash ||
            (await this.#fileHash(target)) !== entry.hash
          ) {
            throw new Error("备份在迁移过程中发生变化");
          }
          guard?.assertAuthorized();
          await unlink(source);
        } catch {
          retainedSourceCount += 1;
        }
      }
      return {
        migratedCount: migration.entries.length,
        skippedCount: migration.skippedCount,
        retainedSourceCount,
      };
    } finally {
      try {
        await resume?.();
      } finally {
        this.#configuring = false;
        this.#configurationDone = undefined;
        finishConfiguration();
      }
    }
  }

  async #applySettings(settings: BackupSettings, guard?: BackupConfigurationGuard): Promise<void> {
    const previousSettings = (await this.#settings.read()).backup;
    guard?.assertAuthorized();
    if (settings.enabled && !settings.folder) {
      throw new Error("启用定时备份前必须选择备份文件夹");
    }
    if (settings.enabled && settings.folder) {
      await this.#ensureWritableFolder(settings.folder);
    }
    await this.#settings.update(
      { backup: settings } as Parameters<SettingsService["update"]>[0],
      guard?.beforeSettingsWrite,
    );
    this.stop();
    if (previousSettings.folder !== settings.folder) {
      this.#lastAttemptAt = null;
      this.#lastBackupAt = null;
      this.#lastRunSuccessCount = 0;
      this.#lastRunFailureCount = 0;
      this.#lastError = null;
      this.#lastBackupPerDoc.clear();
      this.#pendingFailures.clear();
      if (settings.folder) {
        try {
          await this.#hydrateLatestHealthyBackup();
        } catch (error) {
          this.#recordRunFailure(error);
        }
      }
    }
    if (settings.enabled && settings.folder) this.start(settings);
  }

  async runNow(): Promise<void> {
    if (this.#suspended) {
      throw new AppOperationError({ code: "OPERATION_IN_PROGRESS", message: "normalized" });
    }
    await this.#enqueueBackup({ trigger: "manual" });
  }

  async runGuarded(guard: BackupRunGuard): Promise<BackupRunResult> {
    guard.assertAuthorized();
    if (this.#suspended || this.#configuring || this.#shuttingDown)
      throw new AppOperationError({ code: "OPERATION_IN_PROGRESS", message: "normalized" });
    return this.#enqueueBackup({ trigger: "manual", guard });
  }

  async ensureCurrent(
    target: BackupTarget,
    trigger: Extract<BackupTrigger, "idle" | "patent-close">,
  ): Promise<BackupRunResult> {
    if (this.#suspended) {
      throw new AppOperationError({ code: "OPERATION_IN_PROGRESS", message: "normalized" });
    }
    const key = `${target.documentType}:${target.documentId}`;
    const existing = this.#targetRuns.get(key);
    if (existing) {
      existing.again = true;
      return existing.promise;
    }
    const run = { again: false, promise: Promise.resolve(undefined as unknown as BackupRunResult) };
    run.promise = (async () => {
      let result: BackupRunResult;
      do {
        run.again = false;
        result = await this.#enqueueBackup({ trigger, targets: [target] });
      } while (run.again && !this.#exitDrain && !this.#shuttingDown && !this.#suspended);
      return result;
    })().finally(() => {
      if (this.#targetRuns.get(key) === run) this.#targetRuns.delete(key);
    });
    this.#targetRuns.set(key, run);
    return run.promise;
  }

  async finalize(): Promise<BackupRunResult> {
    if (this.#suspended) {
      throw new AppOperationError({ code: "OPERATION_IN_PROGRESS", message: "normalized" });
    }
    if (this.#exitDrain) return this.#exitDrain;
    const settings = (await this.#settings.read()).backup;
    if (settings.waitOnExit) return await this.#enqueueBackup({ trigger: "application-close" });
    // The library's persisted revisions and the managed PATDOC revisions are the
    // durable pending-work record. Startup reconciles them, including after a crash.
    // Fast exit never starts a full-library scan or a new archive.
    if (this.#timerId !== undefined) clearInterval(this.#timerId);
    if (this.#initialTimerId !== undefined) clearTimeout(this.#initialTimerId);
    this.#timerId = undefined;
    this.#initialTimerId = undefined;
    this.#nextBackupAt = null;
    for (const run of this.#queuedRuns) run.cancelRequested = true;
    const operation = (async (): Promise<BackupRunResult> => {
      await this.#runInFlight?.catch(() => undefined);
      return {
        trigger: "application-close",
        attemptedCount: 0,
        successCount: 0,
        skippedCount: 0,
        failures: [],
        cancelled: false,
        completedAt: new Date().toISOString(),
      };
    })();
    this.#exitDrain = operation;
    try {
      return await operation;
    } finally {
      this.#exitDrain = undefined;
      // A cancelled application close must leave ordinary background protection active.
      this.start(settings);
    }
  }

  operationStatus(): BackupOperationStatus {
    return structuredClone(this.#operationStatus);
  }

  requestFinalizationCancel(): void {
    if (![...this.#queuedRuns].some((run) => run.trigger === "application-close")) return;
    // An exit backup can be waiting behind an idle/scheduled backup. Stop that
    // queue at its next safe file boundary too, rather than losing the request.
    for (const run of this.#queuedRuns) run.cancelRequested = true;
    if (this.#operationStatus.running)
      this.#operationStatus = { ...this.#operationStatus, cancelRequested: true };
  }

  start(settings: BackupSettings): void {
    if (this.#suspended) {
      this.#resumeSettings =
        settings.enabled && settings.folder ? structuredClone(settings) : undefined;
      return;
    }
    this.#startScheduling(settings);
  }

  #startScheduling(settings: BackupSettings): void {
    if (this.#shuttingDown) return;
    if (this.#timerId !== undefined || this.#initialTimerId !== undefined) return;
    if (!settings.enabled || !settings.folder) return;

    // A healthy backup baseline is reconstructed from actual PATDOC files at startup.
    // Keep it across schedule restarts so closing the app never causes duplicate writes.
    this.#scheduledSettings = structuredClone(settings);
    const generation = ++this.#generation;
    const intervalMs = settings.intervalMinutes * 60_000;
    const firstIntervalAt = Date.now() + intervalMs;
    const run = (initial = false) => {
      if (generation !== this.#generation) return;
      this.#nextBackupAt = new Date(
        initial ? firstIntervalAt : Date.now() + intervalMs,
      ).toISOString();
      void this.#enqueueBackup({ trigger: "scheduled", generation }).catch((error: unknown) => {
        if (generation === this.#generation) this.#recordRunFailure(error);
      });
    };

    this.#nextBackupAt = new Date(Date.now() + 5_000).toISOString();
    this.#timerId = setInterval(run, intervalMs);
    this.#initialTimerId = setTimeout(() => {
      this.#initialTimerId = undefined;
      run(true);
    }, 5_000);
  }

  stop(): void {
    if (this.#suspended) this.#resumeSettings = undefined;
    this.#stopScheduling();
  }

  #stopScheduling(): void {
    ++this.#generation;
    if (this.#timerId !== undefined) {
      clearInterval(this.#timerId);
      this.#timerId = undefined;
    }
    if (this.#initialTimerId !== undefined) {
      clearTimeout(this.#initialTimerId);
      this.#initialTimerId = undefined;
    }
    this.#nextBackupAt = null;
    this.#scheduledSettings = undefined;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.stop();
    await this.#configurationDone;
    await this.#runInFlight?.catch(() => undefined);
    this.stop();
  }

  async suspend(): Promise<() => Promise<void>> {
    this.#suspended = true;
    this.#resumeSettings = this.#scheduledSettings
      ? structuredClone(this.#scheduledSettings)
      : undefined;
    this.#stopScheduling();

    let resumed = false;
    const resume = async () => {
      if (resumed) return;
      resumed = true;
      const settings = this.#resumeSettings;
      this.#resumeSettings = undefined;
      this.#suspended = false;
      if (settings) this.#startScheduling(settings);
    };
    try {
      await this.#runInFlight;
    } catch (error) {
      await resume();
      throw error;
    }
    return resume;
  }

  async list(settings?: BackupSettings): Promise<BackupEntry[]> {
    const appSettings = { backup: settings ?? (await this.#settings.read()).backup };
    if (!appSettings.backup.folder) return [];

    const entries: BackupEntry[] = [];
    const files = await this.#backupFiles(appSettings.backup.folder);
    for (const file of files) {
      if (!file.endsWith(".patdoc")) continue;

      let filePath: string;
      try {
        filePath = await this.#safePath(appSettings.backup.folder, file);
      } catch {
        continue;
      }
      if (this.#publishingFiles.has(filePath)) continue;
      const managed = this.#isManagedBackupFile(file);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const inspected = await this.#delegate.inspect(filePath);
        entries.push({
          fileName: file,
          displayName: inspected.displayName,
          documentType: inspected.documentType,
          documentId: inspected.documentId,
          revision: inspected.revision,
          sizeBytes: fileStat.size,
          backedUpAt: backupModifiedAt(filePath, fileStat.mtime).toISOString(),
          managed: managedBackupIdentity(file, inspected),
          status: "healthy",
          errorMessage: null,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        entries.push({
          fileName: file,
          displayName: file.replace(/\.patdoc$/, ""),
          documentType: null,
          documentId: null,
          revision: null,
          sizeBytes: fileStat.size,
          backedUpAt: backupModifiedAt(filePath, fileStat.mtime).toISOString(),
          managed,
          status: "damaged",
          errorMessage: this.#errorMessage(error),
        });
      }
    }

    return entries.sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
  }

  async restore(fileName: string): Promise<BackupRestoreResult> {
    if (this.#configuring) throw new Error("正在切换备份位置，请稍后重试");
    const appSettings = await this.#settings.read();
    if (!appSettings.backup.folder) throw new Error("备份文件夹未设置");

    const filePath = await this.#safePath(appSettings.backup.folder, fileName);
    if (this.#publishingFiles.has(filePath)) throw new Error("备份仍在写入，请稍后重试");

    // The .patdoc payload is the source of truth for its document type. Never infer
    // it from a user-controlled display name in the backup file name.
    return await this.#delegate.restoreOne(filePath);
  }

  async describe(
    fileName: string,
    settings: BackupSettings,
  ): Promise<{ fileName: string; state: string }> {
    if (!settings.folder) throw new Error("备份文件夹未设置");
    const filePath = await this.#safePath(settings.folder, fileName);
    return {
      fileName,
      state: createHash("sha256")
        .update(`${filePath}\0${await backupFileState(filePath)}`)
        .digest("hex"),
    };
  }

  async capture(
    fileName: string,
    settings: BackupSettings,
  ): Promise<{ bytes: Uint8Array; state: string }> {
    if (!settings.folder || this.#configuring) throw new Error("备份位置不可用或正在切换");
    const filePath = await this.#safePath(settings.folder, fileName);
    if (this.#publishingFiles.has(filePath)) throw new Error("备份仍在写入");
    const before = await backupFileState(filePath);
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const value = await handle.stat({ bigint: true });
      const opened = `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
      if (!value.isFile() || opened !== before || value.size > 256n * 1024n * 1024n)
        throw new Error("备份文件已变化或超过 256 MiB");
      const bytes = await handle.readFile();
      if (
        bytes.byteLength > 256 * 1024 * 1024 ||
        (await backupFileState(await this.#safePath(settings.folder, fileName))) !== before
      )
        throw new Error("读取期间备份文件已变化");
      return { bytes, state: createHash("sha256").update(`${filePath}\0${before}`).digest("hex") };
    } finally {
      await handle.close();
    }
  }

  async delete(fileName: string, beforeDelete?: (state: string) => void): Promise<void> {
    if (this.#configuring) throw new Error("正在切换备份位置，请稍后重试");
    if (!this.#isManagedBackupFile(fileName)) {
      throw new Error(`只能删除${APPLICATION_NAME}创建的自动备份`);
    }
    const appSettings = await this.#settings.read();
    if (!appSettings.backup.folder) throw new Error("备份文件夹未设置");

    const filePath = await this.#safePath(appSettings.backup.folder, fileName);
    if (this.#publishingFiles.has(filePath)) throw new Error("备份仍在写入，请稍后重试");
    const inspected = await this.#delegate.inspect(filePath).catch(() => null);
    if (inspected && !managedBackupIdentity(fileName, inspected)) {
      throw new Error("备份文件身份与文件名不一致，不能作为自动备份删除");
    }
    const state = createHash("sha256")
      .update(`${filePath}\0${await backupFileState(filePath)}`)
      .digest("hex");
    beforeDelete?.(state);
    await unlink(filePath);
  }

  async selectFolder(ownerWindow: BrowserWindow): Promise<string | null> {
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog(ownerWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择备份文件夹",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }

  #enqueueBackup(input: {
    trigger: BackupTrigger;
    generation?: number;
    targets?: readonly BackupTarget[];
    guard?: BackupRunGuard;
  }): Promise<BackupRunResult> {
    if (this.#exitDrain) return this.#exitDrain;
    const state = { ...input, cancelRequested: false };
    this.#queuedRuns.add(state);
    const previous = this.#runInFlight ?? Promise.resolve(undefined as never);
    const run = previous
      .catch(() => undefined as never)
      .then(async () => {
        const release = this.beginBackgroundOperation?.();
        try {
          return await this.#runBackupOnce(state);
        } finally {
          release?.();
          // Runs are serialized: this cleanup cannot reset a newer operation.
          this.#operationStatus = {
            running: false,
            trigger: null,
            totalCount: 0,
            completedCount: 0,
            currentDisplayName: null,
            cancelRequested: false,
          };
        }
      });
    const inFlight = run.finally(() => {
      this.#queuedRuns.delete(state);
      if (this.#runInFlight === inFlight) this.#runInFlight = undefined;
    });
    this.#runInFlight = inFlight;
    return inFlight;
  }

  async #runBackupOnce(input: {
    trigger: BackupTrigger;
    cancelRequested: boolean;
    generation?: number;
    targets?: readonly BackupTarget[];
    guard?: BackupRunGuard;
  }): Promise<BackupRunResult> {
    const generation = input.generation ?? this.#generation;
    const completedAt = () => new Date().toISOString();
    const emptyResult = (cancelled = false): BackupRunResult => ({
      trigger: input.trigger,
      attemptedCount: 0,
      successCount: 0,
      skippedCount: 0,
      failures: [],
      cancelled,
      completedAt: completedAt(),
    });
    if (generation !== this.#generation || input.cancelRequested) return emptyResult(true);
    const appSettings = await this.#settings.read();
    input.guard?.beforeRun(appSettings);
    if (
      generation !== this.#generation ||
      !appSettings.backup.enabled ||
      !appSettings.backup.folder
    ) {
      return emptyResult();
    }

    this.#lastAttemptAt = new Date().toISOString();
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;
    const failures: BackupRunResult["failures"] = [];
    try {
      input.guard?.assertAuthorized();
      await mkdir(appSettings.backup.folder, { recursive: true });
    } catch (error) {
      this.#recordRunFailure(error);
      return {
        ...emptyResult(),
        attemptedCount: 1,
        failures: [
          {
            target: input.targets?.[0] ?? {
              documentType: "patent",
              documentId: "00000000-0000-4000-8000-000000000000",
            },
            displayName: "备份文件夹",
            message: this.#errorMessage(error),
          },
        ],
      };
    }
    if (generation !== this.#generation) return emptyResult(true);

    let modified: DocumentModifiedInfo[];
    try {
      modified = await this.#delegate.listModified();
    } catch (error) {
      this.#recordRunFailure(error);
      throw error;
    }
    const targets = input.targets
      ? new Set(input.targets.map((target) => `${target.documentType}:${target.documentId}`))
      : undefined;
    const selected = targets
      ? modified.filter((info) => targets.has(`${info.documentType}:${info.documentId}`))
      : modified;
    if (generation !== this.#generation || input.cancelRequested) return emptyResult(true);
    const activeKeys = new Set(modified.map((info) => `${info.documentType}:${info.documentId}`));
    for (const key of this.#pendingFailures.keys()) {
      if (!activeKeys.has(key)) this.#pendingFailures.delete(key);
    }
    this.#operationStatus = {
      running: true,
      trigger: input.trigger,
      totalCount: selected.length,
      completedCount: 0,
      currentDisplayName: null,
      cancelRequested: false,
    };
    for (const info of selected) {
      input.guard?.assertAuthorized();
      if (generation !== this.#generation) {
        this.#operationStatus = {
          ...this.#operationStatus,
          running: false,
          trigger: null,
          currentDisplayName: null,
        };
        return emptyResult(true);
      }
      if (input.cancelRequested) {
        this.#operationStatus = {
          ...this.#operationStatus,
          running: false,
          trigger: null,
          currentDisplayName: null,
        };
        return {
          trigger: input.trigger,
          attemptedCount: successCount + failureCount,
          successCount,
          skippedCount,
          failures,
          cancelled: true,
          completedAt: completedAt(),
        };
      }
      const key = `${info.documentType}:${info.documentId}`;
      // Skip only when the same revision still has a healthy managed file.
      this.#operationStatus = { ...this.#operationStatus, currentDisplayName: null };
      if (
        await this.#hasHealthyBaseline(key, info.revision, input.trigger === "application-close")
      ) {
        try {
          if (input.trigger !== "application-close") {
            await this.#organizeManagedBackups(info, appSettings.backup.folder, input.guard);
          }
        } catch (error) {
          const message = `备份整理失败，原文件已保留：${this.#errorMessage(error)}`.slice(
            0,
            2_000,
          );
          this.#pendingFailures.set(key, message);
          failures.push({
            target: { documentType: info.documentType, documentId: info.documentId },
            displayName: info.displayName,
            message,
          });
          failureCount += 1;
          this.#operationStatus.completedCount += 1;
          continue;
        }
        if (generation !== this.#generation) return emptyResult(true);
        this.#pendingFailures.delete(key);
        skippedCount += 1;
        this.#operationStatus = {
          ...this.#operationStatus,
          completedCount: this.#operationStatus.completedCount + 1,
        };
        continue;
      }
      this.#operationStatus = { ...this.#operationStatus, currentDisplayName: info.displayName };
      const backupTime = new Date();
      const fileName = backupFileName(appSettings.backup.folder, info, backupTime);
      let finalPath = join(appSettings.backup.folder, fileName);
      const partialPath = `${finalPath}.partial-${randomUUID()}`;
      try {
        input.guard?.assertAuthorized();
        await this.#safePath(appSettings.backup.folder, fileName, true);
        await this.#delegate.backupOne(info, partialPath);
        const inspected = await this.#delegate.inspect(partialPath);
        if (
          inspected.documentType !== info.documentType ||
          inspected.documentId !== info.documentId ||
          !Number.isSafeInteger(inspected.revision) ||
          inspected.revision < info.revision
        )
          throw new Error("备份内容与待备份文档不一致，未发布文件，请重试。");
        // Editing may advance between listing the library and capturing the archive.
        const captured = {
          ...info,
          revision: inspected.revision,
          displayName: inspected.displayName,
        };
        // Exclusive publication never overwrites an existing backup.
        finalPath = await this.#publishExclusive(
          partialPath,
          appSettings.backup.folder,
          backupFileName(appSettings.backup.folder, captured, backupTime),
          captured,
          backupTime,
          input.guard,
        );
        await preserveBackupTimes(finalPath, backupTime, backupTime);
        await unlink(partialPath);
        if (!input.cancelRequested) {
          await this.#organizeManagedBackups(captured, appSettings.backup.folder, input.guard);
          await this.#pruneManagedBackups(captured, appSettings.backup.folder, input.guard);
        }
        if (generation !== this.#generation) return emptyResult(true);
        this.#lastBackupPerDoc.set(key, { revision: captured.revision, filePath: finalPath });
        if (!(await this.#hasHealthyBaseline(key, captured.revision))) {
          throw new Error("备份发布后校验失败，请重试。");
        }
        this.#pendingFailures.delete(key);
        successCount += 1;
      } catch (error) {
        await unlink(partialPath).catch(() => undefined);
        if (generation !== this.#generation) return emptyResult(true);
        // Leave the baseline unchanged so a failed backup is retried next tick.
        failureCount += 1;
        this.#pendingFailures.set(
          key,
          `《${info.displayName}》备份失败：${this.#errorMessage(error)}`.slice(0, 2_000),
        );
        failures.push({
          target: { documentType: info.documentType, documentId: info.documentId },
          displayName: info.displayName,
          message: this.#errorMessage(error),
        });
      }
      this.#operationStatus = {
        ...this.#operationStatus,
        completedCount: this.#operationStatus.completedCount + 1,
        currentDisplayName: null,
      };
    }

    if (generation !== this.#generation) return emptyResult(true);
    this.#lastRunSuccessCount = successCount;
    this.#lastRunFailureCount = this.#pendingFailures.size;
    this.#lastError = [...this.#pendingFailures.values()].at(-1) ?? null;
    if (successCount > 0) this.#lastBackupAt = this.#lastAttemptAt;
    this.#operationStatus = {
      running: false,
      trigger: null,
      totalCount: 0,
      completedCount: 0,
      currentDisplayName: null,
      cancelRequested: false,
    };
    return {
      trigger: input.trigger,
      attemptedCount: successCount + failureCount,
      successCount,
      skippedCount,
      failures,
      cancelled: false,
      completedAt: completedAt(),
    };
  }

  async #ensureWritableFolder(folder: string): Promise<void> {
    await mkdir(folder, { recursive: true });
    const probePath = join(folder, `.pwb-write-probe-${randomUUID()}`);
    const handle = await open(probePath, "wx");
    try {
      await handle.writeFile("ok");
      await handle.sync();
    } finally {
      await handle.close();
      await unlink(probePath).catch(() => undefined);
    }
  }

  #recordRunFailure(error: unknown): void {
    this.#lastAttemptAt = new Date().toISOString();
    this.#lastRunSuccessCount = 0;
    this.#lastRunFailureCount = 1;
    this.#lastError = this.#errorMessage(error);
  }

  async #hasHealthyBaseline(key: string, revision: number, quick = false): Promise<boolean> {
    const baseline = this.#lastBackupPerDoc.get(key);
    if (!baseline || baseline.revision !== revision) return false;
    try {
      const before = await backupFileState(baseline.filePath);
      if (quick && baseline.verifiedFileState === before) return true;
      const inspected = await this.#delegate.inspect(baseline.filePath);
      if (
        `${inspected.documentType}:${inspected.documentId}` === key &&
        inspected.revision === revision &&
        before === (await backupFileState(baseline.filePath))
      ) {
        baseline.verifiedFileState = before;
        return true;
      }
    } catch {
      // A present file is not necessarily a usable backup.
    }
    this.#lastBackupPerDoc.delete(key);
    return false;
  }

  async #hydrateLatestHealthyBackup(): Promise<void> {
    this.#lastBackupPerDoc.clear();
    const folder = (await this.#settings.read()).backup.folder;
    const healthy = (await this.list()).filter(
      (entry) =>
        entry.managed &&
        entry.status === "healthy" &&
        entry.documentType !== null &&
        entry.documentId !== null &&
        entry.revision !== null,
    );
    for (const entry of healthy) {
      if (
        entry.documentType === null ||
        entry.documentId === null ||
        entry.revision === null ||
        folder === null
      ) {
        continue;
      }
      const key = `${entry.documentType}:${entry.documentId}`;
      const current = this.#lastBackupPerDoc.get(key);
      if (!current || entry.revision > current.revision) {
        this.#lastBackupPerDoc.set(key, {
          revision: entry.revision,
          filePath: join(folder, entry.fileName),
        });
      }
    }
    this.#lastBackupAt = healthy[0]?.backedUpAt ?? null;
  }

  #errorMessage(error: unknown): string {
    const described = backupFileError(error);
    if (described) return `${described.message} ${described.nextAction ?? ""}`.trim();
    return error instanceof Error && error.message.trim()
      ? error.message.slice(0, 2_000)
      : "备份失败";
  }

  #isManagedBackupFile(fileName: string): boolean {
    return managedBackupIdentity(fileName);
  }

  async #fileHash(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }

  private async prepareFolderMigration(
    sourceFolder: string,
    targetFolder: string,
    guard?: BackupConfigurationGuard,
  ) {
    const sourceRoot = await realpath(sourceFolder);
    guard?.assertAuthorized();
    await this.#ensureWritableFolder(targetFolder);
    const targetRoot = await realpath(targetFolder);
    const nested = (parent: string, child: string) => {
      const path = relative(parent, child);
      return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
    };
    if (nested(sourceRoot, targetRoot) || nested(targetRoot, sourceRoot)) {
      throw new Error("迁移时请使用独立的文件夹，不能选择原目录或它的上级、下级目录");
    }
    const entries: Array<{ name: string; targetName: string; hash: string }> = [];
    let skippedCount = 0;
    for (const name of await this.#backupFiles(sourceRoot)) {
      let source: string;
      let inspected: BackupInspection;
      try {
        source = await this.#safePath(sourceRoot, name);
        inspected = await this.#delegate.inspect(source);
        if (!managedBackupIdentity(name, inspected)) throw new Error("非受管备份");
      } catch {
        skippedCount += 1;
        continue;
      }
      const hash = await this.#fileHash(source);
      const sourceStat = await stat(source);
      const sourceTime = backupModifiedAt(source, sourceStat.mtime);
      let targetName = name;
      if (usesHarmonyPublicFileCopy(targetRoot) && !managedBackupTime(name)) {
        if (!inspected.createdAt) throw new Error("无法取得旧备份的创建时间，原备份已保留。");
        targetName = backupFileName(targetRoot, inspected, sourceTime);
      }
      let copied = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        guard?.assertAuthorized();
        const target = await this.#safePath(targetRoot, targetName, true);
        try {
          guard?.assertAuthorized();
          await copyBackupExclusive(source, target);
          copied = true;
          await preserveBackupTimes(target, sourceStat.atime, sourceTime);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await this.#fileHash(target)) !== hash) {
            targetName = targetName.replace(
              /-[0-9a-f-]+\.patdoc$/iu,
              `-${backupNameToken(name) ? randomUUID().slice(0, 8) : randomUUID()}.patdoc`,
            );
            continue;
          }
        }
        if ((await this.#fileHash(target)) !== hash) throw new Error("迁移校验失败，原备份仍保留");
        const verified = await this.#delegate.inspect(target);
        if (!managedBackupIdentity(targetName, verified)) throw new Error("迁移文件身份校验失败");
        const handle = await open(target, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        entries.push({ name, targetName, hash });
        copied = true;
        break;
      }
      if (!copied) throw new Error("目标目录文件重名，原备份仍保留");
    }
    return { entries, skippedCount };
  }

  async #safePath(folder: string, name: string, createParent = false): Promise<string> {
    if (
      !/^(?:\d{4}-(?:0[1-9]|1[0-2])\/)?[^/\\<>:"|?*\p{Cc}]+\.patdoc$/u.test(name) ||
      name.includes("..")
    ) {
      throw new Error("无效的文件名");
    }
    const root = await realpath(folder);
    const path = resolve(root, name);
    if (createParent) await mkdir(dirname(path), { recursive: true });
    const parent = await realpath(dirname(path));
    const inside = relative(root, parent);
    if (inside && !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(inside))
      throw new Error("备份路径超出备份文件夹");
    if (parent !== dirname(path)) throw new Error("备份路径不能使用链接");
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("备份文件不能使用链接或目录");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path;
  }

  async #backupFiles(folder: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name.endsWith(".patdoc")) result.push(entry.name);
      if (entry.isDirectory() && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(entry.name)) {
        const children = await readdir(join(folder, entry.name), { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        for (const child of children) {
          if (child.isFile() && !child.isSymbolicLink() && child.name.endsWith(".patdoc"))
            result.push(`${entry.name}/${child.name}`);
        }
      }
    }
    return result;
  }

  async #organizeManagedBackups(
    info: DocumentModifiedInfo,
    folder: string,
    guard?: BackupRunGuard,
  ): Promise<void> {
    if (!info.createdAt || !Number.isFinite(Date.parse(info.createdAt))) return;
    for (const name of await this.#backupFiles(folder)) {
      guard?.assertAuthorized();
      if (!this.#isManagedBackupFile(name)) continue;
      let source: string;
      try {
        source = await this.#safePath(folder, name);
      } catch {
        continue;
      }
      let inspected: BackupInspection;
      try {
        inspected = await this.#delegate.inspect(source);
      } catch {
        continue;
      }
      if (
        inspected.documentId !== info.documentId ||
        inspected.documentType !== info.documentType ||
        !managedBackupIdentity(name, inspected)
      )
        continue;
      const sourceStat = await stat(source);
      const sourceTime = backupModifiedAt(source, sourceStat.mtime);
      const targetName = backupFileName(
        folder,
        { ...info, revision: inspected.revision },
        sourceTime,
        backupNameToken(name),
      );
      if (targetName === name) continue;
      const target = await this.#publishExclusive(
        source,
        folder,
        targetName,
        { ...info, revision: inspected.revision },
        sourceTime,
        guard,
      );
      const verified = await this.#delegate.inspect(target);
      if (
        verified.documentId !== inspected.documentId ||
        verified.documentType !== inspected.documentType ||
        verified.revision !== inspected.revision
      ) {
        throw new Error("整理后的备份校验失败，未删除原文件");
      }
      await preserveBackupTimes(target, sourceStat.atime, sourceTime);
      guard?.assertAuthorized();
      await unlink(source);
      const key = `${info.documentType}:${info.documentId}`;
      const baseline = this.#lastBackupPerDoc.get(key);
      if (baseline?.filePath === source)
        this.#lastBackupPerDoc.set(key, { ...baseline, filePath: target });
    }
  }

  async #publishExclusive(
    source: string,
    folder: string,
    name: string,
    info: DocumentModifiedInfo,
    time: Date,
    guard?: BackupRunGuard,
  ): Promise<string> {
    const sourceHash = await this.#fileHash(source);
    let candidate = name;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guard?.assertAuthorized();
      const target = await this.#safePath(folder, candidate, true);
      this.#publishingFiles.add(target);
      let copied = false;
      try {
        guard?.assertAuthorized();
        await copyBackupExclusive(source, target);
        copied = true;
        const handle = await open(target, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if ((await this.#fileHash(target)) !== sourceHash) {
          throw new Error("备份副本校验失败，未替换原有备份");
        }
        return target;
      } catch (error) {
        if (copied) {
          await unlink(target).catch(() => undefined);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        candidate = backupFileName(folder, info, time);
      } finally {
        this.#publishingFiles.delete(target);
      }
    }
    throw new Error("备份文件重名，请稍后重试；已有文件未被覆盖");
  }

  async #pruneManagedBackups(
    info: DocumentModifiedInfo,
    folder: string,
    guard?: BackupRunGuard,
  ): Promise<void> {
    const files = (await this.#backupFiles(folder)).filter((file) =>
      this.#isManagedBackupFile(file),
    );
    const matching: Array<{ filePath: string; revision: number; modifiedMs: number }> = [];
    for (const file of files) {
      try {
        const filePath = await this.#safePath(folder, file);
        const [inspected, fileStat] = await Promise.all([
          this.#delegate.inspect(filePath),
          stat(filePath),
        ]);
        if (
          inspected.documentType === info.documentType &&
          inspected.documentId === info.documentId &&
          managedBackupIdentity(file, inspected)
        ) {
          matching.push({
            filePath,
            revision: inspected.revision,
            modifiedMs: backupModifiedAt(filePath, fileStat.mtime).getTime(),
          });
        }
      } catch {
        // Never delete an entry whose ownership or integrity cannot be proven.
      }
    }
    matching.sort(
      (left, right) =>
        right.revision - left.revision ||
        right.modifiedMs - left.modifiedMs ||
        right.filePath.localeCompare(left.filePath),
    );
    for (const obsolete of matching.slice(3)) {
      guard?.assertAuthorized();
      await unlink(obsolete.filePath);
    }
  }
}
