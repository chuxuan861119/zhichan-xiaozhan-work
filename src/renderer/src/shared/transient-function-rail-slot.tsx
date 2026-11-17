import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { SPATIAL_MOTION_RETENTION_MS } from "./spatial-motion";
import { useReducedMotion } from "./use-reduced-motion";

export function useRetainedTransientVisibility(
  open: boolean,
  retentionMs = SPATIAL_MOTION_RETENTION_MS,
): boolean {
  const [retained, setRetained] = useState(open);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return undefined;
    }
    if (!retained) return undefined;
    if (reduced) {
      setRetained(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setRetained(false), retentionMs);
    return () => window.clearTimeout(timer);
  }, [open, retained, reduced, retentionMs]);

  return open || (!reduced && retained);
}

export function TransientFunctionRailSlot({
  open,
  children,
}: Readonly<{ open: boolean; children: ReactNode }>) {
  const retainedChildren = useRef<ReactNode>(null);
  const visible = useRetainedTransientVisibility(open);
  if (open && children !== null && children !== undefined) retainedChildren.current = children;
  if (!visible) return null;

  return (
    <div
      className="function-rail-transient-slot"
      data-motion={open ? "enter" : "exit"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
    >
      <div className="function-rail-transient-slot__content">
        {open ? children : retainedChildren.current}
      </div>
    </div>
  );
}
