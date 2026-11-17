import type { DrawingPoint } from "../../../shared/drawing-markup/model";

export type CadTransform =
  | { command: "rotate"; base: [number, number]; angle: number }
  | { command: "scale"; base: [number, number]; factor: number };

/** One gesture accumulates turns; a rack must not jump when atan2 crosses its seam. */
export class CadRotationGesture {
  private previous: number;
  private angle = 0;
  constructor(
    private base: DrawingPoint,
    reference: DrawingPoint,
  ) {
    this.previous = Math.atan2(reference.y - base.y, reference.x - base.x);
  }
  update(cursor: DrawingPoint) {
    const dx = cursor.x - this.base.x,
      dy = cursor.y - this.base.y;
    if (Math.hypot(dx, dy) <= 1e-9) return this.angle;
    const next = Math.atan2(dy, dx),
      delta = next - this.previous;
    this.angle += (Math.atan2(Math.sin(delta), Math.cos(delta)) * 180) / Math.PI;
    this.previous = next;
    return this.angle;
  }
}

export function cadTransform(
  mode: "rotate" | "scale",
  base: DrawingPoint,
  reference: DrawingPoint | null,
  cursor: DrawingPoint,
): CadTransform | null {
  const dx = cursor.x - base.x,
    dy = cursor.y - base.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-9) || !Number.isFinite(length)) return null;
  if (mode === "rotate")
    return { command: mode, base: [base.x, base.y], angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  if (!reference) return null;
  const original = Math.hypot(reference.x - base.x, reference.y - base.y);
  const factor = length / original;
  return original > 1e-9 && Number.isFinite(factor) && factor > 0
    ? { command: mode, base: [base.x, base.y], factor }
    : null;
}

export function transformCadPoint(
  point: [number, number],
  transform: CadTransform,
): [number, number] {
  const [x, y] = transform.base;
  if (transform.command === "scale")
    return [x + (point[0] - x) * transform.factor, y + (point[1] - y) * transform.factor];
  const radians = (transform.angle * Math.PI) / 180;
  return [
    x + (point[0] - x) * Math.cos(radians) - (point[1] - y) * Math.sin(radians),
    y + (point[0] - x) * Math.sin(radians) + (point[1] - y) * Math.cos(radians),
  ];
}

export function mergeCadSelection(
  current: string[],
  incoming: string[],
  removing: boolean,
): string[] {
  const members = new Set(incoming);
  return removing
    ? current.filter((handle) => !members.has(handle))
    : [...new Set([...current, ...incoming])];
}

export const CAD_MODIFY_TARGETS = new Set([
  "explode",
  "arrayrect",
  "arraypolar",
  "arraypath",
  "move",
  "copy",
  "mirror",
  "break",
  "offset",
  "fillet",
  "chamfer",
  "rotate",
  "scale",
]);
export function cadTargetLimit(mode: string): number {
  return mode === "fillet" || mode === "chamfer"
    ? 2
    : mode === "offset" || mode === "break"
      ? 1
      : Infinity;
}
