type Box = { x: number; y: number; width: number; height: number };
type LabelBounds = { text: string; original: Box; output: Box };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Spatial buckets keep the 5000-label limit cheap; preserve deliberate existing overlaps. */
export function findNewLabelOverlap(
  labels: readonly LabelBounds[],
  cellSize: number,
): [string, string] | null {
  const cells = new Map<string, LabelBounds[]>();
  for (const label of labels) {
    const box = label.output;
    const checked = new Set<LabelBounds>();
    for (
      let x = Math.floor(box.x / cellSize);
      x <= Math.floor((box.x + box.width) / cellSize);
      x++
    ) {
      for (
        let y = Math.floor(box.y / cellSize);
        y <= Math.floor((box.y + box.height) / cellSize);
        y++
      ) {
        const key = `${x},${y}`;
        const bucket = cells.get(key) ?? [];
        for (const other of bucket) {
          if (checked.has(other)) continue;
          checked.add(other);
          if (overlaps(box, other.output) && !overlaps(label.original, other.original))
            return [other.text, label.text];
        }
        bucket.push(label);
        cells.set(key, bucket);
      }
    }
  }
  return null;
}
