import { memo, type Ref, useImperativeHandle, useState } from "react";
import { baseFragments } from "../../../shared/drawing-markup/base-fragments";
import { cadToPage } from "../../../shared/drawing-markup/cad-state";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import { type CadGripTarget, cadGripPreviewPaths, cadTextGripPreview } from "./cad-grip-preview";
import { cadGearColor } from "./cad-gear-feedback";
import { CadTextEditor } from "./cad-text-editor";
import { type CadTool, cadPreviewGeometry } from "./cad-interaction";
import type { CadTransform } from "./cad-modify-gesture";
import type { CadSnapType } from "./cad-object-snap";
import { CadPrimitiveBatch, CadPrimitiveHighlight } from "./cad-primitive-highlight";
import type { CadScene } from "./cadcraft-client";
import { cadLabelScreenWidth } from "../../../shared/drawing-markup/cad-label-style";
import { CadAffineSurface } from "./cad-affine-surface";
import { CadMirrorPreview } from "./cad-mirror-preview";
import { CadGpuScalePreview } from "./cad-gpu-scale-preview";

const primitiveBounds = new WeakMap<
  CadScene["primitives"][number],
  [number, number, number, number]
>();
const NativePrimitives = memo(function NativePrimitives({
  primitives,
}: {
  primitives: CadScene["primitives"];
}) {
  return <CadPrimitiveBatch primitives={primitives} />;
});
const CurvePrimitives = memo(function CurvePrimitives({paths, mapping}: {
  paths: DrawingPoint[][]; mapping: NonNullable<DrawingProject["cad"]>["mapping"];
}) {
  return <g data-cad-curve-preview="true" transform={`matrix(${mapping.scale} 0 0 ${-mapping.scale} ${-mapping.originX * mapping.scale} ${mapping.originY * mapping.scale})`}>
    <CadPrimitiveBatch primitives={paths.map((points,index)=>({handle:String(index),kind:"polyline",points:points.map(p=>[p.x,p.y]),color:[0,0,0],aci7:true,lineweight:0}))}/>
  </g>;
});
const AffinePrimitives = memo(function AffinePrimitives({
  scene,
  handles,
  project,
}: {
  scene: CadScene;
  handles: string[];
  project: DrawingProject;
}) {
  const selected = new Set(handles);
  const labels=new Set(project.cad?.objects?.filter(o=>o.kind==="label").flatMap(o=>o.label??[]));
  const text=new Set(scene.entities.filter(e=>["Text","MText"].includes(e.type)).map(e=>e.handle));
  return (
    <CadPrimitiveBatch primitives={scene.primitives.filter(p => selected.has(p.handle))}
      strokeWidth={p => labels.has(p.handle) ? (text.has(p.handle) ? Math.max(0.5,p.lineweight/0.25) : cadLabelScreenWidth(p.lineweight)) : undefined} />
  );
});
function boundsOf(primitive: CadScene["primitives"][number]) {
  let bounds = primitiveBounds.get(primitive);
  if (!bounds) {
    bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of primitive.points) {
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
    }
    primitiveBounds.set(primitive, bounds);
  }
  return bounds;
}

export type CadPreview = {
  clipboardProject?: DrawingProject;
  mode: CadTool;
  anchor: DrawingPoint | null;
  points: DrawingPoint[];
  cursor: DrawingPoint;
  snapped: boolean;
  snapType?: CadSnapType | undefined;
  scene: CadScene;
  handles: string[];
  fragmentId?: string | undefined;
  window?: { polygon: DrawingPoint[]; crossing: boolean } | undefined;
  gripFrom?: DrawingPoint;
  gripTarget?: CadGripTarget;
  gripHint?: string | undefined;
  rotationAngle?: number;
  gearControl?: {handle:string;index:number;point:DrawingPoint;active:boolean};
  text?: string;
  height?: number;
  curvePaths?: DrawingPoint[][];
  trimOriginal?: CadScene["primitives"];
  hideOriginal?: boolean;
  cornerGrips?: DrawingPoint[];
  cornerKind?: "fillet"|"chamfer";
  trimResult?: CadScene["primitives"];
  trimFence?: DrawingPoint[];
  trimCrossing?: boolean;
  nativePrimitives?: CadScene["primitives"];
  gapPoints?: [number, number][] | undefined;
  hatchContext?: { bounds: [number, number, number, number]; primitives: CadScene["primitives"] };
  guides?: [DrawingPoint, DrawingPoint][] | undefined;
  references?: DrawingPoint[] | undefined;
  invalid?: boolean | undefined;
  problem?: string | undefined;
  transform?: CadTransform | undefined;
};
export type CadPreviewHandle = {
  update(preview: CadPreview | null): void;
  advanceLine(anchor: DrawingPoint): void;
};

