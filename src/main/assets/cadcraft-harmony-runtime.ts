import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { MAX_DRAWING_INPUT_BYTES } from "../../shared/drawing-markup/model.js";
import type { AppErrorCode } from "../../shared/ipc/result.js";
import { AppOperationError } from "../app-operation-error.js";
import type { CadCodecOperation } from "./cadcraft-runtime.js";

export function runHarmonyCadCodec(
  root: string,
  operation: CadCodecOperation,
  bytes: Uint8Array,
  fontPath: string,
  options: { signal?: AbortSignal; args?: string[]; timeoutMs?: number },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(root, "harmony/worker.mjs"), {
      workerData: { root, operation, bytes, fontPath, args: options.args ?? [] },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (code?: AppErrorCode, result?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // A caller must not release resources while a cancelled parser is alive.
      void worker.terminate().then(
        () => {
          if (code) reject(new AppOperationError({ code, message: "CAD codec failed" }));
          else resolve(result!);
        },
        () =>
          reject(
            new AppOperationError({ code: "CAD_CONVERSION_FAILED", message: "CAD worker failed" }),
          ),
      );
    };
    const abort = () => finish("CANCELLED");
    const timer = setTimeout(() => finish("CAD_CONVERSION_TIMEOUT"), options.timeoutMs ?? 120_000);
    timer.unref();
    worker.on("error", () => finish("CAD_CONVERSION_FAILED"));
    worker.on("exit", () => finish("CAD_CONVERSION_FAILED"));
    worker.on("message", (result) => {
      if (result?.bytes instanceof Uint8Array && result.bytes.byteLength > 0) {
        finish(
          result.bytes.byteLength > MAX_DRAWING_INPUT_BYTES ? "CAD_OUTPUT_TOO_LARGE" : undefined,
          result.bytes,
        );
      } else
        finish(
          ["CAD_OUTPUT_TOO_LARGE", "CAD_RUNTIME_UNAVAILABLE"].includes(result?.code)
            ? result.code
            : "CAD_CONVERSION_FAILED",
        );
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
