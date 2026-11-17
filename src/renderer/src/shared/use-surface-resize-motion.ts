import { type RefObject, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "./motion-preference";
import { spatialMotionTiming, surfaceMotionDistance } from "./spatial-motion";

const resizingSurfaces = new WeakMap<
  HTMLElement,
  { animation: Animation; width: number; height: number }
>();

/** Position constraints must use the destination size, not an interpolated paint frame. */
export function surfaceRestingSize(element: HTMLElement): { width: number; height: number } {
  const resize = resizingSurfaces.get(element);
  return resize?.animation.playState === "running"
    ? { width: resize.width, height: resize.height }
    : { width: element.offsetWidth, height: element.offsetHeight };
}

/** Animate a mode change's paint, never pointer-controlled geometry. */
export function useSurfaceResizeMotion(
  ref: RefObject<HTMLElement | null>,
  mode: boolean,
  { anchored = false, duration }: { anchored?: boolean; duration?: number } = {},
) {
  const previous = useRef<{ bounds: DOMRect; mode: boolean } | null>(null);
  const active = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const last = previous.current;
    // An unrelated render must not record the interpolated size as the resting target.
    if (last?.mode === mode && active.current?.playState === "running") return;
    let from = last?.mode === mode ? null : last?.bounds;
    if (from && active.current?.playState === "running") {
      from = element.getBoundingClientRect();
      active.current.cancel();
    }
    const current = element.getBoundingClientRect();
    previous.current = { bounds: current, mode };

    if (!from?.width || !current.width || !element.animate || prefersReducedMotion()) return;
    active.current?.cancel();
    active.current = element.animate(
      [
        {
          // CSS anchors already move the edge as the animated size changes.
          translate: anchored ? "0 0" : `${from.left - current.left}px ${from.top - current.top}px`,
          width: `${from.width}px`,
          height: `${from.height}px`,
        },
        { translate: "0 0", width: `${current.width}px`, height: `${current.height}px` },
      ],
      {
        ...spatialMotionTiming(surfaceMotionDistance(from, current)),
        ...(duration === undefined ? {} : { duration }),
      },
    );
    resizingSurfaces.set(element, {
      animation: active.current,
      width: current.width,
      height: current.height,
    });
  });
  useLayoutEffect(() => () => active.current?.cancel(), []);
}
