import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  screen,
  session,
} from "electron";
import { APPLICATION_NAME } from "../shared/branding.js";
import {
  CloseResultRequestSchema,
  CloseTokenSchema,
  DualColumnWindowRequestSchema,
  IPC_CHANNELS,
  RendererFailureReportSchema,
  type WindowLayoutState,
} from "../shared/ipc/contract.js";
import { type AppResult, normalizeAppError } from "../shared/ipc/result.js";
import { isIpcDataPageUrl } from "../shared/ipc-data-center.js";
import { AppOperationError } from "./app-operation-error.js";
import { APP_SCHEME } from "./app-protocol.js";
import type { SafeLogger } from "./logging/safe-log.js";
import { macApplicationMenu } from "./platform/application-menu.js";
import { readPhysicalDisplayWidthMm } from "./platform/display-physical-size.js";
import { initializeWindowControls, windowDecorationOptions } from "./platform/window-decoration.js";
import {
  installOfflinePolicy,
  isAllowedDiagramNavigationUrl,
  isAllowedRendererUrl,
  isDevToolsEnabled,
  shouldEnforceOfflinePolicy,
} from "./security.js";
import {
  fitWindowBounds,
  initialWindowBounds,
  installDisplayBoundsProtection,
} from "./window-display-bounds.js";

type DiagramSecurityTarget = BrowserWindow["webContents"];

function isDiagramDownloadUrl(url: string): boolean {
  return (
    url.startsWith("patent-diagram://editor/") || url.startsWith("blob:patent-diagram://editor/")
  );
}

function isDesignEditorNavigation(url: string): boolean {
  try {
    const frame = new URL(url);
    return (
      frame.protocol === "patent-app:" &&
      frame.hostname === "editor" &&
      !frame.username &&
      !frame.password &&
      !frame.port &&
      frame.pathname === "/index.html" &&
      frame.searchParams.size === 3 &&
      /^[a-f0-9-]{36}$/i.test(frame.searchParams.get("session") ?? "") &&
      /^(windows|mac|harmony)$/.test(frame.searchParams.get("platform") ?? "") &&
      /^\d{9,10}$/.test(frame.searchParams.get("budget") ?? "") &&
      /^#[a-f0-9]{64}$/.test(frame.hash)
    );
  } catch {
    return false;
  }
}

export function installDiagramFrameSecurity(target: DiagramSecurityTarget): void {
  target.on("will-frame-navigate", (details) => {
    if (
      details.isMainFrame ||
      (!isAllowedDiagramNavigationUrl(details.url) &&
        !isIpcDataPageUrl(details.url) &&
        !isDesignEditorNavigation(details.url))
    )
      details.preventDefault();
  });
  target.setWindowOpenHandler(() => ({ action: "deny" }));
  target.session.on("will-download", (event, item) => {
    if (
      isDiagramDownloadUrl(item.getURL()) ||
      /^(?:blob:)?patent-ipc:/u.test(item.getURL()) ||
      /^(?:blob:)?patent-app:\/\/editor\//u.test(item.getURL())
    )
      event.preventDefault();
  });
}

type MainWindowContentTarget = Pick<BrowserWindow, "destroy" | "loadURL">;
type CloseProtectedWindow = Pick<BrowserWindow, "close" | "destroy" | "on"> & {
  webContents: Pick<BrowserWindow["webContents"], "send" | "reload" | "mainFrame">;
};
type RendererResilientWindow = {
  webContents: Pick<BrowserWindow["webContents"], "on" | "reload">;
};
type WindowLayoutTarget = Pick<
  BrowserWindow,
  | "getContentSize"
  | "isDestroyed"
  | "isMaximized"
  | "maximize"
  | "on"
  | "getBounds"
  | "setBounds"
  | "unmaximize"
> & {
  webContents: Pick<BrowserWindow["webContents"], "send">;
};

type CloseTimeoutDecision = "wait" | "force";
type RendererFailureDecision = "reload" | "exit";

export type CloseProtectionController = {
  authorizeControlledClose(): void;
  cancelPendingClose(): void;
  forceClose(): void;
  requestReload(): void;
};

type CloseProtectionOptions = {
  ipcEndpoint?: Electron.IpcMain;
  closeWindowOnly?: boolean;
  /** Only isolated, disposable tutorial sessions may skip document save prompts. */
  discardOnClose?: boolean;
  tryHide?: () => boolean;
  onCancelled?: () => void;
  onApproved?: () => void;
  onForcedClose?: () => void;
  timeoutMs?: number;
  onTimeout?: () => Promise<CloseTimeoutDecision>;
};

