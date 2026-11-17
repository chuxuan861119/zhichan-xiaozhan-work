// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDrawingWasm } from "./drawing-wasm.js";

async function runtime(code: string) {
  const root = await mkdtemp(join(tmpdir(), "drawing-wasm-test-"));
  await mkdir(join(root, "wasm"));
  await writeFile(
    join(root, "wasm/worker.mjs"),
    `import {parentPort,workerData} from 'node:worker_threads';${code}`,
  );
  return root;
}

test("returns isolated converter results without detaching the original DWG", async () => {
  const root = await runtime(
    "parentPort.postMessage({svg:new Uint8Array([60,115,118,103,47,62]),reader:{},renderer:{}})",
  );
  const bytes = new Uint8Array([65, 67, 49, 48, 51, 50]);
  const result = await convertDrawingWasm(root, bytes);
  if (!result.svg) throw new Error("Expected vector result");
  expect(Buffer.from(result.svg).toString()).toBe("<svg/>");
  expect([...bytes]).toEqual([65, 67, 49, 48, 51, 50]);
});

test("progress messages remain separate from the final result and reject invalid counters", async () => {
  const root = await runtime(`
    parentPort.postMessage({type:'progress',value:{phase:'draw',completed:1,total:2}});
    parentPort.postMessage({type:'progress',value:{phase:'draw',completed:9,total:2}});
    setTimeout(()=>parentPort.postMessage({svg:new Uint8Array([60,115,118,103,47,62]),reader:{},renderer:{}}),20);
  `);
  const progress = vi.fn();
  const result = await convertDrawingWasm(root, new Uint8Array([65]), undefined, progress);
  if (!result.svg) throw new Error("Expected vector result");
  expect(Buffer.from(result.svg).toString()).toBe("<svg/>");
  expect(progress).toHaveBeenCalledExactlyOnceWith({ phase: "draw", completed: 1, total: 2 });
});

test("cancellation terminates a running conversion and preserves source bytes", async () => {
  const root = await runtime("setInterval(()=>{},1000)");
  const controller = new AbortController();
  const bytes = new Uint8Array([1, 2, 3]);
  const promise = convertDrawingWasm(root, bytes, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
});

test("complex conversion can run beyond two minutes and remains cancellable", async () => {
  const root = await runtime(
    `parentPort.postMessage({type:'progress',value:{phase:'draw',completed:1,total:500000}});setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  let observed!: () => void;
  const progress = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let settled = false;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  try {
    const task = convertDrawingWasm(root, new Uint8Array([65]), controller.signal, observed);
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await progress;
    await vi.advanceTimersByTimeAsync(120_001);
    expect(settled).toBe(false);
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    vi.useRealTimers();
  }
});

test("conversion still stops at its bounded active-time limit", async () => {
  const root = await runtime(
    `parentPort.postMessage({type:'progress',value:{phase:'read',completed:null,total:null}});setInterval(()=>{},1000);`,
  );
  let observed!: () => void;
  const progress = new Promise<void>((resolve) => {
    observed = resolve;
  });
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  try {
    const task = convertDrawingWasm(root, new Uint8Array([65]), undefined, observed);
    const failure = expect(task).rejects.toMatchObject({ code: "CAD_CONVERSION_TIMEOUT" });
    await progress;
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await failure;
  } finally {
    vi.useRealTimers();
  }
});

test("tiled results require a caller-owned output directory and preserve typed size errors", async () => {
  const root = await runtime("parentPort.postMessage({tiled:true,reader:{},renderer:{}})");
  await expect(convertDrawingWasm(root, new Uint8Array([65]))).rejects.toThrow("结果");
  await expect(
    convertDrawingWasm(root, new Uint8Array([65]), undefined, undefined, join(root, "render")),
  ).resolves.toMatchObject({ tiled: true });
  const oversized = await runtime(
    "parentPort.postMessage({error:'safe message',code:'CAD_OUTPUT_TOO_LARGE'})",
  );
  await expect(convertDrawingWasm(oversized, new Uint8Array([65]))).rejects.toMatchObject({
    code: "CAD_OUTPUT_TOO_LARGE",
  });
});

test("reports missing or failed converters instead of returning empty assets", async () => {
  await expect(convertDrawingWasm("missing-runtime", new Uint8Array())).rejects.toThrow("组件");
  const root = await runtime("parentPort.postMessage({error:'conversion failed'})");
  await expect(convertDrawingWasm(root, new Uint8Array())).rejects.toThrow("conversion failed");
  const malformed = await runtime("parentPort.postMessage({svg:null})");
  await expect(convertDrawingWasm(malformed, new Uint8Array())).rejects.toThrow("结果");
  const crashed = await runtime("process.exit(1)");
  await expect(convertDrawingWasm(crashed, new Uint8Array())).rejects.toThrow("退出");
});
