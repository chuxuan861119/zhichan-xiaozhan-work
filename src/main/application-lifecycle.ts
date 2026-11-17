type ApplicationLifecycle = {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
  exit(code?: number): void;
};

/** Drain every task before propagating failures; a rejected sibling must not cut off file writes. */
export async function settleShutdownTasks(tasks: (() => void | Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "应用退出清理未完整完成。");
}

export function installLibraryServiceShutdown(
  application: ApplicationLifecycle,
  closeLibraryServices: () => void | Promise<void>,
  reportFailure: (error: unknown) => void | Promise<void> = () => {
    console.error("应用退出清理失败，下次启动需要恢复检查。");
  },
): void {
  let closed = false;
  let closing = false;
  application.on("will-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    let exitCode = 0;
    let closeResult: Promise<void>;
    try {
      closeResult = Promise.resolve(closeLibraryServices());
    } catch (error) {
      closeResult = Promise.reject(error);
    }
    void closeResult
      .catch(async (error: unknown) => {
        exitCode = 1;
        try {
          await reportFailure(error);
        } catch {
          console.error("退出失败提示未能完成，下次启动需要恢复检查。");
        }
      })
      .finally(() => {
        closed = true;
        application.exit(exitCode);
      });
  });
}
