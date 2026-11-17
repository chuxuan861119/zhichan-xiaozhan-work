import { ChevronDown } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../../../shared/patent/model";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { SPATIAL_MOTION_TIMING, spatialMotionTiming } from "../shared/spatial-motion";
import { SpatialPresence } from "../shared/spatial-presence";
import { DUAL_DOCUMENT_RESIZE_SETTLED_EVENT } from "./dual-document-resize";
import {
  clampDualDocumentSplitPercent,
  DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX,
  DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT,
  dualDocumentSplitIsCentered,
  dualDocumentSplitPercentAfterDrag,
  dualDocumentSplitRange,
  dualDocumentSplitTemplate,
} from "./dual-document-split";
import { minimumDualPaneWidth } from "./dual-pane-layout-budget";
import { PatentFunctionRailScope } from "./function-rail/function-rail-context";
import type { FunctionRailSpace } from "./function-rail/function-rail-state";
import type { WorkspacePane } from "./patent-workspace-layout";

const DUAL_PANE_SWAP_ROOT_CLASS = "dual-pane-swap-motion";

export type DualDocumentPaneView =
  | Readonly<{
      kind: "document";
      targetKey: string;
      patentName: string | null;
      bookKind?: PatentBookKind;
      documentLabel?: string;
      editorId?: string;
      zoomPercent: number;
      content: ReactNode;
    }>
  | Readonly<{
      kind: "selection";
      picker: ReactNode;
    }>;

type DualDocumentWorkspaceProps = Readonly<{
  left: DualDocumentPaneView;
  right: DualDocumentPaneView;
  activePane: WorkspacePane;
  initialRailSpace: FunctionRailSpace;
  toolIdsByPane?: Partial<Record<WorkspacePane, readonly string[]>>;
  switchers?: Partial<Record<WorkspacePane, ReactNode>>;
  hasNonEmptyTextSelection?(editorId: string): boolean;
  onPreserveSelectionPointer?(pointerId: number): void;
  onRestoreRetainedSelection?(editorId: string): void;
  onActivatePane(pane: WorkspacePane): void;
  onClosePane?(pane: WorkspacePane): void;
  onOpenPicker(pane: WorkspacePane): void;
  onOpenSinglePane?(pane: WorkspacePane): void;
  onSwap(): void;
}>;

function paneHeader(view: DualDocumentPaneView): string {
  if (view.kind === "selection") return "请选择文档";
  const documentLabel =
    view.documentLabel ?? (view.bookKind ? PATENT_BOOK_LABELS[view.bookKind] : "其他文档");
  return `${view.patentName?.trim() || "未命名专利"} · ${documentLabel}`;
}

function paneAnimationKey(view: DualDocumentPaneView): string {
  return view.kind === "document" ? `document:${view.targetKey}` : "selection";
}

function copyPaneVisualState(source: HTMLElement, clone: HTMLElement): void {
  const sourceElements = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const cloneElements = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (let index = 0; index < sourceElements.length; index += 1) {
    const sourceElement = sourceElements[index];
    const cloneElement = cloneElements[index];
    if (!sourceElement || !cloneElement) continue;
    cloneElement.removeAttribute("id");
    cloneElement.scrollLeft = sourceElement.scrollLeft;
    cloneElement.scrollTop = sourceElement.scrollTop;
    if (sourceElement instanceof HTMLInputElement && cloneElement instanceof HTMLInputElement) {
      cloneElement.value = sourceElement.value;
      cloneElement.checked = sourceElement.checked;
    } else if (
      sourceElement instanceof HTMLTextAreaElement &&
      cloneElement instanceof HTMLTextAreaElement
    ) {
      cloneElement.value = sourceElement.value;
    } else if (
      sourceElement instanceof HTMLSelectElement &&
      cloneElement instanceof HTMLSelectElement
    ) {
      cloneElement.value = sourceElement.value;
    } else if (
      sourceElement instanceof HTMLCanvasElement &&
      cloneElement instanceof HTMLCanvasElement
    ) {
      cloneElement.width = sourceElement.width;
      cloneElement.height = sourceElement.height;
      try {
        cloneElement.getContext("2d")?.drawImage(sourceElement, 0, 0);
      } catch {
        // A protected canvas can stay blank in the short-lived swap ghost.
      }
    }
  }
}

