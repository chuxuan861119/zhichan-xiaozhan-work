import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";
export type DraftEdge = { id: string; handle: string; a: DrawingPoint; b: DrawingPoint };
export type DraftCurve = {
  id: string;
  handle: string;
  center: DrawingPoint;
  radius: number;
  start?: number;
  sweep?: number;
};
const TAU = Math.PI * 2;
const angle = (value: number) => ((value % TAU) + TAU) % TAU;
export const pointDistance = (a: DrawingPoint, b: DrawingPoint) => Math.hypot(a.x - b.x, a.y - b.y);
export function arcContains(curve: DraftCurve, point: DrawingPoint): boolean {
  if (curve.start === undefined || curve.sweep === undefined) return true;
  const direction = Math.atan2(point.y - curve.center.y, point.x - curve.center.x);
  const delta = curve.sweep >= 0 ? angle(direction - curve.start) : angle(curve.start - direction);
  return delta <= Math.abs(curve.sweep) + 1e-10 || TAU - delta < 1e-10;
}
export function bulgeArc(
  handle: string,
  id: string,
  a: DrawingPoint,
  b: DrawingPoint,
  bulge: number,
): DraftCurve | null {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  if (!bulge || !length) return null;
  const offset = (1 - bulge * bulge) / (4 * bulge);
  const center = { x: (a.x + b.x) / 2 - dy * offset, y: (a.y + b.y) / 2 + dx * offset };
  return {
    id,
    handle,
    center,
    radius: (length * (1 + bulge * bulge)) / (4 * Math.abs(bulge)),
    start: Math.atan2(a.y - center.y, a.x - center.x),
    sweep: 4 * Math.atan(bulge),
  };
}
export function tangentPoints(curve: DraftCurve, point: DrawingPoint): DrawingPoint[] {
  const dx = point.x - curve.center.x,
    dy = point.y - curve.center.y,
    d2 = dx * dx + dy * dy;
  const r2 = curve.radius * curve.radius;
  if (!d2 || d2 < r2 - r2 * 1e-12) return [];
  const along = r2 / d2,
    across = (curve.radius * Math.sqrt(Math.max(0, d2 - r2))) / d2;
  const candidates = [1, -1].map((sign) => ({
    x: curve.center.x + along * dx - sign * across * dy,
    y: curve.center.y + along * dy + sign * across * dx,
  }));
  return candidates.filter(
    (p, i) =>
      arcContains(curve, p) && (i === 0 || pointDistance(p, candidates[0]!) > curve.radius * 1e-10),
  );
}
export function commonTangents(
  a: DraftCurve,
  b: DraftCurve,
): { from: DrawingPoint; to: DrawingPoint }[] {
  const dx = b.center.x - a.center.x,
    dy = b.center.y - a.center.y,
    d2 = dx * dx + dy * dy;
  if (!d2) return [];
  const results: { from: DrawingPoint; to: DrawingPoint }[] = [];
  for (const side of [1, -1]) {
    const radiusDelta = a.radius - side * b.radius;
    const h2 = d2 - radiusDelta * radiusDelta;
    if (h2 < -d2 * 1e-12) continue;
    for (const sign of [1, -1]) {
      const h = sign * Math.sqrt(Math.max(0, h2));
      const nx = (dx * radiusDelta - dy * h) / d2,
        ny = (dy * radiusDelta + dx * h) / d2;
      const from = { x: a.center.x + a.radius * nx, y: a.center.y + a.radius * ny };
      const to = { x: b.center.x + side * b.radius * nx, y: b.center.y + side * b.radius * ny };
      if (
        arcContains(a, from) &&
        arcContains(b, to) &&
        pointDistance(from, to) > 1e-10 &&
        !results.some((r) => pointDistance(r.from, from) < 1e-10 && pointDistance(r.to, to) < 1e-10)
      )
        results.push({ from, to });
    }
  }
  return results;
}
export function perpendicularFoot(
  edge: DraftEdge,
  point: DrawingPoint,
  extended = false,
): DrawingPoint | null {
  const dx = edge.b.x - edge.a.x,
    dy = edge.b.y - edge.a.y,
    length2 = dx * dx + dy * dy;
  if (!length2) return null;
  const t = ((point.x - edge.a.x) * dx + (point.y - edge.a.y) * dy) / length2;
  if (!extended && (t < 0 || t > 1)) return null;
  return { x: edge.a.x + t * dx, y: edge.a.y + t * dy };
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (!scale) return []; // Coincident loci do not define an isolated contact.
  a /= scale;
  b /= scale;
  c /= scale;
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-12) return [];
  if (discriminant <= 0) return [-b / (2 * a)];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  return [q / a, c / q];
}

