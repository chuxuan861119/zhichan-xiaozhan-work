import { memo, type ReactNode } from "react";
import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";
import { isMacPlatform } from "../../../shared/platform";
import { macCadPath } from "./mac-cad-path-cache";

const identityPoint = ([x, y]: [number, number]) => ({ x, y });

/** Bounded stroke batches keep a large transform preview from creating thousands of SVG nodes. */
type BatchProps = {
  primitives: CadScene["primitives"];
  point?: (p: [number, number]) => DrawingPoint;
  strokeWidth?: (p: CadScene["primitives"][number]) => number | undefined;
  pointKey?: string;
};
const MacBatch = memo(PrimitiveBatch, (before, after) =>
  before.strokeWidth === after.strokeWidth &&
  (before.pointKey !== undefined || after.pointKey !== undefined
    ? before.pointKey === after.pointKey
    : before.point === after.point) &&
  before.primitives.length === after.primitives.length &&
  before.primitives.every((primitive, index) => primitive === after.primitives[index]),
);
export function CadPrimitiveBatch(props: BatchProps) {
  return isMacPlatform() ? <MacBatch {...props} /> : <PrimitiveBatch {...props} />;
}
function PrimitiveBatch({
  primitives,
  point = identityPoint,
  strokeWidth = () => undefined,
  pointKey,
}: BatchProps) {
  if (primitives.length < 64)
    return (
      <>
        {primitives.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable tessellation order; these nodes have no state.
          <g key={`${p.handle}-${i}`} strokeWidth={strokeWidth(p)}>
            <CadPrimitiveHighlight kind={p.kind} points={p.points.map(point)} />
          </g>
        ))}
      </>
    );
  const output: ReactNode[] = [];
  const cacheKey = isMacPlatform() ? (point === identityPoint ? "cad" : pointKey) : undefined;
  let data = "",
    count = 0,
    width: number | undefined;
  const flush = () => {
    if (!count) return;
    output.push(
      <path key={output.length} d={data} strokeWidth={width} vectorEffect="non-scaling-stroke" />,
    );
    data = "";
    count = 0;
  };
  for (const p of primitives) {
    const nextWidth = strokeWidth(p);
    if (p.kind === "mask" || p.kind === "triangles") {
      flush();
      if (p.kind !== "mask")
        output.push(
          <CadPrimitiveHighlight key={output.length} kind={p.kind} points={p.points.map(point)} />,
        );
      continue;
    }
    const next = cacheKey !== undefined ? macCadPath(p, cacheKey, point) : p.points
      .map((value, i) => {
        const q = point(value);
        return `${i ? "L" : "M"}${q.x} ${q.y}`;
      })
      .join("");
    if (count && (count >= 64 || width !== nextWidth || data.length + next.length > 65536)) flush();
    width = nextWidth;
    data += next;
    count++;
  }
  flush();
  return <>{output}</>;
}

/** Selection/transform feedback must never expose a fill's internal tessellation. */
export function CadPrimitiveHighlight({ kind, points }: { kind: string; points: DrawingPoint[] }) {
  if (kind === "mask") return null;
  const list = (vertices: DrawingPoint[]) => vertices.map((p) => `${p.x},${p.y}`).join(" ");
  if (kind === "triangles")
    return (
      <g stroke="none" fill="currentColor" fillOpacity={0.18}>
        {Array.from({ length: Math.ceil(Math.floor(points.length / 3) / 64) }, (_, batch) => {
          const start = batch * 192;
          let data = "";
          for (let i = start; i + 2 < Math.min(points.length, start + 192); i += 3)
            data += `M${points[i]!.x},${points[i]!.y}L${points[i + 1]!.x},${points[i + 1]!.y}L${points[i + 2]!.x},${points[i + 2]!.y}Z`;
          // CAD triangles partition a filled face. Compound paths preserve the
          // fill without thousands of independently laid-out SVG polygons.
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable tessellation batches have no component state.
          return <path key={batch} stroke="none" d={data} />;
        })}
      </g>
    );
  return <polyline vectorEffect="non-scaling-stroke" points={list(points)} />;
}
