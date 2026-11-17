import { applyCadMutation } from "./cad-mutation.js";
import { cadObjectHandles } from "./cad-objects.js";
import { cadToPage, pageToCad } from "./cad-state.js";
import { nextDetailLabel } from "./detail-view.js";
import type { DrawingProject } from "./model.js";
/** Paste frozen geometry and business properties, not references to subsequently edited objects. */
export function pasteCadMetadata(
  target: DrawingProject,
  source: DrawingProject,
  handles: string[],
  created: string[],
  delta: [number, number],
  before: string[],
  after: string[],
  id: () => string,
  inside?: string,
) {
  if (!source.cad || !target.cad) throw new Error("复制的图形缺少工作稿。");
  const copied = applyCadMutation(
    source,
    { command: "copy", params: { handles, delta }, result: { handles: created }, before, after },
    id,
  );
  const sourceMapping = source.cad.mapping,
    targetMapping = target.cad.mapping;
  const factor = targetMapping.scale / sourceMapping.scale;
  const point = (p: { x: number; y: number }) =>
    cadToPage(pageToCad(p, sourceMapping), targetMapping);
  const rebased = {
    ...copied,
    annotations: copied.annotations.map((a) => ({
      ...a,
      ...point(a),
      points: a.points.map(point),
      fontSize: a.fontSize * factor,
      lineWidth: a.lineWidth * factor,
    })),
    detailViews: copied.detailViews?.map((d) => ({
      ...d,
      source: point(d.source),
      center: point(d.center),
      title: point(d.title),
      marker: point(d.marker),
      radius: d.radius * factor,
      fontSize: d.fontSize * factor,
      lineWidth: d.lineWidth * factor,
      fragments: d.fragments.map((f) => ({
        ...f,
        offset: point(f.offset),
        scale: (f.scale ?? 1) * factor,
      })),
    })),
  };
  const originalIds = new Set([
    ...(source.cad.objects ?? []).map((o) => o.id),
    ...source.annotations.map((a) => a.id),
    ...(source.detailViews ?? []).map((d) => d.id),
  ]);
  const fresh = (rebased.cad!.objects ?? []).filter((o) => !originalIds.has(o.id));
  for (const object of fresh)
    for (const style of Object.values(object.appearance ?? {})) {
      if (style?.lineWidthAtEdit !== undefined) style.lineWidthAtEdit *= factor;
    }
  const freshIds = new Set(fresh.map((o) => o.id));
  const labels = (target.detailViews ?? []).map((d) => d.label);
  const details = (rebased.detailViews ?? [])
    .filter((d) => freshIds.has(d.id))
    .map((d) => {
      const label = labels.includes(d.label) ? nextDetailLabel(d.label, labels) : d.label;
      labels.push(label);
      return { ...d, label };
    });
  const objects = [
    ...(target.cad.objects ?? []).map((o) => (inside ? structuredClone(o) : o)),
    ...fresh,
  ];
  if (inside) {
    const excluded = new Set(fresh.flatMap(cadObjectHandles));
    const owner = objects.find((o) => o.id === inside);
    if (owner)
      owner.body = [
        ...new Set([...(owner.body ?? []), ...created.filter((h) => !excluded.has(h))]),
      ];
  }
  return {
    ...target,
    annotations: [...target.annotations, ...rebased.annotations.filter((a) => freshIds.has(a.id))],
    detailViews: [...(target.detailViews ?? []), ...details],
    cad: { ...target.cad, objects },
  };
}
