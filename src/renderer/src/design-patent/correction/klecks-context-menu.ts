export type KlecksMenuItem = {
  label: string;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
  number?: {
    value: number;
    min: number;
    max: number;
    step?: number;
    change: (value: number) => void;
  };
};
const openMenus = new WeakMap<Document, () => void>();
/** Shared by the isolated canvas and host panel; no document commands or cross-frame trust here. */
export function showKlecksContextMenu(
  doc: Document,
  point: { x: number; y: number },
  items: KlecksMenuItem[],
): () => void {
  openMenus.get(doc)?.();
  const win = doc.defaultView!,
    original = doc.activeElement as HTMLElement | null,
    menu = doc.createElement("div"),
    abort = new AbortController();
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "图片编辑右键菜单");
  menu.tabIndex = -1;
  menu.style.cssText =
    "position:fixed;z-index:100000;min-width:210px;max-width:calc(100vw - 16px);padding:5px;background:var(--ke-panel,#fff);color:var(--ke-ink,#203047);border:1px solid var(--ke-border,#d4dce7);border-radius:6px;box-shadow:var(--ui-shadow-floating,0 14px 36px rgb(15 23 42 / 14%));font:13px system-ui,sans-serif;overflow-y:auto;box-sizing:border-box";
  let closed = false;
  const close = (restore = false) => {
    if (closed) return;
    closed = true;
    abort.abort();
    menu.remove();
    openMenus.delete(doc);
    if (restore && original?.isConnected) original.focus({ preventScroll: true });
  };
  for (const item of items) {
    if (item.separator) {
      const line = doc.createElement("hr");
      line.style.cssText = "border:0;border-top:1px solid #e2e8f0;margin:5px 3px";
      line.setAttribute("role", "separator");
      menu.append(line);
    }
    if (item.number) {
      const label = doc.createElement("label"),
        input = doc.createElement("input");
      label.textContent = item.label;
      label.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 10px";
      input.type = "number";
      input.setAttribute("aria-label", item.label);
      input.value = String(item.number.value);
      input.min = String(item.number.min);
      input.max = String(item.number.max);
      input.step = String(item.number.step ?? 1);
      input.disabled = !!item.disabled;
      input.style.cssText =
        "width:72px;padding:4px;border:1px solid #d4dce7;border-radius:4px;color:inherit";
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (
          input.value !== "" &&
          Number.isFinite(value) &&
          value >= item.number!.min &&
          value <= item.number!.max
        )
          item.number!.change(value);
        else input.value = String(item.number!.value);
      });
      label.append(input);
      menu.append(label);
      continue;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    button.tabIndex = -1;
    button.style.cssText =
      "display:block;width:100%;padding:7px 10px;border:0;border-radius:3px;background:transparent;color:inherit;text-align:left;font:inherit;white-space:nowrap;cursor:default";
    if (button.disabled) button.style.opacity = ".4";
    button.addEventListener("pointerenter", () => {
      if (!button.disabled) {
        button.style.background = "#e8f1f4";
        button.focus({ preventScroll: true });
      }
    });
    button.addEventListener("pointerleave", () => {
      button.style.background = "transparent";
    });
    button.addEventListener("click", () => {
      if (button.disabled) return;
      close(true);
      item.run?.();
    });
    menu.append(button);
  }
  doc.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(60, win.innerHeight - 16)}px`;
  menu.style.left = `${Math.max(8, Math.min(point.x, win.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(point.y, win.innerHeight - Math.min(rect.height, win.innerHeight - 16) - 8))}px`;
  const options = { signal: abort.signal, capture: true };
  win.addEventListener(
    "pointerdown",
    (event) => {
      if (!menu.contains(event.target as Node)) close();
    },
    options,
  );
  win.addEventListener(
    "blur",
    (event) => {
      if (event.target === win) close();
    },
    options,
  );
  win.addEventListener("resize", () => close(), options);
  win.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
        return;
      }
      if (event.key === "Tab") {
        close();
        return;
      }
      if ((event.target as HTMLElement)?.tagName === "INPUT") return;
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      let index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        (doc.activeElement as HTMLButtonElement)?.click();
      }
    },
    options,
  );
  (menu.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)") ?? menu).focus({
    preventScroll: true,
  });
  const dispose = () => close();
  openMenus.set(doc, dispose);
  return dispose;
}
