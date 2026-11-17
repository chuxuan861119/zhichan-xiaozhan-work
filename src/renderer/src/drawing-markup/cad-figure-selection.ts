import { cadToPage } from "../../../shared/drawing-markup/cad-state";
import type { DrawingProject, DrawingRegion } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

export function cadFigureSelection(
  project: DrawingProject,
  selection: {
    scene: CadScene;
    handles: string[];
    objects?: NonNullable<DrawingProject["cad"]>["objects"];
  },
): { project: DrawingProject; region: DrawingRegion } | null {
  if (!project.cad || selection.scene.partial || !selection.handles.length) return null;
  const handles = [...new Set(selection.handles)].sort();
  const selected = new Set(handles);
  const entities = selection.scene.entities.filter((entity) => selected.has(entity.handle));
  if (entities.length !== handles.length) return null;
  const objects = selection.objects ?? project.cad.objects ?? [];
  const labels = new Set(
    objects
      .filter(
        (object) =>
          object.kind === "label" && object.label?.every((handle) => selected.has(handle)),
      )
      .map((object) => object.id),
  );
  const annotations = project.annotations.filter((annotation) => labels.has(annotation.id));
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (point: { x: number; y: number }) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  };
  for (const primitive of selection.scene.primitives) {
    if (!selected.has(primitive.handle)) continue;
    for (const [x, y] of primitive.points) include(cadToPage({ x, y }, project.cad.mapping));
  }
  for (const entity of entities) {
    for (const [x, y] of entity.grips ?? []) include(cadToPage({ x, y }, project.cad.mapping));
    if (entity.textOrigin) {
      include(cadToPage({ x: entity.textOrigin[0], y: entity.textOrigin[1] }, project.cad.mapping));
      if (entity.type.toLowerCase() === "text" || entity.type.toLowerCase() === "mtext") {
        const height = entity.height && entity.height > 0 ? entity.height : 10;
        const text = entity.plainText ?? entity.text ?? "";
        const width = Math.max(
          height,
          entity.width && entity.width > 0 ? entity.width : text.length * height * 0.65,
        );
        const lines = Math.max(1, text.split(/\r?\n/u).length);
        const angle = ((entity.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle),
          sin = Math.sin(angle);
        for (const dx of [0, width])
          for (const dy of [-height * lines * 1.4, height]) {
            const x = entity.textOrigin[0] + dx * cos - dy * sin;
            const y = entity.textOrigin[1] + dx * sin + dy * cos;
            include(cadToPage({ x, y }, project.cad.mapping));
          }
      }
    }
  }
  for (const annotation of annotations) {
    const halfWidth = annotation.fontSize * Math.max(1, annotation.text.length * 0.6);
    include({ x: annotation.x - halfWidth, y: annotation.y - annotation.fontSize });
    include({ x: annotation.x + halfWidth, y: annotation.y + annotation.fontSize });
    for (const point of annotation.points) include(point);
  }
  if (!Number.isFinite(left)) return null;
  // A selected line may have zero width. The fixed physical export width would
  // otherwise turn a tall line into a >20,000 px image (especially at 600 DPI).
  // Frame narrow selections without changing the user's output-size settings.
  const minWidth = (bottom - top) / 2;
  if (right - left < minWidth) {
    const center = (left + right) / 2;
    left = center - minWidth / 2;
    right = center + minWidth / 2;
  }
  const pad = Math.max(2, Math.max(right - left, bottom - top) * 0.01);
  let hash = 2166136261;
  for (const char of handles.join(",")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const region: DrawingRegion = {
    id: `cad-selection-${(hash >>> 0).toString(16)}`,
    name: "当前选择",
    kind: "rectangle",
    points: [
      { x: left - pad, y: top - pad },
      { x: right + pad, y: top - pad },
      { x: right + pad, y: bottom + pad },
      { x: left - pad, y: bottom + pad },
    ],
    cadHandles: handles,
  };
  return {
    region,
    project: {
      ...project,
      annotations,
      detailViews: [],
      baseFragments: undefined,
      cad: { ...project.cad, overlayAssetId: undefined, backgroundSize: undefined },
    },
  };
}
