import type { DrawingAnnotation, DrawingProject } from "./model.js";
import { DRAWING_LEADER_WIDTH_MM } from "./output-settings.js";

/** Native lineweights are millimetres, never the legacy annotation's drawing-unit width. */
export function cadLabelLineweight(
  project: DrawingProject,
  annotation: Pick<DrawingAnnotation, "id">,
) {
  const specified = project.cad?.objects?.find((o) => o.kind === "label" && o.id === annotation.id)
    ?.appearance?.label?.lineweight;
  return Math.round((specified ?? DRAWING_LEADER_WIDTH_MM) * 100) / 100;
}
export const cadLabelScreenWidth = (millimetres: number) =>
  Math.max(0.5, (millimetres * 96) / 25.4);
export const cadLabelOutputWidth = (millimetres: number, dpi: number, unitsPerPixel: number) =>
  Math.max(1, (millimetres * dpi) / 25.4) * unitsPerPixel;
