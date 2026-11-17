import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FIXED_MOTION_DURATIONS } from "../shared/spatial-motion";
import { useRetainedTransientVisibility } from "../shared/transient-function-rail-slot";
import { useReducedMotion } from "../shared/use-reduced-motion";
import { useSurfaceResizeMotion } from "../shared/use-surface-resize-motion";
import "./cad-function-tabs.css";

const storageKey = "patent-workbench:cad-function-rail:tab:v1";
const tabs = [
  { id: "tools", label: "CAD工具" },
  { id: "marks", label: "附图标记" },
] as const;
type Tab = (typeof tabs)[number]["id"];

function CadTabPanel({
  active,
  tab,
  id,
  children,
}: {
  active: boolean;
  tab: Tab;
  id: string;
  children: ReactNode;
}) {
  const visible = useRetainedTransientVisibility(active, FIXED_MOTION_DURATIONS.functionRail + 20);
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const previous = useRef(active);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const changed = previous.current !== active;
    previous.current = active;
    const element = panel.current;
    if (!element || !visible || reduced) {
      animation.current?.cancel();
      animation.current = null;
      return;
    }
    if (!changed || typeof element.animate !== "function") return;
    // Sample before cancelling so a reversal continues from the painted frame.
    const current = animation.current ? getComputedStyle(element) : null;
    const from = {
      opacity: current?.opacity || (active ? "0" : "1"),
      transform:
        current?.transform || (active ? `translateX(${tab === "tools" ? -6 : 6}px)` : "none"),
    };
    animation.current?.cancel();
    animation.current = element.animate(
      [
        from,
        {
          opacity: active ? 1 : 0,
          transform: active ? "none" : `translateX(${tab === "tools" ? -6 : 6}px)`,
        },
      ],
      { duration: FIXED_MOTION_DURATIONS.functionRail, easing: "ease-in-out", fill: "both" },
    );
  }, [active, visible, reduced, tab]);
  useLayoutEffect(() => () => animation.current?.cancel(), []);
  return (
    <div
      ref={panel}
      className="cad-function-tabs__panel"
      data-motion={active ? "enter" : "exit"}
      data-tool-tooltip={tab === "tools" ? "off" : undefined}
      role="tabpanel"
      id={`${id}-panel-${tab}`}
      aria-labelledby={`${id}-tab-${tab}`}
      aria-hidden={!active}
      hidden={!visible}
      inert={!active}
    >
      {children}
    </div>
  );
}

export function CadFunctionTabs({
  cadAvailable,
  tools,
  referenceMarks,
  renderRail,
  requestTools = false,
  requestKey = 0,
  toolsLabel = "CAD工具",
}: {
  cadAvailable: boolean;
  tools: ReactNode;
  referenceMarks: ReactNode;
  renderRail?: (header: ReactNode, panels: ReactNode) => ReactNode;
  requestTools?: boolean;
  requestKey?: string | number;
  toolsLabel?: "CAD工具" | "图片工具";
}) {
  const id = useId();
  const tablist = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Tab>(() => {
    try {
      return localStorage.getItem(storageKey) === "marks" ? "marks" : "tools";
    } catch {
      // Optional UI preference restrictions must not block access to the drawing.
      return "tools";
    }
  });
  const select = useCallback((tab: Tab) => {
    setSelected(tab);
    try {
      localStorage.setItem(storageKey, tab);
    } catch {
      /* Keep the current-session choice when persistent storage is unavailable. */
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new explicit activation must reveal the requested tab even when it was already requested by the selected detail.
  useEffect(() => {
    if (cadAvailable && requestTools) select("tools");
  }, [cadAvailable, requestTools, requestKey, select]);
  useSurfaceResizeMotion(stage, selected === "tools", {
    anchored: true,
    duration: FIXED_MOTION_DURATIONS.functionRail,
  });
  if (!cadAvailable) return renderRail ? renderRail(null, referenceMarks) : referenceMarks;
  const header = (
    <div
      ref={tablist}
      className="cad-function-tabs__tabs"
      role="tablist"
      aria-label={toolsLabel === "图片工具" ? "图片功能栏" : "CAD功能栏"}
      data-tool-tooltip="off"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${id}-tab-${tab.id}`}
          aria-controls={`${id}-panel-${tab.id}`}
          aria-selected={selected === tab.id}
          style={{ transitionDuration: `${FIXED_MOTION_DURATIONS.functionRail}ms` }}
          tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => select(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowRight"
                    ? 1 - index
                    : null;
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            select(next === 0 ? "tools" : "marks");
            tablist.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tab.id === "tools" ? toolsLabel : tab.label}
        </button>
      ))}
    </div>
  );
  const panels = (
    <div ref={stage} className="cad-function-tabs__panels">
      {tabs.map((tab) => (
        <CadTabPanel key={tab.id} tab={tab.id} id={id} active={selected === tab.id}>
          {tab.id === "tools" ? tools : referenceMarks}
        </CadTabPanel>
      ))}
    </div>
  );
  return renderRail ? (
    renderRail(header, panels)
  ) : (
    <>
      {header}
      {panels}
    </>
  );
}
