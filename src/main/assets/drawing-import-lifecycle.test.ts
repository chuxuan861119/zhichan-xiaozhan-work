// @vitest-environment node
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const converter = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: converter.run,
}));
vi.mock("./drawing-runtime.js", () => ({
  drawingRuntimeCommands: async () => ({
    reader: "reader",
    renderer: "renderer",
    rendererArguments: [],
  }),
  drawingRuntimeCacheIdentity: async () => "lifecycle",
}));

import { importDrawing } from "./drawing-importer.js";

const request = () => ({
  sessionId: randomUUID(),
  operationId: randomUUID(),
  originalName: "synthetic.dwg",
  declaredMediaType: null,
  bytes: Buffer.from("AC1032 fixture"),
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  converter.run.mockReset();
});

test("cancelled queued imports never start and the next reader waits for the cancelled child to exit", async () => {
  const firstAbort = new AbortController(),
    secondAbort = new AbortController();
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  converter.run
    .mockImplementationOnce((_file, _args, options, callback) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 123456789,
        exitCode: null,
        signalCode: null,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      options.signal.addEventListener(
        "abort",
        () => callback(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
      finish = () => {
        Object.assign(child, { signalCode: "SIGTERM" });
        child.emit("close");
      };
      started();
      return child;
    })
    .mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("Synthetic stop"));
    });
  const first = importDrawing(request(), "runtime", firstAbort.signal).catch((e) => e);
  await ready;
  const second = importDrawing(request(), "runtime", secondAbort.signal).catch((e) => e);
  secondAbort.abort();
  expect(await second).toMatchObject({ name: "AbortError" });
  const third = importDrawing(request(), "runtime").catch((e) => e);
  firstAbort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(converter.run).toHaveBeenCalledTimes(1);
  finish();
  expect(await first).toMatchObject({ name: "AbortError" });
  expect(await third).toMatchObject({ code: "CAD_CONVERSION_FAILED" });
  expect(converter.run).toHaveBeenCalledTimes(2);
});

test("the active deadline force-stops an unresponsive converter and reports a timeout", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"],
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const kill = vi.fn();
  converter.run.mockImplementation((_file, _args, _options, callback) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123456789,
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough(),
      kill,
    });
    kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") {
        Object.assign(child, { signalCode: signal });
        callback(new Error("Synthetic termination"));
        child.emit("close");
      }
      return true;
    });
    started();
    return child;
  });
  const result = importDrawing(request(), "runtime").catch((e) => e);
  await ready;
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(kill).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toMatchObject({ code: "CAD_CONVERSION_TIMEOUT" });
  expect(kill).toHaveBeenLastCalledWith("SIGKILL");
});

test("a sleep-sized clock jump does not immediately expire a live import", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const kill = vi.fn();
  converter.run.mockImplementation((_file, _args, options, callback) => {
    options.signal.addEventListener(
      "abort",
      () => callback(new DOMException("Cancelled", "AbortError")),
      { once: true },
    );
    started();
    return Object.assign(new EventEmitter(), { pid: undefined, stderr: new PassThrough(), kill });
  });
  const result = importDrawing(request(), "runtime", abort.signal).catch((e) => e);
  await ready;
  now = 24 * 60 * 60 * 1000;
  await vi.advanceTimersByTimeAsync(1000);
  expect(kill).not.toHaveBeenCalled();
  abort.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
});
