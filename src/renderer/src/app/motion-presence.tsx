import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SPATIAL_MOTION_RETENTION_MS } from "../shared/spatial-motion";
import { useReducedMotion } from "../shared/use-reduced-motion";

const ClosingContext = createContext(false);
export const useMotionPresenceClosing = () => useContext(ClosingContext);

export function MotionPresence({
  children,
  kind = "dialog",
  clearSensitiveInputs = false,
}: Readonly<{ children: ReactNode; kind?: "dialog" | "panel"; clearSensitiveInputs?: boolean }>) {
  // Stable slots preserve null/false positions when neighbouring overlays close.
  return Array.isArray(children) ? (
    children.map((child, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: These fixed physical slots retain null positions and never reorder.
      <MotionPresenceSlot key={index} kind={kind} clearSensitiveInputs={clearSensitiveInputs}>
        {child}
      </MotionPresenceSlot>
    ))
  ) : (
    <MotionPresenceSlot kind={kind} clearSensitiveInputs={clearSensitiveInputs}>
      {children}
    </MotionPresenceSlot>
  );
}

function MotionPresenceSlot({
  children,
  kind = "dialog",
  clearSensitiveInputs = false,
}: Readonly<{ children: ReactNode; kind?: "dialog" | "panel"; clearSensitiveInputs?: boolean }>) {
  const paintRef = useRef<HTMLDivElement>(null);
  const retainedChildRef = useRef(children);
  const wasPresentRef = useRef(Boolean(children));
  const [exitVisible, setExitVisible] = useState(false);
  const reducedMotion = useReducedMotion();

  if (children) retainedChildRef.current = children;
  const closing = !children && !reducedMotion && (wasPresentRef.current || exitVisible);

  useLayoutEffect(() => {
    if (closing && clearSensitiveInputs) {
      for (const field of paintRef.current?.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ) ?? []) {
        field.value = "";
        field.defaultValue = "";
      }
    }
  }, [closing, clearSensitiveInputs]);

  useLayoutEffect(() => {
    if (children) {
      wasPresentRef.current = true;
      setExitVisible(false);
      return undefined;
    }
    if (!wasPresentRef.current || reducedMotion) {
      wasPresentRef.current = false;
      setExitVisible(false);
      return undefined;
    }
    wasPresentRef.current = false;
    setExitVisible(true);
    const timer = window.setTimeout(() => setExitVisible(false), SPATIAL_MOTION_RETENTION_MS);
    return () => window.clearTimeout(timer);
  }, [children, reducedMotion]);

  const renderedChild = children ? children : closing ? retainedChildRef.current : null;
  if (!renderedChild) return null;
  return (
    <div
      ref={paintRef}
      className="motion-presence"
      data-motion-kind={kind}
      data-motion-state={closing ? "closing" : "open"}
      aria-hidden={closing || undefined}
      // React exposes the native inert property in current Electron/Chromium.
      inert={closing || undefined}
    >
      <ClosingContext.Provider value={closing}>{renderedChild}</ClosingContext.Provider>
    </div>
  );
}
