import { access } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type DrawingImportStage,
  DrawingImportStageSchema,
} from "../../shared/drawing-markup/import-progress.js";
import { AppOperationError } from "../app-operation-error.js";

type ConversionReport = {
  unknownEntities?: unknown[];
  skipped?: unknown[];
  externalReferences?: number;
  recoveredBlockReferences?: unknown[];
};
type ConvertedDrawing = ({ svg: Uint8Array; tiled?: never } | { tiled: true; svg?: never }) & {
  reader: ConversionReport;
  renderer: ConversionReport;
};

export async function convertDrawingWasm(
  root: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  progress?: (value: DrawingImportStage) => void,
  outputDirectory?: string,
): Promise<ConvertedDrawing> {
  signal?.throwIfAborted();
  if (bytes.length > 100 * 1024 * 1024) throw new Error("图纸超过 100 MB，请拆分后导入。");
  const entry = join(root, "wasm/worker.mjs");
  try {
    await access(entry);
  } catch {
    throw new AppOperationError({
      code: "CAD_RUNTIME_UNAVAILABLE",
      message: "CAD runtime unavailable",
    });
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Structured cloning deliberately keeps the source buffer owned by the caller.
    const worker = new Worker(entry, {
      workerData: { bytes, outputDirectory },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: unknown, result?: ConvertedDrawing) => {
      if (settled) return;
      settled = true;
      clearInterval(timeout);
      signal?.removeEventListener("abort", abort);
      // Do not remove the caller's private output directory until its writer exits.
      void worker.terminate().then(() => {
        if (error) reject(error);
        else if (result) resolve(result);
      }, reject);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    let elapsed = 0,
      last = performance.now();
    // Match the native conversion's bounded active-time budget; a system sleep
    // must not immediately fail an otherwise healthy, cancellable large drawing.
    const timeout = setInterval(() => {
      const now = performance.now();
      elapsed += Math.min(now - last, 2000);
      last = now;
      if (elapsed >= 20 * 60 * 1000)
        finish(
          new AppOperationError({
            code: "CAD_CONVERSION_TIMEOUT",
            message: "Conversion timed out",
          }),
        );
    }, 1000);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("error", () => finish(new Error("离线 CAD 转换组件运行失败。")));
    worker.on("exit", () => finish(new Error("离线 CAD 转换组件意外退出。")));
    worker.on("message", (result) => {
      if (settled) return;
      if (result?.type === "progress") {
        const parsed = DrawingImportStageSchema.safeParse(result.value);
        if (parsed.success && !signal?.aborted) progress?.(parsed.data);
        return;
      }
      if (typeof result?.error === "string")
        return finish(
          result.code === "CAD_OUTPUT_TOO_LARGE"
            ? new AppOperationError({ code: "CAD_OUTPUT_TOO_LARGE", message: "normalized" })
            : new Error(result.error),
        );
      const tiled = result?.tiled === true && outputDirectory && result.svg === undefined;
      const vector =
        result?.tiled === undefined &&
        result?.svg instanceof Uint8Array &&
        result.svg.length > 0 &&
        result.svg.length <= 50 * 1024 * 1024;
      if (!tiled && !vector) {
        return finish(new Error("离线 CAD 转换结果无效或过大。"));
      }
      if (!result.reader || !result.renderer) {
        return finish(new Error("离线 CAD 转换结果无效或过大。"));
      }
      finish(undefined, result);
    });
  });
}
