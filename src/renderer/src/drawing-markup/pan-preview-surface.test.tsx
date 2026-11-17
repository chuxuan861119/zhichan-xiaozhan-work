import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { DrawingView } from "./fixed-line-preview";
import {
  type PanPreviewFrame,
  PanPreviewSurface,
  type PanPreviewSurfaceHandle,
} from "./pan-preview-surface";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const view: DrawingView = { x: 0, y: 0, width: 1000, height: 800 };
function open(imageCoverage = false, composited = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const ref = createRef<PanPreviewSurfaceHandle>();
  const paint = vi.fn((next: PanPreviewFrame) => (
    <>
      <span>{JSON.stringify(next.camera)}</span>
      {imageCoverage && (
        <div className="drawing-vector-preview" data-render-state="ready">
          <img alt="" />
        </div>
      )}
    </>
  ));
  const result = render(
    <PanPreviewSurface ref={ref} view={view} imageCoverage={imageCoverage} composited={composited}>
      {paint}
    </PanPreviewSurface>,
  );
  paint.mockClear();
  const host = result.container.querySelector("[data-pan-preview-surface]") as HTMLElement;
  return {
    ...result,
    ref,
    paint,
    host,
    frames,
    flush() {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      });
    },
  };
}

test("coalesces boundary crossings into one source-only coverage refresh", () => {
  const { ref, host, paint, frames, flush } = open();
  for (let x = 1; x <= 180; x++) ref.current?.move({ ...view, x: -x }, x, 0);
  expect(host.style.transform).toBe("translate3d(180px, 0px, 0)");
  expect(paint).toHaveBeenCalledTimes(0);
  expect(frames.size).toBe(1);
  flush();
  expect(paint).toHaveBeenCalledTimes(1);
  expect(paint.mock.lastCall?.[0].camera).toEqual({ ...view, x: -180 });
  expect(host.style.transform).toBe("translate3d(0px, 0px, 0)");
  ref.current?.move({ ...view, x: -380, y: -20 }, 380, 20);
  expect(host.style.transform).toBe("translate3d(200px, 20px, 0)");
  flush();
  expect(paint.mock.lastCall?.[0].camera).toEqual({ ...view, x: -380, y: -20 });
  expect(host.style.transform).toBe("translate3d(0px, 0px, 0)");
});

test.each([false, true])(
  "finish discards pending refreshes after a painted frame: %s",
  (painted) => {
    const { ref, host, paint, flush, frames } = open();
    ref.current?.move({ ...view, x: -180 }, 180, 0);
    if (painted) flush();
    ref.current?.move({ ...view, x: -400 }, 400, 0);
    const obsolete = [...frames.values()];
    act(() => ref.current?.finish());
    expect(host.style.transform).toBe("");
    expect(host.textContent).toBe(JSON.stringify(view));
    expect(frames.size).toBe(0);
    const count = paint.mock.calls.length;
    act(() => {
      for (const callback of obsolete) callback(0);
    });
    expect(paint).toHaveBeenCalledTimes(count);
  },
);

test("unmount cancels queued source work", () => {
  const { ref, unmount, frames } = open();
  ref.current?.move({ ...view, x: -180 }, 180, 0);
  unmount();
  expect(frames.size).toBe(0);
});

test("small forward and reverse pans reuse prepared coverage without repainting", () => {
  const { ref, paint, flush } = open();
  for (const x of [10, 40, 64, 20, -40, -64, 0]) {
    ref.current?.move({ ...view, x: -x }, x, 0);
    flush();
  }
  expect(paint).toHaveBeenCalledTimes(0);
});

test("CAD pan reuses the painted image while it still covers the viewport", () => {
  const { ref, host, paint, frames } = open(true);
  expect(host.style.willChange).toBe("transform");
  const viewport = host.parentElement;
  const image = host.querySelector(".drawing-vector-preview img");
  if (!viewport || !image) throw Error("CAD preview image is unavailable");
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(-400, -400, 1800, 1600));
  ref.current?.begin();
  ref.current?.move({ ...view, x: 300 }, -300, 0);
  expect(host.style.transform).toBe("translate3d(-300px, 0px, 0)");
  expect(paint).toHaveBeenCalledTimes(0);
  expect(frames.size).toBe(0);
  ref.current?.move({ ...view, x: 350 }, -350, 0);
  expect(frames.size).toBe(1);
});

