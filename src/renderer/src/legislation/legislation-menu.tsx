import { useEffect, useRef, useState } from "react";
import type { LegislationId } from "../../../shared/legislation";
import { ADDITIONAL_LEGISLATION } from "../../../shared/legislation-extra";
import { SpatialPresence } from "../shared/spatial-presence";

export function LegislationMenu({
  selected,
  onSelect,
}: {
  selected: LegislationId | null;
  onSelect(id: LegislationId): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    (
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    )?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    // Handle the submenu before the enclosing dialog's document capture listener.
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);
  return (
    <fieldset
      aria-label="其他法规选择"
      className="legislation-more"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="更多法规"
        title="更多法规"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={ADDITIONAL_LEGISLATION.some((item) => item.id === selected)}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">···</span>
      </button>
      <SpatialPresence>
        {open ? (
          <div
            ref={menu}
            role="menu"
            aria-label="更多法规"
            className="legislation-more__menu"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
                return;
              }
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitemradio"]',
                ),
              ];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowDown"
                      ? (index + 1) % items.length
                      : event.key === "ArrowUp"
                        ? (index - 1 + items.length) % items.length
                        : null;
              if (next !== null) {
                event.preventDefault();
                items[next]?.focus();
              }
            }}
          >
            {(["行政法规", "部门规章", "配套政策"] as const).map((category) => (
              <fieldset aria-label={category} key={category}>
                <div className="legislation-more__category" aria-hidden="true">
                  {category}
                </div>
                {ADDITIONAL_LEGISLATION.filter((item) => item.category === category).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected === item.id}
                    onClick={() => {
                      onSelect(item.id);
                      setOpen(false);
                      trigger.current?.focus();
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </fieldset>
            ))}
          </div>
        ) : null}
      </SpatialPresence>
    </fieldset>
  );
}
