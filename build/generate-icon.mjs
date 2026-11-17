import sharp from "sharp";

const SOURCE_PATH = "build/logo-source.png";
const OUTPUT_PATHS = ["build/icon.png", "src/renderer/src/assets/xiaozhan-logo.png"];

const { data, info } = await sharp(SOURCE_PATH)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const rgba = Buffer.alloc(info.width * info.height * 4);

for (let sourceOffset = 0, targetOffset = 0; sourceOffset < data.length; sourceOffset += 3) {
  const red = data[sourceOffset] ?? 0;
  const green = data[sourceOffset + 1] ?? 0;
  const blue = data[sourceOffset + 2] ?? 0;
  const brightness = (red + green + blue) / 3;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const backgroundAlpha = Math.round(((238 - brightness) / 28) * 255);
  const alpha = chroma > 22 || brightness < 210 ? 255 : Math.max(0, Math.min(255, backgroundAlpha));

  rgba[targetOffset] = red;
  rgba[targetOffset + 1] = green;
  rgba[targetOffset + 2] = blue;
  rgba[targetOffset + 3] = alpha;
  targetOffset += 4;
}

const logo = await sharp(rgba, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .resize(464, 464, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: 24,
    right: 24,
    bottom: 24,
    left: 24,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await Promise.all(OUTPUT_PATHS.map((path) => sharp(logo).toFile(path)));

// macOS uses an opaque white canvas instead of supplying a backdrop for a transparent logo.
await sharp(logo)
  .resize(1024, 1024)
  .flatten({ background: "#ffffff" })
  .png()
  .toFile("build/icon-mac.png");

// Menu bar templates use only the colored mark's silhouette, without its drop shadow.
const { data: silhouette, info: silhouetteInfo } = await sharp(logo)
  .raw()
  .toBuffer({ resolveWithObject: true });
for (let offset = 0; offset < silhouette.length; offset += 4) {
  const channels = silhouette.subarray(offset, offset + 3);
  if (Math.max(...channels) - Math.min(...channels) <= 22) silhouette[offset + 3] = 0;
  silhouette.fill(0, offset, offset + 3);
}
for (const scale of [1, 2]) {
  await sharp(silhouette, {
    raw: { width: silhouetteInfo.width, height: silhouetteInfo.height, channels: 4 },
  })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(16 * scale, 16 * scale, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: scale,
      right: scale,
      bottom: scale,
      left: scale,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(`build/trayTemplate${scale === 2 ? "@2x" : ""}.png`);
}
