import {
  MAX_IMAGE_IMPORT_BATCH_BYTES,
  MAX_IMAGE_IMPORT_COUNT,
} from "../../../../shared/ipc/contract";

export { MAX_IMAGE_IMPORT_BATCH_BYTES, MAX_IMAGE_IMPORT_COUNT };
export const MAX_SINGLE_IMAGE_BYTES = 50 * 1024 * 1024;

type SizedImage = Readonly<{ size: number }>;

export function imageImportLimitError(images: readonly SizedImage[]): string | null {
  if (images.length > MAX_IMAGE_IMPORT_COUNT) {
    return `单次最多导入 ${MAX_IMAGE_IMPORT_COUNT} 张图片。`;
  }
  if (images.some((image) => image.size > MAX_SINGLE_IMAGE_BYTES)) {
    return "单张图片不能超过 50 MiB。";
  }
  const totalBytes = images.reduce((total, image) => total + image.size, 0);
  if (totalBytes > MAX_IMAGE_IMPORT_BATCH_BYTES) {
    return "单次导入图片的总大小不能超过 250 MiB。";
  }
  return null;
}
