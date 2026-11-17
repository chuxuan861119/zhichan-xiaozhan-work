// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fitPatentOpenZoom, useFitPatentOnOpen } from "./use-fit-patent-on-open";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("computes the width limit independently of the display preference", () => {
  const zoom = fitPatentOpenZoom(1400, 794, 84, true);
  expect(zoom).toBe(166);
  expect((794 * zoom) / 100 + 28 + 48).toBeLessThanOrEqual(1400 - 1);
  expect(fitPatentOpenZoom(1000, 794, 84, true)).toBe(116);
  expect(fitPatentOpenZoom(1400, 794, 0, false)).toBe(176);
  expect(fitPatentOpenZoom(4000, 794, 84, true)).toBe(200);
});

test("fits on opening or reopening, not when changing mode or manually zooming", () => {
  const host = document.createElement("main");
  host.className = "patent-editor-workspace";
  host.innerHTML =
    '<div class="patent-page-with-rail" style="grid-template-columns:84px 794px 292px"><div class="patent-page-zoom-frame"></div><div class="patent-global-function-rail-slot"></div></div>';
  document.body.append(host);
  const layout = host.firstElementChild as HTMLElement;
  let availableWidth = 1450;
  Object.defineProperty(layout, "clientWidth", { get: () => availableWidth });
  layout.getBoundingClientRect = () => ({ width: 1400 }) as DOMRect;
  Object.defineProperty(layout.firstElementChild, "offsetWidth", { value: 794 });
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const fit = vi.fn();
  const { rerender } = renderHook(({ key, enabled }) => useFitPatentOnOpen(key, enabled, fit), {
    initialProps: { key: "patent-a" as string | null, enabled: true },
  });
  act(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
  expect(fit).not.toHaveBeenCalled();
  availableWidth = 1400;
  act(() => {
    for (const cb of frames.splice(0)) cb(16);
  });
  expect(fit).not.toHaveBeenCalled();
  act(() => {
    for (const cb of frames.splice(0)) cb(32);
  });
  expect(fit).toHaveBeenLastCalledWith(166);
  rerender({ key: "patent-a", enabled: false });
  rerender({ key: "patent-a", enabled: true });
  act(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
  expect(fit).toHaveBeenCalledTimes(1);
  rerender({ key: null, enabled: true });
  // A collapsed rail is portaled to the window edge; its anchor stays beside the page.
  layout.lastElementChild?.replaceWith(
    Object.assign(document.createElement("span"), {
      className: "patent-function-rail-measurement-anchor",
    }),
  );
  rerender({ key: "patent-a", enabled: true });
  act(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
  act(() => {
    for (const cb of frames.splice(0)) cb(16);
  });
  expect(fit).toHaveBeenCalledTimes(2);
  expect(fit).toHaveBeenLastCalledWith(166);
});

test("provides a viewport cap without limiting a remembered zoom to 100 percent", () => {
  expect(fitPatentOpenZoom(1400, 794, 84, true)).toBe(166);
  expect(fitPatentOpenZoom(1000, 794, 84, true)).toBe(116);
  expect(Math.min(90, fitPatentOpenZoom(1400, 794, 84, true))).toBe(90);
});

test("wide and compact ruler states have the same viewport cap without an expanded rail reservation", () => {
  expect(fitPatentOpenZoom(900, 794, 84, true)).toBe(fitPatentOpenZoom(900, 794, 28, true));
  expect(Math.min(100, fitPatentOpenZoom(900, 794, 84, true))).toBe(100);
  expect(fitPatentOpenZoom(800, 794, 84, true)).toBe(91);
});
