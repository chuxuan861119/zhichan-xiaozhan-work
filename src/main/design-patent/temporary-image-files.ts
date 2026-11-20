import {
  type TemporaryExportResult,
  type TemporaryPsdExport,
  TemporaryPsdExportSchema,
  type TemporaryRasterExport,
  TemporaryRasterExportSchema,
} from "../../shared/ipc/temporary-images.js";

type FileIO = {
  choose(name: string, format: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  confirmOverwrite(path: string): Promise<boolean>;
  encode(bytes: Uint8Array, options: TemporaryRasterExport["options"]): Promise<Uint8Array>;
  encodePsd?(input: TemporaryPsdExport): Promise<Uint8Array>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
};
export class TemporaryImageFiles {
  private busy = false;
  constructor(private readonly io: FileIO) {}
  async exportRaster(input: TemporaryRasterExport): Promise<TemporaryExportResult> {
    const request = TemporaryRasterExportSchema.parse(input);
    return this.exportFile(request.suggestedName, request.options.format, () =>
      this.io.encode(request.bytes, request.options),
    );
  }
  async exportPsd(input: TemporaryPsdExport): Promise<TemporaryExportResult> {
    const request = TemporaryPsdExportSchema.parse(input);
    if (!this.io.encodePsd) throw new Error("当前平台尚未提供PSD导出。");
    return this.exportFile(request.suggestedName, "psd", () => this.io.encodePsd!(request));
  }
  private async exportFile(
    suggestedName: string,
    format: string,
    encode: () => Promise<Uint8Array>,
  ): Promise<TemporaryExportResult> {
    if (this.busy) throw new Error("正在导出图片，请完成当前操作后重试。");
    this.busy = true;
    try {
      const extension = format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format;
      const name =
        suggestedName
          .split(/[\\/]/)
          .at(-1)!
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows rejects C0 controls in filenames.
          .replace(/[<>:"|?*\x00-\x1f]/g, "_")
          .replace(/\.[^.]*$/, "")
          .replace(/[. ]+$/, "") || "image";
      const selected = await this.io.choose(`${name}-edited.${extension}`, format);
      if (!selected) return null;
      const accepted =
        format === "jpeg"
          ? /\.jpe?g$/i
          : format === "tiff"
            ? /\.tiff?$/i
            : new RegExp(`\\.${extension}$`, "i");
      const outputPath = accepted.test(selected) ? selected : `${selected}.${extension}`;
      if ((await this.io.exists(outputPath)) && !(await this.io.confirmOverwrite(outputPath)))
        return null;
      const bytes = await encode();
      await this.io.writeAtomic(outputPath, bytes);
      return { outputPath };
    } finally {
      this.busy = false;
    }
  }
}
