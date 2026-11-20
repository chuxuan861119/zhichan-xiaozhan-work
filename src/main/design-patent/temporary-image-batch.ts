import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type TemporaryBatchBegin,
  TemporaryBatchBeginSchema,
  type TemporaryBatchPsd,
  TemporaryBatchPsdSchema,
  type TemporaryBatchRaster,
  TemporaryBatchRasterSchema,
  type TemporaryPsdExport,
  type TemporaryRasterExport,
} from "../../shared/ipc/temporary-images.js";

type IO = {
  chooseDirectory(): Promise<string | null>;
  encode(bytes: Uint8Array, options: TemporaryRasterExport["options"]): Promise<Uint8Array>;
  encodePsd(input: TemporaryPsdExport): Promise<Uint8Array>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
};
/** Directory capability only. No image data, case IDs or recoverable drafts are retained. */
export class TemporaryImageBatch {
  private batch: {
    token: string;
    directory: string;
    expires: number;
    items: Map<string, { name: string; format: string; done: boolean }>;
  } | null = null;
  private busy = false;
  constructor(
    private readonly io: IO,
    private readonly now = Date.now,
  ) {}
  async begin(input: TemporaryBatchBegin): Promise<{ token: string } | null> {
    const request = TemporaryBatchBeginSchema.parse(input);
    if (this.busy || (this.batch && this.batch.expires > this.now()))
      throw new Error("已有批量导出正在进行，请完成或取消后重试。");
    this.busy = true;
    try {
      this.batch = null;
      const directory = await this.io.chooseDirectory();
      if (!directory) return null;
      const token = randomUUID();
      this.batch = {
        token,
        directory,
        expires: this.now() + 10 * 60_000,
        items: new Map(request.items.map((item) => [item.id, { ...item, done: false }])),
      };
      return { token };
    } finally {
      this.busy = false;
    }
  }
  async writeRaster(input: TemporaryBatchRaster) {
    const request = TemporaryBatchRasterSchema.parse(input);
    return this.write(request.token, request.id, request.options.format, () =>
      this.io.encode(request.bytes, request.options),
    );
  }
  async writePsd(input: TemporaryBatchPsd) {
    const request = TemporaryBatchPsdSchema.parse(input);
    return this.write(request.token, request.id, "psd", () =>
      this.io.encodePsd({
        project: request.project,
        composite: request.composite,
        suggestedName: "image",
        density: request.density,
      }),
    );
  }
  finish(token: string): void {
    if (this.busy) throw new Error("当前图片仍在写入，请稍后结束批量导出。");
    if (this.batch?.token === token) this.batch = null;
  }
  private async write(
    token: string,
    id: string,
    format: string,
    encode: () => Promise<Uint8Array>,
  ): Promise<{ outputPath: string }> {
    const batch = this.batch,
      item = batch?.items.get(id);
    if (
      !batch ||
      batch.token !== token ||
      batch.expires <= this.now() ||
      !item ||
      item.format !== format ||
      item.done
    )
      throw new Error("批量导出凭据已失效或图片已完成，请重新导出。");
    if (this.busy) throw new Error("正在导出另一张图片，请稍后重试。");
    this.busy = true;
    try {
      const bytes = await encode();
      let stem =
        item.name
          .split(/[\\/]/)
          .at(-1)!
          .replace(/\.[^.]*$/, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows rejects C0 controls in filenames.
          .replace(/[<>:"|?*\x00-\x1f]/g, "_")
          .replace(/[. ]+$/, "")
          .slice(0, 160) || "image";
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
      const extension = format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format;
      for (let number = 1; number <= 1000; number++) {
        const outputPath = join(
          batch.directory,
          `${stem}-edited${number === 1 ? "" : ` (${number})`}.${extension}`,
        );
        try {
          await this.io.writeExclusive(outputPath, bytes);
          item.done = true;
          batch.expires = this.now() + 10 * 60_000;
          return { outputPath };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      throw new Error("目标目录重名文件过多，请选择其他目录。");
    } finally {
      this.busy = false;
    }
  }
}
