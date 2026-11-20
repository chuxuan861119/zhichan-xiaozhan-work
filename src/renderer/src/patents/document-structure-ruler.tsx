import type { Transaction } from "@tiptap/pm/state";
import {
  type CSSProperties,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PatentBookDocument } from "../../../shared/document/model";
import type { DocumentStructureRulerMarker } from "../../../shared/patent/document-structure-ruler";
import type { PatentFigure } from "../../../shared/patent/model";
import type { EditorCommandBus } from "../app/command-bus";
import { CONTENT_PAINT_FRAME } from "../editor/extensions/content-layout-paint";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { AdaptiveRulerScheduler, isComplexRulerDocument } from "./adaptive-ruler-scheduler";
import {
  clampDocumentStructureRulerOffset,
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT,
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP,
  DOCUMENT_STRUCTURE_RULER_RESUME_WINDOW_MS,
  DOCUMENT_STRUCTURE_RULER_TARGET_FLASH_MS,
  DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH,
  type DocumentStructureRulerMode,
  documentStructureRulerCenterIndex,
  documentStructureRulerNavigationTop,
  nearestDocumentStructureRulerMarkerIndex,
  nextDocumentStructureRulerMode,
} from "./document-structure-ruler-state";
import { DualColumnContext } from "./dual-column-context";
import {
  DUAL_DOCUMENT_RESIZE_SETTLED_EVENT,
  dualDocumentResizeIsActive,
} from "./dual-document-resize";
import { rulerClusterLabel, rulerMarkerClusters } from "./ruler-marker-clusters";
import { RulerNavigationPopover } from "./ruler-navigation-popover";
import type { RulerPopoverAnchor } from "./ruler-popover-position";
import { RulerSelectionNavigation } from "./ruler-selection-navigation";
import { useAdaptiveRulerModel } from "./use-adaptive-ruler-model";
import { DOCUMENT_ZOOM_FRAME } from "./use-smooth-document-zoom";

type MarkerGeometry = Readonly<{
  top: number;
  height: number;
}>;

type LocatedBlock = Readonly<{
  position: number;
  element: HTMLElement;
}>;

type NavigationState = Readonly<{
  anchorMarkerId: string;
  centerY: number;
  visibleHeight: number;
  panelTop: number;
  panelLeft: number;
  panelHeight: number;
  panelClipTop: number;
}>;

type RetainedNavigation = Readonly<{
  navigation: NavigationState;
  centerMarkerId: string | null;
}>;

type EditorRulerProps = Readonly<{
  document: PatentBookDocument;
  bookKind: "claims" | "description";
  editorId: string;
  commandBus: EditorCommandBus;
  measurementKey?: number;
  figures?: never;
  selectedFigureId?: never;
  onActivateFigure?: never;
}>;

type DrawingRulerProps = Readonly<{
  document?: never;
  bookKind?: never;
  editorId?: never;
  commandBus?: never;
  measurementKey?: number;
  figures: readonly PatentFigure[];
  selectedFigureId: string | null;
  onActivateFigure(figureId: string): void;
}>;

type DocumentStructureRulerProps = EditorRulerProps | DrawingRulerProps;

const RULER_LABEL_HEIGHT_PX = 22;
const RULER_SCROLL_SETTLE_MS = 80;
const RULER_HOVER_DELAY_MS = 300;

function getFirstLineCenterOffset(element: HTMLElement, zoom: number): number {
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  if (!Number.isFinite(lineHeight)) return 0;
  return Math.max(0, (lineHeight * zoom - RULER_LABEL_HEIGHT_PX) / 2);
}

