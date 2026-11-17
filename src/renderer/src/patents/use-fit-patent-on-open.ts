import { useEffect, useRef } from "react";
import { DUAL_PANE_COLLAPSED_RAIL, DUAL_PANE_COMPACT_RULER } from "./dual-pane-layout-budget";
import { DOCUMENT_ZOOM_FRAME } from "./use-smooth-document-zoom";

export function fitPatentOpenZoom(
  width: number,
  pageWidth: number,
  ruler: number,
  hasRail: boolean,
) {
  const rail = hasRail ? DUAL_PANE_COLLAPSED_RAIL : 0;
  const compactRuler = ruler > 0 ? DUAL_PANE_COMPACT_RULER : 0;
  // Controls release space before the page shrinks. Their current presentation
  // must never feed back into the cap or overwrite the user's reading preference.
  return Math.max(
    1,
    Math.min(200, Math.floor(((width - compactRuler - rail - 1) / pageWidth) * 100)),
  );
}

/** Report viewport limits without modifying the remembered display zoom. */
export function useFitPatentOnOpen(
  key: string | null,
  enabled: boolean,
  onFit: (zoom: number) => void,
  zoomPercent = 100,
) {
  const fit = useRef(onFit);
  fit.current = onFit;
  const target = useRef(zoomPercent);
  target.current = zoomPercent;
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!key) return;
    let frame = 0;
    let disposed = false;
    let lastZoom = -1;
    let observedLayout: HTMLElement | null = null;
    const managedLayouts = new Set<HTMLElement>();
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    let lastMeasurement = "";
    const observer = new MutationObserver(() => schedule());
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const layout = [
        ...document.querySelectorAll<HTMLElement>(
          ".patent-editor-workspace .patent-page-with-rail",
        ),
      ].find(
        (e) =>
          !e.closest("[hidden], .dual-document-pane") &&
          getComputedStyle(e).visibility !== "hidden" &&
          e.getBoundingClientRect().width > 0,
      );
      if (!layout || layout.classList.contains("dual-column-layout")) return;
      const page = layout.querySelector<HTMLElement>(
        ":scope > .patent-page-zoom-frame, :scope > .drawings-editor, :scope > .drawing-page",
      );
      if (!page?.offsetWidth || !layout.clientWidth) return;
      const ruler = Number.parseFloat(getComputedStyle(layout).gridTemplateColumns) || 0;
      const hasRail = Boolean(
        layout.querySelector(
          ":scope > .patent-function-rail-measurement-anchor, :scope > .patent-global-function-rail-slot",
        ),
      );
      const measurement = `${layout.clientWidth}/${page.offsetWidth}/${ruler}/${hasRail}`;
      // Opening mounts the editor and its sidebars together; wait for a stable layout sample.
      if (measurement !== lastMeasurement) {
        lastMeasurement = measurement;
        schedule();
        return;
      }
      observer.disconnect();
      if (observedLayout !== layout) {
        resize?.disconnect();
        resize?.observe(layout);
        resize?.observe(page);
        observedLayout = layout;
      }
      const limit = fitPatentOpenZoom(layout.clientWidth, page.offsetWidth, ruler, hasRail);
      managedLayouts.add(layout);
      const pageTarget = String(Math.min(target.current, limit) / 100);
      layout.dataset.pageHasRail = String(hasRail);
      if (layout.dataset.pageZoomTarget !== pageTarget) {
        layout.dataset.pageZoomTarget = pageTarget;
        layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
      }
      if (limit !== lastZoom) {
        lastZoom = limit;
        fit.current(limit);
      }
    };
    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(measure);
    }
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    scheduleRef.current = schedule;
    schedule();
    return () => {
      disposed = true;
      scheduleRef.current = null;
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      for (const layout of managedLayouts) {
        delete layout.dataset.pageZoomTarget;
        delete layout.dataset.pageHasRail;
        delete layout.dataset.paneRulerCompact;
        delete layout.dataset.paneRailSpace;
      }
    };
  }, [key, enabled]);
  // A new zoom target participates in the control budget before its animation finishes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: schedule the new target stored in the ref.
  useEffect(() => scheduleRef.current?.(), [zoomPercent]);
}
