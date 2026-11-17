// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  maximize: vi.fn(),
  show: vi.fn(),
  destroy: vi.fn(),
  create: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: class {
    loadURL = mocks.load;
    maximize = mocks.maximize;
    show = mocks.show;
    destroy = mocks.destroy;
    isDestroyed = () => false;
    on = vi.fn();
    webContents = {
      on: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      mainFrame: {},
      session: { on: vi.fn() },
    };
    constructor(options: unknown) {
      mocks.create(options);
    }
  },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  Menu: { setApplicationMenu: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { on: vi.fn() } },
}));
vi.mock("./security.js", () => ({
  installOfflinePolicy: vi.fn(),
  isDevToolsEnabled: () => false,
  shouldEnforceOfflinePolicy: () => true,
  isAllowedRendererUrl: () => false,
}));
vi.mock("./window-display-bounds.js", () => ({
  initialWindowBounds: () => ({ width: 1280, height: 800 }),
  installDisplayBoundsProtection: vi.fn(),
}));

import { createMainWindow } from "./window.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReset();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
  vi.stubEnv("PATENT_WORKBENCH_TEST", "");
  mocks.load.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

test("main window loads before being shown maximized, without a small blank startup window", async () => {
  let finish!: () => void;
  mocks.load.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const opening = createMainWindow({ log: vi.fn() } as never);
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalled());
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
  expect(mocks.show).not.toHaveBeenCalled();
  expect(mocks.maximize).not.toHaveBeenCalled();
  finish();
  await opening;
  expect(mocks.maximize).toHaveBeenCalledOnce();
  expect(mocks.show).toHaveBeenCalledOnce();
  expect(mocks.maximize.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.show.mock.invocationCallOrder[0] ?? 0,
  );
});

test.each(["hidden", "test"])(
  "%s startup never activates or maximizes a background window",
  async (mode) => {
    if (mode === "test") vi.stubEnv("PATENT_WORKBENCH_TEST", "1");
    await createMainWindow({ log: vi.fn() } as never, { hidden: mode === "hidden" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
    expect(mocks.maximize).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  },
);

test("a failed renderer load never shows the incomplete window", async () => {
  mocks.load.mockRejectedValueOnce(new Error("load failed"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(createMainWindow({ log: vi.fn() } as never)).rejects.toThrow();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.show).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});
