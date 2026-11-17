import { act, renderHook } from "@testing-library/react";
import { DUAL_DOCUMENT_RESIZE_SETTLED_EVENT } from "./dual-document-resize";
import { DUAL_PANE_COLLAPSED_RAIL, DUAL_PANE_COMPACT_RULER } from "./dual-pane-layout-budget";
import { dualPaneZoomLimit, useDualPaneZoomLimit } from "./dual-pane-zoom-limit";

let resize = () => {};
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function fixture(width = 950, scale = 0.6) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const workspace = document.createElement("section");
  workspace.className = "dual-document-workspace";
  const viewport = document.createElement("main");
  viewport.style.padding = "0 12px";
  const size = { width };
  Object.defineProperty(viewport, "clientWidth", { get: () => size.width });
  viewport.innerHTML = `<div class="patent-page-with-rail" data-structure-ruler="true" style="--patent-page-zoom:${scale}"><div class="patent-page-zoom-frame"></div><aside class="patent-global-function-rail-slot" data-layout="overlay"></aside></div>`;
  const layout = viewport.firstElementChild as HTMLElement;
  const page = layout.firstElementChild as HTMLElement;
  Object.defineProperty(page, "offsetWidth", { value: 794 });
  viewport.getBoundingClientRect = () => ({ width: size.width }) as DOMRect;
  workspace.append(viewport);
  document.body.append(workspace);
  const direct = vi.fn();
  layout.addEventListener("patent-document-zoom-direct", (event) =>
    direct((event as CustomEvent).detail.scale),
  );
  return { workspace, viewport, size, layout, direct };
}

test.each([400, 640, 960, 1400, 2400])("maximum zoom fills only its %i pixel pane", (width) => {
  const max = dualPaneZoomLimit(width, 820);
  const controls = DUAL_PANE_COMPACT_RULER + DUAL_PANE_COLLAPSED_RAIL;
  expect(max).toBeLessThanOrEqual(200);
  expect((820 * max) / 100 + controls).toBeLessThanOrEqual(width);
  if (max < 200) expect((820 * (max + 1)) / 100 + controls).toBeGreaterThan(width);
});

test("reports a pane cap on resize and immediately clamps a painted page that no longer fits", () => {
  const s = fixture(950, 1);
  const report = vi.fn();
  const hook = renderHook(() => useDualPaneZoomLimit(s.viewport, 100, report, "claims"));
  expect(report).toHaveBeenLastCalledWith(dualPaneZoomLimit(926, 794));
  s.size.width = 700;
  act(() => resize());
  const max = dualPaneZoomLimit(676, 794);
  expect(report).toHaveBeenLastCalledWith(max);
  expect(s.direct).toHaveBeenLastCalledWith(max / 100);
  hook.unmount();
});

test("a synchronous zoom-frame notification does not reenter the resize measurement", () => {
  const s = fixture(950, 1);
  s.layout.addEventListener("patent-document-zoom-direct", (event) => {
    s.layout.style.setProperty("--patent-page-zoom", String((event as CustomEvent).detail.scale));
    s.layout.dispatchEvent(new Event("patent-document-zoom-frame"));
  });
  const report = vi.fn();
  const hook = renderHook(() => useDualPaneZoomLimit(s.viewport, 100, report, "claims"));
  report.mockClear();
  s.size.width = 700;
  act(() => resize());
  expect(report).toHaveBeenCalledTimes(1);
  hook.unmount();
});

test("dragging the splitter preserves manual paint below the cap and reports the new limit", () => {
  const s = fixture();
  const report = vi.fn();
  const hook = renderHook(() => useDualPaneZoomLimit(s.viewport, 60, report, "claims"));
  s.workspace.dataset.splitResizing = "true";
  s.size.width = 1100;
  act(() => resize());
  expect(s.direct).not.toHaveBeenCalled();
  expect(report).toHaveBeenLastCalledWith(dualPaneZoomLimit(1076, 794));
  s.workspace.dataset.splitResizing = "false";
  act(() => s.workspace.dispatchEvent(new Event(DUAL_DOCUMENT_RESIZE_SETTLED_EVENT)));
  expect(s.direct).not.toHaveBeenCalled();
  hook.unmount();
});

test("automatic fitting uses stable initial controls instead of chasing rail animations", async () => {
  const s = fixture(851, 0.54);
  const fit = vi.fn();
  const hook = renderHook(() => useDualPaneZoomLimit(s.viewport, 54, () => {}, "claims", fit, 345));
  expect(fit).toHaveBeenLastCalledWith(dualPaneZoomLimit(827, 794));
  const before = fit.mock.calls.length;
  s.layout.style.setProperty("--patent-function-rail-reserved-width", "292px");
  (s.layout.lastElementChild as HTMLElement).dataset.layout = "docked";
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(fit).toHaveBeenCalledTimes(before);
  s.workspace.dataset.splitResizing = "true";
  s.size.width = 1100;
  act(() => resize());
  expect(fit).toHaveBeenLastCalledWith(dualPaneZoomLimit(1076, 794));
  hook.unmount();
});

test.each([345, 600, null])(
  "ruler opens when the scaled page leaves room even on display %s",
  (mm) => {
    const s = fixture(851, 0.5);
    const hook = renderHook(
      ({ zoom }) => useDualPaneZoomLimit(s.viewport, zoom, () => {}, "claims", undefined, mm),
      { initialProps: { zoom: 50 } },
    );
    expect(s.layout.dataset.paneRulerCompact).toBe("false");
    s.layout.style.setProperty("--patent-page-zoom", "0.94");
    hook.rerender({ zoom: 94 });
    expect(s.layout.dataset.paneRulerCompact).toBe("true");
    hook.unmount();
  },
);
