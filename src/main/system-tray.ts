import { readFileSync } from "node:fs";
import { app, type BrowserWindow, ipcMain, Menu, Notification, nativeImage, Tray } from "electron";
import iconPath from "../../build/icon.png?asset";
import trayTemplateRetinaPath from "../../build/trayTemplate@2x.png?asset";
import trayTemplatePath from "../../build/trayTemplate.png?asset";
import { APPLICATION_NAME } from "../shared/branding.js";
import { IPC_CHANNELS } from "../shared/ipc/contract.js";
import { BackgroundSaveResultSchema } from "../shared/settings/startup.js";
import type { SettingsService } from "./settings/settings-service.js";
import { createTrayController } from "./tray-controller.js";

export async function installSystemTray(window: BrowserWindow, settings: SettingsService) {
  let tray: Tray | undefined;
  let status = "保存状态：在窗口中查看";
  const preferences = await settings.readReadOnly();
  let introDismissed = preferences.trayIntroDismissed;
  const notify = (message: string) => {
    if (process.env.PATENT_WORKBENCH_TEST === "1") return;
    if (process.platform === "win32")
      tray?.displayBalloon({ title: APPLICATION_NAME, content: message });
    else if (Notification.isSupported())
      new Notification({ title: APPLICATION_NAME, body: message }).show();
  };
  const controller = createTrayController({
    window,
    available: () => Boolean(tray && !tray.isDestroyed()),
    requestSave: (token) => window.webContents.send(IPC_CHANNELS.applicationBackgroundSave, token),
    updateStatus: (value) => {
      status = value;
      updateMenu();
    },
    notify,
    showIntro: () => {
      if (introDismissed) return;
      introDismissed = true;
      notify("软件仍在后台运行，可点击托盘图标打开，右键托盘图标退出。");
      void settings.update({ trayIntroDismissed: true }).catch(() => {
        introDismissed = false;
      });
    },
  });
  controller.setEnabled(preferences.closeToTray);
  function updateMenu() {
    if (!tray || tray.isDestroyed()) return;
    tray.setToolTip(`${APPLICATION_NAME} · ${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开主窗口", click: controller.open },
        { label: status, enabled: false },
        { type: "separator" },
        {
          label: "设置",
          click: () => {
            controller.open();
            window.webContents.send(IPC_CHANNELS.applicationTraySettings);
          },
        },
        { type: "separator" },
        {
          label: "退出软件",
          click: process.platform === "darwin" ? () => app.quit() : controller.quit,
        },
      ]),
    );
  }
  try {
    const icon = nativeImage.createFromPath(
      process.platform === "darwin" ? trayTemplatePath : iconPath,
    );
    if (icon.isEmpty()) throw new Error("托盘图标不可用");
    if (process.platform === "darwin") {
      icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayTemplateRetinaPath) });
      icon.setTemplateImage(true);
    }
    tray = new Tray(icon);
    tray.on("click", controller.open);
    tray.on("double-click", controller.open);
    tray.on("balloon-click", controller.open);
    updateMenu();
  } catch {
    tray?.destroy();
    tray = undefined;
    if (!window.isVisible()) window.showInactive();
    // No tray means close must retain the existing safe-exit behavior.
  }
  ipcMain.removeHandler(IPC_CHANNELS.applicationBackgroundSaveResult);
  ipcMain.handle(IPC_CHANNELS.applicationBackgroundSaveResult, (event, input) => {
    const parsed = BackgroundSaveResultSchema.safeParse(input);
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !parsed.success
    )
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Invalid background save response" },
      };
    controller.saved(parsed.data.token, parsed.data.ok);
    return { ok: true, value: undefined };
  });
  const beforeQuit = () => controller.beginQuit();
  app.on("before-quit", beforeQuit);
  window.on("query-session-end", () => {
    controller.beginQuit();
  });
  window.on("session-end", controller.beginQuit);
  window.on("closed", () => {
    app.removeListener("before-quit", beforeQuit);
    ipcMain.removeHandler(IPC_CHANNELS.applicationBackgroundSaveResult);
    controller.dispose();
    tray?.destroy();
  });
  return controller;
}
