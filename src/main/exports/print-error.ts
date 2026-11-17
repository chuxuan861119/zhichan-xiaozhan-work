import type { AppResult } from "../../shared/ipc/result.js";

export class PrintCancelledError extends Error {
  override readonly name = "PrintCancelledError";

  constructor() {
    super("打印已取消。");
  }
}

export class PrintPreviewUnavailableError extends Error {
  override readonly name = "PrintPreviewUnavailableError";

  constructor() {
    super("打印预览已失效，请重新生成预览。");
  }
}

export class PrintPrinterUnavailableError extends Error {
  override readonly name = "PrintPrinterUnavailableError";

  constructor(deviceName: string) {
    super(`打印机不可用：${deviceName}`);
  }
}

export class PrintDriverSettingsError extends Error {
  override readonly name = "PrintDriverSettingsError";

  constructor(reason: string) {
    super(`打印机拒绝了当前设置：${reason || "Invalid printer settings"}`);
  }
}

export class PrintTimeoutError extends Error {
  override readonly name = "PrintTimeoutError";
}

export function mapPrintError(error: unknown): AppResult<never> | null {
  if (error instanceof PrintTimeoutError) {
    return { ok: false, error: { code: "INTERNAL", message: error.message } };
  }
  if (error instanceof PrintCancelledError) {
    return { ok: false, error: { code: "CANCELLED", message: error.message } };
  }
  if (
    error instanceof PrintPreviewUnavailableError ||
    error instanceof PrintPrinterUnavailableError
  ) {
    return { ok: false, error: { code: "NOT_FOUND", message: error.message } };
  }
  if (error instanceof PrintDriverSettingsError) {
    return { ok: false, error: { code: "INVALID_INPUT", message: error.message } };
  }

  return null;
}
