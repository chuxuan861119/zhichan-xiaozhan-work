import {
  applyKlecksTransform,
  invertKlecksTransform,
  type KlecksTransformBounds,
  type KlecksTransformMatrix,
  snapKlecksRotation,
} from "./klecks-transform";
export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | "rotate";
type Point = { x: number; y: number };
export const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export function boxHandlePoint(
  bounds: KlecksTransformBounds,
  handle: (typeof BOX_HANDLES)[number],
): Point {
  return {
    x: bounds.left + bounds.width * (handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5),
    y: bounds.top + bounds.height * (handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5),
  };
}
export function multiplyTransform(
  left: KlecksTransformMatrix,
  right: KlecksTransformMatrix,
): KlecksTransformMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}
export function hitTransformHandle(
  bounds: KlecksTransformBounds,
  matrix: KlecksTransformMatrix,
  point: Point,
  tolerance: number,
): BoxHandle | null {
  for (const handle of BOX_HANDLES) {
    const target = applyKlecksTransform(matrix, boxHandlePoint(bounds, handle));
    if (Math.hypot(target.x - point.x, target.y - point.y) <= tolerance) return handle;
  }
  const p = applyKlecksTransform(invertKlecksTransform(matrix), point);
  if (
    p.x >= bounds.left &&
    p.x <= bounds.left + bounds.width &&
    p.y >= bounds.top &&
    p.y <= bounds.top + bounds.height
  )
    return "move";
  const corners = ["nw", "ne", "se", "sw"] as const;
  if (
    corners.some((handle) => {
      const target = applyKlecksTransform(matrix, boxHandlePoint(bounds, handle));
      return Math.hypot(target.x - point.x, target.y - point.y) <= tolerance * 3;
    })
  )
    return "rotate";
  return null;
}
export function dragTransformHandle(
  bounds: KlecksTransformBounds,
  matrix: KlecksTransformMatrix,
  handle: BoxHandle,
  start: Point,
  point: Point,
  keys: { shift: boolean; alt: boolean; linked?: boolean },
): KlecksTransformMatrix {
  if (handle === "move") {
    let dx = point.x - start.x,
      dy = point.y - start.y;
    if (keys.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    return { ...matrix, e: matrix.e + dx, f: matrix.f + dy };
  }
  const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  if (handle === "rotate") {
    const pivot = applyKlecksTransform(matrix, center);
    const angle =
      (snapKlecksRotation(
        ((Math.atan2(point.y - pivot.y, point.x - pivot.x) -
          Math.atan2(start.y - pivot.y, start.x - pivot.x)) *
          180) /
          Math.PI,
        keys.shift,
      ) *
        Math.PI) /
      180;
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    return multiplyTransform(
      {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: pivot.x - cos * pivot.x + sin * pivot.y,
        f: pivot.y - sin * pivot.x - cos * pivot.y,
      },
      matrix,
    );
  }
  const local = applyKlecksTransform(invertKlecksTransform(matrix), point),
    grip = boxHandlePoint(bounds, handle);
  const anchor = keys.alt
    ? center
    : {
        x: bounds.left + bounds.width - (grip.x - bounds.left),
        y: bounds.top + bounds.height - (grip.y - bounds.top),
      };
  let sx = handle === "n" || handle === "s" ? 1 : (local.x - anchor.x) / (grip.x - anchor.x);
  let sy = handle === "e" || handle === "w" ? 1 : (local.y - anchor.y) / (grip.y - anchor.y);
  if ((keys.linked ?? true) !== keys.shift) {
    const factor =
      handle === "n" || handle === "s"
        ? sy
        : handle === "e" || handle === "w"
          ? sx
          : Math.abs(sx - 1) >= Math.abs(sy - 1)
            ? sx
            : sy;
    sx = sy = factor;
  }
  const safe = (value: number) =>
    Math.abs(value) < 0.0001 ? (value < 0 ? -1 : 1) * 0.0001 : value;
  sx = safe(sx);
  sy = safe(sy);
  return multiplyTransform(matrix, {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: anchor.x * (1 - sx),
    f: anchor.y * (1 - sy),
  });
}
