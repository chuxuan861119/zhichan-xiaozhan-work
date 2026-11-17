import {
  colorLuminance,
  colorsAreDistinct,
  type EditorColorField,
  type EditorColors,
} from "./editor-colors.js";

export type EditorColorGamut = string[][];
const gamutValidators = new WeakMap<EditorColorGamut, (color: string) => boolean>();
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function hsvToHex(h: number, s: number, v: number): string {
  const channel = (offset: number) => {
    const k = (offset + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const hue =
    delta === 0
      ? 0
      : max === r
        ? (g - b) / delta
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

/** Keep connected allowed slices; drawing and hit testing use the same table. */
export function createEditorColorGamut(
  colors: EditorColors,
  field: EditorColorField,
  hue: number,
): EditorColorGamut {
  const h = ((hue % 360) + 360) % 360;
  const columns: string[][] = [];
  for (let saturation = 0; saturation <= 255; saturation++) {
    const s = saturation / 255;
    if (field === "page" && colorLuminance(hsvToHex(h, s, 1)) < 0.65) continue;
    const values: string[] = [];
    const runs: string[][] = [];
    let run: string[] = [];
    for (let brightness = 255; brightness >= 0; brightness--) {
      const color = hsvToHex(h, s, brightness / 255);
      if (
        field === "page" &&
        (colorLuminance(color) < 0.65 || !colorsAreDistinct(color, colors.canvas))
      ) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      if (field === "canvas" && !colorsAreDistinct(colors.page, color)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      run.push(color);
    }
    if (run.length) runs.push(run);
    const previous = columns.at(-1)?.[0];
    const previousBrightness = previous ? hexToHsv(previous).v : null;
    const selected =
      field === "canvas"
        ? runs.at(-1)
        : runs.find(
            (candidate) =>
              previousBrightness === null ||
              Math.abs(hexToHsv(candidate[0] ?? "#ffffff").v - previousBrightness) <=
                1 / 255 + 1e-9,
          );
    // A forbidden band can disconnect a hue slice. Never stitch its far side back on.
    if (!selected?.length && columns.length) break;
    values.push(...(selected ?? []));
    if (values.length) columns.push(values);
  }
  // Limit boundary slopes rather than stitching across forbidden RGB gaps.
  const brightness = (color: string) =>
    Math.max(...[1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)));
  const lower = columns.map((column) => brightness(column.at(-1) ?? "#000000"));
  const upper = columns.map((column) => brightness(column[0] ?? "#ffffff"));
  for (let i = 1; i < columns.length; i++) {
    lower[i] = Math.max(lower[i]!, lower[i - 1]! - 1);
    upper[i] = Math.min(upper[i]!, upper[i - 1]! + 1);
  }
  for (let i = columns.length - 2; i >= 0; i--) {
    lower[i] = Math.max(lower[i]!, lower[i + 1]! - 1);
    upper[i] = Math.min(upper[i]!, upper[i + 1]! + 1);
  }
  const result = columns
    .map((column, i) =>
      column.filter((color) => brightness(color) >= lower[i]! && brightness(color) <= upper[i]!),
    )
    .filter((column) => column.length);
  gamutValidators.set(result, (color) =>
    field === "page"
      ? colorLuminance(color) >= 0.65 && colorsAreDistinct(color, colors.canvas)
      : field !== "canvas" || colorsAreDistinct(colors.page, color),
  );
  return result;
}

export function gamutColor(gamut: EditorColorGamut, x: number, y: number): string {
  const horizontal = clamp(x) * (gamut.length - 1);
  const fraction = horizontal - Math.floor(horizontal);
  const candidates: string[] = [];
  const sampleColumn = (index: number) => {
    const column = gamut[index];
    if (!column?.length) throw new Error("No valid colors in this gamut");
    const vertical = clamp(y) * (column.length - 1);
    const a = column[Math.floor(vertical)] ?? column[0] ?? "#ffffff";
    const b = column[Math.ceil(vertical)] ?? a;
    candidates.push(a, b);
    return [1, 3, 5].map((i) => {
      const start = Number.parseInt(a.slice(i, i + 2), 16);
      return start + (Number.parseInt(b.slice(i, i + 2), 16) - start) * (vertical % 1);
    });
  };
  const left = sampleColumn(Math.floor(horizontal));
  const right = sampleColumn(Math.ceil(horizontal));
  const rgb = left.map((value, i) => Math.round(value + ((right[i] ?? value) - value) * fraction));
  const color = `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  const allowed = gamutValidators.get(gamut);
  if (!allowed || allowed(color)) return color;
  // Quantization at the safety boundary may round outside it. Use the closest valid corner.
  const distance = (candidate: string) =>
    [1, 3, 5].reduce(
      (sum, offset, i) =>
        sum + (Number.parseInt(candidate.slice(offset, offset + 2), 16) - (rgb[i] ?? 0)) ** 2,
      0,
    );
  return candidates.reduce((best, candidate) =>
    distance(candidate) < distance(best) ? candidate : best,
  );
}

export function locateGamutColor(gamut: EditorColorGamut, color: string): { x: number; y: number } {
  const target = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  let best = Number.POSITIVE_INFINITY;
  let position = { x: 0, y: 0 };
  gamut.forEach((column, x) => {
    column.forEach((candidate, y) => {
      const distance = [1, 3, 5].reduce(
        (sum, i, channel) =>
          sum + (Number.parseInt(candidate.slice(i, i + 2), 16) - (target[channel] ?? 0)) ** 2,
        0,
      );
      if (distance < best) {
        best = distance;
        position = { x: x / Math.max(1, gamut.length - 1), y: y / Math.max(1, column.length - 1) };
      }
    });
  });
  return position;
}
