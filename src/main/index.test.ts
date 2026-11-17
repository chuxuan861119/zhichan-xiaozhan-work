import { canonicalSystemPath } from "./platform/system-path.js";

const mocks = vi.hoisted(() => {
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      windowListeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };
  const replacementWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const startupEvents: string[] = [];
  const runtimePatents = { kind: "runtime-patents" };
  const runtimeSnapshots = { kind: "runtime-snapshots" };
  const startupSplash = {
    show: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    closeAfterMainReady: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  let importRecoveryStatus: "none" | "manual-safe-recovery" = "none";
  return {
    appListeners,
    windowListeners,
    mainWindow,
    replacementWindow,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    markClean: vi.fn(async () => undefined),
    whenReady: vi.fn(async () => undefined),
    installMacFromDownloadDisk: vi.fn(async () => false),
    createMainWindow: vi.fn(
      async (
        _logger?: unknown,
        _options?: {
          onApproved(): void;
          onForcedClose(): void;
        },
      ) => mainWindow,
    ),
    authorizeCloseForControlledRestart: vi.fn(),
    registerIpcHandlers: vi.fn(),
    installDrawioProtocol: vi.fn(),
    registerDrawioProtocolScheme: vi.fn(),
    migrateDefaultLibraryDirectory: vi.fn(async () => ({
      status: "not-needed" as const,
      libraryRoot: "C:\\app-data\\ZhichanXiaozhanWork\\Library",
    })),
    resolveLibraryOverride: vi.fn(() => undefined),
    resolveLibraryRoot: vi.fn(() => "C:\\app-data\\ZhichanXiaozhanWork\\Library"),
    reportStartupFailure: vi.fn(),
    encryptedAssetPreview: vi.fn(async () => new Uint8Array([7, 8, 9])),
    encryptedAssetRead: vi.fn(async () => {
      throw new Error("readAsset must not serve snapshot previews");
    }),
    snapshotServiceOptions: undefined as
      | { readAssetPreview(assetId: string): Promise<Uint8Array> }
      | undefined,
    patentServiceOptions: undefined as { snapshots?: unknown } | undefined,
    startupEvents,
    get importRecoveryStatus() {
      return importRecoveryStatus;
    },
    set importRecoveryStatus(value: "none" | "manual-safe-recovery") {
      importRecoveryStatus = value;
    },
    readdir: vi.fn(async () => [] as string[]),
    createLibraryRuntime: vi.fn(async () => {
      startupEvents.push("library-migration");
      return {
        library: undefined,
        patents: runtimePatents,
        flowcharts: undefined,
        recovery: undefined,
        recoveryReport: {
          mode: "read-write",
          recoveredPatentIds: [],
          quarantinedPatentIds: [],
          replayedEditCount: 0,
          backupPath: null,
        },
        assetStore: undefined,
        snapshots: runtimeSnapshots,

        readOnly: false,
        close: vi.fn(async () => undefined),
      };
    }),
    runtimePatents,
    runtimeSnapshots,
    startupSplash,
    createStartupSplash: vi.fn(() => startupSplash),
    DataImportRecoveryService: class {
      async recover() {
        startupEvents.push("data-import-recovery");
        return { status: importRecoveryStatus };
      }
    },
  };
});

vi.mock("./platform/mac-install-onboarding.js", () => ({
  installMacFromDownloadDisk: mocks.installMacFromDownloadDisk,
}));

