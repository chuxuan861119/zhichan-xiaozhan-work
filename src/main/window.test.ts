import { app } from "electron";
import type { SafeLogger } from "./logging/safe-log.js";
import { readPhysicalDisplayWidthMm } from "./platform/display-physical-size.js";
import {
  authorizeCloseForControlledRestart,
  installCloseProtection,
  installDiagramFrameSecurity,
  installRendererFailureReporting,
  installRendererRecovery,
  installRendererResilience,
  installWindowLayoutBridge,
  loadMainWindowContent,
  shouldShowMainWindow,
} from "./window.js";

vi.mock("./platform/display-physical-size.js", () => ({
  readPhysicalDisplayWidthMm: vi.fn(async (id: number) => (id === 101 ? 326.571 : 600)),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, quit: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: {
    getDisplayMatching: vi.fn(() => ({ workArea: { x: 100, y: 0, width: 3000, height: 1600 } })),
  },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
    removeHandler(channel: string) {
      this.handlers.delete(channel);
    },
    handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) {
      this.handlers.set(channel, handler);
    },
  },
  Menu: { setApplicationMenu: vi.fn() },
  session: { defaultSession: {} },
}));

const electron = await import("electron");
const ipcMainMock = electron.ipcMain as unknown as {
  handlers: Map<string, (event: unknown, input?: unknown) => unknown>;
};

test("isolated tutorial quit closes only its own window and retains the normal IPC handlers", async () => {
  vi.useFakeTimers();
  vi.mocked(app.quit).mockClear();
  const original = new Map(ipcMainMock.handlers);
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  const endpoint = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const contents = { send: vi.fn(), mainFrame: {} };
  const window = { close: vi.fn(), destroy: vi.fn(), on: vi.fn(), webContents: contents };
  try {
    installCloseProtection(window as never, {
      discardOnClose: true,
      closeWindowOnly: true,
      ipcEndpoint: endpoint as never,
    });
    expect(ipcMainMock.handlers).toEqual(original);
    const quit = handlers.get("application:request-quit")!;
    expect(quit({ sender: {}, senderFrame: {} })).toMatchObject({ ok: false });
    expect(quit({ sender: contents, senderFrame: contents.mainFrame })).toMatchObject({ ok: true });
    await vi.runAllTimersAsync();
    expect(window.close).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a live close heartbeat suppresses misleading save timeouts and an unresponsive attempt prompts only once", async () => {
  vi.useFakeTimers();
  try {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const contents = { send: vi.fn(), mainFrame: {} };
    const window = {
      close: vi.fn(),
      destroy: vi.fn(),
      webContents: contents,
      on: vi.fn((event, listener) => listeners.set(event, listener)),
    };
    const onTimeout = vi.fn(async () => "wait" as const);
    installCloseProtection(window as never, { timeoutMs: 10_000, onTimeout });
    listeners.get("close")?.({ preventDefault: vi.fn() });
    const token = contents.send.mock.calls[0]?.[1];
    const heartbeat = ipcMainMock.handlers.get("application:close-heartbeat")!;
    const sender = { sender: contents, senderFrame: contents.mainFrame };
    expect(heartbeat({ sender: {}, senderFrame: {} }, token)).toMatchObject({ ok: false });
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(heartbeat(sender, token)).toMatchObject({ ok: true });
    }
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(window.destroy).not.toHaveBeenCalled();
    await ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: false });
    expect(heartbeat(sender, token)).toMatchObject({ ok: false });
  } finally {
    vi.useRealTimers();
  }
});

test("disposable tutorial windows close without waiting for a renderer save acknowledgement", () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((name, listener) => listeners.set(name, listener)),
    webContents: { send: vi.fn(), reload: vi.fn(), mainFrame: {} },
  };
  const onApproved = vi.fn();
  installCloseProtection(window as never, { discardOnClose: true, onApproved });
  const event = { preventDefault: vi.fn() };
  listeners.get("close")?.(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(window.webContents.send).not.toHaveBeenCalled();
  expect(onApproved).toHaveBeenCalledOnce();
});

