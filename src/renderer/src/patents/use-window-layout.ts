import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PAGE_SETTINGS } from "../../../shared/document/defaults";
import type { PatentApi, WindowLayoutState } from "../../../shared/ipc/contract";
import {
  DUAL_PANE_DIVIDER_WIDTH,
  DUAL_PANE_MINIMUM_SCALE,
  DUAL_PANE_PADDING,
  DUAL_PANE_SCROLLBAR,
  fitDualPanePage,
} from "./dual-pane-layout-budget";
import type { FunctionRailSpace } from "./function-rail/function-rail-state";

type WindowApplicationApi = Pick<
  PatentApi["application"],
  "getWindowLayoutState" | "maximizeWindow" | "onWindowLayoutStateChanged"
>;

export type DualPaneFit = Readonly<{
  allowed: boolean;
  reason: string | null;
  paneWidth: number;
  initialRailSpace: FunctionRailSpace;
  pageAvailableWidth: number;
  fitScale: number;
  fitZoomPercent: number;
}>;

export type DualViewRequestResult =
  | Readonly<{
      ok: true;
      layout: WindowLayoutState;
      fit: DualPaneFit;
    }>
  | Readonly<{
      ok: false;
      reason: string;
      layout: WindowLayoutState | null;
      fit: DualPaneFit | null;
    }>;

const PAGE_WIDTH = (DEFAULT_PAGE_SETTINGS.widthMm * 96) / 25.4;
const DIVIDER_WIDTH = DUAL_PANE_DIVIDER_WIDTH;
// Match patent-editor-workspace and its stable Windows Chromium scrollbar gutter.
const PANE_HORIZONTAL_PADDING = DUAL_PANE_PADDING;
const PANE_SCROLLBAR_WIDTH = DUAL_PANE_SCROLLBAR;
const MINIMUM_FIT_SCALE = DUAL_PANE_MINIMUM_SCALE;
const MAXIMIZE_CONFIRMATION_TIMEOUT_MS = 1_000;

type LayoutWaiter = {
  resolve(layout: WindowLayoutState | null): void;
  timer: ReturnType<typeof setTimeout>;
};

export function calculateDualPaneFit(layout: WindowLayoutState): DualPaneFit {
  const paneWidth = Math.max(0, Math.floor((layout.contentWidth - DIVIDER_WIDTH) / 2));
  const paneHorizontalChrome = PANE_HORIZONTAL_PADDING * 2 + PANE_SCROLLBAR_WIDTH;
  const { initialRailSpace, pageAvailableWidth, fitScale, fitZoomPercent } = fitDualPanePage(
    paneWidth,
    PAGE_WIDTH,
    paneHorizontalChrome,
    undefined,
    layout.displayWidthMm,
  );
  const readable = fitScale >= MINIMUM_FIT_SCALE;
  const reason = !layout.isMaximized
    ? "请先最大化窗口。"
    : readable
      ? null
      : "当前显示设置下可用宽度不足。";

  return {
    allowed: layout.isMaximized && readable,
    reason,
    paneWidth,
    initialRailSpace,
    pageAvailableWidth,
    fitScale,
    fitZoomPercent,
  };
}

function windowApplicationApi(): WindowApplicationApi {
  return window.patentApi.application;
}

export function useWindowLayout(
  applicationApi: WindowApplicationApi = windowApplicationApi(),
): Readonly<{
  layout: WindowLayoutState | null;
  fit: DualPaneFit | null;
  error: string | null;
  requestDualView(): Promise<DualViewRequestResult>;
}> {
  const [layout, setLayout] = useState<WindowLayoutState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const layoutRef = useRef<WindowLayoutState | null>(null);
  const layoutVersionRef = useRef(0);
  const maximizeWaitersRef = useRef(new Set<LayoutWaiter>());

  const adoptLayout = useCallback((nextLayout: WindowLayoutState) => {
    layoutRef.current = nextLayout;
    layoutVersionRef.current += 1;
    setLayout(nextLayout);
    setError(null);
    if (!nextLayout.isMaximized) return;
    for (const waiter of maximizeWaitersRef.current) {
      clearTimeout(waiter.timer);
      maximizeWaitersRef.current.delete(waiter);
      waiter.resolve(nextLayout);
    }
  }, []);

  const waitForMaximizedLayout = useCallback((): Promise<WindowLayoutState | null> => {
    if (layoutRef.current?.isMaximized) return Promise.resolve(layoutRef.current);
    return new Promise((resolve) => {
      const waiter: LayoutWaiter = {
        resolve,
        timer: setTimeout(() => {
          maximizeWaitersRef.current.delete(waiter);
          resolve(null);
        }, MAXIMIZE_CONFIRMATION_TIMEOUT_MS),
      };
      maximizeWaitersRef.current.add(waiter);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const initialVersion = layoutVersionRef.current;
    const unsubscribe = applicationApi.onWindowLayoutStateChanged((nextLayout) => {
      if (!active) return;
      adoptLayout(nextLayout);
    });

    void applicationApi
      .getWindowLayoutState()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          if (layoutVersionRef.current === initialVersion) adoptLayout(result.value);
        } else {
          setError("无法读取窗口状态，请重试。");
        }
      })
      .catch(() => {
        if (active) setError("无法读取窗口状态，请重试。");
      });

    return () => {
      active = false;
      unsubscribe();
      for (const waiter of maximizeWaitersRef.current) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      maximizeWaitersRef.current.clear();
    };
  }, [adoptLayout, applicationApi]);

  const requestDualView = useCallback(async (): Promise<DualViewRequestResult> => {
    try {
      const maximizeResult = await applicationApi.maximizeWindow();
      if (!maximizeResult.ok) {
        const currentLayout = layoutRef.current;
        return {
          ok: false,
          reason: "无法最大化窗口，请重试。",
          layout: currentLayout,
          fit: currentLayout ? calculateDualPaneFit(currentLayout) : null,
        };
      }

      const confirmedLayout = maximizeResult.value.isMaximized
        ? maximizeResult.value
        : ((await waitForMaximizedLayout()) ?? maximizeResult.value);
      const settledResult = await applicationApi.getWindowLayoutState();
      const rereadLayout = settledResult.ok ? settledResult.value : confirmedLayout;
      const settledLayout =
        rereadLayout.isMaximized || !layoutRef.current?.isMaximized
          ? rereadLayout
          : layoutRef.current;
      const settledFit = calculateDualPaneFit(settledLayout);
      adoptLayout(settledLayout);

      if (!settledFit.allowed) {
        return {
          ok: false,
          reason: settledFit.reason ?? "当前显示设置下无法使用同屏双显。",
          layout: settledLayout,
          fit: settledFit,
        };
      }

      return { ok: true, layout: settledLayout, fit: settledFit };
    } catch {
      const currentLayout = layoutRef.current;
      return {
        ok: false,
        reason: "无法读取窗口状态，请重试。",
        layout: currentLayout,
        fit: currentLayout ? calculateDualPaneFit(currentLayout) : null,
      };
    }
  }, [adoptLayout, applicationApi, waitForMaximizedLayout]);

  return {
    layout,
    fit: layout ? calculateDualPaneFit(layout) : null,
    error,
    requestDualView,
  };
}
