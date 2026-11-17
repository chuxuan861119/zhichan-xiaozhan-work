import { useLayoutEffect, useRef } from "react";
import {
  prefersReducedMotion as isMotionReduced,
  subscribeMotionPreference,
} from "../shared/motion-preference";
import { dualDocumentResizeIsActive } from "./dual-document-resize";

export const DOCUMENT_ZOOM_FRAME = "patent-document-zoom-frame";
export const DOCUMENT_ZOOM_DIRECT = "patent-document-zoom-direct";
const DURATION_MS = 160;

/** Animate only the page geometry; document content and persisted zoom remain React-owned. */
export function useSmoothDocumentZoom(
  viewport: HTMLElement | null,
  zoomPercent: number,
  animate = true,
  documentKey?: string,
) {
  const displayed = useRef<{ layout: HTMLElement; value: number } | null>(null);
  const stopAnimation = useRef<(() => void) | null>(null);
  const retargetAnimation = useRef<((target: number) => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a replacement document may mount new layout DOM in the same viewport.
  useLayoutEffect(() => {
    const layout = viewport?.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
    if (!viewport || !layout || !page) return;
    const applyDirectZoom = (event: Event) => {
      const target = (event as CustomEvent<{ scale?: number }>).detail?.scale;
      if (!Number.isFinite(target) || target === undefined || target <= 0) return;
      stopAnimation.current?.();
      const computed =
        Number.parseFloat(getComputedStyle(layout).getPropertyValue("--patent-page-zoom")) || 1;
      const start = displayed.current?.layout === layout ? displayed.current.value : computed;
      if (start === target) return;
      const top =
        page.getBoundingClientRect().top +
        viewport.scrollTop -
        viewport.getBoundingClientRect().top;
      const scroll = viewport.scrollTop;
      layout.style.setProperty("--patent-page-zoom", String(target));
      displayed.current = { layout, value: target };
      viewport.scrollTop = scroll === 0 ? 0 : top + ((scroll - top) / start) * target;
      layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
    };
    layout.addEventListener(DOCUMENT_ZOOM_DIRECT, applyDirectZoom);
    return () => {
      layout.removeEventListener(DOCUMENT_ZOOM_DIRECT, applyDirectZoom);
      stopAnimation.current?.();
    };
  }, [viewport, documentKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect the displayed scale when the document DOM changes.
  useLayoutEffect(() => {
    const layout = viewport?.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
    if (!viewport || !layout || !page) return;
    let target = zoomPercent / 100;
    if (
      displayed.current?.layout !== layout ||
      viewport.closest("[hidden]") ||
      getComputedStyle(viewport).visibility === "hidden"
    ) {
      stopAnimation.current?.();
      displayed.current = { layout, value: target };
      return;
    }
    let start = displayed.current.value;
    if (start === target) {
      stopAnimation.current?.();
      return;
    }
    // React has written the new target. Restore the last painted value before measuring.
    layout.style.setProperty("--patent-page-zoom", String(start));
    if (!animate || dualDocumentResizeIsActive(viewport)) {
      stopAnimation.current?.();
      const top =
        page.getBoundingClientRect().top +
        viewport.scrollTop -
        viewport.getBoundingClientRect().top;
      const scroll = viewport.scrollTop;
      layout.style.setProperty("--patent-page-zoom", String(target));
      displayed.current = { layout, value: target };
      viewport.scrollTop = scroll === 0 ? 0 : top + ((scroll - top) / start) * target;
      layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
      return;
    }
    if (retargetAnimation.current) {
      retargetAnimation.current(target);
      return;
    }
    const oldAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
    let readingAnchor =
      (viewport.getBoundingClientRect().top +
        viewport.clientHeight / 3 -
        page.getBoundingClientRect().top) /
      start;
    let lastScrollTop = viewport.scrollTop;
    let keepTop = lastScrollTop === 0;
    let frame = 0;
    let started: number | null = null;
    let lastTick: number | null = null;
    let unsubscribe = () => {};
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      cancelAnimationFrame(frame);
      viewport.style.overflowAnchor = oldAnchor;
      if (stopAnimation.current === stop) stopAnimation.current = null;
      retargetAnimation.current = null;
    };
    stopAnimation.current = stop;
    // Keep the frame loop and reading anchor alive while input changes the target.
    // Restarting the effect on every wheel frame otherwise starves its first tick.
    retargetAnimation.current = (next) => {
      start = displayed.current!.value;
      target = next;
      started = lastTick;
    };
    const apply = (value: number) => {
      const before = page.getBoundingClientRect();
      // Keep one content anchor; re-deriving it from rounded scroll offsets each
      // frame accumulates drift. Still honor scrolling performed between frames.
      readingAnchor += (viewport.scrollTop - lastScrollTop) / displayed.current!.value;
      if (viewport.scrollTop !== lastScrollTop) keepTop = false;
      layout.style.setProperty("--patent-page-zoom", String(value));
      displayed.current = { layout, value };
      if (keepTop) viewport.scrollTop = 0;
      else if (before.height > 0) {
        const after = page.getBoundingClientRect();
        const nextReadingY = viewport.getBoundingClientRect().top + viewport.clientHeight / 3;
        viewport.scrollTop += after.top + readingAnchor * value - nextReadingY;
      }
      lastScrollTop = viewport.scrollTop;
      layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
    };
    const tick = (time: number) => {
      if (stopped) return;
      started ??= time;
      lastTick = time;
      const progress = isMotionReduced() ? 1 : Math.min(1, (time - started) / DURATION_MS);
      apply(progress === 1 ? target : start + (target - start) * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else stop();
    };
    if (isMotionReduced()) {
      apply(target);
      stop();
    } else {
      frame = requestAnimationFrame(tick);
      unsubscribe = subscribeMotionPreference(() => {
        if (isMotionReduced()) {
          cancelAnimationFrame(frame);
          apply(target);
          stop();
        }
      });
    }
  }, [viewport, zoomPercent, animate, documentKey]);
}
