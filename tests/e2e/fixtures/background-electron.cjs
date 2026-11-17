const { resolve, dirname, join } = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");

// Generate before Electron starts so privileged protocols register before app readiness.
// Only the test copy changes; services and preload are the production implementation.
module.exports = async function prepareHiddenMain(sourceEntry = "out/main/index.js") {
  const source = await readFile(resolve(sourceEntry), "utf8");
  if (!source.includes("new BrowserWindow("))
    throw new Error("Window constructor not found; refusing to launch uninstrumented.");
  const hidden = `function createHiddenTestWindow(options) {
    // Hidden native windows can still receive only one animation frame a second on Windows.
    // Offscreen rendering exercises real Chromium layout/animation without showing or focusing a window.
    const window = new BrowserWindow({...options,show:false,alwaysOnTop:false,webPreferences:{...options.webPreferences,backgroundThrottling:false,offscreen:true}});
    window.webContents.setFrameRate(60);
    // Keep native identity for getAllWindows(), but simulate layout-only window states.
    // Native maximize/restore can reveal a window even when show() is overridden.
    let maximized = false, minimized = false, fullScreen = false;
    let restoreSize = window.getSize();
    for (const method of ["show", "showInactive", "focus", "moveTop", "setAlwaysOnTop", "flashFrame"]) window[method] = () => {};
    window.isMaximized = () => maximized;
    window.isMinimized = () => minimized;
    window.isFullScreen = () => fullScreen;
    window.maximize = () => {
      if (maximized) return;
      restoreSize = window.getSize(); maximized = true;
      window.setSize(1920, 1080); window.emit("maximize");
    };
    window.unmaximize = () => {
      if (!maximized) return;
      maximized = false; window.setSize(...restoreSize); window.emit("unmaximize");
    };
    window.minimize = () => { minimized = true; window.emit("minimize"); };
    window.restore = () => { minimized = false; window.emit("restore"); };
    window.setFullScreen = (value) => { fullScreen = Boolean(value); window.emit(fullScreen ? "enter-full-screen" : "leave-full-screen"); };
    return window;
  }
  process.on("uncaughtException", error => { console.error(error); app.exit(1); });
  if (process.env.PATENT_WORKBENCH_E2E_HARDWARE_GRAPHICS !== "1") app.disableHardwareAcceleration();
  // Background acceptance never publishes OS notifications or animates the user's Dock.
  if (typeof Notification !== "undefined") Notification.isSupported = () => false;
  if (app.dock) { app.dock.bounce = () => -1; app.dock.cancelBounce = () => {}; }
${source.replaceAll("new BrowserWindow(", "createHiddenTestWindow(")}`;
  const entry = join(dirname(resolve(sourceEntry)), `index.hidden-test-${process.pid}.mjs`);
  await writeFile(entry, hidden, "utf8");
  return entry;
};
