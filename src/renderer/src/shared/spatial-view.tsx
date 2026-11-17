import { type ReactNode, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { spatialMotionTiming } from "./spatial-motion";

/** Change paint without remounting live editors or adding a layout box. */
export function SpatialView({
  children,
  viewKey,
}: Readonly<{ children: ReactNode; viewKey: string }>) {
  const root = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The explicit view key triggers paint without depending on draft edits.
  useLayoutEffect(() => {
    if (document.documentElement.dataset.reducedMotion === "true" || isMotionReduced()) return;
    const animations = Array.from(root.current?.children ?? []).flatMap((child) => {
      if (!(child instanceof HTMLElement) || child.hidden || typeof child.animate !== "function")
        return [];
      return [
        child.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          spatialMotionTiming(6),
        ),
      ];
    });
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [viewKey]);
  return (
    <div ref={root} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
