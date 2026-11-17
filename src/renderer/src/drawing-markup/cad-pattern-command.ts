import type { DrawingPoint } from "../../../shared/drawing-markup/model";

export type PatternTool = "arrayrect" | "arraypolar" | "arraypath" | "hatch";
export const isPatternTool = (mode: string): mode is PatternTool =>
  ["arrayrect", "arraypolar", "arraypath", "hatch"].includes(mode);
export type PatternValues = {
  rows: string;
  cols: string;
  rowSpacing: string;
  colSpacing: string;
  axisAngle: string;
  count: string;
  angle: string;
  rotate: boolean;
  pattern: string;
  scale: string;
  hatchAngle: string;
  islandStyle: "normal" | "outer" | "ignore";
  gapTolerance?: string;
};
export const DEFAULT_PATTERN_VALUES: PatternValues = {
  rows: "1",
  cols: "3",
  rowSpacing: "10",
  colSpacing: "10",
  axisAngle: "0",
  count: "6",
  angle: "360",
  rotate: true,
  pattern: "ANSI31",
  scale: "1",
  hatchAngle: "0",
  islandStyle: "normal",
  gapTolerance: "",
};
export function compilePatternCommand(
  mode: PatternTool,
  values: PatternValues,
  handles: string[],
  point: DrawingPoint | DrawingPoint[] | null,
  editHatch = false,
  path?: string,
) {
  const number = (value: string, name: string) => {
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n)) throw new Error(`请输入有效的${name}。`);
    return n;
  };
  const count = (value: string, name: string) => {
    const n = number(value, name);
    if (!Number.isInteger(n) || n < 1 || n > 1000)
      throw new Error(`${name}须为 1 至 1000 的整数。`);
    return n;
  };
  if (mode !== "hatch" && !handles.length) throw new Error("请选择阵列对象，按 Enter 确认。");
  if (mode === "arraypath") {
    if (!path) throw new Error("请在画布上点选排列路径。");
    if (handles.includes(path)) throw new Error("排列路径不能同时作为阵列对象。");
    const n = count(values.count, "项目数");
    checkSize(n, handles.length);
    return { command: mode, params: { handles, path, count: n, align: values.rotate } };
  }
  if (mode === "arrayrect") {
    const rows = count(values.rows, "行数"),
      cols = count(values.cols, "列数");
    checkSize(rows * cols, handles.length);
    const rowSpacing = number(values.rowSpacing, "行间距"),
      colSpacing = number(values.colSpacing, "列间距");
    if ((rows > 1 && rowSpacing === 0) || (cols > 1 && colSpacing === 0))
      throw new Error("多行或多列的间距不能为 0，可使用负数反向排列。");
    return {
      command: mode,
      params: {
        handles,
        rows,
        cols,
        rowSpacing,
        colSpacing,
        axisAngle: number(values.axisAngle, "方向角"),
        associative: false,
      },
    };
  }
  if (mode === "arraypolar") {
    const n = count(values.count, "项目数"),
      angle = number(values.angle, "分布角度");
    checkSize(n, handles.length);
    if (!angle || Math.abs(angle) > 360)
      throw new Error("分布角度须在 −360° 至 360° 之间且不为 0。");
    if (!point || Array.isArray(point)) throw new Error("请在画布上指定阵列圆心。");
    return {
      command: mode,
      params: {
        handles,
        center: [point.x, point.y],
        count: n,
        angle,
        rotate: values.rotate,
        associative: false,
      },
    };
  }
  const scale = values.pattern === "SOLID" ? 1 : number(values.scale, "填充比例");
  if (scale <= 0) throw new Error("填充比例必须大于 0。");
  const gapTolerance = values.gapTolerance?.trim()
    ? number(values.gapTolerance, "缺口容差")
    : undefined;
  if (gapTolerance !== undefined && (gapTolerance < 0 || gapTolerance > 5000))
    throw new Error("缺口容差须在 0 至 5000 之间。");
  const points = Array.isArray(point) ? point : point ? [point] : [];
  if (!handles.length && !points.length) throw new Error("请点击封闭区域内部。");
  return {
    command: editHatch ? "hatchedit" : "hatch",
    params: {
      ...(handles.length ? { handles } : { points: points.map((p) => [p.x, p.y]) }),
      pattern: values.pattern,
      scale,
      angle: number(values.hatchAngle, "填充角度"),
      style: values.islandStyle,
      ...(!editHatch && gapTolerance !== undefined ? { gapTolerance } : {}),
      ...(!editHatch && points.length > 1 ? { separate: true } : {}),
    },
  };
}
function checkSize(items: number, objects: number) {
  if (items < 2) throw new Error("阵列至少需要 2 个项目（包含源对象）。");
  if (items > 1000 || items * objects > 10000)
    throw new Error("单次阵列最多 1000 个项目、10000 个对象，请减少数量或分批操作。");
}
