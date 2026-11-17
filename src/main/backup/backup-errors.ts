import type { AppError } from "../../shared/ipc/result.js";

/** Describe filesystem failures at the backup boundary; retain business errors elsewhere. */
export function backupFileError(error: unknown): AppError | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  switch (error.code) {
    case "ENOTDIR":
      return {
        code: "INVALID_INPUT",
        message: "备份路径中的某一位置不是文件夹。",
        nextAction: "请重新选择有效的备份文件夹。",
      };
    case "EEXIST":
      return {
        code: "DESTINATION_UNAVAILABLE",
        message: "备份位置被同名文件占用，无法创建文件夹或备份文件。",
        nextAction: "请选择其他备份位置，或检查该位置的同名文件。",
      };
    case "ENOENT":
      return {
        code: "NOT_FOUND",
        message: "备份所需的文件或目录已不存在。",
        nextAction: "请恢复原位置或设备连接，或重新选择备份文件夹后重试。",
      };
    case "EACCES":
    case "EPERM":
      return {
        code: "NO_PERMISSION",
        message: "没有权限读写备份位置。",
        nextAction: "请重新选择并授权备份文件夹，或更换有访问权限的位置。",
      };
    case "EROFS":
      return {
        code: "NO_PERMISSION",
        message: "备份位置为只读，无法写入。",
        nextAction: "请选择可写的备份文件夹或磁盘后重试。",
      };
    case "ENOSPC":
    case "EDQUOT":
      return {
        code: "DISK_FULL",
        message: "备份位置空间不足或存储配额已用完。",
        nextAction: "请释放存储空间，或更换有足够空间的备份位置。",
      };
    case "EIO":
    case "ENODEV":
    case "ENXIO":
    case "ESTALE":
    case "ENOTCONN":
      return {
        code: "DESTINATION_UNAVAILABLE",
        message: "备份存储设备不可用或读写失败。",
        nextAction: "请检查磁盘或外接设备连接，恢复后重试，或更换备份位置。",
      };
    case "EBUSY":
    case "ETXTBSY":
      return {
        code: "FILE_LOCKED",
        message: "备份位置或文件正在被其他程序占用。",
        nextAction: "请关闭占用它的程序后重试，或选择其他备份位置。",
      };
    default:
      return undefined;
  }
}
