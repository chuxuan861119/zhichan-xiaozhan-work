import profile from "../../../shared/drawing-markup/extension-spring-profile.json";

type Point = [number, number];

function removeSeamLoop(path: Point[]): Point[] {
  for (let i = 0; i < path.length - 1; i++)
    for (let j = i + 2; j < path.length - 1; j++) {
      const p = path[i]!,
        b = path[i + 1]!,
        q = path[j]!,
        d = path[j + 1]!;
      const ux = b[0] - p[0],
        uy = b[1] - p[1],
        vx = d[0] - q[0],
        vy = d[1] - q[1];
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-12) continue;
      const t = ((q[0] - p[0]) * vy - (q[1] - p[1]) * vx) / det;
      const s = ((q[0] - p[0]) * uy - (q[1] - p[1]) * ux) / det;
      if (t <= 1e-7 || t >= 1 - 1e-7 || s <= 1e-7 || s >= 1 - 1e-7) continue;
      return removeSeamLoop([
        ...path.slice(0, i + 1),
        [p[0] + t * ux, p[1] + t * uy],
        ...path.slice(j + 1),
      ]);
    }
  return path;
}

/** Cut the hidden branch at its actual silhouette, never at the sample-count midpoint. */
function trimCoilStarts(paths: Point[][], order: number[], extend = true) {
  for (let k = 1; k < order.length; k++) {
    const current = paths[order[k]!]!,
      previous = paths[order[k - 1]!]!;
    let hit: { point: Point; segment: number; position: number } | undefined;
    const middle = (current[0]![1] + current.at(-1)![1]) / 2;
    let bend = 0;
    current.forEach((p, i) => {
      if (Math.abs(p[1] - middle) > Math.abs(current[bend]![1] - middle)) bend = i;
    });
    if (bend === 0 || bend === current.length - 1) bend = Math.floor(current.length / 2);
    for (let i = 0; i < bend; i++) {
      const p = current[i]!,
        b = current[i + 1]!;
      const ux = b[0] - p[0],
        uy = b[1] - p[1];
      for (let j = 0; j < previous.length - 1; j++) {
        const q = previous[j]!,
          d = previous[j + 1]!;
        const vx = d[0] - q[0],
          vy = d[1] - q[1],
          det = ux * vy - uy * vx;
        if (Math.abs(det) < 1e-12) continue;
        const t = ((q[0] - p[0]) * vy - (q[1] - p[1]) * vx) / det;
        const s = ((q[0] - p[0]) * uy - (q[1] - p[1]) * ux) / det;
        if (((i > 0 || !extend) && t < 0) || t > 1 || s < 0 || s > 1) continue;
        const point: Point = [p[0] + t * ux, p[1] + t * uy];
        const position = i + t;
        if (!hit || position > hit.position) hit = { point, segment: i, position };
      }
    }
    if (hit) paths[order[k]!] = [hit.point, ...current.slice(hit.segment + 1)];
  }
}

/** Visible outlines sampled from the supplied side projection, not a sine-wave symbol.
 * Hooks scale uniformly; only the coil pitch changes when the axis is stretched. */
