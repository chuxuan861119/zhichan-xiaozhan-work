export type CellWidthConstraint = {
  left: number;
  right: number;
  minimum: number;
};
export function fitConstrainedWidths(
  widths: readonly number[],
  total: number,
  constraints: readonly CellWidthConstraint[],
): number[] | null {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(total > 0)) return null;
  const proportional = widths.map((width) => (width * total) / sum);
  if (
    constraints.every(
      (c) => proportional.slice(c.left, c.right).reduce((a, b) => a + b, 0) + 0.01 >= c.minimum,
    )
  )
    return proportional;
  // Constraints refer to visible cells, not the hidden grid tracks introduced by split/merge.
  const boundaries = [0];
  for (let right = 1; right <= widths.length; right++) {
    let value = (boundaries[right - 1] ?? 0) + 0.1;
    for (const c of constraints)
      if (c.right === right) value = Math.max(value, (boundaries[c.left] ?? 0) + c.minimum);
    boundaries.push(value);
  }
  const minimumTotal = boundaries.at(-1) ?? 0;
  if (minimumTotal > total + 0.001) return null;
  return widths.map(
    (width, index) =>
      (boundaries[index + 1] ?? 0) -
      (boundaries[index] ?? 0) +
      (Math.max(0, total - minimumTotal) * width) / sum,
  );
}
