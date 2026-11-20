import {
  type KlecksViewport,
  screenToImage,
  type ViewportPoint,
  type ViewportSize,
  zoomViewport,
} from "./klecks-viewport";

export const KLECKS_ZOOM_LEVELS = [
  1 / 64,
  1 / 48,
  1 / 32,
  1 / 24,
  1 / 16,
  1 / 12,
  1 / 8,
  1 / 6,
  1 / 4,
  1 / 3,
  1 / 2,
  2 / 3,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  12,
  16,
  24,
  32,
] as const;
// Bounded by this application's admitted canvas range, not CSS page magnification.
export const clampZoom = (zoom: number) => Math.max(0.01, Math.min(32, zoom));

export function clickZoom(
  view: KlecksViewport,
  anchor: ViewportPoint,
  size: ViewportSize,
  out: boolean,
  center: boolean,
): KlecksViewport {
  const zoom = out
    ? (KLECKS_ZOOM_LEVELS.findLast((level) => level < view.zoom - 1e-9) ?? 0.01)
    : (KLECKS_ZOOM_LEVELS.find((level) => level > view.zoom + 1e-9) ?? 32);
  const result = zoomViewport(view, clampZoom(zoom), anchor);
  if (!center) return result;
  const image = screenToImage(view, anchor),
    scale = result.zoom / result.pixelRatio;
  return { ...result, x: size.width / 2 - image.x * scale, y: size.height / 2 - image.y * scale };
}
export function marqueeZoom(
  view: KlecksViewport,
  rect: { left: number; top: number; width: number; height: number },
  size: ViewportSize,
): KlecksViewport {
  if (
    ![...Object.values(rect), size.width, size.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  )
    throw new Error("缩放框无效。");
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const image = screenToImage(view, center);
  const zoom = clampZoom(view.zoom * Math.min(size.width / rect.width, size.height / rect.height)),
    scale = zoom / view.pixelRatio;
  return {
    ...view,
    zoom,
    x: size.width / 2 - image.x * scale,
    y: size.height / 2 - image.y * scale,
  };
}
export function scrubZoom(view: KlecksViewport, anchor: ViewportPoint, dx: number): KlecksViewport {
  if (!Number.isFinite(dx)) throw new Error("缩放位移无效。");
  // Continuous sensitivity is a host preference; Adobe does not specify an exact rate.
  return zoomViewport(
    view,
    clampZoom(view.zoom * 2 ** Math.max(-20, Math.min(20, dx / 100))),
    anchor,
  );
}
