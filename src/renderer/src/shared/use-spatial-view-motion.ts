import { type RefObject, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { spatialMotionTiming } from "./spatial-motion";

/** Animate a view change without remounting the editor or its draft state. */
export function useSpatialViewMotion(ref: RefObject<HTMLElement | null>, viewKey: string) {
  const previous = useRef(viewKey);
  useLayoutEffect(() => {
    const changed = previous.current !== viewKey;
    previous.current = viewKey;
    const element = ref.current;
    if (
      !changed ||
      !element ||
      element.closest("[inert], [hidden]") ||
      typeof element.animate !== "function" ||
      isMotionReduced() ||
      document.documentElement.dataset.reducedMotion === "true"
    )
      return;
    const animation = element.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      spatialMotionTiming(6),
    );
    return () => animation.cancel();
  }, [ref, viewKey]);
}