type RendererResilienceOptions = {
  promptRepeatedFailure?: () => Promise<RendererFailureDecision>;
  promptUnresponsive?: () => Promise<CloseTimeoutDecision | "reload">;
  unresponsiveTimeoutMs?: number;
};

const closeProtectionControllers = new WeakMap<CloseProtectedWindow, CloseProtectionController>();

export function authorizeCloseForControlledRestart(mainWindow: BrowserWindow): void {
  const controller = closeProtectionControllers.get(mainWindow);
  if (!controller) throw new Error("Main window close protection is not installed");
  controller.authorizeControlledClose();
}

type WindowLayoutBridgeOptions = {
  debounceMs?: number;
};

type MainWindowContentOptions = {
  rendererUrl: string | undefined;
  isPackaged: boolean;
  rendererFile: string;
};

function rendererEntryUrl(options: MainWindowContentOptions): string {
  return options.rendererUrl ?? `${APP_SCHEME}://app/index.html`;
}

function voidResult(): AppResult<void> {
  return { ok: true, value: undefined };
}

function closeFailure(): AppResult<void> {
  return {
    ok: false,
    error: normalizeAppError({ code: "INVALID_INPUT", message: "normalized" }),
  };
}

function windowLayoutResult(value: WindowLayoutState): AppResult<WindowLayoutState> {
  return { ok: true, value };
}

const displaySizeCache = new Map<number, Promise<number | null>>();

async function readWindowLayoutState(mainWindow: WindowLayoutTarget): Promise<WindowLayoutState> {
  const initialSize = mainWindow.getContentSize();
  const initialMaximized = mainWindow.isMaximized();
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  let displayWidthMm: number | null | undefined;
  if (Number.isInteger(display.id) && display.id >= 0) {
    let pending = displaySizeCache.get(display.id);
    if (!pending) {
      pending = readPhysicalDisplayWidthMm(display.id, display.rotation);
      displaySizeCache.set(display.id, pending);
    }
    displayWidthMm = await pending;
  } else if (typeof display.id === "number") {
    displayWidthMm = null;
  }
  const closed = mainWindow.isDestroyed();
  const contentSize = closed ? initialSize : mainWindow.getContentSize();
  return {
    ...(displayWidthMm === undefined ? {} : { displayWidthMm }),
    isMaximized: closed ? initialMaximized : mainWindow.isMaximized(),
    contentWidth: contentSize[0] ?? 0,
    contentHeight: contentSize[1] ?? 0,
  };
}

