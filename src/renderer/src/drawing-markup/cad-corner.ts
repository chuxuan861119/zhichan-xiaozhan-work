import type { DrawingPoint as P } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

type E = CadScene["entities"][number];
type G = NonNullable<E["geometry"]>;
type V = NonNullable<G["vertices"]>[number];
export type CornerKind = "fillet" | "chamfer";
export type CornerValue = { kind: CornerKind; a: number; b: number };
export type CadCorner = {
  corner: P;
  keep1: P;
  keep2: P;
  u1: P;
  u2: P;
  room1: number;
  room2: number;
  theta: number;
  first: E;
  second: E;
  near1: P;
  near2: P;
  poly?: { i: number; j: number } | undefined;
  existing?: E | undefined;
  probe: P[];
  value?: CornerValue;
};
export type CornerChange = {
  params: {
    handles: string[];
    edits: { handle: string; before: G; after: G }[];
    create?: { commonFrom: string; geometry: G };
    connector?: string;
  };
  paths: P[][];
};
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: P, n: number): P => ({ x: a.x * n, y: a.y * n });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;
const len = (a: P) => Math.hypot(a.x, a.y);
const dist = (a: P, b: P) => len(sub(a, b));
const mid = (a: P, b: P) => mul(add(a, b), 0.5);
const v3 = (a: P) => ({ ...a, z: 0 });
const key = (p: P) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
function meet(a: P, b: P, c: P, d: P): P | null {
  const u = sub(b, a),
    v = sub(d, c),
    den = cross(u, v);
  return Math.abs(den) > 1e-10 * len(u) * len(v) ? add(a, mul(u, cross(sub(c, a), v) / den)) : null;
}
function target(
  first: E,
  second: E,
  keep1: P,
  near1: P,
  near2: P,
  keep2: P,
  poly?: CadCorner["poly"],
  existing?: E,
): CadCorner | null {
  const corner = meet(keep1, near1, near2, keep2);
  if (!corner) return null;
  const room1 = dist(corner, keep1),
    room2 = dist(corner, keep2);
  if (Math.min(room1, room2) < 1e-8) return null;
  const u1 = mul(sub(keep1, corner), 1 / room1),
    u2 = mul(sub(keep2, corner), 1 / room2),
    theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-5 || theta > Math.PI - 1e-5) return null;
  const a = dot(sub(near1, corner), u1),
    b = dot(sub(near2, corner), u2);
  if (a < -1e-6 || b < -1e-6 || a >= room1 - 1e-8 || b >= room2 - 1e-8) return null;
  return {
    corner,
    keep1,
    keep2,
    u1,
    u2,
    room1,
    room2,
    theta,
    first,
    second,
    near1,
    near2,
    poly,
    existing,
    probe: [corner],
  };
}
function arcPoints(a: P, b: P, bulge: number): P[] {
  if (Math.abs(bulge) < 1e-10) return [a, b];
  const chord = sub(b, a),
    length = len(chord),
    center = add(mid(a, b), mul({ x: -chord.y, y: chord.x }, (1 - bulge * bulge) / (4 * bulge)));
  const radius = dist(center, a),
    angle = Math.atan2(a.y - center.y, a.x - center.x),
    sweep = 4 * Math.atan(bulge),
    n = Math.max(8, Math.ceil(Math.abs(sweep) * 24));
  if (!length) return [a];
  return Array.from({ length: n + 1 }, (_, i) =>
    add(center, {
      x: radius * Math.cos(angle + (sweep * i) / n),
      y: radius * Math.sin(angle + (sweep * i) / n),
    }),
  );
}
function polyPoints(g: G): P[] {
  const vs = g.vertices ?? [],
    out: P[] = [];
  for (let i = 0; i < vs.length - (g.closed ? 0 : 1); i++) {
    const a = vs[i]!,
      b = vs[(i + 1) % vs.length]!;
    if (a.p && b.p) out.push(...arcPoints(a.p, b.p, a.bulge));
  }
  return out;
}
const cache = new WeakMap<CadScene, Map<CornerKind, CadCorner[]>>();
export function cornerCandidates(scene: CadScene, kind: CornerKind): CadCorner[] {
  let cached = cache.get(scene);
  if (!cached) {
    cached = new Map();
    cache.set(scene, cached);
  }
  const hit = cached.get(kind);
  if (hit) return hit;
  const result: CadCorner[] = [],
    ends = new Map<string, { e: E; near: P; far: P }[]>();
  const push = (t: CadCorner | null, bulge = 0) => {
    if (!t) return;
    if (dist(t.near1, t.near2) > 1e-6) {
      if (kind === "fillet" && Math.abs(bulge) < 1e-10) return;
      if (
        kind === "fillet" &&
        Math.abs(
          bulge - Math.tan((Math.sign(cross(mul(t.u1, -1), t.u2)) * (Math.PI - t.theta)) / 4),
        ) > 1e-5
      )
        return;
      if (kind === "chamfer" && Math.abs(bulge) > 1e-10) return;
      const a = dist(t.corner, t.near1),
        b = dist(t.corner, t.near2);
      if (kind === "fillet" && Math.abs(a - b) > 1e-5 * Math.max(1, a, b)) return;
      t.value = { kind, a: kind === "fillet" ? a * Math.tan(t.theta / 2) : a, b };
      t.probe = Math.abs(bulge) > 1e-10 ? arcPoints(t.near1, t.near2, bulge) : [t.near1, t.near2];
    }
    result.push(t);
  };
  for (const e of scene.entities) {
    if (e.locked || e.visible === false) continue;
    const g = e.geometry;
    if (!g) continue;
    if (g.type === "line" && g.a && g.b) {
      for (const [near, far] of [
        [g.a, g.b],
        [g.b, g.a],
      ]) {
        const k = key(near!);
        const list = ends.get(k) ?? [];
        list.push({ e, near: near!, far: far! });
        ends.set(k, list);
      }
    }
    if (g.type !== "lwPolyline" || !g.vertices) continue;
    const vs = g.vertices,
      n = vs.length,
      ns = n - (g.closed ? 0 : 1);
    for (let i = 0; i < ns; i++) {
      for (const gap of [0, 1]) {
        const j = (i + 1 + gap) % ns;
        if (!g.closed && i + 1 + gap >= ns) continue;
        const a = vs[i]!,
          b = vs[(i + 1) % n]!,
          c = vs[j]!,
          d = vs[(j + 1) % n]!;
        if (!a.p || !b.p || !c.p || !d.p || Math.abs(a.bulge) > 1e-10 || Math.abs(c.bulge) > 1e-10)
          continue;
        const bulge = gap ? b.bulge : 0;
        const t = target(e, e, a.p, b.p, c.p, d.p, { i, j }, gap ? e : undefined);
        push(t, bulge);
      }
    }
  }
  for (const list of ends.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!,
          b = list[j]!;
        if (a.e.handle !== b.e.handle && dist(a.near, b.near) < 1e-6)
          push(target(a.e, b.e, a.far, a.near, b.near, b.far));
      }
  for (const e of scene.entities) {
    const g = e.geometry;
    if (!g || e.locked || e.visible === false) continue;
    let a: P | undefined,
      b: P | undefined,
      bulge = 0;
    if (kind === "chamfer" && g.type === "line") {
      a = g.a;
      b = g.b;
    }
    if (
      kind === "fillet" &&
      g.type === "arc" &&
      g.center &&
      g.radius &&
      g.start !== undefined &&
      g.end !== undefined
    ) {
      a = add(g.center, { x: g.radius * Math.cos(g.start), y: g.radius * Math.sin(g.start) });
      b = add(g.center, { x: g.radius * Math.cos(g.end), y: g.radius * Math.sin(g.end) });
      let sweep = (g.end - g.start) % (Math.PI * 2);
      if (sweep <= 0) sweep += Math.PI * 2;
      bulge = Math.tan(sweep / 4);
    }
    if (!a || !b) continue;
    for (const l of ends.get(key(a)) ?? [])
      for (const r of ends.get(key(b)) ?? []) {
        if (l.e.handle === e.handle || r.e.handle === e.handle || l.e.handle === r.e.handle)
          continue;
        const t = target(l.e, r.e, l.far, a, b, r.far, undefined, e);
        if (kind === "fillet" && t && g.center) {
          if (
            Math.abs(dot(sub(a, g.center), t.u1)) > 1e-5 * Math.max(1, g.radius ?? 0) ||
            Math.abs(dot(sub(b, g.center), t.u2)) > 1e-5 * Math.max(1, g.radius ?? 0)
          )
            continue;
        }
        push(t, bulge);
      }
  }
  cached.set(kind, result);
  return result;
}
function segmentDistance(p: P, a: P, b: P) {
  const d = sub(b, a),
    t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1)));
  return dist(p, add(a, mul(d, t)));
}
export function cornerAt(
  scene: CadScene,
  kind: CornerKind,
  p: P,
  tolerance: number,
  allowed: (h: string) => boolean = () => true,
) {
  let best: CadCorner | undefined,
    distance = tolerance;
  for (const t of cornerCandidates(scene, kind)) {
    if (
      ![t.first.handle, t.second.handle, ...(t.existing ? [t.existing.handle] : [])].every(allowed)
    )
      continue;
    const d =
      t.probe.length === 1
        ? dist(p, t.corner)
        : Math.min(...t.probe.slice(1).map((b, i) => segmentDistance(p, t.probe[i]!, b)));
    if (d <= distance) {
      distance = d;
      best = t;
    }
  }
  return best;
}
export function clampCorner(t: CadCorner, v: CornerValue): CornerValue {
  const max1 = t.room1 * 0.98,
    max2 = t.room2 * 0.98;
  return {
    ...v,
    a: Math.max(
      1e-6,
      Math.min(v.a, v.kind === "fillet" ? Math.min(max1, max2) * Math.tan(t.theta / 2) : max1),
    ),
    b: Math.max(1e-6, Math.min(v.b, max2)),
  };
}
export function cornerGrips(t: CadCorner, value: CornerValue): P[] {
  const v = clampCorner(t, value);
  if (v.kind === "fillet") {
    const bisector = mul(add(t.u1, t.u2), 1 / len(add(t.u1, t.u2)));
    return [add(t.corner, mul(bisector, v.a * (1 / Math.sin(t.theta / 2) - 1)))];
  }
  const a = add(t.corner, mul(t.u1, v.a)),
    b = add(t.corner, mul(t.u2, v.b));
  return [mid(a, b), a, b];
}
export function dragCorner(t: CadCorner, value: CornerValue, index: number, p: P): CornerValue {
  let { a, b } = value;
  if (value.kind === "fillet") {
    const bisector = mul(add(t.u1, t.u2), 1 / len(add(t.u1, t.u2)));
    a = dot(sub(p, t.corner), bisector) / (1 / Math.sin(t.theta / 2) - 1);
  } else if (index === 1) a = dot(sub(p, t.corner), t.u1);
  else if (index === 2) b = dot(sub(p, t.corner), t.u2);
  else {
    const m = sub(cornerGrips(t, value)[0]!, t.corner),
      scale = Math.max(0, dot(sub(p, t.corner), m) / (dot(m, m) || 1));
    a *= scale;
    b *= scale;
  }
  return clampCorner(t, { ...value, a, b });
}
export function cornerGeometry(t: CadCorner, value: CornerValue): CornerChange {
  const v = clampCorner(t, value),
    d1 = v.kind === "fillet" ? v.a / Math.tan(t.theta / 2) : v.a,
    d2 = v.kind === "fillet" ? d1 : v.b;
  const a = add(t.corner, mul(t.u1, d1)),
    b = add(t.corner, mul(t.u2, d2)),
    turn = Math.sign(cross(mul(t.u1, -1), t.u2)),
    bulge = v.kind === "fillet" ? Math.tan((turn * (Math.PI - t.theta)) / 4) : 0;
  const edits: CornerChange["params"]["edits"] = [],
    paths: P[][] = [];
  const connector: G =
    v.kind === "fillet"
      ? (() => {
          const center = add(
            t.corner,
            mul(add(t.u1, t.u2), v.a / (Math.sin(t.theta / 2) * len(add(t.u1, t.u2)))),
          );
          const start = Math.atan2(a.y - center.y, a.x - center.x),
            end = Math.atan2(b.y - center.y, b.x - center.x);
          return {
            type: "arc",
            center: v3(center),
            radius: v.a,
            start: turn > 0 ? start : end,
            end: turn > 0 ? end : start,
          };
        })()
      : { type: "line", a: v3(a), b: v3(b) };
  if (t.poly) {
    const g = t.first.geometry!,
      vs = g.vertices!,
      n = vs.length,
      { i, j } = t.poly;
    const rotated = g.closed ? [...vs.slice(i), ...vs.slice(0, i)] : vs;
    const ii = g.closed ? 0 : i,
      jj = g.closed ? (j + n - i) % n : j,
      template = rotated[ii + 1]!;
    const next: V[] = [
      ...rotated.slice(0, ii + 1),
      { ...template, p: a, bulge },
      { ...template, p: b, bulge: 0 },
      ...rotated.slice(jj + 1),
    ];
    const after = { ...g, vertices: next };
    edits.push({ handle: t.first.handle, before: g, after });
    paths.push(polyPoints(after));
  } else {
    for (const [e, near, at] of [
      [t.first, t.near1, a],
      [t.second, t.near2, b],
    ] as const) {
      const g = e.geometry!;
      const after = {
        ...g,
        ...(dist(g.a!, near) < dist(g.b!, near)
          ? { a: { ...g.a!, ...at } }
          : { b: { ...g.b!, ...at } }),
      };
      edits.push({ handle: e.handle, before: g, after });
      paths.push([after.a!, after.b!]);
    }
    if (t.existing)
      edits.push({ handle: t.existing.handle, before: t.existing.geometry!, after: connector });
    paths.push(arcPoints(a, b, bulge));
  }
  return {
    params: {
      handles: edits.map((e) => e.handle),
      edits,
      ...(!t.poly && !t.existing
        ? { create: { commonFrom: t.first.handle, geometry: connector } }
        : {}),
      ...(t.existing ? { connector: t.existing.handle } : {}),
    },
    paths,
  };
}
