import type { CadScene } from "./cadcraft-client";

/** Keep unchanged object identities and draw order when an edit only supplies a delta. */
export function mergeCadScene(before: CadScene, delta: CadScene): CadScene {
  if (!delta.partial) return delta;
  const replaced = new Set([
    ...delta.entities.map((e) => e.handle),
    ...(delta.removedHandles ?? []),
  ]);
  const entities = new Map(delta.entities.map((e) => [e.handle, e]));
  const primitives = new Map<string, CadScene["primitives"]>();
  for (const p of delta.primitives) {
    const list = primitives.get(p.handle) ?? [];
    list.push(p);
    primitives.set(p.handle, list);
  }
  const nextEntities = before.entities.flatMap((e) => {
    if (!replaced.has(e.handle)) return [e];
    const next = entities.get(e.handle);
    entities.delete(e.handle);
    return next ? [next] : [];
  });
  nextEntities.push(...entities.values());
  const nextPrimitives = before.primitives.flatMap((p) => {
    if (!replaced.has(p.handle)) return [p];
    const next = primitives.get(p.handle) ?? [];
    primitives.delete(p.handle);
    return next;
  });
  for (const ps of primitives.values()) nextPrimitives.push(...ps);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of nextPrimitives) {
    // Native infinite primitives store [base, direction], and intentionally
    // do not contribute to render bounds (the second point is not an endpoint).
    if (p.kind === "infinite" || p.kind === "ray") continue;
    for (const [x, y] of p.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const bounds = Number.isFinite(minX)
    ? { min: [minX, minY] as [number, number], max: [maxX, maxY] as [number, number] }
    : null;
  const w = bounds ? Math.max(maxX - minX, 1e-9) : 1,
    h = bounds ? Math.max(maxY - minY, 1e-9) : 1,
    m = Math.max(w, h) * 0.02;
  return {
    ...delta,
    partial: false,
    entities: nextEntities,
    primitives: nextPrimitives,
    bounds,
    svgFrame: {
      origin: bounds ? [minX - m, maxY + m] : [0, 1],
      width: w + 2 * m,
      height: h + 2 * m,
    },
  };
}

/** Compare once per entity, never once per rendered primitive. */
export function cadSceneDelta(before: CadScene, after: CadScene) {
  if (after.partial) {
    const changed = new Set(after.entities.map((e) => e.handle));
    const touched = new Set([...changed, ...(after.removedHandles ?? [])]);
    return { changed, touched };
  }
  const original = new Map(before.entities.map((e) => [e.handle, JSON.stringify(e.geometry)]));
  const present = new Set(after.entities.map((e) => e.handle));
  const changed = new Set(
    after.entities
      .filter(
        (e) => !original.has(e.handle) || original.get(e.handle) !== JSON.stringify(e.geometry),
      )
      .map((e) => e.handle),
  );
  const touched = new Set([
    ...changed,
    ...before.entities.filter((e) => !present.has(e.handle)).map((e) => e.handle),
  ]);
  return { changed, touched };
}
