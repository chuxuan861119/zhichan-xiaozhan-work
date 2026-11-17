import { memo, useMemo } from "react";
import { cadToPage } from "../../../shared/drawing-markup/cad-state";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import { CadAffineSurface } from "./cad-affine-surface";
import { CadPrimitiveBatch } from "./cad-primitive-highlight";
import type { CadScene } from "./cadcraft-client";

// Text, blocks and hatch retain native mirror semantics (including readable text).
export const affineMirrorType = (type: string) =>
  ["Line", "Polyline", "Arc", "Circle", "Ellipse", "Spline"].includes(type);
const Geometry = memo(function Geometry({
  scene,
  handles,
}: {
  scene: CadScene;
  handles: string[];
}) {
  const selected = new Set(handles);
  return <CadPrimitiveBatch primitives={scene.primitives.filter((p) => selected.has(p.handle))} />;
});
export function CadMirrorPreview({
  scene,
  handles,
  project,
  base,
  cursor,
}: {
  scene: CadScene;
  handles: string[];
  project: DrawingProject;
  base: DrawingPoint;
  cursor: DrawingPoint;
}) {
  const retained = useMemo(() => {
    const selected = new Set(handles);
    return scene.entities
      .filter((e) => selected.has(e.handle) && affineMirrorType(e.type))
      .map((e) => e.handle);
  }, [scene, handles]);
  if (!project.cad || !retained.length || Math.hypot(cursor.x - base.x, cursor.y - base.y) < 1e-12)
    return null;
  const m = project.cad.mapping;
  return (
    <CadAffineSurface
      enabled={!!project.cad.unified && retained.length >= 64}
      reflection={{
        base: cadToPage(base, m),
        angle: (-2 * Math.atan2(cursor.y - base.y, cursor.x - base.x) * 180) / Math.PI,
      }}
    >
      <g
        data-cad-mirror-preview
        transform={`matrix(${m.scale} 0 0 ${-m.scale} ${-m.originX * m.scale} ${m.originY * m.scale})`}
      >
        <Geometry scene={scene} handles={retained} />
      </g>
    </CadAffineSurface>
  );
}
