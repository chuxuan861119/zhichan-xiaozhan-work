import type { Worker, WorkerOptions } from "node:worker_threads";
import {
  type TemporaryLayerProject,
  TemporaryLayerProjectSchema,
  type TemporaryPsdExport,
  type TemporaryRaster,
  type TemporaryRasterDecode,
  type TemporaryRasterExport,
  TemporaryRasterSchema,
} from "../../shared/ipc/temporary-images.js";
import { editorOperationPool } from "./editor-operation-pool.js";

type Job =
  | { action: "decode"; input: TemporaryRasterDecode }
  | { action: "encode"; input: TemporaryRasterExport }
  | { action: "decodePsd"; input: { bytes: Uint8Array } }
  | { action: "encodePsd"; input: TemporaryPsdExport };
/** One bounded conversion at a time. No filesystem, patent/session data or durable queue. */
export class TemporaryImageJobs {
  private busy = false;
  constructor(
    private readonly createWorker: (options: WorkerOptions) => Worker,
    private readonly reserve = () => editorOperationPool.reserve(768 * 1024 ** 2),
    private readonly timeoutMs = 120000,
  ) {}
  async decode(input: TemporaryRasterDecode): Promise<TemporaryRaster> {
    return TemporaryRasterSchema.parse(await this.run({ action: "decode", input }));
  }
  async encode(input: TemporaryRasterExport): Promise<Uint8Array> {
    return this.encoded({ action: "encode", input });
  }
  async decodePsd(input: { bytes: Uint8Array }): Promise<TemporaryLayerProject> {
    return TemporaryLayerProjectSchema.parse(await this.run({ action: "decodePsd", input }));
  }
  async encodePsd(input: TemporaryPsdExport): Promise<Uint8Array> {
    return this.encoded({ action: "encodePsd", input });
  }
  private async encoded(job: Job): Promise<Uint8Array> {
    const result = await this.run(job);
    if (!(result instanceof Uint8Array) || !result.byteLength || result.byteLength > 50 * 1024 ** 2)
      throw new Error("图片转换结果超出支持范围。");
    return result;
  }
  private async run(job: Job): Promise<unknown> {
    if (this.busy) throw new Error("正在处理图片，请完成当前操作后重试。");
    this.busy = true;
    let release: (() => void) | undefined;
    try {
      release = this.reserve();
      const captured =
        job.action === "encodePsd"
          ? {
              ...job,
              input: {
                ...job.input,
                composite: Uint8Array.from(job.input.composite),
                project: {
                  metadata: structuredClone(job.input.project.metadata),
                  psd: Uint8Array.from(job.input.project.psd),
                  backings: job.input.project.backings.map((item) => ({
                    id: item.id,
                    bytes: Uint8Array.from(item.bytes),
                  })),
                },
              },
            }
          : { ...job, input: { ...job.input, bytes: Uint8Array.from(job.input.bytes) } };
      const buffers =
        "bytes" in captured.input
          ? [captured.input.bytes.buffer]
          : [
              captured.input.composite.buffer,
              captured.input.project.psd.buffer,
              ...captured.input.project.backings.map((item) => item.bytes.buffer),
            ];
      const worker = this.createWorker({
        workerData: captured,
        transferList: buffers,
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
      try {
        return await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(
            () => finish(new Error("图片转换超时，请缩小图片后重试。")),
            this.timeoutMs,
          );
          const finish = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
          };
          worker.once("message", (reply: unknown) => {
            if (!reply || typeof reply !== "object" || !("ok" in reply))
              return finish(new Error("图片转换响应无效。"));
            if (reply.ok === true && "value" in reply) finish(undefined, reply.value);
            else
              finish(
                new Error(
                  "message" in reply && typeof reply.message === "string"
                    ? reply.message.slice(0, 500)
                    : "图片转换失败。",
                ),
              );
          });
          worker.once("error", (error) =>
            finish(error instanceof Error ? error : new Error("图片转换失败。")),
          );
          worker.once("exit", () => finish(new Error("图片转换意外停止，原图和编辑内容未改变。")));
        });
      } finally {
        try {
          await worker.terminate();
        } finally {
          worker.removeAllListeners();
        }
      }
    } finally {
      release?.();
      this.busy = false;
    }
  }
}
