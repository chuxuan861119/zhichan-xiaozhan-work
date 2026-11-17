import { leaderPoints } from "./label-layout.js";
import type { DrawingAnnotation, DrawingPoint } from "./model.js";

type LabelDraft = Pick<DrawingAnnotation, "x" | "y" | "text" | "fontSize" | "points">;
export type LabelAlignmentGuide = {
  axis: "horizontal" | "vertical";
  from: DrawingPoint;
  to: DrawingPoint;
};
export type LabelArrangementBounds = { left: number; top: number; right: number; bottom: number };

export function snapLabelToAnnotations(
  label: LabelDraft,
  references: readonly DrawingAnnotation[],
  threshold: number,
): { label: LabelDraft; guides: LabelAlignmentGuide[] } {
  if (!(threshold > 0) || !Number.isFinite(threshold)) return { label, guides: [] };
  let vertical: DrawingAnnotation | undefined;
  let horizontal: DrawingAnnotation | undefined;
  let verticalDistance = threshold;
  let horizontalDistance = threshold;
  for (const reference of references) {
    const dx = Math.abs(reference.x - label.x);
    const dy = Math.abs(reference.y - label.y);
    if (dx <= verticalDistance && (!vertical || dx < verticalDistance)) {
      vertical = reference;
      verticalDistance = dx;
    }
    if (dy <= horizontalDistance && (!horizontal || dy < horizontalDistance)) {
      horizontal = reference;
      horizontalDistance = dy;
    }
  }
  if (!vertical && !horizontal) return { label, guides: [] };
  const moved = {
    ...label,
    x: vertical?.x ?? label.x,
    y: horizontal?.y ?? label.y,
  };
  moved.points = leaderPoints(moved);
  const to = { x: moved.x, y: moved.y };
  const guides: LabelAlignmentGuide[] = [];
  if (vertical) guides.push({ axis: "vertical", from: { x: vertical.x, y: vertical.y }, to });
  if (horizontal)
    guides.push({ axis: "horizontal", from: { x: horizontal.x, y: horizontal.y }, to });
  return { label: moved, guides };
}

