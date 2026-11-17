import { runtimePlatform } from "../../../shared/platform";
import "../../../../resources/ui/workbench-ui.js";

/** Fixed durations shared by renderer and embedded surfaces. */
export const SPATIAL_MOTION_TIMING = {
  duration: window.workbenchUi.panelDuration,
  easing: "ease-in-out",
} as const;
export const SPATIAL_MOTION_RETENTION_MS = SPATIAL_MOTION_TIMING.duration + 20;
export const FIXED_MOTION_DURATIONS = window.workbenchUi.fixedDurations;

/** Windows text edits get more readable motion; other platforms retain their timing. */
export function contentEditMotionTiming(platform = runtimePlatform()) {
  return {
    ...SPATIAL_MOTION_TIMING,
    duration: /^win/iu.test(platform)
      ? FIXED_MOTION_DURATIONS.windowsContentEdit
      : SPATIAL_MOTION_TIMING.duration,
  };
}

/** Existing motion callers share fixed timing regardless of travel. */
export function spatialMotionTiming(_distance: number) {
  return SPATIAL_MOTION_TIMING;
}
export function surfaceMotionDistance(from: DOMRect, to: DOMRect): number {
  // Travel of the farthest corner, covering both translation and resize.
  return Math.max(
    Math.hypot(to.left - from.left, to.top - from.top),
    Math.hypot(to.right - from.right, to.bottom - from.bottom),
  );
}

/** Ruler entry keeps its original 400ms timing. */
export function workspaceMotionTiming(_element: HTMLElement) {
  return SPATIAL_MOTION_TIMING;
}

export function keyframeMotionTiming(_element: HTMLElement, _frames: Keyframe[]) {
  return SPATIAL_MOTION_TIMING;
}

export function synchronizePaintTimings(animations: Animation[], duration: number) {
  const start = document.timeline?.currentTime;
  for (const animation of animations) {
    animation.effect?.updateTiming({ duration });
    if (typeof start === "number") animation.startTime = start;
  }
}