test("reload recovery accepts only the main window frame and coalesces repeated requests", async () => {
  vi.useFakeTimers();
  try {
    const contents = { mainFrame: {}, reload: vi.fn(), send: vi.fn() };
    const window = {
      webContents: contents,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
    };
    installCloseProtection(window as never);
    installRendererRecovery(window as never);
    const recover = ipcMainMock.handlers.get("application:reload-renderer")!;
    expect(recover({ sender: {}, senderFrame: contents.mainFrame })).toMatchObject({ ok: false });
    expect(recover({ sender: contents, senderFrame: {} })).toMatchObject({ ok: false });
    const sender = { sender: contents, senderFrame: contents.mainFrame };
    expect(recover(sender)).toMatchObject({ ok: true });
    expect(recover(sender)).toMatchObject({ ok: true });
    expect(contents.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.send).toHaveBeenCalledOnce();
    const token = contents.send.mock.calls[0]?.[1];
    await ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: false });
    expect(contents.reload).not.toHaveBeenCalled();
    recover(sender);
    await vi.advanceTimersByTimeAsync(0);
    const retryToken = contents.send.mock.calls[1]?.[1];
    await ipcMainMock.handlers.get("application:close-result")?.(
      {},
      { token: retryToken, proceed: true },
    );
    expect(contents.reload).toHaveBeenCalledOnce();
    window.isDestroyed.mockReturnValue(true);
    expect(recover(sender)).toMatchObject({ ok: false });
  } finally {
    vi.useRealTimers();
  }
});

test("keeps automated test windows hidden without changing normal launches", () => {
  expect(shouldShowMainWindow({ PATENT_WORKBENCH_TEST: "1" })).toBe(false);
  expect(shouldShowMainWindow({})).toBe(true);
});

test("allows only initial local diagram iframe navigation and denies external navigation", () => {
  type SecurityListener = (
    details: { preventDefault(): void; url?: string; isMainFrame?: boolean },
    item?: { getURL(): string },
  ) => void;
  const listeners = new Map<string, SecurityListener>();
  const contents = {
    on: vi.fn((event: string, listener: SecurityListener) => listeners.set(event, listener)),
    setWindowOpenHandler: vi.fn(),
    session: {
      on: vi.fn((event: string, listener: SecurityListener) => listeners.set(event, listener)),
    },
  };
  installDiagramFrameSecurity(contents as never);
  const allowed = {
    preventDefault: vi.fn(),
    url: "patent-diagram://editor/index.html",
    isMainFrame: false,
  };
  listeners.get("will-frame-navigate")?.(allowed);
  expect(allowed.preventDefault).not.toHaveBeenCalled();
  const nested = {
    preventDefault: vi.fn(),
    url: "patent-diagram://editor/embed.html",
    isMainFrame: false,
  };
  listeners.get("will-frame-navigate")?.(nested);
  expect(nested.preventDefault).not.toHaveBeenCalled();
  for (const details of [
    { url: "https://evil.test", isMainFrame: false },
    { url: "patent-diagram://evil/index.html", isMainFrame: false },
    { url: "patent-diagram://editor/index.html", isMainFrame: true },
  ]) {
    const blocked = { preventDefault: vi.fn(), ...details };
    listeners.get("will-frame-navigate")?.(blocked);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
  }
  const openHandler = vi.mocked(contents.setWindowOpenHandler).mock.calls[0]?.[0];
  expect(openHandler?.()).toEqual({ action: "deny" });
});

test("cancels only downloads that originate from the diagram iframe", () => {
  type SecurityListener = (
    details: { preventDefault(): void },
    item?: { getURL(): string },
  ) => void;
  const listeners = new Map<string, SecurityListener>();
  const contents = {
    on: vi.fn((event: string, listener: SecurityListener) => listeners.set(event, listener)),
    setWindowOpenHandler: vi.fn(),
    session: {
      on: vi.fn((event: string, listener: SecurityListener) => listeners.set(event, listener)),
    },
  };
  installDiagramFrameSecurity(contents as never);
  for (const [url, cancelled] of [
    ["patent-diagram://editor/export.svg", true],
    ["blob:patent-diagram://editor/abc", true],
    ["patent-app://app/export.docx", false],
    ["blob:patent-app://app/abc", false],
  ] as const) {
    const event = { preventDefault: vi.fn() };
    listeners.get("will-download")?.(event, { getURL: () => url });
    expect(event.preventDefault).toHaveBeenCalledTimes(cancelled ? 1 : 0);
  }
});

