import { join } from "node:path";
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  nativeTheme,
  powerMonitor,
  systemPreferences,
} from "electron";
import legalPolicy from "../../resources/legal-policies.json" with { type: "json" };
import {
  APPLICATION_APP_ID,
  APPLICATION_DATA_DIRECTORY,
  APPLICATION_NAME,
  APPLICATION_VERSION,
} from "../shared/branding.js";
import { APPLICATION_DIAGNOSTIC_VERSION } from "../shared/build-info.js";
import { IPC_CHANNELS } from "../shared/ipc/contract.js";
import { LegalPolicySchema } from "../shared/legal/model.js";
import { isHarmonyPlatform } from "../shared/platform.js";
import {
  createLibraryInitializationFailureReport,
  createStartupRecoveryReport,
  type LibraryInitializationFailure,
  type PreviousShutdownStatus,
} from "../shared/recovery/startup-recovery.js";
import { installAppProtocol } from "./app-protocol.js";
import { installLibraryServiceShutdown } from "./application-lifecycle.js";
import { registerApplicationSchemes } from "./application-schemes.js";
import { TransferHandoffStore } from "./automation/transfer-handoff.js";
import { DataImportJournal } from "./data-transfer/data-import-journal.js";
import { DataImportRecoveryService } from "./data-transfer/data-import-recovery-service.js";
import { recoverAbandonedExportTasks } from "./data-transfer/export-task-recovery.js";
import { ImportStagingOwnership } from "./data-transfer/import-staging-ownership.js";
import { FileService } from "./documents/file-service.js";
import { installPrintProtocol } from "./exports/print-protocol.js";
import { installDrawioProtocol } from "./flowcharts/drawio-protocol.js";
import { registerIpcHandlers } from "./ipc/register-ipc.js";
import { installIpcDataProtocol } from "./ipc-data-center/ipc-data-protocol.js";
import { AgreementService } from "./legal/agreement-service.js";
import { migrateDefaultLibraryDirectory } from "./library/library-directory-migration.js";
import { LibraryLocation } from "./library/library-location.js";
import { resolveLibraryOverride, resolveLibraryRoot } from "./library/library-paths.js";
import { restartAfterLibraryMove } from "./library/library-restart.js";
import {
  createLibraryRuntime,
  type LibraryRuntime,
  LibraryRuntimePreparationError,
} from "./library/library-runtime.js";
import { createSafeLogger } from "./logging/safe-log.js";
import { OpenPathAuthorization } from "./open-path-authorization.js";
import { installDeferredQuit } from "./platform/deferred-quit.js";
import { harmonyPatdocPath } from "./platform/harmony-open-file.js";
import { createHarmonySystem, type HarmonyBridge } from "./platform/harmony-system.js";
import { installDockOnboarding } from "./platform/install-dock-onboarding.js";
import { installMacFromDownloadDisk } from "./platform/mac-install-onboarding.js";
import { createStartupFileOpenGuard } from "./platform/startup-file-open-guard.js";
import { canonicalSystemPath } from "./platform/system-path.js";
import { UsageActivity } from "./platform/usage-activity.js";
import { RunStateFile } from "./recovery/run-state-file.js";
import { SettingsService } from "./settings/settings-service.js";
import { isStartupIsolated, STARTUP_TRAY_ARGUMENT } from "./settings/startup-service.js";
import { findFirstPatdocArgument, sendPatdocOpenCommand } from "./single-instance.js";
import { reportStartupFailure } from "./startup.js";
import { installSystemTray } from "./system-tray.js";
import { HarmonyTutorialLauncher } from "./tutorial/harmony-launcher.js";
import { TutorialLauncher } from "./tutorial/launcher.js";
import { TutorialSeedService } from "./tutorial/seed.js";
import { readTutorialSession } from "./tutorial/session.js";
import { markTutorialReady, watchTutorialCommands } from "./tutorial/transport.js";
import { usageStatisticsConfig } from "./usage-statistics/usage-statistics-config.js";
import { UsageStatisticsService } from "./usage-statistics/usage-statistics-service.js";
import { sendUsageAggregate } from "./usage-statistics/usage-statistics-transport.js";
import { authorizeCloseForControlledRestart, createMainWindow } from "./window.js";

