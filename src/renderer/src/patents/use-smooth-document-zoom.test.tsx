import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSmoothDocumentZoom } from "./use-smooth-document-zoom";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup(reduced = false) {
  let clock = 0;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const viewport = document.createElement("main");
  viewport.innerHTML =
    '<div class="patent-page-with-rail" style="--patent-page-zoom:1"><div class="patent-page-zoom-frame"></div></div>';
  document.body.append(viewport);
  const layout = viewport.firstElementChild as HTMLElement;
  const page = layout.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 600 });
  viewport.scrollTop = 1000;
  viewport.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect;
  page.getBoundingClientRect = () =>
    ({
      top: 20 - viewport.scrollTop,
      height: 5000 * Number(layout.style.getPropertyValue("--patent-page-zoom")),
      width: 820,
    }) as DOMRect;
  const view = renderHook(({ zoom }) => useSmoothDocumentZoom(viewport, zoom), {
    initialProps: { zoom: 100 },
  });
  return {
    layout,
    viewport,
    view,
    frames,
    tick(ms: number) {
      clock += ms;
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((fn) => {
          fn(clock);
        });
      });
    },
    target(zoom: number) {
      layout.style.setProperty("--patent-page-zoom", String(zoom / 100));
      view.rerender({ zoom });
    },
    zoom: () => Number(layout.style.getPropertyValue("--patent-page-zoom")),
  };
}

test("splitter dragging applies each new scale without a competing zoom animation", () => {
  const s = setup();
  s.viewport.classList.add("dual-document-workspace");
  s.viewport.dataset.splitResizing = "true";
  s.target(90);
  expect(s.zoom()).toBe(0.9);
  expect(s.frames.size).toBe(0);
  s.target(80);
  expect(s.zoom()).toBe(0.8);
  s.viewport.dataset.splitResizing = "false";
  s.target(100);
  expect(s.zoom()).toBe(0.8);
  expect(s.frames.size).toBe(1);
});

test("animates through intermediate scales and preserves the reading position", () => {
  const s = setup();
  s.target(150);
  expect(s.zoom()).toBe(1);
  s.tick(16);
  s.tick(64);
  expect(s.zoom()).toBeGreaterThan(1);
  expect(s.zoom()).toBeLessThan(1.5);
  s.tick(200);
  expect(s.zoom()).toBe(1.5);
  expect(s.viewport.scrollTop).toBeCloseTo(1590);
});

test("retargets from the displayed scale and cancels work on unmount", () => {
  const s = setup();
  s.target(150);
  s.tick(16);
  s.tick(48);
  const intermediate = s.zoom();
  s.target(90);
  expect(s.zoom()).toBe(intermediate);
  s.tick(16);
  s.tick(200);
  expect(s.zoom()).toBe(0.9);
  s.target(120);
  s.view.unmount();
  expect(s.frames.size).toBe(0);
});

test("continuous targets make progress every frame instead of waiting for wheel release", () => {
  const s = setup();
  s.target(105);
  s.tick(16);
  let previous = s.zoom();
  for (const target of [110, 115, 120, 125]) {
    s.target(target);
    s.tick(16);
    expect(s.zoom()).toBeGreaterThan(previous);
    previous = s.zoom();
  }
  s.target(80);
  s.tick(16);
  expect(s.zoom()).toBeLessThan(previous);
  s.tick(200);
  expect(s.zoom()).toBe(0.8);
  expect(s.viewport.scrollTop).toBeCloseTo(764);
  s.view.unmount();
  expect(s.frames.size).toBe(0);
});

test("retargeting to the current paint stops the previous destination", () => {
  const s = setup();
  s.target(150);
  s.tick(16);
  s.tick(32);
  const current = s.zoom();
  s.target(current * 100);
  s.tick(200);
  expect(s.zoom()).toBe(current);
  expect(s.frames.size).toBe(0);
});

test("respects reduced motion while keeping the same reading anchor", () => {
  const s = setup(true);
  s.target(150);
  expect(s.zoom()).toBe(1.5);
  expect(s.frames.size).toBe(0);
  expect(s.viewport.scrollTop).toBeCloseTo(1590);
});

test("does not animate retained hidden books", () => {
  const s = setup();
  s.viewport.style.visibility = "hidden";
  s.target(150);
  expect(s.zoom()).toBe(1.5);
  expect(s.frames.size).toBe(0);
});

test("app reduction skips zoom frames even when the system allows motion", () => {
  document.documentElement.dataset.reducedMotion = "true";
  try {
    const s = setup();
    s.target(150);
    expect(s.zoom()).toBe(1.5);
    expect(s.frames.size).toBe(0);
  } finally {
    delete document.documentElement.dataset.reducedMotion;
  }
});

test("enabling app reduction finishes an ongoing zoom at its committed target", async () => {
  const s = setup();
  s.target(150);
  s.tick(16);
  s.tick(32);
  expect(s.zoom()).toBeLessThan(1.5);
  await act(async () => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  expect(s.zoom()).toBe(1.5);
  expect(s.frames.size).toBe(0);
  delete document.documentElement.dataset.reducedMotion;
});

test("automatic fitting is immediate and retains the document top instead of the middle", () => {
  const s = setup();
  const view = renderHook(({ zoom }) => useSmoothDocumentZoom(s.viewport, zoom, false), {
    initialProps: { zoom: 100 },
  });
  s.layout.style.setProperty("--patent-page-zoom", "0.87");
  view.rerender({ zoom: 87 });
  expect(s.zoom()).toBe(0.87);
  expect(s.frames.size).toBe(0);
  expect(s.viewport.scrollTop).toBeCloseTo(872.6);
  s.viewport.scrollTop = 0;
  s.layout.style.setProperty("--patent-page-zoom", "0.56");
  view.rerender({ zoom: 56 });
  expect(s.viewport.scrollTop).toBe(0);
});

test("zooming from the top keeps the top, including continuous retargeting", () => {
  const s = setup();
  s.viewport.scrollTop = 0;
  s.target(110);
  s.tick(16);
  s.tick(48);
  expect(s.viewport.scrollTop).toBe(0);
  s.target(125);
  s.tick(16);
  s.tick(200);
  expect(s.viewport.scrollTop).toBe(0);
});

test("applies direct resize zoom frames immediately and adopts the final committed scale", () => {
  const s = setup();

  act(() => {
    s.layout.dispatchEvent(
      new CustomEvent("patent-document-zoom-direct", { detail: { scale: 0.75 } }),
    );
  });

  expect(s.zoom()).toBe(0.75);
  expect(s.viewport.scrollTop).toBeCloseTo(755);
  expect(s.frames.size).toBe(0);

  s.target(75);
  expect(s.zoom()).toBe(0.75);
  expect(s.viewport.scrollTop).toBeCloseTo(755);
  expect(s.frames.size).toBe(0);
});
