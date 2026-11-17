import { act, renderHook, waitFor } from "@testing-library/react";
import type { PatentApi, WindowLayoutState } from "../../../shared/ipc/contract";
import { calculateDualPaneFit, useWindowLayout } from "./use-window-layout";

type WindowApplicationApi = Pick<
  PatentApi["application"],
  "getWindowLayoutState" | "maximizeWindow" | "onWindowLayoutStateChanged"
>;

function layout(contentWidth: number, isMaximized = true): WindowLayoutState {
  return { isMaximized, contentWidth, contentHeight: 900 };
}

function success(value: WindowLayoutState) {
  return { ok: true as const, value };
}

describe("dual pane fit", () => {
  test("keeps natural page size while compact controls approach the docked threshold", () => {
    expect(calculateDualPaneFit(layout(1920))).toMatchObject({
      allowed: true,
      initialRailSpace: "constrained",
      fitZoomPercent: 100,
      reason: null,
    });
  });

  test("uses the largest non-clipping zoom on a wide display", () => {
    expect(calculateDualPaneFit(layout(2560))).toMatchObject({
      allowed: true,
      initialRailSpace: "fits",
      fitZoomPercent: 106,
    });
  });

  test("allows 1366px with a constrained function rail", () => {
    expect(calculateDualPaneFit(layout(1366))).toMatchObject({
      allowed: true,
      initialRailSpace: "constrained",
      fitZoomPercent: 70,
    });
  });

  test("adapts a 1280px logical display without crossing the readability floor", () => {
    expect(calculateDualPaneFit(layout(1280))).toMatchObject({
      allowed: true,
      initialRailSpace: "constrained",
      fitZoomPercent: 65,
    });
  });

  test("accepts the exact 52 percent logical-width boundary", () => {
    expect(calculateDualPaneFit(layout(1071))).toMatchObject({
      allowed: true,
      initialRailSpace: "constrained",
      fitScale: expect.closeTo(0.52, 3),
      fitZoomPercent: 52,
      reason: null,
    });
  });

  test("rejects 1000px even with a constrained function rail", () => {
    expect(calculateDualPaneFit(layout(1000))).toMatchObject({
      allowed: false,
      initialRailSpace: "constrained",
      fitZoomPercent: 47,
      reason: "当前显示设置下可用宽度不足。",
    });
  });

  test("rejects a readable layout when the native window is not maximized", () => {
    expect(calculateDualPaneFit(layout(1920, false))).toMatchObject({
      allowed: false,
      reason: "请先最大化窗口。",
    });
  });

  test("fits each pane within its control recovery budget and natural-size transition cap", () => {
    const pageWidth = (210 * 96) / 25.4;
    for (let width = 1170; width <= 3840; width += 7) {
      const fit = calculateDualPaneFit(layout(width));
      const rail = fit.initialRailSpace === "fits" ? 292 : 48;
      const recovery = fit.initialRailSpace === "fits" ? 13 : 0;
      const available =
        Math.floor((width - 15) / 2) -
        24 -
        15 -
        (fit.initialRailSpace === "fits" ? 84 : 28) -
        rail -
        recovery;
      expect((fit.fitZoomPercent / 100) * pageWidth).toBeLessThanOrEqual(available);
      const maximum = fit.initialRailSpace === "constrained" ? 100 : 200;
      expect(fit.fitZoomPercent).toBeLessThanOrEqual(maximum);
      if (fit.fitZoomPercent < maximum) {
        expect(((fit.fitZoomPercent + 1) / 100) * pageWidth).toBeGreaterThan(available);
      }
    }
  });
});

