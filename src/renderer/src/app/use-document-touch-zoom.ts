import { useEffect, useRef } from "react";
import type { WorkspacePane } from "../patents/patent-workspace-layout";
import { hasVisibleElement } from "../shared/focusable-elements";
import { isTabletInteraction, isTextEntry } from "../shared/tablet-input";

export function useDocumentTouchZoom(
  zoom: (factor: number, multiplicative?: boolean, pane?: WorkspacePane) => void,
) {
  const latest = useRef(zoom);
  latest.current = zoom;
  useEffect(() => {
    let gesture: {
      ids: number[];
      distance: number;
      viewport: HTMLElement;
      pane?: WorkspacePane;
    } | null = null;
    let frame = 0,
      cleanupFrame = 0,
      factor = 1;
    let finishing = false;
    let paintedViewport: HTMLElement | null = null;
    const clearPaint = () => {
      if (!paintedViewport) return;
      delete paintedViewport.dataset.documentTouchZoom;
      delete paintedViewport.dataset.touchZoomAnchorX;
      delete paintedViewport.dataset.touchZoomAnchorY;
      paintedViewport = null;
    };
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      const delta = factor;
      factor = 1;
      if (gesture && delta !== 1) latest.current(delta, true, gesture.pane);
    };
    const clear = () => {
      flush();
      gesture = null;
      cleanupFrame = requestAnimationFrame(clearPaint);
    };
    const start = (event: TouchEvent) => {
      if (gesture) {
        event.preventDefault();
        return;
      }
      if (
        !isTabletInteraction() ||
        finishing ||
        event.touches.length !== 2 ||
        hasVisibleElement('[role="dialog"][aria-modal="true"]')
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest(
          '.patent-global-function-rail, .drawing-workspace, .flowchart-workspace, input, textarea, math-field, [role="menu"]',
        )
      )
        return;
      const viewport = target.closest<HTMLElement>(".patent-editor-workspace, .editor-workspace");
      if (
        !viewport ||
        !Array.from(event.touches).every(
          (t) => t.target instanceof Node && viewport.contains(t.target),
        )
      )
        return;
      const [a, b] = Array.from(event.touches) as [Touch, Touch];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (distance < 8) return;
      cancelAnimationFrame(cleanupFrame);
      clearPaint();
      paintedViewport = viewport;
      const side = viewport.closest<HTMLElement>(".dual-document-pane")?.dataset.pane;
      gesture = {
        ids: [a.identifier, b.identifier],
        distance,
        viewport,
        ...(side === "left" || side === "right" ? { pane: side } : {}),
      };
      viewport.dataset.documentTouchZoom = "true";
      const active = document.activeElement;
      if (isTextEntry(active) && viewport.contains(active)) active.blur();
      event.preventDefault();
    };
    const move = (event: TouchEvent) => {
      if (!gesture) {
        if (finishing && event.cancelable) event.preventDefault();
        return;
      }
      const [a, b] = gesture.ids.map((id) =>
        Array.from(event.touches).find((t) => t.identifier === id),
      );
      if (!a || !b) {
        clear();
        finishing = event.touches.length > 0;
        return;
      }
      if (!event.cancelable) {
        clear();
        finishing = true;
        return;
      }
      event.preventDefault();
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (distance < 8) return;
      factor *= distance / gesture.distance;
      gesture.distance = distance;
      gesture.viewport.dataset.touchZoomAnchorX = String((a.clientX + b.clientX) / 2);
      gesture.viewport.dataset.touchZoomAnchorY = String((a.clientY + b.clientY) / 2);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const end = (event: TouchEvent) => {
      if (
        gesture &&
        !gesture.ids.every((id) => Array.from(event.touches).some((t) => t.identifier === id))
      )
        clear();
      finishing = event.touches.length > 0;
    };
    const cancel = () => {
      clear();
      finishing = false;
    };
    window.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(cleanupFrame);
      gesture = null;
      clearPaint();
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);
}