export function installWindowLayoutBridge(
  mainWindow: WindowLayoutTarget,
  options: WindowLayoutBridgeOptions = {},
  ipcEndpoint = electronIpcMain,
): void {
  const ipcMain = ipcEndpoint;
  const debounceMs = options.debounceMs ?? 50;
  let disposed = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let publicationVersion = 0;
  let columnWindowBefore: { bounds: Electron.Rectangle; maximized: boolean } | undefined;

  const clearPendingTimer = () => {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
  };
  const publishLatest = async () => {
    pendingTimer = undefined;
    if (disposed || mainWindow.isDestroyed()) return;
    const version = publicationVersion;
    const layout = await readWindowLayoutState(mainWindow);
    if (version === publicationVersion && !disposed && !mainWindow.isDestroyed())
      mainWindow.webContents.send(IPC_CHANNELS.applicationWindowLayoutChanged, layout);
  };
  const schedulePublish = () => {
    if (disposed) return;
    publicationVersion += 1;
    clearPendingTimer();
    pendingTimer = setTimeout(publishLatest, debounceMs);
  };

  ipcMain.removeHandler(IPC_CHANNELS.applicationGetWindowLayoutState);
  ipcMain.handle(IPC_CHANNELS.applicationGetWindowLayoutState, async () =>
    windowLayoutResult(await readWindowLayoutState(mainWindow)),
  );
  ipcMain.removeHandler(IPC_CHANNELS.applicationMaximizeWindow);
  ipcMain.handle(IPC_CHANNELS.applicationMaximizeWindow, async () => {
    if (!mainWindow.isMaximized()) mainWindow.maximize();
    return windowLayoutResult(await readWindowLayoutState(mainWindow));
  });

  ipcMain.removeHandler(IPC_CHANNELS.applicationDualColumnWindow);
  ipcMain.handle(IPC_CHANNELS.applicationDualColumnWindow, async (_event, input) => {
    const parsed = DualColumnWindowRequestSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        error: normalizeAppError({ code: "INVALID_INPUT", message: "无效的窗口尺寸参数" }),
      };
    const { enabled, pageWidth, preserveBounds } = parsed.data;
    if (!enabled) {
      if (columnWindowBefore && !columnWindowBefore.maximized && !preserveBounds) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        mainWindow.setBounds(
          fitWindowBounds(
            columnWindowBefore.bounds,
            screen.getDisplayMatching(columnWindowBefore.bounds).workArea,
          ),
        );
      }
      columnWindowBefore = undefined;
    } else if (!columnWindowBefore) {
      const bounds = mainWindow.getBounds();
      columnWindowBefore = { bounds, maximized: mainWindow.isMaximized() };
      if (!columnWindowBefore.maximized) {
        const area = screen.getDisplayMatching(bounds).workArea;
        const [contentWidth = bounds.width] = mainWindow.getContentSize();
        // Page group plus viewport breathing room and the native window frame (DIP).
        const idealWidth = Math.ceil(2 * pageWidth + 494 + 40 + bounds.width - contentWidth);
        const compactWidth = Math.ceil(2 * pageWidth + 138 + 40 + bounds.width - contentWidth);
        const comfortableWidth = Math.floor(area.width * 0.95);
        const scale = Math.min(
          Math.max(1, idealWidth / bounds.width),
          comfortableWidth / bounds.width,
          Math.floor(area.height * 0.95) / bounds.height,
        );
        const width = Math.round(bounds.width * scale);
        const height = Math.round(bounds.height * scale);
        if (compactWidth > width) {
          mainWindow.maximize();
        } else if (scale > 1) {
          mainWindow.setBounds({
            x: Math.round(area.x + (area.width - width) / 2),
            y: Math.round(area.y + (area.height - height) / 2),
            width,
            height,
          });
        }
      }
    }
    schedulePublish();
    return windowLayoutResult(await readWindowLayoutState(mainWindow));
  });

  const refreshDisplay = () => {
    displaySizeCache.clear();
    schedulePublish();
  };
  screen.on?.("display-metrics-changed", refreshDisplay);
  screen.on?.("display-added", refreshDisplay);
  screen.on?.("display-removed", refreshDisplay);
  mainWindow.on("move", schedulePublish);
  mainWindow.on("maximize", schedulePublish);
  mainWindow.on("unmaximize", schedulePublish);
  mainWindow.on("resize", schedulePublish);
  mainWindow.on("closed", () => {
    disposed = true;
    screen.removeListener?.("display-metrics-changed", refreshDisplay);
    screen.removeListener?.("display-added", refreshDisplay);
    screen.removeListener?.("display-removed", refreshDisplay);
    clearPendingTimer();
    ipcMain.removeHandler(IPC_CHANNELS.applicationGetWindowLayoutState);
    ipcMain.removeHandler(IPC_CHANNELS.applicationMaximizeWindow);
    ipcMain.removeHandler(IPC_CHANNELS.applicationDualColumnWindow);
  });
}

