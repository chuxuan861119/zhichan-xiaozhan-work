import {
  type KlecksViewport,
  panViewport,
  type ViewportPoint,
  zoomViewport,
} from "./klecks-viewport";

type Wheel = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "altKey">;
export function wheelViewport(
  view: KlecksViewport,
  event: Wheel,
  anchor: ViewportPoint,
  pageHeight: number,
  zoomWithWheel: boolean,
): KlecksViewport {
  if (![event.deltaX, event.deltaY, pageHeight].every(Number.isFinite))
    throw new Error("滚轮导航参数无效。");
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  if (zoomWithWheel || event.altKey) {
    const exponent = Math.max(-10, Math.min(10, (-event.deltaY * unit) / 500));
    return zoomViewport(
      view,
      Math.max(0.01, Math.min(128, view.zoom * Math.exp(exponent))),
      anchor,
    );
  }
  return panViewport(view, { x: -event.deltaX * unit, y: -event.deltaY * unit });
}

export function bindKlecksWheelInput(
  element: HTMLElement,
  driver: {
    viewport(): KlecksViewport | null;
    enabled(): boolean;
    zoomWithWheel(): boolean;
    changed(view: KlecksViewport): void;
    error(error: unknown): void;
  },
): () => void {
  const wheel = (event: WheelEvent) => {
    const view = driver.viewport();
    if (!view || event.defaultPrevented) return;
    // Own wheel events only over the canvas. A pending gesture must not scroll the page.
    event.preventDefault();
    event.stopPropagation();
    if (!driver.enabled() || event.ctrlKey || event.metaKey) return;
    const box = element.getBoundingClientRect();
    try {
      driver.changed(
        wheelViewport(
          view,
          event,
          { x: event.clientX - box.left, y: event.clientY - box.top },
          box.height,
          driver.zoomWithWheel(),
        ),
      );
    } catch (error) {
      driver.error(error);
    }
  };
  element.addEventListener("wheel", wheel, { passive: false });
  return () => element.removeEventListener("wheel", wheel);
}
