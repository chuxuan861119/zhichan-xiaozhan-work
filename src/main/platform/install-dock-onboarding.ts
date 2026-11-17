import { homedir } from "node:os";
import { app, type BrowserWindow, dialog } from "electron";
import { APPLICATION_APP_ID, APPLICATION_NAME } from "../../shared/branding.js";
import { installedMacBundle, runDockOnboarding } from "./dock-onboarding.js";
import { createDockPreferences, refreshCurrentUserDock } from "./dock-preferences.js";

export function installDockOnboarding(window: BrowserWindow, onFailure: () => void) {
  if (process.mas) return;
  const uid = process.getuid?.() ?? -1;
  const bundle = installedMacBundle({
    platform: process.platform,
    packaged: app.isPackaged,
    executable: process.execPath,
    home: homedir(),
    isolated:
      uid <= 0 ||
      process.env.PATENT_WORKBENCH_TEST === "1" ||
      process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES === "1" ||
      Boolean(process.env.PATENT_WORKBENCH_LIBRARY_ROOT) ||
      Boolean(process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT) ||
      process.argv.some(
        (argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="),
      ),
  });
  if (!bundle) return;
  const preferences = createDockPreferences({
    bundle,
    bundleId: APPLICATION_APP_ID,
    label: APPLICATION_NAME,
    refresh: () => refreshCurrentUserDock(uid),
  });
  const show = () => {
    if (window.isDestroyed()) return;
    void runDockOnboarding({
      userData: app.getPath("userData"),
      contains: preferences.contains,
      add: preferences.add,
      ask: async () => {
        if (window.isDestroyed()) return false;
        const choice = await dialog.showMessageBox(window, {
          type: "question",
          title: "添加到 Dock",
          message: `将${APPLICATION_NAME}保留在程序坞中？`,
          detail:
            "软件已安装到应用程序，当前已打开。添加后方便下次直接打开。添加时程序坞会短暂刷新；此提示只出现一次，之后主动移除也不会自动添加回来。",
          buttons: ["添加到 Dock", "暂不添加"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return choice.response === 0 && !window.isDestroyed();
      },
      reportFailure: async () => {
        onFailure();
        if (window.isDestroyed()) return;
        await dialog.showMessageBox(window, {
          type: "info",
          title: "Dock 添加未完成",
          message: "自动添加或刷新程序坞未完成。",
          detail: "你仍可右键程序坞中的软件图标，选择“选项 → 在程序坞中保留”。软件不会自动重试。",
          buttons: ["知道了"],
          noLink: true,
        });
      },
    }).catch(onFailure);
  };
  if (window.isVisible()) show();
  else window.once("show", show);
}
