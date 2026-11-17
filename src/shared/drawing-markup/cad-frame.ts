import type { CadCheckpoint } from "./cad-state.js";
import type { DrawingPoint, DrawingProject } from "./model.js";

/** Rebase page coordinates without moving any existing geometry relative to its labels. */
export function reframeCadProject(
  project: DrawingProject,
  cad: CadCheckpoint,
  width: number,
  height: number,
): DrawingProject {
  if (!project.cad) throw new Error("Missing CAD checkpoint");
  const dx = (project.cad.mapping.originX - cad.mapping.originX) * cad.mapping.scale;
  const dy = (cad.mapping.originY - project.cad.mapping.originY) * cad.mapping.scale;
  const point = (p: DrawingPoint) => ({ x: p.x + dx, y: p.y + dy });
  const fragments = project.baseFragments?.map((fragment) => {
    if (project.cad?.backgroundSize) return { ...fragment, offset: point(fragment.offset) };
    const angle = ((fragment.rotation ?? 0) * Math.PI) / 180,
      scale = fragment.scale ?? 1;
    const movedX = scale * (Math.cos(angle) * dx - Math.sin(angle) * dy);
    const movedY = scale * (Math.sin(angle) * dx + Math.cos(angle) * dy);
    return {
      ...fragment,
      offset: { x: fragment.offset.x + dx - movedX, y: fragment.offset.y + dy - movedY },
      clips: fragment.clips.map((polygon) => polygon.map(point)),
      holes: fragment.holes.map((polygon) => polygon.map(point)),
    };
  });
  return {
    ...project,
    cad,
    width,
    height,
    ...(fragments ? { baseFragments: fragments } : {}),
    annotations: project.annotations.map((mark) => ({
      ...mark,
      ...point(mark),
      points: mark.points.map(point),
    })),
    regions: project.regions.map((region) => ({ ...region, points: region.points.map(point) })),
    detailViews: project.detailViews?.map((detail) => ({
      ...detail,
      // Translate the frozen fragments in page space, not their local clip/asset coordinates.
      source: point(detail.source),
      fragments: detail.fragments.map((fragment) => ({
        ...fragment,
        offset: point(fragment.offset),
      })),
      center: point(detail.center),
      title: point(detail.title),
      marker: point(detail.marker),
    })),
  };
}
