import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { imageHasTransparency, renderEditedImage } from "./image-output-service.js";

describe("renderEditedImage", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "preserves oriented pixel order for EXIF %s plus user rotation",
    async (orientation) => {
      const pixels = Buffer.from([
        255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255,
      ]);
      const source = await sharp(pixels, { raw: { width: 3, height: 2, channels: 3 } })
        .withMetadata({ orientation })
        .tiff({ compression: "lzw" })
        .toBuffer();
      const upright = await sharp(source).autoOrient().png().toBuffer();
      const expected = await sharp(upright).rotate(90).raw().toBuffer();
      const output = await renderEditedImage(source, { rotationDeg: 90, format: "png" });
      expect(await sharp(output).raw().toBuffer()).toEqual(expected);
    },
  );

  test.each([0, 90, 180, 270] as const)(
    "applies EXIF orientation before user rotation %s",
    async (rotationDeg) => {
      const source = await readFile("tests/fixtures/images/sample.jpg");
      const output = await renderEditedImage(source, { rotationDeg, format: "png" });
      const quarterTurn = rotationDeg === 90 || rotationDeg === 270;
      expect(await sharp(output).metadata()).toMatchObject({
        width: quarterTurn ? 12 : 8,
        height: quarterTurn ? 8 : 12,
      });
    },
  );

  test("copies and saves imported BMP pixels with correct colors", async () => {
    const source = await readFile("tests/fixtures/images/sample.bmp");
    await expect(imageHasTransparency(source)).resolves.toBe(false);
    const output = await renderEditedImage(source, { rotationDeg: 90, format: "png" });
    expect(await sharp(output).metadata()).toMatchObject({ width: 5, height: 9 });
    expect([...(await sharp(output).raw().toBuffer()).subarray(0, 4)]).toEqual([220, 40, 40, 255]);
  });

  test("rotates original pixels without resizing to document width", async () => {
    const source = await sharp({
      create: { width: 12, height: 7, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const output = await renderEditedImage(source, { rotationDeg: 90, format: "png" });
    expect(await sharp(output).metadata()).toMatchObject({ width: 7, height: 12, format: "png" });
  });

  test("flattens transparent pixels to white for jpeg and writes tiff", async () => {
    const source = await sharp({
      create: { width: 4, height: 3, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const jpeg = await renderEditedImage(source, { rotationDeg: 0, format: "jpg" });
    expect(await sharp(jpeg).metadata()).toMatchObject({ width: 4, height: 3, format: "jpeg" });
    const pixel = await sharp(jpeg).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([255, 255, 255]);
    const tiff = await renderEditedImage(source, { rotationDeg: 270, format: "tif" });
    expect(await sharp(tiff).metadata()).toMatchObject({ width: 3, height: 4, format: "tiff" });
  });

  test("detects whether saving as jpeg will discard transparency", async () => {
    const transparent = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const opaque = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    await expect(imageHasTransparency(transparent)).resolves.toBe(true);
    await expect(imageHasTransparency(opaque)).resolves.toBe(false);
  });
});
