import { bounds } from "./geometry.js";
import type { DrawingPoint } from "./model.js";

type View = { x: number; y: number; width: number; height: number };

export function locateRegionView(
  view: View,
  viewport: { width: number; height: number },
  points: readonly DrawingPoint[],
  fit = false,
): View {
  const area = bounds(points);
  if (
    !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
    viewport.width <= 0 || viewport.height <= 0
  ) return view;
  if (fit) {
    // Fit the source figure, not the whole CAD sheet, with 10% breathing room
    // on each limiting edge. Match the actual SVG viewport to avoid letterbox offsets.
    const units = Math.max(area.width / viewport.width, area.height / viewport.height) / 0.8;
    const width = viewport.width * units;
    const height = viewport.height * units;
    return {
      x: area.x + (area.width - width) / 2,
      y: area.y + (area.height - height) / 2,
      width,
      height,
    };
  }
  // SVG's default xMidYMid meet exposes extra drawing space along one axis.
  const unitsPerPixel = Math.max(view.width / viewport.width, view.height / viewport.height);
  const visibleWidth = viewport.width * unitsPerPixel;
  const visibleHeight = viewport.height * unitsPerPixel;
  const left = view.x + (view.width - visibleWidth) / 2;
  const top = view.y + (view.height - visibleHeight) / 2;
  if (
    area.x >= left &&
    area.y >= top &&
    area.x + area.width <= left + visibleWidth &&
    area.y + area.height <= top + visibleHeight
  )
    return view;
  return {
    ...view,
    x: area.x + (area.width - view.width) / 2,
    y: area.y + (area.height - view.height) / 2,
  };
}
