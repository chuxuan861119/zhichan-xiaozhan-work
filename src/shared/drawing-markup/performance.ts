import { z } from "zod";
import {
  DrawingAnnotationSchema,
  DrawingBaseFragmentSchema,
  DrawingDetailViewSchema,
  type DrawingProject,
  DrawingProjectSchema,
  DrawingRegionSchema,
} from "./model.js";

/** Exact value comparison that stops immediately at immutable shared subtrees. */
export function drawingEditEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && drawingEditEqual(a[key], b[key]))
  );
}

const validatedProjects = new WeakSet<DrawingProject>();

// These references belong to the drawing editor. Never reuse caller-owned IPC inputs.
function shareValidated(input: unknown, parsed: unknown): unknown {
  if (Object.is(input, parsed)) return input;
  if (!input || !parsed || typeof input !== "object" || typeof parsed !== "object") return parsed;
  if (Array.isArray(input) !== Array.isArray(parsed)) return parsed;
  const source = input as Record<string, unknown>,
    result = parsed as Record<string, unknown>;
  const keys = Object.keys(result);
  let same = keys.length === Object.keys(source).length;
  for (const key of keys) {
    result[key] = shareValidated(source[key], result[key]);
    same &&= Object.is(source[key], result[key]);
  }
  return same ? input : parsed;
}

/** Full commit validation, with normalized values and structural sharing for undo and layout. */
export function parseDrawingEdit(input: DrawingProject): DrawingProject {
  const result = shareValidated(input, DrawingProjectSchema.parse(input)) as DrawingProject;
  validatedProjects.add(result);
  return result;
}

/** Only this immutable gesture baseline can bypass repeat validation of unchanged objects. */
export function createDrawingGestureValidator(before: DrawingProject) {
  if (!validatedProjects.has(before)) {
    DrawingProjectSchema.parse(before);
    validatedProjects.add(before);
  }
  const cached = <T extends object>(schema: z.ZodType<T, T>, objects: T[]) => {
    const known = new WeakSet(objects);
    return z.union([
      z.custom<T>((value) => typeof value === "object" && value !== null && known.has(value as T)),
      schema,
    ]);
  };
  const schema = DrawingProjectSchema.safeExtend({
    annotations: z.array(cached(DrawingAnnotationSchema, before.annotations)).max(5000),
    regions: z.array(cached(DrawingRegionSchema, before.regions)).max(500),
    baseFragments: z
      .array(cached(DrawingBaseFragmentSchema, before.baseFragments ?? []))
      .max(500)
      .optional(),
    detailViews: z
      .array(cached(DrawingDetailViewSchema, before.detailViews ?? []))
      .max(100)
      .optional(),
  });
  return (project: DrawingProject) => schema.safeParse(project).success;
}
