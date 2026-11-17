import { Worker } from "node:worker_threads";
import { requiresPrintFontWorker, withBundledPrintFonts } from "./platform-print-fonts.js";

type Pending = {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, Pending>();

function retire(target: Worker, error: Error) {
  if (worker !== target) return;
  worker = undefined;
  clearTimeout(idle);
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
  void target.terminate();
}

/** Print-only font rewriting runs off the application main thread. Idle workers release font buffers. */
export function preparePrintFonts(
  html: string,
  platform: string = process.platform,
): Promise<string> {
  if (!requiresPrintFontWorker(html, platform))
    return Promise.resolve(withBundledPrintFonts(html, platform));
  clearTimeout(idle);
  if (!worker) {
    const workerFile =
      platform === "openharmony" || platform === "ohos"
        ? "./print-font-worker.cjs"
        : "./print-font-worker.js";
    const target = new Worker(new URL(workerFile, import.meta.url));
    worker = target;
    target.on("error", (error) =>
      retire(target, error instanceof Error ? error : new Error("打印字体处理失败。")),
    );
    target.on("exit", () => retire(target, new Error("打印字体处理进程退出。")));
    target.on("message", (result: { id: number; html?: string; error?: string }) => {
      const job = pending.get(result.id);
      if (!job) return;
      pending.delete(result.id);
      clearTimeout(job.timer);
      if (typeof result.html === "string") job.resolve(result.html);
      else job.reject(new Error(result.error ?? "打印字体处理结果无效。"));
      if (pending.size === 0)
        idle = setTimeout(() => retire(target, new Error("打印字体任务已结束。")), 30_000);
      idle?.unref();
    });
    target.unref();
  }
  const target = worker;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => retire(target, new Error("打印字体处理超时。")), 30_000);
    pending.set(id, { resolve, reject, timer });
    try {
      target.postMessage({ id, html, platform });
    } catch (error) {
      retire(target, error instanceof Error ? error : new Error("打印字体任务启动失败。"));
    }
  });
}
