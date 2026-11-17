import { type SnapshotSettings, SnapshotStatusSchema } from "../../shared/snapshot/model.js";
import { SnapshotTimer } from "./snapshot-timer.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const START = new Date("2026-08-16T00:00:00.000Z");

function created(revision: number) {
  return {
    outcome: "created" as const,
    revision,
    createdAt: new Date().toISOString(),
    source: "automatic" as const,
  };
}

function alreadyExists(revision: number) {
  return {
    outcome: "already-exists" as const,
    revision,
    createdAt: "2026-08-15T12:00:00.000Z",
    source: "manual-save" as const,
  };
}

function setup(options?: {
  openPatentIds?: string[];
  enabled?: boolean;
  intervalMinutes?: 3 | 5 | 10 | 15 | 30 | 60;
  readSettings?: () => Promise<{ snapshot: SnapshotSettings }>;
}) {
  const openPatentIds = options?.openPatentIds ?? [];
  const create = vi.fn(
    async (
      _patentId: string,
      _source: "automatic",
    ): Promise<ReturnType<typeof created> | ReturnType<typeof alreadyExists>> => created(1),
  );
  const pruneAll = vi.fn(async () => ({ deletedCount: 0, cleanupError: null as string | null }));
  const lastAutomaticSnapshotAt = vi.fn(() => null as string | null);
  const settings = {
    enabled: options?.enabled ?? true,
    intervalMinutes: options?.intervalMinutes ?? 5,
  };
  const timer = new SnapshotTimer({
    snapshots: { create, pruneAll, lastAutomaticSnapshotAt },
    listOpenPatentIds: () => openPatentIds,
    readSettings: options?.readSettings ?? (async () => ({ snapshot: settings })),
  });
  return { timer, openPatentIds, create, pruneAll, lastAutomaticSnapshotAt, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

test("prepares recovery data even with automatic history disabled and stops when shut down", async () => {
  const prepareClose = vi.fn(async () => {});
  const create = vi.fn();
  const timer = new SnapshotTimer({
    snapshots: {
      prepareClose,
      create,
      pruneAll: async () => ({ deletedCount: 0, cleanupError: null }),
      lastAutomaticSnapshotAt: () => null,
    },
    listOpenPatentIds: () => ["a", "a", "b"],
    readSettings: async () => ({ snapshot: { enabled: false, intervalMinutes: 5 } }),
  });
  timer.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(prepareClose.mock.calls).toEqual([["a"], ["b"]]);
  expect(create).not.toHaveBeenCalled();
  await timer.shutdown();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(prepareClose).toHaveBeenCalledTimes(2);
});

test("reports a paused retention run instead of clearing its warning", async () => {
  const { timer, pruneAll } = setup();
  pruneAll.mockResolvedValue({ deletedCount: 0, cleanupError: "快照损坏，已暂停自动整理" });
  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(timer.status().lastError).toContain("已暂停自动整理");
  pruneAll.mockResolvedValue({ deletedCount: 0, cleanupError: null });
  await vi.advanceTimersByTimeAsync(DAY_MS);
  expect(timer.status().lastError).toBeNull();
  await timer.shutdown();
});

test("long maintenance errors remain readable through the status IPC contract", async () => {
  const { timer, pruneAll } = setup();
  pruneAll.mockResolvedValue({ deletedCount: 0, cleanupError: "资源整理失败；".repeat(400) });
  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    SnapshotStatusSchema.safeParse({
      ...timer.status(),
      enabled: true,
      intervalMinutes: 5,
      openPatentCount: 0,
    }).success,
  ).toBe(true);
  expect(timer.status().lastError).toContain("资源整理失败");
  await timer.shutdown();
});

test("start keeps the automatic clock idle when no patent session is open", async () => {
  const { timer, pruneAll } = setup();

  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  expect(pruneAll).toHaveBeenCalledOnce();
  expect(timer.status()).toMatchObject({
    lastCheckAt: null,
    nextCheckAt: null,
    lastAutomaticSnapshotAt: null,
    lastError: null,
  });
  expect(vi.getTimerCount()).toBe(1);
  await timer.shutdown();
});

test("a stale settings read cannot overwrite a newer automatic clock configuration", async () => {
  let resolveOld: ((value: { snapshot: SnapshotSettings }) => void) | undefined;
  const readSettings = vi
    .fn<() => Promise<{ snapshot: SnapshotSettings }>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ snapshot: { enabled: true, intervalMinutes: 3 } })
    .mockRejectedValue(new Error("设置暂时无法读取"));
  const { timer, create } = setup({ openPatentIds: ["patent-a"], readSettings });
  timer.start();
  await timer.restartAutomaticClock();
  resolveOld?.({ snapshot: { enabled: false, intervalMinutes: 60 } });
  await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();
  expect(timer.status().nextCheckAt).toBe("2026-08-16T00:06:00.000Z");
  await timer.shutdown();
});

