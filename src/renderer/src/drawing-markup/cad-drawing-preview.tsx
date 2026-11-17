import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type CadPreviewFrame, cadPreviewKey, sharedCadPreviewCache } from "./cad-preview-cache";
import { sharedCadSvgPreviewClient } from "./cad-svg-preview-client";
import { cadPreviewRegion } from "./drawing-zoom";
import {
  cadRasterSize,
  EDITABLE_CAD_STROKE_WIDTH,
  MAX_CAD_PREVIEW_PIXELS,
  previewGeometry,
} from "./fixed-line-preview";
import { imageUrl } from "./render";
import type { DrawingPreviewProps } from "./vector-drawing-preview";

/** Keep the source parsed once; use bounded, overlapping SVG viewports at high zoom. */
export function CadDrawingPreview(props: DrawingPreviewProps) {
  const { width, height, view } = props;
  const bytes = props.source.read();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<CadPreviewFrame | null>(null);
  const [source, setSource] = useState<{
    bytes: Uint8Array;
    width: number;
    height: number;
    supportsScreenStrokes: boolean;
  } | null>(null);
  const sourceReady = source?.bytes === bytes && source.width === width && source.height === height;
  const viewport = props.viewportSize ?? size;
  const geometry = previewGeometry({ width, height }, view, viewport.width, viewport.height, 1);
  const requestedRegion = cadPreviewRegion(
    { width, height },
    geometry.visible,
    props.strokeScale ?? geometry.scale,
    props.infinite,
  );
  const { x: regionX, y: regionY, width: regionWidth, height: regionHeight } = requestedRegion;
  const region = useMemo(
    () => ({ x: regionX, y: regionY, width: regionWidth, height: regionHeight }),
    [regionX, regionY, regionWidth, regionHeight],
  );
  const screenStrokes = sourceReady ? source.supportsScreenStrokes : false;
  const referenceScale = screenStrokes
    ? (props.strokeReferenceScale ??
      Math.min(size.width / (width * 1.08), size.height / (height * 1.08)))
    : geometry.zoom;
  const scaleKey = Number(referenceScale.toPrecision(12));
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const raster = cadRasterSize(
    region,
    screenStrokes && region.width === width && region.height === height
      ? scaleKey
      : (props.strokeScale ?? geometry.scale),
    devicePixelRatio,
    4096,
    MAX_CAD_PREVIEW_PIXELS,
  );
  // SVG non-scaling strokes use the image's CSS viewport, not its intrinsic
  // raster size. Compensate only the outer fragment/detail CSS transform.
  const screenPixelScale = screenStrokes
    ? props.viewportSize
      ? 1
      : geometry.scale / (props.strokeScale ?? geometry.scale)
    : 1;
  const request = {
    bytes,
    width,
    height,
    region,
    scaleKey,
    screenStrokes,
    screenPixelScale,
    screenStrokeWidth: props.infinite ? EDITABLE_CAD_STROKE_WIDTH : undefined,
    rasterWidth: raster.width,
    rasterHeight: raster.height,
  };
  const cached = sharedCadPreviewCache.find(request, geometry.visible);
  const selectedKey = cached?.key ?? cadPreviewKey(request);
  const ready = sourceReady && image !== null && image === cached;
  const paintedView = useRef(view);
  const sameScale =
    view.width === paintedView.current.width && view.height === paintedView.current.height;
  const displayed =
    // Keep the current source moving immediately while its sharper tile decodes.
    // A replacement source retains its last painted view until ready.
    ready || (sourceReady && image?.bytes === bytes) || sameScale
      ? geometry
      : previewGeometry({ width, height }, paintedView.current, size.width, size.height, 1);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      // Hidden document tabs report zero size; keep the usable frame until shown again.
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Source loading gates tools; zoom refreshes keep the existing frame usable.
    latest.current.onPending();
    let cancelled = false;
    void sharedCadSvgPreviewClient
      .prepare(bytes, { width, height })
      .then((prepared) => {
        if (!cancelled) setSource({ bytes, width, height, ...prepared });
      })
      .catch((error) => {
        if (!cancelled)
          latest.current.onError(error instanceof Error ? error.message : "图纸显示失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, width, height]);
  // The selected key covers all decode inputs; movement inside retained overscan
  // changes placement only and must not cancel a decode for the same cache entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Cache key represents the source, raster, region, and stroke inputs.
  useLayoutEffect(() => {
    if (
      !sourceReady ||
      !Number.isFinite(scaleKey) ||
      scaleKey <= 0 ||
      !Number.isFinite(screenPixelScale) ||
      screenPixelScale <= 0
    )
      return;
    let cancelled = false;
    let lease: ReturnType<typeof sharedCadPreviewCache.acquire> | undefined;
    const acquire = () => {
      lease = sharedCadPreviewCache.acquire(
        request,
        () => {
          const next = new Image();
          const controller = new AbortController();
          const resource = {
            url: "",
            image: next,
            encodedBytes: 0,
            cancelled: false,
            cancel: () => controller.abort(),
            done: Promise.resolve(),
          };
          resource.done = sharedCadSvgPreviewClient
            .render(
              bytes,
              { width, height },
              {
                zoom: scaleKey,
                scale: screenStrokes ? scaleKey : 1,
                width: raster.width,
                height: raster.height,
                offsetX: 0,
                offsetY: 0,
                visible: region,
              },
              screenStrokes,
              screenPixelScale,
              request.screenStrokeWidth,
              controller.signal,
            )
            .then((encoded) => {
              if (resource.cancelled)
                throw new DOMException("Preview request released", "AbortError");
              resource.encodedBytes = encoded instanceof Blob ? encoded.size : encoded.byteLength;
              resource.url =
                encoded instanceof Blob
                  ? URL.createObjectURL(encoded)
                  : imageUrl(encoded, "image/svg+xml");
              next.src = resource.url;
              return next.decode();
            });
          return resource;
        },
        cached,
      );
      if (lease.frame) setImage(lease.frame);
      if (!lease.frame)
        void lease.promise
          .then((frame) => {
            if (!cancelled) setImage(frame);
          })
          .catch((error) => {
            if (!cancelled)
              latest.current.onError(error instanceof Error ? error.message : "图纸显示失败。");
          });
    };
    // Reuse the painted tile during wheel bursts. Only coalesce refreshes when
    // that tile covers the new viewport; panning into uncovered areas stays immediate.
    const covered =
      image?.bytes === bytes &&
      image.width === width &&
      image.height === height &&
      image.region.x <= geometry.visible.x &&
      image.region.y <= geometry.visible.y &&
      image.region.x + image.region.width >= geometry.visible.x + geometry.visible.width &&
      image.region.y + image.region.height >= geometry.visible.y + geometry.visible.height;
    const timer = covered && !sameScale && !cached ? window.setTimeout(acquire, 120) : undefined;
    if (timer === undefined) acquire();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      lease?.release();
    };
  }, [sourceReady, bytes, selectedKey]);
  // A requested replacement and the currently displayed frame have independent
  // leases. Replacing a request cannot revoke a frame still committed in the DOM.
  useLayoutEffect(() => (image ? sharedCadPreviewCache.retain(image) : undefined), [image]);
  useLayoutEffect(() => {
    if (ready && image) {
      paintedView.current = view;
      latest.current.onPainted(view, true);
    }
  }, [ready, view, image]);
  const cacheStats = sharedCadPreviewCache.statistics();
  return (
    <div
      ref={host}
      className="drawing-vector-preview"
      data-render-state={ready ? "ready" : "pending"}
      data-preview-cache-hits={cacheStats.hits}
      data-preview-source-decodes={cacheStats.decodes}
      data-preview-region={region.width === width && region.height === height ? "full" : "local"}
    >
      {image && (
        <img
          src={image.url}
          alt="图纸底图"
          draggable={false}
          style={{
            position: "absolute",
            maxWidth: "none",
            background: props.transparent ? "transparent" : "white",
            width: image.region.width * displayed.scale,
            height: image.region.height * displayed.scale,
            left: displayed.offsetX + image.region.x * displayed.scale,
            top: displayed.offsetY + image.region.y * displayed.scale,
          }}
        />
      )}
    </div>
  );
}
