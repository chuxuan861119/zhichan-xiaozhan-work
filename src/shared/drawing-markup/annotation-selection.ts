import { pointInside } from "./geometry.js";
import type { DrawingAnnotation, DrawingPoint } from "./model.js";

function touches(a: DrawingPoint, b: DrawingPoint, c: DrawingPoint, d: DrawingPoint) {
  const cross = (p: DrawingPoint, q: DrawingPoint, r: DrawingPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) >= Math.min(c.y, d.y) &&
    Math.max(c.y, d.y) >= Math.min(a.y, b.y) &&
    cross(a, b, c) * cross(a, b, d) <= 0 &&
    cross(c, d, a) * cross(c, d, b) <= 0
  );
}
export function selectAnnotationIds(
  annotations: readonly DrawingAnnotation[],
  polygon: readonly DrawingPoint[],
  crossing: boolean,
): string[] {
  if (polygon.length < 3) return [];
  const left = Math.min(...polygon.map((p) => p.x)),
    right = Math.max(...polygon.map((p) => p.x));
  const top = Math.min(...polygon.map((p) => p.y)),
    bottom = Math.max(...polygon.map((p) => p.y));
  const edges = polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]!] as const);
  return annotations
    .filter((a) => {
      const half = Math.max(a.fontSize / 2, [...a.text].length * a.fontSize * 0.35),
        h = a.fontSize * 0.55;
      const box = [
        { x: a.x - half, y: a.y - h },
        { x: a.x + half, y: a.y - h },
        { x: a.x + half, y: a.y + h },
        { x: a.x - half, y: a.y + h },
      ];
      const points = [...a.points, ...box];
      if (
        points.every((p) => p.x < left) ||
        points.every((p) => p.x > right) ||
        points.every((p) => p.y < top) ||
        points.every((p) => p.y > bottom)
      )
        return false;
      if (!crossing) return points.every((p) => pointInside(p, polygon));
      if (points.some((p) => pointInside(p, polygon)) || polygon.some((p) => pointInside(p, box)))
        return true;
      const segments = [
        ...box.map((p, i) => [p, box[(i + 1) % 4]!] as const),
        ...a.points.slice(1).map((p, i) => [a.points[i]!, p] as const),
      ];
      return segments.some(([a, b]) => edges.some(([c, d]) => touches(a, b, c, d)));
    })
    .map((a) => a.id);
}
export function translateAnnotation(
  a: DrawingAnnotation,
  dx: number,
  dy: number,
): DrawingAnnotation {
  return {
    ...a,
    x: a.x + dx,
    y: a.y + dy,
    points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
  };
}
