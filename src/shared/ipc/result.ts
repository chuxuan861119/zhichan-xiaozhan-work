import { z } from "zod";
import { CAD_IMPORT_LIMIT_MESSAGE } from "../drawing-markup/import-limits.js";
import { ExportIssueSchema } from "../exports/report.js";

export const AppErrorCodeSchema = z.enum([
  "CANCELLED",
  "OPERATION_IN_PROGRESS",
  "INVALID_INPUT",
  "TUTORIAL_RESTRICTED",
  "IMAGE_IMPORT_LIMIT",
  "CAD_IMPORT_TOO_LARGE",
  "CAD_RUNTIME_UNAVAILABLE",
  "CAD_OUTPUT_TOO_LARGE",
  "CAD_TILES_INVALID",
  "CAD_CONVERSION_FAILED",
  "CAD_CONVERSION_TIMEOUT",
  "DOCX_UNRECOGNIZED",
  "DOCX_DUPLICATE_BOOK",
  "NOT_FOUND",
  "NO_PERMISSION",
  "CLIPBOARD_PERMISSION_DENIED",
  "FILE_LOCKED",
  "DISK_FULL",
  "UNSUPPORTED_VERSION",
  "UNSAFE_OVERWRITE",
  "RECOVERY_REQUIRED",
  "RECOVERY_REPAIR_FAILED",
  "RECOVERY_CHAIN_BROKEN",
  "SNAPSHOT_RECOVERY_PROTECTED",
  "CORRUPT_FILE",
  "EXPORT_FAILED",
  "PATDOC_CAPACITY_LIMIT",
  "PATDOC_DOCUMENT_ONLY",
  "PATDOC_HISTORY_INCOMPLETE",
  "REVISION_CONFLICT",
  "LIBRARY_LOCKED",
  "LIBRARY_INITIALIZATION_FAILED",
  "READ_ONLY_RECOVERY",
  "INVALID_KETCHER_SVG",
  "UNSAFE_KETCHER_SVG",
  "CHEMICAL_PREVIEW_TOO_LARGE",
  "CHEMICAL_PREVIEW_FAILED",
  "LIBRARY_NOT_EMPTY",
  "PASSWORD_OR_PACKAGE_INVALID",
  "PACKAGE_TOO_NEW",
  "PACKAGE_INCOMPLETE",
  "PACKAGE_TAMPERED",
  "INSUFFICIENT_SPACE",
  "WINDOWS_KEY_PROTECTION_UNAVAILABLE",
  "SOURCE_SAVE_FAILED",
  "DESTINATION_UNAVAILABLE",
  "IMPORT_ROLLED_BACK",
  "IMPORT_RECOVERY_REQUIRED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
]);

export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

export const DataTransferOperationKindSchema = z.enum([
  "full-data-export",
  "full-data-import",
  "library-swap",
]);
export type DataTransferOperationKind = z.infer<typeof DataTransferOperationKindSchema>;

export const AppErrorSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string().min(1).max(500),
  nextAction: z.string().min(1).max(500).optional(),
  operationKind: DataTransferOperationKindSchema.optional(),
  outputPath: z.string().min(1).max(32767).optional(),
  issues: z.array(ExportIssueSchema).optional(),
});
export type AppError = z.infer<typeof AppErrorSchema>;

export const APP_ERROR_PRESENTATIONS: Record<
  AppErrorCode,
  Readonly<{ message: string; nextAction: string }>