export function DocumentStructureRuler(props: DocumentStructureRulerProps) {
  const dualColumn = useContext(DualColumnContext);
  const model = useAdaptiveRulerModel(props);
  const currentDocumentRef = useRef(props.document);
  currentDocumentRef.current = props.document;
  // Model work and DOM measurement have different costs. Measure each rather
  // than letting a cheap cached model hide an expensive layout pass.
  // biome-ignore lint/correctness/useExhaustiveDependencies: timing belongs to this book/editor, not its individual model revisions.
  const geometryScheduler = useMemo(
    () =>
      new AdaptiveRulerScheduler(
        (measure: () => void) => measure(),
        () => undefined,
      ),
    [props.editorId, props.bookKind],
  );
  const { markers } = model;
  const hostRef = useRef<HTMLElement | null>(null);
  const scheduleMeasurementRef = useRef<(() => void) | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const locatedBlocksRef = useRef(new Map<string, LocatedBlock>());
  const flashedElementRef = useRef<HTMLElement | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelActiveTimerRef = useRef<number | null>(null);
  const navigationOffsetRef = useRef(0);
  const navigationRef = useRef<NavigationState | null>(null);
  const retainedNavigationRef = useRef<RetainedNavigation | null>(null);
  const centerMarkerIdRef = useRef<string | null>(null);
  const [mode, setMode] = useState<DocumentStructureRulerMode>("wide");
  const [pageHeight, setPageHeight] = useState(0);
  const [geometry, setGeometry] = useState<ReadonlyMap<string, MarkerGeometry>>(new Map());
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationState | null>(null);
  const [centerMarkerId, setCenterMarkerId] = useState<string | null>(null);
  const [popover, setPopover] = useState<{
    anchor: RulerPopoverAnchor;
    currentId: string | null;
  } | null>(null);
  const popoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelNavigationHover = useCallback(() => {
    if (navigationHoverTimer.current !== null) clearTimeout(navigationHoverTimer.current);
    navigationHoverTimer.current = null;
  }, []);
  const keepPopover = () => {
    if (popoverCloseTimer.current !== null) clearTimeout(popoverCloseTimer.current);
    popoverCloseTimer.current = null;
  };
  const closePopoverLater = () => {
    keepPopover();
    popoverCloseTimer.current = setTimeout(() => setPopover(null), 180);
  };
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".ruler-navigation-popover"))
        return;
      cancelNavigationHover();
      setPopover(null);
    };
    const exclusive = (event: Event) => {
      if ((event as CustomEvent).detail !== hostRef.current) {
        cancelNavigationHover();
        setPopover(null);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelNavigationHover();
        setPopover(null);
      }
    };
    const selectionStart = () => {
      cancelNavigationHover();
      setPopover(null);
      setNavigation(null);
      navigationRef.current = null;
      retainedNavigationRef.current = null;
    };
    document.addEventListener("ruler-selection-start", selectionStart);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("ruler-popover-open", exclusive);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("ruler-popover-open", exclusive);
      document.removeEventListener("ruler-selection-start", selectionStart);
      if (popoverCloseTimer.current !== null) clearTimeout(popoverCloseTimer.current);
      cancelNavigationHover();
    };
  }, [cancelNavigationHover]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the document or figure invalidates navigation even when the reset does not read those values.
  useEffect(() => {
    cancelNavigationHover();
    setPopover(null);
    setNavigation(null);
    navigationRef.current = null;
    retainedNavigationRef.current = null;
  }, [mode, props.editorId, props.selectedFigureId, cancelNavigationHover]);
  const selectedFigureMarkerId = useMemo(() => {
    if (!props.figures || !props.selectedFigureId) return null;
    return markers.find((marker) => marker.targetBlockId === props.selectedFigureId)?.id ?? null;
  }, [markers, props.figures, props.selectedFigureId]);
  const activeMarkerId =
    hoveredMarkerId ?? (props.figures ? selectedFigureMarkerId : selectedMarkerId);
  const navigableMarkerIds = useMemo(
    () => markers.flatMap((marker) => (geometry.has(marker.id) ? [marker.id] : [])),
    [geometry, markers],
  );
  const navigableMarkerKey = navigableMarkerIds.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: The joined key preserves value-based memoization across equivalent arrays.
  const navigationIndexById = useMemo(
    () => new Map(navigableMarkerIds.map((markerId, index) => [markerId, index])),
    [navigableMarkerKey],
  );

  navigationRef.current = navigation;
  centerMarkerIdRef.current = centerMarkerId;

  const pageElement = (layout: HTMLElement | null | undefined) =>
    layout?.querySelector<HTMLElement>(
      props.figures ? ":scope > .drawing-page" : ":scope > .patent-page-zoom-frame",
    );

  useLayoutEffect(() => {
    const host = hostRef.current;
    const layout = host?.closest<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(
      props.figures ? ":scope > .drawing-page" : ":scope > .patent-page-zoom-frame",
    );
    if (!host || !layout || !page) return;
    const availableSpace = layout.closest<HTMLElement>(".editor-workspace") ?? layout;
    const pairs = props.figures ? page.querySelector<HTMLElement>(".drawing-pairs-scroll") : null;
    const scrollHost = host;

    let frameId: number | null = null;
    let scrollSettleTimer: number | null = null;
    let observedEditor: HTMLElement | null = null;
    const observer = new ResizeObserver(() => {
      // Marker measurement may be deferred, but stale ruler height must not
      // hold the grid's scroll extent open for a frame after a bottom edit.
      // ResizeObserver runs before paint; keep the existing layout footprint
      // in step with the actual page without changing width/navigation rules.
      const height = page.getBoundingClientRect().height;
      if (height > 0) host.style.height = `${height}px`;
      scheduleMeasurement();
    });

    const reconnectEditor = (element: HTMLElement | null) => {
      if (element === observedEditor) return;
      if (observedEditor) observer.unobserve(observedEditor);
      observedEditor = element;
      if (observedEditor) observer.observe(observedEditor);
    };

    const measure = () => {
      frameId = null;
      const pageRect = page.getBoundingClientRect();
      // The grid reserves the full ruler slot in both modes. Judge that slot's
      // visible space, not whether the page and the right rail fit as a whole.
      const viewportRect = availableSpace.getBoundingClientRect();
      const visibleLeft = Math.max(0, viewportRect.left + availableSpace.clientLeft);
      const rulerRight = Math.min(pageRect.left, viewportRect.right, window.innerWidth);
      const dualWidth = Number.parseFloat(layout.style.getPropertyValue("--column-ruler-width"));
      setMode(
        layout.dataset.paneRulerCompact === "true"
          ? "compact"
          : nextDocumentStructureRulerMode(
              Number.isFinite(dualWidth) ? dualWidth : Math.max(0, rulerRight - visibleLeft),
            ),
      );
      setPageHeight(pageRect.height);

      const locatedBlocks = props.figures
        ? locateFigureRows(page, props.figures)
        : locateEditorBlocks(
            props.commandBus.getEditor(props.editorId),
            new Set(markers.flatMap((marker) => [marker.targetBlockId, marker.endBlockId])),
          );
      locatedBlocksRef.current = locatedBlocks;
      const nextGeometry = new Map<string, MarkerGeometry>();
      const zoom = Number.parseFloat(layout.style.getPropertyValue("--patent-page-zoom")) || 1;
      const rectangles = new Map<HTMLElement, DOMRect>();
      const firstLineOffsets = new Map<HTMLElement, number>();
      const readRect = (element: HTMLElement) => {
        let value = rectangles.get(element);
        if (!value) {
          value = element.getBoundingClientRect();
          rectangles.set(element, value);
        }
        return value;
      };
      for (const marker of markers) {
        const start = locatedBlocks.get(marker.targetBlockId)?.element;
        if (!start) continue;
        const startRect = readRect(start);
        if (props.figures) {
          const top = Math.max(
            0,
            startRect.top - pageRect.top + (startRect.height - RULER_LABEL_HEIGHT_PX) / 2,
          );
          nextGeometry.set(marker.id, {
            top,
            // Keep the centered label and hit area, without extending the workspace past the page.
            height: Math.min(Math.max(18, startRect.height), pageRect.height - top),
          });
          continue;
        }
        const end = locatedBlocks.get(marker.endBlockId)?.element ?? start;
        const endRect = readRect(end);
        const firstLineCenterOffset =
          firstLineOffsets.get(start) ?? getFirstLineCenterOffset(start, zoom);
        firstLineOffsets.set(start, firstLineCenterOffset);
        const virtualOffset = getVirtualMarkerOffset(marker, markers);
        nextGeometry.set(marker.id, {
          top: Math.max(0, startRect.top - pageRect.top + firstLineCenterOffset + virtualOffset),
          height: marker.virtual
            ? 18
            : Math.max(18, endRect.bottom - startRect.top - firstLineCenterOffset),
        });
      }
      setGeometry((current) => {
        if (current.size !== nextGeometry.size) return nextGeometry;
        for (const [id, next] of nextGeometry) {
          const previous = current.get(id);
          if (!previous || previous.top !== next.top || previous.height !== next.height)
            return nextGeometry;
        }
        return current;
      });
    };

    function scheduleMeasurement() {
      if (dualDocumentResizeIsActive(layout)) {
        // Apply the pane's control budget immediately; defer expensive marker geometry until release.
        const compact = layout?.dataset.paneRulerCompact;
        if (compact !== undefined) setMode(compact === "true" ? "compact" : "wide");
        return;
      }
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        measureAdaptively();
      });
    }

    function handleScroll() {
      scrollHost.dataset.scrollActive = "true";
      if (scrollSettleTimer !== null) window.clearTimeout(scrollSettleTimer);
      scrollSettleTimer = window.setTimeout(() => {
        scrollSettleTimer = null;
        delete scrollHost.dataset.scrollActive;
      }, RULER_SCROLL_SETTLE_MS);
      scheduleMeasurement();
    }

    function measureAdaptively() {
      const document = currentDocumentRef.current;
      geometryScheduler.update(measure, document ? isComplexRulerDocument(document) : false);
    }

    const editor = props.figures ? null : props.commandBus.getEditor(props.editorId);
    const handleEditorUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) scheduleMeasurement();
    };
    editor?.on("transaction", handleEditorUpdate);
    observer.observe(layout);
    observer.observe(page);
    if (availableSpace !== layout) observer.observe(availableSpace);
    if (props.figures) {
      const observedRows = new Set<Element>();
      page.querySelectorAll("[data-figure-id]").forEach((row) => {
        if (observedRows.has(row)) return;
        observedRows.add(row);
        observer.observe(row);
      });
      pairs?.addEventListener("scroll", handleScroll, { passive: true });
    } else {
      reconnectEditor(editor?.view.dom ?? null);
    }
    window.addEventListener("resize", scheduleMeasurement);
    layout.addEventListener(DOCUMENT_ZOOM_FRAME, scheduleMeasurement);
    layout.addEventListener(CONTENT_PAINT_FRAME, scheduleMeasurement);
    const dualWorkspace = layout.closest<HTMLElement>(".dual-document-workspace");
    dualWorkspace?.addEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, scheduleMeasurement);
    availableSpace.addEventListener("scroll", handleScroll, { passive: true });
    const layoutObserver = new MutationObserver(scheduleMeasurement);
    layoutObserver.observe(layout, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-layout", "data-pane-ruler-compact"],
    });
    scheduleMeasurementRef.current = scheduleMeasurement;
    measureAdaptively();

    return () => {
      scheduleMeasurementRef.current = null;
      editor?.off("transaction", handleEditorUpdate);
      geometryScheduler.cancel();
      observer.disconnect();
      layout.removeEventListener(DOCUMENT_ZOOM_FRAME, scheduleMeasurement);
      layout.removeEventListener(CONTENT_PAINT_FRAME, scheduleMeasurement);
      dualWorkspace?.removeEventListener(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, scheduleMeasurement);
      layoutObserver.disconnect();
      availableSpace.removeEventListener("scroll", handleScroll);
      pairs?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", scheduleMeasurement);
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (scrollSettleTimer !== null) window.clearTimeout(scrollSettleTimer);
      delete scrollHost.dataset.scrollActive;
    };
  }, [geometryScheduler, markers, props.commandBus, props.editorId, props.figures]);

  // The parent restores the currently painted scale in its layout effect.
  // Measuring the new target synchronously here makes markers jump ahead of it.
  useLayoutEffect(() => {
    void props.measurementKey;
    scheduleMeasurementRef.current?.();
  }, [props.measurementKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The effect intentionally resets state when the marker-value key changes.
  useEffect(() => {
    cancelNavigationHover();
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    retainedNavigationRef.current = null;
    navigationOffsetRef.current = 0;
    panelRef.current?.style.setProperty("--ruler-navigation-offset", "0px");
    centerMarkerIdRef.current = null;
    setCenterMarkerId(null);
    navigationRef.current = null;
    setNavigation(null);
  }, [navigableMarkerKey, cancelNavigationHover]);

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
      if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
      if (wheelActiveTimerRef.current !== null) window.clearTimeout(wheelActiveTimerRef.current);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashedElementRef.current?.classList.remove("document-structure-ruler-target-flash");
      flashedElementRef.current = null;
    };
  }, []);

  const activateMarker = (marker: DocumentStructureRulerMarker) => {
    const located = locatedBlocksRef.current.get(marker.targetBlockId);
    const host = hostRef.current;
    const workspace = host?.closest<HTMLElement>(".editor-workspace");
    const layout = host?.closest<HTMLElement>(".patent-page-with-rail");
    const page = pageElement(layout);
    if (!located || !workspace || !page) return;

    if (props.figures) {
      props.onActivateFigure(marker.targetBlockId);
    } else {
      const editor = props.commandBus.getEditor(props.editorId);
      if (!editor || editor.isDestroyed) return;
      setSelectedMarkerId(marker.id);
      if (dualColumn && layout) {
        leaveNavigation();
        layout.dispatchEvent(
          new CustomEvent("dual-column-ruler-navigate", {
            detail: located.element.getBoundingClientRect().top - page.getBoundingClientRect().top,
          }),
        );
      }
      editor.commands.setTextSelection(located.position + 1);
      editor.commands.focus(undefined, { scrollIntoView: false });

      const workspaceRect = workspace.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const visibleTop = Math.max(workspaceRect.top, pageRect.top);
      const visibleBottom = Math.min(workspaceRect.bottom, pageRect.bottom);
      const visibleHeight = visibleBottom - visibleTop;
      const targetRect = located.element.getBoundingClientRect();
      const reducedMotion = isMotionReduced();
      if (!dualColumn)
        workspace.scrollBy({
          top: targetRect.top - visibleTop - visibleHeight / 3,
          behavior: reducedMotion ? "auto" : "smooth",
        });
    }

    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashedElementRef.current?.classList.remove("document-structure-ruler-target-flash");
    located.element.classList.add("document-structure-ruler-target-flash");
    flashedElementRef.current = located.element;
    flashTimerRef.current = window.setTimeout(() => {
      located.element.classList.remove("document-structure-ruler-target-flash");
      if (flashedElementRef.current === located.element) flashedElementRef.current = null;
      flashTimerRef.current = null;
    }, DOCUMENT_STRUCTURE_RULER_TARGET_FLASH_MS);
  };

  const enterNavigation = () => {
    cancelNavigationHover();
    if (
      hostRef.current?.closest<HTMLElement>(".patent-page-with-rail")?.dataset.rulerSelectionPending
    )
      return;
    keepPopover();
    if (popover) return;
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    const retainedNavigation = retainedNavigationRef.current;
    if (retainedNavigation && !dualColumn) {
      retainedNavigationRef.current = null;
      navigationRef.current = retainedNavigation.navigation;
      setNavigation(retainedNavigation.navigation);
      centerMarkerIdRef.current = retainedNavigation.centerMarkerId;
      setCenterMarkerId(retainedNavigation.centerMarkerId);
      return;
    }
    if (navigationRef.current) return;
    const host = hostRef.current;
    const layout = host?.closest<HTMLElement>(".patent-page-with-rail");
    const page = pageElement(layout);
    const workspace = host?.closest<HTMLElement>(".editor-workspace");
    const panel = panelRef.current;
    if (!host || !page || !workspace || !panel || navigableMarkerIds.length === 0) return;

    const pageRect = page.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const sliceTop =
      (layout?.getBoundingClientRect().top ?? workspaceRect.top) +
      (layout?.dataset.activeColumn === "1" ? 20 : 0);
    const sliceBottom = sliceTop + Number(layout?.dataset.columnHeight ?? 0);
    const visibleTop = Math.max(pageRect.top, workspaceRect.top, dualColumn ? sliceTop : -Infinity);
    const visibleBottom = Math.min(
      pageRect.bottom,
      workspaceRect.bottom,
      dualColumn ? sliceBottom : Infinity,
    );
    if (visibleBottom <= visibleTop) return;

    const centerY = (visibleTop + visibleBottom) / 2 - pageRect.top;
    const markerCenters = navigableMarkerIds.map((markerId) => {
      const markerGeometry = geometry.get(markerId);
      if (!markerGeometry) throw new Error(`Missing geometry for marker ${markerId}`);
      return markerGeometry.top + RULER_LABEL_HEIGHT_PX / 2;
    });
    const anchorIndex = nearestDocumentStructureRulerMarkerIndex(markerCenters, centerY);
    if (anchorIndex === null) return;

    if (mode === "compact") {
      const hostRect = host.getBoundingClientRect();
      window.document.dispatchEvent(new CustomEvent("ruler-popover-open", { detail: host }));
      setPopover({
        anchor: {
          left: hostRect.left,
          right: hostRect.right,
          top: visibleTop,
          bottom: visibleBottom,
        },
        currentId: navigableMarkerIds[anchorIndex] ?? null,
      });
      return;
    }

    const nextNavigation = {
      anchorMarkerId: navigableMarkerIds[anchorIndex]!,
      centerY,
      visibleHeight: visibleBottom - visibleTop,
      panelTop: dualColumn ? 0 : panelRect.top,
      panelLeft: dualColumn
        ? host.getBoundingClientRect().width - DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH
        : panelRect.right - DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH,
      panelHeight: Math.max(0, visibleBottom - (dualColumn ? pageRect.top : panelRect.top)),
      panelClipTop: Math.max(0, visibleTop - (dualColumn ? pageRect.top : panelRect.top)),
    };
    navigationOffsetRef.current = 0;
    panelRef.current?.style.setProperty("--ruler-navigation-offset", "0px");
    centerMarkerIdRef.current = nextNavigation.anchorMarkerId;
    setCenterMarkerId(nextNavigation.anchorMarkerId);
    navigationRef.current = nextNavigation;
    setNavigation(nextNavigation);
  };

  const leaveNavigation = () => {
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    const activeNavigation = navigationRef.current;
    if (!activeNavigation) return;
    retainedNavigationRef.current = {
      navigation: activeNavigation,
      centerMarkerId: centerMarkerIdRef.current,
    };
    navigationRef.current = null;
    setNavigation(null);
    centerMarkerIdRef.current = null;
    setCenterMarkerId(null);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      retainedNavigationRef.current = null;
      navigationOffsetRef.current = 0;
      panelRef.current?.style.setProperty("--ruler-navigation-offset", "0px");
    }, DOCUMENT_STRUCTURE_RULER_RESUME_WINDOW_MS);
  };

  const enterNavigationRef = useRef(enterNavigation);
  enterNavigationRef.current = enterNavigation;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleNavigationWheel = (event: WheelEvent) => {
      cancelNavigationHover();
      // Modified wheel input belongs to page zoom, including an inactive dual pane.
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      // An explicit wheel gesture bypasses the right-side hover delay. Otherwise
      // cancelling that delay would leave both navigation and document scrolling idle.
      if (!navigationRef.current) enterNavigationRef.current();
      const activeNavigation = navigationRef.current;
      if (!activeNavigation) return;
      const delta =
        event.deltaMode === 2
          ? event.deltaY * activeNavigation.visibleHeight
          : event.deltaMode === 1
            ? event.deltaY * DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP
            : event.deltaY;
      const anchorIndex = navigationIndexById.get(activeNavigation.anchorMarkerId);
      if (anchorIndex === undefined) return;
      navigationOffsetRef.current = clampDocumentStructureRulerOffset(
        navigationOffsetRef.current + delta,
        anchorIndex,
        navigableMarkerIds.length,
      );
      const panel = panelRef.current;
      if (panel) {
        panel.dataset.wheelActive = "true";
        if (wheelActiveTimerRef.current !== null) window.clearTimeout(wheelActiveTimerRef.current);
        wheelActiveTimerRef.current = window.setTimeout(() => {
          wheelActiveTimerRef.current = null;
          delete panel.dataset.wheelActive;
        }, 140);
      }
      if (wheelFrameRef.current !== null) return;
      wheelFrameRef.current = requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const currentNavigation = navigationRef.current;
        if (!currentNavigation) return;
        panelRef.current?.style.setProperty(
          "--ruler-navigation-offset",
          `${navigationOffsetRef.current}px`,
        );
        const currentAnchorIndex = navigationIndexById.get(currentNavigation.anchorMarkerId);
        if (currentAnchorIndex === undefined) return;
        const nextCenterIndex = documentStructureRulerCenterIndex(
          currentAnchorIndex,
          navigationOffsetRef.current,
          navigableMarkerIds.length,
        );
        const nextCenterMarkerId =
          nextCenterIndex === null ? null : (navigableMarkerIds[nextCenterIndex] ?? null);
        if (nextCenterMarkerId === centerMarkerIdRef.current) return;
        centerMarkerIdRef.current = nextCenterMarkerId;
        setCenterMarkerId(nextCenterMarkerId);
      });
    };

    host.addEventListener("wheel", handleNavigationWheel, { passive: false });
    return () => host.removeEventListener("wheel", handleNavigationWheel);
  }, [navigationIndexById, navigableMarkerIds, cancelNavigationHover]);

  const activateMarkerRef = useRef(activateMarker);
  activateMarkerRef.current = activateMarker;
  const onActivateMarker = useCallback(
    (marker: DocumentStructureRulerMarker) => activateMarkerRef.current(marker),
    [],
  );
  const onOpenGroup = useCallback(() => enterNavigationRef.current(), []);
  const hoverNavigation = () => {
    keepPopover();
    if (popover || navigationRef.current) return;
    cancelNavigationHover();
    const host = hostRef.current;
    const pane = host?.closest<HTMLElement>(".dual-document-pane");
    const isRightPage = pane
      ? pane.dataset.pane === "right"
      : dualColumn &&
        host?.closest<HTMLElement>(".patent-page-with-rail")?.dataset.activeColumn === "1";
    if (isRightPage) {
      navigationHoverTimer.current = setTimeout(() => {
        navigationHoverTimer.current = null;
        enterNavigationRef.current();
      }, RULER_HOVER_DELAY_MS);
    } else enterNavigationRef.current();
  };

  return (
    <>
      {!props.figures ? (
        <RulerSelectionNavigation
          host={hostRef}
          blocks={locatedBlocksRef}
          markers={markers}
          editorId={props.editorId}
          commandBus={props.commandBus}
          dualColumn={dualColumn}
          mode={mode}
        />
      ) : null}
      <aside
        ref={hostRef}
        className="document-structure-ruler"
        aria-label="文档结构标尺"
        data-mode={mode}
        data-navigation={navigation ? "true" : undefined}
        data-anchor-marker={navigation?.anchorMarkerId}
        data-center-marker={centerMarkerId ?? undefined}
        style={{ height: `${pageHeight}px` }}
        onPointerEnter={hoverNavigation}
        onPointerLeave={() => {
          cancelNavigationHover();
          closePopoverLater();
          setHoveredMarkerId(null);
          leaveNavigation();
        }}
      >
        <div
          ref={panelRef}
          className="document-structure-ruler__panel"
          style={
            navigation
              ? {
                  position: dualColumn ? "absolute" : "fixed",
                  top: `${navigation.panelTop}px`,
                  left: `${navigation.panelLeft}px`,
                  height: `${navigation.panelHeight}px`,
                  // Fixed navigation escapes scroll clipping; preserve sideways error labels only.
                  clipPath: `inset(${navigation.panelClipTop}px -100vw 0px)`,
                }
              : undefined
          }
        >
          <RulerMarkers
            markers={markers}
            geometry={geometry}
            navigationIndexById={navigationIndexById}
            navigation={navigation}
            activeMarkerId={activeMarkerId}
            centerMarkerId={centerMarkerId}
            onActivate={onActivateMarker}
            onHover={setHoveredMarkerId}
            onOpenGroup={onOpenGroup}
          />
        </div>
      </aside>
      <RulerNavigationPopover
        open={Boolean(popover)}
        anchor={popover?.anchor ?? { left: 0, right: 0, top: 0, bottom: 0 }}
        markers={markers.filter((marker) => navigationIndexById.has(marker.id))}
        currentId={popover?.currentId ?? null}
        onEnter={keepPopover}
        onLeave={closePopoverLater}
        onActivate={(marker) => {
          setPopover(null);
          onActivateMarker(marker);
        }}
      />
    </>
  );
}

