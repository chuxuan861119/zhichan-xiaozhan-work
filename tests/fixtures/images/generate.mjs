import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const outputDirectory = dirname(fileURLToPath(import.meta.url));
await mkdir(outputDirectory, { recursive: true });

const red = { r: 220, g: 40, b: 40, alpha: 1 };
await sharp({ create: { width: 12, height: 8, channels: 4, background: red } })
  .png()
  .toFile(resolve(outputDirectory, "sample.png"));
await sharp({ create: { width: 12, height: 8, channels: 4, background: red } })
  .withMetadata({ orientation: 6 })
  .jpeg({ quality: 90 })
  .toFile(resolve(outputDirectory, "sample.jpg"));
await sharp({ create: { width: 10, height: 6, channels: 4, background: red } })
  .tiff()
  .toFile(resolve(outputDirectory, "sample.tiff"));

function createBmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3;
      bytes[offset] = 40;
      bytes[offset + 1] = 40;
      bytes[offset + 2] = 220;
    }
  }
  return bytes;
}

await writeFile(resolve(outputDirectory, "sample.bmp"), createBmp(9, 5));
