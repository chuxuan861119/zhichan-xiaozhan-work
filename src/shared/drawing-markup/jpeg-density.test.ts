// @vitest-environment node
import sharp from "sharp";
import { expect, it } from "vitest";
import { jpegWithDensity } from "./jpeg-density.js";

it("stores JPEG output density without changing dimensions or decoded pixels", async () => {
  const source = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "white" },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  const original = await sharp(source).raw().toBuffer();
  for (const dpi of [300, 600]) {
    const output = jpegWithDensity(jpegWithDensity(source, 300), dpi);
    expect(await sharp(output).metadata()).toMatchObject({
      format: "jpeg",
      width: 20,
      height: 30,
      density: dpi,
    });
    expect(await sharp(output).raw().toBuffer()).toEqual(original);
  }
});