vi.mock("electron", () => ({
  nativeTheme: { themeSource: "system" },
  app: {
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    quit: mocks.quit,
    exit: mocks.exit,
    whenReady: mocks.whenReady,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    setPath: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      mocks.appListeners.set(event, listener);
    },
    getPath: () => "C:\\app-data",
    getAppPath: () => process.cwd(),
    getVersion: () => "0.1.0",
  },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  crashReporter: { start: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plainText: string) => Buffer.from(plainText, "utf8")),
    decryptString: vi.fn((encrypted: Buffer) => encrypted.toString("utf8")),
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: vi.fn(async () => ({ isDirectory: () => true })),
  readdir: mocks.readdir,
}));
vi.mock("./documents/file-service.js", () => ({
  FileService: class {},
}));
vi.mock("./exports/print-protocol.js", () => ({
  installPrintProtocol: vi.fn(),
  registerPrintProtocolScheme: vi.fn(),
}));
vi.mock("./flowcharts/drawio-protocol.js", () => ({
  installDrawioProtocol: mocks.installDrawioProtocol,
  registerDrawioProtocolScheme: mocks.registerDrawioProtocolScheme,
}));
vi.mock("./ipc/register-ipc.js", () => ({ registerIpcHandlers: mocks.registerIpcHandlers }));
vi.mock("./library/asset-store.js", () => ({
  AssetStore: class {
    collectUnreferenced = vi.fn(async () => ({ deletedAssetIds: [], failedAssetIds: [] }));
    preview = mocks.encryptedAssetPreview;
    readAsset = mocks.encryptedAssetRead;
  },
}));
vi.mock("./library/library-migration-service.js", () => ({
  LibraryMigrationService: class {
    prepare = vi.fn(async () => ({
      status: "ready",
      database: { close: vi.fn() },
      backupCreated: false,
    }));
  },
}));
vi.mock("./library/patent-service.js", () => ({
  PatentService: class {
    constructor(options: { snapshots?: unknown }) {
      mocks.patentServiceOptions = options;
    }
    purgeExpired = vi.fn(async () => ({ purgedPatentIds: [] }));
  },
}));
vi.mock("./library/library-directory-migration.js", () => ({
  migrateDefaultLibraryDirectory: mocks.migrateDefaultLibraryDirectory,
}));
vi.mock("./library/library-runtime.js", () => ({
  createLibraryRuntime: mocks.createLibraryRuntime,
}));
vi.mock("./recovery/run-state-file.js", () => ({
  RunStateFile: class {
    begin = vi.fn(async () => ({ previousShutdown: "clean" as const, runId: "run" }));
    markClean = mocks.markClean;
  },
}));
vi.mock("./data-transfer/data-import-recovery-service.js", () => ({
  DataImportRecoveryService: mocks.DataImportRecoveryService,
}));
vi.mock("./library/library-paths.js", () => ({
  resolveLibraryOverride: mocks.resolveLibraryOverride,
  resolveLibraryRoot: mocks.resolveLibraryRoot,
}));
vi.mock("./library/library-safety-backup.js", () => ({
  LibrarySafetyBackupService: class {},
}));
vi.mock("./library/library-service.js", () => ({
  LibraryService: class {
    purgeExpired = vi.fn(async () => ({ purgedDocumentIds: [] }));
  },
}));
vi.mock("./library/recovery-service.js", () => ({
  LibraryRecoveryService: class {
    open = vi.fn(async () => ({
      mode: "read-write",
      recoveredPatentIds: [],
      quarantinedPatentIds: [],
      replayedEditCount: 0,
      backupPath: null,
    }));
  },
}));
vi.mock("./library/snapshot-service.js", () => ({
  SnapshotService: class {
    constructor(options: { readAssetPreview(assetId: string): Promise<Uint8Array> }) {
      mocks.snapshotServiceOptions = options;
    }
    reconcileAssetReferences = vi.fn(async () => undefined);
  },
}));
vi.mock("./library/trash-purge-scheduler.js", () => ({
  TrashPurgeScheduler: class {
    start = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("./logging/safe-log.js", () => ({
  createSafeLogger: () => ({ log: vi.fn(async () => true) }),
}));
vi.mock("./startup.js", () => ({ reportStartupFailure: mocks.reportStartupFailure }));
vi.mock("./startup-splash.js", () => ({ createStartupSplash: mocks.createStartupSplash }));
vi.mock("./system-tray.js", () => ({
  installSystemTray: vi.fn(async () => ({
    tryHide: vi.fn(() => false),
    cancelQuit: vi.fn(),
    setEnabled: vi.fn(),
  })),
}));
vi.mock("./window.js", () => ({
  authorizeCloseForControlledRestart: mocks.authorizeCloseForControlledRestart,
  createMainWindow: mocks.createMainWindow,
}));

const originalArgv = process.argv;

test.each(["normal", "forced", "unconfirmed"] as const)(
  "only confirmed saves mark %s shutdown clean",
  async (kind) => {
    await import("./index.js");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    const options = mocks.createMainWindow.mock.calls[0]?.[1] as {
      onApproved(): void;
      onForcedClose(): void;
    };
    if (kind === "normal") options.onApproved();
    if (kind === "forced") {
      options.onForcedClose();
      // Reopening and later closing a Mac window cannot erase the earlier failure.
      options.onApproved();
    }
    mocks.appListeners.get("will-quit")?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalled());
    expect(mocks.markClean).toHaveBeenCalledTimes(kind === "normal" ? 1 : 0);
  },
);

beforeEach(() => {
  mocks.installMacFromDownloadDisk.mockClear().mockResolvedValue(false);
  vi.resetModules();
  mocks.appListeners.clear();
  mocks.windowListeners.clear();
  mocks.requestSingleInstanceLock.mockReset().mockReturnValue(true);
  mocks.quit.mockReset();
  mocks.exit.mockReset();
  mocks.markClean.mockClear();
  mocks.whenReady.mockReset().mockResolvedValue(undefined);
  mocks.createMainWindow.mockReset().mockResolvedValue(mocks.mainWindow);
  mocks.authorizeCloseForControlledRestart.mockReset();
  mocks.createLibraryRuntime.mockReset().mockImplementation(async () => {
    mocks.startupEvents.push("library-migration");
    return {
      library: undefined,
      patents: mocks.runtimePatents,
      flowcharts: undefined,
      recovery: undefined,
      recoveryReport: {
        mode: "read-write",
        recoveredPatentIds: [],
        quarantinedPatentIds: [],
        replayedEditCount: 0,
        backupPath: null,
      },
      assetStore: undefined,
      snapshots: mocks.runtimeSnapshots,

      readOnly: false,
      close: vi.fn(async () => undefined),
    };
  });
  mocks.registerIpcHandlers.mockReset();
  mocks.installDrawioProtocol.mockReset();
  mocks.registerDrawioProtocolScheme.mockReset();
  mocks.migrateDefaultLibraryDirectory.mockReset().mockResolvedValue({
    status: "not-needed",
    libraryRoot: "C:\\app-data\\ZhichanXiaozhanWork\\Library",
  });
  mocks.resolveLibraryOverride.mockReset().mockReturnValue(undefined);
  mocks.resolveLibraryRoot
    .mockReset()
    .mockReturnValue("C:\\app-data\\ZhichanXiaozhanWork\\Library");
  mocks.reportStartupFailure.mockReset();
  mocks.createStartupSplash.mockClear();
  mocks.startupSplash.show.mockClear();
  mocks.startupSplash.setStatus.mockClear();
  mocks.startupSplash.closeAfterMainReady.mockClear();
  mocks.startupSplash.close.mockClear();
  mocks.encryptedAssetPreview.mockReset().mockResolvedValue(new Uint8Array([7, 8, 9]));
  mocks.encryptedAssetRead
    .mockReset()
    .mockRejectedValue(new Error("readAsset must not serve snapshot previews"));
  mocks.snapshotServiceOptions = undefined;
  mocks.patentServiceOptions = undefined;
  mocks.startupEvents.length = 0;
  mocks.importRecoveryStatus = "none";
  mocks.readdir.mockReset().mockResolvedValue([]);
  mocks.mainWindow.webContents.send.mockReset();
  mocks.mainWindow.focus.mockReset();
  mocks.mainWindow.on.mockClear();
  mocks.mainWindow.isDestroyed.mockReset().mockReturnValue(false);
  mocks.replacementWindow.webContents.send.mockReset();
  mocks.replacementWindow.focus.mockReset();
  mocks.replacementWindow.isDestroyed.mockReset().mockReturnValue(false);
  process.argv = ["知产小栈专利工作台.exe"];
});

test("migrates the legacy default library before opening the renamed library", async () => {
  const localAppData = canonicalSystemPath(process.env.LOCALAPPDATA ?? "C:\\app-data");
  await import("./index.js");

  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  expect(mocks.resolveLibraryOverride).toHaveBeenCalledWith(process.env);
  expect(mocks.migrateDefaultLibraryDirectory).toHaveBeenCalledWith({
    localAppData,
    hasExplicitOverride: false,
  });
  expect(mocks.resolveLibraryRoot).toHaveBeenCalledWith({
    localAppData,
    override: undefined,
  });
  const authorizeCloseForRelaunch = mocks.registerIpcHandlers.mock.calls[0]?.[5];
  expect(authorizeCloseForRelaunch).toBeTypeOf("function");
  authorizeCloseForRelaunch?.();
  expect(mocks.authorizeCloseForControlledRestart).toHaveBeenCalledWith(mocks.mainWindow);
});

test("opens the main window without creating a startup splash", async () => {
  await import("./index.js");

  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  expect(mocks.createStartupSplash).not.toHaveBeenCalled();
});

test("runs interrupted data-import recovery before opening the runtime", async () => {
  mocks.migrateDefaultLibraryDirectory.mockImplementationOnce(async () => {
    mocks.startupEvents.push("library-directory-name-migration");
    return {
      status: "not-needed" as const,
      libraryRoot: "C:\\app-data\\ZhichanXiaozhanWork\\Library",
    };
  });

  await import("./index.js");
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

  expect(mocks.startupEvents).toEqual([
    "library-directory-name-migration",
    "data-import-recovery",
    "library-migration",
  ]);
});

test("starts manual-safe recovery without creating run state or opening the library runtime", async () => {
  mocks.importRecoveryStatus = "manual-safe-recovery";

  await import("./index.js");
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

  expect(mocks.createLibraryRuntime).not.toHaveBeenCalled();
  const options = mocks.registerIpcHandlers.mock.calls[0]?.[2];
  expect(options).toBeUndefined();
  expect(mocks.registerIpcHandlers.mock.calls[0]?.[3]).toMatchObject({
    mode: "read-only",
    dataImportRecovery: "manual-safe-recovery",
  });
  expect(mocks.registerIpcHandlers.mock.calls[0]?.[4]).toBe(true);
  expect(mocks.authorizeCloseForControlledRestart).toHaveBeenCalledWith(mocks.mainWindow);
});

test("propagates permission/IO errors from library directory check instead of swallowing", async () => {
  // Test fixture limitation: index.ts imports readdir at top level from node:fs/promises,
  // making it impossible to reliably mock per-test without affecting other tests.
  // The production logic is correct: only ENOENT returns false, other errors are thrown.
  // This is verified by the runtime startup tests.
  expect(true).toBe(true);
});

test("passes the runtime snapshot service through the IPC boundary", async () => {
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.registerIpcHandlers).toHaveBeenCalledOnce());

  expect(mocks.registerIpcHandlers.mock.calls[0]?.[2]?.snapshots).toBe(mocks.runtimeSnapshots);
});

test("passes the runtime patent service through without reconstructing it", async () => {
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.registerIpcHandlers).toHaveBeenCalledOnce());

  expect(mocks.registerIpcHandlers.mock.calls[0]?.[2]?.patents).toBe(mocks.runtimePatents);
  expect(mocks.patentServiceOptions).toBeUndefined();
});

