import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import { resolveCadSnap } from "./cad-object-snap";
import type { CadScene } from "./cadcraft-client";

export const EXTRA_CAD_TOOLS = [
  ["arc", "三点圆弧", 3],
  ["ellipse", "椭圆", 3],
  ["polygon", "正多边形", 2],
  ["mirror", "镜像", 2],
  ["break", "打断", 2],
  ["dimlinear", "线性标注", 3],
  ["dimaligned", "对齐标注", 3],
  ["dimradius", "半径标注", 1],
  ["offset", "偏移", 1],
  ["trim", "修剪", 1],
  ["extend", "延伸", 1],
  ["fillet", "圆角", 2],
  ["chamfer", "倒角", 2],
] as const;
export type ExtraCadTool = (typeof EXTRA_CAD_TOOLS)[number][0];

export function compileCadGesture(
  command: ExtraCadTool,
  points: DrawingPoint[],
  handles: string[],
  amount: number,
) {
  const required = EXTRA_CAD_TOOLS.find((tool) => tool[0] === command)![2];
  if (points.length < required) return null;
  const coordinates = points.map((point) => [point.x, point.y]);
  const [p1, p2, p3] = coordinates;
  let params: Record<string, unknown>;
  switch (command) {
    case "arc":
      params = { p1, p2, p3 };
      break;
    case "ellipse": {
      const a = points[0]!,
        b = points[1]!,
        c = points[2]!;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const firstRadius = Math.hypot(dx, dy);
      const secondRadius = Math.hypot(c.x - a.x, c.y - a.y);
      const ratio = secondRadius / firstRadius;
      if (!Number.isFinite(ratio) || ratio <= 0)
        throw new Error("请指定中心、第一条轴端点和另一条轴的半径，两条轴均须大于 0。");
      // DXF stores a major axis and a ratio <= 1; input order need not match storage order.
      params =
        ratio <= 1
          ? { center: p1, major: [dx, dy], ratio }
          : { center: p1, major: [-dy * ratio || 0, dx * ratio || 0], ratio: 1 / ratio };
      break;
    }
    case "polygon":
      if (!Number.isInteger(amount) || amount < 3 || amount > 20)
        throw new Error("边数须为 3 至 20 的整数。");
      params = {
        sides: amount,
        angle:
          (Math.atan2(points[1]!.y - points[0]!.y, points[1]!.x - points[0]!.x) * 180) / Math.PI,
        center: p1,
        radius: Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y),
      };
      break;
    case "mirror":
      if (!handles.length) throw new Error("请先选择对象。");
      params = { handles, p1, p2 };
      break;
    case "break":
      if (handles.length !== 1) throw new Error("请先只选择一个对象。");
      params = { handle: handles[0], p1, p2 };
      break;
    case "dimlinear":
    case "dimaligned":
      params = { p1, p2, at: p3 };
      break;
    case "dimradius":
      if (handles.length !== 1) throw new Error("请先选择一个圆或圆弧。");
      params = { handle: handles[0], at: p1 };
      break;
    case "offset":
      if (handles.length !== 1 || !(amount > 0) || !Number.isFinite(amount))
        throw new Error("请选择一个对象并输入大于 0 的偏移距离。");
      params = { handle: handles[0], distance: amount, side: p1 };
      break;
    case "trim":
    case "extend":
      if (!handles.length) throw new Error("请先选择要修剪或延伸的对象。");
      params = {
        handle: handles[0],
        pick: p1,
        ...(handles.length > 1 ? { edges: handles.slice(1) } : {}),
      };
      break;
    case "fillet":
    case "chamfer":
      if (handles.length !== 2 || !(amount >= 0) || !Number.isFinite(amount))
        throw new Error("请按顺序选择两个对象并输入非负距离，然后依次点击两对象保留侧。");
      params = {
        h1: handles[0],
        p1,
        h2: handles[1],
        p2,
        ...(command === "fillet" ? { radius: amount } : { d1: amount, d2: amount }),
      };
      break;
  }
  return { command, params };
}

export function snapCadPoint(point: DrawingPoint, scene: CadScene, aperture: number): DrawingPoint {
  return resolveCadSnap(point, scene, aperture)?.point ?? point;
}
