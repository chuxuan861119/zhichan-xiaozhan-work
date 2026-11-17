import type { DrawingSize, DrawingView } from "./fixed-line-preview";

export const MAX_DRAWING_ZOOM_PERCENT = 100_000;

export function minimumDrawingViewWidth(width: number, view: DrawingView) {
  // Keep sub-pixel movement representable even after moving content far from the origin.
  const precisionFloor = Math.max(1, Math.abs(view.x), Math.abs(view.y)) * Number.EPSILON * 8192;
  return Math.max((width * 1.08 * 100) / MAX_DRAWING_ZOOM_PERCENT, precisionFloor);
}

/** Stable grid cells retain overscan while panning and quantize costly SVG decoding during zoom. */
export function cadPreviewRegion(
  project: DrawingSize,
  view: DrawingView,
  cssScale: number,
  infinite = false,
): DrawingView {
  if (!infinite && Math.max(project.width, project.height) * cssScale <= 16_384)
    return { x: 0, y: 0, width: project.width, height: project.height };
  // Small viewport cells retain useful pan overscan without asking Chromium to
  // rasterize an SVG image up to six viewports wide/high at every wheel tick.
  const cellX = project.width * 2 ** (Math.ceil(Math.log2(view.width / project.width)) - 2);
  const cellY = project.height * 2 ** (Math.ceil(Math.log2(view.height / project.height)) - 2);
  return {
    x: (Math.floor(view.x / cellX) - 1) * cellX,
    y: (Math.floor(view.y / cellY) - 1) * cellY,
    width: cellX * 6,
    height: cellY * 6,
  };
}
