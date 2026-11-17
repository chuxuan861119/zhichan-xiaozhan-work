import { type ChangeEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorFormatState } from "../../app/command-bus";
import { SpatialPresence } from "../../shared/spatial-presence";
import { toolbarDropdownPosition } from "./toolbar-dropdown-position";
import { ToolbarSelectButton } from "./toolbar-select-button";

export function ParagraphStylePicker({
  formatState,
  headings,
  disabled,
  onChange,
}: {
  formatState: Pick<EditorFormatState, "paragraphStyle" | "mixedParagraphStyle">;
  headings: boolean;
  disabled: boolean;
  onChange(style: EditorFormatState["paragraphStyle"]): void;
}) {
  const select = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const value = formatState.mixedParagraphStyle ? "" : String(formatState.paragraphStyle);

  useEffect(() => {
    if (disabled || !headings) setPosition(null);
  }, [disabled, headings]);
  useLayoutEffect(() => {
    if (!position || !select.current || !menu.current) return;
    const fitted = toolbarDropdownPosition(
      select.current,
      select.current,
      menu.current.offsetWidth,
    );
    if (fitted) menu.current.style.left = `${fitted.left}px`;
    const selected = menu.current.querySelector<HTMLElement>('[aria-checked="true"]');
    (selected ?? menu.current.querySelector<HTMLElement>("button"))?.focus();
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (select.current?.contains(event.target) || menu.current?.contains(event.target))
      )
        return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      select.current?.focus();
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

  const change = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.currentTarget.value;
    if (disabled) return;
    if (headings && next === "more") {
      event.currentTarget.value = value;
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition(
        toolbarDropdownPosition(event.currentTarget) ?? { top: rect.bottom, left: rect.left },
      );
      return;
    }
    if (next !== "paragraph" && !(headings && next === "1")) return;
    setPosition(null);
    onChange(next === "paragraph" ? "paragraph" : 1);
  };

  return (
    <>
      <select
        ref={select}
        className="style-select"
        aria-label="段落样式"
        aria-disabled={disabled}
        disabled={disabled}
        value={value}
        onChange={change}
      >
        <ToolbarSelectButton />
        {formatState.mixedParagraphStyle ? (
          <option value="" disabled hidden aria-label="混合段落样式" />
        ) : null}
        <option value="paragraph">正文</option>
        {headings ? <option value="1">章节标题</option> : null}
        {headings && (value === "2" || value === "3") ? (
          <option value={value} hidden>{`标题 ${value}`}</option>
        ) : null}
        {headings ? <option value="more">更多样式…</option> : null}
      </select>
      {createPortal(
        <SpatialPresence>
          {position && headings && !disabled ? (
            <div
              ref={menu}
              className="toolbar-export-menu"
              role="menu"
              aria-label="更多段落样式"
              style={{ position: "fixed", top: position.top, left: position.left, zIndex: 10000 }}
              onPointerDown={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const choices = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                );
                const index = choices.findIndex((choice) => choice === document.activeElement);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? choices.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) %
                        choices.length;
                choices[next]?.focus();
              }}
            >
              {([2, 3] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    !formatState.mixedParagraphStyle && formatState.paragraphStyle === level
                  }
                  className={value === String(level) ? "is-active" : undefined}
                  onClick={() => {
                    setPosition(null);
                    onChange(level);
                  }}
                >
                  标题 {level}
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