export function installCloseProtection(
  mainWindow: CloseProtectedWindow,
  options: CloseProtectionOptions = {},
): CloseProtectionController {
  const ipcMain = options.ipcEndpoint ?? electronIpcMain;
  let allowClose = false;
  let pendingToken: string | null = null;
  let pendingAction: "close" | "reload" = "close";
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timeoutPromptShown = false;
  const onTimeout =
    options.onTimeout ??
    (async () => {
      const result = await dialog.showMessageBox(mainWindow as BrowserWindow, {
        type: "warning",
        title: "退出处理暂时无响应",
        message: "暂时无法确认退出处理的进度。",
        detail: "建议继续等待。强制退出可能丢失尚未保存的修改。",
        buttons: ["继续等待", "强制退出"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 ? "force" : "wait";
    });

  const clearPendingTimer = () => {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
  };

  const authorizeControlledClose = () => {
    pendingToken = null;
    clearPendingTimer();
    allowClose = true;
  };
  const controller: CloseProtectionController = {
    authorizeControlledClose,
    cancelPendingClose() {
      pendingToken = null;
      clearPendingTimer();
    },
    forceClose() {
      options.onForcedClose?.();
      authorizeControlledClose();
      mainWindow.destroy();
    },
    requestReload() {
      if (!pendingToken) startRequest("reload");
    },
  };
  closeProtectionControllers.set(mainWindow, controller);

  const scheduleTimeout = (token: string) => {
    clearPendingTimer();
    if (timeoutPromptShown) return;
    pendingTimer = setTimeout(() => {
      timeoutPromptShown = true;
      void (async () => {
        let decision: CloseTimeoutDecision = "wait";
        try {
          decision = await onTimeout();
        } catch {
          // A failed native prompt must never turn into silent data loss.
        }
        if (pendingToken !== token) return;
        if (decision === "force") {
          controller.forceClose();
          return;
        }
        // The responsive renderer owns progress and retry UI. Never repeatedly
        // interrupt a user who already chose to wait for this close attempt.
      })();
    }, timeoutMs);
  };

  ipcMain.removeHandler(IPC_CHANNELS.applicationCloseHeartbeat);
  ipcMain.handle(IPC_CHANNELS.applicationCloseHeartbeat, (event, input) => {
    const parsed = CloseTokenSchema.safeParse(input);
    if (
      !parsed.success ||
      !pendingToken ||
      parsed.data !== pendingToken ||
      event.sender !== mainWindow.webContents ||
      !event.senderFrame ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return closeFailure();
    scheduleTimeout(pendingToken);
    return voidResult();
  });

  ipcMain.removeHandler(IPC_CHANNELS.applicationCloseResult);
  ipcMain.handle(IPC_CHANNELS.applicationCloseResult, async (_event, input) => {
    const parsed = CloseResultRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.token !== pendingToken) return closeFailure();
    pendingToken = null;
    clearPendingTimer();
    if (parsed.data.proceed) {
      if (pendingAction === "reload") mainWindow.webContents.reload();
      else {
        options.onApproved?.();
        allowClose = true;
        mainWindow.close();
      }
    } else options.onCancelled?.();
    return voidResult();
  });

  let quitScheduled = false;
  let windowClosed = false;
  ipcMain.removeHandler(IPC_CHANNELS.applicationRequestQuit);
  ipcMain.handle(IPC_CHANNELS.applicationRequestQuit, (event) => {
    if (
      windowClosed ||
      event.sender !== mainWindow.webContents ||
      !event.senderFrame ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return closeFailure();
    if (!quitScheduled) {
      quitScheduled = true;
      setImmediate(() => {
        quitScheduled = false;
        // Native app.quit triggers the protected close/save handshake. Renderer
        // window.close bypasses the close event in the fixed Harmony runtime.
        if (!windowClosed) {
          if (options.closeWindowOnly) mainWindow.close();
          else app.quit();
        }
      });
    }
    return voidResult();
  });
  ipcMain.removeHandler(IPC_CHANNELS.applicationForceClose);
  ipcMain.handle(IPC_CHANNELS.applicationForceClose, async () => {
    controller.forceClose();
    return voidResult();
  });

  const startRequest = (action: "close" | "reload") => {
    pendingAction = action;
    if (pendingToken) return;
    pendingToken = randomUUID();
    timeoutPromptShown = false;
    mainWindow.webContents.send(IPC_CHANNELS.applicationPrepareClose, pendingToken);
    scheduleTimeout(pendingToken);
  };

  mainWindow.on("close", (event) => {
    if (allowClose) return;
    if (options.discardOnClose) {
      authorizeControlledClose();
      options.onApproved?.();
      return;
    }
    event.preventDefault();
    if (!pendingToken && options.tryHide?.()) return;
    startRequest("close");
  });

  mainWindow.on("query-session-end", (event) => {
    if (allowClose) return;
    // WM_QUERYENDSESSION does not wait for an asynchronous window-close event.
    // Veto this request until the existing persistence handshake has completed.
    event.preventDefault();
    startRequest("close");
  });
  mainWindow.on("closed", () => {
    windowClosed = true;
    ipcMain.removeHandler(IPC_CHANNELS.applicationRequestQuit);
    ipcMain.removeHandler(IPC_CHANNELS.applicationCloseHeartbeat);
    controller.cancelPendingClose();
  });

  return controller;
}

export function installRendererResilience(
  mainWindow: RendererResilientWindow,
  logger: SafeLogger,
  closeProtection: CloseProtectionController,
  options: RendererResilienceOptions = {},
): void {
  let recoveryAttempted = false;
  let promptOpen = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let unresponsiveTimer: ReturnType<typeof setTimeout> | undefined;
  const unresponsiveTimeoutMs = options.unresponsiveTimeoutMs ?? 15_000;
  const promptRepeatedFailure =
    options.promptRepeatedFailure ??
    (async () => {
      const result = await dialog.showMessageBox(mainWindow as BrowserWindow, {
        type: "error",
        title: "编辑界面异常退出",
        message: "编辑界面再次发生异常。",
        detail: "可以重新加载界面继续使用；若问题持续出现，请退出后重新启动软件。",
        buttons: ["重新加载界面", "退出软件"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 ? "exit" : "reload";
    });
  const promptUnresponsive =
    options.promptUnresponsive ??
    (async () => {
      const result = await dialog.showMessageBox(mainWindow as BrowserWindow, {
        type: "warning",
        title: "编辑界面暂时无响应",
        message: "编辑界面已持续一段时间没有响应。",
        detail: "如果正在处理大型文档，可以继续等待；也可以重新加载界面。",
        buttons: ["继续等待", "重新加载界面"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 ? "reload" : "wait";
    });

  const safeLog = (level: "info" | "warn" | "error", event: Parameters<SafeLogger["log"]>[1]) => {
    void logger.log(level, event).catch(() => undefined);
  };

  const reloadRenderer = () => {
    closeProtection.cancelPendingClose();
    recoveryAttempted = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    // Electron may still be tearing down the failed renderer while emitting
    // render-process-gone. Defer navigation to the next task so a fresh renderer
    // process is actually created instead of leaving a crashed WebContents behind.
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      mainWindow.webContents.reload();
    }, 0);
  };

  const handleFailure = () => {
    safeLog("error", { event: "window.renderer_gone", errorCode: "INTERNAL" });
    if (!recoveryAttempted) {
      reloadRenderer();
      return;
    }
    if (promptOpen) return;
    promptOpen = true;
    void promptRepeatedFailure()
      .then((decision) => {
        if (decision === "exit") closeProtection.forceClose();
        else reloadRenderer();
      })
      .catch(() => undefined)
      .finally(() => {
        promptOpen = false;
      });
  };

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    if (unresponsiveTimer !== undefined) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = undefined;
    handleFailure();
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      handleFailure();
    },
  );
  mainWindow.webContents.on("did-finish-load", () => {
    if (recoveryAttempted) safeLog("info", { event: "window.renderer_recovered" });
  });
  mainWindow.webContents.on("unresponsive", () => {
    safeLog("warn", { event: "window.renderer_unresponsive" });
    if (unresponsiveTimer !== undefined || promptOpen) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = undefined;
      if (promptOpen) return;
      promptOpen = true;
      void promptUnresponsive()
        .then((decision) => {
          if (decision === "reload") closeProtection.requestReload();
        })
        .catch(() => undefined)
        .finally(() => {
          promptOpen = false;
        });
    }, unresponsiveTimeoutMs);
  });
  mainWindow.webContents.on("responsive", () => {
    if (unresponsiveTimer !== undefined) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = undefined;
    safeLog("info", { event: "window.renderer_responsive" });
  });
}

export function installRendererFailureReporting(
  logger: SafeLogger,
  ipcEndpoint = electronIpcMain,
): void {
  const ipcMain = ipcEndpoint;
  ipcMain.removeHandler(IPC_CHANNELS.applicationReportRendererFailure);
  ipcMain.handle(IPC_CHANNELS.applicationReportRendererFailure, async (_event, input) => {
    const parsed = RendererFailureReportSchema.safeParse(input);
    if (!parsed.success) return closeFailure();
    try {
      await logger.log("error", {
        event: "window.renderer_failure",
        errorCode: "INTERNAL",
        failureKind: parsed.data.failureKind,
        ...(parsed.data.locations ? { locations: parsed.data.locations } : {}),
      });
    } catch {
      // Reporting must never replace the renderer's recovery controls.
    }
    return voidResult();
  });
}

export function installRendererRecovery(
  mainWindow: BrowserWindow,
  ipcEndpoint = electronIpcMain,
): void {
  const ipcMain = ipcEndpoint;
  let pendingReload: ReturnType<typeof setTimeout> | undefined;
  ipcMain.removeHandler(IPC_CHANNELS.applicationReloadRenderer);
  ipcMain.handle(IPC_CHANNELS.applicationReloadRenderer, (event) => {
    if (
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      !event.senderFrame ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return closeFailure();
    const protection = closeProtectionControllers.get(mainWindow);
    if (!protection) return closeFailure();
    if (pendingReload !== undefined) return voidResult();
    // Reply first so the recovery screen can acknowledge the click. The main
    // process reload bypasses page-initiated navigation without relaxing security.
    pendingReload = setTimeout(() => {
      pendingReload = undefined;
      if (!mainWindow.isDestroyed()) protection.requestReload();
    }, 0);
    return voidResult();
  });
  mainWindow.on("closed", () => {
    if (pendingReload !== undefined) clearTimeout(pendingReload);
    ipcMain.removeHandler(IPC_CHANNELS.applicationReloadRenderer);
  });
}

export async function loadMainWindowContent(
  mainWindow: MainWindowContentTarget,
  options: MainWindowContentOptions,
  logger: SafeLogger,
): Promise<void> {
  try {
    if (options.rendererUrl) {
      if (options.isPackaged || !isAllowedRendererUrl(options.rendererUrl, false)) {
        throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
      }
      await mainWindow.loadURL(rendererEntryUrl(options));
    } else {
      await mainWindow.loadURL(rendererEntryUrl(options));
    }
  } catch (error) {
    console.error("[startup] renderer load failed:", error);
    try {
      mainWindow.destroy();
    } catch {
      // Continue to the normalized terminal error even if teardown has already happened.
    }
    try {
      await logger.log("error", { event: "window.load_failed", errorCode: "INTERNAL" });
    } catch {
      // Logging must not expose or replace the normalized load failure.
    }
    throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
  }
}

export function shouldShowMainWindow(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.PATENT_WORKBENCH_TEST !== "1";
}

export async function createMainWindow(
  logger: SafeLogger,
  options: CloseProtectionOptions & {
    hidden?: boolean;
    tutorial?: boolean;
    isolatedSession?: Electron.Session;
    initializeWindow?(window: BrowserWindow): void | Promise<void>;
  } = {},
): Promise<BrowserWindow> {
  const devTools = isDevToolsEnabled();
  const mainWindow = new BrowserWindow({
    show: false,
    ...initialWindowBounds(screen.getPrimaryDisplay().workArea),
    title: APPLICATION_NAME,
    ...windowDecorationOptions(process.platform),
    webPreferences: {
      ...(options.isolatedSession ? { session: options.isolatedSession } : {}),
      preload: join(__dirname, "../preload/index.cjs"),
      additionalArguments: options.tutorial ? ["--tool-tutorial-renderer"] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools,
    },
  });
  const ipcEndpoint = options.isolatedSession ? mainWindow.webContents.ipc : electronIpcMain;
  await options.initializeWindow?.(mainWindow);

  initializeWindowControls(mainWindow, process.platform);
  Menu.setApplicationMenu(
    process.platform === "darwin" ? Menu.buildFromTemplate(macApplicationMenu()) : null,
  );
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  installDiagramFrameSecurity(mainWindow.webContents);
  if (!devTools) {
    mainWindow.webContents.on("devtools-opened", () => mainWindow.webContents.closeDevTools());
  }
  const closeProtection = installCloseProtection(mainWindow, {
    ...options,
    ipcEndpoint,
    discardOnClose: Boolean(options.tutorial),
  });
  installWindowLayoutBridge(mainWindow, {}, ipcEndpoint);
  installDisplayBoundsProtection(mainWindow);
  installRendererFailureReporting(logger, ipcEndpoint);
  installRendererRecovery(mainWindow, ipcEndpoint);

  installOfflinePolicy(
    options.isolatedSession ?? session.defaultSession,
    shouldEnforceOfflinePolicy(app.isPackaged),
  );

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  await loadMainWindowContent(
    mainWindow,
    {
      rendererUrl,
      isPackaged: app.isPackaged,
      rendererFile: join(__dirname, "../renderer/index.html"),
    },
    logger,
  );
  installRendererResilience(mainWindow, logger, closeProtection);

  if (!options.hidden && shouldShowMainWindow() && !mainWindow.isDestroyed()) {
    if (!options.tutorial) mainWindow.maximize();
    mainWindow.show();
  }

  return mainWindow;
}
