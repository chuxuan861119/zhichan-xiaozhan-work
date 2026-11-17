import { expect, test } from "vitest";
import { outputSize } from "../../../shared/drawing-markup/geometry";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { cadFigureSelection } from "./cad-figure-selection";
import type { CadScene } from "./cadcraft-client";

test("CAD figure selection excludes unselected geometry and annotations", () => {
  const project = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
    width: 1000,
    height: 800,
    annotations: [
      {
        id: "chosen-label",
        x: 60,
        y: 70,
        text: "1",
        fontSize: 10,
        lineWidth: 1,
        points: [{ x: 20, y: 20 }],
      },
      { id: "other-label", x: 800, y: 700, text: "2", fontSize: 10, lineWidth: 1, points: [] },
    ],
    detailViews: [],
    cad: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "0".repeat(40),
      assetId: "00000000-0000-4000-8000-000000000002",
      mapping: { originX: 0, originY: 800, scale: 1 },
      objects: [
        { id: "chosen-label", kind: "label" as const, label: ["102"] },
        { id: "other-label", kind: "label" as const, label: ["103"] },
      ],
    },
  };
  const scene = {
    partial: false,
    revision: 1,
    entityCount: 4,
    selection: ["100", "102"],
    bounds: null,
    svgFrame: { origin: [0, 800], width: 1000, height: 800 },
    entities: [
      {
        handle: "100",
        grips: [
          [20, 780],
          [80, 720],
        ],
      },
      {
        handle: "101",
        grips: [
          [700, 100],
          [900, 100],
        ],
      },
      { handle: "102", grips: [[60, 730]] },
      { handle: "103", grips: [[800, 100]] },
    ],
    primitives: [
      {
        handle: "100",
        points: [
          [20, 780],
          [80, 720],
        ],
      },
      {
        handle: "101",
        points: [
          [700, 100],
          [900, 100],
        ],
      },
    ],
  } as CadScene;
  const selection = cadFigureSelection(project, { scene, handles: ["100", "102"] });
  expect(selection?.project.annotations.map((mark) => mark.id)).toEqual(["chosen-label"]);
  expect(selection?.project.detailViews).toEqual([]);
  expect(selection?.region.points.every((point) => point.x < 200 && point.y < 200)).toBe(true);
  expect(selection?.region.points.some((point) => point.x <= 20 && point.y <= 20)).toBe(true);
  expect(selection?.region.cadHandles).toEqual(["100", "102"]);
});

test("selected CAD text expands the output bounds beyond its insertion point", () => {
  const project = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
    width: 500,
    height: 500,
    cad: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "0".repeat(40),
      assetId: "00000000-0000-4000-8000-000000000002",
      mapping: { originX: 0, originY: 500, scale: 1 },
    },
  };
  const scene = {
    partial: false,
    revision: 1,
    entityCount: 1,
    selection: ["100"],
    bounds: null,
    svgFrame: { origin: [0, 500], width: 500, height: 500 },
    entities: [
      {
        handle: "100",
        type: "TEXT",
        layer: "0",
        textOrigin: [100, 400],
        width: 120,
        height: 20,
        rotation: 0,
      },
    ],
    primitives: [],
  } as CadScene;
  const region = cadFigureSelection(project, { scene, handles: ["100"] })?.region;
  expect(region).toBeDefined();
  expect(Math.max(...(region?.points ?? []).map((point) => point.x))).toBeGreaterThan(215);
});

test.each(["vertical", "horizontal"])(
  "a single %s CAD line remains exportable at both DPIs",
  (orientation) => {
    const project = {
      ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
      width: 1200,
      height: 1200,
      cad: {
        version: 1 as const,
        engine: "cadcraft" as const,
        engineVersion: "0".repeat(40),
        assetId: "00000000-0000-4000-8000-000000000002",
        mapping: { originX: 0, originY: 1200, scale: 1 },
      },
    };
    const points =
      orientation === "vertical"
        ? [
            [100, 100],
            [100, 1100],
          ]
        : [
            [100, 100],
            [1100, 100],
          ];
    const scene = {
      partial: false,
      revision: 1,
      entityCount: 1,
      selection: ["100"],
      bounds: null,
      svgFrame: { origin: [0, 1200], width: 1200, height: 1200 },
      entities: [{ handle: "100", grips: points }],
      primitives: [{ handle: "100", points }],
    } as CadScene;
    const region = cadFigureSelection(project, { scene, handles: ["100"] })?.region;
    if (!region) throw new Error("CAD selection did not create a figure region");
    for (const dpi of [300, 600]) expect(() => outputSize(region.points, 120, dpi)).not.toThrow();
  },
);
