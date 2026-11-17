// User-operated prototype: isolated data, real dialogs, no scripted edits or exit.
const { app } = require("electron");
// The current Mac-hosted PC emulator loses its GPU context on visible windows.
// Confine software rendering to this emulator preview, not production devices.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(app.getPath("userData"), "workbench-interactive-v1");
fs.mkdirSync(root, { recursive: true });
app.setPath("userData", root);
process.env.PATENT_WORKBENCH_TEST = "1";
process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES = "1";
process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT = path.join(root, "library");
process.env.PATENT_HARMONY_SQLITE_MODULE = path.join(__dirname, "sqlite-adapted.cjs");
const report = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  graphics: "software-rendering-for-emulator-preview",
  source: JSON.parse(fs.readFileSync(path.join(__dirname, "interactive-source.json"), "utf8")),
  windows: [],
  errors: [],
};
function persist() {
  fs.writeFileSync(path.join(root, "startup-report.json"), JSON.stringify(report, null, 2));
  console.log(`Harmony interactive startup: ${root}/startup-report.json`);
}
persist();
process.on("uncaughtExceptionMonitor", (error) => {
  report.errors.push(String(error.stack));
  persist();
});
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("preload-error", (_event, _file, error) => {
    report.errors.push(String(error));
    persist();
  });
  window.webContents.on("did-finish-load", () => {
    if (!window.webContents.getURL().startsWith("patent-app:")) return;
    // Explicit manual-preview request permits showing this specific window.
    window.show();
    window.focus();
    window.setTitle("知产小栈Work · 鸿蒙体验版");
    setTimeout(async () => {
      try {
        const page = await window.webContents.executeJavaScript(
          "({title:document.title,body:document.body.innerText.slice(0,300)})",
        );
        report.windows.push({
          id: window.id,
          title: window.getTitle(),
          visible: window.isVisible(),
          nativeHandle: window.getNativeWindowHandle().toString("hex"),
          url: window.webContents.getURL(),
          page,
        });
        report.readyAt = new Date().toISOString();
      } catch (error) {
        report.errors.push(String(error.stack));
      }
      persist();
    }, 1500);
  });
});
globalThis.__harmonyAdaptersReady = require("./sharp-adapted.cjs").initialize();
globalThis.__harmonyStartupError = (error) => {
  report.errors.push(String(error.stack));
  persist();
};
try {
  require("./workbench/main/index.cjs");
} catch (error) {
  globalThis.__harmonyStartupError(error);
  app.exit(2);
}
