import { useEffect } from "react";
import { ignoreApplicationKeyEvent } from "../../../shared/platform";
import type { WorkspacePane } from "../patents/patent-workspace-layout";
import { canvasZoomFactor, wheelPixels } from "../shared/canvas-wheel";
import { hasVisibleElement } from "../shared/focusable-elements";

export function useWorkspaceZoomInput(
  zoom: (amount: number, multiplicative?: boolean, pane?: WorkspacePane) => void,
  reset: () => void,
) {
  useEffect(() => {
    let frame: number | null = null;
    const pixelsByPane = new Map<WorkspacePane | undefined, number>();
    const blocked = () => hasVisibleElement('[role="dialog"][aria-modal="true"]');
    const cancelWheel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      pixelsByPane.clear();
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        ignoreApplicationKeyEvent(event) ||
        event.altKey ||
        (!event.ctrlKey && !event.metaKey) ||
        blocked()
      )
        return;
      const plus = event.key === "+" || event.key === "=";
      if (!plus && event.shiftKey) return;
      if (!plus && event.key !== "-" && event.key !== "0") return;
      event.preventDefault();
      cancelWheel();
      if (event.key === "0") reset();
      else zoom(plus ? 10 : -10);
    };
    const wheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        ignoreApplicationKeyEvent(event) ||
        (!event.ctrlKey && !event.metaKey) ||
        blocked()
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      const paneElement = target?.closest<HTMLElement>(".dual-document-pane");
      if (
        !target ||
        (!target.closest(".editor-workspace") && !paneElement) ||
        target.closest(".drawing-workspace, .flowchart-workspace")
      )
        return;
      event.preventDefault();
      const side = paneElement?.dataset.pane;
      const pane = side === "left" || side === "right" ? side : undefined;
      const pixels =
        (pixelsByPane.get(pane) ?? 0) +
        wheelPixels(event.deltaY, event.deltaMode, window.innerHeight);
      pixelsByPane.set(pane, pixels);
      if (frame !== null || pixels === 0) return;
      frame = requestAnimationFrame(() => {
        // Use CAD's continuous curve, limiting coarse notches and event bursts
        // to about 4.6% per rendered frame without discarding fine input.
        frame = null;
        const pending = [...pixelsByPane];
        pixelsByPane.clear();
        if (blocked()) return;
        for (const [pane, pixels] of pending) {
          const next =
            1 / canvasZoomFactor(Math.max(-32, Math.min(32, pixels)), 0, window.innerHeight);
          if (next !== 1) zoom(next, true, pane);
        }
      });
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelWheel();
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("wheel", wheel);
    };
  }, [zoom, reset]);
}
