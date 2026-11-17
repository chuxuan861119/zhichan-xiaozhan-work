import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import { chainGrip, chainGripLabel, chainPaths } from "./cad-chain-geometry";
import { bulgeArc } from "./cad-drafting-geometry";
import { formatCadNumber } from "./cad-number-input";
import { springGripPreview } from "./cad-spring-geometry";
import type { CadScene } from "./cadcraft-client";

export type CadGripTarget = { handle: string; index: number };

/** Names describe the existing grip edit, independently of object-snap categories. */
export function cadGripLabel(entity: CadScene["entities"][number], index: number): string {
  if (entity.chain) return chainGripLabel(entity.chain, index) ?? "移动控制点";
  if (entity.gear) return cadGearGripLabel(entity.gear, index);
  if (entity.spring)
    return (
      ["调整起点与长度", "调整长度与方向", "调整宽度", "调整圈数", "移动弹簧"][index] ??
      "移动控制点"
    );
  const type = entity.type.toLowerCase();
  if (type === "text" || type === "mtext")
    return entity.textOrigin && entity.plainText !== undefined && entity.grips?.length === 3
      ? (["移动文字", "调整文字宽度", "缩放文字"][index] ?? "移动文字")
      : "移动文字";
  if (type === "line") return ["调整起点", "移动直线", "调整终点"][index] ?? "移动控制点";
  if (type === "circle") return index === 0 ? "移动圆" : "调整半径";
  if (type === "arc")
    return ["调整起点", "调整弧度", "调整终点", "移动圆弧"][index] ?? "移动控制点";
  if (type === "ellipse")
    return index === 0 ? "移动椭圆" : index % 2 ? "调整轴长与方向" : "调整轴长";
  if (type === "lwpolyline" || type === "polyline")
    return index % 2 === 0
      ? "移动顶点"
      : Math.abs(entity.geometry?.vertices?.[Math.floor(index / 2)]?.bulge ?? 0) > 1e-12
        ? "调整圆弧"
        : "平移边线";
  if (
    ["polyline3d", "3d polyline", "solid", "trace", "3d face", "3dface", "wipeout"].includes(type)
  )
    return "移动顶点";
  if (type === "spline") return "调整曲线节点";
  if (type === "leader") return "移动引线节点";
  if (type === "mline") return "移动顶点";
  if (type === "mleader") return "调整引线";
  if (type === "helix")
    return ["移动螺旋线", "调整底部半径与方向", "调整顶部半径"][index] ?? "移动控制点";
  if (type === "ray" || type === "xline") return index === 0 ? "移动基点" : "调整方向";
  if (type === "insert" || type === "block reference")
    return index === 0 ? "移动图块" : "移动属性文字";
  if (type === "image") return "移动图片";
  if (type === "table") return index === 0 ? "移动表格" : "移动表格分段";
  if (type === "point") return "移动点";
  if (type === "attdef") return "移动属性文字";
  if (type === "tolerance") return "移动形位公差";
  if (type === "dimension")
    return (
      ["调整第一界线点", "调整第二界线点", "调整标注位置", "移动标注文字"][index] ?? "移动控制点"
    );
  if (type === "region") return "移动区域";
  if (type === "viewport") return "调整边界";
  return "移动控制点";
}

export function cadGearGripLabel(
  gear: NonNullable<CadScene["entities"][number]["gear"]>,
  index: number,
) {
  return index === 0
    ? "移动"
    : index === 1
      ? `缩放 · ${gear.kind === "rack" ? "长度" : "外径"} ${formatCadNumber(gear.size)}`
      : index === 2
        ? `齿数 ${gear.teeth} · 沿引导方向拖动增减`
        : "绕圆心旋转";
}

export function cadTextGripPreview(scene: CadScene, target: CadGripTarget, cursor: DrawingPoint) {
  const entity = scene.entities.find((e) => e.handle === target.handle);
  if (
    !entity?.textOrigin ||
    entity.grips?.length !== 3 ||
    !entity.width ||
    !entity.height ||
    entity.plainText === undefined
  )
    return null;
  const at = { x: entity.textOrigin[0], y: entity.textOrigin[1] };
  const rotation = entity.rotation ?? 0;
  const angle = (rotation * Math.PI) / 180;
  const distance = (cursor.x - at.x) * Math.cos(angle) + (cursor.y - at.y) * Math.sin(angle);
  const factor = target.index === 2 ? Math.max(0.01, distance / entity.width) : 1;
  return {
    at: target.index === 0 ? cursor : at,
    rotation,
    text: entity.plainText,
    width: target.index === 1 ? Math.max(entity.height, distance) : entity.width * factor,
    height: entity.height * factor,
  };
}

