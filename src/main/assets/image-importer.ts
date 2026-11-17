import { createHash, randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { StoredAsset } from "./asset-store.js";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 20_000;
export const MAX_PREVIEW_DIMENSION = 2_400;

type DetectedFileType = { ext: string; mime: string } | undefined;
type ImageMetadata = {
  width?: number | undefined;
  height?: number | undefined;
  orientation?: number | undefined;
};
type PreviewResult = { bytes: Uint8Array; width: number; height: number };

export type ImageImportDependencies = {
  detectFileType(bytes: Uint8Array): Promise<DetectedFileType>;
  readMetadata(bytes: Uint8Array): Promise<ImageMetadata>;
  createPreview(bytes: Uint8Array): Promise<PreviewResult>;
  bmpToPng(bytes: Uint8Array): Promise<Uint8Array>;
};

export type ImportImageInput = {
  originalName: string;
  bytes: Uint8Array;
};

export class ImageImportError extends Error {
  constructor(
    readonly code: "TOO_LARGE" | "UNSUPPORTED_TYPE" | "INVALID_IMAGE" | "DIMENSIONS_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "ImageImportError";
  }
}

export function decodeBmpToBgra(bytes: Uint8Array): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  if (bytes.byteLength < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new ImageImportError("INVALID_IMAGE", "BMP 文件头无效。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibHeaderSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (dibHeaderSize < 40 || width <= 0 || signedHeight === 0 || planes !== 1) {
    throw new ImageImportError("INVALID_IMAGE", "BMP 图片结构无效。");
  }
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new ImageImportError("INVALID_IMAGE", "BMP 仅支持 24 位或 32 位真彩色图片。");
  }
  if (compression !== 0) {
    throw new ImageImportError("INVALID_IMAGE", "暂不支持压缩 BMP 图片。");
  }
  const height = Math.abs(signedHeight);
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ImageImportError("DIMENSIONS_TOO_LARGE", "图片宽高不能超过 20,000 像素。");
  }
  const sourceBytesPerPixel = bitsPerPixel / 8;
  const sourceRowBytes = Math.ceil((width * sourceBytesPerPixel) / 4) * 4;
  const requiredBytes = pixelOffset + sourceRowBytes * height;
  if (pixelOffset < 14 + dibHeaderSize || requiredBytes > bytes.byteLength) {
    throw new ImageImportError("INVALID_IMAGE", "BMP 像素数据不完整。");
  }

  const pixels = new Uint8Array(width * height * 4);
  const topDown = signedHeight < 0;
  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceY = topDown ? targetY : height - 1 - targetY;
    const rowOffset = pixelOffset + sourceY * sourceRowBytes;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = rowOffset + x * sourceBytesPerPixel;
      const targetOffset = (targetY * width + x) * 4;
      pixels[targetOffset] = bytes[sourceOffset] ?? 0;
      pixels[targetOffset + 1] = bytes[sourceOffset + 1] ?? 0;
      pixels[targetOffset + 2] = bytes[sourceOffset + 2] ?? 0;
      pixels[targetOffset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

type AllowedMediaType = "image/png" | "image/jpeg" | "image/bmp" | "image/tiff";

const ALLOWED_TYPES = new Map<AllowedMediaType, "png" | "jpg" | "bmp" | "tif">([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tif"],
] as const);

const sharpOptions = {
  limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION,
  sequentialRead: true,
} as const;

const defaultDependencies: Omit<ImageImportDependencies, "bmpToPng"> = {
  detectFileType: (bytes) => fileTypeFromBuffer(bytes),
  readMetadata: async (bytes) => sharp(bytes, sharpOptions).metadata(),
  createPreview: async (bytes) => {
    const result = await sharp(bytes, sharpOptions)
      .rotate()
      .resize({
        width: MAX_PREVIEW_DIMENSION,
        height: MAX_PREVIEW_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function normalizedDimensions(metadata: ImageMetadata): { width: number; height: number } {
  const { width, height, orientation } = metadata;
  if (!width || !height) {
    throw new ImageImportError("INVALID_IMAGE", "无法读取图片尺寸。");
  }
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

export async function importImage(
  input: ImportImageInput,
  overrides: Partial<ImageImportDependencies> = {},
): Promise<StoredAsset> {
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageImportError("TOO_LARGE", "图片不能超过 50 MiB。");
  }

  const dependencies = { ...defaultDependencies, ...overrides };
  const original = Uint8Array.from(input.bytes);
  const detected = await dependencies.detectFileType(original);
  const extension = detected ? ALLOWED_TYPES.get(detected.mime as AllowedMediaType) : null;
  if (!detected || !extension) {
    throw new ImageImportError("UNSUPPORTED_TYPE", "仅支持 PNG、JPEG、BMP 和 TIFF 图片。");
  }

  let decodedSource = original;
  if (detected.mime === "image/bmp") {
    if (!overrides.bmpToPng) {
      throw new ImageImportError("INVALID_IMAGE", "当前环境无法解码 BMP 图片。");
    }
    decodedSource = Uint8Array.from(await overrides.bmpToPng(original));
  }

  let metadata: ImageMetadata;
  try {
    metadata = await dependencies.readMetadata(decodedSource);
  } catch (error) {
    throw new ImageImportError(
      "INVALID_IMAGE",
      error instanceof Error ? `图片无法解码：${error.message}` : "图片无法解码。",
    );
  }
  const { width, height } = normalizedDimensions(metadata);
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ImageImportError("DIMENSIONS_TOO_LARGE", "图片宽高不能超过 20,000 像素。");
  }

  let previewResult: PreviewResult;
  try {
    previewResult = await dependencies.createPreview(decodedSource);
  } catch (error) {
    throw new ImageImportError(
      "INVALID_IMAGE",
      error instanceof Error ? `预览生成失败：${error.message}` : "预览生成失败。",
    );
  }
  const preview = Uint8Array.from(previewResult.bytes);

  return {
    descriptor: {
      assetId: randomUUID(),
      kind: "image",
      originalName: input.originalName.trim(),
      mediaType: detected.mime as "image/png" | "image/jpeg" | "image/bmp" | "image/tiff",
      extension,
      byteLength: original.byteLength,
      sha256: sha256(original),
      widthPx: width,
      heightPx: height,
      previewByteLength: preview.byteLength,
      previewSha256: sha256(preview),
    },
    original,
    preview,
  };
}
