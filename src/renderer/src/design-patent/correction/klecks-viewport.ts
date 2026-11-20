export type ViewportPoint = Readonly<{ x: number; y: number }>;
export type ViewportSize = Readonly<{ width: number; height: number }>;
/** zoom is physical display pixels per image pixel; x/y are viewport-local CSS pixels. */
export type KlecksViewport = Readonly<ViewportPoint & { zoom: number; pixelRatio: number }>;

function positive(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error("画布尺寸或倍率无效。");
}

function point(value: ViewportPoint): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error("画布坐标无效。");
}

function scale(view: KlecksViewport): number {
  positive(view.zoom);
  positive(view.pixelRatio);
  point(view);
  return view.zoom / view.pixelRatio;
}

export function imageToScreen(view: KlecksViewport, image: ViewportPoint): ViewportPoint {
  point(image);
  const factor = scale(view);
  return { x: view.x + image.x * factor, y: view.y + image.y * factor };
}

export function screenToImage(view: KlecksViewport, screen: ViewportPoint): ViewportPoint {
  point(screen);
  const factor = scale(view);
  return { x: (screen.x - view.x) / factor, y: (screen.y - view.y) / factor };
}

export function fitViewport(
  image: ViewportSize,
  available: ViewportSize,
  pixelRatio: number,
): KlecksViewport {
  positive(image.width);
  positive(image.height);
  positive(available.width);
  positive(available.height);
  positive(pixelRatio);
  const factor = Math.min(
    32 / pixelRatio,
    available.width / image.width,
    available.height / image.height,
  );
  return {
    zoom: factor * pixelRatio,
    pixelRatio,
    x: (available.width - image.width * factor) / 2,
    y: (available.height - image.height * factor) / 2,
  };
}

export function zoomViewport(
  view: KlecksViewport,
  zoom: number,
  anchor: ViewportPoint,
): KlecksViewport {
  positive(zoom);
  const image = screenToImage(view, anchor);
  const factor = zoom / view.pixelRatio;
  return { ...view, zoom, x: anchor.x - image.x * factor, y: anchor.y - image.y * factor };
}

export function panViewport(view: KlecksViewport, delta: ViewportPoint): KlecksViewport {
  scale(view);
  point(delta);
  return { ...view, x: view.x + delta.x, y: view.y + delta.y };
}

export function changePixelRatio(
  view: KlecksViewport,
  pixelRatio: number,
  anchor: ViewportPoint,
): KlecksViewport {
  positive(pixelRatio);
  const image = screenToImage(view, anchor);
  const factor = view.zoom / pixelRatio;
  return {
    ...view,
    pixelRatio,
    x: anchor.x - image.x * factor,
    y: anchor.y - image.y * factor,
  };
}
