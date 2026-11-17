import { useSyncExternalStore } from "react";
import { prefersReducedMotion, subscribeMotionPreference } from "./motion-preference";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotionPreference, prefersReducedMotion, () => true);
}
