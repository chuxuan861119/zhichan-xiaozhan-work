export type SelectionRaster = { kind: "raster"; width: number; height: number; runs: number[] };
export const MAX_SELECTION_RUN_VALUES = 131072;
export function isSelectionRaster(input: unknown): input is SelectionRaster {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const v = input as SelectionRaster;
  if (
    Object.keys(v).length !== 4 ||
    v.kind !== "raster" ||
    !Number.isSafeInteger(v.width) ||
    !Number.isSafeInteger(v.height) ||
    v.width < 1 ||
    v.height < 1 ||
    v.width > 10000 ||
    v.height > 10000 ||
    v.width * v.height > 40000000 ||
    !Array.isArray(v.runs) ||
    !v.runs.length ||
    v.runs.length % 2 ||
    v.runs.length > MAX_SELECTION_RUN_VALUES
  )
    return false;
  let total = 0;
  for (let i = 0; i < v.runs.length; i += 2) {
    const n = v.runs[i]!,
      a = v.runs[i + 1]!;
    if (!Number.isSafeInteger(n) || n < 1 || !Number.isInteger(a) || a < 0 || a > 255) return false;
    total += n;
    if (total > v.width * v.height) return false;
  }
  return total === v.width * v.height;
}
export function encodeSelectionRaster(
  width: number,
  height: number,
  alpha: Uint8Array,
): SelectionRaster {
  if (alpha.length !== width * height) throw Error("色彩范围蒙版尺寸无效。");
  const runs: number[] = [];
  for (let start = 0; start < alpha.length; ) {
    let end = start + 1;
    while (end < alpha.length && alpha[end] === alpha[start]) end++;
    runs.push(end - start, alpha[start]!);
    start = end;
    if (runs.length > MAX_SELECTION_RUN_VALUES)
      throw Error("本次色彩范围过于复杂，未更改原选区。请缩小局部范围或调整模糊度。");
  }
  const result: SelectionRaster = { kind: "raster", width, height, runs };
  if (!isSelectionRaster(result)) throw Error("色彩范围蒙版尺寸无效。");
  return result;
}
export function decodeSelectionRaster(value: SelectionRaster): Uint8Array {
  if (!isSelectionRaster(value)) throw Error("无效的色彩范围蒙版。");
  const result = new Uint8Array(value.width * value.height);
  let offset = 0;
  for (let i = 0; i < value.runs.length; i += 2) {
    result.fill(value.runs[i + 1]!, offset, offset + value.runs[i]!);
    offset += value.runs[i]!;
  }
  return result;
}
