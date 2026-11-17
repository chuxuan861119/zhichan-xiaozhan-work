import { expect, test } from "vitest";
import { DrawingProjectSchema } from "./model.js";
import { createDrawingGestureValidator, parseDrawingEdit } from "./performance.js";
import {
  applyDrawingProjectEdits,
  DrawingProjectEditsSchema,
  drawingProjectEdits,
} from "./project-edits.js";
import { drawingProjectFixture } from "./test-fixture.js";

test("validated edits preserve unchanged objects without losing normalization or strict validation", () => {
  const before = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  const input = {
    ...before,
    name: " 图纸 ",
    annotations: before.annotations.map((a, i) => (i ? a : { ...a, x: a.x + 20 })),
  };
  const result = parseDrawingEdit(input);
  expect(result).toEqual(DrawingProjectSchema.parse(input));
  expect(result.regions).toBe(before.regions);
  expect(result.annotations[0]).toBe(input.annotations[0]);
  expect(() => parseDrawingEdit({ ...before, unknown: true } as never)).toThrow();
  expect(() =>
    parseDrawingEdit({ ...before, annotations: [{ ...before.annotations[0]!, x: Infinity }] }),
  ).toThrow();
  expect(before.annotations[0]?.x).not.toBe(result.annotations[0]?.x);
});

test("gesture validation retains all limits and duplicate checks while accepting immutable shared objects", () => {
  const before = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  const valid = createDrawingGestureValidator(before);
  expect(valid(before)).toBe(true);
  expect(valid({ ...before, annotations: [...before.annotations, before.annotations[0]!] })).toBe(
    false,
  );
  expect(valid({ ...before, annotations: [{ ...before.annotations[0]!, fontSize: 1001 }] })).toBe(
    false,
  );
  expect(valid({ ...before, annotations: [{ ...before.annotations[0]!, x: 1e7 + 1 }] })).toBe(
    false,
  );
  expect(valid({ ...before, width: 0 })).toBe(false);
});

test("drawing patches retain untouched drawings, ordering, deletion and warnings", () => {
  const first = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  const second = { ...first, projectId: "00000000-0000-4000-8000-000000000002" };
  const changed = { ...first, warnings: ["图形警告"], revision: first.revision + 1 };
  const patch = drawingProjectEdits([first, second], [second, changed]);
  expect(patch.projects).toEqual([changed]);
  const result = applyDrawingProjectEdits([first, second], patch);
  expect(result).toEqual([second, changed]);
  expect(result[0]).toBe(second);
  expect(applyDrawingProjectEdits(result, drawingProjectEdits(result, [second]))).toEqual([second]);
  expect(() =>
    applyDrawingProjectEdits([first], { projectIds: [second.projectId], projects: [] }),
  ).toThrow();
  expect(
    DrawingProjectEditsSchema.safeParse({
      projectIds: [first.projectId, first.projectId],
      projects: [],
    }).success,
  ).toBe(false);
  expect(DrawingProjectEditsSchema.safeParse({ projectIds: [], projects: [first] }).success).toBe(
    false,
  );
});