const SNAP_LABELS: Record<CadSnapType, string> = {
  endpoint: "端点",
  midpoint: "中点",
  center: "圆心/中心",
  quadrant: "象限点",
  intersection: "交点",
  nearest: "最近点",
  node: "节点",
  insertion: "插入点",
  tangent: "相切",
  "tangent-pending": "待定相切",
  perpendicular: "垂直",
  extension: "延长线",
  parallel: "平行",
  tracking: "对齐",
  polar: "方向对齐",
};
function snapMarker(type: CadSnapType, x: number, y: number, s: number): string {
  const left = x - s,
    right = x + s,
    top = y - s,
    bottom = y + s;
  switch (type) {
    case "endpoint":
      return `M${left} ${top}H${right}V${bottom}H${left}Z`;
    case "midpoint":
      return `M${x} ${top}L${right} ${bottom}H${left}Z`;
    case "center":
      return `M${left} ${y}a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0`;
    case "quadrant":
      return `M${x} ${top}L${right} ${y}L${x} ${bottom}L${left} ${y}Z`;
    case "intersection":
      return `M${left} ${top}L${right} ${bottom}M${left} ${bottom}L${right} ${top}`;
    case "nearest":
      return `M${left} ${top}H${right}L${left} ${bottom}H${right}Z`;
    case "node":
      return `M${left} ${y}a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0M${x - s * 0.7} ${y - s * 0.7}L${x + s * 0.7} ${y + s * 0.7}M${x - s * 0.7} ${y + s * 0.7}L${x + s * 0.7} ${y - s * 0.7}`;
    case "insertion":
      return `M${left} ${top}V${bottom}H${right}M${left + s * 0.6} ${top}V${bottom - s * 0.6}H${right}`;
    case "tangent":
    case "tangent-pending":
      return `M${left} ${y}a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0M${left - s * 0.4} ${bottom}H${right + s * 0.4}`;
    case "perpendicular":
      return `M${left} ${top}V${bottom}H${right}M${left} ${y}H${x}V${bottom}`;
    case "parallel":
      return `M${left} ${bottom}L${x} ${top}M${x} ${bottom}L${right} ${top}`;
    case "extension":
      return `M${left} ${y}H${right}M${x} ${top}L${right} ${y}L${x} ${bottom}`;
    case "tracking":
    case "polar":
      return `M${left} ${y}H${right}M${x} ${top}V${bottom}`;
  }
}

/** Repaint only the affected patch so the dark base cannot show through the muted preview.
 * Use native fill triangles as fills, never as connected outline polylines. */
