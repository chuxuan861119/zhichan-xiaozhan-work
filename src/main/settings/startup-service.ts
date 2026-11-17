import { win32 } from "node:path";
import type { App } from "electron";
import { isHarmonyPlatform } from "../../shared/platform.js";
import type { StartupState } from "../../shared/settings/startup.js";

type HarmonyStartup = { readStartup(): Promise<boolean>; openStartupSettings(): Promise<void> };

export const STARTUP_TRAY_ARGUMENT = "--startup-to-tray";
const STARTUP_ITEM_NAME = "ZhichanXiaozhanWork";
export function isStartupIsolated(
  platform: string,
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    environment.PATENT_WORKBENCH_TEST === "1" ||
    environment.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES === "1" ||
    environment.PATENT_WORKBENCH_LIBRARY_ROOT ||
    environment.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT
  )
    return true;
  return argv.some((argument, index) => {
    if (argument !== "--user-data-dir" && !argument.startsWith("--user-data-dir=")) return false;
    const directory = argument === "--user-data-dir" ? argv[index + 1] : argument.slice(16);
    // appspawn supplies the application's normal sandbox directory on Harmony.
    return !(
      isHarmonyPlatform(platform) &&
      directory?.replace(/\/+$/, "") === "/data/storage/el2/base/files"
    );
  });
}
export function createStartupService(
  application: Pick<App, "isPackaged" | "getLoginItemSettings" | "setLoginItemSettings">,
  platform: string = process.platform,
  executable = process.execPath,
  isolated = isStartupIsolated(platform),
  harmony?: HarmonyStartup,
) {
  const systemManaged = isHarmonyPlatform(platform) && !isolated && Boolean(harmony);
  const supported =
    (platform === "win32" || platform === "darwin") && application.isPackaged && !isolated;
  const target = { path: executable, args: [STARTUP_TRAY_ARGUMENT] };
  const read = (): StartupState | Promise<StartupState> => {
    if (systemManaged && harmony)
      return harmony
        .readStartup()
        .then((enabled) => ({ supported: true, enabled, management: "system" as const }));
    if (isHarmonyPlatform(platform))
      return {
        supported: false,
        enabled: false,
        unavailableReason: isolated ? "测试实例不修改系统启动设置" : "鸿蒙系统启动管理暂不可用",
      };
    if (!supported) return { supported: false, enabled: false };
    if (platform === "darwin") {
      return { supported: true, enabled: application.getLoginItemSettings().openAtLogin };
    }
    const state = application.getLoginItemSettings(target);
    // Electron's openAtLogin checks the default AppUserModelID, not our named
    // entry. launchItems reflects named entries and Windows startup approval.
    // Its args list omits command-line switches, including STARTUP_TRAY_ARGUMENT.
    return {
      supported: true,
      enabled: state.launchItems.some(
        (item) =>
          item.name.toLowerCase() === STARTUP_ITEM_NAME.toLowerCase() &&
          item.scope === "user" &&
          win32.normalize(item.path).toLowerCase() === win32.normalize(executable).toLowerCase() &&
          item.enabled,
      ),
    };
  };
  return {
    read,
    update(enabled: boolean): StartupState | Promise<StartupState> {
      if (systemManaged && harmony) return harmony.openStartupSettings().then(read);
      if (!supported)
        throw new Error("开机启动仅支持 Windows 和 Mac 安装版，临时实例不会修改系统启动项。");
      application.setLoginItemSettings(
        platform === "darwin"
          ? { openAtLogin: enabled }
          : {
              ...target,
              name: STARTUP_ITEM_NAME,
              openAtLogin: enabled,
              enabled,
            },
      );
      const state = read() as StartupState;
      if (state.enabled !== enabled)
        throw new Error(
          `${platform === "darwin" ? "macOS" : "Windows"} 未应用开机启动设置，请检查系统登录或启动项设置。`,
        );
      return state;
    },
  };
}