test.each([
  {
    label: "packaged application URL",
    options: {
      rendererUrl: undefined,
      isPackaged: true,
      rendererFile: "C:\\app\\index.html",
    },
    failedLoader: "loadURL" as const,
  },
  {
    label: "development URL",
    options: {
      rendererUrl: "http://localhost:5173",
      isPackaged: false,
      rendererFile: "C:\\app\\index.html",
    },
    failedLoader: "loadURL" as const,
  },
])("terminates a failed $label load with safe metadata and no raw error", async (testCase) => {
  const raw = "C:\\Users\\Alice\\renderer\\index.html raw stack";
  const window = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  window[testCase.failedLoader].mockRejectedValueOnce(new Error(raw));
  const log = vi.fn().mockResolvedValue(true);

  await expect(
    loadMainWindowContent(window, testCase.options, { log } as unknown as SafeLogger),
  ).rejects.toMatchObject({ code: "INTERNAL" });

  expect(window[testCase.failedLoader]).toHaveBeenCalledOnce();
  expect(window.destroy).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("error", {
    event: "window.load_failed",
    errorCode: "INTERNAL",
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(raw);
});

test("prevents window close until the renderer acknowledges that document queues are flushed", async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      listeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };

  installCloseProtection(window as never);
  const closeEvent = { preventDefault: vi.fn() };
  listeners.get("close")?.(closeEvent);

  expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
  expect(window.webContents.send).toHaveBeenCalledWith(
    "application:prepare-close",
    expect.any(String),
  );
  const token = window.webContents.send.mock.calls[0]?.[1];
  await expect(
    ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: true }),
  ).resolves.toEqual({ ok: true, value: undefined });
  expect(window.close).toHaveBeenCalledOnce();
});

test("system session end vetoes termination and bypasses tray until saves are acknowledged", async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) =>
      listeners.set(event, listener),
    ),
    webContents: { send: vi.fn(), reload: vi.fn() },
  };
  const tryHide = vi.fn(() => true);
  const onCancelled = vi.fn();
  const onApproved = vi.fn();
  const controller = installCloseProtection(window as never, { tryHide, onCancelled, onApproved });
  const query = { preventDefault: vi.fn() };
  listeners.get("query-session-end")?.(query);
  listeners.get("query-session-end")?.(query);
  expect(query.preventDefault).toHaveBeenCalledTimes(2);
  expect(tryHide).not.toHaveBeenCalled();
  expect(window.webContents.send).toHaveBeenCalledOnce();
  let token = window.webContents.send.mock.calls[0]?.[1];
  await ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: false });
  expect(window.close).not.toHaveBeenCalled();
  expect(onCancelled).toHaveBeenCalledOnce();
  expect(onApproved).not.toHaveBeenCalled();
  listeners.get("query-session-end")?.(query);
  token = window.webContents.send.mock.calls[1]?.[1];
  await ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: true });
  expect(window.close).toHaveBeenCalledOnce();
  expect(onApproved).toHaveBeenCalledOnce();
  controller.forceClose();
  expect(onApproved).toHaveBeenCalledOnce();
  const allowed = { preventDefault: vi.fn() };
  listeners.get("query-session-end")?.(allowed);
  expect(allowed.preventDefault).not.toHaveBeenCalled();
});

