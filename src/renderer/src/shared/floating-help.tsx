import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { spatialMotionTiming, surfaceMotionDistance } from "./spatial-motion";
import { SpatialPresence } from "./spatial-presence";

let activeHelpDismiss: (() => void) | null = null;
let floatingHelpDetailed = true;
const detailSubscribers = new Set<() => void>();

export function setFloatingHelpDetailed(value: boolean) {
  if (floatingHelpDetailed === value) return;
  floatingHelpDetailed = value;
  for (const subscriber of detailSubscribers) subscriber();
}

function subscribeToDetailPreference(subscriber: () => void) {
  detailSubscribers.add(subscriber);
  return () => detailSubscribers.delete(subscriber);
}

export function floatingHelpPosition(
  anchor: DOMRect,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const gap = 18;
  const left =
    anchor.left - width - gap >= 8
      ? anchor.left - width - gap
      : anchor.right + gap + width <= viewportWidth - 8
        ? anchor.right + gap
        : Math.max(8, viewportWidth - width - 8);
  const top = Math.max(40, Math.min(anchor.top - 56, viewportHeight - height - 8));
  return { left, top };
}

type FloatingHelpProps = {
  showWhenDisabled?: boolean;
  target: string;
  ariaLabel: string;
  className: string;
  renderPanel: (detailed: boolean, onToggle: () => void) => ReactNode;
};

