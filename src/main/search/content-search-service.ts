import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type ContentSearchRequest,
  type ContentSearchState,
  ContentSearchStateSchema,
} from "../../shared/library/content-search.js";
import { createContentSearchTools } from "../../shared/library/content-search-text.js";
import { runContentSearchWorker } from "./content-search-worker.js";

export class ContentSearchService {
  #worker: Worker | undefined;
  #closed = false;
  #sequence = 0;
  #pending = new Map<
    number,
    {
      resolve(value: ContentSearchState): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #busy = 0;
  #enabled = false;
  constructor(
    private readonly options: {
      libraryRoot: string;
      cacheRoot: string;
      idleMs?: number;
      stepMs?: number;
      requestTimeoutMs?: number;
    },
  ) {}
  #ensure() {
    if (this.#closed) throw new Error("Search service closed");
    if (this.#worker) return this.#worker;
    const worker = new Worker(
      `(${runContentSearchWorker.toString()})(require, (${createContentSearchTools.toString()})())`,
      {
        eval: true,
        workerData: {
          libraryPath: join(this.options.libraryRoot, "library.sqlite3"),
          cacheRoot: join(
            this.options.cacheRoot,
            createHash("sha256")
              .update(resolve(this.options.libraryRoot))
              .digest("hex")
              .slice(0, 24),
          ),
          idleMs: this.options.idleMs ?? 60000,
          stepMs: this.options.stepMs ?? 500,
          enabled: this.#enabled,
        },
      },
    );
    this.#worker = worker;
    worker.on("message", ({ id, value }: { id: number; value: unknown }) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const parsed = ContentSearchStateSchema.safeParse(value);
      if (parsed.success) pending.resolve(parsed.data);
      else pending.reject(new Error("Invalid search response"));
    });
    const failed = () => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Search unavailable"));
      }
      this.#pending.clear();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.postMessage({ busy: this.#busy > 0 });
    return worker;
  }
  async request(request: ContentSearchRequest): Promise<ContentSearchState> {
    if (request.action === "configure") this.#enabled = request.enabled;
    const worker = this.#ensure();
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (request.action === "search" && request.searchId)
          worker.postMessage({ request: { action: "cancel-search", searchId: request.searchId } });
        reject(new Error("正文检索请求超时，请重试。"));
      }, this.options.requestTimeoutMs ?? 30000);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, request });
    });
  }
  async preparePermanentDelete(patentId: string): Promise<() => void> {
    const release = this.beginOperation();
    try {
      const result = await this.request({ action: "purge-patent", patentId });
      if (result.searchError) throw new Error("正文缓存清除失败，专利已保留，请重试。");
      return release;
    } catch (failure) {
      release();
      throw failure;
    }
  }
  activity() {
    this.#worker?.postMessage({ activity: true });
  }
  beginOperation() {
    this.#busy++;
    this.#worker?.postMessage({ busy: true });
    return () => {
      this.#busy = Math.max(0, this.#busy - 1);
      this.#worker?.postMessage({ busy: this.#busy > 0 });
    };
  }
  async close() {
    this.#closed = true;
    await this.#worker?.terminate();
    this.#worker = undefined;
  }
}
