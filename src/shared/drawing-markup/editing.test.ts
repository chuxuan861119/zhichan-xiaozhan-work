import { expect, it } from "vitest";
import {
  moveAnnotation,
  nextDrawingLabel,
  resizeRectangle,
  restoreDrawingHistory,
} from "./editing.js";
import { DrawingProjectSchema } from "./model.js";
import { drawingProjectFixture } from "./test-fixture.js";

const project = drawingProjectFixture("00000000-0000-4000-8000-000000000802");
it("continues legacy numbers and round trips explicit sequence preferences", () => {
  expect(nextDrawingLabel(project)).toBe("13");
  const saved = DrawingProjectSchema.parse({ ...project, nextLabel: "4", repeatLabel: true });
  expect(nextDrawingLabel(saved)).toBe("4");
  expect(saved.repeatLabel).toBe(true);
  expect(nextDrawingLabel({ ...project, annotations: [] })).toBe("1");
});
it("resizes only the chosen edges even after crossing the opposite edge", () => {
  const points = project.regions[0]!.points;
  expect(resizeRectangle(points, "e", { x: 600, y: 200 })).toEqual([
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 500 },
    { x: 0, y: 500 },
  ]);
  expect(resizeRectangle(points, "nw", { x: 600, y: 600 })).toEqual([
    { x: 600, y: 600 },
    { x: 500, y: 600 },
    { x: 500, y: 500 },
    { x: 600, y: 500 },
  ]);
});
it("moving text or its terminal keeps the source anchor fixed and the leader attached", () => {
  const a = project.annotations[0]!;
  const moved = moveAnnotation(a, 10, 20);
  expect(moved.points[0]).toEqual(a.points[0]);
  expect(moved.points[1]).toEqual({ x: 170, y: 120 });
  expect([moved.x, moved.y]).toEqual([210, 120]);
});
it("undo retains published image links without reverting publication or unrelated figures", () => {
  const current = {
    ...project,
    regions: [
      {
        ...project.regions[0]!,
        figureId: "00000000-0000-4000-8000-000000000803",
        exportedRevision: 8,
      },
    ],
  };
  const restored = restoreDrawingHistory(project, current);
  expect(restored.regions[0]?.figureId).toBe(current.regions[0]?.figureId);
  expect(restored.regions[0]?.exportedRevision).toBe(8);
  expect(restoreDrawingHistory({ ...project, regions: [] }, current).regions).toEqual(
    current.regions,
  );
});