export function FloatingHelp({
  target,
  ariaLabel,
  className,
  renderPanel,
  showWhenDisabled = false,
}: FloatingHelpProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const detailed = useSyncExternalStore(
    subscribeToDetailPreference,
    () => floatingHelpDetailed,
    () => true,
  );
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const previousRect = useRef<DOMRect | null>(null);

  useEffect(() => {
    let active: HTMLElement | null = null;
    let title: string | null = null;
    let opening: ReturnType<typeof setTimeout> | undefined;
    let suppressFocus = false;
    let lastPointer: { x: number; y: number } | null = null;
    const dismiss = () => {
      clearTimeout(opening);
      if (active) {
        if (title !== null && !active.hasAttribute("title")) active.setAttribute("title", title);
        const descriptions = (active.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter((value) => value && value !== id);
        if (descriptions.length) active.setAttribute("aria-describedby", descriptions.join(" "));
        else active.removeAttribute("aria-describedby");
      }
      active = null;
      title = null;
      if (activeHelpDismiss === dismiss) activeHelpDismiss = null;
      setAnchor(null);
      setPosition(null);
    };
    const inPanel = (targetNode: EventTarget | null) =>
      targetNode instanceof Node && panelRef.current?.contains(targetNode);
    const scheduleClose = dismiss;
    const inPassage = (event: Event) => {
      if (!(event instanceof MouseEvent) || !active || !panelRef.current) return false;
      const button = active.getBoundingClientRect();
      const panel = panelRef.current.getBoundingClientRect();
      if (!button.width || !panel.width) return false;
      const left = panel.right <= button.left ? panel.right : button.right;
      const right = panel.right <= button.left ? button.left : panel.left;
      return (
        event.clientX >= left &&
        event.clientX <= right &&
        event.clientY >= Math.min(button.top, panel.top) &&
        event.clientY <= Math.max(button.bottom, panel.bottom)
      );
    };
    const enter = (event: Event) => {
      if (suppressFocus) return;
      if (event.type === "pointermove" && event instanceof MouseEvent) {
        const stationary = lastPointer?.x === event.clientX && lastPointer.y === event.clientY;
        lastPointer = { x: event.clientX, y: event.clientY };
        if (stationary && inPanel(document.activeElement)) return;
      }
      if (inPanel(event.target)) {
        return;
      }
      const button =
        event.target instanceof Element ? event.target.closest<HTMLElement>(target) : null;
      if (!button || button.closest("[role='dialog']")) {
        if (inPassage(event)) return;
        if (
          event.type === "focusin" &&
          active &&
          panelRef.current &&
          !inPanel(document.activeElement)
        )
          return;
        scheduleClose();
        return;
      }
      if (active === button) return;
      activeHelpDismiss?.();
      dismiss();
      active = button;
      title = button.getAttribute("title");
      button.removeAttribute("title");
      activeHelpDismiss = dismiss;
      opening = setTimeout(() => {
        if (!button.isConnected || (!showWhenDisabled && button.matches(":disabled"))) {
          dismiss();
          return;
        }
        const descriptions = button.getAttribute("aria-describedby");
        button.setAttribute("aria-describedby", descriptions ? `${descriptions} ${id}` : id);
        setAnchor(button);
      }, 550);
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      // Switching panel size can move the focused control out from under a
      // stationary pointer. A subsequent pointermove outside still dismisses.
      if (
        event instanceof MouseEvent &&
        lastPointer?.x === event.clientX &&
        lastPointer.y === event.clientY &&
        inPanel(event.target) &&
        inPanel(document.activeElement)
      )
        return;
      if (event.relatedTarget && inPassage(event)) return;
      if (
        event.relatedTarget instanceof Node &&
        (active?.contains(event.relatedTarget) || inPanel(event.relatedTarget))
      ) {
        return;
      }
      if (inPanel(event.target) || (event.target instanceof Node && active?.contains(event.target)))
        scheduleClose();
    };
    const down = (event: PointerEvent) => {
      if (!inPanel(event.target)) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const button = active;
        const restore = inPanel(event.target);
        dismiss();
        if (restore && button) {
          suppressFocus = true;
          button.focus({ preventScroll: true });
          suppressFocus = false;
        }
      } else if (event.key === "Tab" && panelRef.current && active) {
        if (!event.shiftKey && event.target instanceof Node && active.contains(event.target)) {
          event.preventDefault();
          panelRef.current
            .querySelector<HTMLButtonElement>("[role='switch']")
            ?.focus({ preventScroll: true });
        } else if (inPanel(event.target)) {
          const button = active;
          dismiss();
          suppressFocus = true;
          button.focus({ preventScroll: true });
          suppressFocus = false;
          if (event.shiftKey) event.preventDefault();
        }
      }
    };
    const scroll = (event: Event) => {
      if (!inPanel(event.target)) dismiss();
    };
    const observer = new MutationObserver(() => {
      if (active && (!active.isConnected || (!showWhenDisabled && active.matches(":disabled"))))
        dismiss();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    document.addEventListener("pointermove", enter, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", enter, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      observer.disconnect();
      dismiss();
      document.removeEventListener("pointermove", enter, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", enter, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [id, target, showWhenDisabled]);

  // Measure the new content before paint, then animate only numeric dimensions and position.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detailed changes the measured DOM size before paint.
  useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return;
    const panel = panelRef.current;
    let motion: Animation | null = null;
    const fades: Animation[] = [];
    const place = () => {
      if (motion) return;
      const rect = panel.getBoundingClientRect();
      setPosition(
        floatingHelpPosition(
          anchor.getBoundingClientRect(),
          rect.width,
          rect.height,
          innerWidth,
          innerHeight,
        ),
      );
    };
    place();
    const from = previousRect.current;
    previousRect.current = null;
    const reduced = isMotionReduced() ?? false;
    if (from && panel.animate && !reduced) {
      const rect = panel.getBoundingClientRect();
      const targetPosition = floatingHelpPosition(
        anchor.getBoundingClientRect(),
        rect.width,
        rect.height,
        innerWidth,
        innerHeight,
      );
      panel.style.overflow = "hidden";
      const timing = spatialMotionTiming(
        surfaceMotionDistance(
          new DOMRect(from.left, from.top, from.width, from.height),
          new DOMRect(targetPosition.left, targetPosition.top, rect.width, rect.height),
        ),
      );
      motion = panel.animate(
        [
          {
            width: `${from.width}px`,
            height: `${from.height}px`,
            left: `${from.left}px`,
            top: `${from.top}px`,
          },
          {
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            left: `${targetPosition.left}px`,
            top: `${targetPosition.top}px`,
          },
        ],
        timing,
      );
      for (const child of panel.children) {
        if (child instanceof HTMLElement && child.animate)
          fades.push(child.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      }
      motion.onfinish = () => {
        motion = null;
        panel.style.overflow = "";
        place();
      };
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
      motion?.cancel();
      for (const fade of fades) fade.cancel();
      panel.style.overflow = "";
    };
  }, [anchor, detailed]);

  return createPortal(
    <SpatialPresence>
      {anchor ? (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={ariaLabel}
          aria-modal="false"
          data-function-rail-owner={
            anchor
              .closest("[data-function-rail-scope]")
              ?.getAttribute("data-function-rail-scope") ??
            anchor
              .closest("[data-function-rail-owner]")
              ?.getAttribute("data-function-rail-owner") ??
            undefined
          }
          className={`floating-help-panel ${className}${detailed ? "" : " compact-panel"}`}
          style={{ ...position, visibility: position ? "visible" : "hidden" }}
        >
          {renderPanel(detailed, () => {
            previousRect.current = panelRef.current?.getBoundingClientRect() ?? null;
            setFloatingHelpDetailed(!detailed);
          })}
        </div>
      ) : null}
    </SpatialPresence>,
    document.body,
  );
}
