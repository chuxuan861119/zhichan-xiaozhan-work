import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

export type CadSnapType =
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "intersection"
  | "nearest"
  | "node"
  | "insertion"
  | "tangent"
  | "tangent-pending"
  | "perpendicular"
  | "extension"
  | "parallel"
  | "tracking"
  | "polar";
export type CadSnapResult = { point: DrawingPoint; type: CadSnapType };
type Segment = {
  handle: string;
  a: DrawingPoint;
  dx: number;
  dy: number;
  length2: number;
  straight: boolean;
};
type Circle = { handle: string; center: DrawingPoint; radius: number };
type Geometry = { features: CadSnapResult[]; segments: Segment[]; circles: Circle[] };
const snapshots = new WeakMap<CadScene, Geometry>();
const priority: Record<CadSnapType, number> = {
  endpoint: 0,
  intersection: 1,
  midpoint: 2,
  center: 3,
  quadrant: 4,
  node: 5,
  insertion: 6,
  nearest: 7,
  tangent: 2,
  "tangent-pending": 8,
  perpendicular: 2,
  extension: 6,
  parallel: 6,
  tracking: 6,
  polar: 6,
};

export function cadGripSnapType(type: string, index: number): CadSnapType {
  switch (type.toLowerCase()) {
    case "line":
      return index === 1 ? "midpoint" : "endpoint";
    case "lwpolyline":
    case "polyline":
      return index % 2 ? "midpoint" : "endpoint";
    case "arc":
      return index === 3 ? "center" : index === 1 ? "midpoint" : "endpoint";
    case "circle":
    case "ellipse":
      return index === 0 ? "center" : "quadrant";
    case "polyline3d":
    case "3d polyline":
    case "leader":
    case "solid":
    case "trace":
    case "3dface":
      return "endpoint";
    case "text":
    case "mtext":
    case "block reference":
    case "insert":
    case "image":
      return "insertion";
    default:
      return "node";
  }
}
function geometry(scene: CadScene): Geometry {
  const cached = snapshots.get(scene);
  if (cached) return cached;
  const entities = new Map((scene.entities ?? []).map((entity) => [entity.handle, entity]));
  const result: Geometry = { features: [], segments: [], circles: [] };
  for (const entity of entities.values()) {
    if (entity.visible === false) continue;
    entity.grips?.forEach(([x, y], index) => {
      if (entity.gear && index > 0) return; // Parameter handles are not source geometry.
      result.features.push({ point: { x, y }, type: cadGripSnapType(entity.type, index) });
    });
    if (
      entity.type.toLowerCase() === "circle" &&
      entity.radius &&
      entity.radius > 0 &&
      entity.grips?.[0]
    ) {
      const [x, y] = entity.grips[0];
      result.circles.push({ handle: entity.handle, center: { x, y }, radius: entity.radius });
    }
  }
  scene.primitives.forEach((primitive, primitiveIndex) => {
    const entity = entities.get(primitive.handle);
    if (entity?.visible === false || (primitive.kind !== "polyline" && primitive.kind !== "point"))
      return;
    const points = primitive.points;
    const circle = entity?.type.toLowerCase() === "circle" && entity.radius && entity.grips?.[0];
    if (!entity?.grips?.length) {
      points.forEach(([x, y], index) => {
        result.features.push({
          point: { x, y },
          type: primitive.kind === "point" ? "node" : "endpoint",
        });
        const b = points[index + 1];
        if (b)
          result.features.push({
            point: { x: (x + b[0]) / 2, y: (y + b[1]) / 2 },
            type: "midpoint",
          });
      });
    }
    if (primitive.kind !== "polyline" || circle) return;
    // Tessellated curved polylines remain eligible for nearest-point capture,
    // but their display chords must not be advertised as exact intersections.
    const type = entity?.type.toLowerCase();
    const straight =
      !entity ||
      type === "line" ||
      ((type === "lwpolyline" || type === "polyline") &&
        entity.geometry?.type === "lwPolyline" &&
        !!entity.geometry.vertices?.length &&
        entity.geometry.vertices.every((vertex) => vertex.bulge === 0));
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1]!,
        b = points[index]!;
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length2 = dx * dx + dy * dy;
      if (length2)
        result.segments.push({
          handle: primitive.handle ?? `primitive:${primitiveIndex}`,
          a: { x: a[0], y: a[1] },
          dx,
          dy,
          length2,
          straight,
        });
    }
  });
  snapshots.set(scene, result);
  return result;
}
function onSegment(segment: Segment, t: number): DrawingPoint {
  return { x: segment.a.x + t * segment.dx, y: segment.a.y + t * segment.dy };
}
function segmentIntersection(a: Segment, b: Segment): DrawingPoint | null {
  const cross = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(cross) <= 1e-12 * Math.sqrt(a.length2 * b.length2)) return null;
  const dx = b.a.x - a.a.x,
    dy = b.a.y - a.a.y;
  const t = (dx * b.dy - dy * b.dx) / cross,
    u = (dx * a.dy - dy * a.dx) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? onSegment(a, t) : null;
}
function circleSegment(circle: Circle, segment: Segment): DrawingPoint[] {
  const dx = circle.center.x - segment.a.x,
    dy = circle.center.y - segment.a.y;
  const t = (dx * segment.dx + dy * segment.dy) / segment.length2;
  const foot = onSegment(segment, t);
  const height2 =
    circle.radius ** 2 - (foot.x - circle.center.x) ** 2 - (foot.y - circle.center.y) ** 2;
  if (height2 < 0) return [];
  const offset = Math.sqrt(height2 / segment.length2);
  return [t - offset, t + offset]
    .filter((value) => value >= 0 && value <= 1)
    .map((value) => onSegment(segment, value));
}
function circleIntersection(a: Circle, b: Circle): DrawingPoint[] {
  const dx = b.center.x - a.center.x,
    dy = b.center.y - a.center.y,
    distance = Math.hypot(dx, dy);
  if (!distance || distance > a.radius + b.radius || distance < Math.abs(a.radius - b.radius))
    return [];
  const along = (a.radius ** 2 - b.radius ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, a.radius ** 2 - along ** 2));
  const x = a.center.x + (along * dx) / distance,
    y = a.center.y + (along * dy) / distance;
  return [
    { x: x - (height * dy) / distance, y: y + (height * dx) / distance },
    { x: x + (height * dy) / distance, y: y - (height * dx) / distance },
  ];
}
/** A typed, read-only capture; no aperture box or serialized document state. */
export function resolveCadSnap(
  point: DrawingPoint,
  scene: CadScene,
  aperture: number,
  enabled?: ReadonlySet<CadSnapType>,
): CadSnapResult | null {
  if (!Number.isFinite(aperture) || aperture <= 0) return null;
  const data = geometry(scene),
    limit = aperture * aperture;
  const state = { best: null as CadSnapResult | null, distance: limit };
  const consider = (candidate: DrawingPoint, type: CadSnapType) => {
    if (enabled && !enabled.has(type)) return;
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (
      distance < limit &&
      (!state.best ||
        distance < state.distance - limit * 1e-12 ||
        (Math.abs(distance - state.distance) <= limit * 1e-12 &&
          state.best &&
          priority[type] < priority[state.best.type]))
    ) {
      state.distance = distance;
      state.best = { point: candidate, type };
    }
  };
  for (const feature of data.features) consider(feature.point, feature.type);
  const segments: { segment: Segment; closest: DrawingPoint }[] = [];
  for (const segment of data.segments) {
    const endX = segment.a.x + segment.dx,
      endY = segment.a.y + segment.dy;
    if (
      point.x < Math.min(segment.a.x, endX) - aperture ||
      point.x > Math.max(segment.a.x, endX) + aperture ||
      point.y < Math.min(segment.a.y, endY) - aperture ||
      point.y > Math.max(segment.a.y, endY) + aperture
    )
      continue;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - segment.a.x) * segment.dx + (point.y - segment.a.y) * segment.dy) /
          segment.length2,
      ),
    );
    const closest = onSegment(segment, t);
    if ((point.x - closest.x) ** 2 + (point.y - closest.y) ** 2 < limit)
      segments.push({ segment, closest });
  }
  const circles = data.circles.filter(
    (circle) =>
      Math.abs(Math.hypot(point.x - circle.center.x, point.y - circle.center.y) - circle.radius) <
      aperture,
  );
  // Pairwise intersection checks use nearby geometry, not all pairs across
  // the entire drawing. Scene geometry itself is cached between pointer frames.
  const straight = segments.filter(({ segment }) => segment.straight);
  for (let i = 0; i < straight.length; i++) {
    const a = straight[i]!.segment;
    for (let j = i + 1; j < straight.length; j++) {
      const b = straight[j]!.segment;
      const hit = segmentIntersection(a, b);
      if (hit) consider(hit, "intersection");
    }
    for (const circle of circles)
      for (const hit of circleSegment(circle, a)) consider(hit, "intersection");
  }
  for (let i = 0; i < circles.length; i++)
    for (let j = i + 1; j < circles.length; j++) {
      for (const hit of circleIntersection(circles[i]!, circles[j]!)) consider(hit, "intersection");
    }
  if (state.best) return state.best;
  for (const item of segments) consider(item.closest, "nearest");
  for (const circle of circles) {
    const dx = point.x - circle.center.x,
      dy = point.y - circle.center.y,
      distance = Math.hypot(dx, dy);
    if (distance)
      consider(
        {
          x: circle.center.x + (dx * circle.radius) / distance,
          y: circle.center.y + (dy * circle.radius) / distance,
        },
        "nearest",
      );
  }
  return state.best;
}
