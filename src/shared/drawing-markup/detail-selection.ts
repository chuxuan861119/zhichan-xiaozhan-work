import { selectAnnotationIds } from "./annotation-selection.js";
import { detailMarkerAnnotation, detailRatioText } from "./detail-view.js";
import type { DrawingAnnotation, DrawingDetailView, DrawingPoint } from "./model.js";

export function detailTitleAnnotation(d: DrawingDetailView): DrawingAnnotation {
  const half =
    Math.max(1.3, d.label.length * 0.35, detailRatioText(d.ratio).length * 0.35) * d.fontSize;
  const top = d.title.y - d.fontSize * 0.55,
    bottom = d.title.y + d.fontSize * 2.05;
  return {
    id: `detail-title:${d.id}`,
    text: d.label,
    x: d.title.x,
    y: (top + bottom) / 2,
    fontSize: d.fontSize,
    lineWidth: d.lineWidth,
    points: [
      { x: d.title.x - half, y: top },
      { x: d.title.x + half, y: top },
      { x: d.title.x + half, y: bottom },
      { x: d.title.x - half, y: bottom },
      { x: d.title.x - half, y: top },
    ],
  };
}
export function detailContentAnnotation(d: DrawingDetailView): DrawingAnnotation {
  const r = d.radius * d.ratio;
  return {
    id: `detail-content:${d.id}`,
    text: "",
    x: d.center.x,
    y: d.center.y,
    fontSize: 1,
    lineWidth: d.lineWidth,
    points: Array.from({ length: 65 }, (_, i) => ({
      x: d.center.x + Math.cos((i * Math.PI) / 32) * r,
      y: d.center.y + Math.sin((i * Math.PI) / 32) * r,
    })),
  };
}
export function selectedDetailParts(d: DrawingDetailView, polygon: DrawingPoint[]) {
  return new Set(
    selectAnnotationIds(
      [
        detailContentAnnotation(d),
        ...(d.titleHidden ? [] : [detailTitleAnnotation(d)]),
        ...(d.markerHidden
          ? []
          : [
              detailMarkerAnnotation(d),
              {
                ...detailContentAnnotation({ ...d, center: d.source, ratio: 1 }),
                id: `detail-source:${d.id}`,
              },
            ]),
      ],
      polygon,
      false,
    ),
  );
}
export function moveDetailParts(
  d: DrawingDetailView,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): DrawingDetailView {
  const shift = (p: DrawingPoint) => ({ x: p.x + dx, y: p.y + dy });
  return {
    ...d,
    center: ids.has(`detail-content:${d.id}`) ? shift(d.center) : d.center,
    title: ids.has(`detail-title:${d.id}`) ? shift(d.title) : d.title,
    marker: ids.has(`detail-marker:${d.id}`) ? shift(d.marker) : d.marker,
    ...(ids.has(`detail-source:${d.id}`)
      ? {
          source: shift(d.source),
          fragments: d.fragments.map((f) => ({ ...f, offset: shift(f.offset) })),
        }
      : {}),
  };
}

export function translateDetailCopy(
  d: DrawingDetailView,
  dx: number,
  dy: number,
): DrawingDetailView {
  const shift = (p: DrawingPoint) => ({ x: p.x + dx, y: p.y + dy });
  return {
    ...d,
    center: shift(d.center),
    title: shift(d.title),
    marker: shift(d.marker),
    source: shift(d.source),
    fragments: d.fragments.map((f) => ({ ...f, offset: shift(f.offset) })),
  };
}
