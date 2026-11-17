import { type ReactNode, type Ref, useImperativeHandle, useState } from "react";
import type { DrawingDetailView, DrawingPoint } from "../../../shared/drawing-markup/model";

export type DetailPointerHandle = { update(point: DrawingPoint): void };

/** Pointer-only drafts must not rerender the workspace and its function rail. */
export function DetailPointerPreview({
  ref,
  initial,
  children,
}: {
  ref: Ref<DetailPointerHandle>;
  initial: DrawingPoint;
  children(point: DrawingPoint): ReactNode;
}) {
  const [point, setPoint] = useState(initial);
  useImperativeHandle(ref, () => ({ update: setPoint }), []);
  return children(point);
}

export function detailAtPointer(
  detail: DrawingDetailView,
  point: DrawingPoint,
  marker?: DrawingPoint,
): DrawingDetailView {
  const dx = point.x - detail.center.x,
    dy = point.y - detail.center.y;
  return {
    ...detail,
    center: point,
    title: { x: detail.title.x + dx, y: detail.title.y + dy },
    ...(marker ? { marker } : {}),
  };
}
