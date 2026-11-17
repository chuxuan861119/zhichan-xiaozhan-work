import type { DrawingBaseFragment, DrawingPoint, DrawingProject } from "./model.js";

export function translatePolygon(points: DrawingPoint[], dx: number, dy: number) {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}
export function baseFragments(
  project: Pick<DrawingProject, "baseFragments" | "width" | "height">,
): DrawingBaseFragment[] {
  return (
    project.baseFragments ?? [
      {
        id: "original",
        offset: { x: 0, y: 0 },
        holes: [],
        clips: [
          [
            { x: 0, y: 0 },
            { x: project.width, y: 0 },
            { x: project.width, y: project.height },
            { x: 0, y: project.height },
          ],
        ],
      },
    ]
  );
}
function box(points: DrawingPoint[]) {
  return {
    left: Math.min(...points.map((p) => p.x)),
    right: Math.max(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
}
// Conservative pruning: never discard a concave intersection based on sampled points.
function visible(fragment: DrawingBaseFragment) {
  const boxes = fragment.clips.map(box);
  const b = {
    left: Math.max(...boxes.map((b) => b.left)),
    right: Math.min(...boxes.map((b) => b.right)),
    top: Math.max(...boxes.map((b) => b.top)),
    bottom: Math.min(...boxes.map((b) => b.bottom)),
  };
  if (b.right <= b.left || b.bottom <= b.top) return false;
  return !fragment.holes.some((hole) => {
    if (fragment.clips.some((clip) => JSON.stringify(clip) === JSON.stringify(hole))) return true;
    const h = box(hole);
    const rectangle =
      hole.length === 4 &&
      new Set(hole.map((p) => `${p.x},${p.y}`)).size === 4 &&
      hole.every(
        (p, i) =>
          (p.x === h.left || p.x === h.right) &&
          (p.y === h.top || p.y === h.bottom) &&
          (p.x === hole[(i + 1) % 4]?.x || p.y === hole[(i + 1) % 4]?.y),
      );
    return (
      rectangle && h.left <= b.left && h.right >= b.right && h.top <= b.top && h.bottom >= b.bottom
    );
  });
}
export function extractBase(project: DrawingProject, selection: DrawingPoint[]) {
  return baseFragments(project)
    .map((f) => {
      const clip = selection.map((p) => fragmentLocalPoint(f, p));
      return f.clips.some((c) => JSON.stringify(c) === JSON.stringify(clip))
        ? f
        : { ...f, clips: [...f.clips, clip] };
    })
    .filter(visible);
}
export function translateFragments(
  fragments: DrawingBaseFragment[],
  dx: number,
  dy: number,
  prefix?: string,
) {
  return fragments.map((f, i) => ({
    ...f,
    id: prefix ? `${prefix}-${i}` : f.id,
    offset: { x: f.offset.x + dx, y: f.offset.y + dy },
  }));
}
export function moveBase(
  project: DrawingProject,
  selection: DrawingPoint[],
  dx: number,
  dy: number,
  prefix: string,
) {
  const remaining = baseFragments(project)
    .map((f) => ({
      ...f,
      holes: [...f.holes, selection.map((p) => fragmentLocalPoint(f, p))],
    }))
    .filter(visible);
  return [...remaining, ...translateFragments(extractBase(project, selection), dx, dy, prefix)];
}

export function scalePoint(
  point: DrawingPoint,
  anchor: DrawingPoint,
  factor: number,
): DrawingPoint {
  return {
    x: anchor.x + (point.x - anchor.x) * factor,
    y: anchor.y + (point.y - anchor.y) * factor,
  };
}
export function scaleBase(
  project: DrawingProject,
  selection: DrawingPoint[],
  anchor: DrawingPoint,
  factor: number,
  prefix: string,
) {
  const fragments = moveBase(project, selection, 0, 0, prefix);
  return fragments.map((fragment) =>
    fragment.id.startsWith(`${prefix}-`)
      ? {
          ...fragment,
          offset: scalePoint(fragment.offset, anchor, factor),
          scale: (fragment.scale ?? 1) * factor,
        }
      : fragment,
  );
}

export function rotatePoint(
  point: DrawingPoint,
  anchor: DrawingPoint,
  degrees: number,
): DrawingPoint {
  const angle = (degrees * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const x = point.x - anchor.x,
    y = point.y - anchor.y;
  return { x: anchor.x + x * c - y * s, y: anchor.y + x * s + y * c };
}
export function fragmentWorldPoint(
  fragment: DrawingBaseFragment,
  point: DrawingPoint,
): DrawingPoint {
  const rotated = rotatePoint(point, { x: 0, y: 0 }, fragment.rotation ?? 0);
  return {
    x: fragment.offset.x + rotated.x * (fragment.scale ?? 1),
    y: fragment.offset.y + rotated.y * (fragment.scale ?? 1),
  };
}
export function fragmentLocalPoint(
  fragment: DrawingBaseFragment,
  point: DrawingPoint,
): DrawingPoint {
  const rotated = rotatePoint(
    { x: point.x - fragment.offset.x, y: point.y - fragment.offset.y },
    { x: 0, y: 0 },
    -(fragment.rotation ?? 0),
  );
  return { x: rotated.x / (fragment.scale ?? 1), y: rotated.y / (fragment.scale ?? 1) };
}
export function deleteBase(project: DrawingProject, selection: DrawingPoint[]) {
  return baseFragments(project)
    .map((f) => ({ ...f, holes: [...f.holes, selection.map((p) => fragmentLocalPoint(f, p))] }))
    .filter(visible);
}
export function rotateBase(
  project: DrawingProject,
  selection: DrawingPoint[],
  anchor: DrawingPoint,
  degrees: number,
  prefix: string,
) {
  return [
    ...deleteBase(project, selection),
    ...extractBase(project, selection).map((f, i) => ({
      ...f,
      id: `${prefix}-${i}`,
      offset: rotatePoint(f.offset, anchor, degrees),
      rotation: ((f.rotation ?? 0) + degrees) % 360,
    })),
  ];
}
