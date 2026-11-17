import {
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { FIXED_MOTION_DURATIONS } from "../shared/spatial-motion";
import { useDialogDrag } from "../shared/use-dialog-drag";
import "../shared/standard-dialog.css";
import type { PatentBookKind } from "../../../shared/patent/model";
import {
  type PatentFunctionRailController,
  useOptionalPatentFunctionRail,
} from "./function-rail/function-rail-context";
import { useFunctionRailMeasurement } from "./function-rail/use-function-rail-measurement";
import { useRailVisibleHeight } from "./function-rail/use-rail-visible-height";
import "./function-rail/function-rail-responsive.css";
import { DualColumnContext } from "./dual-column-context";

type PatentGlobalFunctionRailProps = {
  bookKind: PatentBookKind;
  title: string;
  measurementKey?: number;
  onCollapse?(): void;
  draggableWhenPinned?: boolean;
  dragTopBoundaryRef?: RefObject<HTMLElement | null>;
  headerContent?: ReactNode;
  children: ReactNode;
};

const FUNCTION_RAIL_ENTRY_KEYFRAMES = [
  {
    opacity: 0,
    clipPath: "inset(-32px -32px 100% -32px)",
    transform: "translateY(-8px)",
  },
  {
    opacity: 1,
    clipPath: "inset(-32px -32px -32px -32px)",
    transform: "translateY(0)",
  },
];
const FUNCTION_RAIL_EXIT_RETENTION_MS = FIXED_MOTION_DURATIONS.functionRail + 20;

export function PatentGlobalFunctionRail({
  bookKind,
  title,
  measurementKey,
  onCollapse,
  draggableWhenPinned = false,
  dragTopBoundaryRef,
  headerContent,
  children,
}: PatentGlobalFunctionRailProps) {
  const controller = useOptionalPatentFunctionRail();

  if (controller) {
    return (
      <ControlledPatentGlobalFunctionRail
        bookKind={bookKind}
        title={title}
        {...(measurementKey === undefined ? {} : { measurementKey })}
        {...(onCollapse ? { onCollapse } : {})}
        draggableWhenPinned={draggableWhenPinned}
        {...(dragTopBoundaryRef ? { dragTopBoundaryRef } : {})}
        controller={controller}
        headerContent={headerContent}
      >
        {children}
      </ControlledPatentGlobalFunctionRail>
    );
  }

  return (
    <div
      className="patent-global-function-rail-slot"
      data-book-kind={bookKind}
      data-expanded="true"
      data-layout="docked"
      data-reason="auto"
    >
      <aside
        className="patent-global-function-rail"
        aria-label={`${title}全局功能栏`}
        data-book-kind={bookKind}
        data-custom-header={!!headerContent || undefined}
      >
        {headerContent ? (
          <header className="patent-global-function-rail__header">{headerContent}</header>
        ) : null}
        <div className="patent-global-function-rail__body">{children}</div>
      </aside>
    </div>
  );
}

type ControlledPatentGlobalFunctionRailProps = PatentGlobalFunctionRailProps & {
  controller: PatentFunctionRailController;
};

function ControlledPatentGlobalFunctionRail({
  bookKind,
  title,
  measurementKey,
  onCollapse,
  draggableWhenPinned = false,
  dragTopBoundaryRef,
  headerContent,
  children,
  controller,
}: ControlledPatentGlobalFunctionRailProps) {
  const dualColumn = useContext(DualColumnContext);
  const slotRef = useRef<HTMLDivElement>(null);
  const edgeToggleRef = useRef<HTMLDivElement>(null);
  const expanded = controller.presentation.expanded;
  const pinned = controller.userIntent === "pinned";
  const draggable = draggableWhenPinned && pinned && expanded;
  const [dragMinTop, setDragMinTop] = useState(0);
  useLayoutEffect(() => {
    const boundary = dragTopBoundaryRef?.current;
    if (!draggableWhenPinned || !boundary) return;
    const measure = () => setDragMinTop(Math.max(0, boundary.getBoundingClientRect().bottom));
    const observer = new ResizeObserver(measure);
    observer.observe(boundary);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [draggableWhenPinned, dragTopBoundaryRef]);
  const drag = useDialogDrag<HTMLElement>({
    positionKey: `function-rail:${controller.scopeKey}`,
    memory: "none",
    movable: draggable,
    minTop: dragMinTop,
    dragFromControls: draggableWhenPinned,
  });
  const exitRect = useRef<DOMRect | null>(null);
  const exitLayout = useRef(controller.presentation.layout);
  const [retained, setRetained] = useState(expanded);
  useLayoutEffect(() => {
    if (expanded) {
      exitRect.current = null;
      setRetained(true);
      return;
    }
    if (isMotionReduced()) {
      setRetained(false);
      return;
    }
    // Outlast the 600ms exit without depending on throttled animation events.
    const timer = setTimeout(() => setRetained(false), FUNCTION_RAIL_EXIT_RETENTION_MS);
    return () => clearTimeout(timer);
  }, [expanded]);
  const measurementAnchorRef = useRef<HTMLSpanElement>(null);
  useRailVisibleHeight(
    slotRef,
    `${controller.presentation.layout}:${controller.presentation.expanded}`,
    controller.edgeHostElement,
  );
  const [visibleInWorkspace, setVisibleInWorkspace] = useState(true);
  const wasVisibleInWorkspace = useRef(true);
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useFunctionRailMeasurement(measurementAnchorRef, measurementKey, () => {
    if (!expanded) return;
    const rail = slotRef.current?.querySelector<HTMLElement>(".patent-global-function-rail");
    exitRect.current = rail?.getBoundingClientRect() ?? null;
    exitLayout.current = controller.presentation.layout;
  });

  useLayoutEffect(() => {
    const nextVisible =
      measurementAnchorRef.current?.closest(
        '[hidden], .patent-book-transition-surface[data-active="false"]',
      ) === null;
    setVisibleInWorkspace((current) => (current === nextVisible ? current : nextVisible));
  });

  useLayoutEffect(() => {
    const becameVisible = visibleInWorkspace && !wasVisibleInWorkspace.current;
    wasVisibleInWorkspace.current = visibleInWorkspace;
    if (
      !becameVisible ||
      !expanded ||
      isMotionReduced() ||
      document.documentElement.classList.contains("library-editor-view-transition")
    ) {
      return undefined;
    }
    const rail = slotRef.current?.querySelector<HTMLElement>(
      '.patent-global-function-rail[data-motion="enter"]',
    );
    if (!rail || typeof rail.animate !== "function") return undefined;
    const animation = rail.animate(FUNCTION_RAIL_ENTRY_KEYFRAMES, {
      duration: FIXED_MOTION_DURATIONS.functionRail,
      easing: "ease-in-out",
    });
    return () => animation.cancel();
  }, [expanded, visibleInWorkspace]);

  const clearHoverOpenTimer = () => {
    if (hoverOpenTimer.current === null) return;
    clearTimeout(hoverOpenTimer.current);
    hoverOpenTimer.current = null;
  };
  const clearHoverCloseTimer = () => {
    if (hoverCloseTimer.current === null) return;
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  };

  useEffect(
    () => () => {
      if (hoverOpenTimer.current !== null) clearTimeout(hoverOpenTimer.current);
      if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (visibleInWorkspace) return;
    if (hoverOpenTimer.current !== null) clearTimeout(hoverOpenTimer.current);
    if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
    hoverOpenTimer.current = null;
    hoverCloseTimer.current = null;
  }, [visibleInWorkspace]);

  const scheduleHoverOpen = () => {
    clearHoverCloseTimer();
    clearHoverOpenTimer();
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = null;
      controller.setHovered(true);
    }, 150);
  };
  const scheduleHoverClose = () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null;
      controller.setHovered(false);
    }, 250);
  };
  const scheduleHoverCloseAfterPointerOut = (event: React.PointerEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    scheduleHoverClose();
  };
  const keepHoverOpen = () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    controller.setHovered(true);
  };
  const releaseInteractionAfterFocusLeaves = (event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    controller.setInteractionActive(false);
  };
  const collapse = () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    if (draggableWhenPinned && expanded) {
      exitRect.current = drag.surfaceRef.current?.getBoundingClientRect() ?? null;
      exitLayout.current = controller.presentation.layout;
    }
    controller.setHovered(false);
    controller.setInteractionActive(false);
    controller.collapse();
    onCollapse?.();
  };
  const releasePin = () => {
    if (!draggableWhenPinned) {
      controller.releasePin();
      return;
    }
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    exitRect.current = drag.surfaceRef.current?.getBoundingClientRect() ?? null;
    exitLayout.current = controller.presentation.layout;
    controller.setHovered(false);
    controller.setInteractionActive(false);
    controller.releasePin();
  };
  const visualLayout =
    !expanded && retained && exitRect.current ? exitLayout.current : controller.presentation.layout;
  const showHeaderActions = visualLayout === "overlay";

  useEffect(() => {
    if (!visibleInWorkspace || !controller.presentation.expanded) return undefined;
    const clearTrackedHoverCloseTimer = () => {
      if (hoverCloseTimer.current === null) return;
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    };
    const scheduleTrackedHoverClose = () => {
      if (hoverCloseTimer.current !== null) return;
      hoverCloseTimer.current = setTimeout(() => {
        hoverCloseTimer.current = null;
        controller.setHovered(false);
      }, 250);
    };
    const trackRailPointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (slotRef.current?.contains(target) || edgeToggleRef.current?.contains(target))
      ) {
        clearTrackedHoverCloseTimer();
        return;
      }
      scheduleTrackedHoverClose();
    };
    document.addEventListener("pointermove", trackRailPointer, true);
    return () => document.removeEventListener("pointermove", trackRailPointer, true);
  }, [controller.presentation.expanded, controller.setHovered, visibleInWorkspace]);

  const toggle = (
    <button
      type="button"
      className="patent-global-function-rail__collapsed-toggle"
      aria-label="展开功能栏"
      aria-expanded={expanded}
      onClick={keepHoverOpen}
    >
      <span aria-hidden="true">‹</span>
      <span>功能栏</span>
    </button>
  );
  const edgeToggle =
    dualColumn &&
    (!expanded || showHeaderActions) &&
    controller.edgeHostElement &&
    visibleInWorkspace;
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const handle = edgeToggleRef.current;
    if (!slot || !handle || !dualColumn || !showHeaderActions || !expanded || !visibleInWorkspace)
      return;
    const alignOverlay = () => {
      const gap =
        Number.parseFloat(getComputedStyle(slot).getPropertyValue("--patent-function-rail-gap")) ||
        12;
      // The page group is centered, while its collapsed handle is at the window edge.
      // Keep the overlay beside the handle without moving the docked page-side rail.
      slot.style.setProperty(
        "--dual-column-overlay-right",
        `${slot.getBoundingClientRect().right - handle.getBoundingClientRect().left + gap}px`,
      );
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(alignOverlay);
    observer?.observe(slot);
    if (slot.parentElement) observer?.observe(slot.parentElement);
    if (controller.edgeHostElement) observer?.observe(controller.edgeHostElement);
    window.addEventListener("resize", alignOverlay);
    document.addEventListener("scroll", alignOverlay, true);
    alignOverlay();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", alignOverlay);
      document.removeEventListener("scroll", alignOverlay, true);
      slot.style.removeProperty("--dual-column-overlay-right");
    };
  }, [dualColumn, showHeaderActions, expanded, controller.edgeHostElement, visibleInWorkspace]);
  const slot = (
    <div
      ref={slotRef}
      className="patent-global-function-rail-slot"
      data-book-kind={bookKind}
      data-expanded={controller.presentation.expanded}
      data-layout={visualLayout}
      data-reason={controller.presentation.reason}
      hidden={!visibleInWorkspace}
      inert={!visibleInWorkspace}
      onPointerEnter={scheduleHoverOpen}
      onPointerLeave={scheduleHoverClose}
      onPointerOut={scheduleHoverCloseAfterPointerOut}
    >
      {!edgeToggle && (!expanded || showHeaderActions) ? toggle : null}
      {/* Keep tool state and shortcuts alive when only the rail's presentation is collapsed. */}
      <aside
        ref={drag.surfaceRef}
        className="patent-global-function-rail"
        data-draggable={draggable || undefined}
        data-custom-header={!!headerContent || undefined}
        data-dragging={drag.dragging || undefined}
        data-motion={expanded ? "enter" : "exit"}
        style={
          !expanded && !retained
            ? { display: "none" }
            : !expanded && exitRect.current
              ? {
                  position: "fixed",
                  left: exitRect.current.left,
                  top: exitRect.current.top,
                  right: "auto",
                  width: exitRect.current.width,
                }
              : draggable
                ? {
                    ...drag.style,
                    ...(drag.style.position
                      ? {
                          right: "auto",
                          maxHeight: `min(var(--rail-visible-height, 100vh), calc(100dvh - ${drag.style.top}px - 12px))`,
                        }
                      : {}),
                  }
                : undefined
        }
        hidden={!expanded && !retained}
        inert={!expanded}
        aria-hidden={!expanded}
        aria-label={`${title}全局功能栏`}
        data-book-kind={bookKind}
        onPointerEnter={keepHoverOpen}
        onPointerLeave={scheduleHoverClose}
        onFocusCapture={() => controller.setInteractionActive(true)}
        onBlurCapture={releaseInteractionAfterFocusLeaves}
        onPointerDownCapture={draggableWhenPinned ? drag.onPointerDownCapture : undefined}
        onClickCapture={draggableWhenPinned ? drag.onClickCapture : undefined}
      >
        {showHeaderActions || headerContent ? (
          <header
            className="patent-global-function-rail__header"
            onPointerDown={draggable ? drag.onPointerDown : undefined}
          >
            {headerContent}
            {showHeaderActions ? (
              <div className="patent-global-function-rail__header-actions">
                <button
                  type="button"
                  className="patent-global-function-rail__header-action dialog-close-button dialog-close-control"
                  aria-label={pinned ? "取消固定" : "固定"}
                  aria-pressed={pinned}
                  title={pinned ? "取消固定" : "固定"}
                  onClick={pinned ? releasePin : controller.pin}
                >
                  <svg
                    className="dialog-close-icon"
                    aria-hidden="true"
                    focusable="false"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    data-pin-state={pinned ? "pinned" : "unpinned"}
                    style={{ transform: pinned ? "rotate(0deg)" : "rotate(-32deg)" }}
                  >
                    <path d="M5 2.5h6M6 2.5v4L4.5 8v1h7V8L10 6.5v-4M8 9v4.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="patent-global-function-rail__header-action dialog-close-button dialog-close-control"
                  aria-label="收起功能栏"
                  aria-expanded="true"
                  title={draggableWhenPinned ? undefined : "收起功能栏"}
                  data-tool-tooltip={draggableWhenPinned ? "off" : undefined}
                  onClick={collapse}
                >
                  <DialogCloseIcon />
                </button>
              </div>
            ) : null}
          </header>
        ) : null}
        <div className="patent-global-function-rail__body">{children}</div>
      </aside>
    </div>
  );

  return (
    <>
      {edgeToggle && controller.edgeHostElement
        ? createPortal(
            <div
              className="dual-column-edge-toggle"
              ref={edgeToggleRef}
              onPointerEnter={scheduleHoverOpen}
              onPointerLeave={scheduleHoverClose}
            >
              {toggle}
            </div>,
            controller.edgeHostElement,
          )
        : null}
      <span
        ref={measurementAnchorRef}
        className="patent-function-rail-measurement-anchor"
        aria-hidden="true"
      />
      {controller.presentation.layout === "overlay" &&
      !dualColumn &&
      controller.edgeHostElement
        ? createPortal(slot, controller.edgeHostElement)
        : slot}
    </>
  );
}
