import { type BrowserWindow, screen } from "electron";

type Rectangle = Electron.Rectangle;
type DisplayApi = Pick<typeof screen, "getDisplayMatching" | "on" | "removeListener">;
type WindowTarget = Pick<
  BrowserWindow,
  | "getBounds"
  | "setBounds"
  | "setMinimumSize"
  | "isDestroyed"
  | "isMaximized"
  | "isMinimized"
  | "isFullScreen"
  | "on"
>;

export function minimumWindowSize(area: Rectangle) {
  return {
    minWidth: Math.min(1024, Math.max(1, Math.floor(area.width))),
    minHeight: Math.min(700, Math.max(1, Math.floor(area.height))),
  };
}

export function fitWindowBounds(bounds: Rectangle, area: Rectangle): Rectangle {
  const minimum = minimumWindowSize(area);
  const width = Math.max(minimum.minWidth, Math.min(bounds.width, Math.max(1, area.width)));
  const height = Math.max(minimum.minHeight, Math.min(bounds.height, Math.max(1, area.height)));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}

export function initialWindowBounds(area: Rectangle) {
  const width = Math.min(1440, Math.max(1, area.width));
  const height = Math.min(900, Math.max(1, area.height));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    ...minimumWindowSize(area),
  };
}

/** Reconcile native window bounds after a monitor or its usable area changes. */
export function installDisplayBoundsProtection(
  window: WindowTarget,
  displays: DisplayApi = screen,
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousArea = "";
  let forceFit = false;
  const reconcile = () => {
    timer = undefined;
    if (disposed || window.isDestroyed()) return;
    const bounds = window.getBounds();
    const area = displays.getDisplayMatching(bounds).workArea;
    const key = `${area.x}:${area.y}:${area.width}:${area.height}`;
    const changed = key !== previousArea || forceFit;
    previousArea = key;
    forceFit = false;
    const minimum = minimumWindowSize(area);
    window.setMinimumSize(minimum.minWidth, minimum.minHeight);
    if (!changed || window.isMaximized() || window.isMinimized() || window.isFullScreen()) return;
    const next = fitWindowBounds(bounds, area);
    if (
      next.x !== bounds.x ||
      next.y !== bounds.y ||
      next.width !== bounds.width ||
      next.height !== bounds.height
    )
      window.setBounds(next);
  };
  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(reconcile, 100);
  };
  const restore = () => {
    forceFit = true;
    schedule();
  };
  window.on("moved", schedule);
  window.on("unmaximize", restore);
  window.on("restore", restore);
  window.on("leave-full-screen", restore);
  displays.on("display-metrics-changed", schedule);
  displays.on("display-removed", schedule);
  window.on("closed", () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    displays.removeListener("display-metrics-changed", schedule);
    displays.removeListener("display-removed", schedule);
  });
  reconcile();
}
