import { type CadPatentObject, cadObjectHandles } from "./cad-objects.js";
import { cadToPage, pageToCad } from "./cad-state.js";
import { detailMarkerAnnotation, nextDetailLabel } from "./detail-view.js";
import type { DrawingPoint, DrawingProject } from "./model.js";

export type CadMutation = {
  command: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  before: string[];
  after: string[];
  inside?: string | undefined;
};
const arr = (v: unknown) => v as [number, number];
/** Mirror native transforms in patent business properties; never silently detach a smart object. */
export function applyCadMutation(
  project: DrawingProject,
  edit: CadMutation,
  id: () => string,
): DrawingProject {
  if (!project.cad?.unified) return project;
  const p = structuredClone(project),
    mapping = project.cad.mapping;
  const selected = new Set(
    (edit.command === "stretch" ? edit.params.moveHandles as string[] : edit.params.handles as string[] | undefined) ??
      [edit.params.handle, edit.params.h1, edit.params.h2].filter(
        (h): h is string => typeof h === "string",
      ),
  );
  const present = new Set(edit.after),
    before = new Set(edit.before);
  const generated = edit.after.filter((h) => !before.has(h));
  const detached = new Set<string>(
    edit.command === "explode" &&
      edit.result?.changed === true &&
      Array.isArray(edit.result.detached)
      ? edit.result.detached.filter((id): id is string => typeof id === "string")
      : [],
  );
  if (detached.size) p.detailViews = p.detailViews?.filter((d) => !detached.has(d.id));
  const returned = (edit.result?.handles as string[] | undefined) ?? [];
  const ordered = [...selected];
  const copies = new Map<string, string>(
    ordered.map((h, i) => [h, returned[i]!] as const).filter(([, h]) => !!h),
  );
  const isCopy =
    edit.command === "copy" ||
    (edit.command === "mirror" && !edit.params.erase) ||
    ((edit.command === "scale" || edit.command === "rotate") && !!edit.params.copy);
  const transform = (page: DrawingPoint) => {
    const w = pageToCad(page, mapping);
    let x = w.x,
      y = w.y;
    if (edit.command === "move" || edit.command === "copy" || edit.command === "stretch") {
      const d = arr(edit.params.delta);
      x += d[0];
      y += d[1];
    } else if (edit.command === "rotate" || edit.command === "scale") {
      const b = arr(edit.params.base),
        a = edit.command === "rotate" ? (Number(edit.params.angle) * Math.PI) / 180 : 0,
        s = edit.command === "scale" ? Number(edit.params.factor) : 1;
      x = b[0] + ((w.x - b[0]) * Math.cos(a) - (w.y - b[1]) * Math.sin(a)) * s;
      y = b[1] + ((w.x - b[0]) * Math.sin(a) + (w.y - b[1]) * Math.cos(a)) * s;
    } else if (edit.command === "mirror") {
      const a = arr(edit.params.p1),
        b = arr(edit.params.p2),
        dx = b[0] - a[0],
        dy = b[1] - a[1],
        t = ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy);
      x = 2 * (a[0] + t * dx) - x;
      y = 2 * (a[1] + t * dy) - y;
    }
    return cadToPage({ x, y }, mapping);
  };
  const affine = ["move", "copy", "rotate", "scale", "mirror", "stretch"].includes(edit.command);
  const factor = edit.command === "scale" ? Number(edit.params.factor) : 1;
  const objects: CadPatentObject[] = [];
  for (const source of project.cad.objects ?? []) {
    if (source.kind === "detail" && detached.has(source.id)) continue;
    const all = cadObjectHandles(source),
      touched = all.some((h) => selected.has(h));
    const wholeLabel =
      source.kind === "label" && (source.label ?? []).every((h) => selected.has(h)) && touched;
    const wholeDetail =
      source.kind === "detail" &&
      [...(source.body ?? []), ...(source.frame ?? [])].every((h) => selected.has(h)) &&
      touched &&
      edit.inside !== source.id;
    const sourceOnly =
      source.kind === "detail" &&
      !!source.source?.length &&
      source.source.every((h) => selected.has(h));
    const keep = structuredClone(source);
    if (edit.command === "bridge.appearance" && touched) {
      for (const role of ["label", "frame", "source"] as const) {
        if (!source[role]?.some((h) => selected.has(h))) continue;
        const patch = { ...keep.appearance?.[role] };
        if (typeof edit.params.color === "string") patch.color = edit.params.color;
        if (typeof edit.params.linetype === "string") patch.linetype = edit.params.linetype;
        if (typeof edit.params.lineweight === "number") {
          patch.lineweight = edit.params.lineweight;
          patch.lineWidthAtEdit =
            source.kind === "label"
              ? p.annotations.find((a) => a.id === source.id)?.lineWidth
              : p.detailViews?.find((d) => d.id === source.id)?.lineWidth;
        }
        keep.appearance = { ...keep.appearance, [role]: patch };
      }
    }
    for (const role of ["label", "body", "frame", "source"] as const)
      if (keep[role]) keep[role] = keep[role]!.filter((h) => present.has(h));
    if (edit.command === "erase" && (wholeLabel || wholeDetail)) {
      p.annotations = p.annotations.filter((a) => a.id !== source.id);
      p.detailViews = p.detailViews?.filter((d) => d.id !== source.id);
      continue;
    }
    if (edit.command === "erase" && sourceOnly)
      p.detailViews = p.detailViews?.map((d) =>
        d.id === source.id ? { ...d, markerHidden: true } : d,
      );
    objects.push(keep);
    if (!affine || !(wholeLabel || wholeDetail || sourceOnly)) continue;
    const targetId = isCopy ? id() : source.id;
    if (isCopy && sourceOnly && !wholeDetail) {
      const detail = p.detailViews?.find((d) => d.id === source.id);
      if (detail) {
        const marker = detailMarkerAnnotation(detail);
        p.annotations.push({
          ...marker,
          id: targetId,
          ...transform(marker),
          points: marker.points.map(transform),
        });
        objects.push({
          id: targetId,
          kind: "label",
          ...(source.appearance?.source
            ? { appearance: { label: structuredClone(source.appearance.source) } }
            : {}),
          label: (source.source ?? []).flatMap((h) => (copies.has(h) ? [copies.get(h)!] : [])),
        });
      }
      continue;
    }
    const target = isCopy ? structuredClone(source) : keep;
    if (isCopy) {
      target.id = targetId;
      for (const role of ["label", "body", "frame", "source"] as const)
        if (target[role])
          target[role] = target[role]!.flatMap((h) => (copies.has(h) ? [copies.get(h)!] : []));
      objects.push(target);
    }
    if (wholeLabel) {
      const a = p.annotations.find((a) => a.id === source.id)!;
      const next = {
        ...a,
        id: targetId,
        ...transform(a),
        points: a.points.map(transform),
        fontSize: a.fontSize * factor,
      };
      if (isCopy) p.annotations.push(next);
      else p.annotations = p.annotations.map((a) => (a.id === source.id ? next : a));
    } else {
      const d = p.detailViews?.find((d) => d.id === source.id);
      if (!d) continue;
      const next = {
        ...d,
        id: targetId,
        ...(wholeDetail
          ? {
              center: transform(d.center),
              title: transform(d.title),
              ratio: d.ratio * (sourceOnly ? 1 : factor),
            }
          : {}),
        ...(sourceOnly
          ? {
              source: transform(d.source),
              marker: transform(d.marker),
              radius: d.radius * factor,
              ...(!wholeDetail ? { ratio: d.ratio / factor } : {}),
            }
          : {}),
      };
      if (project.cad.overlayAssetId || sourceOnly) {
        const angle =
          wholeDetail && project.cad.overlayAssetId && edit.command === "rotate"
            ? (-Number(edit.params.angle) * Math.PI) / 180
            : 0;
        const scale = sourceOnly ? factor : 1;
        next.fragments = d.fragments.map((f) => {
          const x = f.offset.x - d.source.x,
            y = f.offset.y - d.source.y;
          return {
            ...f,
            offset: {
              x: next.source.x + (x * Math.cos(angle) - y * Math.sin(angle)) * scale,
              y: next.source.y + (x * Math.sin(angle) + y * Math.cos(angle)) * scale,
            },
            scale: (f.scale ?? 1) * scale,
            rotation: (f.rotation ?? 0) + (angle * 180) / Math.PI,
          };
        });
      }
      if (isCopy) {
        next.label = nextDetailLabel(
          d.label,
          (p.detailViews ?? []).map((d) => d.label),
        );
        // Copying a detail keeps the original source reference, but gives it its own smart marker.
        p.detailViews = [...(p.detailViews ?? []), next];
      } else p.detailViews = p.detailViews?.map((d) => (d.id === source.id ? next : d));
    }
  }
  // Internal hatch picking has no selected handles. Keep a fill picked in an
  // editable detail with that detail, just like a boundary-selected fill.
  const hatchSources =
    edit.command === "hatch" && Array.isArray(edit.result?.hatches)
      ? (edit.result.hatches as { handle: string; sources: string[] }[])
      : undefined;
  if (hatchSources && !edit.inside) {
    for (const fill of hatchSources) {
      const body = objects.find(
        (o) =>
          o.kind === "detail" &&
          fill.sources.length > 0 &&
          fill.sources.every((s) => o.body?.includes(s)),
      );
      if (body) body.body = [...new Set([...(body.body ?? []), fill.handle])];
    }
    p.cad = { ...p.cad!, objects };
    return p;
  }
  const hatchPoint =
    edit.command === "hatch" && Array.isArray(edit.params.points)
      ? (edit.params.points[0] as [number, number] | undefined)
      : undefined;
  const pickedDetail =
    hatchPoint &&
    project.detailViews
      ?.slice()
      .reverse()
      .find((d) => {
        const page = cadToPage({ x: hatchPoint[0], y: hatchPoint[1] }, mapping);
        return (
          Math.hypot(page.x - d.center.x, page.y - d.center.y) < d.radius * d.ratio &&
          objects.some((o) => o.id === d.id && o.body !== undefined)
        );
      });
  const inside = edit.inside ?? (pickedDetail ? pickedDetail.id : undefined);
  if (inside) {
    const object = objects.find((o) => o.id === inside);
    if (object) object.body = [...new Set([...(object.body ?? []), ...generated])];
  } else if (!affine && generated.length) {
    const body = objects.filter((o) => o.body?.some((h) => selected.has(h)));
    if (body.length === 1) body[0]!.body = [...new Set([...(body[0]!.body ?? []), ...generated])];
  }
  p.cad = { ...p.cad!, objects };
  return p;
}

export function expandPatentSelection(project: DrawingProject, handles: string[], inside?: string) {
  const selected = new Set(handles);
  for (const object of project.cad?.objects ?? []) {
    if (object.kind === "label" && object.label?.some((h) => selected.has(h)))
      for (const h of object.label) selected.add(h);
    if (
      object.kind === "detail" &&
      object.id !== inside &&
      [...(object.body ?? []), ...(object.frame ?? [])].some((h) => selected.has(h))
    )
      for (const h of [...(object.body ?? []), ...(object.frame ?? [])]) selected.add(h);
    if (object.source?.some((h) => selected.has(h))) for (const h of object.source) selected.add(h);
  }
  return [...selected];
}