test("a stale settings failure cannot replace the current successful settings status", async () => {
  let rejectOld: ((error: Error) => void) | undefined;
  const readSettings = vi
    .fn<() => Promise<{ snapshot: SnapshotSettings }>>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockResolvedValue({ snapshot: { enabled: true, intervalMinutes: 3 } });
  const { timer } = setup({ openPatentIds: ["patent-a"], readSettings });
  timer.start();
  await timer.restartAutomaticClock();
  rejectOld?.(new Error("旧请求失败"));
  await vi.advanceTimersByTimeAsync(0);
  expect(timer.status().lastError).toBeNull();
  await timer.shutdown();
});

test("restarting the clock during creation cannot start an overlapping automatic batch", async () => {
  let finishCreation: (() => void) | undefined;
  const { timer, create } = setup({ openPatentIds: ["patent-a"] });
  create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCreation = () => resolve(created(1));
      }),
  );
  timer.start();
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  await timer.restartAutomaticClock();
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();
  finishCreation?.();
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledTimes(2);
  await timer.shutdown();
});

test("the first open patent starts one automatic clock and later opens do not reset it", async () => {
  const { timer, openPatentIds } = setup();
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  openPatentIds.push("patent-a");
  await timer.openPatentSessionsChanged();
  await vi.advanceTimersByTimeAsync(0);
  const firstNextCheckAt = timer.status().nextCheckAt;

  await vi.advanceTimersByTimeAsync(MINUTE_MS);
  openPatentIds.push("patent-b");
  await timer.openPatentSessionsChanged();
  await vi.advanceTimersByTimeAsync(0);

  expect(timer.status().nextCheckAt).toBe(firstNextCheckAt);
  expect(vi.getTimerCount()).toBe(2);
  await timer.shutdown();
});

test("each tick retries failed settings reads and adopts the recovered cadence", async () => {
  const readSettings = vi
    .fn<() => Promise<{ snapshot: SnapshotSettings }>>()
    .mockRejectedValueOnce(new Error("设置文件无法读取"))
    .mockResolvedValueOnce({ snapshot: { enabled: true, intervalMinutes: 3 } })
    .mockRejectedValueOnce(new Error("设置文件再次无法读取"));
  const { timer, create } = setup({ openPatentIds: ["patent-a"], readSettings });

  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(timer.status()).toMatchObject({
    lastError: "设置文件无法读取",
    nextCheckAt: "2026-08-16T00:05:00.000Z",
  });

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledTimes(1);
  expect(timer.status()).toMatchObject({
    lastError: null,
    nextCheckAt: "2026-08-16T00:08:00.000Z",
  });

  await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
  expect(create).toHaveBeenCalledTimes(2);
  expect(timer.status()).toMatchObject({
    lastError: "设置文件再次无法读取",
    nextCheckAt: "2026-08-16T00:11:00.000Z",
  });
  expect(readSettings).toHaveBeenCalledTimes(3);
  await timer.shutdown();
});

test("an automatic tick creates one snapshot for each unique open patent", async () => {
  const { timer, create } = setup({ openPatentIds: ["patent-a", "patent-a", "patent-b"] });
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

  expect(create.mock.calls).toEqual([
    ["patent-a", "automatic"],
    ["patent-b", "automatic"],
  ]);
  expect(timer.status().lastCheckAt).toBe("2026-08-16T00:05:00.000Z");
  await timer.shutdown();
});

test("already-existing revisions are normal skips and do not invent a success timestamp", async () => {
  const { timer, create, lastAutomaticSnapshotAt } = setup({ openPatentIds: ["patent-a"] });
  create.mockResolvedValueOnce(alreadyExists(4));
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

  expect(timer.status()).toMatchObject({
    lastAutomaticSnapshotAt: null,
    lastError: null,
  });
  expect(lastAutomaticSnapshotAt).toHaveBeenCalled();
  await timer.shutdown();
});

