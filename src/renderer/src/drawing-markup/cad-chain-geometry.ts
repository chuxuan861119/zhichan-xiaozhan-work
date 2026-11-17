import type { DrawingPoint as Point } from "../../../shared/drawing-markup/model";
import reference from "../../../shared/drawing-markup/sprocket-profile.json";

export type ChainSpec = {
  single: boolean;
  at: [number, number];
  end: [number, number];
  radius: number;
  teeth: number;
  otherTeeth: number;
  otherRadius?: number;
  hole: number;
  otherHole: number;
  flip?: boolean;
};
const TAU = Math.PI * 2;
const toothOffsets = reference.radialOffsets;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const chainOtherRadius = (s: ChainSpec) =>
  s.otherRadius ?? (s.radius * Math.sin(Math.PI / s.teeth)) / Math.sin(Math.PI / s.otherTeeth);
export const chainPitch = (s: ChainSpec) => 2 * s.radius * Math.sin(Math.PI / s.teeth);
const radiusForTeeth = (pitch: number, teeth: number) => pitch / (2 * Math.sin(Math.PI / teeth));
function wheelForRadius(pitch: number, target: number, limit: number) {
  let teeth = 8;
  let radius = radiusForTeeth(pitch, teeth);
  let error = Number.POSITIVE_INFINITY;
  for (let n = 8; n <= 120; n++) {
    const r = radiusForTeeth(pitch, n);
    if (r >= 1e-4 && r <= Math.min(limit, 1e8) + 1e-9 && Math.abs(r - target) < error) {
      teeth = n;
      radius = r;
      error = Math.abs(r - target);
    }
  }
  return { teeth, radius };
}
/** Repair an independently resized legacy wheel when the assembly is next edited. */
export function chainMatchPitch(s: ChainSpec): ChainSpec {
  const originalPitch = chainPitch(s);
  const target = chainOtherRadius(s);
  const otherPitch = 2 * target * Math.sin(Math.PI / s.otherTeeth);
  const pitch =
    s.single || Math.abs(originalPitch - otherPitch) <= Math.max(originalPitch, otherPitch) * 1e-9
      ? originalPitch
      : Math.min(originalPitch, otherPitch);
  const first = s.single
    ? { teeth: s.teeth, radius: s.radius }
    : wheelForRadius(pitch, s.radius, chainFrame(s).d / 1.08 - target);
  const wheel = s.single
    ? { teeth: s.otherTeeth, radius: radiusForTeeth(pitch, s.otherTeeth) }
    : wheelForRadius(pitch, target, chainFrame(s).d / 1.08 - first.radius);
  return {
    ...s,
    radius: first.radius,
    teeth: first.teeth,
    hole: Math.min(s.hole, first.radius * 0.5),
    otherTeeth: wheel.teeth,
    otherRadius: wheel.radius,
    otherHole: Math.min(s.otherHole, wheel.radius * 0.5),
  };
}
/** Wheel-size edits keep the shared pitch; whole-object scaling changes the pitch too. */
export function chainWheelSize(
  s: ChainSpec,
  right: boolean,
  value: number,
  byTeeth = false,
): ChainSpec {
  const n = chainMatchPitch(s),
    pitch = chainPitch(n);
  const target = byTeeth ? radiusForTeeth(pitch, clamp(Math.round(value), 8, 120)) : value;
  const limit = n.single ? 1e8 : chainFrame(n).d / 1.08 - (right ? n.radius : chainOtherRadius(n));
  const wheel = wheelForRadius(pitch, target, limit);
  return right
    ? {
        ...n,
        otherRadius: wheel.radius,
        otherTeeth: wheel.teeth,
        otherHole: Math.min(n.otherHole, wheel.radius * 0.5),
      }
    : {
        ...n,
        radius: wheel.radius,
        teeth: wheel.teeth,
        hole: Math.min(n.hole, wheel.radius * 0.5),
      };
}
export function chainFrame(s: ChainSpec) {
  const d = Math.hypot(s.end[0] - s.at[0], s.end[1] - s.at[1]);
  const ux = d ? (s.end[0] - s.at[0]) / d : 1,
    uy = d ? (s.end[1] - s.at[1]) / d : 0;
  return {
    d,
    ux,
    uy,
    world: (x: number, y: number): Point => ({
      x: s.at[0] + ux * x - uy * y * (s.flip ? -1 : 1),
      y: s.at[1] + uy * x + ux * y * (s.flip ? -1 : 1),
    }),
  };
}
export function chainGrips(s: ChainSpec): Point[] {
  const { d, world } = chainFrame(s),
    r = chainOtherRadius(s);
  // Stable indices shared with the native command, including single sprockets.
  const points = s.single
    ? [
        [0, 0],
        [0, s.radius],
        [0, -Math.max(s.hole, s.radius * 0.15)],
        [s.radius * 1.5, s.radius * 1.5],
      ]
    : [
        [d / 2, 0],
        [0, 0],
        [d, 0],
        [0, s.radius],
        [d, r],
        [0, -Math.max(s.hole, s.radius * 0.15)],
        [d, -Math.max(s.otherHole, r * 0.15)],
        [d + s.radius, s.radius * 1.6],
      ];
  return points.map(([x, y]) => world(x!, y!));
}
export const chainGripLabels = [
  "整体移动",
  "左轮轮心",
  "右轮轮心 · 中心距与方向",
  "左轮尺寸",
  "右轮尺寸",
  "左轮轴孔",
  "右轮轴孔",
  "整体缩放",
];
export const chainGripLabel = (s: ChainSpec, i: number) =>
  s.single ? ["移动", "轮径", "轴孔", "整体缩放"][i] : chainGripLabels[i];
