import { memo } from "react";
import type { CadPatentObject } from "../../../shared/drawing-markup/cad-objects";
import { pageToCad } from "../../../shared/drawing-markup/cad-state";
import { leaderPoints } from "../../../shared/drawing-markup/label-layout";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";
import { cadLabelLineweight, cadLabelScreenWidth } from "../../../shared/drawing-markup/cad-label-style";

export type Path = { d: string; fill: string; stroke: string; point: boolean; width:number };
type Run = { detailId?: string; labelId?: string; paths: Path[] };
const cache = new WeakMap<CadScene, WeakMap<CadPatentObject[], { withLabels?: Run[]; withoutLabels?: Run[] }>>();

/** Compile once per immutable scene, not per pointer frame. Keep painter order,
 * including opaque wipeouts, and use the edited body rather than its frozen source. */
export function compileCadDetailScene(scene: CadScene, objects: CadPatentObject[], includeLabels = true): Run[] {
  let entries = cache.get(scene);
  if (!entries) {
    entries = new WeakMap();
    cache.set(scene, entries);
  }
  const retained = entries.get(objects);
  const key = includeLabels ? "withLabels" : "withoutLabels";
  if (retained?.[key]) return retained[key];
  const proxies = new Set(
    objects.filter((o) => !includeLabels || o.kind !== "label")
      .flatMap((o) => [...(o.label ?? []), ...(o.frame ?? []), ...(o.source ?? [])]),
  );
  const bodies = new Map(
    objects
      .filter((o) => o.kind === "detail")
      .flatMap((o) => (o.body ?? []).map((h) => [h, o.id] as const)),
  );
  const masks = new Set(scene.primitives.filter((p) => p.kind === "mask").map((p) => p.handle));
  const labels = new Map(objects.filter(o=>o.kind==="label").flatMap(o=>(o.label??[]).map(h=>[h,o.id] as const)));
  const labelLeaders = new Set(scene.entities.filter(e=>labels.has(e.handle)&&!["Text","MText"].includes(e.type)).map(e=>e.handle));
  const runs: Run[] = [];
  for (const p of scene.primitives) {
    if (proxies.has(p.handle) || !p.points.length || (masks.has(p.handle) && p.kind !== "mask"))
      continue;
    const detailId = bodies.get(p.handle);
    const labelId = labels.get(p.handle);
    let run = runs.at(-1);
    if (!run || run.detailId !== detailId || run.labelId !== labelId) {
      run = { ...(detailId ? { detailId } : {}), ...(labelId ? {labelId} : {}), paths: [] };
      runs.push(run);
    }
    const color = p.aci7 ? "black" : `rgb(${p.color.join(" ")})`;
    const filled = p.kind === "mask" || p.kind === "triangles";
    const fill = p.kind === "mask" ? "white" : filled ? color : "none";
    const stroke = filled ? "none" : color;
    let d = "";
    if (filled) {
      for (let i = 0; i + 2 < p.points.length; i += 3) {
        const a = p.points[i]!,
          b = p.points[i + 1]!,
          c = p.points[i + 2]!;
        d += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}L${c[0]} ${c[1]}Z`;
      }
    } else if (p.kind === "point") {
      const a = p.points[0]!;
      d = `M${a[0]} ${a[1]}l0 0`;
    } else if ((p.kind === "ray" || p.kind === "infinite") && p.points.length >= 2) {
      const a = p.points[0]!,
        direction = p.points[1]!;
      const far = 1e9 + Math.hypot(a[0], a[1]) * 2;
      const start = p.kind === "ray" ? a : [a[0] - direction[0] * far, a[1] - direction[1] * far];
      d = `M${start[0]} ${start[1]}L${a[0] + direction[0] * far} ${a[1] + direction[1] * far}`;
    } else {
      d = p.points.map((v, i) => `${i ? "L" : "M"}${v[0]} ${v[1]}`).join("");
    }
    // Contiguous same-style subpaths share a DOM node without changing draw order.
    const previous = run.paths.at(-1);
    const point = p.kind === "point";
    const width=labelLeaders.has(p.handle)?cadLabelScreenWidth(p.lineweight):Math.max(0.5,p.lineweight/0.25);
    if (previous?.fill === fill && previous.stroke === stroke && previous.point === point && previous.width === width)
      previous.d += d;
    else run.paths.push({ d, fill, stroke, point, width });
  }
  entries.set(objects, { ...retained, [key]: runs });
  return runs;
}

export type CadDetailGesture = {
  before: DrawingProject;
  detailId: string;
  compiled: Run[];
  checkpointId?: string;
};

function labelGeometryCompatible(
  project: DrawingProject,
  preview: CadDetailGesture,
  id: string,
  original: Map<string, DrawingProject["annotations"][number]>,
  updated: Map<string, DrawingProject["annotations"][number]>,
  originalObjects: Map<string, CadPatentObject>,
  updatedObjects: Map<string, CadPatentObject>,
) {
  const before = original.get(id);
  const after = updated.get(id);
  const oldBinding = originalObjects.get(id);
  const newBinding = updatedObjects.get(id);
  return !!before && !!after &&
    before.text === after.text && before.fontSize === after.fontSize &&
    before.lineWidth === after.lineWidth &&
    JSON.stringify(preview.before.cad?.mapping) === JSON.stringify(project.cad?.mapping) &&
    JSON.stringify(oldBinding?.label) === JSON.stringify(newBinding?.label) &&
    JSON.stringify(oldBinding?.appearance?.label) === JSON.stringify(newBinding?.appearance?.label);
}

/** A draft can invalidate the whole project's semantic key, but only changed
 * text/height needs to fall back to SVG. Position edits keep the native glyph. */
export function visibleNativeLabelIds(project: DrawingProject, preview: CadDetailGesture): Set<string> {
  const original = new Map(preview.before.annotations.map((annotation) => [annotation.id, annotation]));
  const updated = new Map(project.annotations.map((annotation) => [annotation.id, annotation]));
  const originalObjects = new Map(preview.before.cad?.objects?.filter((object) => object.kind === "label").map((object) => [object.id, object]) ?? []);
  const updatedObjects = new Map(project.cad?.objects?.filter((object) => object.kind === "label").map((object) => [object.id, object]) ?? []);
  return new Set(preview.compiled.flatMap((run) => {
    if (!run.labelId || !run.paths.length) return [];
    return labelGeometryCompatible(project, preview, run.labelId, original, updated, originalObjects, updatedObjects)
      ? [run.labelId] : [];
  }));
}
const Paths = memo(function Paths({ paths, selected, color }: { paths: Path[]; selected: boolean; color?: string | undefined }) {
  return (
    <>
      {paths.map((path, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable compiled scene order.
          key={i}
          d={path.d}
          fill={color && path.fill !== "none" && path.fill !== "white" ? color : selected && path.fill !== "none" && path.fill !== "white" ? "#007aff" : path.fill}
          stroke={color && path.stroke !== "none" ? color : selected && path.stroke !== "none" ? "#007aff" : path.stroke}
          strokeWidth={selected || path.point ? Math.max(2,path.width) : path.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
});

/** The full cached scene temporarily replaces the saved image, so shrinking or
 * moving a detail exposes the real drawing underneath instead of a white cover. */
export function CadDetailGestureLayer({
  project,
  preview,
  labelColors,
  visibleLabelIds,
  hiddenLabelId,
  selectedDetailId,
}: {
  project: DrawingProject;
  preview: CadDetailGesture;
  labelColors?: ReadonlyMap<string,string>;
  visibleLabelIds?: ReadonlySet<string> | undefined;
  hiddenLabelId?: string | undefined;
  selectedDetailId?: string | undefined;
}) {
  const mapping = project.cad!.mapping;
  const paintableLabels = visibleLabelIds ?? visibleNativeLabelIds(project, preview);
  const originalLabels = new Map(preview.before.annotations.map((annotation) => [annotation.id, annotation]));
  const labels = new Map(project.annotations.map((annotation) => [annotation.id, annotation]));
  return (
    <g
      data-cad-detail-live-scene
      pointerEvents="none"
      transform={`matrix(${mapping.scale} 0 0 ${-mapping.scale} ${-mapping.originX * mapping.scale} ${mapping.originY * mapping.scale})`}
    >
      {preview.compiled.map((run, i) => {
        if (run.labelId && run.labelId === hiddenLabelId) return null;
        const originalLabel = run.labelId ? originalLabels.get(run.labelId) : undefined;
        const updatedLabel = run.labelId ? labels.get(run.labelId) : undefined;
        if (run.labelId && !paintableLabels.has(run.labelId)) return null;
        const original = preview.before.detailViews?.find((d) => d.id === run.detailId);
        const updated = project.detailViews?.find((d) => d.id === run.detailId);
        let transform: string | undefined;
        if (original && updated) {
          const from = pageToCad(original.center, preview.before.cad!.mapping);
          const to = pageToCad(updated.center, mapping);
          const scale =
            (updated.radius * updated.ratio) /
            mapping.scale /
            ((original.radius * original.ratio) / preview.before.cad!.mapping.scale);
          transform = `translate(${to.x} ${to.y}) scale(${scale}) translate(${-from.x} ${-from.y})`;
        }
        const labelMoved = originalLabel && updatedLabel && originalLabel !== updatedLabel && (
          originalLabel.x !== updatedLabel.x || originalLabel.y !== updatedLabel.y ||
          JSON.stringify(originalLabel.points) !== JSON.stringify(updatedLabel.points)
        );
        const from = originalLabel ? pageToCad(originalLabel, mapping) : undefined;
        const to = updatedLabel ? pageToCad(updatedLabel, mapping) : undefined;
        const deltaX = from && to ? to.x - from.x : 0;
        const deltaY = from && to ? to.y - from.y : 0;
        const leader = updatedLabel && labelMoved
          ? leaderPoints(updatedLabel).map((point, index) => {
              const cad = pageToCad(point, mapping);
              return `${index ? "L" : "M"}${cad.x} ${cad.y}`;
            }).join("") : "";
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable painter-order runs.
            key={i}
            data-cad-detail-live-body={run.detailId}
            data-cad-label={run.labelId}
            transform={transform}
          >
            {labelMoved ? (
              <>
                {leader && <path
                  d={leader}
                  fill="none"
                  stroke={labelColors?.get(run.labelId!) ?? "black"}
                  strokeWidth={cadLabelScreenWidth(cadLabelLineweight(project, updatedLabel!))}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />}
                <g data-label-glyph-shift transform={`translate(${deltaX} ${deltaY})`}>
                  <Paths paths={run.paths.filter((path) => path.fill !== "none")}
                    selected={false} color={labelColors?.get(run.labelId!)} />
                </g>
              </>
            ) : <Paths paths={run.paths} selected={!!run.detailId && run.detailId === selectedDetailId} color={run.labelId ? labelColors?.get(run.labelId) : undefined} />}
          </g>
        );
      })}
    </g>
  );
}
