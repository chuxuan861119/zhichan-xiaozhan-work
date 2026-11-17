import { homedir } from "node:os";
import { join, posix } from "node:path";
import { app, dialog } from "electron";
import { APPLICATION_NAME } from "../../shared/branding.js";
export function shouldOfferMacInstallation(options: {
  platform: string;
  packaged: boolean;
  mas: boolean;
  isolated: boolean;
  inApplications: boolean;
  executable: string;
  downloads?: string;
}): boolean {
  if (
    options.platform !== "darwin" ||
    !options.packaged ||
    options.mas ||
    options.isolated ||
    options.inApplications
  )
    return false;
  const { dirname, join, relative } = posix;
  const bundle = dirname(dirname(dirname(options.executable)));
  const downloadChild = options.downloads ? relative(options.downloads, bundle) : "";
  const downloaded = Boolean(
    options.downloads &&
      downloadChild &&
      !downloadChild.startsWith("..") &&
      !downloadChild.startsWith("/"),
  );
  const translocated =
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/[^/]+\/AppTranslocation\/[^/]+\/d\//u.test(
      bundle,
    );
  return (
    (bundle.startsWith("/Volumes/") || translocated || downloaded) &&
    bundle.endsWith(".app") &&
    dirname(options.executable) === join(bundle, "Contents", "MacOS")
  );
}
export async function offerMacInstallation(dependencies: {
  ask(kind: "install"): Promise<boolean>;
  move(conflict: (type: string) => boolean): boolean;
  confirmReplace(): boolean;
  inform(reason: "running" | "cancelled" | "failed"): Promise<void>;
}): Promise<"continue" | "relaunching"> {
  if (!(await dependencies.ask("install"))) return "continue";
  let running = false;
  try {
    const moved = dependencies.move((type) => {
      if (type === "existsAndRunning") {
        running = true;
        return false;
      }
      return type === "exists" && dependencies.confirmReplace();
    });
    if (moved) return "relaunching";
    await dependencies.inform(running ? "running" : "cancelled");
  } catch {
    await dependencies.inform("failed");
  }
  return "continue";
}
export async function installMacFromDownloadDisk(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged || process.mas) return false;
  const eligible = shouldOfferMacInstallation({
    platform: process.platform,
    packaged: app.isPackaged,
    mas: false,
    executable: process.execPath,
    downloads: join(homedir(), "Downloads"),
    inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
    isolated:
      process.env.PATENT_WORKBENCH_TEST === "1" ||
      process.env.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES === "1" ||
      Boolean(
        process.env.PATENT_WORKBENCH_LIBRARY_ROOT || process.env.ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT,
      ) ||
      process.argv.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir=")),
  });
  if (!eligible) return false;
  const result = await offerMacInstallation({
    ask: async () =>
      (
        await dialog.showMessageBox({
          type: "question",
          title: "安装并打开",
          message: `将${APPLICATION_NAME}安装到“应用程序”并打开？`,
          detail:
            "当前软件尚未安装到应用程序。安装后将自动打开软件，无需去应用列表寻找。专利文档保存在独立文档库中。",
          buttons: ["安装并打开", "暂时试用"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      ).response === 0,
    move: (conflictHandler) => app.moveToApplicationsFolder({ conflictHandler }),
    confirmReplace: () =>
      dialog.showMessageBoxSync({
        type: "warning",
        title: "替换已有软件",
        message: "应用程序中已有同名软件，是否替换？",
        detail: "旧软件副本将移入废纸篓，文档库不会删除。",
        buttons: ["取消", "替换并打开"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }) === 1,
    inform: async (reason) => {
      await dialog.showMessageBox({
        type: "info",
        title: "安装尚未完成",
        message:
          reason === "running"
            ? "请先退出已经安装的版本，再重试安装。"
            : reason === "failed"
              ? "未能复制软件，请将图标拖入“应用程序”文件夹。"
              : "安装已取消，当前仍从下载位置运行。",
        detail:
          "可继续试用，或退出后重新打开下载的软件进行安装。安装完成并打开软件后，可以推出下载盘。",
        buttons: ["知道了"],
        noLink: true,
      });
    },
  });
  return result === "relaunching";
}
