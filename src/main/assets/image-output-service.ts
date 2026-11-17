import sharp from "sharp";
import type { ImageRotation } from "../../shared/document/model.js";
import { decodeBmpToBgra } from "./image-importer.js";

export type ImageOutputFormat = "png" | "jpg" | "tif";

function imagePipeline(source: Uint8Array) {
  if (source[0] === 0x42 && source[1] === 0x4d) {
    const { pixels, width, height } = decodeBmpToBgra(source);
    return sharp(pixels, { raw: { width, height, channels: 4 } }).recomb([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  }
  return sharp(source, { failOn: "error" });
}

export async function imageHasTransparency(source: Uint8Array): Promise<boolean> {
  return (await imagePipeline(source).stats()).isOpaque === false;
}

export async function renderEditedImage(
  source: Uint8Array,
  options: Readonly<{ rotationDeg: ImageRotation; format: ImageOutputFormat }>,
): Promise<Uint8Array> {
  let pipeline = imagePipeline(source).autoOrient().rotate(options.rotationDeg);
  if (options.format === "jpg") {
    pipeline = pipeline.flatten({ background: "#FFFFFF" }).jpeg({ quality: 95 });
  } else if (options.format === "tif") {
    pipeline = pipeline.tiff({ compression: "lzw" });
  } else {
    pipeline = pipeline.png();
  }
  return Uint8Array.from(await pipeline.toBuffer());
}
