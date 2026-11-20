import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { UI_MOTION_DURATION_MS } from "../../app/ui-motion";

export function floatingPanelBounds(
  host: DOMRectReadOnly,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const left = Math.max(12, 12 - host.left),
    top = Math.max(12, 12 - host.top);
  return {
    left,
    top,
    right: Math.max(
      left,
      Math.min(host.width - panel.width - 12, viewport.width - host.left - panel.width - 12),
    ),
    bottom: Math.max(
      top,
      Math.min(host.height - panel.height - 12, viewport.height - host.top - panel.height - 12),
    ),
    maxHeight: Math.max(
      96,
      Math.min(host.bottom, viewport.height - 12) - Math.max(host.top + 12, 12),
    ),
  };
}
/** An editor-local, nonmodal surface. Only the surface itself intercepts input. */
export function KlecksFloatingPanel({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose(): void;
}) {
  const id = useId(),
    panel = useRef<HTMLDivElement>(null),
    drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const dragOwner = useRef<HTMLElement | null>(null);
  const endDrag = useCallback(() => {
    const held = drag.current;
    drag.current = null;
    if (dragOwner.current) {
      delete dragOwner.current.dataset.kePanelDragging;
      dragOwner.current = null;
    }
    const header = panel.current?.querySelector("header");
    if (held && header?.hasPointerCapture?.(held.id)) header.releasePointerCapture(held.id);
  }, []);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );
  const measure = useCallback(() => {
    const node = panel.current,
      owner = node?.closest<HTMLElement>(".klecks-panels");
    if (!node || !owner) return null;
    const host = owner.getBoundingClientRect(),
      rect = node.getBoundingClientRect();
    if (host.width <= 0 || host.height <= 0) return null;
    return {
      host,
      rect,
      bounds: floatingPanelBounds(host, rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    };
  }, []);
  const constrain = (left: number, top: number) => {
    const size = measure();
    if (!size) return;
    const { bounds } = size;
    const next = {
      left: Math.min(bounds.right, Math.max(bounds.left, left)),
      top: Math.min(bounds.bottom, Math.max(bounds.top, top)),
      maxHeight: bounds.maxHeight,
    };
    setPosition((old) =>
      old && old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight
        ? old
        : next,
    );
  };
  useLayoutEffect(() => {
    const node = panel.current,
      owner = node?.closest<HTMLElement>(".klecks-panels");
    if (!node || !owner) return;
    const place = () => {
      const size = measure();
      if (!size) return;
      setPosition((old) => {
        const left = Math.min(
          size.bounds.right,
          Math.max(size.bounds.left, old?.left ?? size.bounds.right),
        );
        const top = Math.min(size.bounds.bottom, Math.max(size.bounds.top, old?.top ?? 84));
        const next = { left, top, maxHeight: size.bounds.maxHeight };
        return old && old.left === left && old.top === top && old.maxHeight === next.maxHeight
          ? old
          : next;
      });
    };
    place();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(owner);
    resize?.observe(node);
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("blur", endDrag);
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      endDrag();
      resize?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("blur", endDrag);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [endDrag, measure]);
  const style: CSSProperties & { "--ke-floating-motion": string } = {
    ...(position
      ? { left: position.left, top: position.top, maxHeight: position.maxHeight }
      : { right: 12, top: 84 }),
    "--ke-floating-motion": `${UI_MOTION_DURATION_MS}ms`,
  };
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={id}
      className="klecks-floating-panel"
      style={style}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: This title bar is a focusable move handle with arrow-key support. */}
      <section
        className="klecks-floating-panel__title"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys can move the panel when its title bar is focused.
        tabIndex={0}
        aria-label={`移动${title}面板`}
        title="拖动标题栏移动面板，也可聚焦后使用方向键。"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          const size = measure();
          if (!size) return;
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          drag.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            left: size.rect.left - size.host.left,
            top: size.rect.top - size.host.top,
          };
          dragOwner.current = panel.current?.closest<HTMLElement>(".klecks-panels") ?? null;
          if (dragOwner.current) dragOwner.current.dataset.kePanelDragging = "true";
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start?.id === e.pointerId)
            constrain(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
        }}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId) {
            endDrag();
            if (e.currentTarget.hasPointerCapture?.(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [-10, 0],
            ArrowRight: [10, 0],
            ArrowUp: [0, -10],
            ArrowDown: [0, 10],
          };
          const d = delta[e.key],
            size = measure();
          if (d && size) {
            e.preventDefault();
            e.stopPropagation();
            constrain(size.rect.left - size.host.left + d[0], size.rect.top - size.host.top + d[1]);
          }
        }}
      >
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="dialog-close-button"
          aria-label={`关闭${title}`}
          title="取消并关闭（Esc）"
          onClick={onClose}
        >
          ✕
        </button>
      </section>
      <div className="klecks-floating-panel__content">{children}</div>
      <footer className="klecks-floating-panel__footer">{footer}</footer>
    </div>
  );
}
