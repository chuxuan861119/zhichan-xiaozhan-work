import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import {
  arcContains,
  commonTangents,
  type DraftCurve,
  type DraftEdge,
  draftingGeometry,
  perpendicularFoot,
  pointDistance,
  tangentArcEnds,
  tangentPoints,
} from "./cad-drafting-geometry";
import { type CadSnapType, resolveCadSnap } from "./cad-object-snap";
import type { CadScene } from "./cadcraft-client";
export type AidContext = {
  anchor?: DrawingPoint | null;
  tangent?: boolean;
  circle?: boolean;
  arc?: readonly DrawingPoint[] | undefined;
  deferred?: DraftCurve | undefined;
  orthogonal?: boolean;
  hover?: boolean;
  now?: number;
  forced?: CadSnapType | null;
};
export const CAPTURE_TYPES: { type: CadSnapType; label: string }[] = [
  { type: "endpoint", label: "端点" },
  { type: "midpoint", label: "中点" },
  { type: "center", label: "圆心/中心" },
  { type: "quadrant", label: "象限点" },
  { type: "intersection", label: "交点" },
  { type: "nearest", label: "最近点" },
  { type: "node", label: "节点" },
  { type: "insertion", label: "插入点" },
  { type: "tangent", label: "相切" },
  { type: "perpendicular", label: "垂直" },
  { type: "extension", label: "延长线" },
  { type: "parallel", label: "平行" },
];
export type AidSettings = {
  tracking: boolean;
  angle45: boolean;
  enabled: ReadonlySet<CadSnapType>;
};
export const DEFAULT_AID_SETTINGS: AidSettings = {
  tracking: true,
  angle45: false,
  enabled: new Set(CAPTURE_TYPES.map((t) => t.type)),
};
export type AidResult = {
  point: DrawingPoint;
  type?: CadSnapType;
  references: DrawingPoint[];
  guides: [DrawingPoint, DrawingPoint][];
  deferred?: DraftCurve;
  start?: DrawingPoint;
  invalid?: boolean;
  problem?: string;
  delay?: number;
};
type Reference = { key: string; point: DrawingPoint; edges: DraftEdge[]; feature: boolean };
type Candidate = AidResult & { key: string; rank: number; score: number };
const featureTypes = new Set<CadSnapType>([
  "endpoint",
  "midpoint",
  "center",
  "quadrant",
  "intersection",
  "node",
  "insertion",
]);
function curveClosest(curve: DraftCurve, point: DrawingPoint, finite = true): DrawingPoint | null {
  const dx = point.x - curve.center.x,
    dy = point.y - curve.center.y,
    length = Math.hypot(dx, dy);
  if (!length) return null;
  const q = {
    x: curve.center.x + (dx * curve.radius) / length,
    y: curve.center.y + (dy * curve.radius) / length,
  };
  return !finite || arcContains(curve, q) ? q : null;
}
function axisCompatible(start: DrawingPoint, end: DrawingPoint): boolean {
  const epsilon = Math.max(1, pointDistance(start, end)) * 1e-10;
  return Math.abs(start.x - end.x) <= epsilon || Math.abs(start.y - end.y) <= epsilon;
}
export function orthogonalPoint(point: DrawingPoint, anchor: DrawingPoint): DrawingPoint {
  return Math.abs(point.x - anchor.x) >= Math.abs(point.y - anchor.y)
    ? { x: point.x, y: anchor.y }
    : { x: anchor.x, y: point.y };
}
export class CadDraftingAids {
  private references: Reference[] = [];
  private dwelling: { key: string; point: DrawingPoint; since: number; consumed: boolean } | null =
    null;
  private selected: string | null = null;
  private pool: Candidate[] = [];
  private cycleKey: string | null = null;
  private manualKey: string | null = null;
  clear() {
    this.references = [];
    this.dwelling = null;
    this.selected = null;
    this.pool = [];
    this.cycleKey = null;
    this.manualKey = null;
  }
  stopHover() {
    this.dwelling = null;
  }
  cycle(): boolean {
    if (this.pool.length < 2) return false;
    const index = this.pool.findIndex((c) => c.key === this.selected);
    this.cycleKey = this.pool[(index + 1) % this.pool.length]!.key;
    this.manualKey = this.cycleKey;
    return true;
  }
  resolve(
    point: DrawingPoint,
    scene: CadScene,
    aperture: number,
    context: AidContext = {},
    settings: AidSettings = DEFAULT_AID_SETTINGS,
  ): AidResult {
    const { edges, curves } = draftingGeometry(scene);
    const radius = aperture * 1.6;
    const enabled = context.forced ? new Set([context.forced]) : settings.enabled;
    const supports = (type: CadSnapType) =>
      enabled.has(type) || (type === "tangent" && !!context.deferred);
    const baseTypes = new Set([...enabled].filter((t) => featureTypes.has(t)));
    const basic = resolveCadSnap(point, scene, radius, baseTypes);
    // Only contacts inside the aperture can become candidates. Reject distant
    // bounds before allocating projected points or solving circle/arc geometry.
    const nearbyEdges = edges.filter(
      (edge) =>
        point.x >= Math.min(edge.a.x, edge.b.x) - radius &&
        point.x <= Math.max(edge.a.x, edge.b.x) + radius &&
        point.y >= Math.min(edge.a.y, edge.b.y) - radius &&
        point.y <= Math.max(edge.a.y, edge.b.y) + radius,
    );
    const nearbyCurves = curves.filter(
      (curve) =>
        Math.abs(point.x - curve.center.x) <= curve.radius + radius &&
        Math.abs(point.y - curve.center.y) <= curve.radius + radius,
    );
    const closestEdges = nearbyEdges
      .map((edge) => ({ edge, point: perpendicularFoot(edge, point) }))
      .filter(
        (item): item is { edge: DraftEdge; point: DrawingPoint } =>
          !!item.point && pointDistance(item.point, point) < radius,
      );
    const closestCurves = nearbyCurves
      .map((curve) => ({ curve, point: curveClosest(curve, point) }))
      .filter(
        (item): item is { curve: DraftCurve; point: DrawingPoint } =>
          !!item.point && pointDistance(item.point, point) < radius,
      );
    let delay: number | undefined;
    if (context.hover && settings.tracking) {
      const acquisition = context.forced
        ? resolveCadSnap(
            point,
            scene,
            aperture,
            new Set([...settings.enabled].filter((t) => featureTypes.has(t))),
          )
        : basic;
      const edge = closestEdges.toSorted(
        (a, b) => pointDistance(a.point, point) - pointDistance(b.point, point),
      )[0];
      const target =
        acquisition && pointDistance(acquisition.point, point) < aperture
          ? {
              key: `${acquisition.type}:${acquisition.point.x}:${acquisition.point.y}`,
              point: acquisition.point,
              feature: true,
            }
          : edge &&
              supports("parallel") &&
              context.anchor &&
              pointDistance(edge.point, point) < aperture
            ? { key: `edge:${edge.edge.id}`, point: edge.point, feature: false }
            : null;
      if (!target) this.dwelling = null;
      else {
        const now = context.now ?? performance.now();
        if (
          this.dwelling?.key !== target.key ||
          (!this.dwelling.consumed &&
            pointDistance(this.dwelling.point, target.point) > aperture * 0.35)
        )
          this.dwelling = { key: target.key, point: target.point, since: now, consumed: false };
        const dwelling = this.dwelling;
        if (!dwelling.consumed) {
          delay = Math.max(0, 250 - (now - dwelling.since));
          if (delay === 0) {
            dwelling.consumed = true;
            delay = undefined;
            const index = this.references.findIndex((r) => r.key === target.key);
            if (index >= 0) this.references.splice(index, 1);
            else {
              this.references.push({
                ...target,
                edges: edges.filter((e) => {
                  const foot = perpendicularFoot(e, target.point);
                  return foot && pointDistance(foot, target.point) < Math.max(1, aperture) * 1e-9;
                }),
              });
              this.references = this.references.slice(-2);
            }
          }
        }
      }
    }
    const references = settings.tracking ? this.references.map((r) => r.point) : [];
    const candidates: Candidate[] = [];
    const add = (
      type: CadSnapType,
      p: DrawingPoint,
      key: string,
      rank: number,
      extra: Partial<AidResult> = {},
      relax = false,
    ) => {
      if (!supports(type) && type !== "tracking" && type !== "polar" && type !== "tangent-pending")
        return;
      if (!relax && pointDistance(p, point) >= radius) return;
      const start = extra.start ?? context.anchor;
      if (context.orthogonal && start && !axisCompatible(start, p)) return;
      candidates.push({
        point: p,
        type,
        key,
        rank,
        score:
          pointDistance(p, point) +
          (extra.start && context.anchor ? pointDistance(extra.start, context.anchor) * 0.01 : 0),
        references,
        guides: [],
        ...extra,
      });
    };
    if (context.deferred) {
      const source = context.deferred;
      const target = closestCurves.find((c) => c.curve.id !== source.id);
      if (target && supports("tangent")) {
        commonTangents(source, target.curve).forEach((line, i) => {
          add("tangent", line.to, `common:${target.curve.id}:${i}`, 0, { start: line.from }, true);
        });
      } else if (context.orthogonal) {
        const horizontal =
          Math.abs(point.x - source.center.x) >= Math.abs(point.y - source.center.y);
        const from = horizontal
          ? {
              x: source.center.x,
              y: source.center.y + (point.y >= source.center.y ? 1 : -1) * source.radius,
            }
          : {
              x: source.center.x + (point.x >= source.center.x ? 1 : -1) * source.radius,
              y: source.center.y,
            };
        const to = horizontal ? { x: point.x, y: from.y } : { x: from.x, y: point.y };
        if (arcContains(source, from) && pointDistance(from, to) > aperture)
          add("tangent", to, "deferred:axis", 0, { start: from }, true);
      } else {
        tangentPoints(source, point).forEach((from, i) => {
          add("tangent", point, `deferred:${i}`, 0, { start: from }, true);
        });
      }
      if (!candidates.length) return { point, references, guides: [], invalid: true };
    } else {
      if (basic)
        add(basic.type, basic.point, `basic:${basic.type}:${basic.point.x}:${basic.point.y}`, 0);
      if (context.anchor) {
        const contactType = context.circle ? "tangent" : "perpendicular";
        if (!context.arc && supports(contactType)) {
          nearbyEdges.forEach((edge) => {
            const q = perpendicularFoot(edge, context.anchor!);
            if (q) add(contactType, q, `perp:${edge.id}`, 1);
          });
          nearbyCurves.forEach((curve) => {
            const near = curveClosest(curve, context.anchor!, false);
            if (!near) return;
            if (arcContains(curve, near)) add(contactType, near, `perp:${curve.id}:0`, 1);
            const far = { x: curve.center.x * 2 - near.x, y: curve.center.y * 2 - near.y };
            if (arcContains(curve, far)) add(contactType, far, `perp:${curve.id}:1`, 1);
          });
        }
        if (context.tangent && supports("tangent"))
          curves.forEach((curve) => {
            const from = context.anchor!;
            if (
              Math.abs(pointDistance(from, curve.center) - curve.radius) <= curve.radius * 1e-9 &&
              arcContains(curve, from)
            ) {
              const tangent = {
                id: curve.id,
                handle: curve.handle,
                a: from,
                b: { x: from.x - (from.y - curve.center.y), y: from.y + (from.x - curve.center.x) },
              };
              const end = perpendicularFoot(tangent, point, true);
              if (end && pointDistance(from, end) > aperture)
                add("tangent", end, `outgoing:${curve.id}`, 1, { guides: [[from, end]] });
            }
            tangentPoints(curve, context.anchor!).forEach((q, i) => {
              add(
                "tangent",
                q,
                `tangent:${curve.id}:${i}`,
                1,
                {},
                context.forced === "tangent" && closestCurves.some((c) => c.curve === curve),
              );
            });
          });
      } else if (context.tangent && supports("tangent")) {
        for (const item of closestCurves)
          add(
            "tangent-pending",
            item.point,
            `pending:${item.curve.id}`,
            context.forced === "tangent" ? 0 : 1,
            { deferred: item.curve },
          );
      }
      if (context.arc?.length === 2 && supports("tangent")) {
        for (const target of [...nearbyEdges, ...nearbyCurves])
          tangentArcEnds(context.arc[0]!, context.arc[1]!, target).forEach((contact, index) => {
            const sameFeature =
              basic &&
              pointDistance(contact.point, basic.point) <=
                Math.max(1, pointDistance(context.arc![0]!, context.arc![1]!)) * 1e-6;
            add("tangent", contact.point, `arc:${target.id}:${index}`, sameFeature ? -1 : 0);
          });
      }
      if (settings.tracking) {
        const guides: { origin: DrawingPoint; axis: "x" | "y"; point: DrawingPoint }[] = [];
        for (const ref of this.references) {
          if (ref.feature && !context.forced) {
            if (Math.abs(point.x - ref.point.x) < radius)
              guides.push({ origin: ref.point, axis: "y", point: { x: ref.point.x, y: point.y } });
            if (Math.abs(point.y - ref.point.y) < radius)
              guides.push({ origin: ref.point, axis: "x", point: { x: point.x, y: ref.point.y } });
          }
          for (const edge of ref.edges) {
            if (supports("extension") && ref.feature) {
              const q = perpendicularFoot(edge, point, true);
              if (q && !perpendicularFoot(edge, point))
                add("extension", q, `extension:${edge.id}`, 3, { guides: [[ref.point, q]] });
            }
            if (supports("parallel") && context.anchor) {
              const shifted = {
                ...edge,
                a: context.anchor,
                b: {
                  x: context.anchor.x + edge.b.x - edge.a.x,
                  y: context.anchor.y + edge.b.y - edge.a.y,
                },
              };
              const q = perpendicularFoot(shifted, point, true);
              if (q && pointDistance(q, context.anchor) > aperture)
                add("parallel", q, `parallel:${edge.id}`, 3, { guides: [[context.anchor, q]] });
            }
          }
        }
        for (const guide of guides)
          add(
            "tracking",
            guide.point,
            `tracking:${guide.axis}:${guide.origin.x}:${guide.origin.y}`,
            3,
            { guides: [[guide.origin, guide.point]] },
          );
        for (const x of guides.filter((g) => g.axis === "x"))
          for (const y of guides.filter((g) => g.axis === "y")) {
            if (x.origin === y.origin) continue;
            const q = { x: y.origin.x, y: x.origin.y };
            add("tracking", q, `tracking:cross:${q.x}:${q.y}`, 2, {
              guides: [
                [x.origin, q],
                [y.origin, q],
              ],
            });
          }
        if (context.anchor && !context.forced && !context.orthogonal) {
          const angles = settings.angle45
            ? [0, Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4]
            : [0, Math.PI / 2];
          angles.forEach((angle, i) => {
            const direction = { x: Math.cos(angle), y: Math.sin(angle) };
            const edge = {
              id: "polar",
              handle: "",
              a: context.anchor!,
              b: { x: context.anchor!.x + direction.x, y: context.anchor!.y + direction.y },
            };
            const q = perpendicularFoot(edge, point, true)!;
            if (pointDistance(q, context.anchor!) > aperture)
              add("polar", q, `polar:${i}`, 4, { guides: [[context.anchor!, q]] });
          });
        }
        // Resolve the intersection, not just one projected path. This lets a
        // horizontal/diagonal stroke also align to an acquired object point.
        const paths = candidates.filter(
          (candidate) => candidate.rank >= 3 && candidate.guides.length === 1,
        );
        for (let i = 0; i < paths.length; i++) {
          const a = paths[i]!;
          const [a0, a1] = a.guides[0]!;
          for (const b of paths.slice(i + 1)) {
            if (a.type !== "polar" && b.type !== "polar") continue;
            const [b0, b1] = b.guides[0]!;
            const ax = a1.x - a0.x,
              ay = a1.y - a0.y;
            const bx = b1.x - b0.x,
              by = b1.y - b0.y;
            const cross = ax * by - ay * bx;
            if (Math.abs(cross) <= Math.hypot(ax, ay) * Math.hypot(bx, by) * 1e-10) continue;
            const t = ((b0.x - a0.x) * by - (b0.y - a0.y) * bx) / cross;
            const q = { x: a0.x + t * ax, y: a0.y + t * ay };
            add("tracking", q, `tracking:polar:${a.key}:${b.key}`, 2, {
              guides: [
                [a0, q],
                [b0, q],
              ],
            });
          }
        }
      }
      if (supports("nearest")) {
        closestEdges.forEach((item) => {
          add("nearest", item.point, `nearest:${item.edge.id}`, 1);
        });
        closestCurves.forEach((item) => {
          add("nearest", item.point, `nearest:${item.curve.id}`, 1);
        });
        if (!closestEdges.length && !closestCurves.length) {
          const near = resolveCadSnap(point, scene, radius, new Set(["nearest"]));
          if (near) add("nearest", near.point, "nearest:fallback", 1);
        }
      }
    }
    this.pool = candidates
      .filter((c) => pointDistance(c.point, point) < aperture || c.start || context.forced)
      .toSorted((a, b) => a.rank - b.rank || a.score - b.score);
    const cycled = this.pool.find((c) => c.key === this.cycleKey);
    this.cycleKey = null;
    const winner = this.pool[0];
    const old = candidates.find((c) => c.key === this.selected && c.type !== "nearest");
    const manual = candidates.find((c) => c.key === this.manualKey);
    if (!manual) this.manualKey = null;
    const selected = cycled ?? manual ?? (old && winner && old.rank <= winner.rank ? old : winner);
    this.selected = selected?.key ?? null;
    if (selected) return { ...selected, references, ...(delay !== undefined ? { delay } : {}) };
    if (context.forced)
      return {
        point,
        references,
        guides: [],
        invalid: true,
        problem: context.forced === "tangent" ? "未找到有效切点" : "未找到对应捕捉点",
        ...(delay !== undefined ? { delay } : {}),
      };
    return {
      point: context.orthogonal && context.anchor ? orthogonalPoint(point, context.anchor) : point,
      references,
      guides: [],
      ...(delay !== undefined ? { delay } : {}),
    };
  }
}
