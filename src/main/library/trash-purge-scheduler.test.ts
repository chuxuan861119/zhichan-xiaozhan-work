import { TrashPurgeScheduler } from "./trash-purge-scheduler.js";

test("finishes the current purge before closing its resource cleanup service", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const maintenance = {
    start: vi.fn(),
    dispose: vi.fn(),
    suspend: async () => async () => undefined,
    close: async () => {
      events.push("cleanup-closed");
    },
  };
  const scheduler = new TrashPurgeScheduler(
    {
      purgeExpired: async () => {
        await pending;
        events.push("purge-cleanup-complete");
      },
    },
    { setInterval: () => 1, clearInterval: vi.fn() },
    maintenance,
  );
  scheduler.start();
  const closing = scheduler.close();
  expect(events).toEqual([]);
  release?.();
  await closing;
  expect(events).toEqual(["purge-cleanup-complete", "cleanup-closed"]);
});

test("never restarts timers when transfer release races with shutdown", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timerApi = { setInterval: vi.fn(() => 1), clearInterval: vi.fn() };
  const maintenance = {
    start: vi.fn(),
    dispose: vi.fn(),
    close: async () => undefined,
    suspend: async () => () => pending,
  };
  const scheduler = new TrashPurgeScheduler(
    { purgeExpired: async () => undefined },
    timerApi,
    maintenance,
  );
  scheduler.start();
  const resume = await scheduler.suspend();
  const resuming = resume();
  await scheduler.close();
  release?.();
  await resuming;
  expect(timerApi.setInterval).toHaveBeenCalledOnce();
});

test("suspends resource maintenance with the transfer barrier and waits for it on every close", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = vi.fn(async () => undefined);
  const maintenance = {
    start: vi.fn(),
    dispose: vi.fn(),
    suspend: vi.fn(async () => resume),
    close: vi.fn(() => pending),
  };
  const scheduler = new TrashPurgeScheduler(
    { purgeExpired: async () => undefined },
    { setInterval: () => 1, clearInterval: vi.fn() },
    maintenance,
  );
  scheduler.start();
  expect(maintenance.start).toHaveBeenCalledOnce();
  const resumeAll = await scheduler.suspend();
  expect(maintenance.suspend).toHaveBeenCalledOnce();
  await resumeAll();
  expect(resume).toHaveBeenCalledOnce();
  const first = scheduler.close();
  let secondClosed = false;
  const second = scheduler.close().then(() => {
    secondClosed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(secondClosed).toBe(false);
  release?.();
  await Promise.all([first, second]);
  expect(maintenance.close).toHaveBeenCalledOnce();
});

test("purges once at startup and then every twenty-four hours", async () => {
  const intervals: Array<{ callback: () => void; milliseconds: number }> = [];
  const library = { purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })) };
  const scheduler = new TrashPurgeScheduler(library, {
    setInterval: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    clearInterval: vi.fn(),
  });

  scheduler.start();
  await vi.waitFor(() => expect(library.purgeExpired).toHaveBeenCalledTimes(1));
  expect(intervals).toEqual([
    { callback: expect.any(Function), milliseconds: 24 * 60 * 60 * 1000 },
  ]);

  intervals[0]?.callback();
  await vi.waitFor(() => expect(library.purgeExpired).toHaveBeenCalledTimes(2));
});

test("serializes overlapping purge runs and stops the interval on disposal", async () => {
  let releaseFirst: (() => void) | undefined;
  const clearInterval = vi.fn();
  const intervals: Array<{ callback: () => void; milliseconds: number }> = [];
  const library = {
    purgeExpired: vi.fn(
      () =>
        new Promise<{ purgedPatentIds: string[] }>((resolve) => {
          releaseFirst = () => resolve({ purgedPatentIds: [] });
        }),
    ),
  };
  const scheduler = new TrashPurgeScheduler(library, {
    setInterval: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return "timer-1";
    },
    clearInterval,
  });

  scheduler.start();
  intervals[0]?.callback();
  intervals[0]?.callback();
  expect(library.purgeExpired).toHaveBeenCalledTimes(1);
  releaseFirst?.();
  await vi.waitFor(() => expect(library.purgeExpired).toHaveBeenCalledTimes(2));

  scheduler.dispose();
  expect(clearInterval).toHaveBeenCalledWith("timer-1");
});