export function alignSelectedAnnotations(
  annotations: readonly DrawingAnnotation[],
  ids: ReadonlySet<string>,
  axis: "horizontal" | "vertical",
  bounds: LabelArrangementBounds,
  options?: { figure?: LabelArrangementBounds },
): readonly DrawingAnnotation[] | null {
  const selected = annotations.filter((annotation) => ids.has(annotation.id));
  if (selected.length < 2) return annotations;
  const horizontal = axis === "horizontal";
  const sizes = new Map(
    annotations.map((annotation) => [
      annotation.id,
      {
        x:
          Math.max(
            0.35,
            [...annotation.text].reduce(
              (width, character) => width + (/^[0-9]$/.test(character) ? 0.7 : 1),
              0,
            ) / 2,
          ) * annotation.fontSize,
        y: annotation.fontSize * 0.55,
      },
    ]),
  );
  const size = (annotation: DrawingAnnotation) => sizes.get(annotation.id)!;
  const anchor = (annotation: DrawingAnnotation) =>
    annotation.points.at(-2) ?? { x: annotation.x, y: annotation.y };
  const ordered = [...selected].sort(
    (a, b) =>
      (horizontal ? anchor(a).x - anchor(b).x : anchor(a).y - anchor(b).y) ||
      (horizontal ? a.x - b.x : a.y - b.y) ||
      a.id.localeCompare(b.id),
  );
  const maxFont = Math.max(...selected.map((annotation) => annotation.fontSize));
  const margin = maxFont * 0.5;
  const figureGap = maxFont * 4;
  const halfSpans = ordered.map((annotation) =>
    horizontal ? size(annotation).x : size(annotation).y,
  );
  const totalTextSpan = halfSpans.reduce((sum, half) => sum + half * 2, 0);
  const anchors = ordered.map((annotation) =>
    horizontal ? anchor(annotation).x : anchor(annotation).y,
  );
  const anchorSpan = Math.max(...anchors) - Math.min(...anchors);
  const minimumGap = maxFont * 0.5;
  const localSpan = Math.max(
    anchorSpan + Math.max(...halfSpans) * 2,
    totalTextSpan + minimumGap * (ordered.length - 1),
  );
  const figureStart = options?.figure && (horizontal ? options.figure.left : options.figure.top);
  const figureEnd = options?.figure && (horizontal ? options.figure.right : options.figure.bottom);
  const lowerBound = Math.max(
    (horizontal ? bounds.left : bounds.top) + margin,
    figureStart === undefined ? -Infinity : figureStart - maxFont * 2,
  );
  const upperBound = Math.min(
    (horizontal ? bounds.right : bounds.bottom) - margin,
    figureEnd === undefined ? Infinity : figureEnd + maxFont * 2,
  );
  if (!Number.isFinite(localSpan) || localSpan > upperBound - lowerBound) return null;
  const averageAlong = options?.figure
    ? anchors.reduce((sum, value) => sum + value, 0) / anchors.length
    : selected.reduce((sum, annotation) => sum + (horizontal ? annotation.x : annotation.y), 0) /
      selected.length;
  const start = Math.max(lowerBound, Math.min(upperBound - localSpan, averageAlong - localSpan / 2));
  const end = start + localSpan;
  const free = end - start - totalTextSpan;
  const gap = free / (ordered.length - 1);
  if (!Number.isFinite(gap) || gap < minimumGap - 1e-8) return null;
  const along = new Map<string, number>();
  let cursor = start;
  for (let index = 0; index < ordered.length; index++) {
    const annotation = ordered[index]!;
    along.set(annotation.id, cursor + halfSpans[index]!);
    cursor += halfSpans[index]! * 2 + gap;
  }
  const perpendicular = horizontal ? "y" : "x";
  const halfPerpendicular = Math.max(
    ...selected.map((annotation) => (horizontal ? size(annotation).y : size(annotation).x)),
  );
  const low = (horizontal ? bounds.top : bounds.left) + margin + halfPerpendicular;
  const high = (horizontal ? bounds.bottom : bounds.right) - margin - halfPerpendicular;
  if (low > high) return null;
  const average =
    selected.reduce((sum, annotation) => sum + annotation[perpendicular], 0) / selected.length;
  const preferred = Math.max(low, Math.min(high, average));
  const candidates = options?.figure
    ? [
        (horizontal ? options.figure.top : options.figure.left) - figureGap - halfPerpendicular,
        (horizontal ? options.figure.bottom : options.figure.right) + figureGap + halfPerpendicular,
      ]
        .filter((target) => target >= low && target <= high)
        .sort((a, b) => Math.abs(a - average) - Math.abs(b - average))
    : [preferred];
  if (!options?.figure) {
    const localShift = Math.max(
      maxFont * 3,
      ...selected.map((annotation) =>
        Math.abs(anchor(annotation)[perpendicular] - preferred) + maxFont,
      ),
    );
    for (let step = 1; step <= 12; step++) {
      const offset = (localShift * step) / 12;
      if (preferred - offset >= low) candidates.push(preferred - offset);
      if (preferred + offset <= high) candidates.push(preferred + offset);
    }
  }
  const box = (annotation: DrawingAnnotation) => {
    const half = size(annotation);
    return {
      left: annotation.x - half.x,
      right: annotation.x + half.x,
      top: annotation.y - half.y,
      bottom: annotation.y + half.y,
    };
  };
  const overlaps = (a: DrawingAnnotation, b: DrawingAnnotation) => {
    const first = box(a),
      second = box(b);
    return (
      first.left < second.right &&
      first.right > second.left &&
      first.top < second.bottom &&
      first.bottom > second.top
    );
  };
  const segmentHitsBox = (p: DrawingPoint, q: DrawingPoint, rectangle: ReturnType<typeof box>) => {
    let enter = 0, leave = 1;
    for (const [start, delta, minimum, maximum] of [
      [p.x, q.x - p.x, rectangle.left, rectangle.right],
      [p.y, q.y - p.y, rectangle.top, rectangle.bottom],
    ] as const) {
      if (Math.abs(delta) < 1e-9) {
        if (start < minimum || start > maximum) return false;
      } else {
        const first = (minimum - start) / delta;
        const second = (maximum - start) / delta;
        enter = Math.max(enter, Math.min(first, second));
        leave = Math.min(leave, Math.max(first, second));
        if (enter > leave) return false;
      }
    }
    return true;
  };
  const leaderHitsText = (leader: DrawingAnnotation, text: DrawingAnnotation) => {
    const target = box(text);
    for (let index = 1; index < leader.points.length; index++)
      if (segmentHitsBox(leader.points[index - 1]!, leader.points[index]!, target)) return true;
    return false;
  };
  const segmentsCross = (p: DrawingPoint, q: DrawingPoint, r: DrawingPoint, s: DrawingPoint) => {
    if (
      Math.max(p.x, q.x) < Math.min(r.x, s.x) ||
      Math.max(r.x, s.x) < Math.min(p.x, q.x) ||
      Math.max(p.y, q.y) < Math.min(r.y, s.y) ||
      Math.max(r.y, s.y) < Math.min(p.y, q.y)
    )
      return false;
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-8 || Math.hypot(s.x - r.x, s.y - r.y) < 1e-8)
      return false;
    const cross = (u: DrawingPoint, v: DrawingPoint, w: DrawingPoint) =>
      (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
    const c1 = cross(p, q, r),
      c2 = cross(p, q, s);
    const c3 = cross(r, s, p),
      c4 = cross(r, s, q);
    if ([c1, c2, c3, c4].every((value) => Math.abs(value) < 1e-8)) {
      const overlapX =
        Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) -
        Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x));
      const overlapY =
        Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) -
        Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y));
      return overlapX >= -1e-8 && overlapY >= -1e-8 && (overlapX > 1e-8 || overlapY > 1e-8);
    }
    return c1 * c2 <= 0 && c3 * c4 <= 0;
  };
  const terminalCrosses = (a: DrawingAnnotation, b: DrawingAnnotation) => {
    const p = a.points.at(-2),
      q = a.points.at(-1);
    if (!p || !q) return false;
    for (let index = 1; index < b.points.length; index++) {
      if (segmentsCross(p, q, b.points[index - 1]!, b.points[index]!)) return true;
    }
    return false;
  };
  const crosses = (a: DrawingAnnotation, b: DrawingAnnotation) =>
    terminalCrosses(a, b) || (ids.has(b.id) && terminalCrosses(b, a));
  const others = annotations.filter((annotation) => !ids.has(annotation.id));
  for (const target of candidates) {
    const arranged = selected.map((annotation) => {
      const moved = {
        ...annotation,
        x: horizontal ? along.get(annotation.id)! : target,
        y: horizontal ? target : along.get(annotation.id)!,
        points: options?.figure && annotation.points.length >= 2
          ? [annotation.points[0]!, { x: annotation.x, y: annotation.y }]
          : annotation.points,
      };
      return { ...moved, points: leaderPoints(moved) };
    });
    let conflict = false;
    for (let index = 0; index < arranged.length && !conflict; index++) {
      const annotation = arranged[index]!;
      for (let next = index + 1; next < arranged.length; next++) {
        const other = arranged[next]!;
        if (overlaps(annotation, other) || crosses(annotation, other) ||
            leaderHitsText(annotation, other) || leaderHitsText(other, annotation)) {
          conflict = true;
          break;
        }
      }
      if (!conflict)
        conflict = others.some(
          (other) => overlaps(annotation, other) || crosses(annotation, other) ||
            leaderHitsText(annotation, other) || leaderHitsText(other, annotation),
        );
    }
    if (conflict) continue;
    const byId = new Map(arranged.map((annotation) => [annotation.id, annotation]));
    if (
      selected.every((annotation) => {
        const next = byId.get(annotation.id)!;
        return annotation.x === next.x && annotation.y === next.y;
      })
    )
      return annotations;
    return annotations.map((annotation) => byId.get(annotation.id) ?? annotation);
  }
  return null;
}
