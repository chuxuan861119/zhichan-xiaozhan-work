import { baseFragments, fragmentLocalPoint } from "./base-fragments.js";
import { leaderPoints } from "./label-layout.js";
import type {
  DrawingAnnotation,
  DrawingDetailView,
  DrawingPoint,
  DrawingProject,
} from "./model.js";

export function parseDetailRatio(value: string): number | null {
  const parts = value.trim().split(/[:：]/u);
  if (parts.length > 2 || parts.some((p) => !p.trim())) return null;
  const values = parts.map(Number);
  if (values.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const ratio = values[0]! / (values[1] ?? 1);
  return ratio >= 0.1 && ratio <= 100 ? ratio : null;
}
export const detailRatioText = (ratio: number) => `${Math.round(ratio * 10) / 10}:1`;
export function nextDetailLabel(previous: string, occupied: string[]) {
  const used = new Set(occupied);
  const maxLength = 100;
  let label = previous;
  for (let attempt = 0; attempt <= used.size; attempt++) {
    if (/^[A-Z]+$/u.test(label)) {
      const chars = [...label];
      let i = chars.length - 1;
      while (i >= 0 && chars[i] === "Z") {
        chars[i] = "A";
        i--;
      }
      if (i < 0) chars.unshift("A");
      else chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      label = chars.join("");
    } else {
      const match = label.match(/^(.*?)(\d+)$/u);
      label = match ? `${match[1]}${BigInt(match[2]!) + 1n}` : `${label}1`;
    }
    if (label.length > maxLength) break;
    if (!used.has(label)) return label;
  }
  // Keep overflowed names valid; this fixed prefix makes every bounded suffix distinct.
  const prefix = previous.slice(0, maxLength - String(used.size + 1).length - 1);
  for (let suffix = 1; suffix <= used.size + 1; suffix++) {
    const candidate = `${prefix}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("无法生成未使用的局部放大标记。");
}
export function createDetailView(
  project: DrawingProject,
  source: DrawingPoint,
  radius: number,
  center: DrawingPoint,
  label: string,
  ratio: number,
  fontSize: number,
  lineWidth: number,
  id: string,
): DrawingDetailView {
  const parent = [
    ...(project.cad?.unified && !project.cad.overlayAssetId ? [] : (project.detailViews ?? [])),
  ]
    .reverse()
    .find((d) => Math.hypot(source.x - d.center.x, source.y - d.center.y) <= d.radius * d.ratio);
  const fragments = parent
    ? parent.fragments.map((f) => {
        const offset = {
          x: parent.center.x + (f.offset.x - parent.source.x) * parent.ratio,
          y: parent.center.y + (f.offset.y - parent.source.y) * parent.ratio,
        };
        const transform = (points: DrawingPoint[]) =>
          points.map((p) => ({ x: p.x * parent.ratio, y: p.y * parent.ratio }));
        const boundary = Array.from({ length: 1024 }, (_, i) => ({
          x:
            parent.center.x +
            Math.cos((i * Math.PI * 2) / 1024) * parent.radius * parent.ratio -
            offset.x,
          y:
            parent.center.y +
            Math.sin((i * Math.PI * 2) / 1024) * parent.radius * parent.ratio -
            offset.y,
        }));
        return {
          ...f,
          offset,
          clips: [
            ...f.clips.map(transform),
            boundary.map((p) => fragmentLocalPoint({ ...f, offset: { x: 0, y: 0 } }, p)),
          ],
          holes: f.holes.map(transform),
        };
      })
    : structuredClone(
        project.cad?.unified && !project.cad.overlayAssetId && !project.baseFragments
          ? [
              {
                id: "original",
                offset: { x: 0, y: 0 },
                holes: [],
                // Native CAD is an infinite canvas. Only the requested source
                // area clips a new detail, not the obsolete SVG page rectangle.
                clips: [
                  [
                    { x: source.x - radius, y: source.y - radius },
                    { x: source.x + radius, y: source.y - radius },
                    { x: source.x + radius, y: source.y + radius },
                    { x: source.x - radius, y: source.y + radius },
                  ],
                ],
              },
            ]
          : baseFragments(project),
      );
  return {
    ...(parent ? { sourceScale: (parent.sourceScale ?? 1) * parent.ratio } : {}),
    ...(parent?.cadSource && !project.cad?.unified
      ? { cadSource: parent.cadSource }
      : project.cad
        ? {
            cadSource: {
              ...project.cad,
              baseAssetId: project.baseAssetId,
              width: project.width,
              height: project.height,
            },
          }
        : {}),
    id,
    label,
    source,
    radius,
    center,
    ratio,
    fontSize,
    lineWidth,
    title: { x: center.x, y: center.y - radius * ratio - fontSize * 3 },
    marker: { x: source.x - radius - fontSize * 3, y: source.y - radius - fontSize * 2 },
    fragments,
  };
}
export function resizeDetail(detail: DrawingDetailView, ratio: number): DrawingDetailView {
  return {
    ...detail,
    ratio,
    title: { ...detail.title, y: detail.title.y - detail.radius * (ratio - detail.ratio) },
  };
}
export function moveDetail(detail: DrawingDetailView, dx: number, dy: number): DrawingDetailView {
  return { ...detail, center: { x: detail.center.x + dx, y: detail.center.y + dy } };
}
export function detailMarkerAnnotation(detail: DrawingDetailView): DrawingAnnotation {
  const dx = detail.marker.x - detail.source.x,
    dy = detail.marker.y - detail.source.y;
  const length = Math.hypot(dx, dy) || 1;
  const anchor = {
    x: detail.source.x + (dx / length) * detail.radius,
    y: detail.source.y + (dy / length) * detail.radius,
  };
  const marker = {
    id: `detail-marker:${detail.id}`,
    lineWidth: detail.lineWidth,
    text: detail.label,
    fontSize: detail.fontSize,
    x: detail.marker.x,
    y: detail.marker.y,
    points: [anchor, detail.marker],
  };
  return { ...marker, points: leaderPoints(marker) };
}
export function detailLeader(detail: DrawingDetailView) {
  return detailMarkerAnnotation(detail).points;
}
