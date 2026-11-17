import { type Ref, useImperativeHandle, useState } from "react";
import type { LabelAlignmentGuide } from "../../../shared/drawing-markup/annotation-alignment";
import { type CadMapping, pageToCad } from "../../../shared/drawing-markup/cad-state";
import type { DrawingAnnotation } from "../../../shared/drawing-markup/model";
import { drawingLeaderWidth } from "../../../shared/drawing-markup/output-settings";
import type { Path } from "./cad-detail-gesture";
import { CAD_LABEL_FONT_FAMILY, cadLabelCssFontSize } from "./cad-label-font";
import "./cad-text-editor.css";

export type LabelDragPreviewHandle = {
  update(annotation: DrawingAnnotation, guides: LabelAlignmentGuide[]): void;
};

export function LabelDragPreview(props: {
  ref?: Ref<LabelDragPreviewHandle>;
  annotation: DrawingAnnotation;
  glyphPaths?: readonly Path[] | undefined;
  mapping?: CadMapping | undefined;
  cadText?: boolean;
  unitsPerPixel: number;
}) {
  const [live, setLive] = useState({
    annotation: props.annotation,
    guides: [] as LabelAlignmentGuide[],
  });
  useImperativeHandle(
    props.ref,
    () => ({
      update(annotation, guides) {
        setLive({ annotation, guides });
      },
    }),
    [],
  );
  const { annotation, guides } = live;
  const from = props.mapping ? pageToCad(props.annotation, props.mapping) : props.annotation;
  const to = props.mapping ? pageToCad(annotation, props.mapping) : annotation;
  return (
    <g data-label-drag-preview pointerEvents="none">
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
        points={annotation.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke="#007AFF"
        strokeWidth={drawingLeaderWidth(props.unitsPerPixel)}
      />
      {props.glyphPaths?.length && props.mapping ? (
        <g
          transform={`matrix(${props.mapping.scale} 0 0 ${-props.mapping.scale} ${-props.mapping.originX * props.mapping.scale} ${props.mapping.originY * props.mapping.scale})`}
        >
          <g data-label-glyph-shift transform={`translate(${to.x - from.x} ${to.y - from.y})`}>
            {props.glyphPaths.map((path, index) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable CAD glyph path order.
                key={index}
                d={path.d}
                fill={path.fill === "none" ? "none" : "#007AFF"}
                stroke={path.stroke === "none" ? "none" : "#007AFF"}
                strokeWidth={path.width}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </g>
      ) : (
        <text
          x={annotation.x}
          y={annotation.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily={props.cadText ? CAD_LABEL_FONT_FAMILY : "Arial, sans-serif"}
          fontSize={props.cadText ? cadLabelCssFontSize(annotation.fontSize) : annotation.fontSize}
          fill="#007AFF"
        >
          {annotation.text}
        </text>
      )}
    </g>
  );
}
