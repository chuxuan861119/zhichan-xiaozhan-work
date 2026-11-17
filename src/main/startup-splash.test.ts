import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createStartupSplash, resolveStartupSplashPath } from "./startup-splash.js";

function createWindow() {
  return {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    loadURL: vi.fn<(url: string) => Promise<void>>(async () => undefined),
    show: vi.fn(),
    webContents: { executeJavaScript: vi.fn(async () => undefined) },
  };
}

describe("startup splash", () => {
  test("shows a local branded window and updates its visible status", async () => {
    const window = createWindow();
    const splash = createStartupSplash({
      createWindow: () => window as never,
      splashHtmlPath: () => "C:/app/resources/startup-splash.html",
    });

    await splash.show();
    splash.setStatus("正在打开本地专利库");

    expect(window.loadFile).toHaveBeenCalledWith("C:/app/resources/startup-splash.html");
    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("正在打开本地专利库"),
    );
  });

  test("keeps the splash visible for its minimum duration before closing once", async () => {
    const window = createWindow();
    const sleep = vi.fn<(duration: number) => Promise<void>>(async () => undefined);
    const splash = createStartupSplash({
      createWindow: () => window as never,
      splashHtmlPath: () => "C:/app/resources/startup-splash.html",
      now: () => 100,
      sleep,
    });

    await splash.show();
    await splash.closeAfterMainReady();
    await splash.closeAfterMainReady();

    expect(sleep.mock.calls.map(([duration]) => duration)).toEqual([1_500, 400]);
    expect(window.destroy).toHaveBeenCalledOnce();
  });
});

test.each(["openharmony", "ohos"])(
  "uses installed splash resources on %s even when isPackaged is false",
  (platform) => {
    expect(resolveStartupSplashPath(false, platform, "/installed", "/app/workbench/main")).toBe(
      join("/installed", "resources", "startup-splash.html"),
    );
  },
);
