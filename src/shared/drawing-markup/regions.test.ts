import { expect, it } from "vitest";
import { allFigureDrawingRegions, figureDrawingRegions, savedDrawingRegions } from "./regions.js";
import { drawingProjectFixture } from "./test-fixture.js";

it("saves published links only and lists only figures that still exist", () => {
  const region = drawingProjectFixture("00000000-0000-4000-8000-000000000802").regions[0]!;
  const draft = { ...region, id: "draft" };
  const figure = { ...region, id: "figure", figureId: "figure-1" };
  const deleted = { ...region, id: "deleted", figureId: "figure-2" };
  const body = { ...region, id: "body", bodyNodeId: "node-1" };
  expect(savedDrawingRegions([draft, figure, deleted, body])).toEqual([figure, deleted, body]);
  expect(figureDrawingRegions([draft, figure, deleted, body], ["figure-1"])).toEqual([
    { ...figure, name: "图1" },
  ]);
  // Undoing the figure deletion can show its original editable range again.
  expect(figureDrawingRegions([deleted], ["figure-2"])).toEqual([{ ...deleted, name: "图1" }]);
});

it("uses document figure order and numbering instead of saved custom names", () => {
  const region = drawingProjectFixture("00000000-0000-4000-8000-000000000802").regions[0]!;
  const a = { ...region, id: "a", figureId: "a", name: "自定义图99" };
  const b = { ...region, id: "b", figureId: "b", name: "图7" };
  expect(figureDrawingRegions([a, b], ["b", "unrelated", "a"])).toEqual([
    { ...b, name: "图1" },
    { ...a, name: "图3" },
  ]);
  expect(a.name).toBe("自定义图99");
});

it("lists figures from all drawings in document order and retains their source", () => {
  const first = drawingProjectFixture("asset-a");
  const second = { ...drawingProjectFixture("asset-b"), projectId: "second" };
  first.regions = [{ ...first.regions[0]!, figureId: "figure-a" }];
  second.regions = [{ ...second.regions[0]!, figureId: "figure-b" }];
  const listed = allFigureDrawingRegions([first, second], ["figure-b", "unrelated", "figure-a"]);
  expect(listed.map(({ projectId, name, figureId }) => ({ projectId, name, figureId }))).toEqual([
    { projectId: "second", name: "图1", figureId: "figure-b" },
    { projectId: first.projectId, name: "图3", figureId: "figure-a" },
  ]);
  expect(allFigureDrawingRegions([first, second], ["figure-a"])).toHaveLength(1);
});