export function chainGrip(s: ChainSpec, index: number, to: Point): ChainSpec {
  s = chainMatchPitch(s);
  const n = {
    ...s,
    at: [...s.at] as [number, number],
    end: [...s.end] as [number, number],
    otherRadius: chainOtherRadius(s),
  };
  const { d, ux, uy } = chainFrame(s),
    from = chainGrips(s)[index]!;
  if (s.single) index = [0, 3, 5, 7][index]!;
  const y = Math.abs(-(to.x - s.at[0]) * uy + (to.y - s.at[1]) * ux);
  if (index === 0) {
    const dx = to.x - from.x,
      dy = to.y - from.y;
    n.at = [s.at[0] + dx, s.at[1] + dy];
    n.end = [s.end[0] + dx, s.end[1] + dy];
  }
  if (index === 1 || index === 2) {
    const anchor = index === 1 ? s.end : s.at;
    const dx = to.x - anchor[0],
      dy = to.y - anchor[1],
      len = Math.hypot(dx, dy),
      min = (s.radius + n.otherRadius) * 1.08;
    const factor = s.single ? 1 : Math.max(min, len) / Math.max(len, 1e-12);
    const p: [number, number] =
      len > 1e-12
        ? [anchor[0] + dx * factor, anchor[1] + dy * factor]
        : [...(index === 1 ? s.at : s.end)];
    if (index === 1) n.at = p;
    else n.end = p;
  }
  if (index === 3 || index === 4) return chainWheelSize(n, index === 4, y);
  if (index === 5) n.hole = clamp(y, 0, s.radius * 0.5);
  if (index === 6) n.otherHole = clamp(y, 0, n.otherRadius * 0.5);
  if (index === 7) {
    const f = clamp(
      Math.hypot(to.x - s.at[0], to.y - s.at[1]) / Math.hypot(from.x - s.at[0], from.y - s.at[1]),
      1e-4 / Math.min(s.radius, n.otherRadius),
      1e8 / Math.max(s.radius, n.otherRadius, d),
    );
    n.radius *= f;
    n.otherRadius *= f;
    n.hole *= f;
    n.otherHole *= f;
    n.end = [s.at[0] + (s.end[0] - s.at[0]) * f, s.at[1] + (s.end[1] - s.at[1]) * f];
  }
  return n;
}

