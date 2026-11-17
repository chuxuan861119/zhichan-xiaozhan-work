import { bounds } from "./geometry.js";
import type { DrawingAnnotation, DrawingOutput, DrawingRegion } from "./model.js";

/**
 * 引出线线宽（mm）。不允许用户设置：成图里永远按这条物理线宽渲染，
 * 画布用同一基准换算，所以图纸单位、取图范围、DPI 怎么变都不会走样。
 */
export const DRAWING_LEADER_WIDTH_MM = 0.3;

/** Convert the fixed physical leader weight to the current drawing coordinate system. */
export function drawingLeaderWidth(unitsPerPixel: number, dpi = 96): number {
  return ((DRAWING_LEADER_WIDTH_MM * dpi) / 25.4) * unitsPerPixel;
}

export const defaultDrawingOutput = (): DrawingOutput => ({
  widthMm: 120,
  dpi: 300,
  mode: "drawing",
  labelHeightMm: 3.5,
  leaderWidthMm: 0.1,
});
// Missing settings belong to existing work: never silently change its appearance.
export const drawingOutput = (region: DrawingRegion): DrawingOutput =>
  region.output ?? { ...defaultDrawingOutput(), mode: "drawing" };

type AnnotationStyleSource = Pick<DrawingAnnotation, "fontSize" | "lineWidth">;

/** 标号样式的换算基准：输出框宽度对应多少图形单位；统一编排时再带上毫米字号。 */
export type DrawingAnnotationScale = Readonly<{ unitsPerMm: number; labelHeightMm?: number }>;

function scaledStyle(annotation: AnnotationStyleSource, scale: DrawingAnnotationScale) {
  return {
    fontSize:
      scale.labelHeightMm === undefined
        ? annotation.fontSize
        : scale.labelHeightMm * scale.unitsPerMm,
    // 引出线线宽不再是标号属性：永远按固定物理线宽换算，画布与成图共用这一条。
    lineWidth: DRAWING_LEADER_WIDTH_MM * scale.unitsPerMm,
  };
}

/**
 * 取图范围的换算基准。旧工作稿的范围还没有输出规格、或拖动中角点交叉让范围暂时退化时
 * 返回 null，此时沿用标号自身样式，绘制过程不抛错；导出时 outputSize 仍会拒绝无效范围。
 */
export function drawingAnnotationScale(
  points: DrawingRegion["points"],
  output: DrawingOutput | undefined,
): DrawingAnnotationScale | null {
  if (!output) return null;
  let width: number;
  try {
    width = bounds(points).width;
  } catch {
    return null;
  }
  const unitsPerMm = width / output.widthMm;
  if (!(unitsPerMm > 0)) return null;
  return output.mode === "uniform"
    ? { unitsPerMm, labelHeightMm: output.labelHeightMm }
    : { unitsPerMm };
}

/**
 * 还没框选范围时的基准：以整张图纸宽度和当前输出宽度为准，
 * 引出线线宽因此与「整张图按该宽度成图」时一致。
 */
export function wholeDrawingAnnotationScale(
  drawingWidthUnits: number,
  output: DrawingOutput,
): DrawingAnnotationScale | null {
  const unitsPerMm = drawingWidthUnits / output.widthMm;
  if (!Number.isFinite(unitsPerMm) || unitsPerMm <= 0) return null;
  return { unitsPerMm };
}

export function annotationOutputStyle(
  annotation: AnnotationStyleSource,
  scale: DrawingAnnotationScale | null,
) {
  if (!scale) return { fontSize: annotation.fontSize, lineWidth: annotation.lineWidth };
  return scaledStyle(annotation, scale);
}

/**
 * 写进标号自带线宽字段的数值。模型把这个字段限制在 0.1～100，而换算结果在极端图纸单位下
 * 可能超出区间；这里夹住，避免整份工作稿为了一个只作兜底的字段存不下去。
 */
export function storedAnnotationLineWidth(scale: DrawingAnnotationScale | null) {
  const units = scale ? DRAWING_LEADER_WIDTH_MM * scale.unitsPerMm : DRAWING_LEADER_WIDTH_MM;
  return Math.min(100, Math.max(0.1, units));
}
