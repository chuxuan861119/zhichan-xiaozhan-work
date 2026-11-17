import { type ReactNode, useEffect, useRef } from "react";
import { useRetainedTransientVisibility } from "./transient-function-rail-slot";

export function SpatialCollapse({
  open,
  children,
  className,
  animateInitial = true,
  retentionMs,
  parentGap = 0,
}: Readonly<{
  open: boolean;
  children: ReactNode;
  className?: string;
  animateInitial?: boolean;
  retentionMs?: number;
  /** Move a vertical flex stack's gap (pixels or CSS length) inside the animated height. */
  parentGap?: number | string;
}>) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const retained = useRef(children);
  if (open) retained.current = children;
  const visible = useRetainedTransientVisibility(open, retentionMs);
  if (!visible) return null;
  return (
    <div
      className={`spatial-collapse${className ? ` ${className}` : ""}`}
      style={
        parentGap
          ? {
              marginBlockStart:
                typeof parentGap === "number" ? -parentGap : `calc(-1 * ${parentGap})`,
            }
          : undefined
      }
      data-motion={open ? (animateInitial || mounted.current ? "enter" : "steady") : "exit"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
    >
      <div className="spatial-collapse__content">
        {parentGap ? (
          <div className="spatial-collapse__spacing" style={{ paddingBlockStart: parentGap }}>
            {open ? children : retained.current}
          </div>
        ) : open ? (
          children
        ) : (
          retained.current
        )}
      </div>
    </div>
  );
}
