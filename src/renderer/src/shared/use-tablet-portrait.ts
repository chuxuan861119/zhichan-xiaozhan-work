import { useSyncExternalStore } from "react";
import { isTabletInteraction } from "./tablet-input";

/** Native orientation excludes the IME avoid area. Width is a fallback for older runtimes. */
export function isTabletPortrait(): boolean {
  if (!isTabletInteraction()) return false;
  const orientation = document.documentElement.dataset.tabletOrientation;
  return orientation ? orientation === "portrait" : window.innerWidth <= 760;
}

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  window.addEventListener("workbench-tablet-metrics", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("workbench-tablet-metrics", onChange);
  };
}

export function useTabletPortrait() {
  return useSyncExternalStore(subscribe, isTabletPortrait, () => false);
}
