import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { CadDrawingPreview } from "./cad-drawing-preview";
import type { DrawingPreviewSource } from "./drawing-preview-source";
import { type DrawingView, fixCanvasStrokes } from "./fixed-line-preview";
import { PdfPreviewCache, type PreviewSession } from "./pdf-preview-cache";
import { pdfDocument } from "./render";
import { TiledDrawingPreview, type TiledDrawingSource } from "./tiled-drawing-preview";

async function openSession(
  bytes: Uint8Array,
  project: Pick<DrawingProject, "sourceKind" | "pageNumber" | "width" | "height">,
): Promise<PreviewSession> {
  let zoom = 1;
  // PDF.js also draws transparency groups and patterns into factory-created canvases.
  class CanvasFactory {
    create(width: number, height: number) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      fixCanvasStrokes(context, () => zoom);
      return { canvas, context };
    }
    reset(entry: { canvas: HTMLCanvasElement }, width: number, height: number) {
      entry.canvas.width = width;
      entry.canvas.height = height;
    }
    destroy(entry: { canvas: HTMLCanvasElement | null; context: CanvasRenderingContext2D | null }) {
      if (entry.canvas) entry.canvas.width = entry.canvas.height = 0;
      entry.canvas = null;
      entry.context = null;
    }
  }
  const { task, doc } = await pdfDocument(bytes, CanvasFactory);
  try {
    const page = await doc.getPage(project.pageNumber),
      original = page.getViewport({ scale: 1 });
    return {
      render(canvas, g) {
        zoom = g.zoom;
        const ctx = canvas.getContext("2d")!;
        fixCanvasStrokes(ctx, () => zoom);
        return page.render({
          canvas: null,
          canvasContext: ctx,
          viewport: page.getViewport({ scale: (g.scale * project.width) / original.width }),
          transform: [1, 0, 0, 1, g.offsetX, g.offsetY],
        });
      },
      close: () => task.destroy(),
    };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export type DrawingPreviewProps = {
  source: DrawingPreviewSource;
  tiled?: TiledDrawingSource | undefined;
  sourceKind: "dwg" | "dxf" | "pdf";
  pageNumber: number;
  width: number;
  height: number;
  view: DrawingView;
  viewportSize?: { width: number; height: number } | undefined;
  strokeScale?: number;
  strokeReferenceScale?: number | undefined;
  transparent?: boolean;
  infinite?: boolean;
  onPainted(view: DrawingView, liveViewport?: boolean): void;
  onPending(): void;
  onError(message: string): void;
};

export function VectorDrawingPreview(props: DrawingPreviewProps) {
  if (props.tiled) return <TiledDrawingPreview {...props} tiled={props.tiled} />;
  return props.sourceKind !== "pdf" ? (
    <CadDrawingPreview {...props} />
  ) : (
    <PdfDrawingPreview {...props} />
  );
}

function PdfDrawingPreview(props: DrawingPreviewProps) {
  const { sourceKind, pageNumber, width, height, view } = props;
  const bytes = props.source.read();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef<PdfPreviewCache | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  const size = props.viewportSize ?? measuredSize;
  const hasViewportSize = props.viewportSize !== undefined;
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    if (hasViewportSize) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setMeasuredSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    // The bitmap has an exact pixel-to-CSS scale; measure its containing viewport
    // so rounding that bitmap cannot feed back into layout or freeze resizing.
    observer.observe(canvasRef.current!.parentElement!);
    return () => observer.disconnect();
  }, [hasViewportSize]);
  useEffect(() => {
    let cancelled = false;
    latest.current.onPending();
    setPending(true);
    setSession(null);
    const opened = openSession(bytes, { sourceKind, pageNumber, width, height });
    void opened
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((error) => {
        if (!cancelled)
          latest.current.onError(error instanceof Error ? error.message : "图纸显示失败。");
      });
    return () => {
      cancelled = true;
      cache.current?.dispose();
      void opened.then((s) => s.close()).catch(() => {});
    };
  }, [bytes, sourceKind, pageNumber, width, height]);
  useLayoutEffect(() => {
    if (!session) return;
    const next = new PdfPreviewCache(
      canvasRef.current!,
      session,
      { width, height },
      { width: 0, height: 0 },
      (painted, ready) => {
        setPending(!ready);
        latest.current.onPainted(painted);
      },
      (message) => latest.current.onError(message),
      props.strokeReferenceScale,
    );
    cache.current = next;
    return () => {
      next.dispose();
      if (cache.current === next) cache.current = null;
    };
  }, [session, width, height, props.strokeReferenceScale]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement cache must receive the current view and size, including when its session or stroke reference changes.
  useLayoutEffect(() => {
    cache.current?.update(view, { width: size.width, height: size.height });
  }, [session, width, height, props.strokeReferenceScale, view, size.width, size.height]);
  return (
    <canvas
      ref={canvasRef}
      className="drawing-vector-preview"
      data-render-state={pending ? "pending" : "ready"}
      role="img"
      aria-label="图纸底图"
    />
  );
}
