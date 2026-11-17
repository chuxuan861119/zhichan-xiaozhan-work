// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

test("background fixture retains native window identity and never calls native visibility methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "hidden-window-unit-"));
  try {
    const source = join(root, "main.js");
    await writeFile(source, "globalThis.testWindow = new BrowserWindow({show:true});");
    const prepare = createRequire(import.meta.url)("../tests/e2e/fixtures/background-electron.cjs");
    const entry = await prepare(source);
    class FakeWindow {
      options: { show: boolean };
      size = [1440, 900];
      webContents = { setFrameRate() {} };
      constructor(options: { show: boolean }) {
        this.options = options;
      }
      getSize() {
        return this.size;
      }
      setSize(w: number, h: number) {
        this.size = [w, h];
      }
      emit() {}
      show() {
        throw new Error("native show");
      }
      maximize() {
        throw new Error("native maximize");
      }
      unmaximize() {
        throw new Error("native unmaximize");
      }
      minimize() {
        throw new Error("native minimize");
      }
      restore() {
        throw new Error("native restore");
      }
      setFullScreen() {
        throw new Error("native fullscreen");
      }
      isMaximized() {
        return false;
      }
      isMinimized() {
        return false;
      }
    }
    const context = {
      BrowserWindow: FakeWindow,
      app: { disableHardwareAcceleration() {} },
      process: { on() {}, env: {} },
      console,
      testWindow: undefined as unknown as FakeWindow,
    };
    runInNewContext(await readFile(entry, "utf8"), context);
    const window = context.testWindow;
    expect(window.constructor).toBe(FakeWindow);
    expect(window.options.show).toBe(false);
    window.show();
    window.maximize();
    expect(window.isMaximized()).toBe(true);
    window.unmaximize();
    expect(window.isMaximized()).toBe(false);
    window.minimize();
    expect(window.isMinimized()).toBe(true);
    window.restore();
    expect(window.isMinimized()).toBe(false);
    window.setFullScreen();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
