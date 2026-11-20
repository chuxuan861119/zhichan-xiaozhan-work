import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { UI_MOTION_DURATION_MS, UI_MOTION_EASING } from "../app/ui-motion";

export function useSixViewZoom(fitToInspector = false) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = surface.current,
      anchor = root.current;
    if (!element || !anchor) return;
    if (fitToInspector) {
      // The inspector floats with CSS sizing, not a transform, so the
      // controls keep their original size. Clear legacy hot-update styles.
      animation.current?.cancel();
      element.style.removeProperty("width");
      element.style.removeProperty("height");
      element.style.removeProperty("transform");
      const bounds = anchor.getBoundingClientRect();
      const workspace = anchor.closest(".design-import-step")?.getBoundingClientRect();
      if (expanded && workspace && bounds.width)
        anchor.style.setProperty(
          "--design-inspector-overlay-width",
          `${Math.min(680, Math.max(bounds.width, bounds.right - workspace.left))}px`,
        );
      else anchor.style.removeProperty("--design-inspector-overlay-width");
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    const host = anchor.closest(".klecks-panels__canvas");
    const available = host?.getBoundingClientRect();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const animate = (from: Keyframe, to: Keyframe) => {
      if (element.animate && !reduceMotion)
        animation.current = element.animate([from, to], {
          duration: UI_MOTION_DURATION_MS,
          easing: UI_MOTION_EASING,
        });
    };
    const current = getComputedStyle(element);
    const limit =
      available && bounds.width && element.offsetHeight
        ? Math.max(
            1,
            Math.min(
              2,
              (bounds.right - available.left - 8) / bounds.width,
              (available.bottom - bounds.top - 8) / element.offsetHeight,
            ),
          )
        : 2;
    const target = `scale(${expanded ? limit : 1})`;
    // Capture the in-flight presentation before cancelling. Every reversal starts
    // from the current frame and uses the same full shared duration.
    const from = current.transform;
    animation.current?.cancel();
    element.style.transform = target;
    animate({ transform: from === "none" ? "scale(1)" : from }, { transform: target });
  }, [expanded, fitToInspector]);
  useEffect(() => () => animation.current?.cancel(), []);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      const anchor = root.current;
      const target = event.target;
      if (
        target instanceof Node &&
        (anchor?.contains(target) ||
          anchor?.closest("[data-six-view-layer-stack]")?.contains(target))
      )
        return;
      setExpanded(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      else outside(event);
    };
    const resize = () => setExpanded(false);
    const canvasInput = (event: MessageEvent<unknown>) => {
      const frame = root.current?.closest(".klecks-panels__canvas")?.querySelector("iframe");
      const data = event.data as Record<string, unknown> | null;
      if (
        frame &&
        event.source === frame.contentWindow &&
        event.origin === "patent-app://editor" &&
        data &&
        typeof data === "object" &&
        Object.keys(data).length === 3 &&
        data.type === "klecks:user-input" &&
        data.version === 1 &&
        data.nonce === new URL(frame.src).hash.slice(1)
      )
        setExpanded(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, { capture: true, passive: true });
    document.addEventListener("keydown", key);
    window.addEventListener("message", canvasInput);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("message", canvasInput);
      window.removeEventListener("resize", resize);
    };
  }, [expanded]);
  return {
    expanded,
    root,
    surface,
    toggle: () => setExpanded((value) => !value),
  };
}
