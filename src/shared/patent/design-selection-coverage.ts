import {
  isSelectionRaster,
  MAX_SELECTION_RUN_VALUES,
  type SelectionRaster,
} from "./design-selection-raster.js";
/** Serializable selection coverage; raster weights are immutable and run-length bounded. */
export type SelectionOutline = [number, number][][][];
export type SelectionAffine = { a: number; b: number; c: number; d: number; e: number; f: number };
export type DesignSelectionCoverage =
  | SelectionRaster
  | { kind: "shape"; value: SelectionOutline; feather: number; antiAlias: boolean }
  | { kind: "invert"; source: DesignSelectionCoverage }
  | {
      kind: "transform";
      source: DesignSelectionCoverage;
      width: number;
      height: number;
      matrix: SelectionAffine;
    }
  | {
      kind: "add" | "subtract" | "intersect";
      left: DesignSelectionCoverage;
      right: DesignSelectionCoverage;
    };

/** Idempotent max/min operands keep repeated color clicks from growing the mask tree. */
export function combineSelectionCoverage(
  kind: "add" | "subtract" | "intersect",
  left: DesignSelectionCoverage,
  right: DesignSelectionCoverage,
): DesignSelectionCoverage {
  if (kind !== "subtract") {
    const contains = (tree: DesignSelectionCoverage, shape: DesignSelectionCoverage): boolean => {
      if (shape.kind !== "shape") return false;
      const outline = JSON.stringify(shape.value),
        pending = [tree];
      while (pending.length) {
        const node = pending.pop()!;
        if (
          node.kind === "shape" &&
          node.feather === shape.feather &&
          node.antiAlias === shape.antiAlias &&
          JSON.stringify(node.value) === outline
        )
          return true;
        if (node.kind === kind) pending.push(node.left, node.right);
      }
      return false;
    };
    if (contains(left, right)) return left;
    if (contains(right, left)) return right;
  }
  return { kind, left, right };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
export function isSelectionCoverage(input: unknown): input is DesignSelectionCoverage {
  const pending = [{ value: input, depth: 0 }];
  let nodes = 0,
    points = 0,
    runValues = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 32 || depth > 8 || !record(value)) return false;
    if (value.kind === "raster") {
      if (!isSelectionRaster(value)) return false;
      runValues += value.runs.length;
      if (runValues > MAX_SELECTION_RUN_VALUES) return false;
    } else if (value.kind === "shape") {
      if (
        !exact(value, ["kind", "value", "feather", "antiAlias"]) ||
        typeof value.feather !== "number" ||
        !Number.isFinite(value.feather) ||
        value.feather < 0 ||
        value.feather > 1000 ||
        typeof value.antiAlias !== "boolean" ||
        !Array.isArray(value.value) ||
        value.value.length > 1000
      )
        return false;
      for (const polygon of value.value) {
        if (!Array.isArray(polygon) || !polygon.length || polygon.length > 1000) return false;
        for (const ring of polygon) {
          if (!Array.isArray(ring) || ring.length < 4) return false;
          points += ring.length;
          if (points > 50000) return false;
          for (const point of ring)
            if (
              !Array.isArray(point) ||
              point.length !== 2 ||
              point.some(
                (x) => typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 100000,
              )
            )
              return false;
          if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) return false;
        }
      }
    } else if (value.kind === "invert") {
      if (!exact(value, ["kind", "source"])) return false;
      pending.push({ value: value.source, depth: depth + 1 });
    } else if (value.kind === "transform") {
      if (
        !exact(value, ["kind", "source", "width", "height", "matrix"]) ||
        ![value.width, value.height].every(
          (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= 10000,
        ) ||
        (value.width as number) * (value.height as number) > 40000000 ||
        !record(value.matrix) ||
        !exact(value.matrix, ["a", "b", "c", "d", "e", "f"]) ||
        !Object.values(value.matrix).every(
          (x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100000,
        )
      )
        return false;
      const m = value.matrix as SelectionAffine;
      if (Math.abs(m.a * m.d - m.b * m.c) < 1e-12) return false;
      pending.push({ value: value.source, depth: depth + 1 });
    } else if (["add", "subtract", "intersect"].includes(value.kind as string)) {
      if (!exact(value, ["kind", "left", "right"])) return false;
      pending.push(
        { value: value.left, depth: depth + 1 },
        { value: value.right, depth: depth + 1 },
      );
    } else return false;
  }
  return true;
}