// Thousands of markers need no React reconciliation when typing leaves their
// geometry, labels and interaction state unchanged.
const RulerMarkers = memo(function RulerMarkers({
  markers,
  geometry,
  navigationIndexById,
  navigation,
  activeMarkerId,
  centerMarkerId,
  onActivate,
  onHover,
  onOpenGroup,
}: {
  markers: readonly DocumentStructureRulerMarker[];
  geometry: ReadonlyMap<string, MarkerGeometry>;
  navigationIndexById: ReadonlyMap<string, number>;
  navigation: NavigationState | null;
  activeMarkerId: string | null;
  centerMarkerId: string | null;
  onActivate(marker: DocumentStructureRulerMarker): void;
  onHover(id: string | null): void;
  onOpenGroup(): void;
}) {
  const markersById = new Map(markers.map((marker) => [marker.id, marker]));
  const clusters = navigation ? null : rulerMarkerClusters(geometry, new Set(markersById.keys()));
  const errorIds = new Set(markers.filter((marker) => marker.error).map((marker) => marker.id));
  return markers.map((marker) => {
    const markerGeometry = geometry.get(marker.id);
    const members = clusters?.get(marker.id);
    const grouped = members !== undefined && members.length > 1;
    const markerIndex = navigationIndexById.get(marker.id);
    const anchorIndex = navigation ? navigationIndexById.get(navigation.anchorMarkerId) : undefined;
    const navigationTop =
      navigation && markerIndex !== undefined && anchorIndex !== undefined
        ? documentStructureRulerNavigationTop(markerIndex, anchorIndex, navigation.centerY, 0)
        : undefined;
    return (
      <button
        type="button"
        className="document-structure-ruler__marker"
        key={marker.id}
        aria-label={grouped ? `查看此处 ${members.length} 项文档结构` : `定位到${marker.label}`}
        data-cluster-count={grouped ? members.length : undefined}
        data-cluster-multiline={
          grouped && rulerClusterLabel(members.map((id) => markersById.get(id)!)).includes("\n")
            ? true
            : undefined
        }
        data-kind={marker.kind}
        data-warning={marker.warning}
        data-error={Boolean(marker.error) || Boolean(members?.some((id) => errorIds.has(id)))}
        data-virtual={Boolean(marker.virtual)}
        data-active={activeMarkerId === marker.id}
        data-center={centerMarkerId === marker.id}
        onClick={() => (grouped ? onOpenGroup() : onActivate(marker))}
        onPointerEnter={() => onHover(marker.id)}
        onFocus={() => {
          onHover(marker.id);
          if (grouped) onOpenGroup();
        }}
        onBlur={() => onHover(null)}
        style={
          {
            top: `${markerGeometry?.top ?? 0}px`,
            height: `${navigation && markerIndex !== undefined ? DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT : (markerGeometry?.height ?? 18)}px`,
            "--ruler-navigation-shift-y":
              navigationTop !== undefined && markerGeometry
                ? `${navigationTop - markerGeometry.top}px`
                : "0px",
            visibility: markerGeometry && (!clusters || members) ? "visible" : "hidden",
          } as CSSProperties
        }
      >
        <span className="document-structure-ruler__label--wide">
          {grouped
            ? rulerClusterLabel(members.map((id) => markersById.get(id)!))
            : (marker.displayLabel ?? marker.label)}
        </span>
        {marker.error && !grouped ? (
          <span className="document-structure-ruler__label--full" aria-hidden="true">
            {marker.label}
          </span>
        ) : null}
        <span className="document-structure-ruler__label--compact" aria-hidden="true">
          {marker.compactLabel}
        </span>
      </button>
    );
  });
});

