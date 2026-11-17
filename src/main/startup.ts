import { APPLICATION_NAME } from "../shared/branding.js";
import { LibraryDirectoryMigrationError } from "./library/library-directory-migration.js";
import { LibraryLocationError } from "./library/library-location.js";
import { LibraryRuntimePreparationError } from "./library/library-runtime.js";
import type { SafeLogger } from "./logging/safe-log.js";

type StartupFailureNotifier = (title: string, message: string) => void;

export async function reportStartupFailure(
  logger: SafeLogger,
  quit: () => void,
  notify: StartupFailureNotifier,
  error?: unknown,
): Promise<void> {
  const directoryError = error instanceof LibraryDirectoryMigrationError ? error : undefined;
  const librarySchemaError = error instanceof LibraryRuntimePreparationError ? error : undefined;
  try {
    await logger.log("error", {
      event: "app.start_failed",
      errorCode: directoryError?.code ?? librarySchemaError?.code ?? "INTERNAL",
    });
  } catch {
    // Startup termination must not depend on logging availability.
  }
  try {
    notify(
      `${APPLICATION_NAME}无法启动`,
      directoryError?.message ??
        (error instanceof LibraryLocationError ? error.message : undefined) ??
        (librarySchemaError?.reason === "unsupported-schema"
          ? "检测到不兼容的旧版本本地专利库。当前版本未修改或删除旧资料。请先使用此前能够打开该专利库的版本导出“完整数据包”，再在当前版本的“数据迁移”中导入；完成导出前，请勿删除或移动 Library 文件夹。"
          : undefined) ??
        "本地文档库或应用组件初始化失败。软件未修改或删除旧资料，请重新启动；如仍失败，请联系开发人员。",
    );
  } catch {
    // Startup termination must not depend on the native error dialog.
  }
  quit();
}
