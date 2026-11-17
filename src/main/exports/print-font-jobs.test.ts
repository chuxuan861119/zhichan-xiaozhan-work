import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workers: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    events: Map<string, (...args: unknown[]) => void>;
  }>,
}));
vi.mock("node:worker_threads", () => {
  const Worker = vi.fn(
    class {
      events = new Map<string, (...args: unknown[]) => void>();
      on = vi.fn((name: string, handler: (...args: unknown[]) => void) =>
        this.events.set(name, handler),
      );
      postMessage = vi.fn();
      terminate = vi.fn();
      unref = vi.fn();
      constructor() {
        mocks.workers.push(this);
      }
    },
  );
  return { Worker, default: { Worker } };
});
vi.mock("./platform-print-fonts.js", async (original) => ({
  ...(await original<typeof import("./platform-print-fonts.js")>()),
  withBundledPrintFonts: (html: string) => html,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.workers.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const worker of mocks.workers) worker.events.get("exit")?.();
  vi.useRealTimers();
});

test.each(["win32", "openharmony", "ohos"])(
  "%s rewrites bundled PDF fonts off the main thread while keeping native fonts fast",
  async (platform) => {
    const { preparePrintFonts } = await import("./print-font-jobs.js");
    expect(await preparePrintFonts("font-family:SimSun", platform)).toBe("font-family:SimSun");
    expect(mocks.workers).toHaveLength(0);
    const pending = preparePrintFonts("font-family:'Source Han Serif CN'", platform);
    expect(mocks.workers).toHaveLength(1);
    const { Worker } = await import("node:worker_threads");
    const worker = mocks.workers[0]!;
    const message = worker.postMessage.mock.calls[0]![0];
    expect(message.platform).toBe(platform);
    worker.events.get("message")?.({ id: message.id, html: "rewritten" });
    expect(await pending).toBe("rewritten");
    expect(String(vi.mocked(Worker).mock.calls.at(-1)?.[0])).toMatch(
      platform === "win32" ? /\/print-font-worker\.[jt]s$/u : /\/print-font-worker\.cjs$/u,
    );
  },
);

test("routes concurrent font jobs, reuses the worker, ignores late replies and expires idle buffers", async () => {
  const { preparePrintFonts } = await import("./print-font-jobs.js");
  const first = preparePrintFonts("first", "darwin"),
    second = preparePrintFonts("second", "darwin");
  expect(mocks.workers).toHaveLength(1);
  const worker = mocks.workers[0]!;
  const ids = worker.postMessage.mock.calls.map(([job]) => job.id);
  worker.events.get("message")?.({ id: ids[1], html: "second converted" });
  expect(await second).toBe("second converted");
  worker.events.get("message")?.({ id: ids[0], html: "first converted" });
  expect(await first).toBe("first converted");
  worker.events.get("message")?.({ id: ids[0], html: "duplicate" });
  await vi.advanceTimersByTimeAsync(29_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  const third = preparePrintFonts("third", "darwin");
  worker.events.get("message")?.({
    id: worker.postMessage.mock.calls[2]![0].id,
    html: "third converted",
  });
  await third;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  const restarted = preparePrintFonts("fourth", "darwin");
  const next = mocks.workers[1]!;
  const rejected = expect(restarted).rejects.toThrow();
  next.events.get("error")?.(new Error("test failure"));
  await rejected;
});

test("timeout rejects all pending requests and failed jobs are never treated as printable HTML", async () => {
  const { preparePrintFonts } = await import("./print-font-jobs.js");
  const first = preparePrintFonts("first", "darwin"),
    second = preparePrintFonts("second", "darwin");
  const failures = [expect(first).rejects.toThrow("超时"), expect(second).rejects.toThrow("超时")];
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all(failures);
  const next = preparePrintFonts("invalid", "darwin");
  const worker = mocks.workers[1]!;
  const rejected = expect(next).rejects.toThrow("invalid font");
  worker.events.get("message")?.({
    id: worker.postMessage.mock.calls[0]![0].id,
    error: "invalid font",
  });
  await rejected;
});
