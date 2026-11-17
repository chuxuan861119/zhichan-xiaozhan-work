import { imageImportLimitError } from "../../editor/image/image-import-limits";
import type { DrawingImageImport } from "./drawings-editor";

const SUPPORTED_DRAWING_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/tiff",
]);
const SUPPORTED_DRAWING_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|bmp|tiff?)$/iu;

export function isSupportedDrawingImage(file: File): boolean {
  return (
    SUPPORTED_DRAWING_IMAGE_TYPES.has(file.type.toLocaleLowerCase("en-US")) ||
    SUPPORTED_DRAWING_IMAGE_EXTENSIONS.test(file.name)
  );
}

export async function readDrawingImageFiles(files: readonly File[]): Promise<DrawingImageImport[]> {
  const images = files.filter(isSupportedDrawingImage);
  const limitError = imageImportLimitError(images);
  if (limitError) throw new Error(limitError);
  return Promise.all(
    images.map(async (file) => ({
      originalName: file.name,
      declaredMediaType: file.type || null,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}
