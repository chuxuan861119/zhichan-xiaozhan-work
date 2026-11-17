import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { runCadCodec } from "./cadcraft-runtime.js";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});
vi.mock("node:worker_threads", () => {
  const Worker = vi.fn();
  return { Worker, default: { Worker } };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

test.each(["openharmony", "ohos"])(
  "%s converts CAD in an isolated worker without spawning a desktop program",
  async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const input = new Uint8Array([1, 2, 3]);
    let terminated = false;
    // biome-ignore lint/complexity/useArrowFunction: Worker mocks must be constructable.
    vi.mocked(Worker).mockImplementation(function () {
      const worker = new EventEmitter();
      Object.assign(worker, {
        stdout: { resume() {} },
        stderr: { resume() {} },
        terminate: async () => {
          terminated = true;
          return 0;
        },
      });
      queueMicrotask(() => worker.emit("message", { bytes: new Uint8Array([4, 5]) }));
      return worker as Worker;
    });
    const result = await runCadCodec("runtime", "dxf-to-scene", input);
    expect(result).toEqual(new Uint8Array([4, 5]));
    expect(input).toEqual(new Uint8Array([1, 2, 3]));
    expect(terminated).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  },
);

test.each(["abort", "timeout", "error", "exit", "invalid", "capacity"])(
  "Harmony %s stops the parser before reporting a bounded error",
  async (scenario) => {
    vi.stubGlobal("process", { ...process, platform: "openharmony" });
    vi.useFakeTimers();
    const controller = new AbortController();
    const worker = new EventEmitter();
    let release!: (value: number) => void;
    const terminate = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    Object.assign(worker, { stdout: { resume() {} }, stderr: { resume() {} }, terminate });
    // biome-ignore lint/complexity/useArrowFunction: Worker mocks must be constructable.
    vi.mocked(Worker).mockImplementation(function () {
      return worker as Worker;
    });
    let finished = false;
    const outcome = runCadCodec("runtime", "dxf-to-scene", new Uint8Array([1]), {
      signal: controller.signal,
      timeoutMs: 20,
    }).catch((error: Error & { code: string }) => {
      finished = true;
      return error;
    });
    if (scenario === "abort") controller.abort();
    if (scenario === "timeout") await vi.advanceTimersByTimeAsync(20);
    if (scenario === "error") worker.emit("error", new Error("private file contents"));
    if (scenario === "exit") worker.emit("exit", 1);
    if (scenario === "invalid") worker.emit("message", { bytes: new Uint8Array() });
    if (scenario === "capacity") worker.emit("message", { code: "CAD_OUTPUT_TOO_LARGE" });
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    worker.emit("message", { bytes: new Uint8Array([9]) });
    release(0);
    const error = await outcome;
    const code =
      scenario === "abort"
        ? "CANCELLED"
        : scenario === "timeout"
          ? "CAD_CONVERSION_TIMEOUT"
          : scenario === "capacity"
            ? "CAD_OUTPUT_TOO_LARGE"
            : "CAD_CONVERSION_FAILED";
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("private file");
    expect(execFile).not.toHaveBeenCalled();
  },
);
