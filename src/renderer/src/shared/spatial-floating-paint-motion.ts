import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { SPATIAL_MOTION_RETENTION_MS, spatialMotionTiming } from "./spatial-motion";

/** Preserve only paint when an external plugin removes its interactive menu immediately. */
export function createSpatialFloatingPaintMotion() {
  let entering: Animation | undefined;
  let ghost: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let bounds: DOMRect | undefined;
  const reduced = () =>
    document.documentElement.dataset.reducedMotion === "true" || isMotionReduced();
  const clear = () => {
    entering?.cancel();
    entering = undefined;
    ghost?.remove();
    ghost = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    prepare() {
      clear();
      pending = true;
      bounds = undefined;
    },
    enter(element: HTMLElement) {
      if (!pending) return;
      pending = false;
      bounds = element.getBoundingClientRect();
      if (reduced() || typeof element.animate !== "function") return;
      entering = element.animate(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        spatialMotionTiming(6),
      );
    },
    exit(element: HTMLElement) {
      const painted = element.getBoundingClientRect();
      const previous = painted.width && painted.height ? painted : bounds;
      const opacity = getComputedStyle(element).opacity || "1";
      bounds = undefined;
      pending = false;
      clear();
      if (!previous || reduced() || typeof element.animate !== "function") return;
      ghost = element.cloneNode(true) as HTMLElement;
      for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("[id]")])
        node.removeAttribute("id");
      ghost.inert = true;
      ghost.setAttribute("aria-hidden", "true");
      ghost.dataset.spatialPaint = "exit";
      Object.assign(ghost.style, {
        position: "fixed",
        left: `${previous.left}px`,
        top: `${previous.top}px`,
        width: `${previous.width}px`,
        height: `${previous.height}px`,
        margin: "0",
        visibility: "visible",
        opacity,
        transform: "none",
        pointerEvents: "none",
      });
      document.body.append(ghost);
      ghost.animate(
        [
          { opacity, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(6px)" },
        ],
        { ...spatialMotionTiming(6), fill: "forwards" },
      );
      timer = setTimeout(clear, SPATIAL_MOTION_RETENTION_MS);
    },
    dispose: clear,
  };
}
