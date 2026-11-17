import type { ImageRotation } from "../../../../shared/document/model";

export type ResizeCorner = "top-left" | "bottom-left" | "bottom-right";
export type RotationDirection = "left" | "right";

export type ResizeSession = Readonly<{
  pointerId: number;
  corner: ResizeCorner;
  startX: number;
  startWidthMm: number;
  scale: number;
}>;

const PIXELS_TO_MM = 25.4 / 96;

export function clampImageWidth(widthMm: number): number {
  return Math.min(165, Math.max(10, widthMm));
}

export function rotateImage(
  current: ImageRotation | undefined,
  direction: RotationDirection,
): ImageRotation {
  const normalized = current ?? 0;
  return ((normalized + (direction === "right" ? 90 : 270)) % 360) as ImageRotation;
}

export function rotateImagePreservingSize(
  image: { rotationDeg?: ImageRotation | undefined; widthMm: number },
  sourceAspectRatio: number,
  direction: RotationDirection,
): { rotationDeg: ImageRotation; widthMm: number } | null {
  const ratio = Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0 ? sourceAspectRatio : 1;
  const quarterTurned = image.rotationDeg === 90 || image.rotationDeg === 270;
  const widthMm = image.widthMm * (quarterTurned ? ratio : 1 / ratio);
  // Do not silently scale the image to satisfy the document's width limits.
  if (widthMm < 10 - 1e-8 || widthMm > 165 + 1e-8) return null;
  return {
    rotationDeg: rotateImage(image.rotationDeg, direction),
    widthMm: clampImageWidth(widthMm),
  };
}

export function resizedImageWidth(session: ResizeSession, clientX: number): number {
  const direction = session.corner.endsWith("left") ? -1 : 1;
  const deltaMm = ((clientX - session.startX) / session.scale) * PIXELS_TO_MM * direction;
  return Math.round(clampImageWidth(session.startWidthMm + deltaMm) * 100) / 100;
}
