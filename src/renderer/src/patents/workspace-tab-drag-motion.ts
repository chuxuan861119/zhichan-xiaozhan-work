import { prefersReducedMotion } from "../shared/motion-preference";
import { FIXED_MOTION_DURATIONS, SPATIAL_MOTION_TIMING } from "../shared/spatial-motion";
import type { WorkspaceTabDragSession } from "./use-patent-workspace-tab-drag";

/** Share the return duration between the paint and its retained lifetime. */
export function workspaceTabDragTiming(session: WorkspaceTabDragSession) {
  return {
    ...SPATIAL_MOTION_TIMING,
    duration: prefersReducedMotion()
      ? 0
      : session.status === "cancelling"
        ? FIXED_MOTION_DURATIONS.tabDragReturn
        : FIXED_MOTION_DURATIONS.tabDragSettle,
  };
}
