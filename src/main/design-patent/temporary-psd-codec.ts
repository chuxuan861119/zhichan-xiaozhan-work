import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  type BlendMode,
  initializeCanvas,
  type Layer,
  type PixelData,
  readPsd,
  writePsdBuffer,
} from "ag-psd";
import sharp from "sharp";
import {
  type TemporaryLayerProject,
  TemporaryLayerProjectSchema,
  type TemporaryPsdExport,
  TemporaryPsdExportSchema,
} from "../../shared/ipc/temporary-images.js";
import { validateEditorBinaryHeader } from "../../shared/patent/design-editor-binary.js";
import { validateEditorPsdLayout } from "../../shared/patent/design-editor-psd.js";
import { inspectTemporaryPsd } from "../../shared/patent/temporary-psd-profile.js";

initializeCanvas(
  () => {
    throw new Error("后台PSD仅处理栅格像素，不创建画布。");
  },
  (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: "srgb",
  }),
);

const blends = {
  normal: "source-over",
  darken: "darken",
  multiply: "multiply",
  "color burn": "color-burn",
  lighten: "lighten",
  screen: "screen",
  "color dodge": "color-dodge",
  overlay: "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
} as const;
function pixelData(value: PixelData | undefined, width: number, height: number): PixelData {
  if (
    !value ||
    value.width !== width ||
    value.height !== height ||
    !(value.data instanceof Uint8ClampedArray || value.data instanceof Uint8Array) ||
    value.data.length !== width * height * 4
  )
    throw new Error("PSD图层像素数据无效。");
  return value;
}
const asPng = (image: PixelData) =>
  sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
