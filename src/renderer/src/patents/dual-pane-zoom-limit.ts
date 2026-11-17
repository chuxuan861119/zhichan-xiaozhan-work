import { useLayoutEffect, useRef } from "react";
import { DUAL_DOCUMENT_RESIZE_SETTLED_EVENT } from "./dual-document-resize";
import {
  DUAL_PANE_COLLAPSED_RAIL,
  DUAL_PANE_COMPACT_RULER,
  DUAL_PANE_RULER,
  dualPaneRulerIsCompact,
  fitDualPanePage,
} from "./dual-pane-layout-budget";
import {
  FUNCTION_RAIL_EXPANDED_WIDTH,
  FUNCTION_RAIL_GAP,
  nextFunctionRailSpace,
} from "./function-rail/function-rail-state";
import { DOCUMENT_ZOOM_DIRECT, DOCUMENT_ZOOM_FRAME } from "./use-smooth-document-zoom";

/** Maximum page size uses compact controls, so expanding/collapsing them cannot change the cap. */
export function dualPaneZoomLimit(
  availableWidth: number,
  pageWidth: number,
  rulerWidth = DUAL_PANE_COMPACT_RULER,
) {
  // One pixel protects fractional CSS zoom/grid rounding without losing a percent of page width.
  return Math.max(
    1,
    Math.min(200, ((availableWidth - rulerWidth - DUAL_PANE_COLLAPSED_RAIL - 1) / pageWidth) * 100),
  );
}

export function useDualPaneZoomLimit(
  viewport: HTMLElement | null,
  zoomPercent: number,
  onLimit?: (max: number) => void,
  documentKey?: string,
  onAutoFit?: (zoom: number) => void,
  displayWidthMm?: number | null,
) {
  const report = useRef(onLimit);
  report.current = onLimit;
  const autoFit = useRef(onAutoFit);
  autoFit.current = onAutoFit;
  const zoom = useRef(zoomPercent);
  zoom.current = zoomPercent;
  const measureRef = useRef<(() => void) | null>(null);
  const enabled = Boolean(onLimit);
  const automatic = Boolean(onAutoFit);
  // biome-ignore lint/correctness/useExhaustiveDependencies: document changes replace the page DOM in the same viewport.
  useLayoutEffect(() => {
    if (!enabled || !viewport) return;
    const layout = viewport.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
    if (!layout || !page) return;
    let lastSize = "";
    const measureLayout = () => {
      if (
        !viewport.clientWidth ||
        !page.offsetWidth ||
        viewport.closest("[hidden]") ||
        getComputedStyle(viewport).visibility === "hidden"
      )
        return;
      const style = getComputedStyle(viewport);
      const width =
        viewport.clientWidth -
        Number.parseFloat(style.paddingLeft || "0") -
        Number.parseFloat(style.paddingRight || "0");
      const hasRuler =
        layout.dataset.structureRuler === "true" || layout.dataset.structureRulerOffset === "true";
      const max = dualPaneZoomLimit(
        width,
        page.offsetWidth,
        hasRuler ? DUAL_PANE_COMPACT_RULER : 0,
      );
      let scale =
        Number.parseFloat(getComputedStyle(layout).getPropertyValue("--patent-page-zoom")) ||
        zoom.current / 100;
      // A resize may invalidate an in-flight zoom. Clamp its paint and React state together.
      if (scale > max / 100 + 0.0001) {
        layout.dispatchEvent(
          new CustomEvent(DOCUMENT_ZOOM_DIRECT, { detail: { scale: max / 100 } }),
        );
        scale = max / 100;
      }
      report.current?.(max);
      const size = `${width}:${page.offsetWidth}`;
      if (automatic && size !== lastSize) {
        lastSize = size;
        const fit = fitDualPanePage(width, page.offsetWidth, 0, undefined, displayWidthMm);
        autoFit.current?.(Math.min(max, fit.fitScale * 100));
      }
      const renderedWidth =
        page.offsetWidth * Math.min(max / 100, Math.max(scale, zoom.current / 100));
      layout.dataset.paneZoomTarget = String(Math.min(max, zoom.current) / 100);
      const currentSpace =
        layout.dataset.paneRailSpace === "fits" ||
        (!layout.dataset.paneRailSpace &&
          layout.querySelector(':scope > .patent-global-function-rail-slot[data-layout="docked"]'))
          ? "fits"
          : "constrained";
      const space = nextFunctionRailSpace(
        currentSpace,
        width,
        renderedWidth,
        hasRuler ? DUAL_PANE_RULER : 0,
      );
      layout.dataset.paneRailSpace = space;
      const docked =
        space === "fits" &&
        layout.querySelector(
          ':scope > .patent-global-function-rail-slot[data-layout="docked"][data-expanded="true"]',
        );
      const railWidth = docked
        ? FUNCTION_RAIL_EXPANDED_WIDTH + FUNCTION_RAIL_GAP
        : DUAL_PANE_COLLAPSED_RAIL;
      layout.dataset.paneRulerCompact = String(
        hasRuler &&
          dualPaneRulerIsCompact(
            layout.dataset.paneRulerCompact === "true",
            width,
            renderedWidth,
            railWidth,
          ),
      );
    };
    // Direct paint emits DOCUMENT_ZOOM_FRAME synchronously. Do not recursively
    // repeat layout reads, state reports and control decisions for the same size.
    let measuring = false;
    const measure = () => {
      if (measuring) return;
      measuring = true;
      try {
        measureLayout();
      } finally {
        measuring = false;
      }
    };
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(page);
    const railObserver = new MutationObserver(measure);
    const scope = viewport.closest(".patent-function-rail-scope");
    railObserver.observe(scope ?? viewport, {
      attributes: true,
      attributeFilter: ["data-layout", "data-expanded"],
      subtree: true,
      childList: true,
    });
    layout.addEventListener(DOCUMENT_ZOOM_FRAME, measure);
    const workspace = viewport.closest<HTMLElement>(".dual-document-workspace");
    workspace?.addEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, measure);
    measure();
    return () => {
      measureRef.current = null;
      observer.disconnect();
      railObserver.disconnect();
      layout.removeEventListener(DOCUMENT_ZOOM_FRAME, measure);
      workspace?.removeEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, measure);
      delete layout.dataset.paneRulerCompact;
      delete layout.dataset.paneZoomTarget;
      delete layout.dataset.paneRailSpace;
    };
  }, [viewport, enabled, automatic, documentKey, displayWidthMm]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure the new zoom target before its first painted frame.
  useLayoutEffect(() => {
    measureRef.current?.();
  }, [zoomPercent]);
}
