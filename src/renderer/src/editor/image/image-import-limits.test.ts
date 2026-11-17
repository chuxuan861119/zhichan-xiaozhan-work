import { describe, expect, test } from "vitest";
import {
  imageImportLimitError,
  MAX_IMAGE_IMPORT_BATCH_BYTES,
  MAX_IMAGE_IMPORT_COUNT,
  MAX_SINGLE_IMAGE_BYTES,
} from "./image-import-limits";

describe("image import limits", () => {
  test("allows at most 100 images within the byte limits", () => {
    expect(
      imageImportLimitError(Array.from({ length: MAX_IMAGE_IMPORT_COUNT }, () => ({ size: 1 }))),
    ).toBeNull();
  });

  test("rejects more than 100 images before reading their bytes", () => {
    expect(
      imageImportLimitError(
        Array.from({ length: MAX_IMAGE_IMPORT_COUNT + 1 }, () => ({ size: 1 })),
      ),
    ).toContain("最多导入 100 张图片");
  });

  test("rejects an oversized image and an oversized batch", () => {
    expect(imageImportLimitError([{ size: MAX_SINGLE_IMAGE_BYTES + 1 }])).toContain("50 MiB");
    expect(
      imageImportLimitError(
        Array.from({ length: 6 }, () => ({ size: MAX_IMAGE_IMPORT_BATCH_BYTES / 6 + 1 })),
      ),
    ).toContain("250 MiB");
  });
});
