import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingEditEqual } from "../../../shared/drawing-markup/performance";

/** The native edit already changed geometry. Only semantic changes need composition. */
export function canAcceptNativeSnapshot(before: DrawingProject, after = before) {
  return Boolean(
    before.cad?.unified &&
      after.cad?.unified &&
      before.projectId === after.projectId &&
      drawingEditEqual(before.cad.mapping, after.cad.mapping) &&
      drawingEditEqual(before.annotations, after.annotations) &&
      drawingEditEqual(before.detailViews, after.detailViews) &&
      drawingEditEqual(before.baseFragments, after.baseFragments) &&
      drawingEditEqual(before.cad.objects, after.cad.objects),
  );
}
