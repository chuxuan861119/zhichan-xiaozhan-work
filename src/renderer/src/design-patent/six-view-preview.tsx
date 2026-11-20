// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The SVG is a keyboard-rotatable canvas, with separately focusable face actions.
import { type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AssetDescriptor } from "../../../shared/document/model";
import type { DesignPatent } from "../../../shared/patent/design-patent";
import {
  type OrthographicKind,
  omissionMirror,
  resolveOmissionSource,
} from "../../../shared/patent/design-view-omissions";
import { resolvedOrthographicOmissions } from "./design-omission-status";
import { DESIGN_ASSIGNMENT_LABELS } from "./import/design-assignment";
import {
  buildSixViewModel,
  projectSixViewFaces,
  SIX_VIEW_KINDS,
  type SixViewImage,
  type SixViewRotation,
} from "./six-view-model";
import {
  type DesignPixelSize,
  PreviewContext,
  ProcessedDesignSizesContext,
  RotationContext,
  resolveDesignViewPixelSize,
  useSixViewPreview,
} from "./six-view-preview-context";
import { useSixViewZoom } from "./use-six-view-zoom";
import "./six-view-preview.css";

const initialRotation = { pitch: -22, yaw: -32 };
const emptyProcessedSizes = {};

/** Transient UI state only. Never writes assets, edit checkpoints or patent data. */
export function SixViewPreviewProvider({
  design,
  assets,
  previewUrls,
  processedSizes = emptyProcessedSizes,
  children,
}: {
  design: DesignPatent;
  assets: readonly AssetDescriptor[];
  previewUrls: Record<string, string>;
  processedSizes?: Readonly<Record<string, DesignPixelSize>>;
  children: ReactNode;
}) {
  const [rotation, rotate] = useState(initialRotation);
  const [selectedViewId, select] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("design-six-view-collapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("design-six-view-collapsed", String(collapsed));
    } catch {
      /* Optional UI preference. */
    }
  }, [collapsed]);
  const model = useMemo(() => {
    const images: SixViewImage[] = [];
    for (const view of design.views) {
      if (!SIX_VIEW_KINDS.includes(view.kind as (typeof SIX_VIEW_KINDS)[number])) continue;
      const size = resolveDesignViewPixelSize(
        view,
        assets.find((asset) => asset.assetId === view.assetId),
        processedSizes,
      );
      const url = previewUrls[view.viewId];
      images.push({
        kind: view.kind as SixViewImage["kind"],
        viewId: view.viewId,
        width: size?.widthPx ?? null,
        height: size?.heightPx ?? null,
        ...(url ? { url } : {}),
      });
    }
    for (const kind of SIX_VIEW_KINDS) {
      if (images.some((image) => image.kind === kind)) continue;
      const source = resolveOmissionSource(design, kind);
      const original = source
        ? images.find((image) => image.viewId === source.viewId && !image.omitted)
        : undefined;
      const omission = design.brief.omissions.find((item) => item.viewKind === kind);
      if (original)
        images.push({
          ...original,
          kind,
          omitted: true,
          ...(omission?.reason === "symmetric"
            ? { mirror: omissionMirror(kind as OrthographicKind) }
            : {}),
        });
    }
    return buildSixViewModel(images, resolvedOrthographicOmissions(design));
  }, [design, assets, previewUrls, processedSizes]);
  const value = useMemo(
    () => ({ model, selectedViewId, select, collapsed, setCollapsed }),
    [model, selectedViewId, collapsed],
  );
  const rotationValue = useMemo(() => ({ rotation, rotate }), [rotation]);
  return (
    <PreviewContext.Provider value={design.imageMode === "multi-image" ? null : value}>
      <ProcessedDesignSizesContext.Provider value={processedSizes}>
        <RotationContext.Provider value={rotationValue}>{children}</RotationContext.Provider>
      </ProcessedDesignSizesContext.Provider>
    </PreviewContext.Provider>
  );
}