describe("use window layout", () => {
  test("reads the initial native state, receives changes, and unsubscribes on unmount", async () => {
    let listener: ((state: WindowLayoutState) => void) | undefined;
    const unsubscribe = vi.fn();
    const api: WindowApplicationApi = {
      getWindowLayoutState: vi.fn(async () => success(layout(1440, false))),
      maximizeWindow: vi.fn(async () => success(layout(1440))),
      onWindowLayoutStateChanged: vi.fn((nextListener) => {
        listener = nextListener;
        return unsubscribe;
      }),
    };

    const { result, unmount } = renderHook(() => useWindowLayout(api));

    await waitFor(() => expect(result.current.layout).toEqual(layout(1440, false)));
    act(() => listener?.(layout(1920)));
    expect(result.current.layout).toEqual(layout(1920));
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("does not let a late initial read overwrite a newer native layout event", async () => {
    let listener: ((state: WindowLayoutState) => void) | undefined;
    let resolveInitial: ((value: ReturnType<typeof success>) => void) | undefined;
    const initialRead = new Promise<ReturnType<typeof success>>((resolve) => {
      resolveInitial = resolve;
    });
    const api: WindowApplicationApi = {
      getWindowLayoutState: vi.fn(() => initialRead),
      maximizeWindow: vi.fn(async () => success(layout(1920))),
      onWindowLayoutStateChanged: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    };

    const { result } = renderHook(() => useWindowLayout(api));
    act(() => listener?.(layout(1920)));
    await act(async () => {
      resolveInitial?.(success(layout(1440, false)));
      await initialRead;
    });

    expect(result.current.layout).toEqual(layout(1920));
  });

  test("maximizes, rereads the settled size, and returns an allowed fit", async () => {
    const api: WindowApplicationApi = {
      getWindowLayoutState: vi
        .fn()
        .mockResolvedValueOnce(success(layout(1440, false)))
        .mockResolvedValue(success(layout(1920))),
      maximizeWindow: vi.fn(async () => success(layout(1920))),
      onWindowLayoutStateChanged: vi.fn(() => vi.fn()),
    };
    const { result } = renderHook(() => useWindowLayout(api));
    await waitFor(() => expect(result.current.layout).toEqual(layout(1440, false)));

    let requestResult: Awaited<ReturnType<typeof result.current.requestDualView>> | undefined;
    await act(async () => {
      requestResult = await result.current.requestDualView();
    });

    expect(api.maximizeWindow).toHaveBeenCalledOnce();
    expect(api.getWindowLayoutState).toHaveBeenCalledTimes(2);
    expect(requestResult).toMatchObject({
      ok: true,
      layout: layout(1920),
      fit: { allowed: true, initialRailSpace: "constrained" },
    });
  });

  test("keeps dual view unavailable when the settled maximized width is insufficient", async () => {
    const api: WindowApplicationApi = {
      getWindowLayoutState: vi.fn(async () => success(layout(1000))),
      maximizeWindow: vi.fn(async () => success(layout(1000))),
      onWindowLayoutStateChanged: vi.fn(() => vi.fn()),
    };
    const { result } = renderHook(() => useWindowLayout(api));
    await waitFor(() => expect(result.current.layout).toEqual(layout(1000)));

    let requestResult: Awaited<ReturnType<typeof result.current.requestDualView>> | undefined;
    await act(async () => {
      requestResult = await result.current.requestDualView();
    });

    expect(requestResult).toEqual({
      ok: false,
      reason: "当前显示设置下可用宽度不足。",
      layout: layout(1000),
      fit: calculateDualPaneFit(layout(1000)),
    });
  });

  test("waits for an asynchronous native maximize event before judging readability", async () => {
    let listener: ((state: WindowLayoutState) => void) | undefined;
    const api: WindowApplicationApi = {
      getWindowLayoutState: vi.fn(async () => success(layout(1440, false))),
      maximizeWindow: vi.fn(async () => success(layout(1440, false))),
      onWindowLayoutStateChanged: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    };
    const { result } = renderHook(() => useWindowLayout(api));
    await waitFor(() => expect(result.current.layout).toEqual(layout(1440, false)));

    let requestPromise: ReturnType<typeof result.current.requestDualView> | undefined;
    act(() => {
      requestPromise = result.current.requestDualView();
    });
    await waitFor(() => expect(api.maximizeWindow).toHaveBeenCalledOnce());
    act(() => listener?.(layout(1920)));

    await expect(requestPromise).resolves.toMatchObject({
      ok: true,
      layout: layout(1920),
      fit: { allowed: true },
    });
  });
});
