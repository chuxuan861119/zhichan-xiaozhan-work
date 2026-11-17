import { type Ref, useImperativeHandle, useState } from "react";
import { snapLabelToAnnotations } from "../../../shared/drawing-markup/annotation-alignment";
import { placeLabel } from "../../../shared/drawing-markup/label-layout";
import type { DrawingAnnotation, DrawingPoint } from "../../../shared/drawing-markup/model";
import { drawingLeaderWidth } from "../../../shared/drawing-markup/output-settings";
import type { Path } from "./cad-detail-gesture";
import { CAD_LABEL_FONT_FAMILY, cadLabelCssFontSize } from "./cad-label-font";
import "./cad-text-editor.css";

export type LabelPlacementPreviewHandle = { update(end: DrawingPoint): void };

export function LabelPlacementPreview(props: {
  ref?: Ref<LabelPlacementPreviewHandle>;
  start: DrawingPoint;
  end: DrawingPoint;
  text: string;
  fontSize: number;
  unitsPerPixel: number;
  viewWidth: number;
  references: readonly DrawingAnnotation[];
  cadText?: boolean;
  /** Native outlines normalized to a CAD capital height of one drawing unit. */
  glyphPaths?: readonly Path[] | undefined;
}) {
  const [end, setEnd] = useState(props.end);
  useImperativeHandle(props.ref, () => ({ update: setEnd }), []);
  const { label, guides } = snapLabelToAnnotations(
    placeLabel(props.start, end, props.text, props.fontSize, props.unitsPerPixel),
    props.references,
    props.unitsPerPixel * 8,
  );
  return (
    <g data-drawing-preview="label" pointerEvents="none">
      {guides.map((guide) => (
        <line
          key={guide.axis}
          data-label-align-guide={guide.axis}
          x1={guide.from.x}
          y1={guide.from.y}
          x2={guide.to.x}
          y2={guide.to.y}
          stroke="#15966c"
          strokeWidth={props.unitsPerPixel}
          strokeDasharray={`${props.unitsPerPixel * 5} ${props.unitsPerPixel * 4}`}
        />
      ))}
      <polyline
        points={label.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke="black"
        strokeWidth={drawingLeaderWidth(props.unitsPerPixel)}
        strokeDasharray={`${props.viewWidth / 180} ${props.viewWidth / 250}`}
      />
      {props.glyphPaths?.length ? (
        <g data-label-native-glyph transform={`translate(${label.x} ${label.y}) scale(${props.fontSize} ${-props.fontSize})`}>
          {props.glyphPaths.map((path, index) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: Immutable CAD glyph path order.
              key={index}
              d={path.d}
              fill={path.fill}
              stroke={path.stroke}
              strokeWidth={path.width}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      ) : (
        <text
          x={label.x}
          y={label.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily={props.cadText ? CAD_LABEL_FONT_FAMILY : "Arial, sans-serif"}
          fontSize={props.cadText ? cadLabelCssFontSize(props.fontSize) : props.fontSize}
          fontWeight={400}
          fill="black"
        >
          {props.text}
        </text>
      )}
    </g>
  );
}
