const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(join(__dirname, "index.html"));
});
