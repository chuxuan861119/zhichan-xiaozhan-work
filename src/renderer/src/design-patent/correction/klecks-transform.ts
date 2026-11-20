export type KlecksTransformBounds = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;
export type KlecksTransformMatrix = Readonly<{
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}>;
type Point = Readonly<{ x: number; y: number }>;
type Options = Readonly<{ dx: number; dy: number; scaleX: number; scaleY: number; angle: number }>;

function finite(...values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) throw new Error("变换参数必须为有限数值。");
}
function size(width: number, height: number): void {
  finite(width, height);
  if (
    width === 0 ||
    height === 0 ||
    Math.abs(width) > 10000 ||
    Math.abs(height) > 10000 ||
    Math.abs(width * height) > 40000000
  )
    throw new Error("变换尺寸超出当前图片处理范围。");
}
function bounds(source: KlecksTransformBounds): void {
  finite(source.left, source.top);
  size(source.width, source.height);
  if (source.width <= 0 || source.height <= 0) throw new Error("缺少有效的变换范围。");
}

/** Document-pixel affine transform, using the center of the original content as its pivot. */
export function klecksTransformMatrix(
  source: KlecksTransformBounds,
  options: Options,
): KlecksTransformMatrix {
  bounds(source);
  finite(options.dx, options.dy, options.scaleX, options.scaleY, options.angle);
  size(source.width * options.scaleX, source.height * options.scaleY);
  const angle = ((options.angle % 360) * Math.PI) / 180;
  const exact = (value: number) =>
    Math.abs(value) < 1e-12 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-12 ? Math.sign(value) : value;
  const cos = exact(Math.cos(angle)),
    sin = exact(Math.sin(angle));
  const a = cos * options.scaleX,
    b = sin * options.scaleX,
    c = -sin * options.scaleY,
    d = cos * options.scaleY;
  const x = source.left + source.width / 2,
    y = source.top + source.height / 2;
  const matrix = {
    a,
    b,
    c,
    d,
    e: x + options.dx - a * x - c * y,
    f: y + options.dy - b * x - d * y,
  };
  klecksTransformPixelBounds(source, matrix); // Reject the rotated backing size before allocating any pixels.
  return matrix;
}

export function applyKlecksTransform(matrix: KlecksTransformMatrix, point: Point): Point {
  finite(...Object.values(matrix), point.x, point.y);
  const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
  const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
  finite(x, y);
  return { x, y };
}

export function invertKlecksTransform(matrix: KlecksTransformMatrix): KlecksTransformMatrix {
  finite(...Object.values(matrix));
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("变换无法逆向定位。");
  const inverse = {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
  finite(...Object.values(inverse));
  return inverse;
}

export function klecksTransformPixelBounds(
  source: KlecksTransformBounds,
  matrix: KlecksTransformMatrix,
): KlecksTransformBounds {
  bounds(source);
  const corners: readonly (readonly [number, number])[] = [
    [source.left, source.top],
    [source.left + source.width, source.top],
    [source.left, source.top + source.height],
    [source.left + source.width, source.top + source.height],
  ];
  const points = corners.map(([x, y]) => applyKlecksTransform(matrix, { x, y }));
  const snap = (value: number) =>
    Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
  const left = Math.floor(snap(Math.min(...points.map((point) => point.x))));
  const top = Math.floor(snap(Math.min(...points.map((point) => point.y))));
  const width = Math.ceil(snap(Math.max(...points.map((point) => point.x)))) - left;
  const height = Math.ceil(snap(Math.max(...points.map((point) => point.y)))) - top;
  size(width, height);
  if (Math.abs(left) > 100000 || Math.abs(top) > 100000) throw new Error("变换位置超出安全范围。");
  return { left, top, width, height };
}

/** Shift temporarily reverses the user's ratio-link preference, including signed flip dimensions. */
export function resizeKlecksTransform(
  source: Readonly<{ width: number; height: number }>,
  axis: "width" | "height",
  value: number,
  options: Readonly<{ linked?: boolean; shift?: boolean }> = {},
): { width: number; height: number } {
  size(source.width, source.height);
  finite(value);
  const linked = (options.linked ?? true) !== (options.shift ?? false);
  const ratio = Math.abs(value / source[axis]);
  const result = { ...source, [axis]: value };
  if (linked) result[axis === "width" ? "height" : "width"] *= ratio;
  size(result.width, result.height);
  return result;
}

export function snapKlecksRotation(angle: number, shift: boolean): number {
  finite(angle);
  return shift ? Math.round(angle / 15) * 15 : angle;
}
