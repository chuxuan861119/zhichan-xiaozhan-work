import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { decodeBmpToBgra, importImage, MAX_IMAGE_BYTES } from "./image-importer.js";

const fixture = (name: string) => readFile(resolve(process.cwd(), "tests/fixtures/images", name));

describe("local image importer", () => {
  test("decodes uncompressed 24-bit BMP rows into top-down BGRA pixels", async () => {
    const decoded = decodeBmpToBgra(await fixture("sample.bmp"));

    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(5);
    expect(decoded.pixels).toHaveLength(9 * 5 * 4);
    expect([...decoded.pixels.slice(0, 4)]).toEqual([40, 40, 220, 255]);
  });

  test.each([
    ["sample.png", "misleading.exe", "image/png", "png"],
    ["sample.jpg", "misleading.png", "image/jpeg", "jpg"],
    ["sample.bmp", "misleading.jpg", "image/bmp", "bmp"],
    ["sample.tiff", "misleading.bin", "image/tiff", "tif"],
  ])("accepts %s by signature rather than the %s extension", async (file, name, mediaType, ext) => {
    const bytes = await fixture(file);
    const bmpPreviewSource = await fixture("sample.png");
    const asset = await importImage(
      { originalName: name, bytes },
      { bmpToPng: async () => bmpPreviewSource },
    );

    expect(asset.descriptor.mediaType).toBe(mediaType);
    expect(asset.descriptor.extension).toBe(ext);
  });

  test("rejects an executable renamed as an image", async () => {
    await expect(
      importImage({ originalName: "drawing.png", bytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0]) }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TYPE" });
  });

  test("rejects an oversized input before file detection", async () => {
    const detectFileType = vi.fn();
    await expect(
      importImage(
        { originalName: "large.png", bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) },
        { detectFileType },
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(detectFileType).not.toHaveBeenCalled();
  });

  test("rejects dimensions above 20,000 pixels before rendering a preview", async () => {
    const bytes = await fixture("sample.png");
    const createPreview = vi.fn();
    await expect(
      importImage(
        { originalName: "huge.png", bytes },
        {
          readMetadata: async () => ({ width: 20_001, height: 1 }),
          createPreview,
        },
      ),
    ).rejects.toMatchObject({ code: "DIMENSIONS_TOO_LARGE" });
    expect(createPreview).not.toHaveBeenCalled();
  });

  test("normalizes EXIF rotation and creates a bounded PNG preview", async () => {
    const bytes = await fixture("sample.jpg");
    const asset = await importImage({ originalName: "rotated.jpg", bytes });
    const previewType = await fileTypeFromBuffer(asset.preview);
    const previewMetadata = await sharp(asset.preview).metadata();

    expect(asset.descriptor.widthPx).toBe(8);
    expect(asset.descriptor.heightPx).toBe(12);
    expect(previewType?.mime).toBe("image/png");
    expect(previewMetadata.width).toBeLessThanOrEqual(2_400);
    expect(previewMetadata.height).toBeLessThanOrEqual(2_400);
    expect((previewMetadata.width ?? 0) / (previewMetadata.height ?? 1)).toBeCloseTo(8 / 12, 4);
  });

  test("keeps original bytes unchanged and records uppercase hashes", async () => {
    const bytes = await fixture("sample.png");
    const snapshot = Uint8Array.from(bytes);
    const asset = await importImage({ originalName: "sample.png", bytes });

    expect(asset.original).toEqual(snapshot);
    expect(Uint8Array.from(bytes)).toEqual(snapshot);
    expect(asset.original).not.toBe(bytes);
    expect(asset.descriptor.sha256).toMatch(/^[0-9A-F]{64}$/u);
    expect(asset.descriptor.previewSha256).toMatch(/^[0-9A-F]{64}$/u);
  });
});
