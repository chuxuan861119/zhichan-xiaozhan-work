import { type RefObject, useEffect, useRef } from "react";
import { DOCUMENT_STRUCTURE_RULER_GAP } from "../document-structure-ruler-state";
import {
  DUAL_DOCUMENT_RESIZE_SETTLED_EVENT,
  dualDocumentResizeIsActive,
} from "../dual-document-resize";
import {
  DUAL_PANE_COLLAPSED_RAIL,
  DUAL_PANE_RULER,
  dualPaneRulerIsCompact,
} from "../dual-pane-layout-budget";
import { DOCUMENT_ZOOM_FRAME } from "../use-smooth-document-zoom";
import { usePatentFunctionRail } from "./function-rail-context";
import {
  FUNCTION_RAIL_EXPANDED_WIDTH,
  FUNCTION_RAIL_GAP,
  type FunctionRailSpace,
  nextFunctionRailSpace,
} from "./function-rail-state";

export type InlineRect = Pick<DOMRect, "left" | "right" | "width">;

const PAGE_SELECTOR = [
  ":scope > .patent-page-zoom-frame",
  ":scope > .drawings-editor",
  ":scope > .drawing-page",
].join(", ");

export function measureFunctionRailSpace(
  previous: FunctionRailSpace,
  scopeRect: InlineRect,
  pageRect: InlineRect,
  structureRulerReservation = 0,
): FunctionRailSpace | null {
  if (scopeRect.width <= 0 || pageRect.width <= 0) return null;

  return nextFunctionRailSpace(
    previous,
    scopeRect.width,
    pageRect.width,
    structureRulerReservation,
  );
}

function selectPage(slotElement: HTMLElement | null): HTMLElement | null {
  const layout = slotElement?.closest<HTMLElement>(".patent-page-with-rail");
  if (!layout) return null;

  const candidates = [...layout.querySelectorAll<HTMLElement>(PAGE_SELECTOR)];
  return (
    candidates.find((candidate) => candidate.getBoundingClientRect().width > 0) ??
    candidates[0] ??
    null
  );
}

function selectStructureRuler(slotElement: HTMLElement | null): HTMLElement | null {
  const layout = slotElement?.closest<HTMLElement>(".patent-page-with-rail");
  return layout?.querySelector<HTMLElement>(":scope > .document-structure-ruler") ?? null;
}

