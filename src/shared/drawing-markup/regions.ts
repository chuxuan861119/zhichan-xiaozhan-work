import type { DrawingProject, DrawingRegion } from "./model.js";

// Retain source links for body editing and figure undo, but never save exploratory selections.
export const savedDrawingRegions = (regions: DrawingRegion[]) =>
  regions.filter((r) => r.figureId || r.bodyNodeId);

export const figureDrawingRegions = <T extends DrawingRegion>(
  regions: T[],
  figureIds: string[],
) => {
  return figureIds.flatMap((figureId, index) =>
    regions.filter((r) => r.figureId === figureId).map((r) => ({ ...r, name: `图${index + 1}` })),
  );
};

export const allFigureDrawingRegions = (projects: DrawingProject[], figureIds: string[]) =>
  figureDrawingRegions(
    projects.flatMap((project) =>
      project.regions.map((region) => ({ ...region, projectId: project.projectId })),
    ),
    figureIds,
  );
