import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fragmentLocalPoint,
  fragmentWorldPoint,
} from "../../../shared/drawing-markup/base-fragments";
import { geometricBounds } from "../../../shared/drawing-markup/geometry";
import type {
  DrawingBaseFragment,
  DrawingPoint,
  DrawingProject,
} from "../../../shared/drawing-markup/model";
import type { DrawingPreviewSource } from "./drawing-preview-source";
import { type DrawingSize, type DrawingView, previewGeometry } from "./fixed-line-preview";
import type { TiledDrawingSource } from "./tiled-drawing-preview";
import { VectorDrawingPreview } from "./vector-drawing-preview";

const layer: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };
function FragmentedDrawingPreviewContent({
  project,
  fragments,
  base,
  view,
  viewportSize,
  ghost = false,
  interactiveTransform = false,
  strokeReferenceScale,
  onPainted,
  onError,
}: {
  project: DrawingProject;
  fragments: DrawingBaseFragment[];
  base: { source: DrawingPreviewSource; url: string; tiled?: TiledDrawingSource | undefined };
  view: DrawingView;
  viewportSize?: DrawingSize | undefined;
  ghost?: boolean;
  interactiveTransform?: boolean;
  strokeReferenceScale?: number | undefined;
  onPainted?: (view: DrawingView) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const clipPrefix = useId().replace(/:/g, "");
  const views = useRef(new Map<string, { key: string; placement: string; view: DrawingView }>());
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  const size = viewportSize ?? measuredSize;
  const hasViewportSize = viewportSize !== undefined;
  const callbacks = useRef({ onPainted, onError });
  callbacks.current = { onPainted, onError };
  const geometry = previewGeometry(
    project,
    view,
    Math.max(1, size.width),
    Math.max(1, size.height),
    1,
  );
  const renderFrame = useRef({ width: 0, height: 0, scale: 0 });
  // PDF line widths are baked into pixels: refresh their density on zoom instead
  // of scaling those strokes in CSS. Other sources retain compositor zoom until
  // the inner viewport needs rebasing to avoid sub-pixel layout rounding.
  if (
    size.width > 0 &&
    size.height > 0 &&
    ((project.sourceKind === "pdf" && geometry.scale !== renderFrame.current.scale) || (!hasViewportSize &&
      (renderFrame.current.width !== size.width || renderFrame.current.height !== size.height)) ||
      geometry.scale / renderFrame.current.scale > 4 ||
      geometry.scale / renderFrame.current.scale < 0.25)
  ) {
    renderFrame.current = { width: size.width, height: size.height, scale: geometry.scale };
  }
  const renderScale = renderFrame.current.scale || Math.max(1, geometry.scale);
  useEffect(() => {
    // Detail circles already know their pixel size in the current zoom frame.
    // Measuring them asynchronously would move their contents one frame late.
    if (hasViewportSize) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setMeasuredSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [hasViewportSize]);
  // Cache source coordinates independently from the fragment's placement. Rotation only
  // changes the CSS transform; unchanged fragments retain their decoded vector image.
  const entries = useMemo(
    () =>
      fragments.map((fragment) => {
        const clips = fragment.clips.map(geometricBounds);
        const x = Math.max(...clips.map((b) => b.x)),
          y = Math.max(...clips.map((b) => b.y));
        const right = Math.min(...clips.map((b) => b.x + b.width)),
          bottom = Math.min(...clips.map((b) => b.y + b.height));
        const area = {
          x,
          y,
          width: Math.max(0.001, right - x),
          height: Math.max(0.001, bottom - y),
        };
        const scale =
          Math.min(size.width / view.width, size.height / view.height) * (fragment.scale ?? 1);
        const full =
          !base.tiled &&
          project.sourceKind !== "pdf" &&
          Math.max(area.width, area.height) * scale <= 16384;
        const visible = geometricBounds(
          [
            { x: view.x, y: view.y },
            { x: view.x + view.width, y: view.y },
            { x: view.x + view.width, y: view.y + view.height },
            { x: view.x, y: view.y + view.height },
          ].map((p) => fragmentLocalPoint(fragment, p)),
        );
        const key = JSON.stringify([area, full, full ? null : view, fragment.scale ?? 1]);
        const cached = views.current.get(fragment.id);
        const placement = JSON.stringify([fragment.offset, fragment.rotation ?? 0]);
        const containsVisible =
          cached &&
          cached.view.width <= Math.max(visible.width, visible.height) * 6 &&
          cached.view.height <= Math.max(visible.width, visible.height) * 6 &&
          cached.view.x <= visible.x &&
          cached.view.y <= visible.y &&
          cached.view.x + cached.view.width >= visible.x + visible.width &&
          cached.view.y + cached.view.height >= visible.y + visible.height;
        if (
          cached &&
          ((full && cached.key === key) ||
            interactiveTransform ||
            (!full && cached.placement === placement && containsVisible &&
              (project.sourceKind !== "pdf" || cached.key === key)))
        )
          return { fragment, view: cached.view };
        const span = Math.max(visible.width, visible.height);
        const sourceView = full
          ? area
          : project.sourceKind === "pdf"
            ? visible
            : { x: visible.x - span, y: visible.y - span, width: span * 3, height: span * 3 };
        views.current.set(fragment.id, { key, placement, view: sourceView });
        return { fragment, view: sourceView };
      }),
    [fragments, view, size, project.sourceKind, base.tiled, interactiveTransform],
  );
  const [painted, setPainted] = useState(new Map<string, DrawingView>());
  const ready =
    project.sourceKind === "image" || entries.every((e) => painted.get(e.fragment.id) === e.view);
  useLayoutEffect(() => {
    if (ready && size.width && size.height) callbacks.current.onPainted?.(view);
  }, [ready, view, size]);
  return (
    <div
      ref={host}
      style={{ ...layer, opacity: ghost ? 0.5 : 1 }}
      data-base-fragments={fragments.length}
      data-base-ghost={ghost || undefined}
      data-render-state={ready ? "ready" : "drawing"}
    >
      {!ghost && (
        <div
          style={{
            position: "absolute",
            background: "white",
            left: geometry.offsetX,
            top: geometry.offsetY,
            width: project.width * geometry.scale,
            height: project.height * geometry.scale,
          }}
        />
      )}
      {entries.map(({ fragment, view: fragmentView }) => {
        const screen = (p: DrawingPoint) => {
          const q = fragmentWorldPoint(fragment, p);
          return `${geometry.offsetX + q.x * geometry.scale} ${geometry.offsetY + q.y * geometry.scale}`;
        };
        const origin = fragmentWorldPoint(fragment, fragmentView);
        // CAD SVG strokes already track screen pixels. A second CSS scale would
        // require asynchronous stroke compensation on every animation frame.
        const frameScale =
          project.sourceKind === "dwg" || project.sourceKind === "dxf"
            ? geometry.scale
            : renderScale;
        const pixelScale = frameScale * (fragment.scale ?? 1);
        const polygon = (points: DrawingPoint[]) => `M${points.map(screen).join(" L")}Z`;
        let content: ReactNode =
          project.sourceKind === "image" ? (
            <img
              src={base.url}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                background: "white",
                left: -fragmentView.x * pixelScale,
                top: -fragmentView.y * pixelScale,
                width: project.width * pixelScale,
                height: project.height * pixelScale,
                maxWidth: "none",
              }}
            />
          ) : (
            <VectorDrawingPreview
              source={base.source}
              tiled={base.tiled}
              sourceKind={project.sourceKind}
              pageNumber={project.pageNumber}
              width={project.width}
              height={project.height}
              view={fragmentView}
              viewportSize={
                project.sourceKind === "dwg" || project.sourceKind === "dxf" || hasViewportSize
                  ? {
                      width: fragmentView.width * pixelScale,
                      height: fragmentView.height * pixelScale,
                    }
                  : undefined
              }
              strokeScale={geometry.scale * (fragment.scale ?? 1)}
              strokeReferenceScale={
                strokeReferenceScale ??
                Math.min(size.width / (project.width * 1.08), size.height / (project.height * 1.08))
              }
              onPending={() => {}}
              onPainted={(next) =>
                setPainted((previous) =>
                  previous.get(fragment.id) === next
                    ? previous
                    : new Map(previous).set(fragment.id, next),
                )
              }
              onError={(message) => callbacks.current.onError(message)}
            />
          );
        content = (
          <div
            style={{
              position: "absolute",
              left: geometry.offsetX + origin.x * geometry.scale,
              top: geometry.offsetY + origin.y * geometry.scale,
              width: fragmentView.width * pixelScale,
              height: fragmentView.height * pixelScale,
              transformOrigin: "0 0",
              transform: `scale(${geometry.scale / frameScale}) rotate(${fragment.rotation ?? 0}deg)`,
            }}
          >
            {content}
          </div>
        );
        const paths = [
          ...fragment.clips.map(polygon),
          ...fragment.holes.map(
            (hole) => `M-1 -1H${size.width + 1}V${size.height + 1}H-1Z ${polygon(hole)}`,
          ),
        ];
        const clipId = `${clipPrefix}-${fragment.id}`;
        return (
          <div key={fragment.id} style={layer} data-base-fragment={fragment.id}>
            <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
              <defs>
                {paths.map((path, i) => (
                  <clipPath
                    // biome-ignore lint/suspicious/noArrayIndexKey: Clip IDs and their intersection chain are positional, with no component state.
                    key={i}
                    id={`${clipId}-${i}`}
                    clipPathUnits="userSpaceOnUse"
                    clipPath={i + 1 < paths.length ? `url(#${clipId}-${i + 1})` : undefined}
                  >
                    <path d={path} clipRule="evenodd" />
                  </clipPath>
                ))}
              </defs>
            </svg>
            <div style={{ ...layer, clipPath: paths.length ? `url(#${clipId}-0)` : undefined }}>
              {content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Annotation edits replace the project object, but leave its source geometry
// unchanged. Keep the existing decoded fragment frames during those edits.
export const FragmentedDrawingPreview = memo(
  FragmentedDrawingPreviewContent,
  (previous, next) =>
    previous.fragments === next.fragments &&
    previous.base === next.base &&
    previous.view === next.view &&
    previous.viewportSize?.width === next.viewportSize?.width &&
    previous.viewportSize?.height === next.viewportSize?.height &&
    previous.ghost === next.ghost &&
    previous.interactiveTransform === next.interactiveTransform &&
    previous.strokeReferenceScale === next.strokeReferenceScale &&
    previous.project.width === next.project.width &&
    previous.project.height === next.project.height &&
    previous.project.sourceKind === next.project.sourceKind &&
    previous.project.pageNumber === next.project.pageNumber,
);
