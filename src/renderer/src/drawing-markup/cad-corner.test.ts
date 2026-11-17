import { expect, test } from "vitest";
import { cornerCandidates, cornerGeometry, cornerGrips, dragCorner } from "./cad-corner";
import type { CadScene } from "./cadcraft-client";

const line = (handle: string, a: number[], b: number[]) => ({
  handle,
  type: "Line",
  layer: "0",
  geometry: { type: "line", a: { x: a[0]!, y: a[1]!, z: 0 }, b: { x: b[0]!, y: b[1]!, z: 0 } },
});
function scene(entities: CadScene["entities"]): CadScene {
  return {
    entities,
    primitives: [],
    entityCount: entities.length,
    revision: 1,
    selection: [],
    bounds: null,
    svgFrame: { origin: [0, 100], width: 100, height: 100 },
  };
}
test("a connected pair is one corner with one radius grip and three chamfer grips", () => {
  const s = scene([line("A", [100, 0], [0, 0]), line("B", [0, 0], [0, 100])]);
  const target = cornerCandidates(s, "fillet")[0]!;
  expect(target.corner).toEqual({ x: 0, y: 0 });
  expect(cornerGrips(target, { kind: "fillet", a: 20, b: 20 })).toHaveLength(1);
  expect(cornerGrips(target, { kind: "chamfer", a: 20, b: 10 })).toHaveLength(3);
  const change = cornerGeometry(target, { kind: "fillet", a: 20, b: 20 });
  expect(change.params.edits).toHaveLength(2);
  expect(change.params.create?.geometry).toMatchObject({ type: "arc", radius: 20 });
  expect(change.paths).toHaveLength(3);
});
test("whole rectangles stay closed polylines and only the chosen corner changes", () => {
  const geometry = {
    type: "lwPolyline",
    closed: true,
    vertices: [
      { p: { x: 0, y: 0 }, bulge: 0 },
      { p: { x: 100, y: 0 }, bulge: 0 },
      { p: { x: 100, y: 100 }, bulge: 0 },
      { p: { x: 0, y: 100 }, bulge: 0 },
    ],
    constWidth: 0,
    elevation: 0,
    plinegen: false,
  };
  const s = scene([{ handle: "P", type: "Polyline", layer: "0", geometry }]);
  const target = cornerCandidates(s, "chamfer").find(
    (t) => t.corner.x === 100 && t.corner.y === 0,
  )!;
  const result = cornerGeometry(target, { kind: "chamfer", a: 20, b: 10 });
  expect(result.params.edits).toHaveLength(1);
  expect(result.params.edits[0]!.after).toMatchObject({
    closed: true,
    vertices: expect.arrayContaining([{ p: { x: 0, y: 100 }, bulge: 0 }]),
  });
  expect(result.params.create).toBeUndefined();
  const modified = scene([{ ...s.entities[0]!, geometry: result.params.edits[0]!.after }]);
  expect(cornerCandidates(modified, "chamfer").some((t) => t.existing)).toBe(true);
});
test("asymmetric side grips change only their side; the center grip retains the slope ratio", () => {
  const t = cornerCandidates(
    scene([line("A", [100, 0], [0, 0]), line("B", [0, 0], [0, 100])]),
    "chamfer",
  )[0]!;
  const value = { kind: "chamfer" as const, a: 20, b: 10 };
  const grips = cornerGrips(t, value);
  expect(dragCorner(t, value, 1, { x: 40, y: 0 })).toMatchObject({ a: 40, b: 10 });
  expect(dragCorner(t, value, 2, { x: 0, y: 30 })).toMatchObject({ a: 20, b: 30 });
  expect(dragCorner(t, value, 0, { x: grips[0]!.x * 2, y: grips[0]!.y * 2 })).toMatchObject({
    a: 40,
    b: 20,
  });
});
test("locked or hidden objects are not corner candidates", () => {
  const s = scene([{ ...line("A", [100, 0], [0, 0]), locked: true }, line("B", [0, 0], [0, 100])]);
  expect(cornerCandidates(s, "fillet")).toHaveLength(0);
});