function createPaneSwapGhosts(
  workspace: HTMLElement,
  leftPane: HTMLElement,
  rightPane: HTMLElement,
  paneDistance: number,
): Readonly<{ layer: HTMLDivElement; animations: Animation[] }> | null {
  if (typeof leftPane.animate !== "function" || typeof rightPane.animate !== "function") {
    return null;
  }
  const workspaceRect = workspace.getBoundingClientRect();
  const leftRect = leftPane.getBoundingClientRect();
  const rightRect = rightPane.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "dual-document-workspace dual-pane-swap-ghost-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  Object.assign(layer.style, {
    left: `${workspaceRect.left}px`,
    top: `${workspaceRect.top}px`,
    width: `${workspaceRect.width}px`,
    height: `${workspaceRect.height}px`,
  });

  const createGhost = (pane: HTMLElement, rect: DOMRect, side: WorkspacePane) => {
    const clone = pane.cloneNode(true) as HTMLElement;
    clone.dataset.swapGhost = side;
    Object.assign(clone.style, {
      left: `${rect.left - workspaceRect.left}px`,
      top: `${rect.top - workspaceRect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    layer.append(clone);
    return clone;
  };
  const leftGhost = createGhost(leftPane, leftRect, "left");
  const rightGhost = createGhost(rightPane, rightRect, "right");
  document.body.append(layer);
  copyPaneVisualState(leftPane, leftGhost);
  copyPaneVisualState(rightPane, rightGhost);
  workspace.dataset.swapContentHidden = "true";
  const timing = { ...spatialMotionTiming(paneDistance), fill: "forwards" } as const;
  return {
    layer,
    animations: [
      leftGhost.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(${paneDistance}px)` }],
        timing,
      ),
      rightGhost.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(${-paneDistance}px)` }],
        timing,
      ),
    ],
  };
}

function DocumentPane({
  pane,
  view,
  active,
  initialRailSpace,
  externalToolIds,
  switcher,
  switcherOpen,
  switcherSession,
  onPointerActivate,
  onMouseDownActivate,
  onKeyboardFocus,
  onToggleSwitcher,
  onOpenSingle,
  onCompleteSwapDoubleClick,
  onClose,
  onSwitcherRef,
  leadingControl,
}: Readonly<{
  pane: WorkspacePane;
  view: DualDocumentPaneView;
  active: boolean;
  initialRailSpace: FunctionRailSpace;
  externalToolIds: readonly string[];
  switcher?: ReactNode;
  switcherOpen: boolean;
  switcherSession: number;
  onPointerActivate(event: ReactPointerEvent<HTMLElement>): void;
  onMouseDownActivate(event: ReactMouseEvent<HTMLElement>): void;
  onKeyboardFocus(): void;
  onToggleSwitcher(trigger: HTMLButtonElement): void;
  onOpenSingle(): void;
  onCompleteSwapDoubleClick(event: ReactMouseEvent<HTMLElement>): boolean;
  onClose(): void;
  onSwitcherRef(element: HTMLDivElement | null): void;
  leadingControl?: ReactNode;
}>) {
  const zoomPercent = view.kind === "document" ? view.zoomPercent : 100;
  const style = {
    "--dual-pane-zoom": zoomPercent / 100,
  } as CSSProperties;
  const switchLabel = pane === "left" ? "切换左侧文档" : "切换右侧文档";
  const closeLabel = pane === "left" ? "关闭左侧文档" : "关闭右侧文档";
  const titleClickTimerRef = useRef<number | null>(null);
  const viewKey = paneAnimationKey(view);
  const previousViewKeyRef = useRef(viewKey);

  const clearTitleClickTimer = useCallback(() => {
    if (titleClickTimerRef.current === null) return;
    window.clearTimeout(titleClickTimerRef.current);
    titleClickTimerRef.current = null;
  }, []);

  useEffect(() => clearTitleClickTimer, [clearTitleClickTimer]);
  useEffect(() => {
    if (previousViewKeyRef.current === viewKey) return;
    previousViewKeyRef.current = viewKey;
    clearTitleClickTimer();
  }, [clearTitleClickTimer, viewKey]);

  const scheduleSwitcherToggle = (trigger: HTMLButtonElement) => {
    clearTitleClickTimer();
    titleClickTimerRef.current = window.setTimeout(() => {
      titleClickTimerRef.current = null;
      onToggleSwitcher(trigger);
    }, 200);
  };

  const openSingleFromHeader = (event: ReactMouseEvent<HTMLElement>) => {
    if (view.kind !== "document") return;
    if (onCompleteSwapDoubleClick(event)) {
      clearTitleClickTimer();
      return;
    }
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".dual-document-pane__header")
    ) {
      return;
    }
    if (event.target.closest("[data-dual-header-independent-control]")) {
      return;
    }
    clearTitleClickTimer();
    onOpenSingle();
  };

  return (
    <section
      className="dual-document-pane"
      aria-label={pane === "left" ? "左侧文档" : "右侧文档"}
      data-layout-part={pane}
      data-pane={pane}
      data-active={active}
      data-dual-zoom={zoomPercent}
      style={style}
      onPointerDownCapture={onPointerActivate}
      onMouseDownCapture={onMouseDownActivate}
      onFocusCapture={onKeyboardFocus}
      onDoubleClick={openSingleFromHeader}
    >
      <header className="dual-document-pane__header">
        {leadingControl}
        <div className="dual-document-pane__title-group">
          <button
            type="button"
            className="dual-document-pane__title"
            data-dual-switcher-trigger={pane}
            aria-label={switchLabel}
            title={switchLabel}
            aria-expanded={switcherOpen}
            onClick={(event) => scheduleSwitcherToggle(event.currentTarget)}
          >
            {paneHeader(view)}
          </button>
          <button
            type="button"
            className="dual-document-pane__switch"
            data-dual-switcher-trigger={pane}
            aria-label={switchLabel}
            title={switchLabel}
            aria-expanded={switcherOpen}
            data-dual-header-independent-control
            onClick={(event) => onToggleSwitcher(event.currentTarget)}
          >
            <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        </div>
        <button
          type="button"
          className="dual-document-pane__close dialog-close-button"
          aria-label={closeLabel}
          title={closeLabel}
          data-dual-header-independent-control
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
        <SpatialPresence>
          {switcherOpen ? (
            <div
              key={switcherSession}
              ref={onSwitcherRef}
              className="dual-document-pane__switcher-popover"
              role="dialog"
              aria-label={switchLabel}
              data-dual-header-independent-control
            >
              {switcher}
            </div>
          ) : null}
        </SpatialPresence>
      </header>
      <div className="dual-document-pane__body">
        <PatentFunctionRailScope
          scopeKey={pane}
          externalToolIds={externalToolIds}
          initialSpace={initialRailSpace}
        >
          <Fragment key={view.kind === "document" ? view.targetKey : `picker-${pane}`}>
            {view.kind === "document" ? view.content : view.picker}
          </Fragment>
        </PatentFunctionRailScope>
      </div>
    </section>
  );
}

export function DualDocumentWorkspace({
  left,
  right,
  activePane,
  initialRailSpace,
  toolIdsByPane = {},
  switchers = {},
  hasNonEmptyTextSelection = () => false,
  onPreserveSelectionPointer = () => {},
  onRestoreRetainedSelection = () => {},
  onActivatePane,
  onClosePane = () => {},
  onOpenSinglePane = () => {},
  onSwap,
}: DualDocumentWorkspaceProps) {
  const [openSwitcherPane, setOpenSwitcherPane] = useState<WorkspacePane | null>(null);
  const [switcherSession, setSwitcherSession] = useState(0);
  const [splitPercent, setSplitPercent] = useState(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT);
  const [splitResizing, setSplitResizing] = useState(false);
  const [splitSnappedToCenter, setSplitSnappedToCenter] = useState(false);
  const splitPercentRef = useRef(splitPercent);
  const splitResizingRef = useRef(false);
  const splitMeasureRef = useRef<(() => void) | null>(null);
  const splitSettledFrameRef = useRef<number | null>(null);
  const dividerRef = useRef<HTMLHRElement | null>(null);
  const keyboardNavigationRef = useRef(false);
  const preserveSelectionMouseDownPaneRef = useRef<WorkspacePane | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const minimumWidths = useRef<readonly [number, number]>([
    minimumDualPaneWidth(),
    minimumDualPaneWidth(),
  ]);
  const [splitRange, setSplitRange] = useState({ min: 50, max: 50 });
  const splitDragRef = useRef<{
    startX: number;
    startPercent: number;
    containerWidth: number;
    centerSnapArmed: boolean;
  } | null>(null);
  const switcherRefs = useRef<Record<WorkspacePane, HTMLDivElement | null>>({
    left: null,
    right: null,
  });
  const switchTriggerRefs = useRef<Record<WorkspacePane, HTMLButtonElement | null>>({
    left: null,
    right: null,
  });
  const pendingFocusFrameRef = useRef<number | null>(null);
  const swapClickSequenceRef = useRef<{
    clientX: number;
    clientY: number;
    count: number;
    timeStamp: number;
  } | null>(null);
  const activeAnimationsRef = useRef<Animation[]>([]);
  const swapMotionSequenceRef = useRef(0);
  const swapGhostLayerRef = useRef<HTMLElement | null>(null);
  const swapCommitFramesRef = useRef<number[]>([]);
  const leftAnimationKey = paneAnimationKey(left);
  const rightAnimationKey = paneAnimationKey(right);
  const previousPaneKeysRef = useRef({
    left: leftAnimationKey,
    right: rightAnimationKey,
  });
  const layoutKey = `${leftAnimationKey}|${rightAnimationKey}`;
  if (!splitResizingRef.current) splitPercentRef.current = splitPercent;
  // Recheck each physical pane after resizing, swapping or replacing its document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: document replacement changes the observed page nodes.
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      if (splitResizingRef.current) return;
      const widths = (["left", "right"] as const).map((side) => {
        const viewport = workspace.querySelector<HTMLElement>(
          `[data-pane="${side}"] .patent-editor-workspace`,
        );
        const page = viewport?.querySelector<HTMLElement>(".patent-page-zoom-frame");
        if (!viewport || !page?.offsetWidth) return minimumDualPaneWidth();
        const style = getComputedStyle(viewport);
        const chrome =
          parseFloat(style.paddingLeft || "0") +
          parseFloat(style.paddingRight || "0") +
          Math.max(0, viewport.offsetWidth - viewport.clientWidth);
        return minimumDualPaneWidth(page.offsetWidth, chrome);
      }) as [number, number];
      minimumWidths.current = widths;
      const width = workspace.getBoundingClientRect().width;
      if (!width) return;
      const range = dualDocumentSplitRange(width, widths);
      setSplitRange((current) =>
        current.min === range.min && current.max === range.max ? current : range,
      );
      const clamped = clampDualDocumentSplitPercent(splitPercentRef.current, width, widths);
      splitPercentRef.current = clamped;
      setSplitPercent((current) => (current === clamped ? current : clamped));
    };
    splitMeasureRef.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    workspace.querySelectorAll(".patent-page-zoom-frame").forEach((page) => {
      observer.observe(page);
    });
    return () => {
      observer.disconnect();
      if (splitMeasureRef.current === measure) splitMeasureRef.current = null;
    };
  }, [layoutKey]);
  const previousLayoutKeyRef = useRef(layoutKey);
  const restoreSwitcherFocus = useCallback((pane: WorkspacePane) => {
    if (pendingFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFocusFrameRef.current);
    }
    pendingFocusFrameRef.current = window.requestAnimationFrame(() => {
      pendingFocusFrameRef.current = null;
      switchTriggerRefs.current[pane]?.focus();
    });
  }, []);
  const dismissSwitcher = useCallback(
    (pane: WorkspacePane) => {
      setOpenSwitcherPane((current) => (current === pane ? null : current));
      restoreSwitcherFocus(pane);
    },
    [restoreSwitcherFocus],
  );
  const toggleSwitcher = (pane: WorkspacePane, trigger: HTMLButtonElement) => {
    if (pendingFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFocusFrameRef.current);
      pendingFocusFrameRef.current = null;
    }
    switchTriggerRefs.current[pane] = trigger;
    // Closing motion retains the old picker. Every new opening starts from
    // the pane's active document, including a rapid close and reopen.
    if (openSwitcherPane !== pane) setSwitcherSession((value) => value + 1);
    setOpenSwitcherPane((current) => (current === pane ? null : pane));
  };
  useEffect(() => {
    return () => {
      if (pendingFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFocusFrameRef.current);
      }
      if (splitSettledFrameRef.current !== null) {
        window.cancelAnimationFrame(splitSettledFrameRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!openSwitcherPane) return undefined;
    const pane = openSwitcherPane;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (switcherRefs.current[pane]?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-dual-switcher-trigger]")) {
        return;
      }
      dismissSwitcher(pane);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissSwitcher(pane);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [dismissSwitcher, openSwitcherPane]);
  useEffect(() => {
    if (previousLayoutKeyRef.current === layoutKey) return;
    previousLayoutKeyRef.current = layoutKey;
    if (openSwitcherPane) dismissSwitcher(openSwitcherPane);
  }, [dismissSwitcher, layoutKey, openSwitcherPane]);
  useEffect(() => {
    const noteKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.key === "Tab") keyboardNavigationRef.current = true;
    };
    const notePointerNavigation = () => {
      keyboardNavigationRef.current = false;
    };
    document.addEventListener("keydown", noteKeyboardNavigation, true);
    document.addEventListener("pointerdown", notePointerNavigation, true);
    return () => {
      document.removeEventListener("keydown", noteKeyboardNavigation, true);
      document.removeEventListener("pointerdown", notePointerNavigation, true);
    };
  }, []);
  useLayoutEffect(() => {
    const paneSwapMotionActive =
      document.documentElement.classList.contains(DUAL_PANE_SWAP_ROOT_CLASS);
    if (!paneSwapMotionActive) {
      for (const animation of activeAnimationsRef.current) animation.cancel();
      activeAnimationsRef.current = [];
    }
    const previousPaneKeys = previousPaneKeysRef.current;
    const currentPaneKeys = {
      left: leftAnimationKey,
      right: rightAnimationKey,
    };
    previousPaneKeysRef.current = currentPaneKeys;
    const viewKindsByPane = { left: left.kind, right: right.kind } as const;
    if (isMotionReduced()) {
      return;
    }

    const crossedPanes = new Set<WorkspacePane>();
    const panesSwapped =
      previousPaneKeys.left !== previousPaneKeys.right &&
      previousPaneKeys.left === currentPaneKeys.right &&
      previousPaneKeys.right === currentPaneKeys.left;
    if (panesSwapped) {
      crossedPanes.add("left");
      crossedPanes.add("right");
      if (paneSwapMotionActive) return;
      const leftElement = workspaceRef.current?.querySelector<HTMLElement>('[data-pane="left"]');
      const rightElement = workspaceRef.current?.querySelector<HTMLElement>('[data-pane="right"]');
      if (leftElement && rightElement) {
        const leftRect = leftElement.getBoundingClientRect();
        const rightRect = rightElement.getBoundingClientRect();
        const paneDistance = rightRect.left - leftRect.left;
        if (paneDistance !== 0) {
          activeAnimationsRef.current.push(
            leftElement.animate(
              [{ transform: `translateX(${paneDistance}px)` }, { transform: "translateX(0)" }],
              spatialMotionTiming(paneDistance),
            ),
            rightElement.animate(
              [{ transform: `translateX(${-paneDistance}px)` }, { transform: "translateX(0)" }],
              spatialMotionTiming(paneDistance),
            ),
          );
        }
      }
    }

    (["left", "right"] as const).forEach((pane) => {
      if (
        crossedPanes.has(pane) ||
        previousPaneKeys[pane] === currentPaneKeys[pane] ||
        viewKindsByPane[pane] !== "document"
      )
        return;
      const body = workspaceRef.current?.querySelector<HTMLElement>(
        `[data-pane="${pane}"] .dual-document-pane__body`,
      );
      if (typeof body?.animate !== "function") return;
      const fromSelection = previousPaneKeys[pane] === "selection";
      activeAnimationsRef.current.push(
        body.animate(
          fromSelection
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: "translateY(4px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
          fromSelection ? SPATIAL_MOTION_TIMING : spatialMotionTiming(4),
        ),
      );
    });
  }, [left.kind, leftAnimationKey, right.kind, rightAnimationKey]);

  useEffect(
    () => () => {
      for (const animation of activeAnimationsRef.current) animation.cancel();
      swapMotionSequenceRef.current += 1;
      for (const frame of swapCommitFramesRef.current) window.cancelAnimationFrame(frame);
      swapCommitFramesRef.current = [];
      swapGhostLayerRef.current?.remove();
      swapGhostLayerRef.current = null;
      workspaceRef.current?.removeAttribute("data-swap-content-hidden");
      document.documentElement.classList.remove(DUAL_PANE_SWAP_ROOT_CLASS);
    },
    [],
  );

  const performSwap = () => {
    const workspace = workspaceRef.current;
    if (!workspace || isMotionReduced()) {
      onSwap();
      scheduleSplitSettledMeasurement();
      return;
    }
    const leftPane = workspace.querySelector<HTMLElement>('[data-pane="left"]');
    const rightPane = workspace.querySelector<HTMLElement>('[data-pane="right"]');
    if (!leftPane || !rightPane) {
      onSwap();
      scheduleSplitSettledMeasurement();
      return;
    }
    const paneDistance =
      rightPane.getBoundingClientRect().left - leftPane.getBoundingClientRect().left;
    if (!paneDistance) {
      onSwap();
      scheduleSplitSettledMeasurement();
      return;
    }

    const root = document.documentElement;
    const sequence = swapMotionSequenceRef.current + 1;
    swapMotionSequenceRef.current = sequence;
    root.classList.remove(DUAL_PANE_SWAP_ROOT_CLASS);
    for (const animation of activeAnimationsRef.current) animation.cancel();
    activeAnimationsRef.current = [];
    for (const frame of swapCommitFramesRef.current) window.cancelAnimationFrame(frame);
    swapCommitFramesRef.current = [];
    swapGhostLayerRef.current?.remove();
    swapGhostLayerRef.current = null;
    workspace.removeAttribute("data-swap-content-hidden");
    root.classList.add(DUAL_PANE_SWAP_ROOT_CLASS);

    const ghost = createPaneSwapGhosts(workspace, leftPane, rightPane, paneDistance);
    if (!ghost) {
      root.classList.remove(DUAL_PANE_SWAP_ROOT_CLASS);
      onSwap();
      scheduleSplitSettledMeasurement();
      return;
    }
    swapGhostLayerRef.current = ghost.layer;
    activeAnimationsRef.current = ghost.animations;

    const waitForPaint = new Promise<void>((resolve) => {
      const firstFrame = window.requestAnimationFrame(() => {
        swapCommitFramesRef.current = swapCommitFramesRef.current.filter(
          (frame) => frame !== firstFrame,
        );
        const secondFrame = window.requestAnimationFrame(() => {
          swapCommitFramesRef.current = swapCommitFramesRef.current.filter(
            (frame) => frame !== secondFrame,
          );
          resolve();
        });
        swapCommitFramesRef.current.push(secondFrame);
      });
      swapCommitFramesRef.current.push(firstFrame);
    });
    void waitForPaint.then(async () => {
      if (swapMotionSequenceRef.current !== sequence) return;
      try {
        flushSync(onSwap);
        if (typeof workspace.getAnimations === "function") {
          for (const animation of workspace.getAnimations({ subtree: true })) animation.cancel();
        }
        await Promise.allSettled(ghost.animations.map((animation) => animation.finished));
      } finally {
        if (swapMotionSequenceRef.current === sequence) {
          activeAnimationsRef.current = [];
          ghost.layer.remove();
          swapGhostLayerRef.current = null;
          workspace.removeAttribute("data-swap-content-hidden");
          root.classList.remove(DUAL_PANE_SWAP_ROOT_CLASS);
          // Document-key effects ran while the live panes were hidden by the ghosts.
          // Re-measure after revealing them, including each physical pane's zoom cap.
          scheduleSplitSettledMeasurement();
        }
      }
    });
  };

  const swapWithAnimation = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const previous = swapClickSequenceRef.current;
    const continuesSequence =
      previous !== null &&
      event.timeStamp - previous.timeStamp <= 1_000 &&
      Math.abs(event.clientX - previous.clientX) <= 8 &&
      Math.abs(event.clientY - previous.clientY) <= 8;
    swapClickSequenceRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      count: continuesSequence ? previous.count + 1 : 1,
      timeStamp: event.timeStamp,
    };
    performSwap();
  };
  const completeSwapDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const sequence = swapClickSequenceRef.current;
    if (
      sequence === null ||
      event.timeStamp - sequence.timeStamp > 1_000 ||
      Math.abs(event.clientX - sequence.clientX) > 8 ||
      Math.abs(event.clientY - sequence.clientY) > 8
    ) {
      return false;
    }
    swapClickSequenceRef.current = null;
    if (sequence.count < 2) performSwap();
    return true;
  };
  const swapControl = (
    <button
      type="button"
      className="dual-document-pane__swap"
      title="交换左右文档"
      aria-label="交换左右文档"
      data-dual-header-independent-control
      onClick={swapWithAnimation}
    >
      <svg
        className="dual-document-pane__swap-icon"
        viewBox="0 0 64 18"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M5 6.25h54L53.25 1.25" />
        <path d="M59 11.75H5l5.75 5" />
      </svg>
    </button>
  );
  const openSinglePane = (pane: WorkspacePane) => {
    setOpenSwitcherPane(null);
    onOpenSinglePane(pane);
  };
  const activateFromPointer = (
    pane: WorkspacePane,
    view: DualDocumentPaneView,
    active: boolean,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const preservesRetainedSelection =
      !active &&
      view.kind === "document" &&
      view.editorId &&
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.target instanceof Element &&
      event.target
        .closest("[data-patent-text-projection]")
        ?.getAttribute("data-patent-text-projection") === view.editorId &&
      !event.target.closest(
        "button, input, textarea, select, a[href], [role='button'], .document-structure-ruler, .patent-global-function-rail-slot, .patent-text-selection-gutter",
      ) &&
      hasNonEmptyTextSelection(view.editorId);
    preserveSelectionMouseDownPaneRef.current = preservesRetainedSelection ? pane : null;
    if (preservesRetainedSelection) {
      event.preventDefault();
      onPreserveSelectionPointer(event.pointerId);
      onRestoreRetainedSelection(view.editorId);
    }
    onActivatePane(pane);
  };
  const consumePreservedSelectionMouseDown = (
    pane: WorkspacePane,
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    if (preserveSelectionMouseDownPaneRef.current !== pane) return;
    preserveSelectionMouseDownPaneRef.current = null;
    event.preventDefault();
    event.stopPropagation();
  };
  const activateFromKeyboardFocus = (pane: WorkspacePane) => {
    if (!keyboardNavigationRef.current) return;
    keyboardNavigationRef.current = false;
    onActivatePane(pane);
  };
  const applySplitPercentImmediately = (nextPercent: number) => {
    splitPercentRef.current = nextPercent;
    const workspace = workspaceRef.current;
    const divider = dividerRef.current;
    if (workspace) workspace.style.gridTemplateColumns = dualDocumentSplitTemplate(nextPercent);
    if (!divider) return;
    const label = Math.round(nextPercent);
    const snappedToCenter = splitResizingRef.current && dualDocumentSplitIsCentered(nextPercent);
    const snapped = String(snappedToCenter);
    const value = String(label);
    const valueText = `左侧 ${label}%，右侧 ${100 - label}%`;
    if (divider.dataset.splitSnapped !== snapped) {
      divider.dataset.splitSnapped = snapped;
      setSplitSnappedToCenter(snappedToCenter);
    }
    if (divider.getAttribute("aria-valuenow") !== value)
      divider.setAttribute("aria-valuenow", value);
    if (divider.getAttribute("aria-valuetext") !== valueText) {
      divider.setAttribute("aria-valuetext", valueText);
    }
  };
  const scheduleSplitSettledMeasurement = () => {
    if (splitSettledFrameRef.current !== null) {
      window.cancelAnimationFrame(splitSettledFrameRef.current);
    }
    splitSettledFrameRef.current = window.requestAnimationFrame(() => {
      splitSettledFrameRef.current = null;
      splitMeasureRef.current?.();
      workspaceRef.current?.dispatchEvent(
        new Event(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT, { bubbles: true }),
      );
    });
  };
  const endSplitDrag = () => {
    if (!splitDragRef.current && !splitResizingRef.current) return;
    splitDragRef.current = null;
    splitResizingRef.current = false;
    if (workspaceRef.current) workspaceRef.current.dataset.splitResizing = "false";
    if (dividerRef.current) {
      dividerRef.current.dataset.splitResizing = "false";
      dividerRef.current.dataset.splitSnapped = "false";
    }
    setSplitSnappedToCenter(false);
    setSplitResizing(false);
    setSplitPercent(splitPercentRef.current);
    scheduleSplitSettledMeasurement();
  };
  /**
   * 拖动中线：按下时记下起点，之后按横向位移换算左栏占比，两侧宽度同时变化。
   * 指针捕获保证拖出分隔线（甚至拖到文档上）仍能继续，松开或丢失捕获即结束。
   */
  const startSplitDrag = (event: ReactPointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return;
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    event.preventDefault();
    splitDragRef.current = {
      startX: event.clientX,
      startPercent: splitPercentRef.current,
      containerWidth: rect.width,
      centerSnapArmed: splitPercentRef.current !== DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT,
    };
    splitResizingRef.current = true;
    if (workspaceRef.current) workspaceRef.current.dataset.splitResizing = "true";
    event.currentTarget.dataset.splitResizing = "true";
    const startsSnapped = dualDocumentSplitIsCentered(splitPercentRef.current);
    event.currentTarget.dataset.splitSnapped = String(startsSnapped);
    setSplitSnappedToCenter(startsSnapped);
    setSplitResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveSplitDrag = (event: ReactPointerEvent<HTMLHRElement>) => {
    const drag = splitDragRef.current;
    if (!drag) return;
    if ((event.buttons & 1) === 0) {
      endSplitDrag();
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (!drag.centerSnapArmed && Math.abs(deltaX) > DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX) {
      drag.centerSnapArmed = true;
    }
    applySplitPercentImmediately(
      dualDocumentSplitPercentAfterDrag(
        drag.startPercent,
        deltaX,
        drag.containerWidth,
        minimumWidths.current,
        drag.centerSnapArmed,
      ),
    );
  };
  /** 双击中线恢复等宽，给拖窄了之后留一条退路。 */
  const resetSplit = () => {
    endSplitDrag();
    applySplitPercentImmediately(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT);
    setSplitPercent(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT);
    scheduleSplitSettledMeasurement();
  };
  /** 键盘微调：方向键 2%，Shift + 方向键 10%，Home 恢复等宽。 */
  const adjustSplitFromKeyboard = (event: ReactKeyboardEvent<HTMLHRElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      resetSplit();
      return;
    }
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = direction * (event.shiftKey ? 10 : 2);
    const containerWidth = workspaceRef.current?.getBoundingClientRect().width ?? 0;
    const next = clampDualDocumentSplitPercent(
      splitPercentRef.current + step,
      containerWidth,
      minimumWidths.current,
    );
    splitPercentRef.current = next;
    setSplitPercent(next);
  };
  const splitPercentLabel = Math.round(splitPercent);
  /** 拖动中且已贴回等宽：分隔线换成绿色特效，明确告诉用户这里吸住了。 */
  const panes: ReactElement[] = [
    <DocumentPane
      key="dual-left"
      pane="left"
      view={left}
      active={activePane === "left"}
      initialRailSpace={initialRailSpace}
      externalToolIds={toolIdsByPane.left ?? []}
      switcher={switchers.left}
      switcherOpen={openSwitcherPane === "left"}
      switcherSession={switcherSession}
      onPointerActivate={(event) => activateFromPointer("left", left, activePane === "left", event)}
      onMouseDownActivate={(event) => consumePreservedSelectionMouseDown("left", event)}
      onKeyboardFocus={() => activateFromKeyboardFocus("left")}
      onToggleSwitcher={(trigger) => toggleSwitcher("left", trigger)}
      onOpenSingle={() => openSinglePane("left")}
      onCompleteSwapDoubleClick={completeSwapDoubleClick}
      onClose={() => onClosePane("left")}
      onSwitcherRef={(element) => {
        switcherRefs.current.left = element;
      }}
    />,
    <hr
      key="dual-divider"
      ref={dividerRef}
      className="dual-document-divider"
      data-layout-part="divider"
      data-split-resizing={splitResizing}
      data-split-snapped={splitSnappedToCenter}
      tabIndex={0}
      aria-label="双文档分隔线"
      aria-orientation="vertical"
      aria-valuemin={splitRange.min}
      aria-valuemax={splitRange.max}
      aria-valuenow={splitPercentLabel}
      aria-valuetext={`左侧 ${splitPercentLabel}%，右侧 ${100 - splitPercentLabel}%`}
      title="拖动调整两侧文档宽度，双击恢复等宽"
      onPointerDown={startSplitDrag}
      onPointerMove={moveSplitDrag}
      onPointerUp={endSplitDrag}
      onPointerCancel={endSplitDrag}
      onLostPointerCapture={endSplitDrag}
      onDoubleClick={resetSplit}
      onKeyDown={adjustSplitFromKeyboard}
    />,
    <DocumentPane
      key="dual-right"
      pane="right"
      view={right}
      active={activePane === "right"}
      initialRailSpace={initialRailSpace}
      externalToolIds={toolIdsByPane.right ?? []}
      switcher={switchers.right}
      switcherOpen={openSwitcherPane === "right"}
      switcherSession={switcherSession}
      onPointerActivate={(event) =>
        activateFromPointer("right", right, activePane === "right", event)
      }
      onMouseDownActivate={(event) => consumePreservedSelectionMouseDown("right", event)}
      onKeyboardFocus={() => activateFromKeyboardFocus("right")}
      onToggleSwitcher={(trigger) => toggleSwitcher("right", trigger)}
      onOpenSingle={() => openSinglePane("right")}
      onCompleteSwapDoubleClick={completeSwapDoubleClick}
      onClose={() => onClosePane("right")}
      onSwitcherRef={(element) => {
        switcherRefs.current.right = element;
      }}
      leadingControl={swapControl}
    />,
  ];

  return (
    <section
      className="dual-document-workspace"
      aria-label="同屏双文档工作区"
      ref={workspaceRef}
      data-split-resizing={splitResizing}
      style={{ gridTemplateColumns: dualDocumentSplitTemplate(splitPercent) }}
    >
      {panes}
    </section>
  );
}
