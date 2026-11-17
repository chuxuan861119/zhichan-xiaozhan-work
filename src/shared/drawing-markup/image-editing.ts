import { rotateBase, rotatePoint } from "./base-fragments.js";
import { selectedDetailParts } from "./detail-selection.js";
import { bounds, pointInside } from "./geometry.js";
import { type DrawingProject, type DrawingRegion, DrawingProjectSchema } from "./model.js";

export function isImageDrawing(project?: Pick<DrawingProject, "sourceKind"> | null) {
  return project?.sourceKind === "image" || project?.sourceKind === "pdf";
}

/** A page shares the original PDF resource, never another page's edited overlay. */
export function imagePdfPage(
  project: DrawingProject,
  page: number,
  width: number,
  height: number,
  id: string,
): DrawingProject {
  return DrawingProjectSchema.parse({
    ...project,
    projectId: id,
    baseAssetId: project.sourceAssetId,
    cad: undefined,
    name: `${project.name.replace(/ · 第\d+页$/u, "")} · 第${page}页`.slice(0, 200),
    pageNumber: page,
    width,
    height,
    annotations: [],
    baseFragments: undefined,
    detailViews: undefined,
    regions: [],
    warnings: [],
    revision: 0,
  });
}

/** Rotate a pixel selection non-destructively; patent text remains upright. */
export function rotateImageSelection(
  project: DrawingProject,
  region: DrawingRegion,
  angle: number,
  prefix: string,
): DrawingProject {
  if (!isImageDrawing(project) || !Number.isFinite(angle))
    throw new Error("请选择有效的图片选区和旋转角度。");
  if (angle % 360 === 0) return project;
  const box = bounds(region.points);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const transform = (point: { x: number; y: number }) => rotatePoint(point, center, angle % 360);
  return DrawingProjectSchema.parse({
    ...project,
    baseFragments: rotateBase(project, region.points, center, angle % 360, prefix),
    annotations: project.annotations.map((a) =>
      pointInside(a, region.points)
        ? { ...a, ...transform(a), points: a.points.map(transform) }
        : a,
    ),
    detailViews: project.detailViews?.map((d) => {
      const parts = selectedDetailParts(d, region.points);
      return {
        ...d,
        ...(parts.has(`detail-content:${d.id}`) ? { center: transform(d.center) } : {}),
        ...(parts.has(`detail-title:${d.id}`) ? { title: transform(d.title) } : {}),
        ...(parts.has(`detail-marker:${d.id}`) ? { marker: transform(d.marker) } : {}),
        ...(parts.has(`detail-source:${d.id}`)
          ? {
              source: transform(d.source),
              fragments: d.fragments.map((f) => ({
                ...f,
                offset: transform(f.offset),
                rotation: ((f.rotation ?? 0) + angle) % 360,
              })),
            }
          : {}),
      };
    }),
    regions: project.regions.map((r) =>
      r.id === region.id ? { ...r, kind: "lasso", points: r.points.map(transform) } : r,
    ),
  });
}
