import { type RefObject, useLayoutEffect } from "react";

export function measureDockedRailViewport(slot: HTMLElement) {
  let top = 0;
  let bottom = window.innerHeight;
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue;
    const edge = parent.getBoundingClientRect().top + parent.clientTop;
    top = Math.max(top, edge);
    bottom = Math.min(bottom, edge + parent.clientHeight);
  }
  return { offset: top - slot.getBoundingClientRect().top, height: Math.max(0, bottom - top) };
}

export function measureRailVisibleHeight(slot: HTMLElement): number {
  let top = Math.max(0, slot.getBoundingClientRect().top);
  let bottom = window.innerHeight;
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/auto|scroll|hidden|clip/.test(style.overflowY)) continue;
    top = Math.max(top, parent.getBoundingClientRect().top + parent.clientTop);
    bottom = Math.min(
      bottom,
      // Sticky positioning is constrained by the content bottom, not the
      // scrollport's padding. Keep that padding out of the rail's height.
      parent.getBoundingClientRect().top +
        parent.clientTop +
        parent.clientHeight -
        (Number.parseFloat(style.paddingBottom) || 0),
    );
  }
  const configuredGap = Number.parseFloat(
    getComputedStyle(slot).getPropertyValue("--rail-bottom-gap"),
  );
  const bottomGap = Number.isFinite(configuredGap) ? Math.max(0, configuredGap) : 12;
  return Math.max(0, Math.floor(bottom - top - bottomGap));
}

export function useRailVisibleHeight(
  ref: RefObject<HTMLElement | null>,
  stateKey: string,
  portalHost: HTMLElement | null = null,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: A portal host change replaces the ref node without changing the expanded layout state.
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot || stateKey.endsWith(":false")) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (slot.dataset.layout === "docked") {
        const viewport = measureDockedRailViewport(slot);
        slot.style.setProperty("--rail-viewport-offset", `${viewport.offset}px`);
        slot.style.setProperty("--rail-visible-height", `${viewport.height}px`);
        return;
      }
      slot.style.setProperty("--rail-visible-height", `${measureRailVisibleHeight(slot)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent);
    }
    measure();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [ref, stateKey, portalHost]);
}
