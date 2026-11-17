import { bounds } from "./geometry.js";
import type { DrawingAnnotation, DrawingPoint, DrawingProject } from "./model.js";
export function incrementLabel(text: string) {
  const n = Number(text);
  return /^\d+$/u.test(text) && Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER
    ? String(n + 1)
    : text;
}
export function nextDrawingLabel(project?: DrawingProject) {
  if (project?.nextLabel) return project.nextLabel;
  const numbers =
    project?.annotations
      .map((a) => (/^\d+$/u.test(a.text) ? Number(a.text) : 0))
      .filter(Number.isSafeInteger) ?? [];
  return incrementLabel(String(Math.max(0, ...numbers)));
}
export function resizeRectangle(points: DrawingPoint[], handle: string, point: DrawingPoint) {
  const box = bounds(points);
  const left = handle.includes("w") ? point.x : box.x;
  const right = handle.includes("e") ? point.x : box.x + box.width;
  const top = handle.includes("n") ? point.y : box.y;
  const bottom = handle.includes("s") ? point.y : box.y + box.height;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}
export function moveAnnotation(a: DrawingAnnotation, dx: number, dy: number): DrawingAnnotation {
  return {
    ...a,
    x: a.x + dx,
    y: a.y + dy,
    points: a.points.map((p, i) => (i === a.points.length - 1 ? { x: p.x + dx, y: p.y + dy } : p)),
  };
}
export function restoreDrawingHistory(
  previous: DrawingProject,
  current: DrawingProject,
): DrawingProject {
  return {
    ...previous,
    regions: [
      ...previous.regions.map((r) => {
        const published = current.regions.find((v) => v.id === r.id);
        return published
          ? {
              ...r,
              figureId: published.figureId,
              bodyNodeId: published.bodyNodeId,
              bodyAssetId: published.bodyAssetId,
              exportedRevision: published.exportedRevision,
            }
          : r;
      }),
      ...current.regions.filter(
        (r) => (r.figureId || r.bodyNodeId) && !previous.regions.some((p) => p.id === r.id),
      ),
    ],
  };
}
