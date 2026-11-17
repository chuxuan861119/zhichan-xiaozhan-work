import { type Ref, useImperativeHandle, useState } from "react";
import { cadToPage } from "../../../shared/drawing-markup/cad-state";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";
import { EDITABLE_CAD_STROKE_WIDTH } from "./fixed-line-preview";

export type PendingCadDrawing = {
  sequence: number;
  primitives: CadScene["primitives"];
  lineAnchor?: DrawingPoint;
  text?: { at: [number, number]; text: string; height: number };
};
export type PendingCadDrawingsHandle = {
  append(drawing: PendingCadDrawing): void;
  painted(sequence: number): void;
};

/** Finished native geometry remains visible until its durable preview is painted. */
export function CadPendingDrawings({
  ref,
  project,
}: {
  ref: Ref<PendingCadDrawingsHandle>;
  project: DrawingProject;
}) {
  const [drawings, setDrawings] = useState<PendingCadDrawing[]>([]);
  useImperativeHandle(ref, () => ({
    append: (drawing) => setDrawings((old) => [...old, drawing]),
    painted: (sequence) => setDrawings((old) => old.filter((item) => item.sequence > sequence)),
  }));
  if (!project.cad || !drawings.length) return null;
  const mapping = project.cad.mapping;
  return (
    <g data-cad-pending-drawings pointerEvents="none">
      {drawings.map((drawing) => (
        <g key={drawing.sequence} data-cad-drawing-sequence={drawing.sequence}>
          {drawing.primitives.map((primitive, index) => (
            <polyline
              // biome-ignore lint/suspicious/noArrayIndexKey: Native tessellation order is frozen within an immutable stroke.
              key={`${primitive.handle}-${index}`}
              points={(primitive.kind==="point"?[primitive.points[0]!,primitive.points[0]!]:primitive.points)
                .map(([x, y]) => {
                  const point = cadToPage({ x, y }, mapping);
                  return `${point.x},${point.y}`;
                })
                .join(" ")}
              stroke={primitive.aci7 ? "#000" : `rgb(${primitive.color.join(",")})`}
              strokeWidth={Math.max(0.5,primitive.lineweight/0.25)*EDITABLE_CAD_STROKE_WIDTH}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {drawing.text && (
            <text
              x={cadToPage({ x: drawing.text.at[0], y: drawing.text.at[1] }, mapping).x}
              y={cadToPage({ x: drawing.text.at[0], y: drawing.text.at[1] }, mapping).y}
              fontSize={drawing.text.height * mapping.scale}
              fill="#000"
            >
              {drawing.text.text}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}
