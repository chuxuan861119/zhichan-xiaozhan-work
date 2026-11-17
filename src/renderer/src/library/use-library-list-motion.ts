import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { spatialMotionTiming } from "../shared/spatial-motion";

const ITEM = "[data-library-item-key]";
const reducedMotion = () =>
  document.documentElement.dataset.reducedMotion === "true" || isMotionReduced();

/** Capture before an explicit layout change, never cache a running transform as a resting position. */
export function useLibraryListMotion(
  listRef: RefObject<HTMLElement | null>,
  layoutKey: string,
  resetKey = "",
) {
  const positions = useRef<Map<string, DOMRect> | null>(null);
  const visibleItems = useRef(new Set<HTMLElement>());
  const animations = useRef(new Set<Animation>());
  const previousReset = useRef(resetKey);
  const cancel = useCallback(() => {
    for (const animation of animations.current) animation.cancel();
    animations.current.clear();
  }, []);

  const capture = useCallback(() => {
    const items =
      typeof IntersectionObserver === "undefined"
        ? Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
        : Array.from(visibleItems.current);
    // Read every painted position before cancelling or writing any animation.
    positions.current = reducedMotion()
      ? null
      : new Map(
          items
            .filter((item) => item.isConnected && !item.closest("[inert], [hidden]"))
            .map((item) => [item.dataset.libraryItemKey ?? "", item.getBoundingClientRect()]),
        );
    cancel();
  }, [cancel, listRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey schedules measurement after the corresponding DOM layout change.
  useLayoutEffect(() => {
    const previous = positions.current;
    positions.current = null;
    cancel();
    const reset = previousReset.current !== resetKey;
    previousReset.current = resetKey;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
    if (previous && !reset && !reducedMotion()) {
      const moves = items.flatMap((item) => {
        const from = previous.get(item.dataset.libraryItemKey ?? "");
        if (!from || item.closest("[inert], [hidden]")) return [];
        const to = item.getBoundingClientRect();
        if (to.bottom < 0 || to.top > window.innerHeight) return [];
        return [{ item, x: from.left - to.left, y: from.top - to.top }];
      });
      const timing = spatialMotionTiming(Math.max(0, ...moves.map(({ x, y }) => Math.hypot(x, y))));
      for (const { item, x, y } of moves) {
        if ((x === 0 && y === 0) || typeof item.animate !== "function") continue;
        const animation = item.animate(
          [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
          timing,
        );
        animations.current.add(animation);
        animation.onfinish = () => animations.current.delete(animation);
      }
    }
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const item = entry.target as HTMLElement;
          if (entry.isIntersecting) visibleItems.current.add(item);
          else visibleItems.current.delete(item);
        }
      },
      { root: listRef.current?.closest(".library-view") ?? null, rootMargin: "180px" },
    );
    for (const item of items) observer.observe(item);
    return () => {
      observer.disconnect();
      visibleItems.current.clear();
    };
  }, [layoutKey, resetKey, listRef, cancel]);

  useLayoutEffect(() => cancel, [cancel]);
  return capture;
}
