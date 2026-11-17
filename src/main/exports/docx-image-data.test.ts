import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { prepareDocxImageData } from "./docx-image-data.js";

test.each([90, 180, 270] as const)(
  "keeps vector quality and matching fallback after %s degree rotation",
  async (rotation) => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8"><rect width="12" height="8" fill="red"/><rect width="6" height="4" fill="blue"/></svg>',
    );
    const fallback = await sharp(source).png().toBuffer();
    const result = await prepareDocxImageData(
      { type: "svg", data: source, fallback: { type: "png", data: fallback } },
      rotation,
      12,
      8,
    );
    expect(result.type).toBe("svg");
    if (result.type !== "svg") throw new Error("Vector image was rasterized");
    expect(Buffer.from(result.data).toString()).toContain("<rect");
    const expected = await sharp(source).rotate(rotation).ensureAlpha().raw().toBuffer();
    expect(await sharp(result.data).ensureAlpha().raw().toBuffer()).toEqual(expected);
    expect(await sharp(result.fallback.data).ensureAlpha().raw().toBuffer()).toEqual(expected);
  },
);

test("normalizes EXIF without resizing or mutating the original", async () => {
  const source = await readFile("tests/fixtures/images/sample.jpg");
  const original = Buffer.from(source);
  const result = await prepareDocxImageData({ type: "jpg", data: source }, 0, 8, 12);
  expect(await sharp(result.data).metadata()).toMatchObject({ width: 8, height: 12 });
  expect(await sharp(result.data).raw().toBuffer()).toEqual(
    await sharp(source).autoOrient().raw().toBuffer(),
  );
  expect(source).toEqual(original);
});

test("passes through an unrotated PNG byte for byte", async () => {
  const source = await readFile("tests/fixtures/images/sample.png");
  const result = await prepareDocxImageData({ type: "png", data: source }, 0, 12, 8);
  expect(result.data).toBe(source);
});