const TAU = Math.PI * 2;
const point = ([x, y]: [number, number]): DrawingPoint => ({ x, y });
const add = (p: DrawingPoint, delta: DrawingPoint): DrawingPoint => ({
  x: p.x + delta.x,
  y: p.y + delta.y,
});

function circleThrough(a: DrawingPoint, b: DrawingPoint, c: DrawingPoint) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-10) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d,
  };
  const start = Math.atan2(a.y - center.y, a.x - center.x);
  const middle = Math.atan2(b.y - center.y, b.x - center.x);
  const end = Math.atan2(c.y - center.y, c.x - center.x);
  const ccw = (((end - start) % TAU) + TAU) % TAU;
  const middleCcw = (((middle - start) % TAU) + TAU) % TAU;
  return {
    center,
    radius: Math.hypot(a.x - center.x, a.y - center.y),
    start,
    sweep: middleCcw <= ccw + 1e-8 ? ccw : ccw - TAU,
  };
}

function sampleArc(
  center: DrawingPoint,
  radius: number,
  start: number,
  sweep: number,
): DrawingPoint[] {
  const count = Math.max(12, Math.ceil((Math.abs(sweep) / TAU) * 72));
  return Array.from({ length: count + 1 }, (_, i) => ({
    x: center.x + radius * Math.cos(start + (sweep * i) / count),
    y: center.y + radius * Math.sin(start + (sweep * i) / count),
  }));
}

