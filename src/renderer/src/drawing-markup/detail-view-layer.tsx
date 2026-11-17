import { useEffect, useMemo, useState } from "react";
import { detailLeader, detailRatioText } from "../../../shared/drawing-markup/detail-view";
import type { DrawingDetailView, DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingLeaderWidth } from "../../../shared/drawing-markup/output-settings";
import { type DrawingPreviewSource, drawingPreviewSource } from "./drawing-preview-source";
import type { DrawingView } from "./fixed-line-preview";
import { FragmentedDrawingPreview } from "./fragmented-drawing-preview";
import type { TiledDrawingSource } from "./tiled-drawing-preview";

export function DetailViewImage({
  detail,
  project,
  base,
  view,
  left,
  top,
  unit,
  strokeReferenceScale,
  ghost,
  forcePreview = false,
  onError,
  sessionId,
}: {
  detail: DrawingDetailView;
  project: DrawingProject;
  base: { url: string; source: DrawingPreviewSource; tiled?: TiledDrawingSource | undefined };
  view: DrawingView;
  left: number;
  top: number;
  unit: number;
  strokeReferenceScale?: number | undefined;
  ghost?: boolean;
  forcePreview?: boolean;
  onError: (message: string) => void;
  sessionId?: string;
}) {
  const [frozen, setFrozen] = useState<{ url: string; source: DrawingPreviewSource } | null>(null);
  const frozenId = detail.cadSource?.baseAssetId;
  useEffect(() => {
    setFrozen(null);
    // The current immutable asset already owns decoded preview/cache entries.
    // Reading it again creates a new byte identity and repeats SVG decoding as
    // the user starts placing a detail. Only older frozen assets need loading.
    if (!frozenId || frozenId === project.baseAssetId || !sessionId) return;
    let cancelled = false;
    let url: string | undefined;
    void window.patentApi.assets
      .readDrawingSource(sessionId, frozenId)
      .then((result) => {
        if (!result.ok) throw new Error(result.error.message);
        if (cancelled) return;
        url = URL.createObjectURL(
          new Blob([Uint8Array.from(result.value)], { type: "image/svg+xml" }),
        );
        setFrozen({ url, source: drawingPreviewSource(result.value) });
      })
      .catch((error) => {
        if (!cancelled) onError(String(error));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [frozenId, project.baseAssetId, sessionId, onError]);
  const circleSourceView = useMemo(
    () => ({
      x: detail.source.x - detail.radius,
      y: detail.source.y - detail.radius,
      width: detail.radius * 2,
      height: detail.radius * 2,
    }),
    [detail.source, detail.radius],
  );
  const viewportSourceView = useMemo(
    () => ({
      x: detail.source.x + (view.x - detail.center.x) / detail.ratio,
      y: detail.source.y + (view.y - detail.center.y) / detail.ratio,
      width: view.width / detail.ratio,
      height: view.height / detail.ratio,
    }),
    [view, detail.source, detail.center, detail.ratio],
  );
  const radiusPixels = (detail.radius * detail.ratio) / unit;
  const viewportWidth = (view.width + 2 * (view.x - left)) / unit;
  const viewportHeight = (view.height + 2 * (view.y - top)) / unit;
  if (
    !ghost &&
    !forcePreview &&
    project.cad?.unified &&
    !project.cad.overlayAssetId &&
    project.cad.objects?.some((o) => o.id === detail.id && o.body !== undefined)
  )
    return null;
  // A small circle needs only its own source area. Once it covers the viewport,
  // the viewport itself is the smaller and safer rendering surface.
  const useCircle = (radiusPixels * 2) ** 2 <= viewportWidth * viewportHeight;
  const sourceView = useCircle ? circleSourceView : viewportSourceView;
  if (frozenId && frozenId !== project.baseAssetId && !frozen) return null;
  return (
    <div
      data-detail-image={detail.id}
      style={{
        position: "absolute",
        ...(useCircle
          ? {
              left: (detail.center.x - left) / unit - radiusPixels,
              top: (detail.center.y - top) / unit - radiusPixels,
              width: radiusPixels * 2,
              height: radiusPixels * 2,
              clipPath: "circle(50% at 50% 50%)",
            }
          : {
              inset: 0,
              clipPath: `circle(${radiusPixels}px at ${(detail.center.x - left) / unit}px ${(detail.center.y - top) / unit}px)`,
            }),
        pointerEvents: "none",
        opacity: ghost ? 0.5 : 1,
        background: "white",
      }}
    >
      <FragmentedDrawingPreview
        project={{
          ...project,
          width:
            (detail.cadSource?.backgroundSize?.[0] ?? detail.cadSource?.width ?? project.width) *
            (detail.sourceScale ?? 1),
          height:
            (detail.cadSource?.backgroundSize?.[1] ?? detail.cadSource?.height ?? project.height) *
            (detail.sourceScale ?? 1),
        }}
        fragments={detail.fragments}
        base={frozen ?? base}
        view={sourceView}
        viewportSize={
          useCircle
            ? { width: radiusPixels * 2, height: radiusPixels * 2 }
            : { width: viewportWidth, height: viewportHeight }
        }
        strokeReferenceScale={
          (strokeReferenceScale ?? 1 / unit / ((project.width * 1.08) / view.width)) /
          (detail.sourceScale ?? 1)
        }
        onError={onError}
      />
    </div>
  );
}

export function DetailViewMarks({
  detail: d,
  selected,
  part,
  unit,
  zoom,
  ghost = false,
  sourceOnly = false,
  markerColor,
  titleColor,
}: {
  detail: DrawingDetailView;
  selected: boolean;
  part: string;
  unit: number;
  zoom: number;
  ghost?: boolean;
  sourceOnly?: boolean;
  markerColor?: string;
  titleColor?: string;
}) {
  const color = selected ? "#007AFF" : "black";
  const radius = d.radius * d.ratio;
  return (
    <g data-detail={d.id} opacity={ghost ? 0.5 : 1} pointerEvents={ghost ? "none" : undefined}>
      {!d.markerHidden && (
        <g data-detail-part="marker">
          {!ghost && (
            <>
              <circle
                data-detail-source-hit
                cx={d.source.x}
                cy={d.source.y}
                r={d.radius}
                fill="none"
                stroke="transparent"
                strokeWidth={10 * unit}
              />
              <polyline
                data-detail-leader-hit
                points={detailLeader(d)
                  .map((p) => `${p.x},${p.y}`)
                  .join(" ")}
                fill="none"
                stroke="transparent"
                strokeWidth={10 * unit}
              />
            </>
          )}
          <circle
            cx={d.source.x}
            cy={d.source.y}
            r={d.radius}
            fill="none"
            stroke={color}
            strokeWidth={Math.max(d.lineWidth / zoom, (selected ? 1.5 : 1) * unit)}
          />
          <polyline
            points={detailLeader(d)
              .map((p) => `${p.x},${p.y}`)
              .join(" ")}
            fill="none"
            stroke={markerColor ?? color}
            strokeWidth={
              selected ? Math.max(drawingLeaderWidth(unit), 1.5 * unit) : drawingLeaderWidth(unit)
            }
          />
          <text
            x={d.marker.x}
            y={d.marker.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={d.fontSize}
            fontWeight={400}
            fill={markerColor ?? color}
          >
            {d.label}
          </text>
        </g>
      )}
      {!sourceOnly && (
        <>
          <circle
            data-detail-part="content"
            cx={d.center.x}
            cy={d.center.y}
            r={radius}
            fill="transparent"
            stroke={color}
            strokeWidth={Math.max(d.lineWidth / zoom, (selected ? 1.5 : 1) * unit)}
          />
          {!d.titleHidden && (
            <g
              data-detail-part="title"
              fill={titleColor ?? color}
              fontFamily="Arial, sans-serif"
              fontSize={d.fontSize}
              fontWeight={400}
              textAnchor="middle"
              dominantBaseline="central"
            >
              <rect
                x={d.title.x - d.fontSize * 2}
                y={d.title.y - d.fontSize}
                width={d.fontSize * 4}
                height={d.fontSize * 3}
                fill="transparent"
              />
              <text x={d.title.x} y={d.title.y}>
                {d.label}
              </text>
              <line
                x1={d.title.x - d.fontSize * 1.3}
                x2={d.title.x + d.fontSize * 1.3}
                y1={d.title.y + d.fontSize * 0.7}
                y2={d.title.y + d.fontSize * 0.7}
                stroke={titleColor ?? color}
                strokeWidth={Math.max(d.lineWidth / zoom, (selected ? 1.5 : 1) * unit)}
              />
              <text x={d.title.x} y={d.title.y + d.fontSize * 1.5}>
                {detailRatioText(d.ratio)}
              </text>
            </g>
          )}
          {selected && part === "content" && (
            <circle
              data-detail-part="resize"
              cx={d.center.x + radius}
              cy={d.center.y}
              r={3 * unit}
              fill="white"
              stroke="var(--drawing-grip, #c45a00)"
              strokeWidth={unit}
              style={{ cursor: "ew-resize" }}
            />
          )}
        </>
      )}
    </g>
  );
}