export function extensionSpringPaths(
  length: number,
  width: number,
  wire: number,
  turns: number,
): [number, number][][] {
  const hookScale = (width - wire) / (profile.referenceWidth - profile.referenceWire);
  const extra = (turns - profile.referenceTurns) * profile.referencePitch;
  const bodyEnd = 63.85 + extra;
  const bodyScale = (length - 2 * width + wire) / (turns * profile.referencePitch);
  const paths: [number, number][][] = [];
  const append = (index: number, shift = 0) => {
    // The reference's clipped spline ends curl backwards over a few samples.
    // They are occlusion cut-offs, not physical bends in the wire.
    let template = profile.paths[index]!;
    if (index === 4 || index === 5 || index === 8) template = template.slice(0, -4);
    if (index === 7) template = template.slice(0, -6);
    paths.push(
      template.map(([x = 0, y = 0], i): [number, number] => {
        const a = template[Math.max(0, i - 1)]!,
          b = template[Math.min(template.length - 1, i + 1)]!;
        const dx = b[0]! - a[0]!,
          dy = b[1]! - a[1]!,
          size = Math.hypot(dx, dy);
        const nx = dy / size,
          ny = -dx / size;
        const center = x + shift - (profile.referenceWire / 2) * nx;
        const across = y - (profile.referenceWire / 2) * ny;
        const scale = center <= 18.85 || center >= bodyEnd ? hookScale : bodyScale;
        const along =
          center <= 18.85
            ? wire / 2 + (center - 1.15) * hookScale
            : center >= bodyEnd
              ? length - wire / 2 - (81.55 + extra - center) * hookScale
              : width - wire / 2 + (center - 18.85) * bodyScale;
        const n = Math.hypot(nx / scale, ny / hookScale);
        return [
          along + ((wire / 2) * nx) / scale / n,
          wire / 2 + (across - 1.15) * hookScale + ((wire / 2) * ny) / hookScale / n,
        ];
      }),
    );
  };
  for (const i of [0, 1, 2, 3, 4]) append(i);
  for (let i = 0; i < turns - 1; i++) append(5, i * 3);
  append(6, extra);
  append(7, extra);
  for (let i = 0; i < turns - 1; i++) append(8, i * 3);
  append(9);
  for (const i of [10, 11, 12, 13]) append(i, extra);
  const order = [
    ...Array.from({ length: turns + 1 }, (_, i) => 4 + i),
    5 + turns,
    ...Array.from({ length: turns - 1 }, (_, i) => 4 + 2 * turns - i),
    5 + 2 * turns,
  ];
  // A hook stem and its first half-turn form one silhouette for the next coil.
  const topStem = paths[2]!,
    bottomStem = paths[7 + 2 * turns]!;
  paths[2] = [...topStem, ...paths[4]!.slice(1)];
  paths[7 + 2 * turns] = [...bottomStem, ...paths[5 + turns]!.slice(1)];
  trimCoilStarts(paths, [2, ...order.slice(1, turns + 1)]);
  trimCoilStarts(paths, [7 + 2 * turns, ...order.slice(turns + 2)]);
  paths[2] = topStem;
  paths[7 + 2 * turns] = bottomStem;
  const joinEnd = (a: number, b: number, extend = true) => {
    paths[a]!.reverse();
    trimCoilStarts(paths, [b, a], extend);
    paths[a]!.reverse();
  };
  for (let i = 0; i < turns - 1; i++) {
    joinEnd(5 + i, 6 + turns + i);
    joinEnd(6 + turns + i, 5 + i);
  }
  joinEnd(4, 5 + 2 * turns);
  joinEnd(5 + turns, 4 + turns);
  // At touching pitch the next turn hides part of the outgoing branch too.
  for (let i = 0; i < turns - 1; i++) {
    const right = i === turns - 2 ? 7 + 2 * turns : 7 + turns + i;
    joinEnd(5 + i, right, false);
  }
  joinEnd(4, 6 + turns, false);
  for (let i = 0; i < turns - 1; i++) {
    joinEnd(6 + turns + i, i === 0 ? 2 : 4 + i, false);
  }
  joinEnd(5 + turns, 3 + turns, false);
  // Join separately sampled arcs and hook stems after changing wire diameter.
  const snap = (a: number, ai: number, b: number, bi: number) => {
    paths[b]![bi < 0 ? paths[b]!.length - 1 : bi] = paths[a]![ai < 0 ? paths[a]!.length - 1 : ai]!;
  };
  snap(0, -1, 2, 0);
  snap(1, 0, 3, -1);
  snap(2, -1, 4, 0);
  snap(3, 0, 5 + 2 * turns, -1);
  snap(4 + turns, -1, 6 + 2 * turns, 0);
  snap(5 + turns, 0, 7 + 2 * turns, -1);
  snap(8 + 2 * turns, 0, 6 + 2 * turns, -1);
  snap(9 + 2 * turns, -1, 7 + 2 * turns, 0);
  const trimStem = (stem: number, coil: number, occluder: number) => {
    const count = paths[stem]!.length;
    const original = paths[coil]!;
    paths[coil] = removeSeamLoop([...paths[stem]!, ...original.slice(1)]);
    joinEnd(coil, occluder, false);
    const joined = paths[coil]!;
    const seam = Math.min(count - 1, joined.length - 2);
    paths[stem] = joined.slice(0, seam + 1);
    paths[coil] = joined.slice(seam);
  };
  trimStem(2, 4, 6 + turns);
  trimStem(7 + 2 * turns, 5 + turns, 3 + turns);
  // Clipping a neighbouring turn can move its silhouette past a previous join.
  // Close only sub-wire sampling gaps; never bridge separated turns.
  for (let a = 4; a <= 5 + 2 * turns; a++) {
    const path = paths[a]!;
    for (const index of [0, path.length - 1]) {
      const p = path[index]!;
      let distance = wire * 0.05,
        nearest: Point | undefined;
      for (let b = 2; b <= 7 + 2 * turns; b++) {
        if (a === b) continue;
        const other = paths[b]!;
        for (let j = 1; j < other.length; j++) {
          const q = other[j - 1]!,
            end = other[j]!;
          const dx = end[0] - q[0],
            dy = end[1] - q[1];
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / (dx * dx + dy * dy)),
          );
          const point: Point = [q[0] + t * dx, q[1] + t * dy];
          const gap = Math.hypot(point[0] - p[0], point[1] - p[1]);
          if (gap < distance) {
            distance = gap;
            nearest = point;
          }
        }
      }
      if (nearest) path[index] = nearest;
    }
  }
  const result = paths.map((path) => path.map(([x, y]): [number, number] => [x, width / 2 - y]));
  // Flat cut ends of the open hooks. No additional user-visible end settings.
  result.push([result[0]![0]!, result[1]![result[1]!.length - 1]!]);
  result.push([
    result[9 + 2 * turns]![0]!,
    result[8 + 2 * turns]![result[8 + 2 * turns]!.length - 1]!,
  ]);
  return result;
}
