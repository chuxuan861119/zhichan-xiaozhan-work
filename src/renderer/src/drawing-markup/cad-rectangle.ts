import type { DrawingPoint } from "../../../shared/drawing-markup/model";

export type RectangleOptions = {
  corner?: "sharp" | "round" | "chamfer";
  size?: number;
  square?: boolean;
};

/** Compile mouse picks to one native closed polyline, never a group of loose edges. */
export function rectangleGeometry(
  method: string,
  points: DrawingPoint[],
  options: RectangleOptions = {},
) {
  const tilted = method === "rectang.3p" || method === "rectang.center-rotated";
  if (points.length < (tilted ? 3 : 2)) return null;
  const [a, b, c] = points as [DrawingPoint, DrawingPoint, DrawingPoint];
  let origin = a,
    w: number,
    h: number,
    rotation = 0;
  if (tilted) {
    w = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(w > 1e-9)) throw new Error("请指定不同的轴线端点。");
    rotation = Math.atan2(b.y - a.y, b.x - a.x);
    h = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / w;
    if (options.square) h = (h < 0 ? -1 : 1) * w;
    if (method === "rectang.center-rotated") {
      origin = {
        x: a.x - w * Math.cos(rotation) + h * Math.sin(rotation),
        y: a.y - w * Math.sin(rotation) - h * Math.cos(rotation),
      };
      w *= 2;
      h *= 2;
    }
  } else {
    w = b.x - a.x;
    h = b.y - a.y;
    if (options.square) {
      const edge = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * edge;
      h = (h < 0 ? -1 : 1) * edge;
    }
    if (method === "rectang.center") {
      origin = { x: a.x - w, y: a.y - h };
      w *= 2;
      h *= 2;
    }
  }
  if (![origin.x, origin.y, w, h, rotation].every(Number.isFinite))
    throw new Error("绘图坐标无效。");
  if (Math.min(Math.abs(w), Math.abs(h)) < 1e-9)
    throw new Error("矩形宽度和高度必须大于 0，请移到边线外。");
  const corner = options.corner ?? "sharp";
  const size = corner === "sharp" ? 0 : (options.size ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new Error("请输入有效的圆角半径或倒角大小。");
  if (size > Math.min(Math.abs(w), Math.abs(h)) / 2)
    throw new Error("圆角或倒角不能超过矩形短边的一半，请减小设置或放大矩形。");
  const transform = (x: number, y: number): DrawingPoint => ({
    x: origin.x + x * Math.cos(rotation) - y * Math.sin(rotation),
    y: origin.y + x * Math.sin(rotation) + y * Math.cos(rotation),
  });
  const end = transform(w, h);
  const params: Record<string, unknown> = {
    p1: [origin.x, origin.y],
    p2: [end.x, end.y],
    ...(tilted ? { rotation: (rotation * 180) / Math.PI } : {}),
    ...(corner === "round" && size > 0 ? { fillet: size } : {}),
    ...(corner === "chamfer" && size > 0 ? { chamfer: [size, size] } : {}),
  };
  // Match the native rect_with_corners convention in local coordinates, then rotate.
  const x0 = Math.min(0, w),
    x1 = Math.max(0, w),
    y0 = Math.min(0, h),
    y1 = Math.max(0, h);
  const path: DrawingPoint[] = [];
  if (corner === "round" && size > 0) {
    for (const [cx, cy, start] of [
      [x1 - size, y0 + size, -Math.PI / 2],
      [x1 - size, y1 - size, 0],
      [x0 + size, y1 - size, Math.PI / 2],
      [x0 + size, y0 + size, Math.PI],
    ]) {
      for (let i = 0; i <= 24; i++) {
        const angle = start! + (i * Math.PI) / 48;
        path.push(transform(cx! + size * Math.cos(angle), cy! + size * Math.sin(angle)));
      }
    }
  } else if (corner === "chamfer" && size > 0) {
    for (const [x, y] of [
      [x0 + size, y0],
      [x1 - size, y0],
      [x1, y0 + size],
      [x1, y1 - size],
      [x1 - size, y1],
      [x0 + size, y1],
      [x0, y1 - size],
      [x0, y0 + size],
    ])
      path.push(transform(x!, y!));
  } else {
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
      path.push(transform(x!, y!));
  }
  path.push(path[0]!);
  return { command: "rectang", params, path };
}