// The application exposes its own explicit motion preference. Keep Chromium's
// media queries neutral so a stale or incorrect OS report cannot override it.
app.commandLine.appendSwitch("force-prefers-no-reduced-motion");
// Chromium can default to instant scrolling on Windows even for behavior: "smooth".
// Call sites still honor the application motion preference before requesting animation.
app.commandLine.appendSwitch("enable-smooth-scrolling");
registerApplicationSchemes();
// Validate before creating any service: invalid training startup must never use normal data.
const tutorialSession = readTutorialSession(process.argv);
if (tutorialSession) {
  process.env.LOCALAPPDATA = tutorialSession.localAppData;
  process.env.ZXW_HOME = tutorialSession.cliHome;
  process.env.PATENT_WORKBENCH_LIBRARY_ROOT = tutorialSession.library;
  process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT = tutorialSession.library;
}
const applicationUserDataPath =
  tutorialSession?.userData ?? canonicalSystemPath(app.getPath("userData"));
app.setName(APPLICATION_NAME);
if (process.platform === "darwin") nativeTheme.themeSource = "light";
if (process.platform === "win32") app.setAppUserModelId(APPLICATION_APP_ID);
app.setPath("userData", applicationUserDataPath);
if (!process.mas) crashReporter.start({ uploadToServer: false });

const logger = createSafeLogger(
  join(app.getPath("userData"), "logs"),
  APPLICATION_DIAGNOSTIC_VERSION,
);

