import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const fitted = { x: 0, y: 0, zoom: 1 };

export function DesignImagePreviewDialog({
  label,
  resolution,
  previewUrl,
  onClose,
}: {
  label: string;
  resolution: string;
  previewUrl: string;
  onClose(): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [pose, setPose] = useState(fitted);
  const [dragging, setDragging] = useState(false);
  const reset = useCallback(() => {
    drag.current = null;
    setDragging(false);
    setPose(fitted);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement image resets the preview's zoom and drag even when the reset handler is unchanged.
  useEffect(() => {
    reset();
  }, [previewUrl, reset]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setPose((previous) => {
        const zoom = Math.min(16, Math.max(0.25, previous.zoom * Math.exp(-delta * 0.0015)));
        const ratio = zoom / previous.zoom;
        return {
          zoom,
          x: x - (x - previous.x) * ratio,
          y: y - (y - previous.y) * ratio,
        };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  return createPortal(
    <div className="design-image-preview">
      <button
        type="button"
        className="design-image-preview__backdrop"
        aria-label="关闭大图预览"
        onClick={onClose}
      />
      <section
        className="design-image-preview__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${label}大图预览`}
      >
        <header>
          <div className="design-image-preview__title">
            <strong>{label}</strong>
            <span>{resolution}</span>
          </div>
          <div className="design-image-preview__actions">
            <span title="相对于适合窗口的预览比例">{Math.round(pose.zoom * 100)}%</span>
            <button type="button" className="design-image-preview__fit" onClick={reset}>
              适合窗口
            </button>
            <button type="button" aria-label="关闭大图预览" onClick={onClose}>
              <X aria-hidden="true" size={20} />
            </button>
          </div>
        </header>
        <section
          ref={viewport}
          className="design-image-preview__viewport"
          aria-label="图片预览画布"
          data-dragging={dragging}
          onDoubleClick={reset}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const previous = drag.current;
            if (!previous || previous.id !== event.pointerId) return;
            const dx = event.clientX - previous.x,
              dy = event.clientY - previous.y;
            drag.current = {
              id: previous.id,
              x: event.clientX,
              y: event.clientY,
            };
            setPose((current) => ({
              ...current,
              x: current.x + dx,
              y: current.y + dy,
            }));
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          <img
            src={previewUrl}
            alt={`${label}大图`}
            draggable={false}
            style={{
              transform: `translate(${pose.x}px, ${pose.y}px) scale(${pose.zoom})`,
            }}
          />
        </section>
        <footer>滚轮缩放 · 按住左键拖动 · 双击适合窗口</footer>
      </section>
    </div>,
    document.body,
  );
}
