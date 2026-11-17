export const STRUCTURE_OPERATION_TIMEOUT_MS = 30_000;

export class StructureTimeoutError extends Error {
  constructor() {
    super("结构式操作超时，请重试。画布未被清除。");
    this.name = "StructureTimeoutError";
  }
}

/** Stop awaiting an unresponsive worker/IPC; late results never reach the caller. */
export async function withStructureTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StructureTimeoutError()),
          STRUCTURE_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
