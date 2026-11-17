import { LibraryDirectoryMigrationError } from "./library/library-directory-migration.js";
import { LibraryRuntimePreparationError } from "./library/library-runtime.js";
import type { SafeLogger } from "./logging/safe-log.js";
import { reportStartupFailure } from "./startup.js";

test("terminal startup failure logging uses only allow-listed metadata", async () => {
  const log = vi.fn().mockResolvedValue(true);
  const quit = vi.fn();
  const notify = vi.fn();

  await reportStartupFailure({ log } as unknown as SafeLogger, quit, notify);

  expect(log).toHaveBeenCalledWith("error", {
    event: "app.start_failed",
    errorCode: "INTERNAL",
  });
  expect(notify).toHaveBeenCalledWith(
    "知产小栈Work无法启动",
    "本地文档库或应用组件初始化失败。软件未修改或删除旧资料，请重新启动；如仍失败，请联系开发人员。",
  );
  expect(quit).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toContain("stack");
});

test("reports renamed library directory conflicts without hiding either location", async () => {
  const log = vi.fn().mockResolvedValue(true);
  const quit = vi.fn();
  const notify = vi.fn();
  const error = new LibraryDirectoryMigrationError(
    "LIBRARY_DIRECTORY_CONFLICT",
    "检测到新旧专利库数据目录同时存在。\n旧目录：C:\\old\n新目录：C:\\new",
    ["C:\\old", "C:\\new"],
  );

  await reportStartupFailure({ log } as unknown as SafeLogger, quit, notify, error);

  expect(log).toHaveBeenCalledWith("error", {
    event: "app.start_failed",
    errorCode: "LIBRARY_DIRECTORY_CONFLICT",
  });
  expect(notify).toHaveBeenCalledWith(
    "知产小栈Work无法启动",
    "检测到新旧专利库数据目录同时存在。\n旧目录：C:\\old\n新目录：C:\\new",
  );
  expect(quit).toHaveBeenCalledOnce();
});

test("explains how to preserve an unsupported legacy library without resetting it", async () => {
  const log = vi.fn().mockResolvedValue(true);
  const quit = vi.fn();
  const notify = vi.fn();

  await reportStartupFailure(
    { log } as unknown as SafeLogger,
    quit,
    notify,
    new LibraryRuntimePreparationError("unsupported-schema"),
  );

  expect(log).toHaveBeenCalledWith("error", {
    event: "app.start_failed",
    errorCode: "UNSUPPORTED_LIBRARY_SCHEMA",
  });
  expect(notify).toHaveBeenCalledWith(
    "知产小栈Work无法启动",
    "检测到不兼容的旧版本本地专利库。当前版本未修改或删除旧资料。请先使用此前能够打开该专利库的版本导出“完整数据包”，再在当前版本的“数据迁移”中导入；完成导出前，请勿删除或移动 Library 文件夹。",
  );
  expect(quit).toHaveBeenCalledOnce();
});
