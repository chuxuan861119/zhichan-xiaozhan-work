import { useEditorSessionVisible } from "../shared/editor-session-scope";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export type CadMenuChoice = { id: string; label: string; tool: string; Icon: LucideIcon };
export function CadToolMenu(props: {
  name: string;
  choices: CadMenuChoice[];
  active: boolean;
  activeChoiceId?: string;
  disabled: boolean;
  choose: (choice: CadMenuChoice) => void;
  focusCanvas: () => void;
}) {
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(`cad.tool-menu.${props.name}`) ?? props.choices[0]!.id;
    } catch {
      return props.choices[0]!.id;
    }
  });
  const sessionVisible = useEditorSessionVisible();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (props.disabled || !sessionVisible) setOpen(false);
  }, [props.disabled, sessionVisible]);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const current = props.choices.find((c) => c.id === selected) ?? props.choices[0]!;
  const primary = props.choices[0]!;
  const shown = props.active
    ? (props.choices.find((c) => c.id === props.activeChoiceId) ?? current)
    : primary;
  const mainLabel =
    shown.id === primary.id ? props.name : shown.tool === "polygon" ? "正多边形" : shown.label;
  const reposition = useCallback(() => {
    if (!trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect();
    const menuWidth = menu.current?.offsetWidth || 188;
    const theme = getComputedStyle(trigger.current);
    for (const key of ["--rail-surface", "--rail-ink", "--rail-line", "--rail-accent"])
      menu.current?.style.setProperty(key, theme.getPropertyValue(key));
    const left = Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = Math.max(
      8,
      Math.min(r.bottom + 6, window.innerHeight - (menu.current?.offsetHeight ?? 300) - 8),
    );
    setPosition((old) => (old.left === left && old.top === top ? old : { left, top }));
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    menu.current
      ?.querySelector<HTMLButtonElement>("[role='menuitemradio'][aria-checked='true']")
      ?.focus({ preventScroll: true });
  }, [open, reposition]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))
        setOpen(false);
    };
    const resize = () => reposition();
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", resize);
    const scroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) reposition();
    };
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, reposition]);
  function choose(choice: CadMenuChoice) {
    setOpen(false);
    setSelected(choice.id);
    try {
      localStorage.setItem(`cad.tool-menu.${props.name}`, choice.id);
    } catch {
      /* Optional preference. */
    }
    props.focusCanvas();
    props.choose(choice);
  }
  return (
    <div className="cad-split-tool">
      <button
        type="button"
        disabled={props.disabled}
        aria-pressed={props.active}
        aria-label={mainLabel}
        aria-description={`${props.name} · ${shown.label}`}
        onClick={() => choose(shown)}
      >
        <shown.Icon size={20} aria-hidden="true" />
        <span>{mainLabel}</span>
      </button>
      <button
        className="cad-split-tool__arrow"
        type="button"
        ref={trigger}
        disabled={props.disabled}
        aria-label={`${props.name}选项`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} />
      </button>
      {sessionVisible && open &&
        !props.disabled &&
        createPortal(
          <div
            ref={menu}
            className="cad-tool-menu"
            data-tool-tooltip="off"
            style={position}
            role="menu"
            aria-label={`${props.name}选项`}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                props.focusCanvas();
              }
              if (e.key === "Tab") {
                setOpen(false);
                return;
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button")];
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                items[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                ]?.focus({ preventScroll: true });
              }
            }}
          >
            {props.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitemradio"
                aria-checked={(props.active ? shown : current).id === c.id}
                onClick={() => choose(c)}
              >
                <c.Icon size={22} aria-hidden="true" />
                <span>{c.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
