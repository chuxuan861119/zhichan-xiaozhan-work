import type { FillColor, FillOptions } from "../../../../shared/settings/design-fill";
export function resolveFillColor(
  options: FillOptions,
  foreground: FillColor,
  background: FillColor,
): FillColor {
  return options.source === "foreground"
    ? { ...foreground }
    : options.source === "background"
      ? { ...background }
      : options.source === "color"
        ? { ...options.color }
        : options.source === "gray"
          ? { r: 128, g: 128, b: 128 }
          : options.source === "white"
            ? { r: 255, g: 255, b: 255 }
            : { r: 0, g: 0, b: 0 };
}
/** W3C source-over blending; preserve mode retains destination alpha, including soft edges. */
export function fillPixel(
  pixel: readonly number[],
  color: FillColor,
  amount: number,
  blend: FillOptions["blend"],
  preserve: boolean,
): [number, number, number, number] {
  if (amount === 0 || (preserve && pixel[3] === 0))
    return [...pixel] as [number, number, number, number];
  const da = pixel[3]! / 255,
    alpha = preserve ? da : amount + da * (1 - amount),
    source = [color.r, color.g, color.b];
  const result: [number, number, number, number] = [0, 0, 0, Math.round(alpha * 255)];
  for (let k = 0; k < 3; k++) {
    const b = pixel[k]! / 255,
      s = source[k]! / 255;
    const mixed =
      blend === "multiply"
        ? b * s
        : blend === "screen"
          ? b + s - b * s
          : blend === "overlay"
            ? b <= 0.5
              ? 2 * b * s
              : 1 - 2 * (1 - b) * (1 - s)
            : blend === "darken"
              ? Math.min(b, s)
              : blend === "lighten"
                ? Math.max(b, s)
                : blend === "difference"
                  ? Math.abs(b - s)
                  : s;
    result[k] = Math.round(
      255 *
        (preserve
          ? (1 - amount) * b + amount * mixed
          : alpha
            ? ((1 - amount) * da * b + amount * ((1 - da) * s + da * mixed)) / alpha
            : 0),
    );
  }
  return result;
}
