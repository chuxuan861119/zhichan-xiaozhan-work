import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { canvasZoomFactor } from "../shared/canvas-wheel";
import type { DrawingView } from "./fixed-line-preview";

type ScreenPanMatrix = Pick<DOMMatrixReadOnly, "a" | "b" | "c" | "d">;

/**
 * Fragmented previews move their direct fragment layers as a unit. A vector
 * image nested below one of those layers must not receive the live pan
 * translation a second time.
 */
export function shouldTranslateLivePanImage(image: Pick<Element, "closest">) {
  return image.closest("[data-base-fragments]") === null;
}

/** Convert the live screen translation back into the view that is committed on release. */
export function panViewByScreenDelta(
  view: DrawingView,
  screenInverse: ScreenPanMatrix,
  screenX: number,
  screenY: number,
): DrawingView {
  return {
    ...view,
    x: view.x - screenInverse.a * screenX - screenInverse.c * screenY,
    y: view.y - screenInverse.b * screenX - screenInverse.d * screenY,
  };
}

export function wheelZoomFactor(delta: number, mode: number, pageHeight: number, pinch = false) {
  return canvasZoomFactor(delta, mode, pageHeight, pinch);
}

export function useSmoothDrawingView(initial: DrawingView) {
  const [view, publish] = useState(initial);
  const current = useRef(view);
  const getView = useCallback(() => current.current, []);
  const frame = useRef<number | null>(null);
  const panFrame = useRef<number | null>(null);
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
    panFrame.current = null;
  }, []);
  useEffect(() => stop, [stop]);
  const setView = useCallback(
    (action: SetStateAction<DrawingView>) => {
      stop();
      current.current = typeof action === "function" ? action(current.current) : action;
      publish(current.current);
    },
    [stop],
  );
  const pan = useCallback((next: DrawingView) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    current.current = next;
    if (panFrame.current !== null) return;
    panFrame.current = requestAnimationFrame(() => {
      panFrame.current = null;
      publish(current.current);
    });
  }, []);
  const flushPan = useCallback(() => {
    if (panFrame.current === null) return;
    cancelAnimationFrame(panFrame.current);
    panFrame.current = null;
    publish(current.current);
  }, []);
  const panBy = useCallback(
    (screenInverse: ScreenPanMatrix, screenX: number, screenY: number) => {
      pan(panViewByScreenDelta(current.current, screenInverse, screenX, screenY));
    },
    [pan],
  );
  const zoom = useCallback(
    (factor: number, anchor: { x: number; y: number }, min: number, max: number) => {
      if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(min) || min <= 0 || min > max)
        return;
      if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
      panFrame.current = null;
      const previous = current.current;
      const width = Math.max(min, Math.min(max, previous.width * factor));
      const height = (previous.height * width) / previous.width;
      const target = {
        x: previous.x + (previous.width - width) * anchor.x,
        y: previous.y + (previous.height - height) * anchor.y,
        width,
        height,
      };
      if (width === previous.width) return;
      // Wheel input is direct manipulation: accumulate every delta, then publish
      // once per display frame. Restarting an easing timer starves continuous input.
      current.current = target;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        publish(current.current);
      });
    },
    [],
  );
  return { view, getView, setView, pan, panBy, flushPan, zoom, stop };
}
