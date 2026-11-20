/** Cheap preflight only; not a substitute for a decoder's structural validation. */
export function validateEditorBinaryHeader(
  bytes: Uint8Array,
  kind: "psd" | "png",
  expected: { width: number; height: number },
): void {
  const fail = () => {
    throw new Error("编辑工程二进制格式或尺寸与清单不一致。");
  };
  if (bytes.byteLength < (kind === "psd" ? 26 : 33)) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width: number, height: number;
  if (kind === "psd") {
    if (
      view.getUint32(0) !== 0x38425053 ||
      view.getUint16(4) !== 1 ||
      bytes.subarray(6, 12).some((value) => value !== 0) ||
      view.getUint16(12) < 3 ||
      view.getUint16(12) > 4 ||
      view.getUint16(22) !== 8 ||
      view.getUint16(24) !== 3
    )
      fail();
    height = view.getUint32(14);
    width = view.getUint32(18);
  } else {
    if (
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452 ||
      bytes[24] !== 8 ||
      ![2, 6].includes(bytes[25] ?? -1) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      bytes[28] !== 0
    )
      fail();
    width = view.getUint32(16);
    height = view.getUint32(20);
  }
  if (
    width !== expected.width ||
    height !== expected.height ||
    !width ||
    !height ||
    width > 10000 ||
    height > 10000 ||
    width * height > 40000000
  )
    fail();
}
