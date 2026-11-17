import { expect, test } from "vitest";
import { cadSceneDelta, mergeCadScene } from "./cad-scene-delta";
import type { CadScene } from "./cadcraft-client";

const base: CadScene = {
  revision: 1,
  entityCount: 2,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 10, height: 10 },
  primitives: [],
  entities: [
    { handle: "A", type: "Line", layer: "0" },
    { handle: "B", type: "Line", layer: "0" },
  ],
};

test("edit deltas preserve unrelated identities and order while replacing every primitive of a handle", () => {
  const primitive = (handle: string, x: number): CadScene["primitives"][number] => ({
    handle,
    kind: "polyline",
    points: [
      [x, 0],
      [x + 1, 1],
    ],
    color: [0, 0, 0],
    aci7: true,
    lineweight: 0,
  });
  const old = { ...base, primitives: [primitive("A", 0), primitive("A", 2), primitive("B", 4)] };
  const delta = {
    ...base,
    partial: true,
    entities: [{ ...base.entities[0]!, geometry: { type: "Line" } }],
    primitives: [primitive("A", 10)],
  };
  const result = mergeCadScene(old, delta);
  expect(result.entities[1]).toBe(old.entities[1]);
  expect(result.primitives.map((p) => p.handle)).toEqual(["A", "B"]);
  expect(result.primitives[1]).toBe(old.primitives[2]);
  expect(result.bounds).toEqual({ min: [4, 0], max: [11, 1] });
  const erased = mergeCadScene(result, {
    ...base,
    partial: true,
    entities: [],
    primitives: [],
    removedHandles: ["A", "B"],
  });
  expect(erased.entities).toEqual([]);
  expect(erased.primitives).toEqual([]);
  expect(erased.bounds).toBeNull();
  expect(mergeCadScene(result, base)).toBe(base);
});
test("partial previews never infer deletion from absence", () => {
  const delta = cadSceneDelta(base, {
    ...base,
    partial: true,
    entities: [{ handle: "C", type: "Line", layer: "0" }],
    removedHandles: ["A"],
  });
  expect([...delta.changed]).toEqual(["C"]);
  expect([...delta.touched].sort()).toEqual(["A", "C"]);
});

test("infinite-line direction vectors do not change the finite drawing frame", () => {
  const old = {
    ...base,
    primitives: [
      {
        handle: "A",
        kind: "infinite",
        points: [
          [500, 500],
          [1, 0],
        ],
        color: [0, 0, 0],
        aci7: true,
        lineweight: 0,
      },
    ] as CadScene["primitives"],
  };
  const result = mergeCadScene(old, { ...base, partial: true, entities: [], primitives: [] });
  expect(result.bounds).toBeNull();
  expect(result.primitives).toEqual(old.primitives);
});
test("full preview fallback detects deletions without per-primitive comparisons", () => {
  const delta = cadSceneDelta(base, {
    ...base,
    entities: [base.entities[1]!, { handle: "C", type: "Line", layer: "0" }],
  });
  expect([...delta.changed]).toEqual(["C"]);
  expect([...delta.touched].sort()).toEqual(["A", "C"]);
});