test("suspends before waiting for the current purge and resumes without an immediate duplicate", async () => {
  let releasePurge: (() => void) | undefined;
  let signalPurgeStarted: (() => void) | undefined;
  const purgePending = new Promise<void>((resolve) => {
    releasePurge = resolve;
  });
  const purgeStarted = new Promise<void>((resolve) => {
    signalPurgeStarted = resolve;
  });
  const callbacks: Array<() => void> = [];
  const clearInterval = vi.fn();
  const library = {
    purgeExpired: vi.fn(async () => {
      signalPurgeStarted?.();
      await purgePending;
      return { purgedPatentIds: [] };
    }),
  };
  const scheduler = new TrashPurgeScheduler(library, {
    setInterval: (callback) => {
      callbacks.push(callback);
      return `timer-${callbacks.length}`;
    },
    clearInterval,
  });
  scheduler.start();
  await purgeStarted;

  let suspended = false;
  const suspension = scheduler.suspend().then((resume) => {
    suspended = true;
    return resume;
  });
  callbacks[0]?.();
  await Promise.resolve();
  expect(clearInterval).toHaveBeenCalledWith("timer-1");
  expect(library.purgeExpired).toHaveBeenCalledOnce();
  expect(suspended).toBe(false);

  releasePurge?.();
  const resume = await suspension;
  await Promise.all([resume(), resume()]);
  expect(callbacks).toHaveLength(2);
  expect(library.purgeExpired).toHaveBeenCalledOnce();

  callbacks[1]?.();
  await vi.waitFor(() => expect(library.purgeExpired).toHaveBeenCalledTimes(2));
  scheduler.dispose();
});

test("keeps a stopped scheduler stopped across suspend and resume", async () => {
  const setInterval = vi.fn(() => "timer");
  const scheduler = new TrashPurgeScheduler(
    { purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })) },
    { setInterval, clearInterval: vi.fn() },
  );

  const resume = await scheduler.suspend();
  await resume();
  expect(setInterval).not.toHaveBeenCalled();
});

test("restores scheduling when the purge observed by suspend rejects", async () => {
  let rejectPurge: ((error: Error) => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise<void>((_resolve, reject) => {
    rejectPurge = reject;
  });
  const intervals: Array<() => void> = [];
  const scheduler = new TrashPurgeScheduler(
    {
      purgeExpired: vi.fn(async () => {
        signalStarted?.();
        await pending;
      }),
    },
    {
      setInterval: (callback) => {
        intervals.push(callback);
        return intervals.length;
      },
      clearInterval: vi.fn(),
    },
  );
  scheduler.start();
  await started;

  const failure = new Error("purge failed");
  const suspension = scheduler.suspend();
  rejectPurge?.(failure);
  await expect(suspension).rejects.toBe(failure);
  expect(intervals).toHaveLength(2);
  scheduler.dispose();
});

test("close is idempotent and waits for an in-flight purge without scheduling another", async () => {
  let releasePurge: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    releasePurge = resolve;
  });
  const clearInterval = vi.fn();
  const library = {
    purgeExpired: vi.fn(async () => {
      signalStarted?.();
      await pending;
    }),
  };
  const scheduler = new TrashPurgeScheduler(library, {
    setInterval: () => "timer",
    clearInterval,
  });
  scheduler.start();
  await started;

  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  releasePurge?.();
  await closing;
  await scheduler.close();

  expect(clearInterval).toHaveBeenCalledOnce();
  expect(library.purgeExpired).toHaveBeenCalledOnce();
});
