import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

type Primitive = CadScene["primitives"][number];
// Scene primitives are immutable. Weak keys release paths with their owning scene;
// keep only the most recent mapping rather than retaining every zoom/history state.
const paths = new WeakMap<Primitive, { key: string; points: Primitive["points"]; data: string }>();
export function macCadPath(
  primitive: Primitive,
  key: string,
  point: (p: [number, number]) => DrawingPoint,
) {
  const cached = paths.get(primitive);
  if (cached?.key === key && cached.points === primitive.points) return cached.data;
  let data = "";
  for (let i = 0; i < primitive.points.length; i++) {
    const p = point(primitive.points[i]!);
    data += `${i ? "L" : "M"}${p.x} ${p.y}`;
  }
  paths.set(primitive, { key, points: primitive.points, data });
  return data;
}