test("closing sessions changes future membership and closing the last patent cancels the clock", async () => {
  const { timer, openPatentIds, create } = setup({ openPatentIds: ["patent-a", "patent-b"] });
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  openPatentIds.splice(openPatentIds.indexOf("patent-a"), 1);
  await timer.openPatentSessionsChanged();
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith("patent-b", "automatic");

  openPatentIds.length = 0;
  await timer.openPatentSessionsChanged();
  expect(timer.status().nextCheckAt).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await timer.shutdown();
});

test("disabled settings cancel automatic checks and a successful restart starts a fresh interval", async () => {
  const { timer, create, settings } = setup({ openPatentIds: ["patent-a"] });
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(MINUTE_MS);
  settings.enabled = false;
  await timer.restartAutomaticClock();
  await vi.advanceTimersByTimeAsync(0);
  expect(timer.status().nextCheckAt).toBeNull();

  await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
  expect(create).not.toHaveBeenCalled();

  settings.enabled = true;
  await timer.restartAutomaticClock();
  await vi.advanceTimersByTimeAsync(0);
  expect(timer.status().nextCheckAt).toBe("2026-08-16T00:16:00.000Z");
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();
  await timer.shutdown();
});

test("startup and daily maintenance run without open patents", async () => {
  const { timer, pruneAll } = setup();
  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(pruneAll).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(DAY_MS);

  expect(pruneAll).toHaveBeenCalledTimes(2);
  await timer.shutdown();
});

test("maintenance suppresses snapshot creation and its failure does not stop scheduling", async () => {
  let finishMaintenance: (() => void) | undefined;
  const { timer, pruneAll, create } = setup({ openPatentIds: ["patent-a"] });
  pruneAll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishMaintenance = () => resolve({ deletedCount: 0, cleanupError: null });
      }),
  );
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).not.toHaveBeenCalled();
  finishMaintenance?.();
  await vi.advanceTimersByTimeAsync(0);

  pruneAll.mockRejectedValueOnce(new Error("maintenance failed"));
  await vi.advanceTimersByTimeAsync(DAY_MS - 5 * MINUTE_MS);
  expect(timer.status().lastError).toBe("maintenance failed");
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalled();
  await timer.shutdown();
});

test("daily maintenance waits for an in-flight automatic creation", async () => {
  let finishCreation: (() => void) | undefined;
  const { timer, create, pruneAll } = setup({
    openPatentIds: ["patent-a"],
    intervalMinutes: 60,
  });
  create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCreation = () => resolve(created(3));
      }),
  );
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(DAY_MS - 60 * MINUTE_MS);
  expect(pruneAll).toHaveBeenCalledOnce();

  finishCreation?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(pruneAll).toHaveBeenCalledTimes(2);
  await timer.shutdown();
});

test("one patent failure is isolated from the remaining open patents", async () => {
  const { timer, create } = setup({ openPatentIds: ["patent-a", "patent-b"] });
  create.mockRejectedValueOnce(new Error("patent-a failed")).mockResolvedValueOnce(created(2));
  timer.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

  expect(create).toHaveBeenCalledTimes(2);
  expect(timer.status().lastError).toBe("patent-a failed");
  await timer.shutdown();
});

test("shutdown clears both clocks and waits for in-flight creation", async () => {
  let finishCreation: (() => void) | undefined;
  const { timer, create } = setup({ openPatentIds: ["patent-a"] });
  create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCreation = () => resolve(created(3));
      }),
  );
  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

  let shutdownFinished = false;
  const shutdown = timer.shutdown().then(() => {
    shutdownFinished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(shutdownFinished).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  finishCreation?.();
  await shutdown;
  expect(shutdownFinished).toBe(true);
});

test("suspend waits for in-flight snapshot work and resumes exactly one timer chain", async () => {
  let finishCreation: (() => void) | undefined;
  const { timer, create } = setup({ openPatentIds: ["patent-a"] });
  create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCreation = () => resolve(created(3));
      }),
  );
  timer.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();

  let suspensionFinished = false;
  const suspension = timer.suspend().then((resume) => {
    suspensionFinished = true;
    return resume;
  });
  await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
  expect(create).toHaveBeenCalledOnce();
  expect(suspensionFinished).toBe(false);

  finishCreation?.();
  const resume = await suspension;
  await Promise.all([resume(), resume()]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  expect(create).toHaveBeenCalledTimes(2);
  await timer.shutdown();
});

test("suspending and releasing a never-started timer keeps it stopped", async () => {
  const { timer, create } = setup({ openPatentIds: ["patent-a"] });

  const resume = await timer.suspend();
  await resume();
  await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

  expect(create).not.toHaveBeenCalled();
  await timer.shutdown();
});
