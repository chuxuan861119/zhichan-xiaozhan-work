import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRangePreview } from "./use-range-preview";

it("coalesces pointer updates without rerendering the workspace for unchanged hits and cancels pending frames", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  let renders = 0;
  const { result, unmount } = renderHook(() => {
    renders++;
    return useRangePreview();
  });
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  result.current.ref.current = polygon;
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() =>
      pending.forEach((cb) => {
        cb(0);
      }),
    );
  };
  const hitTest = vi.fn(() => [] as string[]);
  act(() => {
    result.current.update([{ x: 1, y: 2 }], false, []);
    result.current.update([{ x: 3, y: 4 }], true, hitTest);
  });
  expect(frames.size).toBe(1);
  expect(hitTest).not.toHaveBeenCalled();
  flush();
  expect(polygon.getAttribute("points")).toBe("3,4");
  expect(hitTest).toHaveBeenCalledTimes(1);
  const before = renders;
  act(() => result.current.update([{ x: 5, y: 6 }], true, []));
  flush();
  expect(renders).toBe(before);
  act(() => result.current.update([{ x: 7, y: 8 }], true, ["a"]));
  flush();
  expect(result.current.ids).toEqual(["a"]);
  act(() => {
    result.current.update([{ x: 9, y: 10 }], false, []);
    result.current.clear();
  });
  expect(frames.size).toBe(0);
  expect(polygon.getAttribute("points")).toBe("");
  unmount();
  vi.unstubAllGlobals();
});
