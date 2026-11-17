import { type ReactNode, useState } from "react";
import { SpatialCollapse } from "./spatial-collapse";
import { useRetainedTransientVisibility } from "./transient-function-rail-slot";

export function SpatialPresetDisclosure({
  className,
  summary,
  children,
}: Readonly<{ className: string; summary: ReactNode; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  const visible = useRetainedTransientVisibility(open);
  return (
    <details className={className} open={visible}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useSemanticElements: A native summary must remain the details toggle; explicit button semantics expose the logical state while its exit paint is retained. */}
      <summary
        role="button"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        {summary}
      </summary>
      <SpatialCollapse open={open}>{children}</SpatialCollapse>
    </details>
  );
}
