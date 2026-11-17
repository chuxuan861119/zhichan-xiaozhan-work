import { join } from "node:path";
import { createDesktopShortcut } from "./shortcut-service.js";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readlink: vi.fn(),
  symlink: vi.fn(),
  app: { isPackaged: true, getPath: vi.fn(() => "/Users/example/Desktop") },
  writeShortcut: vi.fn(() => true),
  message: vi.fn(() => 0),
}));
vi.mock("node:fs", async (importOriginal) => {
  const mocked = {
    ...(await importOriginal<typeof import("node:fs")>()),
    lstatSync: mocks.lstat,
    readlinkSync: mocks.readlink,
    symlinkSync: mocks.symlink,
  };
  return { ...mocked, default: mocked };
});
vi.mock("electron", () => ({
  app: mocks.app,
  dialog: { showMessageBoxSync: mocks.message },
  shell: { writeShortcutLink: mocks.writeShortcut },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    execPath: "/Applications/知产小栈Work.app/Contents/MacOS/知产小栈Work",
  });
});
afterEach(() => vi.unstubAllGlobals());
test("creates a Mac desktop entry pointing to the installed app", () => {
  mocks.lstat.mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ENOENT" });
  });
  expect(createDesktopShortcut()).toBe(true);
  expect(mocks.symlink).toHaveBeenCalledWith(
    "/Applications/知产小栈Work.app",
    join("/Users/example/Desktop", "知产小栈Work.app"),
  );
  expect(mocks.writeShortcut).not.toHaveBeenCalled();
});
test("accepts an existing matching entry and preserves a different desktop item", () => {
  mocks.lstat.mockReturnValue({ isSymbolicLink: () => true });
  mocks.readlink.mockReturnValue("/Applications/知产小栈Work.app");
  expect(createDesktopShortcut()).toBe(true);
  mocks.readlink.mockReturnValue("/Applications/Other.app");
  expect(() => createDesktopShortcut()).toThrow("桌面已有同名项目");
  expect(mocks.symlink).not.toHaveBeenCalled();
});
test("refuses development processes", () => {
  mocks.app.isPackaged = false;
  expect(() => createDesktopShortcut()).toThrow("安装版");
  expect(mocks.symlink).not.toHaveBeenCalled();
});

test.each(["/Volumes/Workbench", "/private/tmp/Workbench"])(
  "refuses desktop entries pointing to temporary apps in %s",
  (root) => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      execPath: `${root}/知产小栈Work.app/Contents/MacOS/知产小栈Work`,
    });
    expect(() => createDesktopShortcut()).toThrow("应用程序");
    expect(mocks.symlink).not.toHaveBeenCalled();
  },
);

test.each(["openharmony", "ohos"])(
  "guides the system launcher on %s without writing Windows files",
  (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    expect(createDesktopShortcut()).toBe(true);
    expect(mocks.message).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("添加至桌面") }),
    );
    expect(mocks.writeShortcut).not.toHaveBeenCalled();
    expect(mocks.symlink).not.toHaveBeenCalled();
  },
);
