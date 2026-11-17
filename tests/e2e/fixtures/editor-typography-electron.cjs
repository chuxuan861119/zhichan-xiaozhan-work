const { app, BrowserWindow } = require("electron");

// A renderer-only harness: no application services, document library or visible window.
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.setMenu(null);
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
