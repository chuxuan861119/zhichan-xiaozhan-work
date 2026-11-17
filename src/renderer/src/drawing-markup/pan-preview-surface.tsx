import {
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { DrawingSize, DrawingView } from "./fixed-line-preview";

type Frame = { view: DrawingView; x: number; y: number };
type ImageCoverage = {
  image: HTMLImageElement;
  src: string | null;
  imageRect: DOMRect;
  viewportRect: DOMRect;
  x: number;
  y: number;
};
export type PanPreviewSurfaceHandle = {
  begin(): void;
  move(view: DrawingView, screenX: number, screenY: number): void;
  settle(view: DrawingView): void;
  finish(): void;
};
export type PanPreviewFrame = {
  camera: DrawingView;
  view: DrawingView;
  displayView: DrawingView;
  size: DrawingSize;
};

/** Expand in source units without changing the viewport's scale or center. */
function bufferedView(view: DrawingView, size: DrawingSize, margin: number): DrawingView {
  if (!size.width || !size.height || !margin) return view;
  const unit = Math.max(view.width / size.width, view.height / size.height);
  const width = (size.width + 2 * margin) * unit;
  const height = (size.height + 2 * margin) * unit;
  return {
    x: view.x + (view.width - width) / 2,
    y: view.y + (view.height - height) / 2,
    width,
    height,
  };
}

function screenOffset(
  camera: DrawingView,
  nextView: DrawingView,
  size: DrawingSize,
  fallbackX: number,
  fallbackY: number,
) {
  if (!size.width || !size.height || !camera.width || !camera.height)
    return { x: fallbackX, y: fallbackY };
  const scale = Math.min(size.width / camera.width, size.height / camera.height);
  return { x: (camera.x - nextView.x) * scale, y: (camera.y - nextView.y) * scale };
}

/** Compositor movement consumes prepared coverage; only its edge schedules replenishment. */
export function PanPreviewSurface({
  children,
  ref,
  view,
  displayView = view,
  imageCoverage = false,
  composited = false,
}: {
  children(frame: PanPreviewFrame): ReactNode;
  ref: Ref<PanPreviewSurfaceHandle>;
  view: DrawingView;
  displayView?: DrawingView;
  imageCoverage?: boolean;
  composited?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pending = useRef<Frame | null>(null);
  const painted = useRef<Frame | null>(null);
  const request = useRef<number | null>(null);
  const coverage = useRef<ImageCoverage | null>(null);
  const settling = useRef<DrawingView | null>(null);
  const settleOrigin = useRef<DrawingView | null>(null);
  const activePan = useRef(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const margin =
    size.width && size.height ? Math.min(192, Math.min(size.width, size.height) / 4) : 0;
  const translate = useCallback(() => {
    const latest = pending.current;
    if (host.current)
      host.current.style.transform = latest ? `translate3d(${latest.x}px, ${latest.y}px, 0)` : "";
  }, []);
  const captureCoverage = (x: number, y: number): ImageCoverage | null => {
    if (!imageCoverage || !viewport.current || !host.current) return null;
    const image = host.current.querySelector<HTMLImageElement>(
      '.drawing-vector-preview[data-render-state="ready"] img',
    );
    if (!image) return null;
    return {
      image,
      src: image.getAttribute("src"),
      imageRect: image.getBoundingClientRect(),
      viewportRect: viewport.current.getBoundingClientRect(),
      x,
      y,
    };
  };
  useImperativeHandle(ref, () => ({
    begin() {
      activePan.current = true;
      coverage.current = captureCoverage(pending.current?.x ?? 0, pending.current?.y ?? 0);
    },
    move(nextView, x, y) {
      const offset = screenOffset(painted.current?.view ?? view, nextView, size, x, y);
      pending.current = { view: nextView, ...offset };
      translate();
      const dx = offset.x;
      const dy = offset.y;
      if (imageCoverage) {
        // The current image stays visible while the next tile decodes. Do not
        // replace that request on every pointer sample; it would restart the
        // expensive SVG raster/decode pipeline continuously.
        if (host.current?.querySelector('.drawing-vector-preview[data-render-state="pending"]'))
          return;
        const image = host.current?.querySelector<HTMLImageElement>(
          '.drawing-vector-preview[data-render-state="ready"] img',
        );
        if (
          !coverage.current ||
          coverage.current.image !== image ||
          coverage.current.src !== image?.getAttribute("src")
        )
          coverage.current = captureCoverage(offset.x, offset.y);
        const available = coverage.current;
        if (available) {
          const left = available.imageRect.left + offset.x - available.x;
          const right = available.imageRect.right + offset.x - available.x;
          const top = available.imageRect.top + offset.y - available.y;
          const bottom = available.imageRect.bottom + offset.y - available.y;
          const viewport = available.viewportRect;
          const headroom = Math.min(64, margin / 2);
          if (
            left <= viewport.left - headroom &&
            right >= viewport.right + headroom &&
            top <= viewport.top - headroom &&
            bottom >= viewport.bottom + headroom
          )
            return;
        }
      }
      // Replenish before coverage is exhausted, leaving room for the next input sample.
      if (request.current !== null || Math.max(Math.abs(dx), Math.abs(dy)) < margin * 0.75) return;
      request.current = requestAnimationFrame(() => {
        request.current = null;
        if (pending.current) flushSync(() => setFrame(pending.current));
      });
    },
    settle(nextView) {
      activePan.current = false;
      if (request.current !== null) cancelAnimationFrame(request.current);
      request.current = null;
      coverage.current = null;
      settling.current = nextView;
      settleOrigin.current = view;
      // The translated image remains visible until the new view is committed.
      setFrame(null);
    },
    finish() {
      activePan.current = false;
      if (request.current !== null) cancelAnimationFrame(request.current);
      request.current = null;
      pending.current = null;
      coverage.current = null;
      settling.current = null;
      settleOrigin.current = null;
      setFrame(null);
      // A fast release can precede the first refresh, leaving state already null.
      if (!painted.current) translate();
    },
  }));
  useLayoutEffect(() => {
    painted.current = frame;
    coverage.current = null;
    if (pending.current) {
      const offset = screenOffset(
        frame?.view ?? view,
        pending.current.view,
        size,
        pending.current.x,
        pending.current.y,
      );
      pending.current = { ...pending.current, ...offset };
    }
    const target = settling.current;
    const origin = settleOrigin.current;
    if (
      target &&
      !activePan.current &&
      !frame &&
      ((view.x === target.x &&
        view.y === target.y &&
        view.width === target.width &&
        view.height === target.height) ||
        (origin &&
          (view.x !== origin.x ||
            view.y !== origin.y ||
            view.width !== origin.width ||
            view.height !== origin.height)))
    ) {
      pending.current = null;
      settling.current = null;
      settleOrigin.current = null;
    }
    translate();
  }, [frame, size, translate, view]);
  useLayoutEffect(() => {
    const measure = () => {
      const element = viewport.current;
      if (!element) return;
      const width = element.clientWidth,
        height = element.clientHeight;
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current!);
    return () => {
      observer.disconnect();
      if (request.current !== null) cancelAnimationFrame(request.current);
      pending.current = null;
    };
  }, []);
  const camera = frame?.view ?? view;
  const sourceView = useMemo(() => bufferedView(camera, size, margin), [camera, size, margin]);
  const sourceDisplayView = useMemo(
    () => bufferedView(frame?.view ?? displayView, size, margin),
    [frame, displayView, size, margin],
  );
  return (
    <div ref={viewport} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        ref={host}
        data-pan-preview-surface
        data-pan-buffer={margin}
        style={{
          position: "absolute",
          inset: -margin,
          pointerEvents: "none",
          willChange: composited || imageCoverage ? "transform" : undefined,
        }}
      >
        {children({ camera, view: sourceView, displayView: sourceDisplayView, size })}
      </div>
    </div>
  );
}
