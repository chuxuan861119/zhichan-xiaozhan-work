import { expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import {
  cadPreviewGeometry,
  expandCadGroups,
  resolveCadPointer,
  resolveCadWindow,
  validCadProperty,
} from "./cad-interaction";
import type { CadScene } from "./cadcraft-client";

test("ellipse preview keeps both axes when the second radius is larger", () => {
  const result = cadPreviewGeometry(
    "ellipse",
    null,
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ],
    { x: 0, y: 10 },
  );
  expect(result.paths).toHaveLength(1);
  expect(Math.max(...result.paths[0]!.map((p) => p.x))).toBeCloseTo(4);
  expect(Math.max(...result.paths[0]!.map((p) => p.y))).toBeCloseTo(10);
});

test("window direction remains screen based after rotating the fragment", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: project.sourceAssetId,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  project.baseFragments = [
    { id: "r", offset: { x: 100, y: 100 }, rotation: 180, scale: 1, clips: [], holes: [] },
  ];
  const box = resolveCadWindow(project, { x: 20, y: 20 }, { x: 80, y: 80 }, 4)!;
  expect(box.crossing).toBe(false);
  expect(box.polygon).toHaveLength(4);
  expect(box.polygon[0]!.x).toBeGreaterThan(box.polygon[1]!.x);
});

test("group selection expands visible members transitively without hidden members", () => {
  const scene = {
    entities: [
      { handle: "a" },
      { handle: "b" },
      { handle: "c" },
      { handle: "hidden", visible: false },
    ],
    groups: [
      { selectable: true, members: ["a", "b"] },
      { selectable: true, members: ["b", "c", "hidden"] },
    ],
  } as CadScene;
  expect(expandCadGroups(scene, ["a"])).toEqual(["a", "b", "c"]);
});

test("property controls reject unsupported types and invalid numbers", () => {
  expect(validCadProperty("radius", "-1", ["Circle"])).toBe(false);
  expect(validCadProperty("radius", "2", ["Circle", "Line"])).toBe(false);
  expect(validCadProperty("color", "1.5", ["Line"])).toBe(false);
  expect(validCadProperty("height", "2", ["Text", "MText"])).toBe(true);
});

test("pointer mapping stays on the starting rotated fragment while dragging outside it", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: project.sourceAssetId,
    mapping: { originX: 0, originY: 800, scale: 2 },
  };
  project.baseFragments = [
    {
      id: "rotated",
      offset: { x: 200, y: 100 },
      rotation: 90,
      scale: 2,
      clips: [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      ],
      holes: [],
    },
  ];
  expect(resolveCadPointer(project, { x: 100, y: 200 }, 8)).toMatchObject({
    point: { x: 25, y: 775 },
    tolerance: 2,
    fragmentId: "rotated",
  });
  expect(resolveCadPointer(project, { x: 100, y: 400 }, 8)).toBeNull();
  expect(resolveCadPointer(project, { x: 100, y: 400 }, 8, "rotated")?.point).toEqual({
    x: 75,
    y: 775,
  });
});

test("live rectangle and circle previews use the same final geometry as clicks", () => {
  expect(cadPreviewGeometry("rectang", { x: 2, y: 3 }, [], { x: 5, y: 7 }).paths[0]).toEqual([
    { x: 2, y: 3 },
    { x: 5, y: 3 },
    { x: 5, y: 7 },
    { x: 2, y: 7 },
    { x: 2, y: 3 },
  ]);
  expect(cadPreviewGeometry("circle", { x: 2, y: 3 }, [], { x: 5, y: 7 }).circle).toEqual({
    center: { x: 2, y: 3 },
    radius: 5,
  });
  expect(
    cadPreviewGeometry(
      "pline",
      null,
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      { x: 5, y: 6 },
    ).paths[0],
  ).toHaveLength(3);
});

test("three point arc previews follow the curve through the middle point", () => {
  const result = cadPreviewGeometry(
    "arc",
    null,
    [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    { x: 20, y: 0 },
  );
  expect(result.paths[0]!.length).toBeGreaterThan(10);
  expect(result.paths[0]![0]!.x).toBeCloseTo(0);
  expect(result.paths[0]!.at(-1)!.x).toBeCloseTo(20);
  expect(Math.max(...result.paths[0]!.map((p) => p.y))).toBeCloseTo(10, 1);
});

test("polygon preview puts its first vertex at the cursor", () => {
  for (const sides of [3, 4, 5, 6]) {
    const first = cadPreviewGeometry("polygon", null, [{ x: 0, y: 0 }], { x: 10, y: 0 }, sides)
      .paths[0]![0]!;
    expect(first.x).toBeCloseTo(10);
    expect(first.y).toBeCloseTo(0);
  }
});
