import { TextSelection } from "@tiptap/pm/state";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { DEFAULT_DUAL_COLUMN_FLOW, type DualColumnFlow } from "../../../shared/settings/model";
import type { EditorCommandBus } from "../app/command-bus";
import { selectedTextClientRects } from "../editor/use-editor-selection-overlay";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { resizedColumnPosition } from "./dual-column-comfort";
import { DualColumnContext } from "./dual-column-context";
import { createColumnFlow } from "./dual-column-flow";
import { columnGeometry } from "./dual-column-geometry";
import { DualColumnIntro } from "./dual-column-intro";
import { syncRulerMirror } from "./dual-column-ruler-mirror";
import { createColumnScrollbar } from "./dual-column-scrollbar";
import { ColumnWheelMotion, columnWheelDuration } from "./dual-column-wheel";
import { dualColumnWidth } from "./dual-column-width";
import { useOptionalPatentFunctionRail } from "./function-rail/function-rail-context";
import type { FunctionRailSpace } from "./function-rail/function-rail-state";
import { DOCUMENT_ZOOM_FRAME } from "./use-smooth-document-zoom";
import "./dual-column-surface.css";
import "./dual-column-flow.css";
import "./dual-column-margin.css";

export const DUAL_COLUMN_REFIT = "patent-dual-column-refit";

/** Two visual slices, but only ONE live editor, transaction stream and history.
 * The inactive slice is a paint-only mirror. Before pointer interaction, move the
 * live DOM to that slice without remounting it or serializing document content.
 */