export function useFunctionRailMeasurement(
  slotRef: RefObject<HTMLElement | null>,
  measurementKey?: number,
  onBeforeSpaceChange?: () => void,
): void {
  const beforeSpaceChange = useRef(onBeforeSpaceChange);
  beforeSpaceChange.current = onBeforeSpaceChange;
  const { scopeKey, scopeElement, space, setSpace, userIntent } = usePatentFunctionRail();
  const currentSpace = useRef(space);
  const scheduleMeasurementRef = useRef<(() => void) | null>(null);
  currentSpace.current = space;

  useEffect(() => {
    if (!scopeElement) return;

    let observedPage: HTMLElement | null = null;
    let observedRuler: HTMLElement | null = null;
    let observedLayout: HTMLElement | null = null;
    let frameId: number | null = null;

    const observer = new ResizeObserver(() => scheduleMeasurement());

    const reconnectPage = (nextPage: HTMLElement | null) => {
      if (nextPage === observedPage) return;
      if (observedPage) observer.unobserve(observedPage);
      observedPage = nextPage;
      if (observedPage) observer.observe(observedPage);
    };

    const reconnectRuler = (nextRuler: HTMLElement | null) => {
      if (nextRuler === observedRuler) return;
      if (observedRuler) observer.unobserve(observedRuler);
      observedRuler = nextRuler;
      if (observedRuler) observer.observe(observedRuler);
    };

    const measure = () => {
      frameId = null;
      const page = selectPage(slotRef.current);
      const ruler = selectStructureRuler(slotRef.current);
      const layout = slotRef.current?.closest<HTMLElement>(".patent-page-with-rail") ?? null;
      if (layout !== observedLayout) {
        if (observedLayout) observer.unobserve(observedLayout);
        observedLayout = layout;
        if (layout) observer.observe(layout);
      }
      reconnectPage(page);
      reconnectRuler(ruler);
      if (!page || !layout) return;
      // Retained book surfaces keep their geometry while invisible. They share
      // the rail controller, but must not overwrite the active book's space.
      if (layout.closest("[hidden]") || getComputedStyle(layout).visibility === "hidden") return;
      const rulerWidth = ruler?.getBoundingClientRect().width ?? 0;
      // The grid reserves room even while the ruler uses its compact appearance.
      const gridReservation = Number.parseFloat(getComputedStyle(layout).gridTemplateColumns);
      const structureRulerReservation = Number.isFinite(gridReservation)
        ? gridReservation
        : rulerWidth > 0
          ? rulerWidth + DOCUMENT_STRUCTURE_RULER_GAP
          : 0;

      const dual = scopeKey === "left" || scopeKey === "right";
      const hasRulerReservation =
        Boolean(ruler) ||
        layout.dataset.structureRuler === "true" ||
        layout.dataset.structureRulerOffset === "true";
      const pageRect = page.getBoundingClientRect();
      const managedSingle = !dual && layout.dataset.pageZoomTarget !== undefined;
      const targetScale =
        Number(dual ? layout.dataset.paneZoomTarget : layout.dataset.pageZoomTarget) || 0;
      const renderedWidth =
        dual || managedSingle
          ? Math.max(pageRect.width, page.offsetWidth * targetScale)
          : pageRect.width;
      const nextSpace = layout.classList.contains("dual-column-layout")
        ? layout.dataset.columnRailSpace === "fits"
          ? "fits"
          : "constrained"
        : measureFunctionRailSpace(
            currentSpace.current,
            layout.getBoundingClientRect(),
            { left: pageRect.left, right: pageRect.right, width: renderedWidth },
            (dual || managedSingle) && hasRulerReservation
              ? DUAL_PANE_RULER
              : structureRulerReservation,
          );
      if ((dual || managedSingle) && nextSpace) layout.dataset.paneRailSpace = nextSpace;
      if (managedSingle && nextSpace) {
        const railWidth =
          nextSpace === "fits" && userIntent !== "collapsed"
            ? FUNCTION_RAIL_EXPANDED_WIDTH + FUNCTION_RAIL_GAP
            : DUAL_PANE_COLLAPSED_RAIL;
        const compact = String(
          hasRulerReservation &&
            dualPaneRulerIsCompact(
              layout.dataset.paneRulerCompact === "true",
              layout.getBoundingClientRect().width,
              renderedWidth,
              railWidth,
            ),
        );
        if (layout.dataset.paneRulerCompact !== compact) {
          layout.dataset.paneRulerCompact = compact;
          layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
        }
      }
      if (nextSpace === null || nextSpace === currentSpace.current) return;
      beforeSpaceChange.current?.();
      currentSpace.current = nextSpace;
      setSpace(nextSpace);
    };

    function scheduleMeasurement() {
      if (dualDocumentResizeIsActive(scopeElement) && scopeKey !== "left" && scopeKey !== "right")
        return;
      if (frameId !== null) return;
      frameId = requestAnimationFrame(measure);
    }

    scheduleMeasurementRef.current = scheduleMeasurement;
    observer.observe(scopeElement);
    scopeElement.addEventListener(DOCUMENT_ZOOM_FRAME, scheduleMeasurement);
    const dualWorkspace = scopeElement.closest<HTMLElement>(".dual-document-workspace");
    dualWorkspace?.addEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, scheduleMeasurement);
    reconnectPage(selectPage(slotRef.current));
    reconnectRuler(selectStructureRuler(slotRef.current));
    scheduleMeasurement();

    return () => {
      scheduleMeasurementRef.current = null;
      observer.disconnect();
      scopeElement.removeEventListener(DOCUMENT_ZOOM_FRAME, scheduleMeasurement);
      dualWorkspace?.removeEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, scheduleMeasurement);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [scopeElement, setSpace, slotRef, scopeKey, userIntent]);

  useEffect(() => {
    if (measurementKey === undefined) return;
    scheduleMeasurementRef.current?.();
  }, [measurementKey]);
}