test("tray hiding bypasses close handshake but disabling it retains save protection", async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, callback: (event: { preventDefault(): void }) => void) =>
      listeners.set(event, callback),
    ),
    webContents: { send: vi.fn() },
  };
  const tryHide = vi.fn().mockReturnValue(true);
  const onCancelled = vi.fn();
  installCloseProtection(window as never, { tryHide, onCancelled });
  listeners.get("close")?.({ preventDefault: vi.fn() });
  expect(window.webContents.send).not.toHaveBeenCalled();
  tryHide.mockReturnValue(false);
  listeners.get("close")?.({ preventDefault: vi.fn() });
  expect(window.webContents.send).toHaveBeenCalledOnce();
  const token = window.webContents.send.mock.calls[0]?.[1];
  await ipcMainMock.handlers.get("application:close-result")?.({}, { token, proceed: false });
  expect(onCancelled).toHaveBeenCalledOnce();
  expect(window.close).not.toHaveBeenCalled();
});

test("force close destroys the protected window without waiting for renderer state", async () => {
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn() },
  };

  const onForcedClose = vi.fn();
  const onApproved = vi.fn();
  installCloseProtection(window as never, { onForcedClose, onApproved });

  await expect(
    ipcMainMock.handlers.get("application:force-close")?.({}, undefined),
  ).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(window.destroy).toHaveBeenCalledOnce();
  expect(onForcedClose).toHaveBeenCalledOnce();
  expect(onApproved).not.toHaveBeenCalled();
});

test("allows a controlled restart to bypass renderer close protection only after authorization", () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      listeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };

  installCloseProtection(window as never);
  const userClose = { preventDefault: vi.fn() };
  listeners.get("close")?.(userClose);
  expect(userClose.preventDefault).toHaveBeenCalledOnce();

  authorizeCloseForControlledRestart(window as never);
  const controlledRestartClose = { preventDefault: vi.fn() };
  listeners.get("close")?.(controlledRestartClose);
  expect(controlledRestartClose.preventDefault).not.toHaveBeenCalled();
});

test("asks for an explicit decision when the renderer does not acknowledge close in time", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const onTimeout = vi.fn(async () => "force" as const);
  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      listeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };

  installCloseProtection(window as never, { timeoutMs: 1_000, onTimeout });
  listeners.get("close")?.({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1_000);

  expect(onTimeout).toHaveBeenCalledOnce();
  expect(window.destroy).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("reloads once after a renderer crash and asks before handling a repeated crash", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const promptRepeatedFailure = vi.fn(async () => "exit" as const);
  const closeProtection = {
    authorizeControlledClose: vi.fn(),
    cancelPendingClose: vi.fn(),
    forceClose: vi.fn(),
    requestReload: vi.fn(),
  };
  const window = {
    webContents: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      reload: vi.fn(),
    },
  };
  const log = vi.fn(async () => true);

  installRendererResilience(window as never, { log } as unknown as SafeLogger, closeProtection, {
    promptRepeatedFailure,
  });
  listeners.get("render-process-gone")?.({}, { reason: "crashed" });
  await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce());
  expect(closeProtection.cancelPendingClose).toHaveBeenCalledOnce();

  listeners.get("render-process-gone")?.({}, { reason: "crashed" });
  await vi.waitFor(() => expect(promptRepeatedFailure).toHaveBeenCalledOnce());
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  expect(closeProtection.forceClose).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("error", {
    event: "window.renderer_gone",
    errorCode: "INTERNAL",
  });
});

