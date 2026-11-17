import type { DrawingAnnotation, DrawingPoint } from "./model.js";

type Label = Pick<DrawingAnnotation, "x" | "y" | "text" | "fontSize" | "points">;
function direction(start: DrawingPoint, end: DrawingPoint) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return distance > 1e-6
    ? { x: (end.x - start.x) / distance, y: (end.y - start.y) / distance, distance }
    : { x: 1, y: 0, distance: 0 };
}
function textBox(text: string, size: number) {
  return { x: Math.max(0.35, [...text].length * 0.35) * size, y: size * 0.55 };
}
export function leaderPoints(a: Label): DrawingPoint[] {
  if (a.points.length < 2) return a.points;
  const anchor = a.points[a.points.length - 2]!;
  const d = direction(anchor, a);
  const half = textBox(a.text, a.fontSize);
  const inset =
    Math.min(half.x / Math.max(Math.abs(d.x), 1e-9), half.y / Math.max(Math.abs(d.y), 1e-9)) +
    a.fontSize * 0.18;
  const length = Math.max(0, d.distance - inset);
  return [...a.points.slice(0, -1), { x: anchor.x + d.x * length, y: anchor.y + d.y * length }];
}
export function placeLabel(
  start: DrawingPoint,
  pointer: DrawingPoint,
  text: string,
  fontSize: number,
  unitsPerPixel: number,
) {
  const half = textBox(text, fontSize);
  // Keep the cursor hotspot directly below the number, with a screen-space gap.
  const a = {
    x: pointer.x,
    y: pointer.y - half.y - 4 * unitsPerPixel,
    text,
    fontSize,
    points: [start, pointer],
  };
  return { ...a, points: leaderPoints(a) };
}