/** Bounded, synchronous geometry for pointer frames. No worker, document or persistence calls. */
export function chainPaths(s: ChainSpec): Point[][] {
  const { d, world } = chainFrame(s),
    r1 = s.radius,
    r2 = chainOtherRadius(s);
  const paths: Point[][] = [];
  const arc = (cx: number, cy: number, r: number, a: number, b: number, count = 64) =>
    Array.from({ length: count + 1 }, (_, i) => ({
      x: cx + r * Math.cos(a + ((b - a) * i) / count),
      y: cy + r * Math.sin(a + ((b - a) * i) / count),
    }));
  const theta = Math.acos(clamp((r1 - r2) / Math.max(d, 1e-9), -1, 1));
  const wheel = (cx: number, r: number, teeth: number, hole: number, left: boolean) => {
    const pitch = 2 * r * Math.sin(Math.PI / teeth);
    // Concave roller seats and narrow rounded tooth tips, not involute gear teeth.
    const profile: Point[] = [];
    const inset = (pitch / r) * 0.48;
    const start = s.single ? 0 : left ? -theta + inset : theta + inset,
      end = s.single ? TAU : left ? theta - inset : TAU - theta - inset;
    const count = Math.ceil(((end - start) / TAU) * teeth * 64);
    for (let i = 0; i <= count; i++) {
      const a = start + ((end - start) * i) / count;
      const t = ((((a / TAU) * teeth - 0.25) % 1) + 1) % 1;
      const u = t * 64,
        k = Math.min(63, Math.floor(u));
      const rr =
        r + pitch * (toothOffsets[k]! + (toothOffsets[k + 1]! - toothOffsets[k]!) * (u - k));
      const p = { x: cx + rr * Math.cos(a), y: rr * Math.sin(a) };
      if (s.single || Math.abs(p.y) * Math.sin(theta) + p.x * Math.cos(theta) < r1 - pitch * 0.51)
        profile.push(p);
    }
    paths.push(
      profile,
      arc(cx, 0, r - pitch * 0.55, 0, TAU, 128),
      arc(cx, 0, r - pitch * 0.46, 0, TAU, 128),
    );
    if (hole > 0) {
      const a = Math.acos(0.28),
        p = arc(cx, 0, hole, Math.PI - a, TAU + a, 80);
      p.push(
        { x: cx + hole * 0.28, y: hole * 1.15 },
        { x: cx - hole * 0.28, y: hole * 1.15 },
        p[0]!,
      );
      paths.push(p);
    }
  };
  wheel(0, r1, s.teeth, s.hole, true);
  if (!s.single) {
    wheel(d, r2, s.otherTeeth, s.otherHole, false);
    const straight = Math.sqrt(Math.max(0, d * d - (r1 - r2) ** 2));
    const rightArc = 2 * theta * r2,
      leftArc = (TAU - 2 * theta) * r1,
      total = 2 * straight + rightArc + leftArc;
    const nominal = 2 * r1 * Math.sin(Math.PI / s.teeth);
    const links = clamp(2 * Math.round(total / nominal / 2), 12, 512),
      step = total / links;
    const track = (z: number): Point => {
      if (z < straight) {
        const t = z / straight;
        return {
          x: r1 * Math.cos(theta) + straight * Math.sin(theta) * t,
          y: r1 * Math.sin(theta) - straight * Math.cos(theta) * t,
        };
      }
      z -= straight;
      if (z < rightArc) {
        const a = theta - z / r2;
        return { x: d + r2 * Math.cos(a), y: r2 * Math.sin(a) };
      }
      z -= rightArc;
      if (z < straight) {
        const t = z / straight;
        return {
          x: d + r2 * Math.cos(theta) - straight * Math.sin(theta) * t,
          y: -r2 * Math.sin(theta) - straight * Math.cos(theta) * t,
        };
      }
      z -= straight;
      const a = -theta - z / r1;
      return { x: r1 * Math.cos(a), y: r1 * Math.sin(a) };
    };
    const pins = Array.from({ length: links }, (_, i) => track(i * step));
    const w = step * 0.45;
    for (let i = 0; i < links; i++) {
      const a = pins[i]!,
        b = pins[(i + 1) % links]!,
        angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Alternating outer plates and the exposed sides of the inner plates.
      if (i % 2 === 0) {
        const p = [
          ...arc(b.x, b.y, w, angle - Math.PI / 2, angle + Math.PI / 2, 12),
          ...arc(a.x, a.y, w, angle + Math.PI / 2, angle + (3 * Math.PI) / 2, 12),
        ];
        p.push(p[0]!);
        paths.push(p);
      } else
        for (const sign of [-1, 1]) {
          const nx = -Math.sin(angle) * sign,
            ny = Math.cos(angle) * sign;
          const before = pins[(i + links - 1) % links]!,
            after = pins[(i + 2) % links]!;
          const beforeAngle = Math.atan2(a.y - before.y, a.x - before.x);
          const afterAngle = Math.atan2(after.y - b.y, after.x - b.x);
          // Meet the adjacent plate's cap exactly, including at a change of direction.
          paths.push([
            {
              x: a.x - Math.sin(beforeAngle) * sign * w,
              y: a.y + Math.cos(beforeAngle) * sign * w,
            },
            { x: (a.x + b.x) / 2 + nx * w * 0.82, y: (a.y + b.y) / 2 + ny * w * 0.82 },
            { x: b.x - Math.sin(afterAngle) * sign * w, y: b.y + Math.cos(afterAngle) * sign * w },
          ]);
        }
      paths.push(arc(a.x, a.y, step * 0.145, 0, TAU, 20));
    }
  }
  return paths.filter((path) => path.length > 1).map((path) => path.map((p) => world(p.x, p.y)));
}
