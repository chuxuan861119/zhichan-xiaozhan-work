import type { DrawingAnnotation, DrawingPoint } from "./model.js";

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
function segmentTouches(a: DrawingPoint, b: DrawingPoint, box: Box) {
  let enter = 0,
    leave = 1;
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, box.left, box.right],
    [a.y, b.y - a.y, box.top, box.bottom],
  ] as const) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return false;
    } else {
      const first = (min - origin) / delta,
        last = (max - origin) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

export function rectangleSelection(
  start: DrawingPoint,
  end: DrawingPoint,
  annotations: readonly DrawingAnnotation[],
) {
  const raw: Box = {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
  const expanded = { ...raw };
  const annotationIds: string[] = [];
  const crossing = end.x < start.x;
  if (crossing)
    for (const a of annotations) {
      // Enclose the number's font box, including its ascenders/descenders.
      const halfWidth = Math.max(a.fontSize / 2, [...a.text].length * a.fontSize * 0.35);
      const text: Box = {
        left: a.x - halfWidth,
        right: a.x + halfWidth,
        top: a.y - a.fontSize * 0.55,
        bottom: a.y + a.fontSize * 0.55,
      };
      const radius = a.lineWidth / 2;
      const strokeBox = {
        left: raw.left - radius,
        right: raw.right + radius,
        top: raw.top - radius,
        bottom: raw.bottom + radius,
      };
      const touched =
        overlaps(raw, text) ||
        a.points.some((p, i) => segmentTouches(a.points[Math.max(0, i - 1)] ?? p, p, strokeBox));
      if (!touched) continue;
      annotationIds.push(a.id);
      // Test against the mouse rectangle, not the enlarged result, to avoid cascading to unrelated marks.
      expanded.left = Math.min(expanded.left, text.left, ...a.points.map((p) => p.x - radius));
      expanded.right = Math.max(expanded.right, text.right, ...a.points.map((p) => p.x + radius));
      expanded.top = Math.min(expanded.top, text.top, ...a.points.map((p) => p.y - radius));
      expanded.bottom = Math.max(
        expanded.bottom,
        text.bottom,
        ...a.points.map((p) => p.y + radius),
      );
    }
  return {
    crossing,
    annotationIds,
    points: [
      { x: expanded.left, y: expanded.top },
      { x: expanded.right, y: expanded.top },
      { x: expanded.right, y: expanded.bottom },
      { x: expanded.left, y: expanded.bottom },
    ],
  };
}
