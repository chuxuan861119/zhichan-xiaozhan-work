import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type AppSettings, DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { SettingsService } from "../settings/settings-service.js";
import { type BackupDelegate, BackupService } from "./backup-service.js";

function settingsStore(initial: AppSettings) {
  let value = structuredClone(initial);
  return {
    read: async () => structuredClone(value),
    update: async (patch: Partial<AppSettings>) => {
      value = { ...value, ...structuredClone(patch) };
      return structuredClone(value);
    },
  };
}

function delegate(overrides: Partial<BackupDelegate> = {}): BackupDelegate {
  return {
    listModified: async () => [],
    backupOne: async () => {},
    inspect: async () => ({
      documentType: "patent",
      documentId: "00000000-0000-4000-8000-000000000001",
      displayName: "测试专利",
      revision: 1,
    }),
    restoreOne: async () => ({
      documentType: "patent",
      documentId: "00000000-0000-4000-8000-000000000002",
      displayName: "测试专利（恢复）",
    }),
    ...overrides,
  };
}

describe("BackupService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patent-backup-service-"));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  test("rejects enabling automatic backup without a folder", async () => {
    const settings = settingsStore(DEFAULT_APP_SETTINGS);
    const service = new BackupService({ settings, delegate: delegate() });

    await expect(
      service.configure({ enabled: true, folder: null, intervalMinutes: 5 }),
    ).rejects.toThrow("启用定时备份前必须选择备份文件夹");
  });

  test("fast exit never scans the library or touches an unavailable backup folder", async () => {
    const listModified = vi.fn(async () => []);
    const backupOne = vi.fn();
    const service = new BackupService({
      settings: settingsStore({
        ...DEFAULT_APP_SETTINGS,
        backup: { enabled: true, folder: join(root, "missing", "backup"), intervalMinutes: 5 },
      }),
      delegate: delegate({ listModified, backupOne }),
    });
    expect(await service.finalize()).toMatchObject({ attemptedCount: 0, failures: [] });
    expect(listModified).not.toHaveBeenCalled();
    expect(backupOne).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    await service.shutdown();
  });

  test("fast exit finishes the current file and a fresh service resumes the remaining persisted revisions", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const records = [1, 2].map((id) => ({
      documentType: "patent" as const,
      documentId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      displayName: `专利${id}`,
      modifiedAt: "2026-10-18T00:00:00.000Z",
      revision: 1,
    }));
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const backupOne = vi.fn(async (info, path: string) => {
      await writeFile(path, JSON.stringify(info));
      if (backupOne.mock.calls.length === 1) {
        start();
        await writing;
      }
    });
    const backing = delegate({
      listModified: async () => records,
      backupOne,
      inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
    });
    const service = new BackupService({ settings, delegate: backing });
    const background = service.runNow();
    await started;
    const exit = service.finalize();
    await Promise.resolve();
    await Promise.resolve();
    expect((await readdir(root)).filter((name) => name.endsWith(".patdoc"))).toHaveLength(0);
    finish();
    await Promise.all([background, exit]);
    expect(backupOne).toHaveBeenCalledTimes(1);
    expect((await readdir(root)).filter((name) => name.endsWith(".patdoc"))).toHaveLength(1);
    await service.shutdown();
    const reopened = new BackupService({ settings, delegate: backing });
    await reopened.initialize();
    await reopened.runNow();
    expect(backupOne).toHaveBeenCalledTimes(2);
    expect(backupOne.mock.calls[1]?.[0].documentId).toBe(records[1]?.documentId);
    await reopened.shutdown();
  });

  test("coalesces repeated requests while preserving a newer revision received during writing", async () => {
    let revision = 1;
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const target = {
      documentType: "patent" as const,
      documentId: "00000000-0000-4000-8000-000000000001",
    };
    const listModified = vi.fn(async () => [
      { ...target, displayName: "合并请求", modifiedAt: "2026-10-18T00:00:00.000Z", revision },
    ]);
    const backupOne = vi.fn(async (info, path: string) => {
      await writeFile(path, JSON.stringify(info));
      if (backupOne.mock.calls.length === 1) {
        start();
        await writing;
      }
    });
    const service = new BackupService({
      settings: settingsStore({
        ...DEFAULT_APP_SETTINGS,
        backup: { enabled: true, folder: root, intervalMinutes: 5 },
      }),
      delegate: delegate({
        listModified,
        backupOne,
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });
    const first = service.ensureCurrent(target, "idle");
    await started;
    revision = 2;
    const requests = Array.from({ length: 20 }, () => service.ensureCurrent(target, "idle"));
    finish();
    await Promise.all([first, ...requests]);
    expect(listModified).toHaveBeenCalledTimes(2);
    expect(backupOne.mock.calls.map(([info]) => info.revision)).toEqual([1, 2]);
    await service.shutdown();
  });

  test("checks configuration authorization again inside the settings write queue", async () => {
    const settings = new SettingsService(join(root, "settings.json"));
    const initial = await settings.read();
    const service = new BackupService({ settings, delegate: delegate() });
    const guard = {
      assertAuthorized: vi.fn(),
      beforeSettingsWrite: vi.fn(() => {
        throw new Error("revoked while queued");
      }),
    };
    await expect(
      service.configure({ enabled: false, folder: null, intervalMinutes: 15 }, guard),
    ).rejects.toThrow("revoked while queued");
    expect((await settings.readReadOnly()).backup).toEqual(initial.backup);
    expect(guard.beforeSettingsWrite).toHaveBeenCalledOnce();
    service.stop();
  });

  test("surfaces settings recovery warnings through backup status", async () => {
    const settings = {
      ...settingsStore(DEFAULT_APP_SETTINGS),
      status: () => ({
        state: "degraded" as const,
        message: "设置文件损坏且没有有效备份，请重新确认数据安全设置。",
      }),
    };
    const service = new BackupService({ settings, delegate: delegate() });

    await expect(service.status()).resolves.toMatchObject({
      lastError: "设置文件损坏且没有有效备份，请重新确认数据安全设置。",
    });
  });

  test("does not report a failed run as the last successful backup", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            displayName: "失败专利",
            modifiedAt: "2026-08-09T00:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne: async () => {
          throw new Error("磁盘已满");
        },
      }),
    });

    await (service as BackupService & { initialize(): Promise<void> }).initialize();
    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(async () => {
      expect(await service.status()).toMatchObject({
        lastAttemptAt: expect.any(String),
        lastBackupAt: null,
        lastRunSuccessCount: 0,
        lastRunFailureCount: 1,
        lastError: "《失败专利》备份失败：磁盘已满",
      });
    });
  });

  test("keeps a damaged patdoc visible without violating the result contract", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    await writeFile(join(root, "broken.patdoc"), Buffer.from("broken"));
    const service = new BackupService({
      settings,
      delegate: delegate({ inspect: async () => Promise.reject(new Error("文件损坏")) }),
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        fileName: "broken.patdoc",
        documentType: null,
        documentId: null,
        revision: null,
        sizeBytes: 6,
        managed: false,
        status: "damaged",
        errorMessage: "文件损坏",
      }),
    ]);
  });

  test("reports an unreadable backup folder instead of presenting an empty list", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: false, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({ settings, delegate: delegate() });
    await rm(root, { recursive: true, force: true });

    await expect(service.list()).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("records a successful backup time when the same run only partially succeeds", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000011",
            displayName: "成功专利",
            modifiedAt: "2026-08-16T00:00:00.000Z",
            revision: 1,
          },
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000012",
            displayName: "失败专利",
            modifiedAt: "2026-08-16T00:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne: async (info, targetPath) => {
          if (info.displayName === "失败专利") throw new Error("磁盘写入失败");
          await writeFile(targetPath, JSON.stringify(info));
        },
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });

    await service.runNow();

    await expect(service.status()).resolves.toMatchObject({
      lastBackupAt: expect.any(String),
      lastRunSuccessCount: 1,
      lastRunFailureCount: 1,
      lastError: "《失败专利》备份失败：磁盘写入失败",
    });
  });

  test("restores the latest healthy managed backup time during initialization", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const fileName =
      "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r1-10000000-0000-4000-8000-000000000003.patdoc";
    await writeFile(join(root, fileName), Buffer.from("healthy"));
    const service = new BackupService({ settings, delegate: delegate() });

    await service.initialize();

    await expect(service.status()).resolves.toMatchObject({
      lastBackupAt: expect.any(String),
      lastError: null,
    });
    service.stop();
  });

  test("restores the latest healthy backup time while scheduled backup is disabled", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: false, folder: root, intervalMinutes: 5 },
    });
    const fileName =
      "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r1-10000000-0000-4000-8000-000000000003.patdoc";
    await writeFile(join(root, fileName), Buffer.from("healthy"));
    const service = new BackupService({ settings, delegate: delegate() });

    await service.initialize();

    await expect(service.status()).resolves.toMatchObject({
      enabled: false,
      lastBackupAt: expect.any(String),
      lastError: null,
    });
  });

  test("clears folder-scoped status after changing to an empty backup folder", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: false, folder: root, intervalMinutes: 5 },
    });
    const fileName =
      "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r1-10000000-0000-4000-8000-000000000003.patdoc";
    await writeFile(join(root, fileName), Buffer.from("healthy"));
    const service = new BackupService({ settings, delegate: delegate() });
    await service.initialize();
    const emptyFolder = await mkdtemp(join(tmpdir(), "patent-backup-empty-"));

    try {
      await service.configure({ enabled: false, folder: emptyFolder, intervalMinutes: 5 });

      await expect(service.status()).resolves.toMatchObject({
        folder: emptyFolder,
        lastAttemptAt: null,
        lastBackupAt: null,
        lastRunSuccessCount: 0,
        lastRunFailureCount: 0,
        lastError: null,
      });
    } finally {
      await rm(emptyFolder, { recursive: true, force: true });
    }
  });

  test("records an unexpected scheduled-run failure instead of swallowing it", async () => {
    const configured = {
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    };
    let failRead = false;
    const settings = {
      read: async () => {
        if (failRead) throw new Error("设置读取失败");
        return structuredClone(configured);
      },
      update: async () => structuredClone(configured),
    };
    const service = new BackupService({ settings, delegate: delegate() });
    await service.initialize();
    failRead = true;

    await vi.advanceTimersByTimeAsync(5_000);
    failRead = false;

    await expect(service.status()).resolves.toMatchObject({
      lastRunFailureCount: 1,
      lastError: "设置读取失败",
    });
    service.stop();
  });

  test("identifies external patdoc files and refuses to delete them", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: false, folder: root, intervalMinutes: 5 },
    });
    const fileName = "用户手动归档.patdoc";
    const filePath = join(root, fileName);
    await writeFile(filePath, Buffer.from("manual"));
    const service = new BackupService({ settings, delegate: delegate() });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ fileName, managed: false, status: "healthy" }),
    ]);
    await expect(service.delete(fileName)).rejects.toThrow("只能删除");
    await expect(readFile(filePath, "utf8")).resolves.toBe("manual");
  });

  test("still allows deleting a managed automatic backup", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: false, folder: root, intervalMinutes: 5 },
    });
    const fileName =
      "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r1-10000000-0000-4000-8000-000000000003.patdoc";
    const filePath = join(root, fileName);
    await writeFile(filePath, Buffer.from("managed"));
    const service = new BackupService({ settings, delegate: delegate() });

    const described = await service.describe(fileName, (await settings.read()).backup);
    const captured = await service.capture(fileName, (await settings.read()).backup);
    expect(captured.state).toBe(described.state);
    expect(Buffer.from(captured.bytes).toString()).toBe("managed");
    await expect(
      service.delete(fileName, (state) => {
        expect(state).toBe(described.state);
        throw new Error("revoked before deletion");
      }),
    ).rejects.toThrow("revoked before deletion");
    expect(await readFile(filePath, "utf8")).toBe("managed");

    await expect(service.delete(fileName)).resolves.toBeUndefined();
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("guarded runs stop publication when authorization is revoked during capture", async () => {
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    let revoked = false;
    const info = {
      documentType: "patent" as const,
      documentId: "00000000-0000-4000-8000-000000000001",
      displayName: "测试专利",
      revision: 1,
      modifiedAt: new Date().toISOString(),
    };
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [info],
        backupOne: async (_, path) => {
          await writeFile(path, "captured");
          revoked = true;
        },
      }),
    });
    const beforeRun = vi.fn();
    const result = await service.runGuarded({
      beforeRun,
      assertAuthorized: () => {
        if (revoked) throw new Error("revoked");
      },
    });
    expect(beforeRun).toHaveBeenCalledOnce();
    expect(result.successCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await service.list()).toEqual([]);
    expect(service.operationStatus().running).toBe(false);
    await service.shutdown();
  });

  test("explicit read settings never invoke the settings write-capable reader", async () => {
    const settings = settingsStore(DEFAULT_APP_SETTINGS);
    const read = vi.spyOn(settings, "read");
    const service = new BackupService({ settings, delegate: delegate() });
    await service.status(DEFAULT_APP_SETTINGS.backup);
    await service.list(DEFAULT_APP_SETTINGS.backup);
    expect(read).not.toHaveBeenCalled();
  });

  test("waits for an in-flight backup before shutdown completes", async () => {
    let releaseWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let confirmWriteStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      confirmWriteStarted = resolve;
    });
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            displayName: "退出保护",
            modifiedAt: "2026-08-09T00:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne: async () => {
          confirmWriteStarted?.();
          await writeStarted;
        },
      }),
    });

    const run = service.runNow();
    await started;
    let shutdownFinished = false;
    const shutdown = service.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    releaseWrite?.();
    await Promise.all([run, shutdown]);
    expect(shutdownFinished).toBe(true);
  });

  test("backs up a closed patent by its persisted library entry", async () => {
    const backupOne = vi.fn<BackupDelegate["backupOne"]>(async (info, targetPath) => {
      await writeFile(targetPath, JSON.stringify(info));
    });
    const target = {
      documentType: "patent" as const,
      documentId: "00000000-0000-4000-8000-000000000101",
    };
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            ...target,
            displayName: "已关闭的专利",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 4,
          },
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000102",
            displayName: "未关闭的专利",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 2,
          },
        ],
        backupOne,
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });

    await expect(service.ensureCurrent(target, "patent-close")).resolves.toMatchObject({
      trigger: "patent-close",
      attemptedCount: 1,
      successCount: 1,
    });
    expect(backupOne).toHaveBeenCalledTimes(1);
    expect(backupOne.mock.calls[0]?.[0]).toMatchObject(target);
  });

  test("finalizes only revisions without a healthy backup", async () => {
    let revision = 1;
    const backupOne = vi.fn(async (_info: unknown, targetPath: string) => {
      await writeFile(targetPath, JSON.stringify(_info));
    });
    const documentId = "00000000-0000-4000-8000-000000000103";
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5, waitOnExit: true },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId,
            displayName: "最终修订",
            modifiedAt: `2026-08-23T01:00:0${revision}.000Z`,
            revision,
          },
        ],
        backupOne,
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });

    await service.runNow();
    revision = 2;
    await expect(service.finalize()).resolves.toMatchObject({
      trigger: "application-close",
      attemptedCount: 1,
      successCount: 1,
    });
    await expect(service.finalize()).resolves.toMatchObject({
      trigger: "application-close",
      attemptedCount: 0,
      skippedCount: 1,
    });
    expect(backupOne).toHaveBeenCalledTimes(2);
  });

  test("hydrates every healthy managed revision so startup does not rewrite it", async () => {
    const documentId = "00000000-0000-4000-8000-000000000104";
    const fileName = `PWB-AUTO-PAT-${documentId}-r3-10000000-0000-4000-8000-000000000003.patdoc`;
    await writeFile(join(root, fileName), Buffer.from("revision-3"));
    const backupOne = vi.fn(async () => undefined);
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId,
            displayName: "已有备份",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 3,
          },
        ],
        inspect: async () => ({
          documentType: "patent",
          documentId,
          displayName: "已有备份",
          revision: 3,
        }),
        backupOne,
      }),
    });

    await service.initialize();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(backupOne).not.toHaveBeenCalled();
  });

  test("serializes a close backup behind an active scheduled backup", async () => {
    let releaseFirst: (() => void) | undefined;
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const calls: string[] = [];
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000105",
            displayName: "第一项",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 1,
          },
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000106",
            displayName: "第二项",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne: async (info, targetPath) => {
          calls.push(info.documentId);
          if (info.documentId.endsWith("105")) {
            signalFirstStarted?.();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          await writeFile(targetPath, JSON.stringify(info));
        },
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });

    const scheduled = service.runNow();
    await firstStarted;
    const closeBackup = service.ensureCurrent(
      { documentType: "patent", documentId: "00000000-0000-4000-8000-000000000106" },
      "patent-close",
    );
    await Promise.resolve();
    expect(calls).toEqual(["00000000-0000-4000-8000-000000000105"]);

    releaseFirst?.();
    await Promise.all([scheduled, closeBackup]);
    expect(calls).toEqual([
      "00000000-0000-4000-8000-000000000105",
      "00000000-0000-4000-8000-000000000106",
    ]);
  });

  test("only exposes a final patdoc after the backup writer has completed", async () => {
    let releaseWrite: (() => void) | undefined;
    let signalWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5, waitOnExit: true },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000107",
            displayName: "原子备份",
            modifiedAt: "2026-08-23T01:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne: async (info, targetPath) => {
          await writeFile(targetPath, JSON.stringify(info));
          signalWriteStarted?.();
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        },
        inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      }),
    });

    const finalization = service.finalize();
    await writeStarted;
    const duringWrite = await readdir(root);
    expect(duringWrite.some((name) => name.endsWith(".patdoc"))).toBe(false);
    expect(duringWrite.some((name) => name.includes(".partial-"))).toBe(true);

    releaseWrite?.();
    await finalization;
    const afterWrite = await readdir(root);
    expect(afterWrite.filter((name) => name.endsWith(".patdoc"))).toHaveLength(1);
    expect(afterWrite.some((name) => name.includes(".partial-"))).toBe(false);
  });

  test("starts an enabled backup during service initialization", async () => {
    const backupOne = vi.fn(async () => {});
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 5 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            displayName: "自动备份",
            modifiedAt: "2026-08-09T00:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne,
      }),
    });

    await (service as BackupService & { initialize(): Promise<void> }).initialize();
    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => expect(backupOne).toHaveBeenCalledTimes(1));
  });

  test("writes versioned automatic backups and retains only the latest three per patent", async () => {
    let revision = 0;
    const settings = settingsStore(DEFAULT_APP_SETTINGS);
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            displayName: "轮换专利",
            modifiedAt: `2026-08-09T00:00:0${revision}.000Z`,
            revision,
          },
        ],
        backupOne: async (_info, targetPath) => {
          await writeFile(targetPath, Buffer.from(`revision-${revision}`));
        },
        inspect: async (filePath) => ({
          documentType: "patent",
          documentId: "00000000-0000-4000-8000-000000000001",
          displayName: "轮换专利",
          revision: Number((await readFile(filePath, "utf8")).replace("revision-", "")),
        }),
      }),
    });
    await service.configure({ enabled: true, folder: root, intervalMinutes: 5 });

    for (revision = 1; revision <= 4; revision += 1) {
      await (service as BackupService & { runNow(): Promise<void> }).runNow();
    }

    const names = await readdir(root);
    expect(names).toHaveLength(3);
    expect(names.every((file) => file.startsWith("PWB-AUTO-") && file.endsWith(".patdoc"))).toBe(
      true,
    );
  });

  test("suspends scheduled backups before waiting and resumes exactly one schedule", async () => {
    let releaseWrite: (() => void) | undefined;
    let signalWriteStarted: (() => void) | undefined;
    const writePending = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const backupOne = vi.fn(async () => {
      signalWriteStarted?.();
      await writePending;
    });
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 1 },
    });
    const service = new BackupService({
      settings,
      delegate: delegate({
        listModified: async () => [
          {
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            displayName: "暂停备份",
            modifiedAt: "2026-08-16T00:00:00.000Z",
            revision: 1,
          },
        ],
        backupOne,
      }),
    });
    await service.initialize();
    vi.advanceTimersByTime(5_000);
    await writeStarted;

    let suspended = false;
    const suspension = service.suspend().then((resume) => {
      suspended = true;
      return resume;
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(backupOne).toHaveBeenCalledOnce();
    expect(suspended).toBe(false);
    await expect(service.runNow()).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });

    releaseWrite?.();
    const resume = await suspension;
    await Promise.all([resume(), resume()]);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(backupOne).toHaveBeenCalledTimes(2));
    await service.shutdown();
  });

  test("does not enable a schedule that was stopped before suspension", async () => {
    const backupOne = vi.fn(async () => undefined);
    const settings = settingsStore({
      ...DEFAULT_APP_SETTINGS,
      backup: { enabled: true, folder: root, intervalMinutes: 1 },
    });
    const service = new BackupService({ settings, delegate: delegate({ backupOne }) });

    const resume = await service.suspend();
    await resume();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(backupOne).not.toHaveBeenCalled();
  });

  test("restores its schedule when the in-flight backup observed by suspend rejects", async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const failingRead = new Promise<AppSettings>((_resolve, reject) => {
      rejectRead = reject;
    });
    let reads = 0;
    const settings = {
      read: vi.fn(async () => {
        reads += 1;
        if (reads === 1) {
          signalReadStarted?.();
          return failingRead;
        }
        return {
          ...DEFAULT_APP_SETTINGS,
          backup: { enabled: true, folder: root, intervalMinutes: 1 },
        };
      }),
      update: vi.fn(async () => DEFAULT_APP_SETTINGS),
    };
    const service = new BackupService({ settings, delegate: delegate() });
    service.start({ enabled: true, folder: root, intervalMinutes: 1 });
    vi.advanceTimersByTime(5_000);
    await readStarted;

    const failure = new Error("settings read failed");
    const suspension = service.suspend();
    rejectRead?.(failure);
    await expect(suspension).rejects.toBe(failure);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settings.read).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });
});
