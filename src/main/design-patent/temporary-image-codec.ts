import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { TemporaryRasterExport } from "../../shared/ipc/temporary-images.js";
import { decodeBmpToBgra } from "../assets/image-importer.js";

export const TEMPORARY_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
export const TEMPORARY_IMAGE_MAX_PIXELS = 40_000_000;
export const TEMPORARY_EXPORT_FORMATS = [
  "png",
  "jpeg",
  "webp",
  "avif",
  "tiff",
  "gif",
  "bmp",
] as const;
export type TemporaryExportFormat = (typeof TEMPORARY_EXPORT_FORMATS)[number];
export type TemporaryRasterOptions = TemporaryRasterExport["options"];
const inputOptions = {
  limitInputPixels: TEMPORARY_IMAGE_MAX_PIXELS,
  failOn: "error" as const,
};
function bounded(n: number, maximum: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum)
    throw new Error("图片尺寸或参数超出支持范围。");
  return n;
}
function dimensions(width: number, height: number) {
  bounded(width, 10000);
  bounded(height, 10000);
  if (width * height > TEMPORARY_IMAGE_MAX_PIXELS) throw new Error("图片不能超过4000万像素。");
}
function inputBytes(input: Uint8Array) {
  if (!input.byteLength || input.byteLength > TEMPORARY_IMAGE_MAX_BYTES)
    throw new Error("图片为空或超过50 MiB。");
  return Buffer.from(input);
}
function validateSvg(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (
    /<!DOCTYPE|<!ENTITY|<\s*(script|foreignObject|style)\b|\bon\w+\s*=|\bstyle\s*=|@import|\bsrc\s*=|<\?(?!xml\b)/i.test(
      text,
    )
  )
    throw new Error("SVG包含不支持的活动内容或外部资源。");
  for (const match of text.matchAll(/(?:\b(?:xlink:)?href\s*=\s*["'])([^"']*)/gi))
    if (match[1] && !match[1].startsWith("#")) throw new Error("SVG不允许加载外部资源。");
  if (/url\s*\(\s*["']?(?!#)/i.test(text)) throw new Error("SVG不允许加载外部资源。");
}

/** Pure memory conversion: no patent/session identifiers, asset store or filesystem access. */
export async function decodeTemporaryRaster(input: Uint8Array, page = 0, density = 72) {
  let bytes = inputBytes(input);
  bounded(page + 1, 256);
  bounded(density, 1200);
  const detected = await fileTypeFromBuffer(bytes);
  const svg = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
    bytes.toString("utf8", 0, Math.min(bytes.length, 4096)),
  );
  if (svg) validateSvg(bytes);
  else if (!detected || !["png", "jpg", "webp", "avif", "tif", "gif", "bmp"].includes(detected.ext))
    throw new Error("不支持该图片格式。");
  if (detected?.ext === "bmp") {
    const bmp = decodeBmpToBgra(bytes);
    dimensions(bmp.width, bmp.height);
    bytes = await sharp(bmp.pixels, {
      raw: { width: bmp.width, height: bmp.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  const metadata = await sharp(bytes, { ...inputOptions, density }).metadata();
  const pageCount = metadata.pages ?? 1;
  if (page >= pageCount) throw new Error("选择的页面或帧不存在。");
  dimensions(metadata.width ?? 0, metadata.pageHeight ?? metadata.height ?? 0);
  const result = await sharp(bytes, {
    ...inputOptions,
    density,
    page,
    pages: 1,
  })
    .rotate()
    .toColourspace("srgb")
    .png()
    .toBuffer({ resolveWithObject: true });
  dimensions(result.info.width, result.info.height);
  return {
    bytes: Uint8Array.from(result.data),
    widthPx: result.info.width,
    heightPx: result.info.height,
    pageCount,
    page,
    mediaType: "image/png" as const,
  };
}

export async function encodeTemporaryRaster(
  input: Uint8Array,
  options: TemporaryRasterOptions,
): Promise<Uint8Array> {
  if (!TEMPORARY_EXPORT_FORMATS.includes(options.format)) throw new Error("不支持的导出格式。");
  const bytes = inputBytes(input),
    metadata = await sharp(bytes, inputOptions).metadata();
  if (metadata.format !== "png") throw new Error("导出内容必须是编辑器合成的PNG图片。");
  dimensions(metadata.width ?? 0, metadata.height ?? 0);
  const quality = bounded(options.quality ?? 90, 100);
  if (options.width !== undefined) bounded(options.width, 10000);
  if (options.height !== undefined) bounded(options.height, 10000);
  const width =
    options.width ??
    (options.height
      ? Math.round((metadata.width! * options.height) / metadata.height!)
      : metadata.width!);
  const height =
    options.height ??
    (options.width
      ? Math.round((metadata.height! * options.width) / metadata.width!)
      : metadata.height!);
  dimensions(width, height);
  let pipeline = sharp(bytes, inputOptions)
    .resize({ width, height, fit: "inside" })
    .toColourspace("srgb");
  if (options.density !== undefined) {
    const density = bounded(options.density, 1200);
    // withMetadata preserves source EXIF; first strip it rather than carrying GPS into output.
    const clean = await pipeline.png().toBuffer();
    pipeline = sharp(clean, inputOptions).withMetadata({ density });
  }
  if (options.format === "jpeg" || options.format === "bmp")
    pipeline = pipeline.flatten({
      background: options.background ?? "#ffffff",
    });
  if (options.format === "bmp") {
    const raw = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = raw.info.width,
      h = raw.info.height,
      stride = Math.ceil((w * 3) / 4) * 4;
    if (stride * h + 54 > TEMPORARY_IMAGE_MAX_BYTES)
      throw new Error("BMP导出超过50 MiB，请缩小尺寸或改用PNG。");
    const bmp = Buffer.alloc(54 + stride * h);
    bmp.write("BM");
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(w, 18);
    bmp.writeInt32LE(h, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(stride * h, 34);
    bmp.writeInt32LE(Math.round((options.density ?? 72) / 0.0254), 38);
    bmp.writeInt32LE(Math.round((options.density ?? 72) / 0.0254), 42);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 3,
          dst = 54 + (h - 1 - y) * stride + x * 3;
        bmp[dst] = raw.data[src + 2]!;
        bmp[dst + 1] = raw.data[src + 1]!;
        bmp[dst + 2] = raw.data[src]!;
      }
    return Uint8Array.from(bmp);
  }
  switch (options.format) {
    case "png":
      pipeline = pipeline.png();
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality, chromaSubsampling: "4:4:4" });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality, effort: 4 });
      break;
    case "tiff":
      pipeline = pipeline.tiff({ compression: "lzw" });
      break;
    case "gif":
      pipeline = pipeline.gif();
      break;
  }
  const result = await pipeline.toBuffer();
  if (result.length > TEMPORARY_IMAGE_MAX_BYTES)
    throw new Error("导出图片超过50 MiB，请调整尺寸或格式。");
  return Uint8Array.from(result);
}
