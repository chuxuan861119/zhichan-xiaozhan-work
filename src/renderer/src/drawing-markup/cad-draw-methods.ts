import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import { rectangleGeometry, type RectangleOptions } from "./cad-rectangle";
export type DrawMethod = {
  id: string;
  label: string;
  steps: string[];
  parameter?: string;
  picks?: boolean;
};
export const DRAW_METHODS: Record<string, DrawMethod[]> = {
  rectang: [
    {id:"rectang",label:"两点矩形",steps:["指定矩形的第一个角点。","指定对角点；也可以按住拖动绘制。"]},
    {id:"rectang.center",label:"中心矩形",steps:["指定矩形中心。","指定一个角点，矩形围绕中心对称展开。"]},
    {id:"rectang.3p",label:"三点矩形",steps:["指定第一条边的起点。","指定第一条边的终点，确定方向和长度。","指定宽度，四角自动保持直角。"]},
    {id:"rectang.center-rotated",label:"中心倾斜矩形",steps:["指定矩形中心。","指定轴端点，确定方向和半长。","指定半宽，矩形围绕中心对称展开。"]},
  ],
  spring: [
    { id: "spring", label: "压缩弹簧", parameter: "圈数", steps: ["指定弹簧一端。", "指定另一端，确定长度和方向。", "点选弹簧边缘，确定宽度。"] },
    { id: "spring.extension", label: "拉伸弹簧", parameter: "圈数", steps: ["指定拉伸弹簧一端。", "指定另一端，确定含挂钩的总长和方向。", "点选弹簧边缘，确定宽度。"] },
  ],
  chain: [
    { id: "chain.drive", label: "链条", parameter: "左轮齿数", steps: ["指定左轮轮心。", "指定右轮轮心，确定中心距与方向。"] },
    { id: "chain.sprocket", label: "链轮", parameter: "齿数", steps: ["指定链轮圆心。", "指定轮缘，确定大小。"] },
  ],
  gear: [
    { id: "gear.external", label: "外齿轮", parameter: "齿数", steps: ["输入齿数，指定圆心。", "移动鼠标确定大小和方向，点击完成。"] },
    { id: "gear.internal", label: "内齿圈", parameter: "齿数", steps: ["输入齿数，指定圆心。", "移动鼠标确定大小和方向，点击完成。"] },
    { id: "gear.rack", label: "齿条", parameter: "齿数", steps: ["输入齿数，指定齿条起点。", "移动鼠标确定长度和方向，点击完成。"] },
  ],
  circle: [
    { id: "circle", label: "圆心、半径", steps: ["指定圆心。", "指定半径端点。"] },
    { id: "circle.cd", label: "圆心、直径", steps: ["指定圆心。", "点选确定直径长度。"] },
    { id: "circle.2p", label: "两点", steps: ["指定直径第一端点。", "指定直径另一端点。"] },
    {
      id: "circle.3p",
      label: "三点",
      steps: ["指定圆上第一点。", "指定圆上第二点。", "指定圆上第三点。"],
    },
    {
      id: "circle.ttr",
      label: "相切、相切、半径",
      parameter: "半径",
      picks: true,
      steps: ["输入半径，点选第一个相切对象。", "点选第二个相切对象，靠近期望切点。"],
    },
    {
      id: "circle.ttt",
      label: "相切、相切、相切",
      picks: true,
      steps: ["点选第一个相切对象。", "点选第二个相切对象。", "点选第三个相切对象。"],
    },
  ],
  arc: [
    { id: "arc", label: "三点", steps: ["指定起点。", "指定经过点。", "指定终点。"] },
    {
      id: "arc.sce",
      label: "起点、圆心、终点",
      steps: ["指定起点。", "指定圆心。", "指定终点方向（逆时针）。"],
    },
    {
      id: "arc.ser",
      label: "起点、终点、半径",
      parameter: "半径",
      steps: ["输入半径，指定起点；负半径绘制优弧。", "指定终点。"],
    },
    {
      id: "arc.sea",
      label: "起点、终点、角度",
      parameter: "角度（°）",
      steps: ["输入夹角，指定起点；正值逆时针、负值顺时针。", "指定终点。"],
    },
    { id: "arc.continue", label: "接续上一段", steps: ["指定终点，与上一条直线或圆弧相切接续。"] },
  ],
  ellipse: [
    {
      id: "ellipse",
      label: "中心",
      steps: ["指定中心。", "指定第一条轴端点。", "指定另一条轴的半径。"],
    },
    {
      id: "ellipse.axis",
      label: "轴、端点",
      steps: ["指定第一轴的一个端点。", "指定第一轴的另一端点。", "指定另一轴半径。"],
    },
    {
      id: "ellipse.arc",
      label: "椭圆弧",
      steps: [
        "指定第一轴的一个端点。",
        "指定第一轴的另一端点。",
        "指定另一轴半径。",
        "指定弧起点方向。",
        "指定弧终点方向（逆时针）。",
      ],
    },
  ],
  polygon: [
    {
      id: "polygon",
      label: "内接于圆",
      parameter: "边数",
      steps: ["输入边数，指定中心。", "指定顶点位置。"],
    },
    {
      id: "polygon.out",
      label: "外切于圆",
      parameter: "边数",
      steps: ["输入边数，指定中心。", "指定边中点位置。"],
    },
    {
      id: "polygon.edge",
      label: "指定一条边",
      parameter: "边数",
      steps: ["输入边数，指定边的起点。", "指定边的终点，多边形在有向边左侧。"],
    },
  ],
};
export function drawMethod(id: string) {
  return Object.values(DRAW_METHODS)
    .flat()
    .find((m) => m.id === id);
}
export function compileDrawMethod(
  id: string,
  points: DrawingPoint[],
  amount: number,
  handles: string[] = [],
  options: { gearHole?: boolean; springWire?: number | undefined; rectangle?: RectangleOptions } = {},
) {
  const method = drawMethod(id);
  if (!method || points.length < method.steps.length) return null;
  const ps = points.map((p) => [p.x, p.y]);
  if (ps.flat().some((n) => !Number.isFinite(n))) throw new Error("绘图坐标无效。");
  const [a, b, c] = points;
  if (id === "rectang" || id.startsWith("rectang.")) {
    const result=rectangleGeometry(id,points,options.rectangle);
    return result ? {command:result.command,params:result.params} : null;
  }
  const dist = (a: DrawingPoint, b: DrawingPoint) => Math.hypot(b.x - a.x, b.y - a.y);
  const length = b ? dist(a!, b) : 0;
  if (b && length < 1e-9 && !method.picks) throw new Error("请指定不同的位置。");
  if (method.parameter && !Number.isFinite(amount))
    throw new Error(`请输入有效的${method.parameter}。`);
  if (id.startsWith("gear.") || id.startsWith("chain.")) {
    const kind=id.split(".")[1], min=kind==="rack"?2:8;
    if (!Number.isInteger(amount)||amount<min||amount>120) throw new Error(`齿数须为 ${min}～120 的整数。`);
    if(id.startsWith("chain.")) {
      const single=kind==="sprocket",radius=single?length:length*14/108;
      return {command:"bridge.chain",params:{single,at:ps[0],end:ps[1],radius,teeth:amount,otherTeeth:Math.max(8,Math.round(amount*17/23)),hole:radius*2.5/14,otherHole:radius*1.5/14}};
    }
    return {command:"bridge.gear",params:{kind,teeth:amount,hole:options.gearHole ?? true,at:ps[0],size:length*(kind==="rack"?1:2),rotation:Math.atan2(b!.y-a!.y,b!.x-a!.x)*180/Math.PI}};
  }
  if (id === "spring" || id === "spring.extension") {
    const extension = id === "spring.extension";
    if (!Number.isInteger(amount) || amount < 3 || amount > 24) throw new Error("圈数须为 3～24 的整数。");
    const width = 2 * Math.abs((b!.x-a!.x)*(c!.y-a!.y)-(b!.y-a!.y)*(c!.x-a!.x)) / length;
    const wire = options.springWire ?? (extension ? Math.min(width * 0.115, (length - 2 * width) / (amount - 1) * 0.95) : Math.min(width * 0.08, length / (amount * 4)));
    if (extension && (!(wire > 1e-6) || length < 2 * width + (amount - 1) * wire))
      throw new Error("长度不足以容纳两端挂钩和线圈，请拉长弹簧、减小宽度、圈数或线径。");
    if (!(width > 1e-6) || !Number.isFinite(width) || !(wire > 1e-6) || !Number.isFinite(wire) || wire >= width / 3 || (!extension && wire >= length / (2 * amount)))
      throw new Error("请指定有效的弹簧宽度和线径；线径须小于宽度的三分之一和半圈间距。");
    return { command: "bridge.spring", params: { at: ps[0], end: ps[1], width, turns: amount, wire, ...(extension ? {kind:"extension"} : {}) } };
  }
  let command = id,
    params: Record<string, unknown>;
  switch (id) {
    case "circle.cd":
      command = "circle";
      params = { center: ps[0], diameter: length };
      break;
    case "circle.2p":
      command = "circle";
      params = { p1: ps[0], p2: ps[1] };
      break;
    case "circle.3p":
      if (
        Math.abs((b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x)) <
        1e-10 * Math.max(1, length * dist(a!, c!))
      )
        throw new Error("三点不能重合或共线。");
      command = "circle";
      params = { p1: ps[0], p2: ps[1], p3: ps[2] };
      break;
    case "circle.ttr":
    case "circle.ttt":
      if (handles.length < method.steps.length) return null;
      if (new Set(handles).size !== handles.length) throw new Error("请选择不同的相切对象。");
      if (id === "circle.ttr" && !(amount > 0)) throw new Error("半径必须大于 0。");
      params = {
        h1: handles[0],
        p1: ps[0],
        h2: handles[1],
        p2: ps[1],
        ...(id === "circle.ttr" ? { radius: amount } : { h3: handles[2], p3: ps[2] }),
      };
      break;
    case "arc.sce":
      params = { start: ps[0], center: ps[1], end: ps[2] };
      break;
    case "arc.ser":
      if (!amount || Math.abs(amount) < length / 2)
        throw new Error("半径的绝对值不能小于两端点距离的一半。");
      params = { start: ps[0], end: ps[1], radius: amount };
      break;
    case "arc.sea":
      if (!amount || Math.abs(amount) >= 360)
        throw new Error("夹角须大于 −360°、小于 360°，且不为 0。");
      params = { start: ps[0], end: ps[1], angle: amount };
      break;
    case "arc.continue":
      params = { end: ps[0] };
      break;
    case "ellipse.axis":
      params = { p1: ps[0], p2: ps[1], p3: ps[2] };
      break;
    case "ellipse.arc": {
      const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      const dx = (b!.x - a!.x) / 2,
        dy = (b!.y - a!.y) / 2,
        r = length / 2;
      const minor = Math.abs(-(c!.x - center.x) * dy + (c!.y - center.y) * dx) / r;
      if (!(minor > 1e-9)) throw new Error("另一条轴半径必须大于 0。");
      const majorAngle = Math.atan2(dy, dx) + (minor > r ? Math.PI / 2 : 0);
      const angle = (p: DrawingPoint) => {
        if (dist(center, p) < 1e-9) throw new Error("请在中心以外指定弧端点方向。");
        return ((Math.atan2(p.y - center.y, p.x - center.x) - majorAngle) * 180) / Math.PI;
      };
      // The engine accepts geometric angles relative to its normalized major axis.
      params = {
        p1: ps[0],
        p2: ps[1],
        distance: minor,
        start: angle(points[3]!),
        end: angle(points[4]!),
      };
      break;
    }
    case "polygon.out":
    case "polygon.edge":
      if (!Number.isInteger(amount) || amount < 3 || amount > 20)
        throw new Error("边数须为 3 至 20 的整数。");
      command = "polygon";
      params =
        id === "polygon.edge"
          ? { sides: amount, edge: [ps[0], ps[1]] }
          : {
              sides: amount,
              center: ps[0],
              radius: length,
              inscribed: false,
              angle: (Math.atan2(b!.y - a!.y, b!.x - a!.x) * 180) / Math.PI,
            };
      break;
    default:
      return null;
  }
  return { command, params };
}
