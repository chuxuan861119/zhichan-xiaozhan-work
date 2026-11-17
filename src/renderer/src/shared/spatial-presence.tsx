import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createDropdownMotion, findDropdownSurface } from "./dropdown-motion";
import { SPATIAL_MOTION_RETENTION_MS } from "./spatial-motion";
import { useRetainedTransientVisibility } from "./transient-function-rail-slot";

export function SpatialPresence({ children }: Readonly<{ children: ReactNode }>) {
  const open = Boolean(children);
  const retained = useRef(children);
  if (open) retained.current = children;
  const [retention, setRetention] = useState(SPATIAL_MOTION_RETENTION_MS);
  const visible = useRetainedTransientVisibility(open, retention);
  const presence = useRef<HTMLDivElement>(null);
  const motion = useMemo(() => createDropdownMotion(), []);
  useLayoutEffect(() => {
    const surface = visible ? findDropdownSurface(presence.current) : undefined;
    const duration = motion.update(surface, open);
    setRetention(duration === undefined ? SPATIAL_MOTION_RETENTION_MS : duration + 20);
  }, [open, visible, motion]);
  useLayoutEffect(() => () => motion.dispose(), [motion]);
  if (!visible) return null;
  return (
    <div
      ref={presence}
      className="spatial-presence"
      data-motion={open ? "enter" : "exit"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
    >
      {open ? children : retained.current}
    </div>
  );
}
