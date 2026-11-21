// Shared business code is bundled separately. This file owns Harmony startup only.
const { app, safeStorage, systemPreferences } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const configuration = require("./harmony-build.json");
delete process.env.PATENT_HARMONY_APP_PACKAGE;
if (
  configuration.local === false &&
  !configuration.smoke &&
  !configuration.acceptance &&
  !configuration.uiAcceptance &&
  !configuration.hotReload
)
  process.env.PATENT_HARMONY_APP_PACKAGE = "1";
if (configuration.hotReload) {
  if (!configuration.local || configuration.smoke)
    throw new Error("Hot reload requires a local interactive build");
  process.env.PATENT_HARMONY_HOT_RELOAD_URL = "http://127.0.0.1:5179/";
  process.env.ELECTRON_RENDERER_URL = process.env.PATENT_HARMONY_HOT_RELOAD_URL;
  const inspector = require("node:inspector");
  if (!inspector.url()) inspector.open(9229, "127.0.0.1");
}
if (configuration.uiAcceptance) {
  if (!configuration.local || !configuration.acceptance || !configuration.smoke)
    throw new Error("UI debugging requires an isolated local acceptance build");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}
if (configuration.emulator) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}
let data = app.getPath("userData");
let acceptanceMode = "standard";
if (configuration.acceptance && !configuration.uiAcceptance) {
  const control = path.join(data, "acceptance-control.json");
  if (fs.existsSync(control)) {
    const mode = JSON.parse(fs.readFileSync(control, "utf8")).mode;
    if (!["standard", "restore", "native"].includes(mode))
      throw new Error("Unknown acceptance mode");
    acceptanceMode = mode;
  }
}
if (configuration.local) {
  data = path.join(
    data,
    configuration.uiAcceptance
      ? "workbench-ui-acceptance-v1"
      : acceptanceMode === "restore"
        ? "workbench-restore-v3"
        : configuration.smoke
          ? "workbench-buildcheck-v1"
          : "workbench-interactive-v1",
  );
  fs.mkdirSync(data, { recursive: true });
  app.setPath("userData", data);
  process.env.PATENT_WORKBENCH_TEST = "1";
  process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES = "1";
  process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT = path.join(data, "library");
}
process.env.PATENT_HARMONY_SQLITE_MODULE = path.join(__dirname, "sqlite-adapted.cjs");
if (configuration.smoke) process.argv.push("--startup-to-tray");
const diagnostics = require("./startup-diagnostics.cjs")(data);
const report = {
  source: configuration.source,
  platform: process.platform,
  startedAt: new Date().toISOString(),
  windows: [],
  errors: [],
};
function persist() {
  fs.mkdirSync(diagnostics, { recursive: true });
  fs.writeFileSync(path.join(diagnostics, "harmony-startup.json"), JSON.stringify(report, null, 2));
}
function nativeResponse(name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native platform check timed out")), 10000);
    systemPreferences.callArkTSFunction(name, "void", [
      (value) => {
        clearTimeout(timer);
        resolve(JSON.parse(value));
      },
    ]);
  });
}
globalThis.__harmonyStartupError = (error) => {
  report.errors.push(String(error.stack ?? error));
  persist();
};
process.on("uncaughtExceptionMonitor", globalThis.__harmonyStartupError);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("preload-error", (_event, _file, error) =>
    globalThis.__harmonyStartupError(error),
  );
  window.webContents.on("did-finish-load", () => {
    if (
      !window.webContents.getURL().startsWith("patent-app:") &&
      !(
        configuration.hotReload && window.webContents.getURL() === process.env.ELECTRON_RENDERER_URL
      )
    )
      return;
    setTimeout(async () => {
      try {
        const page = await window.webContents.executeJavaScript(
          '({title:document.title,api:typeof window.patentApi,fontPlatform:globalThis.documentFontPlatform,fonts:!!document.getElementById("document-fonts"),viewport:{layoutHeight:innerHeight,visibleHeight:window.visualViewport?.height,ratio:devicePixelRatio,contentHeight:getComputedStyle(document.documentElement).getPropertyValue("--harmony-content-height")}})',
        );
        const record = {
          title: window.getTitle(),
          visible: window.isVisible(),
          nativeHandle: window.getNativeWindowHandle().toString("hex"),
          page,
        };
        if (configuration.smoke) {
          record.nativePlatform = {
            startup: await nativeResponse("Workbench.ReadStartup"),
            files: await nativeResponse("Workbench.RestoreFileAccess"),
          };
          if (!safeStorage.isEncryptionAvailable())
            throw new Error("Credential encryption unavailable");
          // A fixed, unusable test string; never read application credentials.
          const credentialFile = path.join(diagnostics, "synthetic-credential.bin");
          const synthetic = "harmony-synthetic-credential-v1";
          const previous = fs.existsSync(credentialFile);
          if (previous && safeStorage.decryptString(fs.readFileSync(credentialFile)) !== synthetic)
            throw new Error("Credential restart verification failed");
          fs.writeFileSync(credentialFile, safeStorage.encryptString(synthetic), { mode: 0o600 });
          if (safeStorage.decryptString(fs.readFileSync(credentialFile)) !== synthetic)
            throw new Error("Credential verification failed");
          record.credential = { encrypted: true, previousLaunchVerified: previous };
          record.library = await window.webContents.executeJavaScript(
            "window.patentApi.patents.list('active')",
          );
          if (configuration.acceptance && !configuration.uiAcceptance)
            record.acceptance = await require("./acceptance-main.cjs")(
              window,
              data,
              acceptanceMode,
            );
          if (!configuration.uiAcceptance && (window.isVisible() || window.isFocused()))
            throw new Error("Smoke window must remain hidden and unfocused");
        }
        report.windows.push(record);
        report.readyAt = new Date().toISOString();
        persist();
        // Device-side capture avoids the emulator's unsupported hidden CDP capture path.
        if (configuration.uiAcceptance) window.showInactive();
      } catch (error) {
        globalThis.__harmonyStartupError(error);
      }
      if (configuration.smoke && !configuration.uiAcceptance) app.quit();
    }, 1500);
  });
});
if (configuration.smoke && !configuration.uiAcceptance)
  setTimeout(
    () => {
      globalThis.__harmonyStartupError(new Error("Smoke startup timeout"));
      app.quit();
    },
    configuration.acceptance ? 240000 : 45000,
  ).unref();
globalThis.__harmonyAdaptersReady = require("./sharp-adapted.cjs").initialize();
persist();
try {
  require("./workbench/main/index.cjs");
} catch (error) {
  globalThis.__harmonyStartupError(error);
  app.exit(1);
}