let libraryLocation: LibraryLocation | undefined;
let libraryLocationNotice: string | undefined;
let recoverySourceRoot: string | undefined;
// A closed database does not prove that the renderer's pending edits were saved.
let exitSaveConfirmed = false;
let forcedCloseOccurred = false;
let tutorialSeed: TutorialSeedService | undefined;
async function createLibraryIpcOptions() {
  const localAppData = canonicalSystemPath(process.env.LOCALAPPDATA ?? app.getPath("userData"));
  const override = resolveLibraryOverride({
    ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT,
    PATENT_WORKBENCH_LIBRARY_ROOT: process.env.PATENT_WORKBENCH_LIBRARY_ROOT,
  });
  await migrateDefaultLibraryDirectory({
    localAppData,
    hasExplicitOverride: override !== undefined,
  });
  const defaultLibraryRoot = resolveLibraryRoot({
    localAppData,
    override,
  });
  const userDataRoot = app.getPath("userData");
  libraryLocation = new LibraryLocation(
    join(userDataRoot, "library-location.json"),
    defaultLibraryRoot,
  );
  let migrationWindow: BrowserWindow | undefined;
  let resolvedLocation: Awaited<ReturnType<LibraryLocation["resolveStartup"]>>;
  try {
    resolvedLocation = await libraryLocation.resolveStartup((completed, total) => {
      if (!migrationWindow) {
        migrationWindow = new BrowserWindow({
          width: 460,
          height: 190,
          resizable: false,
          minimizable: false,
          maximizable: false,
          title: "正在迁移文档库",
          frame: false,
          transparent: true,
          hasShadow: false,
          backgroundColor: "#00000000",
          show: process.env.PATENT_WORKBENCH_TEST !== "1",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        migrationWindow.on("close", (event) => event.preventDefault());
        void migrationWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent('<html lang="zh-CN"><style>html{background:transparent}body{box-sizing:border-box;margin:0;height:100vh;border-radius:12px;background:white;font:16px system-ui;padding:24px;color:#1e293b;animation:fade-in 400ms ease-in-out}body.exiting{animation:fade-out 400ms ease-in-out forwards}@keyframes fade-in{from{opacity:0}to{opacity:1}}@keyframes fade-out{from{opacity:1}to{opacity:0}}@media(prefers-reduced-motion:reduce){body,body.exiting{animation:none}}</style><body><h3>正在迁移文档库</h3><p>正在复制并校验，请勿关闭电脑或断开磁盘。</p></body></html>')}`,
        );
      }
      migrationWindow.setProgressBar(total ? completed / total : 2);
    });
  } finally {
    if (migrationWindow) {
      const finishedWindow = migrationWindow;
      void finishedWindow.webContents
        .executeJavaScript("document.body.classList.add('exiting')")
        .then(
          () =>
            setTimeout(() => {
              if (!finishedWindow.isDestroyed()) finishedWindow.destroy();
            }, 400),
          () => {
            if (!finishedWindow.isDestroyed()) finishedWindow.destroy();
          },
        );
    }
  }
  const libraryRoot = resolvedLocation.root;
  recoverySourceRoot = libraryRoot;
  libraryLocationNotice = resolvedLocation.notice;
  const applicationDataRoot = join(localAppData, APPLICATION_DATA_DIRECTORY);
  const importJournal = new DataImportJournal({ applicationDataRoot, libraryRoot, userDataRoot });
  const importIdBeforeRecovery = await importJournal
    .recover({ exclusiveStartup: true })
    .then((record) => record?.operationId)
    .catch(() => undefined);
  const importRecovery = await new DataImportRecoveryService({
    journal: importJournal,
    libraryRoot,
    userDataRoot,
    applicationDataRoot,
  }).recover();
  await new TransferHandoffStore(applicationDataRoot, libraryRoot)
    .settle(importIdBeforeRecovery, importRecovery)
    .catch(() => undefined);
  let importRecoveryStatus = importRecovery.status;
  if (importRecoveryStatus !== "manual-safe-recovery") {
    const exports = await recoverAbandonedExportTasks(applicationDataRoot, {
      exclusiveStartup: true,
    });
    if (exports.pending) await logger.log("warn", { event: "app.error", errorCode: "INTERNAL" });
    try {
      await new ImportStagingOwnership({ applicationDataRoot, libraryRoot, userDataRoot }).recover({
        exclusiveStartup: true,
      });
    } catch {
      importRecoveryStatus = "manual-safe-recovery";
    }
  }
  if (importRecoveryStatus === "manual-safe-recovery") {
    const startupRecoveryReport = createStartupRecoveryReport({
      previousShutdown: "unknown",
      recovery: {
        mode: "read-only",
        recoveredPatentIds: [],
        quarantinedPatentIds: [],
        replayedEditCount: 0,
        backupPath: null,
      },
      dataImportRecovery: importRecoveryStatus,
      checkedAt: new Date().toISOString(),
    });
    return {
      ipc: undefined,
      startupRecoveryReport: { ...startupRecoveryReport, recoverySourcesUnavailable: true },
      startupReadOnly: true,
      close: async () => undefined,
    };
  }
  let libraryInitializationFailure: LibraryInitializationFailure = "unknown";
  const runtime: LibraryRuntime | null = await createLibraryRuntime({
    libraryRoot,
    userDataRoot,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: !tutorialSession,
  }).catch(async (error: unknown) => {
    if (tutorialSession) throw error;
    if (error instanceof LibraryRuntimePreparationError && error.reason === "unsupported-schema")
      throw error;
    libraryInitializationFailure =
      error instanceof LibraryRuntimePreparationError && error.reason !== "unsupported-schema"
        ? error.reason
        : "unknown";
    await logger.log("warn", {
      event: "library.recovery_read_only",
      errorCode: "LIBRARY_INITIALIZATION_FAILED",
    });
    return null;
  });
  if (!runtime) {
    return {
      ipc: undefined,
      startupRecoveryReport: createLibraryInitializationFailureReport(
        libraryInitializationFailure,
        new Date().toISOString(),
      ),
      startupReadOnly: true,
      close: async () => undefined,
    };
  }
  if (tutorialSession) {
    tutorialSeed = new TutorialSeedService(tutorialSession.sessionId, runtime);
    await tutorialSeed.prepare(tutorialSession.lessonId);
  }
  const runState = new RunStateFile(join(libraryRoot, "last-run-state.json"));
  let runStateStarted = false;
  let previousShutdown: PreviousShutdownStatus = "unknown";
  try {
    previousShutdown = (await runState.begin(app.getVersion())).previousShutdown;
    runStateStarted = true;
  } catch {
    // A missing or unwritable marker must not prevent access to the document library.
  }
  const recoveryReport = runtime.recoveryReport;
  const startupRecoveryReport = createStartupRecoveryReport({
    previousShutdown,
    recovery: recoveryReport,
    dataImportRecovery: importRecoveryStatus,
    checkedAt: new Date().toISOString(),
  });
  return {
    ipc: {
      automationRuntime: runtime,
      ...(runtime.contentSearch ? { contentSearch: runtime.contentSearch } : {}),
      library: runtime.library,
      patents: runtime.patents,
      patentTemplates: runtime.patentTemplates,
      flowcharts: runtime.flowcharts,
      recovery: runtime.recovery,
      fileService: new FileService(),
      assetStore: runtime.assetStore,
      snapshots: runtime.snapshots,

      readOnly: runtime.readOnly,
      dataTransferRuntime: {
        database: runtime.database,
        libraryRoot,
        userDataRoot,
        applicationDataRoot,
        backgroundScheduler: runtime.backgroundScheduler,
        assets: runtime.assetStore,
        closeRuntime: () => runtime.close(),
      },
    },
    startupRecoveryReport,
    startupReadOnly: false,
    close: async () => {
      await runtime.close();
      if (runStateStarted && exitSaveConfirmed && !forcedCloseOccurred) await runState.markClean();
    },
  };
}

const allowMultipleTestInstances =
  process.env.PATENT_WORKBENCH_TEST === "1" &&
  process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES === "1";
if (!tutorialSession && !allowMultipleTestInstances && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  let usageStatistics: UsageStatisticsService | undefined;
  let usageActivity: UsageActivity | undefined;
  let windowCreation: Promise<BrowserWindow> | undefined;
  let windowServicesReady = false;
  const deferredQuit = installDeferredQuit(
    app,
    () => windowServicesReady,
    process.platform,
    Boolean(tutorialSession),
  );
  let startupReadOnly = false;
  const settings = new SettingsService(join(app.getPath("userData"), "settings.json"));
  const tutorialLauncher = tutorialSession
    ? undefined
    : isHarmonyPlatform(process.platform)
      ? new HarmonyTutorialLauncher({
          logger,
          rendererRoot: join(__dirname, "../renderer"),
          agreements: (root) =>
            new AgreementService({
              statePath: join(root, "agreement-consent.json"),
              appVersion: APPLICATION_VERSION,
              platform: process.platform,
              policy: LegalPolicySchema.parse(legalPolicy),
              bypass: true,
            }),
        })
      : new TutorialLauncher({
          executable: process.execPath,
          entry: app.isPackaged ? app.getAppPath() : (process.argv[1] ?? app.getAppPath()),
          environment: process.env,
        });
  const openedAtLogin = () =>
    process.argv.includes(STARTUP_TRAY_ARGUMENT) ||
    Boolean(
      process.platform === "darwin" &&
        app.isPackaged &&
        app.getLoginItemSettings().wasOpenedAtLogin,
    );
  let trayController: Awaited<ReturnType<typeof installSystemTray>> | undefined;
  let closeLibraryServices: (() => void | Promise<void>) | undefined;
  let disposeIpc: (() => Promise<void>) | undefined;
  let disposeTutorialCommands: (() => void) | undefined;
  let restartForLibraryMove = false;
  let relocationCloseApproved = false;
  let cancelRelocation = Promise.resolve();
  installLibraryServiceShutdown(
    app,
    async () => {
      disposeTutorialCommands?.();
      usageActivity?.dispose();
      await usageStatistics?.close();
      try {
        const failures: unknown[] = [];
        try {
          await disposeIpc?.();
        } catch (error) {
          exitSaveConfirmed = false;
          failures.push(error);
        }
        try {
          await closeLibraryServices?.();
        } catch (error) {
          failures.push(error);
        }
        closeLibraryServices = undefined;
        if (failures.length) throw new AggregateError(failures, "退出收尾未完整完成。");
        if (restartForLibraryMove && relocationCloseApproved) {
          await libraryLocation?.approveAfterShutdown();
          await restartAfterLibraryMove(
            {
              isPackaged: app.isPackaged,
              rendererUrl: process.env.ELECTRON_RENDERER_URL,
              appPath: app.getAppPath(),
              execPath: process.execPath,
              pid: process.pid,
              parentPid: process.ppid,
              logPath: join(app.getPath("userData"), "logs", "library-restart.log"),
              args: process.argv.slice(1).filter((argument) => argument !== STARTUP_TRAY_ARGUMENT),
            },
            { relaunch: (options) => app.relaunch(options) },
          );
        } else if (restartForLibraryMove) await libraryLocation?.cancel();
      } catch (error) {
        if (restartForLibraryMove) {
          await libraryLocation?.cancel().catch(() => undefined);
          dialog.showErrorBox(
            "迁移未开始",
            "退出保存或迁移准备未完成，原文档库未移动。请重新启动软件，完成恢复后重试迁移。",
          );
        }
        throw error;
      }
    },
    async () => {
      await logger.log("error", { event: "app.error", errorCode: "INTERNAL" });
      if (!restartForLibraryMove)
        dialog.showErrorBox(
          "退出收尾未完成",
          "部分后台任务未能正常结束，已保留恢复标记。请重新启动软件，查看恢复检查结果。",
        );
    },
  );
  const pendingPaths: string[] = [];
  const startupFileOpenGuard = createStartupFileOpenGuard(
    isHarmonyPlatform(process.platform) ? 2000 : 0,
  );
  const openPathAuthorization = new OpenPathAuthorization();
  const dispatchOpenPath = (path: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    openPathAuthorization.authorize(path);
    if (sendPatdocOpenCommand(mainWindow, path)) return true;
    openPathAuthorization.revoke(path);
    return false;
  };
  const ensureMainWindow = async (): Promise<BrowserWindow> => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    if (windowCreation) return windowCreation;
    exitSaveConfirmed = false;
    windowCreation = createMainWindow(logger, {
      tutorial: Boolean(tutorialSession),
      hidden:
        (Boolean(tutorialSession) &&
          process.env.PATENT_WORKBENCH_TEST === "1" &&
          process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") ||
        (openedAtLogin() && !findFirstPatdocArgument(process.argv) && !startupReadOnly),
      tryHide: () => trayController?.tryHide() ?? false,
      onCancelled: () => {
        deferredQuit.cancel();
        trayController?.cancelQuit();
        if (restartForLibraryMove) {
          restartForLibraryMove = false;
          cancelRelocation = libraryLocation?.cancel() ?? Promise.resolve();
          void cancelRelocation.catch(() =>
            dialog.showErrorBox(
              "迁移未开始",
              "无法清除迁移请求。原文档库未移动，重新启动时会取消未完成的请求。",
            ),
          );
        }
      },
      onApproved: () => {
        exitSaveConfirmed = true;
        relocationCloseApproved = restartForLibraryMove;
      },
      onForcedClose: () => {
        forcedCloseOccurred = true;
        exitSaveConfirmed = false;
      },
    }).then(async (createdWindow) => {
      mainWindow = createdWindow;
      if (tutorialSession) createdWindow.setTitle(`${APPLICATION_NAME} · 快速工具教程`);
      usageActivity?.bind(createdWindow);
      usageActivity?.refresh();
      if (!startupReadOnly && !tutorialSession)
        trayController = await installSystemTray(createdWindow, settings);
      if (!startupReadOnly && !tutorialSession)
        installDockOnboarding(createdWindow, () => {
          void logger.log("warn", { event: "app.error" });
        });
      // Manual-safe startup opens no editable runtime; final-save/backup IPC is disabled.
      if (startupReadOnly) authorizeCloseForControlledRestart(createdWindow);
      createdWindow.on("closed", () => {
        if (mainWindow === createdWindow) mainWindow = undefined;
        trayController = undefined;
      });
      return createdWindow;
    });
    try {
      return await windowCreation;
    } finally {
      windowCreation = undefined;
    }
  };
  const openFromArguments = async (argv: readonly string[]) => {
    if (tutorialSession) {
      if (argv.length && !argv.includes(`--tool-tutorial=${tutorialSession.root}`)) return;
      if (!windowServicesReady) return;
      const window = await ensureMainWindow();
      if (
        process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1" ||
        process.env.PATENT_WORKBENCH_TEST !== "1"
      ) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      return;
    }
    const uri = isHarmonyPlatform(process.platform)
      ? argv.find((value) => harmonyPatdocPath(value) !== null)
      : undefined;
    const path = uri
      ? harmonyPatdocPath(uri)
      : findFirstPatdocArgument(
          isHarmonyPlatform(process.platform)
            ? argv.filter((value) => !value.includes("://"))
            : argv,
        );
    if (!windowServicesReady) {
      if (path) pendingPaths.push(uri ?? path);
      return;
    }
    if (!startupFileOpenGuard.accept(path)) return;
    const currentWindow = await ensureMainWindow();
    if (uri) {
      try {
        await createHarmonySystem(systemPreferences as HarmonyBridge).persistOpenedFile(uri);
      } catch {
        dialog.showErrorBox(
          "文件未打开",
          "无法取得外部文件访问权限。请从应用的导入菜单重新选择文件；现有文档未被修改。",
        );
        return;
      }
    }
    if (path) {
      dispatchOpenPath(path);
      return;
    }
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
  };

  // Finder can deliver this before ready. openFromArguments queues until services exist
  // and dispatchOpenPath grants the same one-use authorization as Windows file opening.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    void openFromArguments([path]).catch(() => undefined);
  });

  app.on("open-url", (event, uri) => {
    if (!isHarmonyPlatform(process.platform) || !harmonyPatdocPath(uri)) return;
    event.preventDefault();
    const nativeUri = uri.startsWith("zhichan-patdoc:")
      ? (new URL(uri).searchParams.get("uri") ?? "")
      : uri;
    void openFromArguments([nativeUri]).catch(() => {
      dialog.showErrorBox(
        "文件未打开",
        "无法取得外部文件访问权限。请在应用的导入菜单中重新选择文件；现有文档未被修改。",
      );
    });
  });

  app.on("second-instance", (_event, argv) => {
    void openFromArguments(argv).catch(() => undefined);
  });
  app.on("activate", () => {
    if (windowServicesReady) void openFromArguments([]).catch(() => undefined);
  });
  void app
    .whenReady()
    .then(async () => {
      if (!tutorialSession && (await installMacFromDownloadDisk())) return;
      if (tutorialSession)
        await settings.update({
          welcomeCompleted: true,
          editorIntroductionSeen: true,
          closeToTray: false,
          trayIntroDismissed: true,
          autoCheckUpdates: false,
          contentSearchEnabled: false,
        });
      await logger.log("info", { event: "app.started" });
      if (!tutorialSession && isHarmonyPlatform(process.platform)) {
        try {
          const result = await createHarmonySystem(
            systemPreferences as HarmonyBridge,
          ).restoreFileAccess();
          if (result.failed)
            await logger.log("warn", { event: "harmony.file_access.reselect_required" });
        } catch {
          await logger.log("warn", { event: "harmony.file_access.restore_unavailable" });
        }
      }
      installPrintProtocol();
      installAppProtocol(join(__dirname, "../renderer"), undefined, {
        editorRoot: join(__dirname, "../design-editor"),
        developmentRendererUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
      });
      installDrawioProtocol();
      installIpcDataProtocol();
      const libraryServices = await createLibraryIpcOptions();
      startupReadOnly = libraryServices.startupReadOnly;
      closeLibraryServices = libraryServices.close;
      try {
        const usageConfig = usageStatisticsConfig();
        usageActivity = new UsageActivity(
          () => mainWindow,
          powerMonitor,
          (active) => {
            void usageStatistics?.observe(active);
          },
          process.platform,
          () => createHarmonySystem(systemPreferences as HarmonyBridge, 2_000).readUsageActivity(),
        );
        usageStatistics = new UsageStatisticsService({
          statePath: join(app.getPath("userData"), "usage-statistics.json"),
          versionGroup: APPLICATION_VERSION.split(".").slice(0, 2).join("."),
          appVersion: APPLICATION_VERSION,
          platform: process.platform,
          config: usageConfig,
          allowed:
            !tutorialSession &&
            !startupReadOnly &&
            app.isPackaged &&
            !isStartupIsolated(process.platform, process.argv, process.env) &&
            /^\d+\.\d+\.\d+$/.test(APPLICATION_VERSION),
          sessionAllowed: false,
          foreground: () => usageActivity?.foreground() ?? false,
          send: (payload, signal) => sendUsageAggregate(usageConfig.endpoint, payload, signal),
          onChanged: (state) => {
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
              mainWindow.webContents.send(IPC_CHANNELS.usageStatisticsChanged, state);
          },
        });
      } catch {
        usageActivity?.dispose();
        void logger.log("warn", { event: "app.error", errorCode: "INTERNAL" }).catch(() => {
          console.warn("使用统计初始化失败，统计未运行；本地文档功能继续可用。");
        });
      }
      disposeIpc = registerIpcHandlers(
        logger,
        openPathAuthorization,
        libraryServices.ipc,
        libraryServices.startupRecoveryReport,
        libraryServices.startupReadOnly,
        () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            throw new Error("Cannot authorize restart without the active main window");
          }
          authorizeCloseForControlledRestart(mainWindow);
          exitSaveConfirmed = true;
        },
        {
          settings,
          ...(tutorialSeed ? { tutorial: tutorialSeed } : {}),
          ...(tutorialSession
            ? {
                onTutorialReady: () => markTutorialReady(tutorialSession),
              }
            : {}),
          ...(tutorialLauncher ? { tutorialLauncher } : {}),
          ...(usageStatistics ? { usageStatistics } : {}),
          agreements: new AgreementService({
            statePath: join(app.getPath("userData"), "agreement-consent.json"),
            appVersion: APPLICATION_VERSION,
            platform: process.platform,
            policy: LegalPolicySchema.parse(legalPolicy),
            ...(usageStatistics ? { usage: usageStatistics } : {}),
            bypass: Boolean(tutorialSession),
          }),
          openAutomationAuthorization: async () => {
            await openFromArguments([]);
            app.focus();
          },
          onCloseToTrayChanged: (enabled) => trayController?.setEnabled(enabled),
          ...(recoverySourceRoot
            ? {
                recoveryLibrary: {
                  sourceRoot: recoverySourceRoot,
                  activate: async (root: string) => {
                    if (!libraryLocation) throw new Error("文档库位置不可用。");
                    await libraryLocation.activateRecovered(root);
                  },
                  restart: () => {
                    if (mainWindow) authorizeCloseForControlledRestart(mainWindow);
                    restartForLibraryMove = true;
                    relocationCloseApproved = true;
                    app.quit();
                  },
                },
              }
            : {}),
          libraryRelocation: {
            schedule: async (parent) => {
              await cancelRelocation;
              if (!libraryLocation) throw new Error("文档库尚未准备好");
              return libraryLocation.schedule(parent);
            },
            status: async () => libraryLocation?.status(),
            cancel: async () => {
              await libraryLocation?.cancel();
            },
            restart: (approved = false) => {
              if (approved && mainWindow) {
                authorizeCloseForControlledRestart(mainWindow);
                exitSaveConfirmed = true;
              }
              restartForLibraryMove = true;
              relocationCloseApproved = approved;
              app.quit();
            },
          },
        },
      );
      windowServicesReady = true;
      await ensureMainWindow();
      if (tutorialSession) {
        disposeTutorialCommands = watchTutorialCommands(tutorialSession, (command) => {
          if (command === "focus") void openFromArguments([]);
          if (command === "close") app.quit();
        });
      }
      usageStatistics?.start();
      if (libraryLocationNotice)
        dialog.showMessageBox(mainWindow as BrowserWindow, {
          type: "info",
          title: "文档库迁移",
          message: libraryLocationNotice,
          buttons: ["知道了"],
        });
      if (!openedAtLogin() || findFirstPatdocArgument(process.argv))
        await openFromArguments(process.argv);
      for (const path of pendingPaths.splice(0)) await openFromArguments([path]);
      startupFileOpenGuard.finish();
    })
    .catch((error: unknown) => {
      return reportStartupFailure(
        logger,
        () => app.quit(),
        (title, message) => dialog.showErrorBox(title, message),
        error,
      );
    })
    .catch(() => app.quit());
}
