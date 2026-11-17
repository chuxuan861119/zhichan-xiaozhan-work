/** Set PNG physical resolution without re-encoding its pixels. */
export function pngWithDensity(bytes: Uint8Array, dpi: number): Uint8Array {
  if (![300, 600].includes(dpi) || bytes.length < 33 || bytes[0] !== 137 || bytes[1] !== 80)
    throw new Error("PNG 输出参数无效。");
  const chunk = new Uint8Array(21),
    view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4);
  view.setUint32(8, Math.round(dpi / 0.0254));
  view.setUint32(12, Math.round(dpi / 0.0254));
  chunk[16] = 1;
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 17)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(17, (crc ^ 0xffffffff) >>> 0);
  const parts: Uint8Array[] = [bytes.subarray(0, 8), chunk];
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) throw new Error("PNG 数据不完整。");
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0) + 12;
    if (offset + size > bytes.length) throw new Error("PNG 数据不完整。");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type !== "pHYs") parts.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  // IHDR must remain the first chunk.
  const header = parts.splice(2, 1)[0];
  if (!header) throw new Error("PNG 数据不完整。");
  parts.splice(1, 0, header);
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
