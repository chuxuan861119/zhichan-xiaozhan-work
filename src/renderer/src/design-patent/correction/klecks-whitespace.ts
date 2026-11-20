import {
  type WhitespaceOptions,
  WhitespaceOptionsSchema,
  type WhitespacePlan,
  WhitespacePlanSchema,
} from "../../../../shared/settings/design-whitespace";
export type WhitespaceBounds = { left: number; top: number; width: number; height: number };
export async function scanWhitespace(
  src: { width: number; height: number; data: Uint8ClampedArray },
  tolerance: number,
  signal?: AbortSignal,
): Promise<WhitespaceBounds | null> {
  const { width, height, data } = src;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10000 ||
    height > 10000 ||
    width * height > 40000000 ||
    data.length !== width * height * 4 ||
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 50
  )
    throw Error("白边识别参数无效。");
  let left = width,
    top = height,
    right = -1,
    bottom = -1,
    clock = performance.now();
  const threshold = 255 - tolerance;
  for (let y = 0; y < height; y++) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4,
        a = data[p + 3]! / 255;
      if (!a) continue;
      if (
        255 - a * (255 - data[p]!) < threshold ||
        255 - a * (255 - data[p + 1]!) < threshold ||
        255 - a * (255 - data[p + 2]!) < threshold
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = y;
      }
    }
    if (performance.now() - clock >= 8) {
      await new Promise<void>((r) => setTimeout(r, 0));
      clock = performance.now();
    }
  }
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}
export function planWhitespace(
  width: number,
  height: number,
  bounds: WhitespaceBounds | null,
  raw: WhitespaceOptions,
): WhitespacePlan {
  const o = WhitespaceOptionsSchema.parse(raw);
  if (o.trim && !bounds)
    throw Error("没有识别到非白色主体，不会自动裁剪；可关闭裁白边后增加留白。");
  const crop = o.trim ? bounds! : { left: 0, top: 0, width, height },
    padding = o.pad
      ? { top: o.top, right: o.right, bottom: o.bottom, left: o.left }
      : { top: 0, right: 0, bottom: 0, left: 0 };
  const rect = {
    left: crop.left - padding.left,
    top: crop.top - padding.top,
    width: crop.width + padding.left + padding.right,
    height: crop.height + padding.top + padding.bottom,
  };
  const changed =
    crop.left !== 0 ||
    crop.top !== 0 ||
    crop.width !== width ||
    crop.height !== height ||
    Object.values(padding).some((v) => v > 0);
  const result = WhitespacePlanSchema.safeParse({
    original: { width, height },
    crop,
    rect,
    padding,
    changed,
  });
  if (!result.success) throw Error("结果尺寸超限：边长最多 10000 像素，总像素最多 4000 万。");
  return result.data;
}
