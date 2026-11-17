type ProfilePoint = [number, number];

export function joinVisibleTurns(
  paths: ProfilePoint[][],
  turns: number,
  width: number,
  extend = true,
): void {
  const cross = (a: ProfilePoint, b: ProfilePoint) => a[0] * b[1] - a[1] * b[0];
  for (let index = 1; index < 2 * turns; index++) {
    if (index === turns) continue;
    const current = paths[index] as ProfilePoint[],
      previous = paths[index - 1] as ProfilePoint[];
    const start = current[0] as ProfilePoint;
    let best:
      | { point: ProfilePoint; distance: number; segment: number; extend: boolean }
      | undefined;
    // Recompute occlusion joins after changing wire size. The sampled end of
    // a hidden branch may have to extend before it meets the next visible turn.
    for (let i = 0; i < Math.floor(current.length / 2); i++) {
      const p = current[i] as ProfilePoint,
        next = current[i + 1] as ProfilePoint;
      const u: ProfilePoint = [next[0] - p[0], next[1] - p[1]];
      for (let j = Math.floor(previous.length / 2); j < previous.length - 1; j++) {
        const q = previous[j] as ProfilePoint,
          end = previous[j + 1] as ProfilePoint;
        const v: ProfilePoint = [end[0] - q[0], end[1] - q[1]];
        const delta: ProfilePoint = [q[0] - p[0], q[1] - p[1]];
        const determinant = cross(u, v);
        if (Math.abs(determinant) < 1e-12) continue;
        const t = cross(delta, v) / determinant,
          s = cross(delta, u) / determinant;
        if ((i > 0 && t < 0) || t > 1 || s < 0 || ((!extend || j < previous.length - 2) && s > 1))
          continue;
        const point: ProfilePoint = [p[0] + t * u[0], p[1] + t * u[1]];
        if (point[1] < 0 || point[1] > width) continue;
        const distance = Math.hypot(point[0] - start[0], point[1] - start[1]);
        if (!best || distance < best.distance)
          best = { point, distance, segment: i, extend: s > 1 };
      }
    }
    if (best) {
      paths[index] = [best.point, ...current.slice(best.segment + 1)];
      if (best.extend) previous.push(best.point);
    }
  }
}
