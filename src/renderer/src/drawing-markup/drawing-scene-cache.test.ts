import { expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { createAnnotationLayoutCache, createDrawingSidebarCache } from "./drawing-scene-cache";

test("coordinate edits reuse untouched label layouts and style-equivalent scale objects", () => {
  const p = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  const layout = createAnnotationLayoutCache(),
    a = p.annotations[0]!;
  const before = layout(a, { unitsPerMm: 10 });
  expect(layout(a, { unitsPerMm: 10 })).toBe(before);
  expect(layout({ ...a, x: a.x + 1 }, { unitsPerMm: 10 })).not.toBe(before);
  expect(layout(a, { unitsPerMm: 20 })).not.toBe(before);
});

test("sidebar stays stable during movement and updates across renumber, delete, undo and figure reorder", () => {
  const p = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  const f1 = "00000000-0000-4000-8000-000000000002",
    f2 = "00000000-0000-4000-8000-000000000003";
  p.regions[0]!.figureId = f1;
  const cache = createDrawingSidebarCache(),
    before = cache([p], [{ figureId: f1 }, { figureId: f2 }]);
  const moved = { ...p, annotations: p.annotations.map((a) => ({ ...a, x: a.x + 1 })) };
  const after = cache([moved], [{ figureId: f1 }, { figureId: f2 }]);
  expect(after.numbers).toBe(before.numbers);
  expect(after.regions).toBe(before.regions);
  expect(
    cache([{ ...moved, annotations: moved.annotations.map((a) => ({ ...a, text: "13" })) }], [])
      .numbers,
  ).toEqual(new Set(["13"]));
  expect(cache([{ ...moved, annotations: [] }], []).numbers.size).toBe(0);
  expect(cache([p], [{ figureId: f2 }, { figureId: f1 }]).regions[0]?.name).toBe("图2");
  expect(cache([p], []).numbers.has("12")).toBe(true);
});