> = {
  CANCELLED: { message: "操作已取消。", nextAction: "无需其他操作。" },
  PATDOC_DOCUMENT_ONLY: {
    message: "这是单文档 PATDOC，不是完整的五书专利文件；当前专利导入入口不支持此类型。",
    nextAction: "文件并未损坏。请在支持单文档的版本中打开，再通过 Word 文档导入当前版本。",
  },
  PATDOC_CAPACITY_LIMIT: {
    message: "文档或资源超过 PATDOC 归档安全容量，未生成或覆盖文件。",
    nextAction:
      "请减少图片及资源数量或大小。普通归档解压后总量最多 256 MiB，含分块图纸的专利最多 512 MiB。",
  },
  PATDOC_HISTORY_INCOMPLETE: {
    message: "存在损坏或缺少资源的快照，已取消完整导出。",
    nextAction: "请先在“快照版本”中检查相关快照；原专利及已有导出文件未被修改。",
  },
  OPERATION_IN_PROGRESS: {
    message: "此文档已有同类操作正在进行。",
    nextAction: "请等待当前操作完成后重试。",
  },
  INVALID_INPUT: { message: "输入内容无效。", nextAction: "请检查输入内容后重试。" },
  TUTORIAL_RESTRICTED: {
    message: "此操作在快速工具教程中不可用。",
    nextAction: "请退出教学，在正常工作窗口中操作正式专利。",
  },
  IMAGE_IMPORT_LIMIT: {
    message: "图片导入超出限制：单次最多 100 张、单张最多 50 MiB、总计最多 250 MiB。",
    nextAction: "请减少图片数量或文件大小后重试。",
  },
  CAD_IMPORT_TOO_LARGE: {
    message: CAD_IMPORT_LIMIT_MESSAGE,
    nextAction: "请在原 CAD 软件中拆分图纸后重试。原图纸和文档未被修改。",
  },
  CAD_RUNTIME_UNAVAILABLE: {
    message: "CAD 转换组件缺失、损坏或与当前系统架构不匹配，未导入图纸。",
    nextAction:
      "安装版请重新安装对应系统版本；开发实例请补齐并校验离线 CAD 组件后重试。原文档未被修改。",
  },
  CAD_TILES_INVALID: {
    message: "图纸分块资源缺失或损坏，未完成操作。",
    nextAction: "请从原 DWG 重新导入，或从备份恢复文档。",
  },
  CAD_CONVERSION_FAILED: {
    message: "图纸转换未完成。",
    nextAction: "请重试；若仍失败，请在原 CAD 软件中导出 PDF 后导入。",
  },
  CAD_CONVERSION_TIMEOUT: {
    message: "图纸转换等待时间过长，已停止本次导入。",
    nextAction: "请重试，或在原 CAD 软件中拆分所需附图后导入。",
  },
  CAD_OUTPUT_TOO_LARGE: {
    message: "图纸转换后的矢量内容超过显示容量，未导入。请在 CAD 中拆分图纸，或导出 PDF 后导入。",
    nextAction: "文件较小也可能包含过多图形数据，请拆分所需附图后重试。原图纸和文档未被修改。",
  },
  DOCX_UNRECOGNIZED: {
    message: "所选 Word 文档中存在无法识别的内容，不能导入。",
    nextAction: "请选择可识别的五书合一文档，或单项五书文档；多选时每份都必须能够识别。",
  },
  DOCX_DUPLICATE_BOOK: {
    message: "所选 Word 文档包含重复的五书类型，不能导入。",
    nextAction: "每类文档只保留一份，然后重新选择文件。",
  },
  NOT_FOUND: {
    message: "所需文件或资源不存在。",
    nextAction: "请确认它没有被移动或删除后重试。",
  },
  NO_PERMISSION: {
    message: "没有权限访问所选位置。",
    nextAction: "请选择有访问权限的位置后重试。",
  },
  CLIPBOARD_PERMISSION_DENIED: {
    message: "没有读取剪贴板的权限，粘贴未执行。",
    nextAction: "请在系统设置中允许本应用读取剪贴板，再重新粘贴。原文档未被修改。",
  },
  FILE_LOCKED: {
    message: "文件正被其他程序占用。",
    nextAction: "请关闭占用程序后重试，或使用另存为。",
  },
  DISK_FULL: {
    message: "磁盘空间不足。原文件没有被修改。",
    nextAction: "请释放空间后重试。",
  },
  UNSUPPORTED_VERSION: {
    message: "此文件由更新版本的软件创建。当前版本不会覆盖它。",
    nextAction: "请使用更新版本打开，或另存为其他文件。",
  },
  UNSAFE_OVERWRITE: {
    message: "无法确认目标文件可被安全覆盖，现有文件未被修改。",
    nextAction: "请保留现有文件，并选择新的文件名保存。",
  },
  RECOVERY_REQUIRED: {
    message: "保存未完成，原文件可能需要恢复。",
    nextAction: "如存在恢复副本，请勿删除；关闭占用目标文件的程序后重试，或联系技术支持。",
  },
  RECOVERY_REPAIR_FAILED: {
    message: "自动修复没有完成。该专利的原数据仍然保留，没有任何内容被改动。",
    nextAction:
      "请先查看该专利的快照版本；没有可用快照时，从定时备份恢复为新副本。原专利继续保留，其他专利不受影响。",
  },
  RECOVERY_CHAIN_BROKEN: {
    message: "该专利的编辑历史无法自证，但正文内容完好，没有被改动。",
    nextAction:
      "请在文档库中对该专利执行「修复并打开」：系统会先创建安全备份，再用现有正文重建恢复锚点，不会丢弃任何内容。",
  },
  SNAPSHOT_RECOVERY_PROTECTED: {
    message: "这是最后一个可恢复到当前内容的有效快照，不能删除。",
    nextAction: "完成后续修改并生成新的有效快照后，可再删除此版本。",
  },
  CORRUPT_FILE: {
    message: "文件内容损坏或不完整。",
    nextAction: "请尝试恢复备份，或重新选择有效文件。",
  },
  EXPORT_FAILED: {
    message: "导出未完成。原文档没有被修改。",
    nextAction: "请检查导出报告和目标位置后重试。",
  },
  REVISION_CONFLICT: {
    message: "文档修订与已保存版本不一致。",
    nextAction: "请重新打开文档并重试此操作。",
  },
  LIBRARY_LOCKED: {
    message: "文档库暂时无法写入。",
    nextAction: "请稍后重试；如果问题持续，请重新启动应用。",
  },
  LIBRARY_INITIALIZATION_FAILED: {
    message: "专利库尚未成功初始化，暂时无法读取。",
    nextAction: "请查看启动提示中的原因及处理方式，并保留原文档库目录。",
  },
  READ_ONLY_RECOVERY: {
    message: "文档库当前处于只读恢复模式。",
    nextAction: "请在文档恢复中选择快照或 PATDOC 备份，恢复到新库后再切换；原库保留。",
  },
  INVALID_KETCHER_SVG: {
    message: "化学结构 SVG 无效。",
    nextAction: "请重新编辑化学结构后重试。",
  },
  UNSAFE_KETCHER_SVG: {
    message: "化学结构 SVG 包含不安全内容。",
    nextAction: "请重新生成化学结构后重试。",
  },
  CHEMICAL_PREVIEW_TOO_LARGE: {
    message: "化学结构预览超出允许范围。",
    nextAction: "请缩小化学结构后重试。",
  },
  CHEMICAL_PREVIEW_FAILED: {
    message: "化学结构预览生成失败。",
    nextAction: "请重新编辑化学结构后重试。",
  },
  LIBRARY_NOT_EMPTY: {
    message: "当前文档库不是空库，无法导入完整数据。",
    nextAction: "请切换到空文档库后重新开始导入。",
  },
  PASSWORD_OR_PACKAGE_INVALID: {
    message: "密码不正确或所选数据包无效，无法继续导入。",
    nextAction: "请确认密码和数据包来源后重试。",
  },
  PACKAGE_TOO_NEW: {
    message: "数据包需要更新版本的应用才能导入。",
    nextAction: "请更新应用后重新选择该数据包。",
  },
  PACKAGE_INCOMPLETE: {
    message: "数据包不完整，导入已停止。",
    nextAction: "请重新获取完整的数据包后重试。",
  },
  PACKAGE_TAMPERED: {
    message: "数据包完整性验证失败，导入已停止。",
    nextAction: "请勿继续使用该数据包，并从可信来源重新获取。",
  },
  INSUFFICIENT_SPACE: {
    message: "可用磁盘空间不足，数据迁移未完成。",
    nextAction: "请释放足够空间后重新开始操作。",
  },
  WINDOWS_KEY_PROTECTION_UNAVAILABLE: {
    message: "当前 Windows 账户的密钥保护服务不可用。",
    nextAction: "请恢复账户保护服务后重新开始操作。",
  },
  SOURCE_SAVE_FAILED: {
    message: "源文档库未能完成安全保存，数据迁移已停止。",
    nextAction: "请先解决文档保存问题，再重新开始操作。",
  },
  DESTINATION_UNAVAILABLE: {
    message: "所选目标位置当前不可用，数据迁移未完成。",
    nextAction: "请恢复目标位置的访问权限，或选择其他可用位置。",
  },
  IMPORT_ROLLED_BACK: {
    message: "导入未完成，原文档库已恢复。",
    nextAction: "请根据提示解决问题后重新开始导入。",
  },
  IMPORT_RECOVERY_REQUIRED: {
    message: "导入未完成，文档库需要恢复处理。",
    nextAction: "请勿继续编辑或删除恢复数据，并按恢复指引处理。",
  },
  NOT_IMPLEMENTED: {
    message: "此功能尚未开放。",
    nextAction: "请使用当前已开放的功能。",
  },
  INTERNAL: {
    message: "本地操作失败。",
    nextAction: "请重试；如果问题持续，请重新启动应用。",
  },
};

export function normalizeAppError(error: AppError): AppError {
  const presentation = APP_ERROR_PRESENTATIONS[error.code];
  const operationKind = DataTransferOperationKindSchema.safeParse(error.operationKind);
  return {
    code: error.code,
    message: presentation.message,
    nextAction: presentation.nextAction,
    ...(operationKind.success ? { operationKind: operationKind.data } : {}),
    ...(error.outputPath ? { outputPath: error.outputPath } : {}),
    ...(error.issues ? { issues: error.issues } : {}),
  };
}

export type AppResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

export function appResultSchema<ValueSchema extends z.ZodType>(valueSchema: ValueSchema) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueSchema }),
    z.object({ ok: z.literal(false), error: AppErrorSchema }),
  ]);
}