/** Centers through two fixed arc points lie on their chord's perpendicular bisector. */
export function tangentArcEnds(a: DrawingPoint, b: DrawingPoint, target: DraftEdge | DraftCurve) {
  const half = pointDistance(a, b) / 2;
  const results: { point: DrawingPoint; center: DrawingPoint; radius: number }[] = [];
  if (!half) return results;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const coordinateError =
    Number.EPSILON * Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) * 8;
  const normal = { x: -(b.y - a.y) / (2 * half), y: (b.x - a.x) / (2 * half) };
  let roots: number[];
  if ("a" in target) {
    const length = pointDistance(target.a, target.b);
    if (!length) return results;
    const nx = -(target.b.y - target.a.y) / length,
      ny = (target.b.x - target.a.x) / length;
    const d = ((mid.x - target.a.x) * nx + (mid.y - target.a.y) * ny) / half;
    const v = normal.x * nx + normal.y * ny;
    roots = quadraticRoots(v * v - 1, 2 * d * v, d * d - 1);
  } else {
    const dx = (mid.x - target.center.x) / half,
      dy = (mid.y - target.center.y) / half;
    const r = target.radius / half;
    const d = dx * dx + dy * dy - 1 - r * r,
      v = 2 * (dx * normal.x + dy * normal.y);
    roots = quadraticRoots(v * v - 4 * r * r, 2 * d * v, d * d - 4 * r * r);
  }
  for (const t of roots) {
    const center = { x: mid.x + half * t * normal.x, y: mid.y + half * t * normal.y };
    const radius = half * Math.hypot(1, t);
    if (!Number.isFinite(radius)) continue;
    const contacts: DrawingPoint[] = [];
    if ("a" in target) {
      const foot = perpendicularFoot(target, center);
      if (foot) contacts.push(foot);
    } else {
      const distance = pointDistance(center, target.center);
      if (distance <= Math.max(radius, target.radius) * 1e-10) continue;
      for (const sign of [1, -1])
        contacts.push({
          x: target.center.x + (sign * target.radius * (center.x - target.center.x)) / distance,
          y: target.center.y + (sign * target.radius * (center.y - target.center.y)) / distance,
        });
    }
    for (const point of contacts) {
      if (
        Math.abs(pointDistance(center, point) - radius) >
          Math.max(Math.max(radius, half) * 1e-8, coordinateError) ||
        (!("a" in target) && !arcContains(target, point)) ||
        pointDistance(point, a) < half * 1e-8 ||
        pointDistance(point, b) < half * 1e-8 ||
        results.some((r) => pointDistance(r.point, point) < half * 1e-8)
      )
        continue;
      results.push({ point, center, radius });
    }
  }
  return results;
}

type DraftGeometry = { edges: DraftEdge[]; curves: DraftCurve[] };
const geometries = new WeakMap<CadScene, DraftGeometry>();
/** Native geometric definitions, never display chords masquerading as curves. */
export function draftingGeometry(scene: CadScene): DraftGeometry {
  const cached = geometries.get(scene);
  if (cached) return cached;
  const result: DraftGeometry = { edges: [], curves: [] };
  const primitives = new Map(
    scene.primitives.filter((p) => p.kind === "polyline").map((p) => [p.handle, p]),
  );
  for (const entity of scene.entities) {
    if (entity.visible === false) continue;
    const g = entity.geometry,
      type = entity.type.toLowerCase();
    const normal = entity.common?.extrusion;
    if (normal && (normal.x !== 0 || normal.y !== 0 || normal.z < 0)) continue;
    if (g?.type === "lwPolyline" && g.vertices?.every((v) => v.p)) {
      const vertices = g.vertices;
      for (let i = 0; i < vertices.length - (g.closed ? 0 : 1); i++) {
        const a = vertices[i]!,
          b = vertices[(i + 1) % vertices.length]!;
        const id = `${entity.handle}:${i}`;
        const curve = bulgeArc(entity.handle, id, a.p!, b.p!, a.bulge);
        if (curve) result.curves.push(curve);
        else if (pointDistance(a.p!, b.p!))
          result.edges.push({ handle: entity.handle, id, a: a.p!, b: b.p! });
      }
    } else if (type === "line") {
      const primitive = primitives.get(entity.handle);
      const a =
        g?.a ??
        (primitive?.points[0] ? { x: primitive.points[0][0], y: primitive.points[0][1] } : null);
      const b =
        g?.b ??
        (primitive?.points[1] ? { x: primitive.points[1][0], y: primitive.points[1][1] } : null);
      if (a && b && pointDistance(a, b))
        result.edges.push({ id: entity.handle, handle: entity.handle, a, b });
    } else if (type === "circle" || type === "arc") {
      const grip = entity.grips?.[type === "circle" ? 0 : 3];
      const center = g?.center ?? (grip ? { x: grip[0], y: grip[1] } : null);
      const radius = g?.radius ?? entity.radius;
      if (!center || !radius || radius <= 0) continue;
      if (type === "arc") {
        if (g?.start === undefined || g.end === undefined) continue;
        result.curves.push({
          id: entity.handle,
          handle: entity.handle,
          center,
          radius,
          start: g.start,
          sweep: angle(g.end - g.start),
        });
      } else result.curves.push({ id: entity.handle, handle: entity.handle, center, radius });
    }
  }
  geometries.set(scene, result);
  return result;
}