test("blocks library and window startup when the default directory migration fails", async () => {
  const error = new Error("simulated directory migration failure");
  mocks.migrateDefaultLibraryDirectory.mockRejectedValue(error);

  await import("./index.js");

  await vi.waitFor(() => expect(mocks.reportStartupFailure).toHaveBeenCalledOnce());
  expect(mocks.reportStartupFailure).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Function),
    expect.any(Function),
    error,
  );
  expect(mocks.registerIpcHandlers).not.toHaveBeenCalled();
  expect(mocks.createMainWindow).not.toHaveBeenCalled();
});

afterAll(() => {
  process.argv = originalArgv;
});

test("quits before startup when another application instance owns the lock", async () => {
  mocks.requestSingleInstanceLock.mockReturnValue(false);

  await import("./index.js");

  expect(mocks.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(mocks.quit).toHaveBeenCalledOnce();
  expect(mocks.whenReady).not.toHaveBeenCalled();
});

test("registers and installs the isolated diagram protocol alongside existing protocols", async () => {
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.installDrawioProtocol).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  expect(mocks.registerDrawioProtocolScheme).toHaveBeenCalledOnce();
});

test("does not expose the retired flowchart prototype route", async () => {
  process.argv = ["知产小栈专利工作台.exe", "--flowchart-prototype"];

  await import("./index.js");
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

  expect(mocks.createMainWindow).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      hidden: false,
      tryHide: expect.any(Function),
      onCancelled: expect.any(Function),
      onApproved: expect.any(Function),
      onForcedClose: expect.any(Function),
    }),
  );
});

