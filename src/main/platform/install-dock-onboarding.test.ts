import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn(() => "/test/user-data") },
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  run: vi.fn(async (_options: Record<string, unknown>) => undefined),
  preferences: vi.fn(() => ({ contains: vi.fn(), add: vi.fn() })),
}));
vi.mock("electron", () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("./dock-onboarding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dock-onboarding.js")>()),
  runDockOnboarding: mocks.run,
}));
vi.mock("./dock-preferences.js", () => ({
  createDockPreferences: mocks.preferences,
  refreshCurrentUserDock: vi.fn(),
}));

import { installDockOnboarding } from "./install-dock-onboarding.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    execPath: "/Applications/知产小栈Work.app/Contents/MacOS/知产小栈Work",
    getuid: () => 501,
    argv: [],
    env: {},
  });
});
afterEach(() => vi.unstubAllGlobals());
function windowFixture(visible: boolean) {
  return { isVisible: () => visible, isDestroyed: vi.fn(() => false), once: vi.fn() };
}

test("hidden login startup waits until the window is shown", () => {
  const window = windowFixture(false);
  installDockOnboarding(window as unknown as BrowserWindow, vi.fn());
  expect(mocks.run).not.toHaveBeenCalled();
  expect(window.once).toHaveBeenCalledWith("show", expect.any(Function));
  window.once.mock.calls[0]?.[1]();
  expect(mocks.run).toHaveBeenCalledOnce();
});

test("visible installed app offers explicit Add and Skip choices", async () => {
  const window = windowFixture(true);
  installDockOnboarding(window as unknown as BrowserWindow, vi.fn());
  const options = mocks.run.mock.calls[0]?.[0];
  if (!options) throw new Error("Missing onboarding options");
  expect(await (options.ask as () => Promise<boolean>)()).toBe(true);
  expect(mocks.showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ buttons: ["添加到 Dock", "暂不添加"], cancelId: 1 }),
  );
  window.isDestroyed.mockReturnValue(true);
  expect(await (options.ask as () => Promise<boolean>)()).toBe(false);
});

test.each(["development", "isolated", "mounted"])(
  "%s never reads or writes Dock preferences",
  (mode) => {
    if (mode === "development") mocks.app.isPackaged = false;
    if (mode === "isolated") process.env.PATENT_WORKBENCH_TEST = "1";
    if (mode === "mounted")
      process.execPath = "/Volumes/install/知产小栈Work.app/Contents/MacOS/知产小栈Work";
    installDockOnboarding(windowFixture(true) as unknown as BrowserWindow, vi.fn());
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  },
);