function CadTrimPreview({
  preview,
  page,
  unit,
  id,
}: {
  preview: CadPreview;
  page: (p: DrawingPoint) => DrawingPoint;
  unit: number;
  id: string;
}) {
  const originals = preview.trimOriginal ?? [];
  const result = preview.trimResult ?? [];
  const muted = new Set(originals.map((p) => p.handle));
  const gearGrip = preview.scene.entities.some(
    (entity) => entity.gear && (entity.handle === preview.gripTarget?.handle || preview.handles.includes(entity.handle) && entity.gearMate),
  );
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const primitive of [...originals, ...result])
    for (const [x, y] of primitive.points) {
      const p = page({ x, y });
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  if (!Number.isFinite(x0)) return null;
  const rect = {
    x: x0 - unit * 2,
    y: y0 - unit * 2,
    width: x1 - x0 + unit * 4,
    height: y1 - y0 + unit * 4,
  };
  function paint(p: CadScene["primitives"][number], i: number, gray: boolean) {
    const selectedGear = gearGrip && !gray && muted.has(p.handle);
    const gear=selectedGear?preview.scene.entities.find(e=>e.handle===p.handle):undefined;
    const color = gray ? "#c4c4c4" : selectedGear ? gear?cadGearColor(gear):"#007aff" : p.aci7 ? "black" : `rgb(${p.color.join(",")})`;
    const points = p.points.map(([x, y]) => page({ x, y }));
    const attrs = { "data-trim-original": gray ? "true" : undefined, "data-cad-preview-handle": p.handle, strokeDasharray: "none" };
    const key = `${p.handle}:${i}:${gray}`;
    if (p.kind === "triangles" || p.kind === "mask") {
      let d = "";
      for (let j = 0; j + 2 < points.length; j += 3)
        d += `M${points
          .slice(j, j + 3)
          .map((v) => `${v.x},${v.y}`)
          .join(" ")}Z`;
      return (
        <path key={key} {...attrs} d={d} fill={p.kind === "mask" ? "white" : color} stroke="none" />
      );
    }
    return (
      <polyline
        key={key}
        {...attrs}
        points={(p.kind==="point"?[points[0]!,points[0]!]:points).map((v) => `${v.x},${v.y}`).join(" ")}
        strokeLinecap="round"
        fill="none"
        stroke={color}
        strokeWidth={selectedGear ? 2 : Math.max(0.5,p.lineweight/0.25)}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  return (
    <g data-trim-context="true" strokeDasharray="none">
      <defs>
        <clipPath id={id}>
          <rect {...rect} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        <rect {...rect} fill="white" stroke="none" />
        {preview.scene.primitives
          .filter((p) => {
            if (p.kind === "infinite" || p.kind === "ray") return true;
            const [left, bottom, right, top] = boundsOf(p);
            const corners = [
              page({ x: left, y: bottom }),
              page({ x: left, y: top }),
              page({ x: right, y: bottom }),
              page({ x: right, y: top }),
            ];
            return (
              Math.max(...corners.map((p) => p.x)) >= rect.x &&
              Math.min(...corners.map((p) => p.x)) <= rect.x + rect.width &&
              Math.max(...corners.map((p) => p.y)) >= rect.y &&
              Math.min(...corners.map((p) => p.y)) <= rect.y + rect.height
            );
          })
          .filter(p=>!preview.hideOriginal||!muted.has(p.handle))
          .map((p, i) => paint(p, i, muted.has(p.handle)))}
        {result.map((p, i) => paint(p, i, false))}
      </g>
    </g>
  );
}

/** Only this small overlay updates on pointer frames, never the base drawing or workspace. */
export function CadGesturePreview({
  ref,
  project,
  unit,
}: {
  ref: Ref<CadPreviewHandle>;
  project: DrawingProject;
  unit: number;
}) {
  const [preview, setPreview] = useState<CadPreview | null>(null);
  useImperativeHandle(ref, () => ({
    update: setPreview,
    advanceLine: (anchor) => setPreview((old) => (old?.mode === "line" ? { ...old, anchor } : old)),
  }));
  if (!project.cad || !preview) return null;
  const mapping = project.cad.mapping;
  const page = (p: DrawingPoint) => cadToPage(p, mapping);
  const path = (ps: DrawingPoint[]) =>
    ps
      .map((p) => {
        const q = page(p);
        return `${q.x},${q.y}`;
      })
      .join(" ");
  const shapes = cadPreviewGeometry(
    preview.mode,
    preview.anchor,
    preview.points,
    preview.cursor,
    preview.height,
  );
  if (preview.curvePaths) shapes.paths = preview.curvePaths;
  if (preview.invalid) {
    shapes.paths = [];
    delete shapes.circle;
  }
  const cursor = page(preview.cursor);
  const axisTolerance =
    Math.max(
      1,
      preview.anchor
        ? Math.hypot(preview.cursor.x - preview.anchor.x, preview.cursor.y - preview.anchor.y)
        : 0,
    ) * 1e-10;
  const snapLabel =
    preview.snapType === "polar" && preview.anchor
      ? Math.abs(preview.cursor.y - preview.anchor.y) <= axisTolerance
        ? "水平"
        : Math.abs(preview.cursor.x - preview.anchor.x) <= axisTolerance
          ? "竖直"
          : `${
              (Math.round(
                (Math.atan2(
                  preview.cursor.y - preview.anchor.y,
                  preview.cursor.x - preview.anchor.x,
                ) *
                  180) /
                  Math.PI,
              ) +
                360) %
              360
            }°`
      : SNAP_LABELS[preview.snapType ?? "node"];
  const moving = (preview.mode === "move" || preview.mode === "copy") && preview.anchor;
  const delta = moving ? { x: preview.cursor.x - moving.x, y: preview.cursor.y - moving.y } : null;
  const textGrip = preview.gripTarget
    ? cadTextGripPreview(preview.scene, preview.gripTarget, preview.cursor)
    : null;
  const gripPaths =
    preview.gripTarget && !textGrip && !preview.trimOriginal
      ? cadGripPreviewPaths(preview.scene, preview.gripTarget, preview.cursor)
      : [];
  const geometry = (
    <>
      {preview.mode === "mirror" && preview.points[0] && <CadMirrorPreview scene={preview.scene} handles={preview.handles} project={project} base={preview.points[0]} cursor={preview.cursor}/>}
      {preview.trimFence && (
        <polyline
          data-trim-fence="true"
          points={path(
            preview.trimCrossing && preview.trimFence.length >= 2
              ? (() => {
                  const a = preview.trimFence![0]!,
                    b = preview.trimFence!.at(-1)!;
                  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
                })()
              : preview.trimFence,
          )}
          stroke="#23864a"
          strokeDasharray="5 4"
          fill={preview.trimCrossing ? "#23864a18" : "none"}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {preview.trimOriginal && (
        <CadTrimPreview
          preview={preview}
          page={page}
          unit={unit}
          id={`cad-trim-${project.projectId}`}
        />
      )}
      {preview.cornerGrips?.map((p,index)=>{const q=page(p);return <circle key={`corner-${index}`} data-cad-corner-grip={index} aria-label={preview.cornerKind==="fillet"?"圆角半径":index===0?"倒角大小":`倒角侧长${index}`} cx={q.x} cy={q.y} r={5*unit} fill="white" stroke="var(--drawing-grip, #c45a00)" strokeWidth={1.5} strokeDasharray="none" vectorEffect="non-scaling-stroke"/>;})}
      {preview.hatchContext &&
        (() => {
          const [minX, minY, maxX, maxY] = preview.hatchContext.bounds;
          const a = page({ x: minX, y: maxY }),
            b = page({ x: maxX, y: minY });
          const id = `cad-hatch-context-${project.projectId}`;
          const rect = {
            x: a.x - unit,
            y: a.y - unit,
            width: b.x - a.x + 2 * unit,
            height: b.y - a.y + 2 * unit,
          };
          return (
            <g data-hatch-context="true">
              <defs>
                <clipPath id={id}>
                  <rect {...rect} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${id})`} strokeDasharray="none">
                <rect {...rect} fill="white" stroke="none" />
                {preview.hatchContext.primitives.map((primitive, index) => {
                  const color = primitive.aci7 ? "black" : `rgb(${primitive.color.join(",")})`;
                  const points = primitive.points.map(([x, y]) => page({ x, y }));
                  const list = (points: DrawingPoint[]) =>
                    points.map((p) => `${p.x},${p.y}`).join(" ");
                  const key = `${primitive.handle}:${index}`;
                  if (primitive.kind === "triangles" || primitive.kind === "mask") {
                    let d = "";
                    for (let i = 0; i + 2 < points.length; i += 3)
                      d += `M${list(points.slice(i, i + 3))}Z`;
                    return (
                      <path
                        key={key}
                        d={d}
                        fill={primitive.kind === "mask" ? "white" : color}
                        stroke="none"
                      />
                    );
                  }
                  if (primitive.kind === "point")
                    return points.map((p) => (
                      <circle
                        key={`${key}:${p.x}:${p.y}`}
                        cx={p.x}
                        cy={p.y}
                        r={unit*Math.max(0.5,primitive.lineweight/0.25)/2}
                        fill={color}
                        stroke="none"
                      />
                    ));
                  return (
                    <polyline
                      key={key}
                      points={list(points)}
                      fill="none"
                      stroke={color}
                      strokeWidth={Math.max(0.5,primitive.lineweight/0.25)}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </g>
            </g>
          );
        })()}
      <g
        data-hatch-lines={preview.mode === "hatch" ? "true" : undefined}
        strokeWidth={preview.mode === "hatch" ? 0.75 : undefined}
        strokeDasharray={preview.mode === "hatch" ? "none" : undefined}
        transform={`matrix(${mapping.scale} 0 0 ${-mapping.scale} ${-mapping.originX * mapping.scale} ${mapping.originY * mapping.scale})`}
      >
        {preview.nativePrimitives && <NativePrimitives primitives={preview.nativePrimitives} />}
        {preview.gapPoints?.map(([x,y],i) => <circle key={`gap-${i}`} data-hatch-gap="true" cx={x} cy={y} r={5 * unit / mapping.scale} fill="none" stroke="#dc2626" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
      </g>
      {preview.curvePaths && !preview.trimOriginal && !preview.invalid ? <CadAffineSurface enabled={preview.mode === "mirror"}><CurvePrimitives paths={preview.curvePaths} mapping={mapping}/></CadAffineSurface> : shapes.paths.map((ps, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Stateless temporary geometry keeps its order during one gesture.
        <polyline
          key={`preview-${i}`}
          points={path(ps)}
          stroke={preview.trimOriginal ? "black" : undefined}
          strokeWidth={preview.trimOriginal ? 0.75 : undefined}
          strokeDasharray={preview.trimOriginal ? "none" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {shapes.circle && (
        <circle
          cx={page(shapes.circle.center).x}
          cy={page(shapes.circle.center).y}
          r={shapes.circle.radius * mapping.scale}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {(delta || preview.transform) && !preview.trimOriginal && (
        <CadGpuScalePreview scene={preview.scene} handles={delta || preview.transform?.command === "scale" ? preview.handles : []} project={project} translation={delta ?? undefined}
          factor={preview.transform?.command === "scale" ? preview.transform.factor : 1} base={preview.transform?.base ?? [0,0]}>
        <CadAffineSurface enabled={!!project.cad?.unified && preview.handles.length >= 64 && preview.transform?.command !== "scale"}
          delta={delta ? { x: delta.x * mapping.scale, y: -delta.y * mapping.scale } : undefined}
          rotation={preview.transform?.command === "rotate" ? { base: page({ x: preview.transform.base[0], y: preview.transform.base[1] }), angle: -preview.transform.angle } : undefined}>
        <g
          data-cad-affine-preview
          transform={`matrix(${mapping.scale} 0 0 ${-mapping.scale} ${-mapping.originX * mapping.scale} ${mapping.originY * mapping.scale})`}
        >
          <g
            transform={
              preview.transform?.command === "scale"
                    ? `translate(${preview.transform.base.join(" ")}) scale(${preview.transform.factor}) translate(${-preview.transform.base[0]} ${-preview.transform.base[1]})`
                    : undefined
            }
          >
            <AffinePrimitives scene={preview.scene} handles={preview.handles} project={preview.clipboardProject??project} />
          </g>
        </g>
        </CadAffineSurface>
        </CadGpuScalePreview>
      )}
      {gripPaths.length > 0 && (
        <g className="cad-grip-shape">
          {gripPaths.map((points, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: The immutable preview keeps tessellation order within a gesture.
            <polyline key={index} points={path(points)} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {textGrip && (
        <g
          className="cad-grip-shape"
          transform={`rotate(${-textGrip.rotation} ${page(textGrip.at).x} ${page(textGrip.at).y})`}
        >
          <CadTextEditor
            readOnly
            value={textGrip.text}
            x={page(textGrip.at).x}
            y={page(textGrip.at).y}
            width={textGrip.width * mapping.scale}
            fontSize={(textGrip.height * mapping.scale) / 0.729}
            onChange={() => {}}
            onFinish={() => {}}
          />
        </g>
      )}
      {preview.gripFrom && gripPaths.length === 0 && !textGrip && !preview.trimOriginal && (
        <polyline
          points={path([preview.gripFrom, preview.cursor])}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {preview.mode === "text" && preview.text && (
        <text
          x={cursor.x}
          y={cursor.y}
          stroke="none"
          fill="currentColor"
          fontSize={(preview.height ?? 10) * mapping.scale}
        >
          {preview.text}
        </text>
      )}
    </>
  );
  return (
    <g
      className="cad-gesture-preview"
      data-cad-preview={preview.window ? "window" : preview.mode}
      pointerEvents="none"
    >
      {baseFragments(
        project.cad?.unified
          ? {
              width: project.width,
              height: project.height,
              baseFragments: [{ id: "original", offset: { x: 0, y: 0 }, clips: [], holes: [] }],
            }
          : project,
      )
        .filter((f) => !preview.fragmentId || f.id === preview.fragmentId)
        .map((fragment) => {
          const prefix = `cad-preview-${project.projectId}-${fragment.id}`;
          const factor = fragment.scale ?? 1;
          const size = unit / factor;
          let clipped = geometry;
          fragment.clips.forEach((clip, i) => {
            clipped = (
              <g clipPath={`url(#${prefix}-${i})`}>
                <defs>
                  <clipPath id={`${prefix}-${i}`}>
                    <polygon points={clip.map((p) => `${p.x},${p.y}`).join(" ")} />
                  </clipPath>
                </defs>
                {clipped}
              </g>
            );
          });
          if (fragment.holes.length)
            clipped = (
              <g mask={`url(#${prefix}-holes)`}>
                <defs>
                  <mask
                    id={`${prefix}-holes`}
                    maskUnits="userSpaceOnUse"
                    x={-100000}
                    y={-100000}
                    width={200000}
                    height={200000}
                  >
                    <rect x={-100000} y={-100000} width={200000} height={200000} fill="white" />
                    {fragment.holes.map((h, i) => (
                      <polygon
                        // biome-ignore lint/suspicious/noArrayIndexKey: Frozen clip geometry is unchanged during a pointer gesture.
                        key={`hole-${i}`}
                        fill="black"
                        points={h.map((p) => `${p.x},${p.y}`).join(" ")}
                      />
                    ))}
                  </mask>
                </defs>
                {clipped}
              </g>
            );
          return (
            <g
              key={fragment.id}
              transform={`translate(${fragment.offset.x} ${fragment.offset.y}) rotate(${fragment.rotation ?? 0}) scale(${factor})`}
            >
              {preview.window ? (
                <polygon
                  className={
                    preview.window?.crossing ? "cad-window-crossing" : "cad-window-contained"
                  }
                  points={path(preview.window.polygon)}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                clipped
              )}
              {preview.snapped && (
                <g
                  className={`cad-cursor is-snapped${preview.snapType === "tangent-pending" ? " is-deferred" : ""}`}
                  strokeDasharray="none"
                  data-cad-snap={preview.snapType ?? "node"}
                  aria-label={`${preview.gripHint ?? snapLabel}吸附`}
                >
                  <path
                    d={snapMarker(preview.snapType ?? "node", cursor.x, cursor.y, 7 * size)}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}
              {preview.references?.map((reference) => {
                const p = page(reference),
                  s = 3 * size;
                return (
                  <path
                    key={`reference-${reference.x}:${reference.y}`}
                    className="cad-tracking-reference"
                    d={`M${p.x - s} ${p.y}H${p.x + s}M${p.x} ${p.y - s}V${p.y + s}`}
                    vectorEffect="non-scaling-stroke"
                    data-cad-reference="true"
                  />
                );
              })}
              {preview.guides?.map((guide) => (
                <polyline
                  key={`guide-${guide[0].x}:${guide[0].y}:${guide[1].x}:${guide[1].y}`}
                  className="cad-tracking-guide"
                  points={path(guide)}
                  vectorEffect="non-scaling-stroke"
                  data-cad-guide="true"
                />
              ))}
              {(() => {
                const target=preview.gearControl??(preview.gripTarget&&preview.scene.entities.some(e=>e.handle===preview.gripTarget!.handle&&e.gear)?{...preview.gripTarget,point:preview.cursor,active:true}:undefined);
                if(!target)return null;
                const p=page(target.point),s=4*size,color="var(--drawing-grip, #c45a00)";
                return <g data-cad-gear-feedback={target.active?"active":"hover"} data-cad-gear-handle={target.handle}
                  stroke={color} fill={target.active?color:"#fff0d6"} strokeWidth={1.5}>
                  {target.index===1?<rect x={p.x-s} y={p.y-s} width={s*2} height={s*2} vectorEffect="non-scaling-stroke"/>
                    :target.index===2?<path d={`M${p.x} ${p.y-s*1.3}L${p.x+s*1.3} ${p.y}L${p.x} ${p.y+s*1.3}L${p.x-s*1.3} ${p.y}Z`} vectorEffect="non-scaling-stroke"/>
                    :<circle cx={p.x} cy={p.y} r={s} vectorEffect="non-scaling-stroke"/>}
                </g>;
              })()}
              {(preview.snapType || preview.invalid || preview.gripHint) && (
                <text
                  className="cad-snap-label"
                  x={cursor.x + 10 * size}
                  y={cursor.y - 10 * size}
                  fontSize={11 * size}
                  vectorEffect="non-scaling-stroke"
                  data-cad-snap-label="true"
                >
                  {preview.invalid ? (preview.problem ?? "此位置无法形成切线") : preview.gripHint ? `${preview.gripHint}${preview.gripTarget && preview.snapType ? ` · ${snapLabel}` : ""}` : snapLabel}
                </text>
              )}
            </g>
          );
        })}
    </g>
  );
}
