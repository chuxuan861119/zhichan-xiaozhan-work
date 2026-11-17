import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

/** Pointer-down only: test painted geometry locally, never queue a worker pick while dragging. */
export function hitsCadSelection(
  scene: CadScene,
  handles: readonly string[],
  point: DrawingPoint,
  tolerance: number,
): boolean {
  if (!handles.length) return false;
  const selected = new Set(handles);
  for (const entity of scene.entities)
    if (entity.locked || entity.visible === false) selected.delete(entity.handle);
  const near = (a: number[], b = a, kind = "polyline") => {
    const extended = kind === "infinite" || kind === "ray";
    const dx = b[0]! - (extended ? 0 : a[0]!), dy = b[1]! - (extended ? 0 : a[1]!);
    const length = dx * dx + dy * dy;
    const projection = length
      ? ((point.x - a[0]!) * dx + (point.y - a[1]!) * dy) / length : 0;
    const t = kind === "infinite" ? projection
      : kind === "ray" ? Math.max(0, projection) : Math.max(0, Math.min(1, projection));
    return (point.x - a[0]! - t * dx) ** 2 + (point.y - a[1]! - t * dy) ** 2 <= tolerance ** 2;
  };
  const side = (a: number[], b: number[]) =>
    (b[0]! - a[0]!) * (point.y - a[1]!) - (b[1]! - a[1]!) * (point.x - a[0]!);
  for (const primitive of scene.primitives) {
    if (!selected.has(primitive.handle) || primitive.kind === "mask") continue;
    const pts = primitive.points;
    if (primitive.kind === "triangles") {
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const a = pts[i]!, b = pts[i + 1]!, c = pts[i + 2]!;
        if (near(a,b) || near(b,c) || near(c,a)) return true;
        const ab = side(a,b), bc = side(b,c), ca = side(c,a);
        if ((ab > 0 && bc > 0 && ca > 0) || (ab < 0 && bc < 0 && ca < 0)) return true;
      }
    } else if (primitive.kind === "point" || pts.length === 1) {
      if (pts.some(p => near(p))) return true;
    } else {
      for (let i = 1; i < pts.length; i++)
        if (near(pts[i - 1]!, pts[i]!, primitive.kind)) return true;
    }
  }
  return false;
}
