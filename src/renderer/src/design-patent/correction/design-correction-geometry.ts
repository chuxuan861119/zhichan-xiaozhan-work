export type CropRect = { left: number; top: number; width: number; height: number };

export function screenPointToImagePixel(
  point: { x: number; y: number },
  viewport: { left: number; top: number; zoom: number; panX: number; panY: number },
): { x: number; y: number } {
  return {
    x: Math.round((point.x - viewport.left - viewport.panX) / viewport.zoom),
    y: Math.round((point.y - viewport.top - viewport.panY) / viewport.zoom),
  };
}

export function clampCropRect(crop: CropRect, image: { width: number; height: number }): CropRect {
  const left = Math.max(0, Math.min(crop.left, image.width - 1));
  const top = Math.max(0, Math.min(crop.top, image.height - 1));
  return {
    left,
    top,
    width: Math.max(1, Math.min(crop.width, image.width - left)),
    height: Math.max(1, Math.min(crop.height, image.height - top)),
  };
}
