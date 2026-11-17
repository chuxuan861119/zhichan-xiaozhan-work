import { memo } from "react";
import type { DrawingAnnotation } from "../../../shared/drawing-markup/model";
import { drawingLeaderWidth } from "../../../shared/drawing-markup/output-settings";
import { CAD_LABEL_FONT_FAMILY, cadLabelCssFontSize } from "./cad-label-font";
import "./cad-text-editor.css";

export const DrawingAnnotationView = memo(function DrawingAnnotationView({
  annotation: a,
  nativeVisual = false,
  cadText = false,
  selected,
  handles,
  clipped,
  color,
  viewWidth,
  unitsPerPixel,
  canvasWidth,
  lineweightMm,
}: {
  annotation: DrawingAnnotation;
  nativeVisual?: boolean;
  cadText?: boolean;
  selected: boolean;
  handles: boolean;
  clipped: boolean;
  color: string;
  viewWidth: number;
  unitsPerPixel: number;
  canvasWidth: number;
  lineweightMm?: number;
}) {
  const points = a.points.map((p) => `${p.x},${p.y}`).join(" ");
  const showOverlay = !nativeVisual;
  return (
    <g
      data-annotation={a.id}
      data-selected={selected ? "true" : undefined}
      className="drawing-annotation"
    >
      {a.points.length > 0 && (
        <>
          <polyline points={points} fill="none" stroke="transparent" strokeWidth={viewWidth / 60} />
          {showOverlay && <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth={
              (lineweightMm === undefined ? drawingLeaderWidth(unitsPerPixel) : Math.max(0.5,lineweightMm*96/25.4)*unitsPerPixel)
            }
            strokeLinejoin="round"
            strokeLinecap="round"
          />}
        </>
      )}
      <text
        className={clipped ? "is-clipped" : undefined}
        x={a.x}
        y={a.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={cadText ? CAD_LABEL_FONT_FAMILY : "Arial, sans-serif"}
        fontSize={cadText ? cadLabelCssFontSize(a.fontSize) : a.fontSize}
        fontWeight={400}
        fill={color}
        opacity={showOverlay ? undefined : 0}
        pointerEvents="all"
      >
        {a.text}
      </text>
      {handles &&
        a.points.map((p, i) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: Leader slots remain stable while coordinates move.
            key={`${a.id}-${i}`}
            data-point-index={i}
            cx={p.x}
            cy={p.y}
            r={(viewWidth / Math.max(1, canvasWidth)) * 3}
            fill="white"
            stroke="var(--drawing-grip, #c45a00)"
            strokeWidth={viewWidth / 900}
          />
        ))}
    </g>
  );
});
