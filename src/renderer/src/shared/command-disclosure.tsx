import { type ReactNode, useEffect, useRef } from "react";

/** Low-frequency commands remain ordinary buttons, with native disclosure keyboard support. */
export function CommandDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target))
        ref.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  return (
    <details
      ref={ref}
      className="command-disclosure"
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button:not(:disabled)") &&
          ref.current
        )
          ref.current.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && ref.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>{label}</summary>
      <div className="command-disclosure__items">{children}</div>
    </details>
  );
}
