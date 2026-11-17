// @vitest-environment node
import { backupFileError } from "./backup-errors.js";

test.each([
  ["ENOTDIR", "INVALID_INPUT", "不是文件夹", "重新选择"],
  ["EEXIST", "DESTINATION_UNAVAILABLE", "同名文件", "其他备份"],
  ["ENOENT", "NOT_FOUND", "不存在", "恢复"],
  ["EACCES", "NO_PERMISSION", "权限", "授权"],
  ["EPERM", "NO_PERMISSION", "权限", "授权"],
  ["EROFS", "NO_PERMISSION", "只读", "可写"],
  ["ENOSPC", "DISK_FULL", "空间不足", "释放"],
  ["EDQUOT", "DISK_FULL", "空间不足", "释放"],
  ["EIO", "DESTINATION_UNAVAILABLE", "读写失败", "连接"],
  ["ENODEV", "DESTINATION_UNAVAILABLE", "不可用", "连接"],
  ["EBUSY", "FILE_LOCKED", "占用", "关闭"],
])("describes %s without exposing raw paths", (code, expectedCode, text, action) => {
  const result = backupFileError(
    Object.assign(new Error(`${code}: native operation /private/path`), { code }),
  );
  expect(result).toMatchObject({ code: expectedCode });
  expect(result?.message).toContain(text);
  expect(result?.nextAction).toContain(action);
  expect(JSON.stringify(result)).not.toContain("/private/path");
});

test("leaves business and validation errors to their existing handlers", () => {
  expect(backupFileError(new Error("备份内容与文档不一致"))).toBeUndefined();
  expect(backupFileError({ code: "REVISION_CONFLICT" })).toBeUndefined();
});
