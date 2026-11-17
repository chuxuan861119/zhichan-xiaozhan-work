import { describe, expect, test } from "vitest";
import { cadGearGripLabel, cadGripPreviewPaths, cadTextGripPreview } from "./cad-grip-preview";
import type { CadScene } from "./cadcraft-client";

const base: CadScene = {
  revision: 0,
  entityCount: 1,
  selection: ["A"],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: [],
  primitives: [],
};

test("gear dragging hint uses one decimal without changing its dimensions", () => {
  const gear = { kind: "external" as const, teeth: 20, size: 80.123456, hole: true };
  expect(cadGearGripLabel(gear, 1)).toBe("缩放 · 外径 80.1");
  expect(gear.size).toBe(80.123456);
});

test("gear size and rotation previews keep the centre fixed rather than translating the gear", () => {
  const scene: CadScene = {
    ...base,
    entities: [
      {
        handle: "G",
        type: "Block Reference",
        layer: "0",
        gear: { kind: "external", teeth: 20, hole: true, size: 80 },
        grips: [
          [10, 20],
          [50, 20],
          [-40, 20],
          [10, 76],
        ],
      },
    ],
    primitives: [
      {
        handle: "G",
        kind: "polyline",
        points: [
          [50, 20],
          [10, 60],
        ],
        color: [0, 0, 0],
        aci7: true,
        lineweight: 0,
      },
    ],
  };
  expect(cadGripPreviewPaths(scene, { handle: "G", index: 1 }, { x: 90, y: 20 })).toEqual([
    [
      { x: 90, y: 20 },
      { x: 10, y: 100 },
    ],
  ]);
  const rotated = cadGripPreviewPaths(scene, { handle: "G", index: 3 }, { x: -46, y: 20 })[0]!;
  expect(rotated[0]!.x).toBeCloseTo(10);
  expect(rotated[0]!.y).toBeCloseTo(60);
  expect(rotated[1]!.x).toBeCloseTo(-30);
  expect(rotated[1]!.y).toBeCloseTo(20);
  expect(cadGripPreviewPaths(scene, { handle: "G", index: 2 }, { x: -48, y: 20 })).toEqual([]);
});
test("text width and scale grips keep the insertion point and never translate the whole text", () => {
  const scene: CadScene = {
    ...base,
    entities: [
      {
        handle: "T",
        type: "MText",
        layer: "0",
        textOrigin: [10, 20],
        plainText: "中文",
        height: 5,
        width: 30,
        rotation: 0,
        grips: [
          [10, 20],
          [40, 20],
          [40, 10],
        ],
      },
    ],
  };
  expect(cadTextGripPreview(scene, { handle: "T", index: 1 }, { x: 70, y: 25 })).toMatchObject({
    at: { x: 10, y: 20 },
    width: 60,
    height: 5,
  });
  expect(cadTextGripPreview(scene, { handle: "T", index: 2 }, { x: 70, y: 25 })).toMatchObject({
    at: { x: 10, y: 20 },
    width: 60,
    height: 10,
  });
  expect(cadTextGripPreview(scene, { handle: "T", index: 0 }, { x: 70, y: 25 })).toMatchObject({
    at: { x: 70, y: 25 },
    width: 30,
    height: 5,
  });
});

describe("CAD grip live preview", () => {
  test("line endpoint stretches while its midpoint translates the full line", () => {
    const scene: CadScene = {
      ...base,
      entities: [
        {
          handle: "A",
          type: "Line",
          layer: "0",
          grips: [
            [0, 0],
            [10, 0],
            [20, 0],
          ],
          geometry: { type: "Line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
        },
      ],
    };
    expect(cadGripPreviewPaths(scene, { handle: "A", index: 0 }, { x: 2, y: 3 })).toEqual([
      [
        { x: 2, y: 3 },
        { x: 20, y: 0 },
      ],
    ]);
    expect(cadGripPreviewPaths(scene, { handle: "A", index: 1 }, { x: 12, y: 3 })).toEqual([
      [
        { x: 2, y: 3 },
        { x: 22, y: 3 },
      ],
    ]);
  });

  test("circle centre moves the circle while a quadrant grip changes its radius", () => {
    const scene: CadScene = {
      ...base,
      entities: [
        {
          handle: "A",
          type: "Circle",
          layer: "0",
          radius: 10,
          grips: [
            [0, 0],
            [10, 0],
            [0, 10],
            [-10, 0],
            [0, -10],
          ],
          geometry: { type: "Circle", center: { x: 0, y: 0 }, radius: 10 },
        },
      ],
      primitives: [
        {
          handle: "A",
          kind: "polyline",
          points: [
            [10, 0],
            [0, 10],
            [-10, 0],
          ],
          color: [0, 0, 0],
          aci7: true,
          lineweight: 0,
        },
      ],
    };
    expect(cadGripPreviewPaths(scene, { handle: "A", index: 0 }, { x: 2, y: 3 })).toEqual([
      [
        { x: 12, y: 3 },
        { x: 2, y: 13 },
        { x: -8, y: 3 },
      ],
    ]);
    const resized = cadGripPreviewPaths(scene, { handle: "A", index: 1 }, { x: 20, y: 0 });
    expect(resized[0]?.[0]).toEqual({ x: 20, y: 0 });
    expect(resized[0]).toHaveLength(73);
  });

  test("rotating an ellipse's major grip keeps its axes perpendicular in preview", () => {
    const scene: CadScene = {
      ...base,
      entities: [
        {
          handle: "A",
          type: "Ellipse",
          layer: "0",
          grips: [
            [0, 0],
            [10, 0],
            [0, 5],
            [-10, 0],
            [0, -5],
          ],
        },
      ],
    };
    const path = cadGripPreviewPaths(scene, { handle: "A", index: 1 }, { x: 0, y: 10 })[0];
    expect(path?.[0]?.x).toBeCloseTo(0);
    expect(path?.[0]?.y).toBeCloseTo(10);
    expect(path?.[18]?.x).toBeCloseTo(-5);
    expect(path?.[18]?.y).toBeCloseTo(0);
  });
});