test("does not reload for a brief renderer stall but offers recovery for a sustained stall", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const promptUnresponsive = vi.fn(async () => "reload" as const);
  const closeProtection = {
    authorizeControlledClose: vi.fn(),
    cancelPendingClose: vi.fn(),
    forceClose: vi.fn(),
    requestReload: vi.fn(),
  };
  const window = {
    webContents: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      reload: vi.fn(),
    },
  };

  installRendererResilience(
    window as never,
    { log: vi.fn(async () => true) } as unknown as SafeLogger,
    closeProtection,
    { promptUnresponsive, unresponsiveTimeoutMs: 2_000 },
  );
  listeners.get("unresponsive")?.();
  await vi.advanceTimersByTimeAsync(1_000);
  listeners.get("responsive")?.();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(promptUnresponsive).not.toHaveBeenCalled();

  listeners.get("unresponsive")?.();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(promptUnresponsive).toHaveBeenCalledOnce();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  expect(closeProtection.requestReload).toHaveBeenCalledOnce();
  expect(window.webContents.reload).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("records renderer failures without accepting raw error content", async () => {
  const log = vi.fn(async () => true);
  installRendererFailureReporting({ log } as unknown as SafeLogger);
  const handler = ipcMainMock.handlers.get("application:report-renderer-failure");

  await expect(handler?.({}, { source: "react-boundary", message: "secret" })).resolves.toEqual({
    ok: false,
    error: expect.objectContaining({ code: "INVALID_INPUT" }),
  });
  await expect(handler?.({}, { source: "react-boundary" })).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(log).toHaveBeenCalledWith("error", {
    event: "window.renderer_failure",
    errorCode: "INTERNAL",
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  const locations = [{ bundle: "index-AbC_1234.js", line: 12, column: 3 }];
  await expect(handler?.({}, { source: "react-boundary", locations })).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(log).toHaveBeenLastCalledWith("error", expect.objectContaining({ locations }));
  await expect(
    handler?.(
      {},
      { source: "react-boundary", locations: [{ bundle: "secret.js", line: 1, column: 1 }] },
    ),
  ).resolves.toMatchObject({ ok: false });
});

test("dual columns resize around natural page width, restore bounds, and maximize only on small screens", async () => {
  const original = { x: 200, y: 100, width: 1300, height: 900 };
  const window = {
    isDestroyed: () => false,
    isMaximized: vi.fn(() => false),
    getContentSize: () => [1280, 860],
    getBounds: () => original,
    setBounds: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn() },
  };
  installWindowLayoutBridge(window as never);
  const handler = ipcMainMock.handlers.get("application:dual-column-window");
  expect(handler).toBeDefined();
  await handler?.({}, { enabled: true, pageWidth: 820 });
  expect(window.maximize).not.toHaveBeenCalled();
  expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 2194 }));
  expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ height: 1519 }));
  await handler?.({}, { enabled: true, pageWidth: 820 });
  expect(window.setBounds).toHaveBeenCalledOnce();
  await handler?.({}, { enabled: false, pageWidth: 820 });
  expect(window.setBounds).toHaveBeenLastCalledWith(original);
  await handler?.({}, { enabled: true, pageWidth: 820 });
  vi.mocked(electron.screen.getDisplayMatching).mockReturnValueOnce({
    workArea: { x: 0, y: 0, width: 1093, height: 574 },
  } as never);
  await handler?.({}, { enabled: false, pageWidth: 820 });
  expect(window.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1093, height: 574 });
  await handler?.({}, { enabled: true, pageWidth: 820 });
  window.setBounds.mockClear();
  expect(
    await handler?.({}, { enabled: false, pageWidth: 820, preserveBounds: true }),
  ).toMatchObject({ ok: true });
  expect(window.setBounds).not.toHaveBeenCalled();
  vi.mocked(electron.screen.getDisplayMatching).mockReturnValueOnce({
    workArea: { x: 0, y: 0, width: 3000, height: 1400 },
  } as never);
  await handler?.({}, { enabled: true, pageWidth: 820 });
  expect(window.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ width: 1921, height: 1330 }),
  );
  expect(window.maximize).not.toHaveBeenCalled();
  await handler?.({}, { enabled: false, pageWidth: 820 });
  vi.mocked(electron.screen.getDisplayMatching).mockReturnValueOnce({
    workArea: { x: 0, y: 0, width: 1600, height: 900 },
  } as never);
  await handler?.({}, { enabled: true, pageWidth: 820 });
  expect(window.maximize).toHaveBeenCalledOnce();
  await handler?.({}, { enabled: false, pageWidth: 820 });
  window.isMaximized.mockReturnValue(true);
  window.setBounds.mockClear();
  await handler?.({}, { enabled: true, pageWidth: 820 });
  await handler?.({}, { enabled: false, pageWidth: 820 });
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(await handler?.({}, { enabled: true, pageWidth: -1 })).toMatchObject({ ok: false });
});