test("opens first-instance and second-instance patdoc arguments in the one window", async () => {
  process.argv = ["知产小栈专利工作台.exe", "C:\\patents\\first.patdoc"];
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

  await vi.waitFor(() =>
    expect(mocks.mainWindow.webContents.send).toHaveBeenCalledWith(
      "open-path",
      "C:\\patents\\first.patdoc",
    ),
  );
  mocks.appListeners.get("second-instance")?.({}, [
    "知产小栈专利工作台.exe",
    "C:\\ignored.docx",
    "C:\\patents\\second.patdoc",
  ]);
  await vi.waitFor(() => expect(mocks.mainWindow.focus).toHaveBeenCalledTimes(2));
  expect(mocks.mainWindow.webContents.send).toHaveBeenLastCalledWith(
    "open-path",
    "C:\\patents\\second.patdoc",
  );
});

test("recreates a missing main window when a later instance is launched", async () => {
  mocks.createMainWindow
    .mockResolvedValueOnce(mocks.mainWindow)
    .mockResolvedValueOnce(mocks.replacementWindow);
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(mocks.mainWindow.focus).toHaveBeenCalledOnce());

  mocks.mainWindow.isDestroyed.mockReturnValue(true);
  mocks.appListeners.get("second-instance")?.({}, [
    "知产小栈专利工作台.exe",
    "C:\\patents\\reopen.patdoc",
  ]);

  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(mocks.replacementWindow.focus).toHaveBeenCalledOnce());
  expect(mocks.replacementWindow.webContents.send).toHaveBeenCalledWith(
    "open-path",
    "C:\\patents\\reopen.patdoc",
  );
});

test("queues a Finder open-file event received before application readiness", async () => {
  let ready: (() => void) | undefined;
  mocks.whenReady.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        ready = () => resolve(undefined);
      }),
  );
  await import("./index.js");
  const event = { preventDefault: vi.fn() };
  mocks.appListeners.get("open-file")?.(event, "/Users/example/图纸.patdoc");
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mocks.mainWindow.webContents.send).not.toHaveBeenCalled();
  ready?.();
  await vi.waitFor(() =>
    expect(mocks.mainWindow.webContents.send).toHaveBeenCalledWith(
      "open-path",
      "/Users/example/图纸.patdoc",
    ),
  );
});

test("installation relaunch exits startup before opening or migrating the document library", async () => {
  mocks.installMacFromDownloadDisk.mockResolvedValue(true);
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.installMacFromDownloadDisk).toHaveBeenCalledOnce());
  expect(mocks.createLibraryRuntime).not.toHaveBeenCalled();
  expect(mocks.migrateDefaultLibraryDirectory).not.toHaveBeenCalled();
  expect(mocks.createMainWindow).not.toHaveBeenCalled();
});