export function DualColumnSurface({
  enabled,
  editorId,
  commandBus,
  zoomPercent,
  flowSettings = DEFAULT_DUAL_COLUMN_FLOW,
  onZoomLimit,
  children,
}: {
  enabled: boolean;
  editorId: string;
  commandBus: EditorCommandBus;
  zoomPercent: number;
  flowSettings?: DualColumnFlow;
  onZoomLimit?: (max: number) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<number | null>(null);
  const readingAnchorRef = useRef<number | null>(null);
  const sideRef = useRef(0);
  const flowRef = useRef<ReturnType<typeof createColumnFlow> | null>(null);
  const flowSettingsRef = useRef(flowSettings);
  const railController = useOptionalPatentFunctionRail();
  const expandedRail = useRef(railController?.presentation.expanded);
  expandedRail.current = railController?.presentation.expanded;
  const widthBasis = useRef<{
    editorId: string;
    pageWidth: number;
    baseZoom: number;
    railSpace: FunctionRailSpace;
    rulerCompact: boolean;
  } | null>(null);
  flowSettingsRef.current = flowSettings;
  useLayoutEffect(() => {
    flowRef.current?.configure(flowSettings);
  }, [flowSettings]);
  const reportLimit = useRef(onZoomLimit);
  reportLimit.current = onZoomLimit;
  useLayoutEffect(() => {
    if (!enabled) {
      positionRef.current = null;
      readingAnchorRef.current = null;
      sideRef.current = 0;
      widthBasis.current = null;
      return;
    }
    const root = rootRef.current;
    const layout = root?.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = layout?.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
    const ruler = layout?.querySelector<HTMLElement>(":scope > .document-structure-ruler");
    const viewport = root?.closest<HTMLElement>(".editor-workspace");
    if (!root || !layout || !page || !viewport) return;
    const editor = commandBus.getEditor(editorId);
    if (!editor) return;
    const originalScroll = viewport.scrollTop;
    const singleZoom = Number.parseFloat(layout.style.getPropertyValue("--patent-page-zoom")) || 1;
    const originalPageStyle = page.getAttribute("style");
    const originalRulerStyle = ruler?.getAttribute("style") ?? null;
    const caret = editor.isFocused ? editor.view.coordsAtPos(editor.state.selection.head) : null;
    const viewportBounds = viewport.getBoundingClientRect();
    // Scrolling away from a focused caret expresses a reading position, not a
    // request to jump back to the old insertion point when changing modes.
    const visibleCaret =
      caret && caret.top >= viewportBounds.top && caret.bottom <= viewportBounds.bottom;
    const initialReadingAnchor =
      (positionRef.current ?? originalScroll) === 0
        ? null
        : (readingAnchorRef.current ??
          (visibleCaret ? (caret.top - page.getBoundingClientRect().top) / singleZoom : null));
    const frames = [0, 1].map((side) => {
      const frame = document.createElement("div");
      frame.className = "dual-column-paper";
      frame.dataset.side = String(side);
      frame.setAttribute("aria-hidden", "true");
      // Keep moving paper edges on a leaf, outside the inherited styles of the document.
      const background = document.createElement("div");
      background.className = "dual-column-paper-background";
      const copy = document.createElement("div");
      copy.className = "dual-column-copy";
      copy.inert = true;
      const selection = document.createElement("div");
      selection.className = "dual-column-selection";
      frame.append(background, copy, selection);
      layout.append(frame);
      return { frame, background, copy, selection };
    });
    const scrollbar = createColumnScrollbar(layout, (nextPosition) => {
      cancelScrolling();
      position = nextPosition;
      paint();
    });
    viewport.classList.add("has-dual-column-surface");
    layout.classList.add("dual-column-layout");
    viewport.scrollTop = 0;
    const flow = createColumnFlow(layout);
    flow.configure(flowSettingsRef.current);
    flowRef.current = flow;
    let side = sideRef.current;
    let height = 600;
    let columnWidth = 600;
    let rulerSlot = 84;
    let zoom = 1;
    let documentHeight = 1200;
    let rulerHeight = 1200;
    let position = positionRef.current ?? originalScroll / singleZoom;
    let scheduled = 0;
    let paintScheduled = 0;
    let selectionFrame = 0;
    let composing = false;
    let measured = false;
    let dragAnchor: number | null = null;
    let crossColumnDrag = false;
    let navigationFrame = 0;
    let wheelFrame = 0;
    let lastWheelAt = Number.NEGATIVE_INFINITY;
    const wheelMotion = new ColumnWheelMotion();
    const cancelWheel = () => {
      cancelAnimationFrame(wheelFrame);
      wheelFrame = 0;
      wheelMotion.cancel();
    };
    const cancelNavigation = () => {
      cancelAnimationFrame(navigationFrame);
      navigationFrame = 0;
    };
    const cancelScrolling = () => {
      cancelNavigation();
      cancelWheel();
    };

    const paint = () => {
      const geometry = columnGeometry(position, height, documentHeight);
      position = geometry.left;
      flow.paint({ columnWidth, rulerSlot, height, position });
      positionRef.current = position / zoom;
      readingAnchorRef.current = (position + (side + 1 / 3) * height) / zoom;
      sideRef.current = side;
      layout.dataset.columnPosition = String(position);
      layout.dataset.columnHeight = String(height);
      layout.dataset.activeColumn = String(side);
      scrollbar.update(geometry.max, position);
      frames.forEach(({ background, copy, selection }, index) => {
        background.style.top = `${index === 0 ? geometry.leftTop : 20}px`;
        background.style.bottom = `${index === 1 ? geometry.rightBottom : 20}px`;
        const copyOffset = index === 0 ? geometry.contentLeft : geometry.contentRight;
        copy.style.transform = `translateY(${-copyOffset}px)`;
        copy.style.clipPath = `inset(${Math.max(0, copyOffset)}px 0 ${Math.max(0, documentHeight - copyOffset - height)}px 0)`;
        copy.style.display = index === side ? "none" : "grid";
        selection.replaceChildren();
      });
      const offset = side === 0 ? geometry.contentLeft : geometry.contentRight;
      const top = side === 0 ? 0 : 20;
      const x = side * (columnWidth + 20);
      page.style.transform = `translate(${(x + rulerSlot) / zoom}px, ${(top - offset) / zoom}px)`;
      page.style.clipPath = `inset(${Math.max(0, offset) / zoom}px 0 ${Math.max(0, documentHeight - offset - height) / zoom}px 0)`;
      if (ruler) {
        ruler.style.transform = `translate(${x}px, ${top - offset}px)`;
        ruler.style.clipPath = `inset(${Math.max(0, offset)}px -8px ${Math.max(0, rulerHeight - offset - height)}px -8px)`;
      }
      const selected = window.getSelection();
      if (
        selected?.rangeCount &&
        !selected.isCollapsed &&
        selected.anchorNode &&
        editor.view.dom.contains(selected.anchorNode)
      ) {
        const bounds = layout.getBoundingClientRect();
        const inactive = 1 - side;
        const overlay = frames[inactive]?.selection;
        for (const rect of selectedTextClientRects(editor, zoom)) {
          const localTop =
            rect.top - bounds.top - side * 20 + offset - (geometry.contentLeft + inactive * height);
          if (localTop + rect.height <= 0 || localTop >= height) continue;
          const highlight = document.createElement("span");
          highlight.style.cssText = `left:${rect.left - bounds.left - side * (columnWidth + 20)}px;top:${Math.max(0, localTop) + inactive * 20}px;width:${rect.width}px;height:${Math.min(height, localTop + rect.height) - Math.max(0, localTop)}px`;
          overlay?.append(highlight);
        }
      }
    };
    const mirror = () => {
      paintScheduled = 0;
      frames.forEach(({ copy }) => {
        const pageCopy = page.cloneNode(true) as HTMLElement;
        pageCopy.removeAttribute("style");
        const rulerCopy = ruler?.cloneNode(true) as HTMLElement | undefined;
        rulerCopy?.removeAttribute("style");
        rulerCopy?.removeAttribute("data-navigation");
        rulerCopy?.removeAttribute("data-center-marker");
        rulerCopy?.querySelector(".document-structure-ruler__panel")?.removeAttribute("style");
        const snapshot = document.createDocumentFragment();
        snapshot.append(...(rulerCopy ? [rulerCopy, pageCopy] : [pageCopy]));
        snapshot
          .querySelectorAll("[id], [contenteditable], [tabindex], [role]")
          .forEach((element) => {
            element.removeAttribute("id");
            element.removeAttribute("role");
            element.removeAttribute("tabindex");
            if (element.hasAttribute("contenteditable"))
              element.setAttribute("contenteditable", "false");
          });
        const existingRuler = copy.querySelector(":scope > .document-structure-ruler");
        if (rulerCopy) {
          if (existingRuler) syncRulerMirror(existingRuler, rulerCopy);
          else copy.prepend(rulerCopy);
        }
        const existingPage = copy.querySelector(":scope > .patent-page-zoom-frame");
        if (existingPage) existingPage.replaceWith(pageCopy);
        else copy.append(pageCopy);
      });
      paint();
    };
    const measure = () => {
      scheduled = 0;
      if (root.closest("[hidden]")) return;
      const rect = layout.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      scrollbar.measure({
        top: viewportRect.top,
        right: viewportRect.right,
        height: viewport.clientHeight,
        gutter: viewport.offsetWidth - viewport.clientWidth,
      });
      const rail = layout.querySelector<HTMLElement>(":scope > .patent-global-function-rail-slot");
      const dimensions = dualColumnWidth(
        root.getBoundingClientRect().width,
        page.offsetWidth,
        zoomPercent,
        expandedRail.current ?? rail?.dataset.expanded !== "false",
        widthBasis.current?.editorId === editorId &&
          widthBasis.current.pageWidth === page.offsetWidth
          ? widthBasis.current
          : undefined,
      );
      // Keep the entry fit as the relative-zoom basis. A resize must not rebase
      // the chosen scale when crossing the comfortable-controls breakpoint.
      widthBasis.current = {
        editorId,
        pageWidth: page.offsetWidth,
        baseZoom: dimensions.baseZoom,
        railSpace: dimensions.railFits ? "fits" : "constrained",
        rulerCompact: dimensions.rulerWidth === 20,
      };
      reportLimit.current?.(dimensions.maxZoomPercent);
      const availableHeight =
        viewport.getBoundingClientRect().top + viewport.clientHeight - rect.top;
      const previousHeight = height;
      height = Math.max(120, availableHeight - 20);
      const previousZoom = zoom;
      zoom = dimensions.zoom;
      columnWidth = dimensions.columnWidth;
      rulerSlot = dimensions.rulerWidth + 8;
      const previousDimensions =
        layout.style.getPropertyValue("--column-group-width") + layout.dataset.columnRailSpace;
      layout.dataset.columnRailSpace = dimensions.railFits ? "fits" : "constrained";
      layout.style.setProperty("--column-group-width", `${dimensions.groupWidth}px`);
      layout.style.setProperty("--column-ruler-width", `${dimensions.rulerWidth}px`);
      layout.style.setProperty("--column-ruler-slot", `${rulerSlot}px`);
      layout.style.setProperty("--column-zoom", String(zoom));
      layout.style.setProperty("--column-width", `${columnWidth}px`);
      layout.style.setProperty("--column-paper-width", `${page.offsetWidth * zoom}px`);
      layout.style.setProperty("--column-rail-width", `${dimensions.railWidth}px`);
      layout.style.setProperty("--column-height", `${height}px`);
      const nextDocumentHeight = page.getBoundingClientRect().height;
      rulerHeight = ruler?.getBoundingClientRect().height ?? nextDocumentHeight;
      if (
        previousZoom !== zoom ||
        previousHeight !== height ||
        nextDocumentHeight !== documentHeight
      )
        cancelWheel();
      documentHeight = nextDocumentHeight;
      if (measured)
        position = resizedColumnPosition(
          position,
          previousHeight,
          previousZoom,
          height,
          zoom,
          side,
        );
      else
        position =
          initialReadingAnchor === null
            ? position * zoom
            : initialReadingAnchor * zoom - (side + 1 / 3) * height;
      measured = true;
      mirror();
      if (
        previousDimensions !==
        layout.style.getPropertyValue("--column-group-width") + layout.dataset.columnRailSpace
      )
        layout.dispatchEvent(new Event(DOCUMENT_ZOOM_FRAME, { bubbles: true }));
    };
    const scheduleMeasure = () => {
      if (!scheduled) scheduled = requestAnimationFrame(measure);
    };
    const refit = () => {
      widthBasis.current = null;
      scheduleMeasure();
    };
    window.addEventListener(DUAL_COLUMN_REFIT, refit);
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(viewport);
    resizeObserver.observe(layout);
    resizeObserver.observe(page);
    if (ruler) resizeObserver.observe(ruler);
    const railObserver = new MutationObserver(scheduleMeasure);
    railObserver.observe(viewport.closest(".patent-function-rail-scope") ?? layout, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-layout", "data-expanded"],
    });
    const mutations = new MutationObserver((records) => {
      if (records.every((record) => record.target === page || record.target === ruler)) return;
      if (!paintScheduled) paintScheduled = requestAnimationFrame(mirror);
    });
    mutations.observe(page, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    if (ruler) mutations.observe(ruler, { subtree: true, childList: true, attributes: true });

    const columnAt = (x: number, y: number) => {
      const rect = layout.getBoundingClientRect();
      const localX = x - rect.left;
      if (y < rect.top || y > rect.top + height + 20 || localX < 0) return null;
      if (localX <= columnWidth) return 0;
      if (localX >= columnWidth + 20 && localX <= columnWidth * 2 + 20) return 1;
      return null;
    };
    const activate = (next: number) => {
      if (side === next || composing) return;
      side = next;
      paint();
    };
    const move = (event: PointerEvent) => {
      if (isRailEvent(event)) return;
      const next = columnAt(event.clientX, event.clientY);
      if (next !== null && event.buttons === 0) activate(next);
    };
    const down = (event: PointerEvent) => {
      if (isRailEvent(event)) return;
      cancelScrolling();
      const next = columnAt(event.clientX, event.clientY);
      if (next === null || event.button !== 0) return;
      const switched = next !== side;
      activate(next);
      const resolved = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      dragAnchor = event.shiftKey ? editor.state.selection.anchor : (resolved?.pos ?? null);
      crossColumnDrag = false;
      if ((switched || event.shiftKey) && resolved && !composing) {
        event.preventDefault();
        editor.view.dispatch(
          editor.state.tr.setSelection(
            event.shiftKey
              ? TextSelection.create(editor.state.doc, editor.state.selection.anchor, resolved.pos)
              : TextSelection.near(editor.state.doc.resolve(resolved.pos)),
          ),
        );
        editor.view.focus();
      }
    };
    const drag = (event: MouseEvent) => {
      if (isRailEvent(event)) return;
      if (dragAnchor === null || event.buttons !== 1 || composing) return;
      const next = columnAt(event.clientX, event.clientY);
      if (next === null || (next === side && !crossColumnDrag)) return;
      crossColumnDrag = true;
      activate(next);
      const resolved = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, dragAnchor, resolved.pos),
        ),
      );
    };
    const up = () => {
      dragAnchor = null;
      crossColumnDrag = false;
    };
    const isRailEvent = (event: Event) =>
      event.target instanceof Element &&
      event.target.closest(
        ".patent-global-function-rail-slot, [data-function-rail-owner], .document-structure-ruler",
      ) !== null;
    const wheel = (event: WheelEvent) => {
      if (isRailEvent(event)) return;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.deltaY === 0 ||
        columnAt(event.clientX, event.clientY) === null
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      cancelNavigation();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? height : 1);
      if (isMotionReduced()) {
        cancelWheel();
        position += delta;
        paint();
        return;
      }
      const now = performance.now();
      const duration = columnWheelDuration(event.deltaMode, event.deltaY, now - lastWheelAt);
      lastWheelAt = now;
      wheelMotion.add(
        position,
        delta,
        columnGeometry(position, height, documentHeight).max,
        now,
        duration,
      );
      if (wheelFrame || !wheelMotion.running) return;
      const tick = (now: number) => {
        wheelFrame = 0;
        if (!wheelMotion.running) return;
        position = wheelMotion.sample(isMotionReduced() ? Number.MAX_SAFE_INTEGER : now);
        paint();
        if (wheelMotion.running) wheelFrame = requestAnimationFrame(tick);
      };
      wheelFrame = requestAnimationFrame(tick);
    };
    const revealSelection = () => {
      if (
        !editor.isFocused ||
        composing ||
        dragAnchor !== null ||
        navigationFrame ||
        layout.dataset.rulerSelectionDrag
      )
        return;
      cancelWheel();
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const rect = layout.getBoundingClientRect();
      const currentOffset = position + side * height;
      const documentY = caret.top - rect.top - side * 20 + currentOffset;
      if (documentY >= position && documentY <= position + height * 2) {
        activate(documentY < position + height ? 0 : 1);
      } else {
        position = columnGeometry(documentY - height * 0.3, height, documentHeight).left;
        activate(documentY < position + height ? 0 : 1);
      }
      paint();
    };
    const compositionStart = () => {
      cancelScrolling();
      composing = true;
    };
    const compositionEnd = () => {
      composing = false;
      scheduleMeasure();
    };
    const previousHandleScroll = editor.options.editorProps.handleScrollToSelection;
    const navigateTo = (offset: number) => {
      cancelScrolling();
      const documentY = offset + 20;
      const target = columnGeometry(
        documentY - side * height - height / 3,
        height,
        documentHeight,
      ).left;
      const start = position;
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = isMotionReduced() ? 1 : Math.min(1, (now - startedAt) / 360);
        position = start + (target - start) * (1 - (1 - progress) ** 3);
        paint();
        if (progress < 1) navigationFrame = requestAnimationFrame(tick);
        else {
          navigationFrame = 0;
          activate(documentY < target + height ? 0 : 1);
        }
      };
      if (isMotionReduced()) tick(performance.now());
      else navigationFrame = requestAnimationFrame(tick);
    };
    const navigateRuler = (event: Event) => {
      if (event instanceof CustomEvent && Number.isFinite(event.detail))
        navigateTo(Number(event.detail));
    };
    const selectionNavigation = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;
      cancelScrolling();
      if (detail.kind === "cancel") return;
      if (detail.side !== 0 && detail.side !== 1) return;
      activate(detail.side);
      if (detail.kind === "navigate" && Number.isFinite(detail.documentY))
        navigateTo(detail.documentY);
      if (detail.kind === "scroll" && Number.isFinite(detail.delta)) {
        position = columnGeometry(position + detail.delta, height, documentHeight).left;
        paint();
      }
    };
    layout.addEventListener("dual-column-selection-navigation", selectionNavigation);
    layout.addEventListener("dual-column-ruler-navigate", navigateRuler);
    root.addEventListener("keydown", cancelScrolling, true);
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handleScrollToSelection: () => {
          revealSelection();
          return true;
        },
      },
    });
    editor.on("selectionUpdate", revealSelection);
    root.addEventListener("pointermove", move, true);
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("mousemove", drag, true);
    window.addEventListener("pointerup", up);
    root.addEventListener("wheel", wheel, { passive: false, capture: true });
    root.addEventListener("compositionstart", compositionStart);
    root.addEventListener("compositionend", compositionEnd);
    const selectionPaint = () => {
      if (!selectionFrame)
        selectionFrame = requestAnimationFrame(() => {
          selectionFrame = 0;
          paint();
        });
    };
    document.addEventListener("selectionchange", selectionPaint);
    measure();
    return () => {
      window.removeEventListener(DUAL_COLUMN_REFIT, refit);
      flow.destroy();
      flowRef.current = null;
      cancelScrolling();
      layout.removeEventListener("dual-column-ruler-navigate", navigateRuler);
      layout.removeEventListener("dual-column-selection-navigation", selectionNavigation);
      root.removeEventListener("keydown", cancelScrolling, true);
      cancelAnimationFrame(scheduled);
      cancelAnimationFrame(paintScheduled);
      cancelAnimationFrame(selectionFrame);
      resizeObserver.disconnect();
      railObserver.disconnect();
      mutations.disconnect();
      editor.off("selectionUpdate", revealSelection);
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          handleScrollToSelection: previousHandleScroll ?? (() => false),
        },
      });
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("mousemove", drag, true);
      window.removeEventListener("pointerup", up);
      root.removeEventListener("wheel", wheel, true);
      root.removeEventListener("compositionstart", compositionStart);
      root.removeEventListener("compositionend", compositionEnd);
      document.removeEventListener("selectionchange", selectionPaint);
      frames.forEach(({ frame }) => {
        frame.remove();
      });
      scrollbar.destroy();
      layout.classList.remove("dual-column-layout");
      viewport.classList.remove("has-dual-column-surface");
      for (const property of [
        "--column-zoom",
        "--column-width",
        "--column-height",
        "--column-paper-width",
        "--column-rail-width",
        "--column-group-width",
        "--column-ruler-width",
        "--column-ruler-slot",
      ])
        layout.style.removeProperty(property);
      delete layout.dataset.columnRailSpace;
      if (originalPageStyle === null) page.removeAttribute("style");
      else page.setAttribute("style", originalPageStyle);
      if (ruler) {
        if (originalRulerStyle === null) ruler.removeAttribute("style");
        else ruler.setAttribute("style", originalRulerStyle);
      }
      viewport.scrollTop = ((position + side * height) / zoom) * singleZoom;
    };
  }, [enabled, commandBus, editorId, zoomPercent]);
  return (
    <DualColumnContext.Provider value={enabled}>
      <div ref={rootRef} className="patent-drafting-workspace">
        {children}
        <DualColumnIntro enabled={enabled} />
      </div>
    </DualColumnContext.Provider>
  );
}
