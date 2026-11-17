import { expect, test } from "vitest";
import {
  arcContains,
  bulgeArc,
  commonTangents,
  draftingGeometry,
  perpendicularFoot,
  tangentArcEnds,
  tangentPoints,
} from "./cad-drafting-geometry";
import type { CadScene } from "./cadcraft-client";

const circle = { id: "C", handle: "C", center: { x: 0, y: 0 }, radius: 5 };
test("arc tangency retains small local drawings translated far from the origin", () => {
  const transform = (x: number, y: number) => ({
    x: 1e6 + (x * Math.cos(0.37) - y * Math.sin(0.37)) * 0.001,
    y: -1e6 + (x * Math.sin(0.37) + y * Math.cos(0.37)) * 0.001,
  });
  const contacts = tangentArcEnds(transform(1, 2), transform(5, 2), {
    id: "L",
    handle: "L",
    a: transform(0, 0),
    b: transform(10, 0),
  });
  expect(contacts).toHaveLength(1);
  const expected = transform(3, 0);
  expect(
    Math.hypot(contacts[0]!.point.x - expected.x, contacts[0]!.point.y - expected.y),
  ).toBeLessThan(1e-9);
});
test("three-point arc tangency solves real centers and excludes finite-edge extensions and coincident circles", () => {
  const a = { x: 1, y: 2 },
    b = { x: 5, y: 2 };
  const edge = { id: "L", handle: "L", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  const results = tangentArcEnds(a, b, edge);
  expect(results).toHaveLength(1);
  expect(results[0]!.point).toEqual({ x: 3, y: 0 });
  expect(tangentArcEnds(a, b, { ...edge, b: { x: 2, y: 0 } })).toEqual([]);
  expect(tangentArcEnds(a, a, edge)).toEqual([]);
  const target = {
    id: "arc",
    handle: "arc",
    center: { x: 10, y: 0 },
    radius: 2,
    start: Math.PI / 2,
    sweep: Math.PI,
  };
  const contacts = tangentArcEnds({ x: 4, y: 0 }, { x: 6, y: -2 }, target);
  expect(contacts.some(({ point }) => Math.hypot(point.x - 8, point.y) < 1e-8)).toBe(true);
  for (const result of contacts) {
    expect(arcContains(target, result.point)).toBe(true);
    expect(
      Math.hypot(result.point.x - target.center.x, result.point.y - target.center.y),
    ).toBeCloseTo(2, 8);
    expect(
      Math.hypot(result.point.x - result.center.x, result.point.y - result.center.y),
    ).toBeCloseTo(result.radius, 8);
    const radii = [result.point.x - result.center.x, result.point.y - result.center.y];
    expect(
      radii[0]! * (result.point.y - target.center.y) -
        radii[1]! * (result.point.x - target.center.x),
    ).toBeCloseTo(0, 8);
  }
  expect(tangentArcEnds({ x: 12, y: 0 }, { x: 10, y: 2 }, target)).toEqual([]);
});
test("external point tangents are truly perpendicular to the radius and interior points have none", () => {
  const p = { x: 13, y: 0 };
  const hits = tangentPoints(circle, p);
  expect(hits).toHaveLength(2);
  for (const q of hits) {
    expect(Math.hypot(q.x, q.y)).toBeCloseTo(5, 9);
    expect(q.x * (p.x - q.x) + q.y * (p.y - q.y)).toBeCloseTo(0, 9);
  }
  expect(tangentPoints(circle, { x: 1, y: 0 })).toEqual([]);
  expect(tangentPoints(circle, { x: 5, y: 0 })).toHaveLength(1);
});
test("finite arcs exclude tangents outside their sweep including clockwise bulges", () => {
  const arc = { ...circle, start: 0, sweep: Math.PI / 2 };
  expect(tangentPoints(arc, { x: 13, y: 0 })).toHaveLength(1);
  expect(arcContains(arc, { x: 0, y: -5 })).toBe(false);
  const lower = bulgeArc("B", "B:0", { x: -5, y: 0 }, { x: 5, y: 0 }, 1)!;
  expect(lower.center.x).toBeCloseTo(0, 9);
  expect(lower.center.y).toBeCloseTo(0, 9);
  expect(lower.radius).toBeCloseTo(5, 9);
  expect(arcContains(lower, { x: 0, y: -5 })).toBe(true);
  expect(arcContains(lower, { x: 0, y: 5 })).toBe(false);
});
test("public tangents cover both external and internal solutions without impossible nested solutions", () => {
  const other = { ...circle, id: "D", handle: "D", center: { x: 20, y: 0 } };
  const lines = commonTangents(circle, other);
  expect(lines).toHaveLength(4);
  for (const { from, to } of lines) {
    expect(Math.hypot(from.x, from.y)).toBeCloseTo(5, 9);
    expect(Math.hypot(to.x - 20, to.y)).toBeCloseTo(5, 9);
    const dx = to.x - from.x,
      dy = to.y - from.y;
    expect(from.x * dx + from.y * dy).toBeCloseTo(0, 8);
    expect((to.x - 20) * dx + to.y * dy).toBeCloseTo(0, 8);
  }
  expect(commonTangents(circle, { ...other, center: { x: 1, y: 0 }, radius: 1 })).toEqual([]);
});
test("perpendicular feet stay on finite edges unless extension is explicit", () => {
  const edge = { id: "L", handle: "L", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  expect(perpendicularFoot(edge, { x: 3, y: 8 })).toEqual({ x: 3, y: 0 });
  expect(perpendicularFoot(edge, { x: 13, y: 8 })).toBeNull();
  expect(perpendicularFoot(edge, { x: 13, y: 8 }, true)).toEqual({ x: 13, y: 0 });
});

test("native closed bulge polylines preserve real arcs rather than tessellated chords", () => {
  const scene: CadScene = {
    revision: 1,
    entityCount: 3,
    selection: [],
    bounds: null,
    svgFrame: { origin: [0, 0], width: 100, height: 100 },
    entities: [
      {
        handle: "P",
        type: "Polyline",
        layer: "0",
        geometry: {
          type: "lwPolyline",
          closed: true,
          vertices: [
            { p: { x: -5, y: 0 }, bulge: 1 },
            { p: { x: 5, y: 0 }, bulge: 0 },
            { p: { x: 0, y: 10 }, bulge: 0 },
          ],
        },
      },
      {
        handle: "hidden",
        type: "Circle",
        visible: false,
        layer: "0",
        geometry: { type: "circle", center: { x: 0, y: 0 }, radius: 5 },
      },
      {
        handle: "tilted",
        type: "Circle",
        layer: "0",
        common: { extrusion: { x: 1, y: 0, z: 1 } },
        geometry: { type: "circle", center: { x: 0, y: 0 }, radius: 5 },
      },
    ],
    primitives: [
      {
        handle: "P",
        kind: "polyline",
        points: [
          [-5, 0],
          [0, -5],
          [5, 0],
        ],
        color: [0, 0, 0],
        aci7: true,
        lineweight: 0,
      },
    ],
  };
  const geometry = draftingGeometry(scene);
  expect(geometry.edges).toHaveLength(2);
  expect(geometry.curves).toHaveLength(1);
  expect(geometry.curves[0]!.radius).toBe(5);
  expect(geometry.edges.some((e) => e.a.y === 0 && e.b.y === 0)).toBe(false);
  expect(draftingGeometry(scene)).toBe(geometry);
});
