import { Maximize2, Minimize2, PanelLeft, PanelTop } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TabletWindowState } from "../../../shared/ipc/contract";
import { isHarmonyPlatform } from "../../../shared/platform";
import { showAppAlert } from "./app-dialog";
import { blurTabletInputForNavigation, installTabletTouchInput } from "./tablet-input";
import "./tablet-controls.css";
import "../library/tablet-library.css";
import "../editor/ui/tablet-editor.css";
import "./tablet-tabs.css";
import "./tablet-surfaces.css";
import "../patents/function-rail/tablet-function-rail.css";
import "./tablet-portrait.css";

const sameState = (a: TabletWindowState | null, b: TabletWindowState) =>
  a?.available === b.available &&
  a.focusMode === b.focusMode &&
  a.windowed === b.windowed &&
  a.contentHeightPx === b.contentHeightPx &&
  a.portrait === b.portrait &&
  a.topInsetPx === b.topInsetPx &&
  a.bottomInsetPx === b.bottomInsetPx;

export function TabletControls({
  editorMode,
  toolbarAvailable = true,
}: {
  editorMode: boolean;
  toolbarAvailable?: boolean;
}) {
  const [state, setState] = useState<TabletWindowState | null>(null);
  const [busy, setBusy] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth < 1100);
  const [navOverride, setNavOverride] = useState<boolean | null>(null);
  const [toolsOverride, setToolsOverride] = useState(false);
  const alive = useRef(true);
  const requestVersion = useRef(0);
  const pending = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const publish = useCallback((next: TabletWindowState) => {
    if (alive.current) setState((previous) => (sameState(previous, next) ? previous : next));
  }, []);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const version = ++requestVersion.current;
    try {
      const result = await window.patentApi.application.readTabletWindow?.();
      if (result?.ok && version === requestVersion.current) publish(result.value);
    } catch {
      /* Keep the last confirmed layout when the native window is unavailable. */
    }
  }, [publish]);
  const changeFocus = useCallback(
    async (enabled: boolean) => {
      if (pending.current) return;
      pending.current = true;
      blurTabletInputForNavigation();
      requestVersion.current += 1;
      setBusy(true);
      try {
        const result = await window.patentApi.application.setTabletFocusMode?.(enabled);
        if (!result?.ok || !result.value.available) throw new Error("unavailable");
        if (!alive.current && enabled && result.value.focusMode) {
          await window.patentApi.application.setTabletFocusMode?.(false);
        } else {
          publish(result.value);
        }
      } catch {
        if (alive.current) showAppAlert("无法切换专注模式，请在平板全屏窗口中重试。");
      } finally {
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [publish],
  );

  useEffect(() => {
    alive.current = true;
    if (!isHarmonyPlatform() || !window.patentApi.application.readTabletWindow) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      setCompact(window.innerWidth < 1100);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 120);
    };
    const inputChanged = () => {
      schedule();
      // Native IME avoid areas settle after the focus event. One trailing read,
      // rather than polling, covers that transition even without a DOM resize.
      if (inputTimer !== undefined) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => void refresh(), 600);
    };
    void refresh();
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.addEventListener("focusin", inputChanged);
    window.addEventListener("focusout", inputChanged);
    return () => {
      alive.current = false;
      requestVersion.current += 1;
      if (timer !== undefined) clearTimeout(timer);
      if (inputTimer !== undefined) clearTimeout(inputTimer);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener("focusin", inputChanged);
      window.removeEventListener("focusout", inputChanged);
      if (latest.current?.focusMode)
        void window.patentApi.application.setTabletFocusMode?.(false).catch(() => undefined);
    };
  }, [refresh]);

  useEffect(() => installTabletTouchInput(), []);

  const focused = Boolean(state?.focusMode);
  const toolsCollapsed = focused || toolsOverride;
  useEffect(() => {
    if ((!editorMode || state?.windowed) && state?.focusMode) void changeFocus(false);
  }, [editorMode, state?.windowed, state?.focusMode, changeFocus]);
  useEffect(() => {
    if (!state?.available || !focused) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      void changeFocus(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [focused, state?.available, changeFocus]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: view changes mount new menu/toolbar siblings that must inherit inert state.
  useLayoutEffect(() => {
    if (!state?.available) return;
    const root = document.documentElement;
    root.dataset.deviceForm = "tablet";
    root.dataset.tabletWindowed = String(state.windowed);
    root.dataset.tabletOrientation =
      (state.portrait ?? window.innerWidth <= 760) ? "portrait" : "landscape";
    root.dataset.tabletNav = (navOverride ?? compact) ? "collapsed" : "expanded";
    root.dataset.tabletTools = toolsCollapsed ? "collapsed" : "expanded";
    root.dataset.tabletFocus = String(focused);
    root.dataset.tabletKeyboard = String(
      window.innerHeight -
        (state.contentHeightPx + state.topInsetPx + state.bottomInsetPx) /
          (window.devicePixelRatio || 1) >
        80,
    );
    const ratio = window.devicePixelRatio || 1;
    if (state.contentHeightPx > 0)
      root.style.setProperty("--harmony-content-height", `${state.contentHeightPx / ratio}px`);
    root.style.setProperty("--harmony-content-inset-top", `${state.topInsetPx / ratio}px`);
    root.style.setProperty("--harmony-content-inset-bottom", `${state.bottomInsetPx / ratio}px`);
    window.dispatchEvent(new Event("workbench-tablet-metrics"));
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        ".window-shell > .tool-bar, .window-shell > .menu-bar",
      ),
    ];
    for (const target of targets)
      target.inert = target.matches(".tool-bar") ? toolsCollapsed : focused;
    return () => {
      for (const target of targets) target.inert = false;
      delete root.dataset.deviceForm;
      delete root.dataset.tabletWindowed;
      delete root.dataset.tabletOrientation;
      delete root.dataset.tabletNav;
      delete root.dataset.tabletTools;
      delete root.dataset.tabletFocus;
      delete root.dataset.tabletKeyboard;
      root.style.removeProperty("--harmony-content-inset-top");
      root.style.removeProperty("--harmony-content-inset-bottom");
      root.style.removeProperty("--harmony-content-height");
    };
  }, [state, compact, navOverride, toolsCollapsed, focused, editorMode, toolbarAvailable]);

  if (!state?.available) return null;
  return (
    <fieldset
      className="tablet-controls"
      aria-label="平板显示控制"
      onPointerDown={(event) => {
        if (event.button === 0) event.preventDefault();
      }}
    >
      {!editorMode && (
        <button
          type="button"
          aria-label={(navOverride ?? compact) ? "展开专利库导航" : "收起专利库导航"}
          title={(navOverride ?? compact) ? "展开专利库导航" : "收起专利库导航"}
          onClick={() => setNavOverride(!(navOverride ?? compact))}
        >
          <PanelLeft size={20} aria-hidden="true" />
        </button>
      )}
      {editorMode && toolbarAvailable && (
        <button
          type="button"
          disabled={focused}
          aria-label={toolsCollapsed ? "展开工具栏" : "收起工具栏"}
          title={toolsCollapsed ? "展开工具栏" : "收起工具栏"}
          aria-expanded={!toolsCollapsed}
          onClick={() => setToolsOverride(!toolsCollapsed)}
        >
          <PanelTop size={20} aria-hidden="true" />
        </button>
      )}
      {(editorMode || state.focusMode) && (
        <button
          type="button"
          disabled={busy || (state.windowed && !focused)}
          aria-pressed={focused}
          aria-label={focused ? "退出专注模式" : "进入专注模式"}
          title={
            state.windowed && !focused
              ? "专注模式需在全屏窗口使用"
              : focused
                ? "退出专注模式（Esc）"
                : "进入专注模式"
          }
          onClick={() => void changeFocus(!focused)}
        >
          {focused ? (
            <Minimize2 size={18} aria-hidden="true" />
          ) : (
            <Maximize2 size={18} aria-hidden="true" />
          )}
          <span>{focused ? "退出专注" : "专注"}</span>
        </button>
      )}
    </fieldset>
  );
}