function getVirtualMarkerOffset(
  marker: DocumentStructureRulerMarker,
  markers: readonly DocumentStructureRulerMarker[],
): number {
  if (!marker.virtual || !marker.virtualPlacement) return 0;
  const siblings = markers.filter(
    (candidate) =>
      candidate.virtual &&
      candidate.virtualPlacement === marker.virtualPlacement &&
      candidate.targetBlockId === marker.targetBlockId,
  );
  const index = siblings.findIndex((candidate) => candidate.id === marker.id);
  if (marker.virtualPlacement === "before") return -(siblings.length - index) * 24;
  return (index + 1) * 24;
}

function locateFigureRows(
  page: HTMLElement,
  figures: readonly { figureId: string }[],
): Map<string, LocatedBlock> {
  const located = new Map<string, LocatedBlock>();
  for (const figure of figures) {
    const row = page.querySelector<HTMLElement>(`[data-figure-id="${figure.figureId}"]`);
    if (row) located.set(figure.figureId, { position: 0, element: row });
  }
  return located;
}

function locateEditorBlocks(
  editor: ReturnType<EditorCommandBus["getEditor"]>,
  needed: ReadonlySet<string>,
) {
  const located = new Map<string, LocatedBlock>();
  if (!editor) return located;
  editor.state.doc.descendants((node, position) => {
    const nodeId = node.attrs.nodeId;
    if (typeof nodeId !== "string" || !needed.has(nodeId)) return;
    const dom = editor.view.nodeDOM(position);
    if (dom instanceof HTMLElement) located.set(nodeId, { position, element: dom });
  });
  return located;
}
