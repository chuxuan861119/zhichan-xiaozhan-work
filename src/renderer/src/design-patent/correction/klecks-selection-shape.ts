export type SelectionPoint = [number, number];
export type SelectionRegion = SelectionPoint[][][];
export type SelectionShapeTool = "rectangle" | "ellipse" | "lasso" | "polygon";

/** Creates only a candidate; applying/combining it is the engine's responsibility. */
export function selectionShape(
  tool: SelectionShapeTool,
  points: readonly (readonly [number, number])[],
  options: {
    constrain?: boolean;
    fromCenter?: boolean;
    style?: "normal" | "ratio" | "fixed";
    width?: number;
    height?: number;
  } = {},
): SelectionRegion {
  if (
    points.length > 50_000 ||
    points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
  ) {
    throw new Error("选区坐标无效或过于复杂。");
  }
  if (tool === "lasso" || tool === "polygon") {
    if (points.length < 3) return [];
    const ring: SelectionPoint[] = points.map(([x, y]) => [x, y]);
    const first = ring[0];
    const last = ring.at(-1);
    if (!first || !last) return [];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    return [[ring]];
  }
  if (tool !== "rectangle" && tool !== "ellipse") throw new Error("未知选区工具。");
  const start = points[0];
  const end = points.at(-1);
  if (!start || !end || points.length < 2) return [];
  let dx = end[0] - start[0];
  let dy = end[1] - start[1];
  if (options.style === "fixed" || options.style === "ratio") {
    if (
      !Number.isFinite(options.width) ||
      !Number.isFinite(options.height) ||
      options.width! <= 0 ||
      options.height! <= 0 ||
      options.width! > 10000 ||
      options.height! > 10000
    )
      throw new Error("选框尺寸或比例无效。");
    if (options.style === "fixed") {
      dx = ((dx < 0 ? -1 : 1) * options.width!) / (options.fromCenter ? 2 : 1);
      dy = ((dy < 0 ? -1 : 1) * options.height!) / (options.fromCenter ? 2 : 1);
    } else {
      const ratio = options.width! / options.height!;
      if (Math.abs(dx) >= Math.abs(dy) * ratio) dy = ((dy < 0 ? -1 : 1) * Math.abs(dx)) / ratio;
      else dx = (dx < 0 ? -1 : 1) * Math.abs(dy) * ratio;
    }
  } else if (options.constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  if (dx === 0 || dy === 0) return [];
  const left = options.fromCenter ? start[0] - Math.abs(dx) : Math.min(start[0], start[0] + dx);
  const top = options.fromCenter ? start[1] - Math.abs(dy) : Math.min(start[1], start[1] + dy);
  const width = Math.abs(dx) * (options.fromCenter ? 2 : 1);
  const height = Math.abs(dy) * (options.fromCenter ? 2 : 1);
  if (tool === "rectangle") {
    return [
      [
        [
          [left, top],
          [left + width, top],
          [left + width, top + height],
          [left, top + height],
          [left, top],
        ],
      ],
    ];
  }
  const ring: SelectionPoint[] = Array.from({ length: 128 }, (_, index) => {
    const angle = (index / 128) * 2 * Math.PI;
    return [
      left + width / 2 + (Math.cos(angle) * width) / 2,
      top + height / 2 + (Math.sin(angle) * height) / 2,
    ];
  });
  const first = ring[0];
  if (first) ring.push([...first]);
  return [[ring]];
}
