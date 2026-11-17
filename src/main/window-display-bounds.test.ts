import { EventEmitter } from "node:events";
import {
  fitWindowBounds,
  initialWindowBounds,
  installDisplayBoundsProtection,
} from "./window-display-bounds.js";

vi.mock("electron", () => ({ screen: {} }));

test.each([
  { x: 0, y: 0, width: 1093, height: 574 },
  { x: -1280, y: 20, width: 1280, height: 680 },
  { x: 0, y: 0, width: 1920, height: 1040 },
])("startup fits within the logical work area $width x $height", (area) => {
  const bounds = initialWindowBounds(area);
  expect(bounds.x).toBeGreaterThanOrEqual(area.x);
  expect(bounds.y).toBeGreaterThanOrEqual(area.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
  expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height);
});

test("preserves the existing default size when the display has enough room", () => {
  expect(initialWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toMatchObject({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
  });
});

test("recovers a window from a removed monitor with negative coordinates", () => {
  expect(
    fitWindowBounds(
      { x: -1800, y: 100, width: 1440, height: 900 },
      { x: 0, y: 0, width: 1093, height: 574 },
    ),
  ).toEqual({ x: 0, y: 0, width: 1093, height: 574 });
});

test("restores the normal minimum before positioning on a larger monitor", () => {
  expect(
    fitWindowBounds(
      { x: 1100, y: 800, width: 900, height: 500 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ),
  ).toEqual({ x: 896, y: 340, width: 1024, height: 700 });
});

test("adapts after display changes, leaves maximized windows alone, and releases listeners", () => {
  vi.useFakeTimers();
  try {
    let area = { x: 0, y: 0, width: 1920, height: 1040 };
    let bounds = { x: 200, y: 50, width: 1440, height: 900 };
    const events = new EventEmitter();
    const displays = Object.assign(new EventEmitter(), {
      getDisplayMatching: () => ({ workArea: area }),
    });
    const window = Object.assign(events, {
      getBounds: () => bounds,
      setBounds: vi.fn((next: typeof bounds) => {
        bounds = next;
      }),
      setMinimumSize: vi.fn(),
      isDestroyed: () => false,
      isMaximized: vi.fn(() => false),
      isMinimized: () => false,
      isFullScreen: () => false,
    });
    installDisplayBoundsProtection(window as never, displays as never);
    expect(window.setBounds).not.toHaveBeenCalled();
    area = { x: 1920, y: 0, width: 1093, height: 574 };
    bounds = { ...bounds, x: 2000 };
    events.emit("moved");
    vi.advanceTimersByTime(100);
    expect(bounds).toEqual({ x: 1920, y: 0, width: 1093, height: 574 });
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(1024, 574);
    window.setBounds.mockClear();
    window.isMaximized.mockReturnValue(true);
    area = { x: 0, y: 0, width: 900, height: 500 };
    displays.emit("display-metrics-changed");
    vi.advanceTimersByTime(100);
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(900, 500);
    expect(window.setBounds).not.toHaveBeenCalled();
    window.isMaximized.mockReturnValue(false);
    events.emit("unmaximize");
    vi.advanceTimersByTime(100);
    expect(bounds).toEqual({ x: 0, y: 0, width: 900, height: 500 });
    events.emit("closed");
    expect(displays.listenerCount("display-metrics-changed")).toBe(0);
    expect(displays.listenerCount("display-removed")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
