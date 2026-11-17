import { OperationCoordinator } from "./operation-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("per-session operation isolation", () => {
  test("rejects an overlapping request instead of reusing another session payload result", async () => {
    const coordinator = new OperationCoordinator(() => "operation-1");
    const pending = deferred<string>();
    const firstRequest = { sessionId: "session-1", title: "第一份内容" };
    const secondRequest = { sessionId: "session-2", title: "第二份不同内容" };
    const firstWork = vi.fn(async ({ operationId }: { operationId: string }) => {
      expect(operationId).toBe("operation-1");
      expect(firstRequest.title).toBe("第一份内容");
      return pending.promise;
    });
    const secondWork = vi.fn(async () => secondRequest.title);

    const first = coordinator.run("document-1", "save", firstWork);
    const overlap = coordinator.run("document-1", "save", secondWork);
    await expect(overlap).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    expect(firstWork).toHaveBeenCalledTimes(1);
    expect(secondWork).not.toHaveBeenCalled();
    pending.resolve("saved");

    await expect(first).resolves.toBe("saved");
  });

  test("releases the slot in finally after failure", async () => {
    let sequence = 0;
    const coordinator = new OperationCoordinator(() => `operation-${++sequence}`);

    await expect(
      coordinator.run("document-1", "export-docx", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      coordinator.run("document-1", "export-docx", async ({ operationId }) => operationId),
    ).resolves.toBe("operation-2");
  });

  test("signals active operations when their document closes", async () => {
    const coordinator = new OperationCoordinator(() => "operation-1");
    const pending = deferred<void>();
    let signal: AbortSignal | undefined;
    const operation = coordinator.run("document-1", "draft-save", async (context) => {
      signal = context.signal;
      await pending.promise;
      return "finished";
    });

    expect(coordinator.cancelScope("document-1")).toBe(1);
    expect(signal?.aborted).toBe(true);
    pending.resolve();
    await expect(operation).resolves.toBe("finished");
  });

  test("waits for active work to settle before release cleanup continues", async () => {
    const coordinator = new OperationCoordinator(() => "operation-1");
    const pending = deferred<void>();
    let cleanupStarted = false;
    void coordinator.run("document-1", "export-pdf", async () => pending.promise);

    const release = coordinator.cancelAndWaitScope("document-1").then(() => {
      cleanupStarted = true;
    });
    await Promise.resolve();
    expect(cleanupStarted).toBe(false);

    pending.resolve();
    await release;
    expect(cleanupStarted).toBe(true);
  });

  test("rejects new operations from drain start until release cleanup finishes", async () => {
    const coordinator = new OperationCoordinator(() => "operation-1");
    const pending = deferred<void>();
    const active = coordinator.run("document-1", "export-pdf", async () => pending.promise);

    const draining = coordinator.cancelAndWaitScope("document-1");
    await expect(
      coordinator.run("document-1", "save", async () => "must-not-run"),
    ).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });

    pending.resolve();
    await active;
    await draining;
    await expect(
      coordinator.run("document-1", "print", async () => "must-not-run"),
    ).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });

    coordinator.finishScopeClose("document-1");
    await expect(coordinator.run("document-1", "save", async () => "new-session")).resolves.toBe(
      "new-session",
    );
  });
});