const asPixels = async (png: Uint8Array): Promise<PixelData> => {
  const result = await sharp(png, { limitInputPixels: 40_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(result.data),
    width: result.info.width,
    height: result.info.height,
  };
};

export async function decodeTemporaryPsd(bytes: Uint8Array): Promise<TemporaryLayerProject> {
  const profile = inspectTemporaryPsd(bytes);
  if (profile.estimatedBytes > 768 * 1024 ** 2)
    throw new Error("PSD图层占用内存过大，请先缩小尺寸或减少图层。");
  try {
    for (const segment of profile.zipSegments) {
      // Node's `info` result shape is exercised by the ZIP fixture; current typings expose only Buffer.
      const expanded = inflateSync(
        bytes.subarray(segment.offset, segment.offset + segment.length),
        { maxOutputLength: Math.max(1, segment.rawLength), info: true },
      ) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (
        expanded.buffer.length !== segment.rawLength ||
        expanded.engine.bytesWritten !== segment.length
      )
        throw new Error("invalid ZIP channel");
    }
  } catch {
    throw new Error("PSD压缩通道损坏或解压尺寸超过图层声明。");
  }
  const decoded = readPsd(bytes, {
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    strict: true,
  });
  const composite = pixelData(decoded.imageData, profile.width, profile.height);
  const sourceLayers = decoded.children?.length
    ? decoded.children
    : [{ name: "图片", imageData: composite }];
  const project: TemporaryLayerProject = {
    metadata: {
      projectId: { value: randomUUID() },
      size: { width: profile.width, height: profile.height },
      selection: {},
      activeLayerId: `layer-${sourceLayers.length}`,
      layers: [],
    },
    psd: new Uint8Array(),
    backings: [],
  };
  const canonical: Layer[] = [];
  for (const [index, source] of sourceLayers.entries()) {
    if (
      source.children ||
      source.mask ||
      source.realMask ||
      source.text ||
      source.effects ||
      source.adjustment ||
      source.placedLayer ||
      source.vectorMask ||
      source.vectorFill ||
      source.vectorStroke ||
      source.protected?.artboards
    )
      throw new Error("PSD包含不支持的高级图层，请先在原软件中栅格化。");
    const blend = blends[(source.blendMode ?? "normal") as keyof typeof blends];
    if (!blend) throw new Error("PSD混合模式暂不支持，未丢弃或合并任何图层。");
    const x = source.left ?? 0,
      y = source.top ?? 0;
    const image = source.imageData;
    const w = image?.width ?? 0,
      h = image?.height ?? 0;
    if (w && h) pixelData(image, w, h);
    const full = new Uint8ClampedArray(profile.width * profile.height * 4);
    if (image)
      for (let row = Math.max(0, -y); row < Math.min(h, profile.height - y); row++) {
        const start = Math.max(0, -x),
          end = Math.min(w, profile.width - x);
        if (end > start)
          full.set(
            image.data.subarray((row * w + start) * 4, (row * w + end) * 4),
            ((row + y) * profile.width + x + start) * 4,
          );
      }
    const id = `layer-${index + 1}`,
      name = (source.name || `图层 ${index + 1}`).slice(0, 200);
    const locks = {
      all: false,
      alpha: source.protected?.transparency ?? source.transparencyProtected ?? false,
      pixels: source.protected?.composite ?? false,
      position: source.protected?.position ?? false,
    };
    if (locks.alpha && locks.pixels && locks.position) {
      locks.all = true;
      locks.alpha = false;
      locks.pixels = false;
      locks.position = false;
    }
    const properties = {
      index,
      name,
      opacity: source.opacity ?? 1,
      isVisible: !source.hidden,
      hasClipping: source.clipping ?? false,
      mixModeStr: blend,
      hostLocks: locks,
    };
    const layer: TemporaryLayerProject["metadata"]["layers"][number] = { id, properties };
    if (image && w && h && (x < 0 || y < 0 || x + w > profile.width || y + h > profile.height)) {
      layer.backing = { x, y, width: w, height: h };
      project.backings.push({ id, bytes: Uint8Array.from(await asPng(image)) });
    }
    project.metadata.layers.push(layer);
    canonical.push({
      name,
      opacity: properties.opacity,
      hidden: !properties.isVisible,
      clipping: properties.hasClipping,
      blendMode: source.blendMode ?? "normal",
      left: 0,
      top: 0,
      imageData: { width: profile.width, height: profile.height, data: full },
    });
  }
  project.psd = Uint8Array.from(
    writePsdBuffer({
      width: profile.width,
      height: profile.height,
      imageData: composite,
      children: canonical,
    }),
  );
  validateEditorPsdLayout(project.psd, project.metadata.size, canonical.length);
  return TemporaryLayerProjectSchema.parse({
    ...project,
    composite: Uint8Array.from(await asPng(composite)),
  });
}

export async function encodeTemporaryPsd(input: TemporaryPsdExport): Promise<Uint8Array> {
  const request = TemporaryPsdExportSchema.parse(input),
    metadata = request.project.metadata;
  const pixels =
    metadata.size.width * metadata.size.height * (metadata.layers.length + 1) +
    metadata.layers.reduce(
      (sum, layer) =>
        sum +
        (layer.backing ? layer.backing.width * layer.backing.height : 0) +
        (layer.mask ? layer.mask.width * layer.mask.height : 0),
      0,
    );
  if (pixels * 4 * 12 + request.project.psd.byteLength * 3 > 768 * 1024 ** 2)
    throw new Error("PSD图层占用内存过大，请先缩小尺寸或减少图层。");
  validateEditorPsdLayout(
    request.project.psd,
    metadata.size,
    metadata.layers.length,
    metadata.layers.map((layer) => layer.mask),
  );
  const decoded = readPsd(request.project.psd, {
    useImageData: true,
    skipThumbnail: true,
    skipCompositeImageData: true,
  });
  validateEditorBinaryHeader(request.composite, "png", metadata.size);
  const composite = await asPixels(request.composite);
  if (composite.width !== metadata.size.width || composite.height !== metadata.size.height)
    throw new Error("PSD合成图尺寸不一致。");
  const children: Layer[] = [];
  for (const [index, layer] of metadata.layers.entries()) {
    const backing = layer.backing;
    const backingBytes = request.project.backings.find((item) => item.id === layer.id)?.bytes;
    if (backing && !backingBytes) throw new Error("PSD外围像素缺失。");
    if (backing) validateEditorBinaryHeader(backingBytes!, "png", backing);
    const image = backing ? await asPixels(backingBytes!) : decoded.children?.[index]?.imageData;
    const w = backing?.width ?? metadata.size.width,
      h = backing?.height ?? metadata.size.height;
    pixelData(image, w, h);
    const properties = layer.properties,
      locks = properties.hostLocks;
    const blendMode = Object.entries(blends).find(
      ([, value]) => value === properties.mixModeStr,
    )?.[0] as BlendMode | undefined;
    children.push({
      name: properties.name,
      hidden: !properties.isVisible,
      opacity: properties.opacity,
      clipping: properties.hasClipping,
      blendMode: blendMode ?? "normal",
      left: backing?.x ?? 0,
      top: backing?.y ?? 0,
      imageData: image!,
      ...(layer.mask && decoded.children?.[index]?.mask
        ? { mask: decoded.children[index]!.mask }
        : {}),
      protected: {
        transparency: !!(locks?.all || locks?.alpha),
        composite: !!(locks?.all || locks?.pixels),
        position: !!(locks?.all || locks?.position),
      },
    });
  }
  const density = request.density ?? 72;
  const result = Uint8Array.from(
    writePsdBuffer({
      width: metadata.size.width,
      height: metadata.size.height,
      imageData: composite,
      children,
      imageResources: {
        resolutionInfo: {
          horizontalResolution: density,
          verticalResolution: density,
          horizontalResolutionUnit: "PPI",
          verticalResolutionUnit: "PPI",
          widthUnit: "Inches",
          heightUnit: "Inches",
        },
      },
    }),
  );
  if (result.byteLength > 50 * 1024 ** 2) throw new Error("PSD导出超过50 MiB，请减少图层或尺寸。");
  return result;
}
