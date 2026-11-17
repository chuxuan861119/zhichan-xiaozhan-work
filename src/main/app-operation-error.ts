import type { AppError, AppErrorCode } from "../shared/ipc/result.js";
import { normalizeAppError } from "../shared/ipc/result.js";

export class AppOperationError extends Error {
  override readonly name = "AppOperationError";
  readonly code: AppErrorCode;

  constructor(error: AppError) {
    const normalized = normalizeAppError(error);
    super(normalized.message);
    this.code = normalized.code;
  }
}
