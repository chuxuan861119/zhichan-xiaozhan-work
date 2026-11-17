import { describe, expect, it } from "vitest";
import {
  baseFragments,
  deleteBase,
  extractBase,
  fragmentLocalPoint,
  moveBase,
  rotateBase,
  scaleBase,
  translateFragments,
} from "./base-fragments.js";
import { pointInside } from "./geometry.js";
import { type DrawingProject, DrawingProjectSchema } from "./model.js";

const rectangle = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const project: DrawingProject = {
  projectId: "12345678-1234-4234-8234-123456789abc",
  name: "test",
  sourceAssetId: "12345678-1234-4234-8234-123456789abc",
  baseAssetId: "12345678-1234-4234-8234-123456789abc",
  sourceKind: "image",
  pageNumber: 1,
  width: 100,
  height: 100,
  annotations: [],
  regions: [],
  warnings: [],
  revision: 0,
};
function contains(p: DrawingProject, x: number, y: number) {
  return baseFragments(p).some((f) => {
    const q = fragmentLocalPoint(f, { x, y });
    return f.clips.every((c) => pointInside(q, c)) && !f.holes.some((h) => pointInside(q, h));
  });
}
describe("editable base fragments", () => {
  it("moves content out of the original position and survives serialization", () => {
    const p = DrawingProjectSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...project,
          baseFragments: moveBase(project, rectangle(10, 10, 20, 20), 120, 0, "move"),
        }),
      ),
    );
    expect(contains(p, 20, 20)).toBe(false);
    expect(contains(p, 140, 20)).toBe(true);
    expect(contains(p, 80, 80)).toBe(true);
    expect(project.baseFragments).toBeUndefined();
  });
  it("copies a previously moved area without resurrecting holes", () => {
    const moved = {
      ...project,
      baseFragments: moveBase(project, rectangle(10, 10, 20, 20), 120, 0, "move"),
    };
    const copy = {
      ...moved,
      baseFragments: [
        ...baseFragments(moved),
        ...translateFragments(extractBase(moved, rectangle(0, 0, 100, 100)), 0, 120, "copy"),
      ],
    };
    expect(contains(copy, 20, 140)).toBe(false);
    expect(contains(copy, 80, 200)).toBe(true);
    expect(contains(copy, 140, 20)).toBe(true);
  });
  it("keeps lasso clipping and removes fully moved fragments on repeated moves", () => {
    let p = {
      ...project,
      baseFragments: moveBase(project, rectangle(0, 0, 100, 100), 100, 0, "first"),
    };
    for (let i = 1; i < 30; i++)
      p = { ...p, baseFragments: moveBase(p, rectangle(i * 100, 0, 100, 100), 100, 0, `move${i}`) };
    expect(p.baseFragments).toHaveLength(1);
    const lasso = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    const copied = {
      ...project,
      baseFragments: translateFragments(extractBase(project, lasso), 200, 0, "lasso"),
    };
    expect(contains(copied, 210, 10)).toBe(true);
    expect(contains(copied, 290, 90)).toBe(false);
  });
});

it("scales around a fixed opposite corner, then moves and copies the scaled content", () => {
  const enlarged = DrawingProjectSchema.parse(
    JSON.parse(
      JSON.stringify({
        ...project,
        baseFragments: scaleBase(project, rectangle(0, 0, 100, 100), { x: 0, y: 100 }, 2, "scale"),
      }),
    ),
  );
  expect(contains(enlarged, 180, -80)).toBe(true);
  expect(contains(enlarged, 210, 20)).toBe(false);
  const moved = {
    ...enlarged,
    baseFragments: moveBase(enlarged, rectangle(0, -100, 200, 200), 250, 0, "move"),
  };
  expect(contains(moved, 180, -80)).toBe(false);
  expect(contains(moved, 430, -80)).toBe(true);
  expect(extractBase(moved, rectangle(250, -100, 200, 200))).toHaveLength(1);
  expect(project.baseFragments).toBeUndefined();
});

it("rotates a cropped base and deletes it without resurrecting the original", () => {
  const selection = rectangle(0, 0, 100, 100);
  const rotated = DrawingProjectSchema.parse({
    ...project,
    baseFragments: rotateBase(project, selection, { x: 0, y: 0 }, 90, "rotate"),
  });
  expect(contains(rotated, -50, 50)).toBe(true);
  expect(contains(rotated, 50, 50)).toBe(false);
  const deleted = { ...rotated, baseFragments: deleteBase(rotated, rectangle(-100, 0, 100, 100)) };
  expect(contains(deleted, -50, 50)).toBe(false);
  expect(contains(deleted, 50, 50)).toBe(false);
});
