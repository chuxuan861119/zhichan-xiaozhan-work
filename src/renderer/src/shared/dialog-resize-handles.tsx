import { useRef } from "react";
import type { DialogDragResult } from "./use-dialog-drag";
import "./dialog-resize-handles.css";
export function DialogResizeHandles({
  drag,
  setSize,
  setResizing,
  label,
  minTop = 0,
}: {
  drag: DialogDragResult<HTMLDivElement>;
  setSize: (size: { width: number; height: number }) => void;
  setResizing: (value: boolean) => void;
  label: string;
  minTop?: number;
}) {
  const resizeStart = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    top: number;
  } | null>(null);
  return (
    <>
      {" "}
      {(["e", "w", "s", "n", "se", "sw", "ne", "nw"] as const).map((edge) => (
        <button
          key={edge}
          type="button"
          tabIndex={-1}
          aria-label={
            edge === "e" || edge === "w"
              ? `调整${label}宽度`
              : edge === "s" || edge === "n"
                ? `调整${label}高度`
                : `调整${label}大小`
          }
          className={`dialog-resize dialog-resize--${edge}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const rect = drag.surfaceRef.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            setResizing(true);
            resizeStart.current = {
              x: event.clientX,
              y: event.clientY,
              width: rect.width,
              height: rect.height,
              left: rect.left,
              top: rect.top,
            };
            // Fix the left edge when the default window is positioned from the right.
            drag.setPosition({ left: rect.left, top: rect.top });
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start) return;
            if ((event.buttons & 1) === 0) {
              resizeStart.current = null;
              setResizing(false);
              return;
            }
            const west = edge.includes("w");
            const north = edge.includes("n");
            const maxWidth = west ? start.left + start.width : window.innerWidth - start.left;
            const maxHeight = north
              ? start.top + start.height - minTop
              : window.innerHeight - start.top;
            const width =
              edge === "s" || edge === "n"
                ? start.width
                : Math.min(
                    maxWidth,
                    Math.max(
                      Math.min(480, maxWidth),
                      start.width + (west ? -1 : 1) * (event.clientX - start.x),
                    ),
                  );
            const height =
              edge === "e" || edge === "w"
                ? start.height
                : Math.min(
                    maxHeight,
                    Math.max(
                      Math.min(360, maxHeight),
                      start.height + (north ? -1 : 1) * (event.clientY - start.y),
                    ),
                  );
            setSize({ width, height });
            drag.setPosition({
              left: west ? start.left + start.width - width : start.left,
              top: north ? start.top + start.height - height : start.top,
            });
          }}
          onPointerUp={() => {
            resizeStart.current = null;
            setResizing(false);
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
            setResizing(false);
          }}
          onLostPointerCapture={() => {
            resizeStart.current = null;
            setResizing(false);
          }}
        />
      ))}
    </>
  );
}
