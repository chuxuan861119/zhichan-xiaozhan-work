import { type DrawingAnnotation, type DrawingPoint, MAX_DRAWING_EXPORT_PIXELS } from "./model.js";
export function bounds(points: readonly DrawingPoint[]) {
  if (points.length < 3) throw new Error("请先框选或圈选取图范围。");
  const box = geometricBounds(points);
  if (!Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0)
    throw new Error("取图范围过小。");
  return box;
}

/** Display viewports can be smaller than one drawing unit at high magnification. */
export function geometricBounds(points: readonly DrawingPoint[]) {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys),
    width = Math.max(...xs) - x,
    height = Math.max(...ys) - y;
  return { x, y, width, height };
}
export function outputSize(points: readonly DrawingPoint[], widthMm: number, dpi: number) {
  const box = bounds(points);
  if (!Number.isFinite(widthMm) || widthMm < 10 || widthMm > 165 || ![300, 600].includes(dpi))
    throw new Error("输出尺寸无效。");
  const width = Math.round((widthMm / 25.4) * dpi),
    height = Math.round((width * box.height) / box.width),
    scale = width / box.width;
  if (
    !Number.isFinite(scale) ||
    width * height > MAX_DRAWING_EXPORT_PIXELS ||
    height > 20000 ||
    height < 1
  )
    throw new Error("输出图片过大或比例过窄，请调整范围或降低分辨率。");
  return { width, height, scale, box };
}
export function pointInside(p: DrawingPoint, polygon: readonly DrawingPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
    if (
      Math.abs(cross) < 1e-6 &&
      p.x >= Math.min(a.x, b.x) &&
      p.x <= Math.max(a.x, b.x) &&
      p.y >= Math.min(a.y, b.y) &&
      p.y <= Math.max(a.y, b.y)
    )
      return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
export function clippedAnnotations(
  annotations: readonly DrawingAnnotation[],
  polygon: readonly DrawingPoint[],
): string[] {
  return annotations
    .filter((a) => {
      const half = Math.max(a.fontSize / 2, a.text.length * a.fontSize * 0.32);
      const points = [
        ...a.points,
        { x: a.x - half, y: a.y - a.fontSize / 2 },
        { x: a.x + half, y: a.y + a.fontSize / 2 },
        { x: a.x, y: a.y },
      ];
      const crosses = a.points.some((end, index) => {
        const start = a.points[index - 1];
        if (!start) return false;
        return polygon.some((b, i) =>
          segmentsCross(start, end, b, polygon[(i + 1) % polygon.length]!),
        );
      });
      return (
        crosses ||
        (points.some((p) => pointInside(p, polygon)) &&
          points.some((p) => !pointInside(p, polygon)))
      );
    })
    .map((a) => a.text);
}

function segmentsCross(
  a: DrawingPoint,
  b: DrawingPoint,
  c: DrawingPoint,
  d: DrawingPoint,
): boolean {
  const turn = (p: DrawingPoint, q: DrawingPoint, r: DrawingPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}
