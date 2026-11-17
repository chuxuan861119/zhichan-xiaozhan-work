import { DataTransferOperationGate } from "./data-transfer-operation-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("blocks new mutations, drains active work, and releases in finally", async () => {
  const gate = new DataTransferOperationGate();
  const first = deferred();
  const active = gate.runMutation("patents:apply-book-edit", () => first.promise);
  const exclusive = gate.runExclusive("full-data-export", async () => "exported");

  await expect(gate.runMutation("patents:create", async () => undefined)).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
    operationKind: "full-data-export",
    channel: "patents:create",
  });
  first.resolve();
  await expect(active).resolves.toBeUndefined();
  await expect(exclusive).resolves.toBe("exported");
  await expect(gate.runMutation("patents:create", async () => "ok")).resolves.toBe("ok");
});

test("reserves synchronously so a second exclusive task and later writes cannot race in", async () => {
  const gate = new DataTransferOperationGate();
  const activeWork = deferred();
  const exclusiveStarted = vi.fn();
  const active = gate.runMutation("drafts:save", () => activeWork.promise);
  const exclusive = gate.runExclusive("full-data-import", async () => {
    exclusiveStarted();
  });

  const secondExclusive = gate.runExclusive("library-swap", async () => undefined);
  const laterMutation = gate.runMutation("documents:save", async () => undefined);

  await expect(secondExclusive).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
    operationKind: "full-data-import",
  });
  await expect(laterMutation).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
    operationKind: "full-data-import",
  });
  expect(exclusiveStarted).not.toHaveBeenCalled();

  activeWork.resolve();
  await active;
  await exclusive;
  expect(exclusiveStarted).toHaveBeenCalledOnce();
});

test("releases active mutations after synchronous throws and asynchronous rejection", async () => {
  const gate = new DataTransferOperationGate();
  const synchronousFailure = new Error("safe synchronous failure");
  const asynchronousFailure = new Error("safe asynchronous failure");

  await expect(
    gate.runMutation("assets:import-bytes", () => {
      throw synchronousFailure;
    }),
  ).rejects.toBe(synchronousFailure);
  await expect(
    gate.runMutation("drafts:save", async () => {
      throw asynchronousFailure;
    }),
  ).rejects.toBe(asynchronousFailure);

  await expect(gate.runExclusive("full-data-export", async () => "drained")).resolves.toBe(
    "drained",
  );
});

test("waits for a rejected active mutation and then runs the reserved exclusive task", async () => {
  const gate = new DataTransferOperationGate();
  const activeWork = deferred();
  const started = deferred();
  const active = gate.runMutation("flowcharts:save", () => activeWork.promise);
  const exclusive = gate.runExclusive("full-data-export", async () => {
    started.resolve();
    return "complete";
  });

  activeWork.reject(new Error("safe active failure"));
  await expect(active).rejects.toThrow("safe active failure");
  await started.promise;
  await expect(exclusive).resolves.toBe("complete");
});

test("releases the reservation when an exclusive task rejects", async () => {
  const gate = new DataTransferOperationGate();
  const failure = new Error("safe exclusive failure");

  await expect(
    gate.runExclusive("library-swap", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(gate.runMutation("library:create", async () => "available")).resolves.toBe(
    "available",
  );
});

test("cancels while waiting, releases the reservation once, and does not leak task data", async () => {
  const gate = new DataTransferOperationGate();
  const activeWork = deferred();
  const active = gate.runMutation("library:apply-edit", () => activeWork.promise);
  const controller = new AbortController();
  const task = vi.fn(async () => undefined);
  const exclusive = gate.runExclusive("full-data-import", task, controller.signal);

  controller.abort();
  await expect(exclusive).rejects.toMatchObject({
    code: "CANCELLED",
    operationKind: "full-data-import",
  });
  expect(task).not.toHaveBeenCalled();
  await expect(gate.runMutation("settings:update", async () => "available")).resolves.toBe(
    "available",
  );

  activeWork.resolve();
  await active;
  await expect(gate.runExclusive("library-swap", async () => "released")).resolves.toBe("released");
  expect(JSON.stringify(await exclusive.catch((error: unknown) => error))).not.toContain(
    "client-name",
  );
});

test("reports cancellation while running and holds the reservation until the task settles", async () => {
  const gate = new DataTransferOperationGate();
  const controller = new AbortController();
  const taskStarted = deferred();
  const taskFinished = deferred();
  const exclusive = gate.runExclusive(
    "full-data-export",
    async () => {
      taskStarted.resolve();
      await taskFinished.promise;
      return "ignored";
    },
    controller.signal,
  );

  await taskStarted.promise;
  controller.abort();
  const blocked = gate.runMutation("snapshot:restore", async () => undefined);
  await expect(blocked).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });

  taskFinished.resolve();
  await expect(exclusive).rejects.toMatchObject({
    code: "CANCELLED",
    operationKind: "full-data-export",
  });
  await expect(gate.runMutation("snapshot:restore", async () => "available")).resolves.toBe(
    "available",
  );
});

test("handles pre-cancelled signals and hostile thenables without double release", async () => {
  const gate = new DataTransferOperationGate();
  const controller = new AbortController();
  controller.abort();
  const task = vi.fn(async () => undefined);

  await expect(
    gate.runExclusive("full-data-export", task, controller.signal),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(task).not.toHaveBeenCalled();

  const thenable = {
    // biome-ignore lint/suspicious/noThenProperty: this regression test exercises Promise thenable assimilation.
    then(resolve: (value: string) => void, reject: (error: Error) => void) {
      resolve("first");
      reject(new Error("ignored"));
      resolve("second");
    },
  };
  await expect(
    gate.runMutation("flowcharts:save", () => thenable as PromiseLike<string>),
  ).resolves.toBe("first");
  await expect(gate.runExclusive("library-swap", async () => "released")).resolves.toBe("released");
});

test("gate errors contain only enumerated operation and channel identifiers", async () => {
  const gate = new DataTransferOperationGate();
  const hold = deferred();
  const started = deferred();
  const exclusive = gate.runExclusive("full-data-export", async () => {
    started.resolve();
    await hold.promise;
  });
  await started.promise;

  const error = await gate
    .runMutation("patents:import-patdoc", async () => "D:\\clients\\secret-name.patdoc")
    .catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    code: "OPERATION_IN_PROGRESS",
    operationKind: "full-data-export",
    channel: "patents:import-patdoc",
  });
  expect(JSON.stringify(error)).not.toMatch(/clients|secret-name/iu);

  hold.resolve();
  await exclusive;
});
