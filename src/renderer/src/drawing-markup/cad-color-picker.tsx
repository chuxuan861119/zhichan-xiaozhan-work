import { useEditorSessionVisible } from "../shared/editor-session-scope";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CustomColorPopup } from "../editor/ui/custom-color-popup";
import { TextColorPalette } from "../editor/ui/text-color-palette";
import { SpatialPresence } from "../shared/spatial-presence";
import "../editor/ui/text-color-picker.css";

export function CadColorPicker({
  id,
  value,
  label,
  disabled,
  onSelect,
  focusCanvas,
}: {
  id: string;
  value: string;
  label: string;
  disabled: boolean;
  onSelect(color: string): void;
  focusCanvas(): void;
}) {
  const sessionVisible = useEditorSessionVisible();
  const [open, setOpen] = useState(false);
  const [customAnchor, setCustomAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(value || "#000000");
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const custom = useRef<HTMLElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setCustomAnchor(null);
  }, []);
  function select(color: string) {
    close();
    onSelect(color.toLowerCase());
  }
  const reposition = useCallback(() => {
    const palette = layer.current?.querySelector<HTMLElement>(".color-palette");
    if (!palette || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const { width, height } = palette.getBoundingClientRect();
    const below = anchor.bottom + 4 + height <= window.innerHeight - 8;
    palette.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    palette.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4)}px`;
    palette.style.setProperty("--dropdown-open-direction", below ? "down" : "up");
  }, []);
  useEffect(() => {
    if (disabled || !sessionVisible) {
      setOpen(false);
      setCustomAnchor(null);
    }
  }, [disabled, sessionVisible]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !layer.current?.contains(target) &&
        !custom.current?.contains(target)
      )
        close();
    };
    const scroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        (layer.current?.contains(event.target) || custom.current?.contains(event.target))
      )
        return;
      reposition();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !(event.target instanceof Node) ||
        !layer.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      close();
      focusCanvas();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close, focusCanvas, reposition]);
  useLayoutEffect(() => {
    const palette = layer.current?.querySelector<HTMLElement>(".color-palette");
    if (!open || !palette || !trigger.current) return;
    reposition();
    (
      palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ??
      palette.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
  }, [open, reposition]);
  return (
    <>
      <button
        id={id}
        ref={trigger}
        className="cad-appearance-control cad-color-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <i
          className="cad-color-swatch"
          style={{ background: value || "linear-gradient(135deg,#fff 50%,#777 50%)" }}
        />
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {createPortal(
        <div
          hidden={!sessionVisible}
          ref={layer}
          className="text-color-picker cad-color-palette-layer"
          data-tool-tooltip="off"
        >
          <SpatialPresence>
            {open ? (
              <TextColorPalette
                label="颜色"
                value={value || "#000000"}
                onSelect={select}
                onCustom={(anchor) => {
                  setDraft(value || "#000000");
                  setCustomAnchor(anchor);
                }}
              />
            ) : null}
          </SpatialPresence>
        </div>,
        document.body,
      )}
      <CustomColorPopup
        className="cad-custom-color-popup"
        open={sessionVisible && open && !!customAnchor}
        value={value || "#000000"}
        title="其他颜色"
        anchor={customAnchor}
        surface={custom}
        onSelect={setDraft}
        onClose={() => {
          close();
          focusCanvas();
        }}
        onConfirm={select}
        footer={(valid) => (
          <div className="cad-color-confirm-actions">
            <button
              type="button"
              onClick={() => {
                close();
                focusCanvas();
              }}
            >
              取消
            </button>
            <button type="button" disabled={!valid} onClick={() => select(draft)}>
              应用
            </button>
          </div>
        )}
      />
    </>
  );
}
