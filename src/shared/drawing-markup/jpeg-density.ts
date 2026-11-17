/** Replace the JFIF density header without recompressing the image. */
export function jpegWithDensity(bytes: Uint8Array, dpi: number): Uint8Array {
  if (![300, 600].includes(dpi) || bytes[0] !== 255 || bytes[1] !== 216)
    throw new Error("JPEG 输出参数无效。");
  const header = new Uint8Array([255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  const view = new DataView(header.buffer);
  view.setUint16(12, dpi);
  view.setUint16(14, dpi);
  const hasJfif =
    bytes[2] === 255 &&
    bytes[3] === 224 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === "JFIF\0";
  const offset = hasJfif ? 4 + ((bytes[4]! << 8) | bytes[5]!) : 2;
  const result = new Uint8Array(2 + header.length + bytes.length - offset);
  result.set(bytes.subarray(0, 2));
  result.set(header, 2);
  result.set(bytes.subarray(offset), 2 + header.length);
  return result;
}
