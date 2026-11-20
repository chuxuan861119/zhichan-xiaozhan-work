import { validateEditorBinaryHeader } from "./design-editor-binary.js";

/** Internal raster-only profile, not an external Photoshop import parser.
 * Layout: https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 * Never inflates channels or instantiates a canvas while inspecting allocation bounds.
 */
export function validateEditorPsdLayout(
  bytes: Uint8Array,
  size: { width: number; height: number },
  layerCount: number,
  masks?: readonly (
    | { x: number; y: number; width: number; height: number; outside: number }
    | undefined
  )[],
): void {
  validateEditorBinaryHeader(bytes, "psd", size);
  const fail = (): never => {
    throw new Error("编辑工程PSD结构不受支持或图层尺寸超出清单。");
  };
  if (!Number.isInteger(layerCount) || layerCount < 1 || layerCount > 16) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 26;
  const need = (count: number, end = bytes.length) => {
    if (!Number.isSafeInteger(count) || count < 0 || p + count > end) fail();
  };
  const u16 = () => {
    need(2);
    const value = view.getUint16(p);
    p += 2;
    return value;
  };
  const u32 = () => {
    need(4);
    const value = view.getUint32(p);
    p += 4;
    return value;
  };
  const i32 = () => {
    need(4);
    const value = view.getInt32(p);
    p += 4;
    return value;
  };
  const section = (end = bytes.length) => {
    const length = u32();
    need(length, end);
    return p + length;
  };
  if (u32() !== 0) fail(); // RGB has no color-mode palette.
  const resourceEnd = section();
  while (p < resourceEnd) {
    if (u32() !== 0x3842494d) fail();
    const id = u16();
    need(1, resourceEnd);
    const nameBytes = 1 + view.getUint8(p);
    need(nameBytes + (nameBytes % 2), resourceEnd);
    p += nameBytes + (nameBytes % 2);
    const length = u32();
    if (![1026, 1072].includes(id) || length > layerCount * 2) fail();
    need(length + (length % 2), resourceEnd);
    p += length + (length % 2);
  }
  const outerEnd = section();
  const infoEnd = section(outerEnd);
  need(2, infoEnd);
  const count = Math.abs(view.getInt16(p));
  p += 2;
  if (count !== layerCount) fail();
  const channels: { length: number; width: number; height: number }[] = [];
  for (let layer = 0; layer < count; layer++) {
    need(18, infoEnd);
    const top = i32(),
      left = i32(),
      bottom = i32(),
      right = i32();
    if (
      top < 0 ||
      left < 0 ||
      bottom < top ||
      right < left ||
      bottom > size.height ||
      right > size.width
    )
      fail();
    const width = right - left,
      height = bottom - top,
      channelCount = u16();
    if (channelCount < 3 || channelCount > 5) fail();
    const layerChannels: { length: number; width: number; height: number; id: number }[] = [];
    const ids = new Set<number>();
    for (let channel = 0; channel < channelCount; channel++) {
      need(6, infoEnd);
      const id = view.getInt16(p);
      p += 2;
      const length = u32();
      if (![-2, -1, 0, 1, 2].includes(id) || ids.has(id) || length < 2) fail();
      ids.add(id);
      layerChannels.push({ length, width, height, id });
    }
    if (![0, 1, 2].every((id) => ids.has(id)) || u32() !== 0x3842494d) fail();
    need(8, infoEnd);
    p += 8; // Blend mode and flags carry no allocations.
    const extraEnd = section(infoEnd);
    if (extraEnd - p > 16384) fail();
    const maskEnd = section(extraEnd),
      expected = masks?.[count - 1 - layer];
    if (maskEnd !== p) {
      if (!expected) throw new Error("工程包含未声明的蒙版通道。");
      if (maskEnd - p < 18 || maskEnd - p > 20 || !ids.has(-2)) fail();
      const maskTop = i32(),
        maskLeft = i32(),
        maskBottom = i32(),
        maskRight = i32();
      const mw = maskRight - maskLeft,
        mh = maskBottom - maskTop;
      if (
        maskLeft !== expected.x ||
        maskTop !== expected.y ||
        mw !== expected.width ||
        mh !== expected.height ||
        mw < 1 ||
        mh < 1 ||
        mw > 10000 ||
        mh > 10000 ||
        mw * mh > 40000000
      )
        fail();
      need(2, maskEnd);
      if (view.getUint8(p) !== expected.outside || (view.getUint8(p + 1) & ~3) !== 0) fail();
      p = maskEnd;
      const channel = layerChannels.find((value) => value.id === -2);
      if (!channel) throw new Error("工程缺少蒙版通道。");
      channel.width = mw;
      channel.height = mh;
    } else if (expected || ids.has(-2)) fail();
    if (u32() !== 0) fail(); // No blending ranges in the internal profile.
    channels.push(...layerChannels);
    need(1, extraEnd);
    const nameLength = 1 + view.getUint8(p);
    const paddedName = Math.ceil(nameLength / 4) * 4;
    need(paddedName, extraEnd);
    p += paddedName;
    while (p < extraEnd) {
      if (u32() !== 0x3842494d || u32() !== 0x6c756e69) fail(); // Only bounded Unicode layer names.
      const end = section(extraEnd),
        characters = u32();
      if (characters > 200 || characters * 2 > end - p) fail();
      p = end;
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
      let rows = 0;
      for (let row = 0; row < channel.height; row++) rows += u16();
      if (rows !== end - p) fail();
    } else fail(); // No ZIP inflation before allocation limits can be established.
    p = end;
  }
  if (infoEnd - p > 3 || bytes.subarray(p, infoEnd).some((value) => value !== 0)) fail();
  p = infoEnd;
  if (u32() !== 0) fail(); // No global mask or nested alternate layer sets.
  if (outerEnd - p > 3 || bytes.subarray(p, outerEnd).some((value) => value !== 0)) fail();
  p = outerEnd;
  const compression = u16();
  if (compression !== 0 && compression !== 1) fail();
}
