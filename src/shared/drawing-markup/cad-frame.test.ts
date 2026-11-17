import { expect, test } from "vitest";
import { fragmentWorldPoint } from "./base-fragments.js";
import { reframeCadProject } from "./cad-frame.js";
import { cadToPage } from "./cad-state.js";
import type { DrawingProject } from "./model.js";

test("expanding CAD frame keeps rotated fragment, annotation and frozen detail aligned", () => {
  const cad = {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "a".repeat(40),
    assetId: crypto.randomUUID(),
    mapping: { originX: 0, originY: 10, scale: 2 },
  };
  const fragment = {
    id: "f",
    offset: { x: 15, y: 20 },
    rotation: 45,
    scale: 2,
    clips: [
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ],
    ],
    holes: [],
  };
  const project = {
    cad,
    width: 20,
    height: 20,
    annotations: [{ x: 10, y: 10, points: [{ x: 8, y: 8 }] }],
    regions: [],
    baseFragments: [fragment],
    detailViews: [
      {
        center: { x: 10, y: 10 },
        title: { x: 12, y: 12 },
        marker: { x: 3, y: 3 },
        source: { x: 2, y: 2 },
        fragments: [fragment],
        cadSource: { ...cad, baseAssetId: "frozen" },
      },
    ],
  } as unknown as DrawingProject;
  const nextCad = { ...cad, mapping: { originX: -5, originY: 15, scale: 2 } };
  const next = reframeCadProject(project, nextCad, 40, 40);
  expect(next.annotations[0]).toMatchObject({ x: 20, y: 20, points: [{ x: 18, y: 18 }] });
  const oldPoint = fragmentWorldPoint(fragment, cadToPage({ x: 5, y: 5 }, cad.mapping));
  const newPoint = fragmentWorldPoint(
    next.baseFragments![0]!,
    cadToPage({ x: 5, y: 5 }, nextCad.mapping),
  );
  expect(newPoint.x - oldPoint.x).toBeCloseTo(10);
  expect(newPoint.y - oldPoint.y).toBeCloseTo(10);
  expect(next.detailViews![0]!.source).toEqual({ x: 12, y: 12 });
  expect(next.detailViews![0]!.fragments[0]!.offset.x - next.detailViews![0]!.source.x).toBe(
    fragment.offset.x - project.detailViews![0]!.source.x,
  );
  expect(next.detailViews![0]!.fragments[0]!.clips).toBe(fragment.clips);
  expect(next.detailViews![0]!.center).toEqual({ x: 20, y: 20 });
});