test("edited CAD keeps its preview on a compositor layer without assuming image coverage", () => {
  const { host } = open(false, true);
  expect(host.style.willChange).toBe("transform");
});

test("CAD pan waits for an in-flight replacement instead of decoding every move", () => {
  const { ref, host, frames, flush } = open(true);
  ref.current?.move({ ...view, x: 200 }, -200, 0);
  flush();
  host.querySelector(".drawing-vector-preview")?.setAttribute("data-render-state", "pending");
  ref.current?.move({ ...view, x: 400 }, -400, 0);
  expect(frames.size).toBe(0);
});

test("pan release keeps the live translation until the committed camera arrives", () => {
  const { ref, host, rerender, paint } = open();
  const next = { ...view, x: -80 };
  ref.current?.move(next, 80, 0);
  act(() => ref.current?.settle(next));
  expect(host.style.transform).toBe("translate3d(80px, 0px, 0)");
  rerender(
    <PanPreviewSurface ref={ref} view={{ ...view }}>
      {paint}
    </PanPreviewSurface>,
  );
  expect(host.style.transform).toBe("translate3d(80px, 0px, 0)");
  rerender(
    <PanPreviewSurface ref={ref} view={next}>
      {paint}
    </PanPreviewSurface>,
  );
  expect(host.style.transform).toBe("");
  expect(host.textContent).toBe(JSON.stringify(next));
});

test("a second pan starts from an unsettled first pan without jumping", () => {
  const { ref, host, rerender, paint } = open();
  const first = { ...view, x: 100 };
  ref.current?.begin();
  ref.current?.move(first, -100, 0);
  act(() => ref.current?.settle(first));
  ref.current?.begin();
  ref.current?.move(view, 100, 0);
  expect(host.style.transform).toBe("translate3d(0px, 0px, 0)");
  rerender(
    <PanPreviewSurface ref={ref} view={first}>
      {paint}
    </PanPreviewSurface>,
  );
  expect(host.style.transform).toBe("translate3d(100px, 0px, 0)");
  act(() => ref.current?.settle(view));
  rerender(
    <PanPreviewSurface ref={ref} view={view}>
      {paint}
    </PanPreviewSurface>,
  );
  expect(host.style.transform).toBe("");
});

test("zoom committed immediately after pan release clears the obsolete translation", () => {
  const { ref, host, rerender, paint } = open();
  const next = { ...view, x: -80 };
  ref.current?.begin();
  ref.current?.move(next, 80, 0);
  act(() => ref.current?.settle(next));
  const zoomed = { ...next, x: 170, y: 200, width: 500, height: 400 };
  rerender(
    <PanPreviewSurface ref={ref} view={zoomed}>
      {paint}
    </PanPreviewSurface>,
  );
  expect(host.style.transform).toBe("");
  expect(host.textContent).toBe(JSON.stringify(zoomed));
});

test("buffered coverage keeps the same scale and center for a mismatched viewport aspect", () => {
  const { paint, rerender, ref } = open();
  const camera = { x: 40, y: 70, width: 600, height: 600 };
  rerender(
    <PanPreviewSurface ref={ref} view={camera}>
      {paint}
    </PanPreviewSurface>,
  );
  const frame = paint.mock.lastCall![0];
  const scale = Math.min(1000 / camera.width, 800 / camera.height);
  expect(Math.min(1384 / frame.view.width, 1184 / frame.view.height)).toBeCloseTo(scale);
  expect(frame.view.x + frame.view.width / 2).toBeCloseTo(camera.x + camera.width / 2);
  expect(frame.view.y + frame.view.height / 2).toBeCloseTo(camera.y + camera.height / 2);
});
