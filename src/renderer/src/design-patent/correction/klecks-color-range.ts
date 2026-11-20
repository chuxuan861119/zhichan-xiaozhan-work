import {
  type ColorRangeOptions,
  ColorRangeOptionsSchema,
} from "../../../../shared/settings/design-color-range";

export { DEFAULT_COLOR_RANGE } from "../../../../shared/settings/design-color-range";
export type RangeSample = { r: number; g: number; b: number; x: number; y: number };
type Raster = { width: number; height: number; data: Uint8ClampedArray };
export function sampleRangeColor(src: Raster, x: number, y: number): RangeSample | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= src.width ||
    y >= src.height
  )
    return null;
  x = Math.floor(x);
  y = Math.floor(y);
  const i = (y * src.width + x) * 4;
  if (!src.data[i + 3]) return null;
  return { r: src.data[i]!, g: src.data[i + 1]!, b: src.data[i + 2]!, x, y };
}
export async function colorRangeMask(
  src: Raster,
  options: ColorRangeOptions,
  positive: RangeSample[],
  negative: RangeSample[],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { width, height, data } = src,
    n = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10000 ||
    height > 10000 ||
    n > 40000000 ||
    data.length !== n * 4 ||
    !ColorRangeOptionsSchema.safeParse(options).success ||
    positive.length + negative.length > 32 ||
    [...positive, ...negative].some(
      (s) =>
        ![s.r, s.g, s.b, s.x, s.y].every(Number.isFinite) ||
        [s.r, s.g, s.b].some((v) => v < 0 || v > 255) ||
        s.x < 0 ||
        s.y < 0 ||
        s.x >= width ||
        s.y >= height,
    )
  )
    throw Error("色彩范围参数无效。");
  const alpha = new Uint8Array(n),
    radius = Math.max(1, (Math.hypot(width, height) * options.range) / 100),
    spread = options.fuzziness * 1.275;
  const weight = (distance: number) =>
    spread === 0 ? (distance < 1e-9 ? 1 : 0) : Math.max(0, 1 - distance / spread);
  const samples = (
    points: RangeSample[],
    r: number,
    g: number,
    b: number,
    x: number,
    y: number,
  ) => {
    let v = 0;
    for (const s of points) {
      const c = weight(Math.max(Math.abs(r - s.r), Math.abs(g - s.g), Math.abs(b - s.b))),
        spatial = options.localized ? Math.max(0, 1 - Math.hypot(x - s.x, y - s.y) / radius) : 1;
      v = Math.max(v, c * spatial);
    }
    return v;
  };
  let clock = performance.now();
  for (let y = 0; y < height; y++) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        p = i * 4;
      if (!data[p + 3]) continue;
      const r = data[p]!,
        g = data[p + 1]!,
        b = data[p + 2]!;
      let v = 0;
      if (options.preset === "sampled") v = samples(positive, r, g, b, x, y);
      else if (["shadows", "midtones", "highlights"].includes(options.preset))
        v = weight(
          Math.abs(
            0.2126 * r +
              0.7152 * g +
              0.0722 * b -
              (options.preset === "shadows" ? 0 : options.preset === "highlights" ? 255 : 128),
          ),
        );
      else {
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b),
          d = max - min;
        let hue =
          d === 0
            ? 0
            : max === r
              ? ((g - b) / d) % 6
              : max === g
                ? (b - r) / d + 2
                : (r - g) / d + 4;
        hue = (hue * 60 + 360) % 360;
        const target = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 }[
          options.preset as "reds"
        ];
        const distance = Math.min(Math.abs(hue - target), 360 - Math.abs(hue - target));
        v =
          d === 0
            ? 0
            : Math.max(0, 1 - distance / (15 + options.fuzziness * 0.3)) * Math.min(1, d / 32);
      }
      if (options.preset === "sampled") v = Math.max(0, v - samples(negative, r, g, b, x, y));
      if (options.invert) v = 1 - v;
      alpha[i] = Math.round(v * 255);
    }
    if (performance.now() - clock >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      clock = performance.now();
    }
  }
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  return alpha;
}
