import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { SafeLogger } from "../../../src/main/logging/safe-log.js";
import {
  installDiagramFrameSecurity,
  installRendererFailureReporting,
  installRendererRecovery,
} from "../../../src/main/window.js";

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: process.env.RECOVERY_PRELOAD!,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  installDiagramFrameSecurity(win.webContents);
  installRendererRecovery(win);
  installRendererFailureReporting(new SafeLogger(join(app.getPath("userData"), "logs"), "test"));
  await win.loadFile(join(__dirname, "index.html"));
});
