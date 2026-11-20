import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DesignImageMode } from "../../../../shared/patent/design-image-modes";

export function DesignImageModeDialog({
  mode,
  count,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  mode: DesignImageMode;
  count: number;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const backdrop = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = backdrop.current,
      element = dialog.current;
    if (!root || !element) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = Array.from(document.body.children).filter((item) => item !== root);
    const attributes = background.map((item) => ({
      item,
      inert: item.hasAttribute("inert"),
      hidden: item.getAttribute("aria-hidden"),
    }));
    for (const { item } of attributes) {
      item.setAttribute("inert", "");
      item.setAttribute("aria-hidden", "true");
    }
    element.querySelector<HTMLButtonElement>("button")?.focus();
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) element.focus();
    };
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("focusin", focus);
      for (const { item, inert, hidden } of attributes) {
        if (!inert) item.removeAttribute("inert");
        if (hidden === null) item.removeAttribute("aria-hidden");
        else item.setAttribute("aria-hidden", hidden);
      }
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="dialog-backdrop" ref={backdrop}>
      <section
        className="design-mode-dialog"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label="切换图片模式"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
          }
          if (event.key === "Tab") {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h2>切换到{mode === "multi-image" ? "多图模式" : "六视图模式"}？</h2>
        <p>
          当前模式的 {count}{" "}
          张图片及分配设置将从本申请移出，无法通过撤销恢复。图片编辑会先保存，电脑上的原始图片不会删除。
        </p>
        <p>通用简要说明文字会保留。如需保留当前整套材料，请取消并先导出原生文件。</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="design-mode-dialog__actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消切换
          </button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "正在保存并切换…" : "放弃当前图片并切换"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
