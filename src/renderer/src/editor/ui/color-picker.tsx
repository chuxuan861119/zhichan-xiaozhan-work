import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SpatialPresence } from "../../shared/spatial-presence";
import { CustomColorPopup } from "./custom-color-popup";
import { HighlightColorPalette } from "./highlight-color-palette";
import { HighlightIcon } from "./highlight-icon";
import { TextColorPalette } from "./text-color-palette";
import { toolbarDropdownPosition } from "./toolbar-dropdown-position";
import "./text-color-picker.css";

type ColorPickerProps = {
  value?: string;
  disabled?: boolean;
  onUnavailable?(): void;
} & (
  | {
      kind?: "text";
      onSelect(color: string, preserveSelection?: boolean, focusEditor?: boolean): void;
    }
  | {
      kind: "highlight";
      onSelect(color: string | null, preserveSelection?: boolean, focusEditor?: boolean): void;
    }
);

export function ColorPicker(props: ColorPickerProps) {
  const { value, disabled = false, onUnavailable } = props;
  const label = props.kind === "highlight" ? "文本突出显示颜色" : "文字颜色";
  const [selectedColor, setSelectedColor] = useState(
    value ?? (props.kind === "highlight" ? "#FFFF00" : "#000000"),
  );
  useEffect(() => {
    if (value) setSelectedColor(value.toUpperCase());
  }, [value]);
  const [open, setOpen] = useState(false);
  const [customAnchor, setCustomAnchor] = useState<HTMLElement | null>(null);
  const customSurface = useRef<HTMLElement>(null);
  const appliedCustomColor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening a different custom popup starts a new color application session.
  useEffect(() => {
    appliedCustomColor.current = null;
  }, [customAnchor]);
  useEffect(() => {
    if (!open) setCustomAnchor(null);
  }, [open]);
  const selectCustom = (color: string) => {
    if (disabled) return onUnavailable?.();
    const normalized = color.toUpperCase();
    if (normalized === appliedCustomColor.current) return;
    appliedCustomColor.current = normalized;
    setSelectedColor(normalized);
    props.onSelect(normalized, true, false);
  };
  const select = (color: string | null) => {
    if (disabled) return onUnavailable?.();
    if (color !== null) {
      const normalized = color.toUpperCase();
      setSelectedColor(normalized);
      props.onSelect(normalized);
    } else if (props.kind === "highlight") props.onSelect(null);
    setOpen(false);
    setCustomAnchor(null);
  };
  const root = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !customSurface.current?.contains(event.target)
      ) {
        setOpen(false);
        setCustomAnchor(null);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setCustomAnchor(null);
    }
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const palette = root.current?.querySelector<HTMLElement>(".color-palette");
    if (!palette || !trigger.current) return;
    const toolbarPosition = toolbarDropdownPosition(
      trigger.current,
      root.current ?? trigger.current,
      palette.offsetWidth,
    );
    if (toolbarPosition) {
      palette.style.left = `${toolbarPosition.left}px`;
      palette.style.top = `${toolbarPosition.top}px`;
      return;
    }
    palette.style.left = "0px";
    palette.style.top = "0px";
    const rect = palette.getBoundingClientRect();
    const anchor = trigger.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
    const top =
      anchor.bottom + 4 + rect.height <= window.innerHeight - 8
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - rect.height - 4);
    palette.style.left = `${left - rect.left}px`;
    palette.style.top = `${top - rect.top}px`;
  }, [open]);
  return (
    <>
      <fieldset
        className="color-picker text-color-picker"
        aria-label={`${label}选择`}
        ref={root}
        onPointerDown={(event) => {
          if (
            event.button === 0 &&
            event.target instanceof Element &&
            !event.target.closest("input")
          )
            event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          } else if (event.key === "Tab") setOpen(false);
        }}
      >
        <div className="color-picker-split">
          <button
            className="color-picker-main"
            type="button"
            aria-label={`应用${label}`}
            title={`应用${label} ${selectedColor}`}
            disabled={disabled && !onUnavailable}
            aria-disabled={disabled}
            onClick={() => select(selectedColor)}
          >
            {props.kind === "highlight" ? (
              <HighlightIcon size={18} fill={selectedColor} />
            ) : (
              <span
                className="color-picker-letter"
                style={{ color: selectedColor }}
                aria-hidden="true"
              >
                A
              </span>
            )}
          </button>
          <button
            className="color-picker-dropdown"
            ref={trigger}
            type="button"
            aria-label={`打开${label}菜单`}
            title={`选择${label}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled && !onUnavailable}
            aria-disabled={disabled}
            onClick={() => (disabled ? onUnavailable?.() : setOpen((current) => !current))}
          >
            <ChevronDown size={14} />
          </button>
        </div>
        {
          <SpatialPresence>
            {open ? (
              props.kind === "highlight" ? (
                <HighlightColorPalette
                  value={selectedColor}
                  onSelect={select}
                  onCustom={setCustomAnchor}
                />
              ) : (
                <TextColorPalette
                  value={selectedColor}
                  onSelect={select}
                  onCustom={setCustomAnchor}
                />
              )
            ) : null}
          </SpatialPresence>
        }
      </fieldset>
      <CustomColorPopup
        open={open && customAnchor !== null}
        value={selectedColor}
        title={props.kind === "highlight" ? "其他突出显示颜色" : "其他颜色"}
        anchor={customAnchor}
        surface={customSurface}
        onSelect={selectCustom}
        onClose={() => setCustomAnchor(null)}
      />
    </>
  );
}
