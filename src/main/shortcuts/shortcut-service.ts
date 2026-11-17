import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, dialog, shell } from "electron";
import { APPLICATION_NAME } from "../../shared/branding.js";
import { installedMacBundle } from "../platform/dock-onboarding.js";

export function createDesktopShortcut(): boolean {
  if (["openharmony", "ohos"].includes(process.platform)) {
    dialog.showMessageBoxSync({
      type: "info",
      title: "添加至桌面",
      buttons: ["知道了"],
      message: "请在桌面底部快捷栏或应用中心，右键单击知产小栈Work，选择“添加至桌面”。",
      detail: "鸿蒙的应用图标由系统管理；较新系统安装后会自动添加桌面图标。",
    });
    return true;
  }
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error("当前系统未提供应用桌面图标接口。");
  if (process.platform === "darwin") {
    if (!app.isPackaged) throw new Error("请在安装版中创建应用快捷方式。");
    const bundle = installedMacBundle({
      platform: process.platform,
      packaged: app.isPackaged,
      isolated: false,
      executable: process.execPath,
      home: homedir(),
    });
    if (!bundle) throw new Error("请先将软件移到“应用程序”文件夹，再创建桌面快捷方式。");
    const destination = join(app.getPath("desktop"), `${APPLICATION_NAME}.app`);
    try {
      if (lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === bundle)
        return true;
      throw new Error("桌面已有同名项目，请保留原项目后重试。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    symlinkSync(bundle, destination);
    return true;
  }
  return shell.writeShortcutLink(
    join(app.getPath("desktop"), `${APPLICATION_NAME}.lnk`),
    "create",
    {
      target: process.execPath,
      cwd: dirname(process.execPath),
      description: APPLICATION_NAME,
      icon: process.execPath,
      iconIndex: 0,
    },
  );
}
