import { freemem, totalmem } from "node:os";

export class EditorResourceAdmissionError extends Error {
  readonly code = "EDITOR_RESOURCE_LIMIT";
  constructor() {
    super("当前可用内存不足以开始本次图片处理，未改变原图和已有编辑内容。请稍后重试。");
  }
}
/** Shared in the main process; reservations are conservative estimates, not RSS limits. */
export class EditorOperationPool {
  private reserved = 0;
  constructor(
    private readonly memory = () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
    private readonly policy = { limitBytes: 4 * 1024 ** 3, spareBytes: 512 * 1024 ** 2 },
  ) {
    if (
      !Number.isSafeInteger(policy.limitBytes) ||
      policy.limitBytes <= 0 ||
      !Number.isSafeInteger(policy.spareBytes) ||
      policy.spareBytes < 0
    )
      throw new Error("Invalid editor admission policy");
    this.policy = { ...policy };
  }
  get reservedBytes(): number {
    return this.reserved;
  }
  get availableBytes(): number {
    const memory = this.memory();
    if (
      !Number.isSafeInteger(memory.totalBytes) ||
      memory.totalBytes <= 0 ||
      !Number.isSafeInteger(memory.freeBytes) ||
      memory.freeBytes < 0 ||
      memory.freeBytes > memory.totalBytes
    )
      throw new EditorResourceAdmissionError();
    const limit = Math.min(this.policy.limitBytes, Math.floor(memory.totalBytes / 2));
    const available =
      memory.freeBytes - Math.min(this.policy.spareBytes, Math.floor(memory.totalBytes / 8));
    return Math.max(0, Math.floor(Math.min(limit, available) - this.reserved));
  }
  reserve(estimatedBytes: number): () => void {
    if (
      !Number.isSafeInteger(estimatedBytes) ||
      estimatedBytes < 0 ||
      estimatedBytes > this.availableBytes
    )
      throw new EditorResourceAdmissionError();
    this.reserved += estimatedBytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.reserved -= estimatedBytes;
      }
    };
  }
}

export const editorOperationPool = new EditorOperationPool();
