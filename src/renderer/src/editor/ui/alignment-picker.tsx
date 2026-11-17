import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fixedShortcutsFor } from "../../../../shared/settings/shortcuts";
import type { EditorFormatState } from "../../app/command-bus";
import { SpatialPresence } from "../../shared/spatial-presence";
import type { EditorCommand } from "../commands";
import { toolbarDropdownPosition } from "./toolbar-dropdown-position";

const OPTIONS = [
  { value: "left", label: "左对齐", Icon: AlignLeft },
  { value: "center", label: "居中", Icon: AlignCenter },
  { value: "right", label: "右对齐", Icon: AlignRight },
  { value: "justify", label: "两端对齐", Icon: AlignJustify },
] as const;

export function AlignmentPicker({
  alignment,
  disabled,
  onCommand,
}: {
  alignment: EditorFormatState["alignment"];
  disabled: boolean;
  onCommand(command: EditorCommand): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!position || !trigger.current || !menu.current) return;
    const fitted = toolbarDropdownPosition(
      trigger.current,
      trigger.current,
      menu.current.offsetWidth,
    );
    if (fitted) menu.current.style.left = `${fitted.left}px`;
  }, [position]);
  const current = OPTIONS.find((option) => option.value === alignment) ?? OPTIONS[0];
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (trigger.current?.contains(event.target) || menu.current?.contains(event.target))
      )
        return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [position]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tool-button"
        style={{
          width: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
        aria-label="段落对齐"
        title={`段落对齐：${current.label}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition(
            position
              ? null
              : (toolbarDropdownPosition(event.currentTarget) ?? {
                  top: rect.bottom + 4,
                  left: Math.max(4, Math.min(rect.left, window.innerWidth - 180)),
                }),
          );
        }}
      >
        <current.Icon size={18} />
        <ChevronDown size={12} />
      </button>
      {createPortal(
        <SpatialPresence>
          {position && !disabled ? (
            <div
              ref={menu}
              className="toolbar-export-menu"
              role="menu"
              aria-label="段落对齐方式"
              style={{ position: "fixed", top: position.top, left: position.left, zIndex: 10000 }}
              onPointerDown={(event) => event.preventDefault()}
            >
              {OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-label={label}
                  aria-checked={alignment === value}
                  className={alignment === value ? "is-active" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: alignment === value ? "#edf1f7" : undefined,
                  }}
                  title={fixedShortcutsFor(label).join(" / ")}
                  onClick={() => {
                    onCommand(`align-${value}`);
                    setPosition(null);
                  }}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}
