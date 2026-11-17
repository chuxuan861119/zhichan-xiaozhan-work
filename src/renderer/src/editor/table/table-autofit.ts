export type CellWidthMeasurement = {
  left: number;
  right: number;
  requiredWidthMm: number;
};

const MINIMUM_COLUMN_WIDTH_MM = 10;

function fitToPage(widths: readonly number[], maximumTotalMm: number): number[] {
  const minimum = Math.min(MINIMUM_COLUMN_WIDTH_MM, maximumTotalMm / widths.length);
  const result = Array.from({ length: widths.length }, () => 0);
  const remaining = new Set(widths.map((_, index) => index));
  let remainingTotal = maximumTotalMm;

  while (remaining.size > 0) {
    const sourceTotal = [...remaining].reduce((sum, index) => sum + (widths[index] ?? 0), 0);
    const constrained = [...remaining].filter((index) => {
      const proportion = sourceTotal > 0 ? (widths[index] ?? 0) / sourceTotal : 1 / remaining.size;
      return proportion * remainingTotal < minimum;
    });
    if (constrained.length === 0) {
      for (const index of remaining) {
        const proportion =
          sourceTotal > 0 ? (widths[index] ?? 0) / sourceTotal : 1 / remaining.size;
        result[index] = proportion * remainingTotal;
      }
      break;
    }
    for (const index of constrained) {
      result[index] = minimum;
      remaining.delete(index);
      remainingTotal -= minimum;
    }
  }
  return result;
}

function roundWidths(widths: readonly number[], maximumTotalMm: number): number[] {
  const rounded = widths.map((width) => Math.round(width * 1_000) / 1_000);
  const difference =
    Math.round((maximumTotalMm - rounded.reduce((sum, width) => sum + width, 0)) * 1_000) / 1_000;
  if (Math.abs(difference) > 0.0001 && rounded.length > 0)
    rounded[rounded.length - 1] = Math.round(((rounded.at(-1) ?? 0) + difference) * 1_000) / 1_000;
  return rounded;
}

export function calculateContentColumnWidths(
  measurements: readonly CellWidthMeasurement[],
  currentWidthsMm: readonly number[],
  maximumTotalMm: number,
): number[] {
  if (currentWidthsMm.length === 0 || !Number.isFinite(maximumTotalMm) || maximumTotalMm <= 0)
    return [];
  const widths = currentWidthsMm.map(() => MINIMUM_COLUMN_WIDTH_MM);
  const validMeasurements = measurements.filter(
    (measurement) =>
      Number.isInteger(measurement.left) &&
      Number.isInteger(measurement.right) &&
      measurement.left >= 0 &&
      measurement.right <= widths.length &&
      measurement.right > measurement.left &&
      Number.isFinite(measurement.requiredWidthMm) &&
      measurement.requiredWidthMm > 0,
  );

  for (const measurement of validMeasurements.filter(
    (measurement) => measurement.right - measurement.left === 1,
  )) {
    widths[measurement.left] = Math.max(
      widths[measurement.left] ?? MINIMUM_COLUMN_WIDTH_MM,
      measurement.requiredWidthMm,
    );
  }
  for (const measurement of validMeasurements.filter(
    (measurement) => measurement.right - measurement.left > 1,
  )) {
    const covered = widths.slice(measurement.left, measurement.right);
    const total = covered.reduce((sum, width) => sum + width, 0);
    const deficit = measurement.requiredWidthMm - total;
    if (deficit <= 0) continue;
    for (let index = measurement.left; index < measurement.right; index += 1) {
      const proportion = total > 0 ? (widths[index] ?? 0) / total : 1 / covered.length;
      widths[index] = (widths[index] ?? 0) + deficit * proportion;
    }
  }

  const total = widths.reduce((sum, width) => sum + width, 0);
  return total > maximumTotalMm
    ? roundWidths(fitToPage(widths, maximumTotalMm), maximumTotalMm)
    : widths.map((width) => Math.round(width * 1_000) / 1_000);
}
