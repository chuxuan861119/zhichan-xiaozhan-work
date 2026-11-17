import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  panViewByScreenDelta,
  shouldTranslateLivePanImage,
  useSmoothDrawingView,
  wheelZoomFactor,
} from "./use-smooth-drawing-view";

afterEach(() => vi.unstubAllGlobals());
const initial = { x: 20, y: 40, width: 1000, height: 800 };
function setup() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const hook = renderHook(() => useSmoothDrawingView(initial));
  const step = (time: number) =>
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    });
  return { ...hook, step, frames };
}
test("continuous wheel input reaches its anchored view on every frame", () => {
  const { result, step, frames } = setup();
  for (let frame = 0; frame < 10; frame++) {
    act(() => result.current.zoom(0.9, { x: 0.25, y: 0.75 }, 10, 20000));
    expect(frames.size).toBe(1);
    step(frame * 16);
    expect(result.current.view.width).toBeCloseTo(1000 * 0.9 ** (frame + 1));
    expect(result.current.view.x + result.current.view.width * 0.25).toBeCloseTo(270);
    expect(result.current.view.y + result.current.view.height * 0.75).toBeCloseTo(640);
    expect(frames.size).toBe(0);
  }
});
test("multiple wheel events coalesce without losing their accumulated scale", () => {
  const { result, step, frames } = setup();
  act(() => {
    result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000);
    result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000);
  });
  expect(frames.size).toBe(1);
  expect(result.current.view).toEqual(initial);
  step(0);
  expect(result.current.view.width).toBe(250);
});
test("new input accumulates, reverses direction, clamps and leaves no queued frame on stop", () => {
  const { result, step, frames, unmount } = setup();
  act(() => result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000));
  step(0);
  step(50);
  act(() => result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000));
  step(60);
  step(200);
  expect(result.current.view.width).toBe(250);
  act(() => result.current.zoom(2, { x: 0.5, y: 0.5 }, 10, 400));
  step(210);
  step(350);
  expect(result.current.view.width).toBe(400);
  act(() => result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000));
  act(() => result.current.setView(initial));
  expect(frames.size).toBe(0);
  step(500);
  expect(result.current.view).toEqual(initial);
  act(() => result.current.zoom(0.5, { x: 0.5, y: 0.5 }, 10, 20000));
  unmount();
  expect(frames.size).toBe(0);
});
test("touchpad deltas remain proportional and line/page wheel modes are normalized", () => {
  expect(wheelZoomFactor(0, 0, 800)).toBe(1);
  expect(wheelZoomFactor(1, 0, 800)).toBeLessThan(1.002);
  expect(wheelZoomFactor(100, 0, 800)).toBeCloseTo(1.15, 2);
  expect(wheelZoomFactor(1, 1, 800)).toBe(wheelZoomFactor(40, 0, 800));
  expect(wheelZoomFactor(1, 2, 800)).toBe(wheelZoomFactor(240, 0, 800));
  expect(wheelZoomFactor(100, 0, 800) * wheelZoomFactor(-100, 0, 800)).toBeCloseTo(1);
});

test("pan coalesces mouse events and flushes the last position before release", () => {
  const { result, frames, step } = setup();
  for (let x = 1; x <= 100; x++) act(() => result.current.pan({ ...initial, x }));
  expect(frames.size).toBe(1);
  expect(result.current.view).toEqual(initial);
  step(16);
  expect(result.current.view.x).toBe(100);
  act(() => result.current.pan({ ...initial, x: 120 }));
  act(() => result.current.flushPan());
  expect(result.current.view.x).toBe(120);
  expect(frames.size).toBe(0);
});

test("a new pan can read the latest camera before its transition is published", () => {
  const { result, frames } = setup();
  act(() => result.current.pan({ ...initial, x: 120 }));
  expect(frames.size).toBe(1);
  expect(result.current.view).toEqual(initial);
  expect(result.current.getView()).toEqual({ ...initial, x: 120 });
});

test("trackpad pan accumulates all samples in screen coordinates without changing scale", () => {
  const { result, frames, step } = setup();
  const inverse = { a: 2, b: 0, c: 0, d: 2 };
  act(() => {
    result.current.panBy(inverse, -10, -20);
    result.current.panBy(inverse, -10, -20);
  });
  expect(frames.size).toBe(1);
  step(16);
  expect(result.current.view).toEqual({ ...initial, x: 60, y: 120 });
});

test("Mac pinch follows flowchart gain instead of the slower mouse-wheel gain", () => {
  expect(wheelZoomFactor(-2.5, 0, 800, true)).toBeCloseTo(1 / 1.025);
  expect(wheelZoomFactor(-2.5, 0, 800, true)).toBeLessThan(wheelZoomFactor(-2.5, 0, 800));
});

test("reset and unmount cancel queued pan updates", () => {
  const { result, frames, step, unmount } = setup();
  act(() => result.current.pan({ ...initial, x: 120 }));
  act(() => result.current.setView(initial));
  step(16);
  expect(result.current.view).toEqual(initial);
  act(() => result.current.pan({ ...initial, x: 140 }));
  unmount();
  expect(frames.size).toBe(0);
});

test("screen pan keeps the committed view aligned with the live scene translation", () => {
  expect(panViewByScreenDelta(initial, { a: 2, b: 0.25, c: -0.5, d: 1.5 }, 40, -20)).toEqual({
    x: -70,
    y: 60,
    width: 1000,
    height: 800,
  });
});

test("nested vector images are translated by their fragment layer only", () => {
  const directImage = { closest: vi.fn(() => null) };
  const nestedImage = { closest: vi.fn(() => ({}) as Element) };

  expect(shouldTranslateLivePanImage(directImage)).toBe(true);
  expect(shouldTranslateLivePanImage(nestedImage)).toBe(false);
  expect(directImage.closest).toHaveBeenCalledWith("[data-base-fragments]");
  expect(nestedImage.closest).toHaveBeenCalledWith("[data-base-fragments]");
});
