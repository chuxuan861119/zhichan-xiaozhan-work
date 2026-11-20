import { useRef, useState } from "react";
import { type CropRect, clampCropRect } from "./design-correction-geometry";

type Handle = "左上" | "上" | "右上" | "右" | "右下" | "下" | "左下" | "左";
const HANDLES: Handle[] = ["左上", "上", "右上", "右", "右下", "下", "左下", "左"];

export function DesignCorrectionCanvas({
  imageUrl,
  imageAlt = "当前处理图",
  imageSize,
  crop,
  onCropChange,
  onImageSizeChange,
}: {
  imageUrl: string | null;
  imageAlt?: string;
  imageSize: { width: number; height: number };
  crop: CropRect;
  onCropChange(crop: CropRect): void;
  onImageSizeChange?(size: { width: number; height: number }): void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; x: number; y: number; crop: CropRect } | null>(null);
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const fitImageToViewport = (size = imageSize) => {
    const box = viewportRef.current?.getBoundingClientRect();
    const fitted = box ? Math.min(box.width / size.width, box.height / size.height) : 1;
    setZoom(Math.min(1, fitted || 1));
    setPan({ x: 0, y: 0 });
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDrag.current) {
      setPan({
        x: panDrag.current.panX + event.clientX - panDrag.current.x,
        y: panDrag.current.panY + event.clientY - panDrag.current.y,
      });
      return;
    }
    const active = drag.current;
    if (!active) return;
    const dx = Math.round((event.clientX - active.x) / zoom);
    const dy = Math.round((event.clientY - active.y) / zoom);
    const next = { ...active.crop };
    if (active.handle.includes("左")) {
      next.left += dx;
      next.width -= dx;
    }
    if (active.handle.includes("右")) next.width += dx;
    if (active.handle.includes("上")) {
      next.top += dy;
      next.height -= dy;
    }
    if (active.handle.includes("下")) next.height += dy;
    onCropChange(clampCropRect(next, imageSize));
  };
  return (
    <div
      data-testid="design-correction-canvas"
      data-pan={`${pan.x},${pan.y}`}
      data-zoom={zoom}
      className="design-correction-canvas"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          panDrag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId))
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        drag.current = null;
        panDrag.current = null;
      }}
    >
      <div className="design-correction-canvas__toolbar" role="toolbar" aria-label="画布视图控制">
        <button type="button" onClick={() => fitImageToViewport()}>
          适应画布
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          100%
        </button>
        <button type="button" onClick={() => setZoom((current) => Math.min(4, current + 0.25))}>
          放大
        </button>
        <button type="button" onClick={() => setZoom((current) => Math.max(0.25, current - 0.25))}>
          缩小
        </button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <div
        ref={viewportRef}
        className="design-correction-canvas__viewport"
        data-scroll-surface="false"
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest(".design-correction-canvas__handle")) {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            panDrag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          }
        }}
      >
        {imageUrl ? (
          <div
            className="design-correction-canvas__stage"
            style={{
              width: imageSize.width * zoom,
              height: imageSize.height * zoom,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <img
              src={imageUrl}
              alt={imageAlt}
              onLoad={(event) => {
                const size = {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                };
                onImageSizeChange?.(size);
                fitImageToViewport(size);
              }}
            />
            <div
              className="design-correction-canvas__crop"
              style={{
                left: crop.left * zoom,
                top: crop.top * zoom,
                width: crop.width * zoom,
                height: crop.height * zoom,
              }}
            >
              {HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  aria-label={`裁剪手柄 ${handle}`}
                  className={`design-correction-canvas__handle is-${handle}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    drag.current = { handle, x: event.clientX, y: event.clientY, crop };
                  }}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (!delta) return;
                    event.preventDefault();
                    const next = { ...crop };
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      if (handle.includes("左")) {
                        next.left += delta;
                        next.width -= delta;
                      } else if (handle.includes("右")) next.width += delta;
                    } else if (handle.includes("上")) {
                      next.top += delta;
                      next.height -= delta;
                    } else if (handle.includes("下")) next.height += delta;
                    onCropChange(clampCropRect(next, imageSize));
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <p>预览加载中</p>
        )}
      </div>
    </div>
  );
}
