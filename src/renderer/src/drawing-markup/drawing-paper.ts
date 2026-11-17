import { baseFragments, fragmentWorldPoint } from "../../../shared/drawing-markup/base-fragments";
import { detailTitleAnnotation } from "../../../shared/drawing-markup/detail-selection";
import { detailMarkerAnnotation } from "../../../shared/drawing-markup/detail-view";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";

import { minimumDrawingViewWidth } from "./drawing-zoom";

/** Shared display bounds; never changes stored drawing coordinates. */
export function drawingContentBounds(
  project: DrawingProject,
  cache?: WeakMap<object, DrawingPoint[]>,
) {
  const cachedPoints = (object: object, calculate: () => DrawingPoint[]) => {
    const old = cache?.get(object);
    if (old) return old;
    const points = calculate();
    cache?.set(object, points);
    return points;
  };
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (x: number, y: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };
  for (const fragment of baseFragments(project)) {
    const corners = cachedPoints(fragment, () => {
      const boxes = fragment.clips.map((points) => ({
        left: Math.min(...points.map((p) => p.x)),
        right: Math.max(...points.map((p) => p.x)),
        top: Math.min(...points.map((p) => p.y)),
        bottom: Math.max(...points.map((p) => p.y)),
      }));
      const l = Math.max(...boxes.map((b) => b.left)),
        r = Math.min(...boxes.map((b) => b.right));
      const t = Math.max(...boxes.map((b) => b.top)),
        b = Math.min(...boxes.map((b) => b.bottom));
      if (l > r || t > b) return [];
      return [
        { x: l, y: t },
        { x: r, y: t },
        { x: r, y: b },
        { x: l, y: b },
      ].map((point) => fragmentWorldPoint(fragment, point));
    });
    for (const p of corners) include(p.x, p.y);
  }
  const annotations = [...project.annotations];
  for (const d of project.detailViews ?? []) {
    const radius = d.radius * d.ratio;
    include(d.center.x - radius, d.center.y - radius);
    include(d.center.x + radius, d.center.y + radius);
    if (!d.markerHidden) {
      include(d.source.x - d.radius, d.source.y - d.radius);
      include(d.source.x + d.radius, d.source.y + d.radius);
      annotations.push(detailMarkerAnnotation(d));
    }
    if (!d.titleHidden) {
      for (const point of detailTitleAnnotation(d).points) include(point.x, point.y);
    }
  }
  for (const a of annotations) {
    const points = cachedPoints(a, () => {
      const half = (a.fontSize * Math.max(1, a.text.length)) / 2;
      return [
        { x: a.x - half, y: a.y - a.fontSize },
        { x: a.x + half, y: a.y + a.fontSize },
        ...a.points,
      ];
    });
    for (const p of points) include(p.x, p.y);
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: project.width, height: project.height };
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function drawingFitBounds(project: DrawingProject, native?: { x: number; y: number; width: number; height: number } | null) {
  const box = drawingContentBounds(project);
  if (native && Object.values(native).every(Number.isFinite) && native.width >= 0 && native.height >= 0) {
    const right = Math.max(box.x + box.width, native.x + native.width);
    const bottom = Math.max(box.y + box.height, native.y + native.height);
    box.x = Math.min(box.x, native.x);
    box.y = Math.min(box.y, native.y);
    box.width = right - box.x;
    box.height = bottom - box.y;
  }
  const minimum = minimumDrawingViewWidth(project.width, box);
  const width = Math.max(box.width * 1.08, minimum);
  const height = Math.max(box.height * 1.08, (minimum * project.height) / project.width);
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function drawingPaperBounds(
  project: DrawingProject,
  cache?: WeakMap<object, DrawingPoint[]>,
) {
  const box = drawingContentBounds(project, cache);
  const x = Math.min(-project.width * 0.15, box.x);
  const y = Math.min(-project.height * 0.15, box.y);
  return {
    x,
    y,
    width: Math.max(project.width * 1.15, box.x + box.width) - x,
    height: Math.max(project.height * 1.15, box.y + box.height) - y,
  };
}
