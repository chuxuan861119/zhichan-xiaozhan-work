import { expect, test } from "vitest";
import { moveDetailParts, selectedDetailParts, translateDetailCopy } from "./detail-selection.js";
import { createDetailView } from "./detail-view.js";
import { drawingProjectFixture } from "./test-fixture.js";

const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
const d = createDetailView(
  { ...project, detailViews: [] },
  { x: 300, y: 300 },
  50,
  { x: 700, y: 300 },
  "A",
  1,
  12,
  1,
  "detail",
);
test("moving an area containing the source and enlarged view preserves sampled content", () => {
  const ids = selectedDetailParts(d, [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 800 },
    { x: 0, y: 800 },
  ]);
  const moved = moveDetailParts(d, ids, 100, 200);
  expect(moved.source).toEqual({ x: 400, y: 500 });
  expect(moved.center).toEqual({ x: 800, y: 500 });
  expect(moved.source.x - moved.fragments[0]!.offset.x).toBe(d.source.x - d.fragments[0]!.offset.x);
});
test("copy translation retains nested sampling scale and source coordinates relative to snapshots", () => {
  const copy = translateDetailCopy({ ...d, sourceScale: 6 }, 200, 300);
  expect(copy.sourceScale).toBe(6);
  expect(copy.source.y - copy.fragments[0]!.offset.y).toBe(d.source.y - d.fragments[0]!.offset.y);
  expect(d.center).toEqual({ x: 700, y: 300 });
});
