import { Minus, Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { canvasWheelPans, canvasZoomFactor, wheelPixels } from "../shared/canvas-wheel";
import "./flowchart.css";

const MIN_SCALE = 0.001;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

type Point = Readonly<{ x: number; y: number }>;

type FlowchartImagePreviewProps = Readonly<{
  src: string | null;
  alt: string;
  busy?: boolean;
  message?: string | null;
  title?: ReactNode;
  actions?: ReactNode;
  outputWidthMm?: number | undefined;
  rotationDeg?: 0 | 90 | 180 | 270 | undefined;
  onLoad?: (() => void) | undefined;
  onError?: (() => void) | undefined;
  fitOnLoad?: boolean;
}>;

export function FlowchartImagePreview({
  src,
  alt,
  busy = false,
  message = null,
  title,
  actions,
  outputWidthMm,
  rotationDeg = 0,
  onLoad,
  onError,
  fitOnLoad = false,
}: FlowchartImagePreviewProps) {
  return (
    <FlowchartImagePreviewCanvas
      key={src ?? `${busy ? "busy" : "empty"}:${message ?? ""}`}
      src={src}
      alt={alt}
      busy={busy}
      message={message}
      title={title}
      actions={actions}
      outputWidthMm={outputWidthMm}
      rotationDeg={rotationDeg}
      onLoad={onLoad}
      onError={onError}
      fitOnLoad={fitOnLoad}
    />
  );
}

function FlowchartImagePreviewCanvas({
  src,
  alt,
  busy,
  message,
  title,
  actions,
  outputWidthMm,
  rotationDeg = 0,
  onLoad,
  onError,
  fitOnLoad = false,
}: FlowchartImagePreviewProps) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const quarterTurned = rotationDeg === 90 || rotationDeg === 270;
  const imageWidthMm =
    outputWidthMm === undefined
      ? undefined
      : outputWidthMm * (quarterTurned && imageSize ? imageSize.width / imageSize.height : 1);
  const [imageFailed, setImageFailed] = useState(false);
  const imageAvailable = Boolean(src) && !imageFailed;
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; origin: Point; start: Point } | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{
    distance: number;
    midpoint: Point;
    scale: number;
    position: Point;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef({ scale: 1, position: { x: 0, y: 0 } });
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const autoFit = useRef(fitOnLoad);
  const fitHandler = useRef<() => void>(() => {});

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    // React's delegated wheel listener is passive in Chromium.
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, []);

  const changePosition = (next: Point) => {
    viewRef.current.position = next;
    setPosition(next);
  };

  const changeScale = (next: number) => {
    const bounded = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    viewRef.current.scale = bounded;
    setScale(bounded);
  };

  const cancelGesture = () => {
    touches.current.clear();
    pinch.current = null;
    dragRef.current = null;
  };
  const finishPointer = (pointerId: number) => {
    touches.current.delete(pointerId);
    pinch.current = null;
    dragRef.current = null;
    const remaining = touches.current.entries().next().value;
    if (remaining)
      dragRef.current = {
        pointerId: remaining[0],
        start: remaining[1],
        origin: viewRef.current.position,
      };
  };

  const reset = () => {
    cancelGesture();
    autoFit.current = false;
    changeScale(1);
    changePosition({ x: 0, y: 0 });
  };

  const fitImage = (size = imageSize) => {
    const viewport = viewportRef.current;
    if (!viewport || !size) {
      reset();
      return;
    }
    const width =
      outputWidthMm === undefined
        ? quarterTurned
          ? size.height
          : size.width
        : (outputWidthMm * 96) / 25.4;
    const height = width * (quarterTurned ? size.width / size.height : size.height / size.width);
    const availableWidth = viewport.clientWidth - 48;
    const availableHeight = viewport.clientHeight - 48;
    if (availableWidth <= 0 || availableHeight <= 0) {
      reset();
      return;
    }
    changeScale(Math.min(1, availableWidth / width, availableHeight / height));
    changePosition({ x: 0, y: 0 });
    autoFit.current = true;
  };
  fitHandler.current = () => fitImage();
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (autoFit.current) fitHandler.current();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  wheelHandler.current = (event) => {
    if (!imageAvailable) return;
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current || touches.current.size) return;
    autoFit.current = false;
    const viewport = event.currentTarget as HTMLDivElement;
    const previous = viewRef.current;
    if (canvasWheelPans(event) || event.deltaY === 0) {
      changePosition({
        x: previous.position.x - wheelPixels(event.deltaX, event.deltaMode, viewport.clientWidth),
        y: previous.position.y - wheelPixels(event.deltaY, event.deltaMode, viewport.clientHeight),
      });
      return;
    }
    changeScale(
      previous.scale /
        canvasZoomFactor(
          event.deltaY,
          event.deltaMode,
          viewport.clientHeight,
          event.ctrlKey || event.metaKey,
        ),
    );
  };

  return (
    <section className="flowchart-image-preview" aria-label={`${alt}查看器`}>
      <div className="flowchart-image-preview__toolbar">
        {title ? <span className="flowchart-image-preview__title">{title}</span> : null}
        <button
          type="button"
          aria-label="缩小预览"
          disabled={!imageAvailable || scale <= MIN_SCALE}
          onClick={() => {
            autoFit.current = false;
            changeScale(scale - SCALE_STEP);
          }}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <output aria-label="预览缩放比例">{Math.round(scale * 1000) / 10}%</output>
        <button
          type="button"
          aria-label="放大预览"
          disabled={!imageAvailable || scale >= MAX_SCALE}
          onClick={() => {
            autoFit.current = false;
            changeScale(scale + SCALE_STEP);
          }}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="重置预览"
          disabled={!imageAvailable}
          onClick={() => fitImage()}
        >
          适应窗口
        </button>
        <button
          type="button"
          aria-label="实际尺寸（100%）"
          disabled={!imageAvailable}
          onClick={reset}
        >
          实际尺寸
        </button>
        {actions}
      </div>
      <div
        ref={viewportRef}
        className={`flowchart-image-preview__viewport${imageAvailable ? " is-pannable" : ""}`}
        data-testid="flowchart-image-preview-viewport"
        onPointerDown={(event) => {
          if (!imageAvailable || event.button !== 0) return;
          if (event.pointerType === "touch") {
            if (touches.current.size >= 2) return;
            touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          } else if (touches.current.size) return;
          autoFit.current = false;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          if (touches.current.size === 2) {
            const [a, b] = [...touches.current.values()];
            if (!a || !b) return;
            pinch.current = {
              distance: Math.hypot(b.x - a.x, b.y - a.y),
              midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              scale: viewRef.current.scale,
              position: viewRef.current.position,
            };
            dragRef.current = null;
            return;
          }
          dragRef.current = {
            pointerId: event.pointerId,
            origin: viewRef.current.position,
            start: { x: event.clientX, y: event.clientY },
          };
        }}
        onPointerMove={(event) => {
          if (touches.current.has(event.pointerId)) {
            touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const start = pinch.current;
            if (start && touches.current.size === 2) {
              const [a, b] = [...touches.current.values()];
              if (!a || !b) return;
              // Coincident contacts cannot establish a stable scale baseline.
              if (start.distance < 1) return;
              const nextScale = Math.min(
                MAX_SCALE,
                Math.max(
                  MIN_SCALE,
                  (start.scale * Math.hypot(b.x - a.x, b.y - a.y)) / start.distance,
                ),
              );
              const ratio = nextScale / start.scale;
              const bounds = event.currentTarget.getBoundingClientRect();
              const center = {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
              };
              changeScale(nextScale);
              changePosition({
                x:
                  (a.x + b.x) / 2 -
                  center.x -
                  (start.midpoint.x - center.x - start.position.x) * ratio,
                y:
                  (a.y + b.y) / 2 -
                  center.y -
                  (start.midpoint.y - center.y - start.position.y) * ratio,
              });
              return;
            }
          }
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          changePosition({
            x: drag.origin.x + event.clientX - drag.start.x,
            y: drag.origin.y + event.clientY - drag.start.y,
          });
        }}
        onPointerUp={(event) => {
          if (
            touches.current.has(event.pointerId) ||
            dragRef.current?.pointerId === event.pointerId
          )
            finishPointer(event.pointerId);
        }}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={(event) => {
          if (
            touches.current.has(event.pointerId) ||
            dragRef.current?.pointerId === event.pointerId
          )
            cancelGesture();
        }}
      >
        {src && !imageFailed ? (
          <img
            className="flowchart-image-preview__image is-actual-size"
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(event) => {
              const size = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              setImageSize(size);
              if (fitOnLoad) fitImage(size);
              onLoad?.();
            }}
            onError={() => {
              cancelGesture();
              setImageFailed(true);
              onError?.();
            }}
            style={{
              width: imageWidthMm === undefined ? undefined : `${imageWidthMm}mm`,
              transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotationDeg}deg)`,
            }}
          />
        ) : imageFailed ? (
          <div className="flowchart-image-preview__error" role="alert">
            <span>图片预览加载失败。</span>
            <button
              type="button"
              aria-label="重试加载预览"
              onClick={() => {
                reset();
                setImageFailed(false);
              }}
            >
              重试
            </button>
          </div>
        ) : (
          <span className="flowchart-image-preview__message" role="status">
            {busy ? "正在生成预览…" : (message ?? "暂无预览")}
          </span>
        )}
      </div>
    </section>
  );
}
