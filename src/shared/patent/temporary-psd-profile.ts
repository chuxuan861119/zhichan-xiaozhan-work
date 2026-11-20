import { validateEditorBinaryHeader } from "./design-editor-binary.js";

/** Allocation preflight for external 8-bit RGB raster layers, before any channel decoder runs. */
export function inspectTemporaryPsd(bytes: Uint8Array): {
  width: number;
  height: number;
  layerCount: number;
  estimatedBytes: number;
  zipSegments: { offset: number; length: number; rawLength: number }[];
} {
  const fail = (): never => {
    throw new Error(
      "仅支持8位RGB基础栅格图层PSD。文字、蒙版、智能对象、效果及图层组请先在原软件中栅格化。",
    );
  };
  if (bytes.byteLength < 26 || bytes.byteLength > 50 * 1024 ** 2) fail();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = data.getUint32(18),
    height = data.getUint32(14);
  validateEditorBinaryHeader(bytes, "psd", { width, height });
  let p = 26;
  const need = (count: number, end = bytes.length) => {
    if (!Number.isSafeInteger(count) || count < 0 || p + count > end) fail();
  };
  const u16 = () => {
    need(2);
    const result = data.getUint16(p);
    p += 2;
    return result;
  };
  const u32 = () => {
    need(4);
    const result = data.getUint32(p);
    p += 4;
    return result;
  };
  const i32 = () => {
    need(4);
    const result = data.getInt32(p);
    p += 4;
    return result;
  };
  const section = (end = bytes.length) => {
    const length = u32();
    need(length, end);
    return p + length;
  };
  if (u32() !== 0) fail();
  p = section(); // Image resources are bounded by the file and intentionally not retained on output.
  const outerEnd = section();
  let layerCount = 0,
    backingPixels = 0;
  const channels: { width: number; height: number; length: number }[] = [];
  const zipSegments: { offset: number; length: number; rawLength: number }[] = [];
  if (outerEnd > p) {
    const infoEnd = section(outerEnd);
    if (infoEnd > p) {
      need(2, infoEnd);
      layerCount = Math.abs(data.getInt16(p));
      p += 2;
      if (layerCount > 16) fail();
      for (let index = 0; index < layerCount; index++) {
        need(18, infoEnd);
        const top = i32(),
          left = i32(),
          bottom = i32(),
          right = i32();
        const w = right - left,
          h = bottom - top;
        if (
          [top, left, bottom, right].some((value) => Math.abs(value) > 100000) ||
          w < 0 ||
          h < 0 ||
          w > 10000 ||
          h > 10000 ||
          w * h > 40_000_000
        )
          fail();
        if (top < 0 || left < 0 || bottom > height || right > width) backingPixels += w * h;
        const count = u16(),
          ids = new Set<number>();
        if (count < 3 || count > 4) fail();
        for (let c = 0; c < count; c++) {
          need(6, infoEnd);
          const id = data.getInt16(p);
          p += 2;
          const length = u32();
          if (![-1, 0, 1, 2].includes(id) || ids.has(id) || length < 2) fail();
          ids.add(id);
          channels.push({ width: w, height: h, length });
        }
        if (![0, 1, 2].every((id) => ids.has(id)) || u32() !== 0x3842494d) fail();
        need(8, infoEnd);
        p += 8;
        const extraEnd = section(infoEnd);
        if (u32() !== 0) fail(); // Raster masks require explicit rasterization, never silent loss.
        const rangesEnd = section(extraEnd);
        if ((rangesEnd - p) % 8) fail();
        const defaultRange = [0, 0, 255, 255, 0, 0, 255, 255];
        for (let i = 0; p < rangesEnd; p++, i++) if (bytes[p] !== defaultRange[i % 8]) fail();
        need(1, extraEnd);
        const nameBytes = 1 + data.getUint8(p);
        need(Math.ceil(nameBytes / 4) * 4, extraEnd);
        p += Math.ceil(nameBytes / 4) * 4;
        while (p < extraEnd) {
          if (u32() !== 0x3842494d) fail();
          const key = u32(),
            end = section(extraEnd);
          // Names, IDs, locks, color labels and non-rendering metadata only.
          const neutral = [
            0x6c756e69, 0x6c796964, 0x6c737066, 0x6c636c72, 0x73686d64, 0x66787270, 0x696e6678,
          ];
          const defaults: Record<number, number> = {
            1668047468: 1,
            1802398575: 0,
            1953721465: 1,
            1766813793: 255,
          };
          if (
            !neutral.includes(key) &&
            (!(key in defaults) || end - p !== 4 || bytes[p] !== defaults[key])
          )
            fail();
          p = end + ((end - p) % 2);
          if (p > extraEnd) fail();
        }
      }
      for (const channel of channels) {
        need(channel.length, infoEnd);
        const end = p + channel.length,
          compression = u16();
        if (compression === 0) {
          if (end - p !== channel.width * channel.height) fail();
        } else if (compression === 1) {
          need(channel.height * 2, end);
          let size = 0;
          for (let y = 0; y < channel.height; y++) size += u16();
          if (size !== end - p) fail();
        } else if (compression === 2 || compression === 3)
          zipSegments.push({
            offset: p,
            length: end - p,
            rawLength: channel.width * channel.height,
          });
        else fail();
        p = end;
      }
      if (infoEnd - p > 3 || bytes.subarray(p, infoEnd).some((value) => value !== 0)) fail();
    }
    p = infoEnd;
    if (p < outerEnd && u32() !== 0) fail();
    if (outerEnd - p > 3 || bytes.subarray(p, outerEnd).some((value) => value !== 0)) fail();
  }
  p = outerEnd;
  const compression = u16(),
    count = data.getUint16(12);
  if (compression === 0) {
    if (bytes.length - p !== width * height * count) fail();
  } else if (compression === 1) {
    need(height * count * 2);
    let size = 0;
    for (let y = 0; y < height * count; y++) size += u16();
    if (size !== bytes.length - p) fail();
  } else if (compression === 2 || compression === 3)
    zipSegments.push({ offset: p, length: bytes.length - p, rawLength: width * height * count });
  else fail();
  const fullPixels = width * height * Math.max(1, layerCount);
  return {
    width,
    height,
    layerCount,
    estimatedBytes: (fullPixels + backingPixels + width * height) * 4 * 12 + bytes.byteLength * 3,
    zipSegments,
  };
}