export function SixViewPreview({
  onActivate,
  activeViewId,
  fitToInspector = false,
}: {
  onActivate?(viewId: string): void;
  activeViewId?: string | null;
  fitToInspector?: boolean;
}) {
  const context = useSixViewPreview(),
    view = useContext(RotationContext);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: SixViewRotation;
    moved: boolean;
    face: string | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const clipPrefix = useId().replaceAll(":", "");
  const zoom = useSixViewZoom(fitToInspector);
  const fitModel = context?.model;
  const restingFaces = useMemo(
    () => (fitToInspector && fitModel ? projectSixViewFaces(fitModel, initialRotation) : []),
    [fitToInspector, fitModel],
  );
  const select = context?.select;
  useEffect(() => {
    if (activeViewId !== undefined) select?.(activeViewId);
  }, [activeViewId, select]);
  if (!context || !view) return null;
  const { model, selectedViewId } = context,
    { rotation, rotate } = view;
  const faces = projectSixViewFaces(model, rotation);
  let viewBox = "40 0 200 200";
  if (fitToInspector) {
    // Start with a close fit at the resting angle; allow extra room on turns
    // only if needed so a narrower angle does not continually magnify the model.
    const points = [...restingFaces, ...faces].flatMap((face) => face.points);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const left = Math.floor(Math.min(...xs)) - 5;
    const top = Math.floor(Math.min(...ys)) - 5;
    const right = Math.ceil(Math.max(...xs)) + 5;
    const bottom = Math.ceil(Math.max(...ys)) + 5;
    viewBox = `${left} ${top} ${right - left} ${bottom - top}`;
  }
  const facing = faces.reduce<(typeof faces)[number] | undefined>(
    (best, face) => (!best || face.facing > best.facing ? face : best),
    undefined,
  );
  const collapsed = !fitToInspector && !!context.collapsed;
  const zoomLabel = collapsed ? "展开三维模型" : zoom.expanded ? "恢复默认大小" : "放大三维视图";
  const activate = (image?: SixViewImage) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!image) return;
    if (selectedViewId === image.viewId) {
      context.select(null);
      return;
    }
    context.select(image.viewId);
    onActivate?.(image.viewId);
  };
  return (
    <section
      ref={zoom.root}
      className="six-view-preview"
      aria-label="六视图尺寸预览"
      data-status={model.status}
      data-expanded={zoom.expanded}
      data-collapsed={collapsed}
    >
      <div ref={zoom.surface} className="six-view-preview__surface">
        <div className="six-view-preview__caption">
          <span data-facing-label={facing?.kind}>
            {collapsed ? "三维视图" : facing ? DESIGN_ASSIGNMENT_LABELS[facing.kind] : "六视图"}
            {!collapsed && facing?.omitted ? " · 已省略" : ""}
          </span>
          {(!zoom.expanded || fitToInspector) && (
            <button
              type="button"
              aria-label={zoomLabel}
              aria-expanded={zoom.expanded}
              title={zoomLabel}
              onClick={() => (collapsed ? context.setCollapsed?.(false) : zoom.toggle())}
            >
              {zoom.expanded ? "−" : "+"}
            </button>
          )}
          {!fitToInspector && !collapsed && (
            <button
              type="button"
              aria-label="收起三维模型"
              title="收起三维模型"
              onClick={() => {
                if (zoom.expanded) zoom.toggle();
                context.setCollapsed?.(true);
              }}
            >
              −
            </button>
          )}
        </div>
        <svg
          className="six-view-preview__model"
          role="img"
          aria-label="可旋转的六视图模型"
          viewBox={viewBox}
          tabIndex={0}
          aria-hidden={collapsed || undefined}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            suppressClick.current = false;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              start: rotation,
              moved: false,
              face:
                (event.target as Element).closest("[data-face]")?.getAttribute("data-face") ?? null,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || event.pointerId !== current.id) return;
            const dx = event.clientX - current.x,
              dy = event.clientY - current.y;
            if (Math.hypot(dx, dy) < 5 && !current.moved) return;
            current.moved = true;
            rotate({
              yaw: (current.start.yaw + dx * 0.65) % 360,
              pitch: Math.max(-85, Math.min(85, current.start.pitch - dy * 0.65)),
            });
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            // Capture retargets the browser's click to the SVG. Resolve the original
            // face here, then swallow any synthetic click to prevent double activation.
            if (!drag.current.moved)
              activate(model.faces.find((face) => face.kind === drag.current?.face)?.image);
            suppressClick.current = true;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            suppressClick.current = true;
          }}
          onLostPointerCapture={() => {
            if (drag.current) {
              suppressClick.current = drag.current.moved;
              drag.current = null;
            }
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Home") {
              event.preventDefault();
              event.stopPropagation();
              rotate(initialRotation);
              return;
            }
            const delta = {
              ArrowLeft: [-10, 0],
              ArrowRight: [10, 0],
              ArrowUp: [0, 10],
              ArrowDown: [0, -10],
            }[event.key];
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            rotate({
              yaw: (rotation.yaw + delta[0]!) % 360,
              pitch: Math.max(-85, Math.min(85, rotation.pitch + delta[1]!)),
            });
          }}
        >
          {faces.map((face) => {
            const p = face.points,
              a = p[0]!,
              b = p[1]!,
              d = p[3]!;
            const selected = face.image?.viewId === selectedViewId;
            const label = DESIGN_ASSIGNMENT_LABELS[face.kind];
            const labelSize = Math.min(
              7,
              Math.abs((b[0] + p[2]![0] - a[0] - d[0]) / 2) / 4,
              Math.abs((d[1] + p[2]![1] - a[1] - b[1]) / 2) / 2,
            );
            const clipId = `${clipPrefix}-${face.kind}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG faces require a group; an HTML button cannot contain projected SVG geometry.
              <g
                key={face.kind}
                role="button"
                tabIndex={face.image ? 0 : -1}
                aria-label={`定位${label}${face.omitted ? "（已省略）" : face.image ? "" : "（未分配）"}`}
                aria-disabled={!face.image}
                aria-pressed={!!face.image && selected}
                data-face={face.kind}
                data-omitted={face.omitted}
                onClick={() => activate(face.image)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressClick.current = false;
                    activate(face.image);
                  }
                }}
              >
                <title>
                  {label}
                  {face.omitted ? (face.image ? " · 省略视图引用预览" : " · 已省略") : ""}
                  {face.image?.width && face.image?.height
                    ? ` · ${face.image.width} × ${face.image.height} px`
                    : face.omitted && !face.image
                      ? ""
                      : " · 未分配或尺寸未知"}
                </title>
                <polygon
                  points={p.map((point) => point.join(",")).join(" ")}
                  fill={face.image ? "#fff" : "#edf1f5"}
                  stroke="#c8d1da"
                  strokeWidth={1}
                  strokeLinejoin="round"
                />
                {face.image?.url && (
                  <image
                    href={face.image.url}
                    width="1"
                    height="1"
                    preserveAspectRatio="none"
                    pointerEvents="none"
                    transform={
                      face.image.mirror === "x"
                        ? `matrix(${a[0] - b[0]} ${a[1] - b[1]} ${p[2]![0] - b[0]} ${p[2]![1] - b[1]} ${b[0]} ${b[1]})`
                        : face.image.mirror === "y"
                          ? `matrix(${p[2]![0] - d[0]} ${p[2]![1] - d[1]} ${a[0] - d[0]} ${a[1] - d[1]} ${d[0]} ${d[1]})`
                          : `matrix(${b[0] - a[0]} ${b[1] - a[1]} ${d[0] - a[0]} ${d[1] - a[1]} ${a[0]} ${a[1]})`
                    }
                  />
                )}
                {face.edges.map((edge, index) => (
                  <line
                    key={["top", "right", "bottom", "left"][index]}
                    x1={p[index]![0]}
                    y1={p[index]![1]}
                    x2={p[(index + 1) % 4]![0]}
                    y2={p[(index + 1) % 4]![1]}
                    data-edge={edge}
                    stroke={
                      edge === "mismatch" ? "#dc6464" : edge === "matched" ? "#93d6b3" : "#aebbc9"
                    }
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                ))}
                {face.image && selected ? (
                  <g data-selection-marker="true" pointerEvents="none">
                    <polygon
                      points={p.map((point) => point.join(",")).join(" ")}
                      fill="#237f75"
                      fillOpacity=".12"
                      stroke="none"
                    />
                  </g>
                ) : null}
                {!face.image?.url && labelSize >= 3 && (
                  <>
                    <clipPath id={clipId}>
                      <polygon points={p.map((point) => point.join(",")).join(" ")} />
                    </clipPath>
                    <text
                      data-empty-face-label="true"
                      clipPath={`url(#${clipId})`}
                      x={p.reduce((s, v) => s + v[0], 0) / 4}
                      y={p.reduce((s, v) => s + v[1], 0) / 4}
                      textAnchor="middle"
                      fill="#728196"
                      dominantBaseline="central"
                      fontSize={labelSize}
                      pointerEvents="none"
                    >
                      {face.omitted ? "已省略" : label}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
