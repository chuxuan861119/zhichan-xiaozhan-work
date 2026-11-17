import { scaleSvgStrokeWidths } from "./fixed-line-preview";

/** Match native CAD stroke proportions to a stable physical output reference. */
export function prepareCadExportStrokes(
  bytes: Uint8Array,
  strokeScale: number,
  renderedWidth: number,
  referencePixels: number,
) {
  const source = new TextDecoder().decode(bytes);
  const viewBox = source
    .match(/\bviewBox\s*=\s*["']([^"']+)["']/u)?.[1]
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  const svgWidth = viewBox?.[2];
  const nativeUnit = Number(source.match(/\bdata-cad-stroke-unit=["']([^"']+)["']/u)?.[1]);
  if (
    nativeUnit > 0 &&
    Number.isFinite(nativeUnit) &&
    svgWidth &&
    Number.isFinite(svgWidth) &&
    renderedWidth > 0 &&
    referencePixels > 0
  ) {
    const reference = (referencePixels * svgWidth) / renderedWidth;
    return new TextEncoder().encode(
      source.replace(
        /(stroke-width\s*[:=]\s*["']?)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/giu,
        (match, prefix: string, value: string, unit: string) => {
          const width = Number(value);
          return width > 0 && !unit
            ? `${prefix}${Math.max(width / nativeUnit, 0.8) * reference}`
            : match;
        },
      ),
    );
  }
  // Older SVGs have no native stroke unit. Retain their original zoom
  // compensation and only give otherwise invisible hairlines a small floor.
  const scaled = scaleSvgStrokeWidths(bytes, strokeScale);
  if (!svgWidth || !Number.isFinite(svgWidth) || renderedWidth <= 0 || referencePixels <= 0)
    return scaled;
  const minimum = (referencePixels * svgWidth) / renderedWidth;
  return new TextEncoder().encode(
    new TextDecoder()
      .decode(scaled)
      .replace(
        /(stroke-width\s*[:=]\s*["']?)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/giu,
        (match, prefix: string, value: string, unit: string) => {
          const width = Number(value);
          // Explicitly hidden strokes and unsupported unit-based widths stay unchanged.
          return width > 0 && !unit ? `${prefix}${Math.max(width, minimum)}` : match;
        },
      ),
  );
}
