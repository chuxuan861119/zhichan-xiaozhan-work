import { isHarmonyPlatform, isMacPlatform } from "../../../shared/platform";

/** DOM wheel events do not reliably identify the physical input device. */
export function canvasWheelPans(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  platform?: string,
) {
  return (
    (isMacPlatform(platform) || isHarmonyPlatform(platform)) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/** Pixel normalization is shared by direct canvas gestures and document zoom. */
export function wheelPixels(delta: number, mode: number, pageSize: number) {
  return delta * (mode === 1 ? 40 : mode === 2 ? pageSize : 1);
}

export function canvasZoomFactor(delta: number, mode: number, pageHeight: number, pinch = false) {
  const pixels = wheelPixels(delta, mode, pageHeight);
  if (pinch) {
    // Match draw.io's fine pinch gain: 1 + |delta| / 20 * (1.2 - 1).
    const factor = 1 + Math.min(40, Math.abs(pixels)) * 0.01;
    return pixels < 0 ? 1 / factor : factor;
  }
  return Math.exp(Math.max(-240, Math.min(240, pixels)) * 0.0014);
}