test("reads the native content size and maximizes only the main window", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let maximized = false;
  const window = {
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => maximized),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1366, height: 768 })),
    getContentSize: vi.fn(() => [1366, 768] as [number, number]),
    maximize: vi.fn(() => {
      maximized = true;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };

  installWindowLayoutBridge(window as never);

  await expect(
    ipcMainMock.handlers.get("application:get-window-layout-state")?.({}, undefined),
  ).resolves.toEqual({
    ok: true,
    value: { isMaximized: false, contentWidth: 1366, contentHeight: 768 },
  });
  await expect(
    ipcMainMock.handlers.get("application:maximize-window")?.({}, undefined),
  ).resolves.toEqual({
    ok: true,
    value: { isMaximized: true, contentWidth: 1366, contentHeight: 768 },
  });
  expect(window.maximize).toHaveBeenCalledOnce();
});

test("publishes the latest maximized and resized layout, then stops after close", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let maximized = false;
  let contentSize: [number, number] = [1440, 900];
  const window = {
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => maximized),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: contentSize[0], height: contentSize[1] })),
    getContentSize: vi.fn(() => contentSize),
    maximize: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    webContents: { send: vi.fn() },
  };

  installWindowLayoutBridge(window as never, { debounceMs: 50 });
  contentSize = [1600, 900];
  listeners.get("resize")?.();
  contentSize = [1920, 1080];
  maximized = true;
  listeners.get("maximize")?.();
  await vi.advanceTimersByTimeAsync(50);

  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  expect(window.webContents.send).toHaveBeenLastCalledWith("application:window-layout-changed", {
    isMaximized: true,
    contentWidth: 1920,
    contentHeight: 1080,
  });

  listeners.get("closed")?.();
  contentSize = [1200, 700];
  maximized = false;
  listeners.get("unmaximize")?.();
  await vi.advanceTimersByTimeAsync(50);
  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("normal quit rejects foreign senders and defers the native save handshake until after acknowledgement", async () => {
  vi.useFakeTimers();
  try {
    const listeners = new Map<string, () => void>();
    const contents = { send: vi.fn(), reload: vi.fn(), mainFrame: {} };
    const window = {
      close: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
      webContents: contents,
    };
    installCloseProtection(window as never);
    const quit = ipcMainMock.handlers.get("application:request-quit");
    expect(quit).toBeDefined();
    expect(quit?.({ sender: {}, senderFrame: contents.mainFrame })).toMatchObject({ ok: false });
    expect(quit?.({ sender: contents, senderFrame: {} })).toMatchObject({ ok: false });
    expect(quit?.({ sender: contents, senderFrame: contents.mainFrame })).toMatchObject({
      ok: true,
    });
    expect(quit?.({ sender: contents, senderFrame: contents.mainFrame })).toMatchObject({
      ok: true,
    });
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
    listeners.get("closed")?.();
    expect(ipcMainMock.handlers.has("application:request-quit")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("window layout carries the physical width of the display containing the window", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let x = 0;
  const window = {
    getContentSize: () => [2560, 1440],
    isDestroyed: () => false,
    isMaximized: () => true,
    getBounds: () => ({ x, y: 0, width: 1280, height: 900 }),
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    webContents: { send: vi.fn() },
  };
  vi.mocked(electron.screen.getDisplayMatching).mockImplementation(
    (bounds) =>
      ({
        id: bounds.x === 0 ? 101 : 102,
        rotation: 0,
        workArea: { x: 0, y: 0, width: 2560, height: 1440 },
      }) as never,
  );
  installWindowLayoutBridge(window as never);
  const read = () =>
    ipcMainMock.handlers.get("application:get-window-layout-state")?.({}, undefined);
  await expect(read()).resolves.toMatchObject({
    ok: true,
    value: { contentWidth: 2560, displayWidthMm: 326.571 },
  });
  x = 1280;
  await expect(read()).resolves.toMatchObject({ ok: true, value: { displayWidthMm: 600 } });
  expect(readPhysicalDisplayWidthMm).toHaveBeenCalledWith(101, 0);
  expect(readPhysicalDisplayWidthMm).toHaveBeenCalledWith(102, 0);
  listeners.get("closed")?.();
});