/** Pure pointer-frame preview; the CAD engine is only mutated when the gesture is committed. */
export function cadGripPreviewPaths(
  scene: CadScene,
  target: CadGripTarget,
  cursor: DrawingPoint,
): DrawingPoint[][] {
  const entity = scene.entities.find((item) => item.handle === target.handle);
  const from = entity?.grips?.[target.index];
  if (!entity || !from) return [];
  if (entity.chain) return chainPaths(chainGrip(entity.chain, target.index, cursor));
  if (entity.spring) return springGripPreview(entity.spring, target.index, cursor);
  const delta = { x: cursor.x - from[0], y: cursor.y - from[1] };
  const type = entity.type.toLowerCase();
  const primitives = scene.primitives.filter((item) => item.handle === target.handle);
  const translate = () =>
    primitives.map((primitive) => primitive.points.map((p) => add(point(p), delta)));

  if (entity.gear && target.index > 0) {
    const center = entity.grips?.[0];
    if (!center || target.index === 2) return [];
    const a = { x: from[0] - center[0], y: from[1] - center[1] };
    const b = { x: cursor.x - center[0], y: cursor.y - center[1] };
    const factor =
      target.index === 1
        ? Math.min(
            1e8,
            Math.max(1e-5, (entity.gear.size * Math.hypot(b.x, b.y)) / Math.hypot(a.x, a.y)),
          ) / entity.gear.size
        : 1;
    const angle =
      target.index === 3 && Math.hypot(b.x, b.y) > 1e-10
        ? Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x)
        : 0;
    return primitives.map((p) =>
      p.points.map(([x, y]) => ({
        x:
          center[0] +
          ((x - center[0]) * Math.cos(angle) - (y - center[1]) * Math.sin(angle)) * factor,
        y:
          center[1] +
          ((x - center[0]) * Math.sin(angle) + (y - center[1]) * Math.cos(angle)) * factor,
      })),
    );
  }

  if (type === "line") {
    const a = entity.geometry?.a ?? (entity.grips?.[0] && point(entity.grips[0]));
    const b = entity.geometry?.b ?? (entity.grips?.[2] && point(entity.grips[2]));
    if (!a || !b) return [];
    return [
      [
        target.index === 0 ? cursor : target.index === 1 ? add(a, delta) : a,
        target.index === 2 ? cursor : target.index === 1 ? add(b, delta) : b,
      ],
    ];
  }

  if (type === "lwpolyline" || type === "polyline") {
    const geometry = entity.geometry;
    const vertices = geometry?.vertices;
    if (!vertices?.length) return [];
    const positions = vertices.map((vertex) => vertex.p);
    if (positions.some((p) => !p)) return [];
    const path = positions.map((p) => ({ x: p!.x, y: p!.y }));
    const bulges = vertices.map((vertex) => vertex.bulge ?? 0);
    const index = Math.floor(target.index / 2);
    if (index >= path.length) return [];
    if (target.index % 2 === 0) path[index] = cursor;
    else {
      const next = (index + 1) % path.length;
      if (Math.abs(bulges[index] ?? 0) > 1e-12) {
        // A curved segment's middle grip changes its bulge, not its end vertices.
        const arc = circleThrough(path[index]!, cursor, path[next]!);
        bulges[index] = arc ? Math.tan(arc.sweep / 4) : 0;
      } else {
        path[index] = add(path[index]!, delta);
        path[next] = add(path[next]!, delta);
      }
    }
    const result: DrawingPoint[] = [];
    const segments = geometry?.closed ? path.length : path.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = path[i]!;
      const b = path[(i + 1) % path.length]!;
      const arc = bulgeArc(target.handle, `${target.handle}-${i}`, a, b, bulges[i] ?? 0);
      const points = arc ? sampleArc(arc.center, arc.radius, arc.start!, arc.sweep!) : [a, b];
      result.push(...(i ? points.slice(1) : points));
    }
    return result.length ? [result] : [];
  }

  if (type === "circle") {
    if (target.index === 0) return translate();
    const center = entity.geometry?.center ?? (entity.grips?.[0] && point(entity.grips[0]));
    if (!center) return [];
    const radius = Math.hypot(cursor.x - center.x, cursor.y - center.y);
    return radius > 1e-10 ? [sampleArc(center, radius, 0, TAU)] : [];
  }

  if (type === "ellipse") {
    if (target.index === 0) return translate();
    const grips = entity.grips;
    if (!grips || grips.length < 5) return [];
    const center = point(grips[0]!);
    const major = { x: grips[1]![0] - center.x, y: grips[1]![1] - center.y };
    const minor = { x: grips[2]![0] - center.x, y: grips[2]![1] - center.y };
    if (target.index === 1 || target.index === 3) {
      const sign = target.index === 1 ? 1 : -1;
      const minorLength = Math.hypot(minor.x, minor.y);
      major.x = (cursor.x - center.x) * sign;
      major.y = (cursor.y - center.y) * sign;
      const majorLength = Math.hypot(major.x, major.y);
      if (majorLength < 1e-10) return [];
      minor.x = (-major.y * minorLength) / majorLength;
      minor.y = (major.x * minorLength) / majorLength;
    } else {
      const length = Math.hypot(major.x, major.y);
      if (length < 1e-10) return [];
      const projected = Math.abs(
        ((cursor.x - center.x) * -major.y + (cursor.y - center.y) * major.x) / length,
      );
      const oldLength = Math.hypot(minor.x, minor.y);
      if (oldLength < 1e-10) return [];
      minor.x *= projected / oldLength;
      minor.y *= projected / oldLength;
    }
    return [
      Array.from({ length: 73 }, (_, i) => {
        const angle = (TAU * i) / 72;
        return {
          x: center.x + major.x * Math.cos(angle) + minor.x * Math.sin(angle),
          y: center.y + major.y * Math.cos(angle) + minor.y * Math.sin(angle),
        };
      }),
    ];
  }

  if (type === "arc") {
    if (target.index === 3) return translate();
    const grips = entity.grips;
    if (!grips || grips.length < 3) return [];
    const positions = grips.slice(0, 3).map(point);
    positions[target.index] = cursor;
    const arc = circleThrough(positions[0]!, positions[1]!, positions[2]!);
    return arc ? [sampleArc(arc.center, arc.radius, arc.start, arc.sweep)] : [];
  }

  if (type === "polyline3d" || type === "3d polyline" || type === "leader") {
    const positions = entity.grips?.map(point) ?? [];
    positions[target.index] = cursor;
    return positions.length > 1 ? [positions] : [];
  }

  // In the engine these insertion/centre grips translate the entire entity.
  if (
    [
      "point",
      "text",
      "mtext",
      "attdef",
      "image",
      "table",
      "hatch",
      "tolerance",
      "insert",
      "block reference",
    ].includes(type)
  )
    return translate();
  return [];
}
