import { ChevronDown, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { APPLICATION_NAME } from "../../../shared/branding";
import { SaveStateBadge } from "../documents/save-state-badge";
import { IpcDataCenter } from "../ipc-data-center/ipc-data-center";
import { BrandLogo } from "../shared/brand-logo";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";
import { spatialMotionTiming } from "../shared/spatial-motion";
import { SpatialPresence } from "../shared/spatial-presence";
import type { PatentSession } from "./patent-reducer";
import type { WorkspaceTabDragBindings, WorkspaceTabDragSource } from "./patent-workspace-tab-drag";

type PatentTabsProps = {
  tutorialMode?: boolean;
  guidance?: ReactNode;
  windowActions?: ReactNode;
  sessions: PatentSession[];
  activePatentId: string;
  libraryActive: boolean;
  onOpenLibrary(): void;
  onNewPatent?(): void;
  onActivatePatent(patentId: string): void;
  onRequestClose(patentId: string): void | Promise<void>;
  workspaceTabDrag?: WorkspaceTabDragBindings;
};

function PatentTabStateBadge({ session }: { session: PatentSession }) {
  const state = session.aggregateSaveState;
  const [showSaving, setShowSaving] = useState(false);
  useEffect(() => {
    setShowSaving(false);
    if (state !== "saving") return;
    // Filter brief autosave pulses, never delay the save itself or a failure.
    const timer = window.setTimeout(() => setShowSaving(true), 500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <span className="patent-tabs__state-badge">
      {state === "failed" || (state === "saving" && showSaving) ? (
        <SaveStateBadge state={state} lastSavedAt={session.lastSavedAt} />
      ) : (
        <span className={`patent-type-badge patent-type-badge--${session.patent.patentType}`}>
          {{ invention: "发明", "utility-model": "实用新型", design: "外观设计" }[session.patent.patentType]}
        </span>
      )}
    </span>
  );
}

export function PatentTabs({
  tutorialMode = false,
  guidance,
  windowActions,
  sessions,
  activePatentId,
  libraryActive,
  onOpenLibrary,
  onNewPatent,
  onActivatePatent,
  onRequestClose,
  workspaceTabDrag,
}: PatentTabsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const patentViewportRef = useRef<HTMLDivElement | null>(null);
  const knownSessionIdsRef = useRef(new Set(sessions.map((session) => session.patentId)));
  const closingSessionIdsRef = useRef(new Set<string>());
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [patentMenuOpen, setPatentMenuOpen] = useState(false);
  const sessionCount = sessions.length;

  useLayoutEffect(() => {
    const knownSessionIds = knownSessionIdsRef.current;
    knownSessionIdsRef.current = new Set(sessions.map((session) => session.patentId));
    if (isMotionReduced()) return;
    sessions.forEach((session) => {
      if (knownSessionIds.has(session.patentId)) return;
      const shell = tabListRef.current?.querySelector<HTMLElement>(
        `[data-patent-tab-id="${session.patentId}"]`,
      );
      if (typeof shell?.animate !== "function") return;
      const width = shell.getBoundingClientRect().width;
      shell.animate(
        [
          { opacity: 0, width: "0px" },
          { opacity: 1, width: `${width}px` },
        ],
        spatialMotionTiming(width),
      );
    });
  }, [sessions]);

  useLayoutEffect(() => {
    const viewport = patentViewportRef.current;
    if (!viewport) return;
    if (sessionCount === 0) {
      setTabsOverflow(false);
      setPatentMenuOpen(false);
      return;
    }
    const measureOverflow = () => {
      const overflowing = viewport.scrollWidth > viewport.clientWidth + 1;
      setTabsOverflow(overflowing);
      if (!overflowing) setPatentMenuOpen(false);
    };
    measureOverflow();
    window.addEventListener("resize", measureOverflow);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    observer?.observe(viewport);
    return () => {
      window.removeEventListener("resize", measureOverflow);
      observer?.disconnect();
    };
  }, [sessionCount]);

  useLayoutEffect(() => {
    if (libraryActive) return;
    const viewport = patentViewportRef.current;
    const activeShell = tabListRef.current?.querySelector<HTMLElement>(
      `[data-patent-tab-id="${activePatentId}"]`,
    );
    if (!viewport || !activeShell || viewport.clientWidth === 0) return;
    const tabLeft = activeShell.offsetLeft;
    const tabRight = tabLeft + activeShell.offsetWidth;
    const visibleLeft = viewport.scrollLeft;
    const visibleRight = visibleLeft + viewport.clientWidth;
    if (tabLeft < visibleLeft) viewport.scrollLeft = tabLeft;
    else if (tabRight > visibleRight) viewport.scrollLeft = tabRight - viewport.clientWidth;
  }, [activePatentId, libraryActive]);

  useEffect(() => {
    if (!patentMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setPatentMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPatentMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [patentMenuOpen]);

  useEffect(() => {
    const viewport = patentViewportRef.current;
    if (!viewport) return;
    const browsePatentTabs = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      viewport.scrollLeft += delta;
      event.preventDefault();
      event.stopPropagation();
    };
    viewport.addEventListener("wheel", browsePatentTabs, { passive: false });
    return () => viewport.removeEventListener("wheel", browsePatentTabs);
  }, []);

  const requestCloseWithAnimation = (patentId: string, button: HTMLButtonElement) => {
    if (closingSessionIdsRef.current.has(patentId)) return;
    const shell = button.closest<HTMLElement>(".patent-tabs__patent-tab-shell");
    if (!shell || typeof shell.animate !== "function" || isMotionReduced()) {
      onRequestClose(patentId);
      return;
    }
    closingSessionIdsRef.current.add(patentId);
    const width = shell.getBoundingClientRect().width;
    const animation = shell.animate(
      [
        { opacity: 1, width: `${width}px` },
        { opacity: 0, width: "0px" },
      ],
      {
        ...spatialMotionTiming(width),
        fill: "forwards",
      },
    );
    // Saving and the visual transition run concurrently; animation must not delay
    // persistence. A cancelled/failed close also needs its original tab restored.
    void animation.finished?.catch(() => undefined);
    void Promise.resolve(onRequestClose(patentId)).finally(() => {
      animation.cancel();
      closingSessionIdsRef.current.delete(patentId);
    });
  };

  return (
    <div ref={rootRef} className="patent-tabs" data-layout="single-tier">
      <div className="patent-tabs__top-row" role="tablist" aria-label="专利标签栏">
        {!tutorialMode && (
          <button
            type="button"
            role="tab"
            aria-selected={libraryActive}
            className={`patent-tabs__library-tab is-fixed ${libraryActive ? "is-active" : ""}`}
            onClick={onOpenLibrary}
          >
            <span className="patent-tabs__brand" title={APPLICATION_NAME}>
              <BrandLogo className="patent-tabs__brand-logo" decorative />
              <span>专利库</span>
            </span>
          </button>
        )}
        {windowActions}
        <div ref={patentViewportRef} className="patent-tabs__patent-viewport">
          <div ref={tabListRef} className="patent-tabs__patent-list">
            {sessions.map((session, index) => {
              const label = session.patent.name ?? `未命名专利 ${index + 1}`;
              const active = !libraryActive && session.patentId === activePatentId;
              const dragSource: WorkspaceTabDragSource = {
                key: `patent:${session.patentId}`,
                label,
                target: {
                  patentId: session.patentId,
                  bookKind: session.activeBookKind,
                },
              };
              return (
                <span
                  className={`patent-tabs__patent-tab-shell ${active ? "is-active" : ""}`}
                  key={session.patentId}
                  data-patent-tab-id={session.patentId}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={label}
                    title={label}
                    aria-selected={active}
                    className="patent-tabs__patent-tab"
                    onPointerDown={(event) =>
                      workspaceTabDrag?.start({
                        source: dragSource,
                        sourceElement: event.currentTarget,
                        pointerId: event.pointerId,
                        button: event.button,
                        clientX: event.clientX,
                        clientY: event.clientY,
                      })
                    }
                    onClick={() => {
                      if (workspaceTabDrag?.consumeClick(dragSource.key)) return;
                      onActivatePatent(session.patentId);
                    }}
                  >
                    <span className="patent-tabs__patent-title">{label}</span>
                    <PatentTabStateBadge session={session} />
                  </button>
                  <button
                    type="button"
                    className="patent-tabs__close-patent"
                    aria-label={`关闭${label}`}
                    title={`关闭${label}`}
                    onClick={(event) =>
                      requestCloseWithAnimation(session.patentId, event.currentTarget)
                    }
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
        {!tutorialMode && onNewPatent && (
          <button
            type="button"
            className="patent-tabs__new-patent"
            aria-label="新建专利（加号）"
            title="新建专利"
            onClick={() => {
              setPatentMenuOpen(false);
              onNewPatent();
            }}
          >
            <Plus size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {tabsOverflow ? (
          <button
            type="button"
            className="patent-tabs__overflow-trigger"
            aria-label="全部专利"
            aria-haspopup="menu"
            aria-expanded={patentMenuOpen}
            title="全部专利"
            onClick={() => setPatentMenuOpen((open) => !open)}
          >
            <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        ) : null}
        <div className="patent-tabs__spacer" aria-hidden="true" />
        {guidance}
        {!tutorialMode && <IpcDataCenter />}
      </div>
      <SpatialPresence>
        {patentMenuOpen ? (
          <div className="patent-tabs__overflow-menu" role="menu" aria-label="全部已打开专利">
            {sessions.map((session, index) => {
              const label = session.patent.name ?? `未命名专利 ${index + 1}`;
              const active = !libraryActive && session.patentId === activePatentId;
              return (
                <button
                  type="button"
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  key={session.patentId}
                  onClick={() => {
                    setPatentMenuOpen(false);
                    onActivatePatent(session.patentId);
                  }}
                >
                  <span className="patent-tabs__overflow-menu-title">{label}</span>
                  <SaveStateBadge
                    state={session.aggregateSaveState}
                    lastSavedAt={session.lastSavedAt}
                  />
                </button>
              );
            })}
          </div>
        ) : null}
      </SpatialPresence>
    </div>
  );
}
