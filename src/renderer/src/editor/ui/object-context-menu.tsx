import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showAppAlert } from "../../shared/app-dialog";
import { SpatialPresence } from "../../shared/spatial-presence";
import "./editor-context-menus.css";

type Action = { label: string; disabled?: boolean; run(): unknown };
/** Context actions for the non-text drawing pages; never intercept their rail inputs. */
export function useObjectContextMenu(
  owner: string,
  actions: readonly Action[],
  label = "附图右键菜单",
) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; host: HTMLElement } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor) return;
    const close = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target))
        setAnchor(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);
  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const box = (
      anchor.host.closest("[data-function-rail-scope]") ?? document.body
    ).getBoundingClientRect();
    const target = panel.current;
    target.style.left = `${Math.max(box.left + 8, Math.min(anchor.x, box.right - target.offsetWidth - 8))}px`;
    target.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - target.offsetHeight - 8))}px`;
    target
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [anchor]);
  const open = (event: MouseEvent<HTMLElement>, position?: { x: number; y: number }) => {
    event.preventDefault();
    event.stopPropagation();
    setAnchor({
      x: position?.x ?? event.clientX,
      y: position?.y ?? event.clientY,
      host: event.currentTarget,
    });
  };
  const menu = createPortal(
    <SpatialPresence>
      {anchor ? (
        <div
          ref={panel}
          className="editor-context-menu editor-menu-surface"
          data-editor-menu-owner={owner}
          role="menu"
          aria-label={label}
          style={{ width: 200, left: anchor.x, top: anchor.y }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" || event.key === "Tab") {
              setAnchor(null);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            items[
              (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
            ]?.focus();
          }}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              className={action.label.startsWith("删除") ? "is-danger" : undefined}
              onClick={() => {
                setAnchor(null);
                void Promise.resolve()
                  .then(() => action.run())
                  .catch(() => showAppAlert("操作未完成，请重试。"));
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </SpatialPresence>,
    document.body,
  );
  return { open, menu };
}
