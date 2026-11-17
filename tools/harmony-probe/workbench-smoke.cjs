const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(app.getPath("userData"), "workbench-smoke-v1");
fs.mkdirSync(root, { recursive: true });
app.setPath("userData", root);
process.env.PATENT_WORKBENCH_TEST = "1";
process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES = "1";
process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT = path.join(root, "library");
process.env.PATENT_HARMONY_SQLITE_MODULE = path.join(__dirname, "sqlite-adapted.cjs");
process.argv.push("--startup-to-tray");
const report = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  windows: [],
  errors: [],
  fileDialogs: "stubbed to synthetic sandbox outputs; native picker unverified",
};
const exportRoot = path.join(root, `exports-${require("node:crypto").randomUUID()}`);
fs.mkdirSync(exportRoot);
const exportFiles = ["sample.patdoc", "sample.docx", "sample.pdf"].map((name) =>
  path.join(exportRoot, name),
);
const pendingExports = [...exportFiles];
dialog.showSaveDialog = async () => {
  const filePath = pendingExports.shift();
  if (!filePath) throw new Error("Unexpected extra save dialog");
  return { canceled: false, filePath };
};
function persist() {
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Harmony workbench smoke report: ${root}/report.json`);
}
persist();
process.on("uncaughtExceptionMonitor", (error) => {
  report.errors.push(String(error.stack));
  persist();
});
app.on("browser-window-created", (_event, window) => {
  const record = { id: window.id, visible: window.isVisible() };
  report.windows.push(record);
  persist();
  window.webContents.on("preload-error", (_event, _file, error) => {
    record.preloadError = String(error);
    persist();
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    record.loadError = { code, description };
    persist();
  });
  window.webContents.on("did-finish-load", () => {
    record.url = window.webContents.getURL();
    persist();
    if (!record.url.startsWith("patent-app:")) return;
    setTimeout(async () => {
      try {
        record.page = await window.webContents.executeJavaScript(
          `({title:document.title,body:document.body.innerText.slice(0,2000),api:typeof window.patentApi})`,
        );
        record.library = await window.webContents.executeJavaScript(
          `window.patentApi.patents.list('active')`,
        );
        record.flow = await window.webContents.executeJavaScript(
          `(${require("./workbench-flow.cjs").toString()})()`,
        );
        record.exportFiles = exportFiles.map((file) => ({
          file,
          size: fs.statSync(file).size,
          signature: fs.readFileSync(file).subarray(0, 5).toString("ascii"),
        }));
        record.visible = window.isVisible();
        report.finishedAt = new Date().toISOString();
        persist();
      } catch (error) {
        report.errors.push(String(error.stack));
        persist();
      }
      app.quit();
    }, 2000);
  });
});
setTimeout(() => {
  report.timeout = true;
  persist();
  app.quit();
}, 30000).unref();
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
