import { expect, test } from "vitest";
import { compileDrawMethod, DRAW_METHODS } from "./cad-draw-methods";
const p = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 5, y: 5 },
];
test("rectangle methods retain native CAD commands and center / perpendicular geometry", () => {
  expect(DRAW_METHODS.rectang?.map(m => m.id)).toEqual([
    "rectang", "rectang.center", "rectang.3p", "rectang.center-rotated",
  ]);
  expect(compileDrawMethod("rectang", [{x:2,y:3},{x:12,y:8}], 0)).toEqual({
    command:"rectang", params:{p1:[2,3],p2:[12,8]},
  });
  expect(compileDrawMethod("rectang.center", [{x:2,y:3},{x:12,y:8}], 0)?.params)
    .toEqual({p1:[-8,-2],p2:[12,8]});
  const tilted = compileDrawMethod("rectang.3p", [{x:0,y:0},{x:6,y:8},{x:1,y:8}], 0);
  expect(tilted?.params.p1).toEqual([0,0]);
  expect(tilted?.params.p2).toEqual([expect.closeTo(2.8,9),expect.closeTo(10.4,9)]);
  expect(tilted?.params.rotation).toBeCloseTo(53.130102354);
  expect(compileDrawMethod("rectang.center-rotated", [{x:0,y:0},{x:10,y:0},{x:0,y:3}], 0)?.params)
    .toEqual({p1:[-10,-3],p2:[10,3],rotation:0});
  expect(compileDrawMethod("rectang.3p", p.slice(0,2), 0)).toBeNull();
});
test("rectangle corners and square constraints validate instead of silently losing corner treatment", () => {
  const points=[{x:0,y:0},{x:10,y:6}];
  expect(compileDrawMethod("rectang", points, 0, [], {rectangle:{corner:"round",size:2}})?.params)
    .toEqual({p1:[0,0],p2:[10,6],fillet:2});
  expect(compileDrawMethod("rectang", points, 0, [], {rectangle:{corner:"chamfer",size:2}})?.params.chamfer)
    .toEqual([2,2]);
  expect(compileDrawMethod("rectang", points, 0, [], {rectangle:{square:true}})?.params.p2).toEqual([10,10]);
  expect(() => compileDrawMethod("rectang", points, 0, [], {rectangle:{corner:"round",size:4}})).toThrow(/一半/);
  expect(() => compileDrawMethod("rectang", points, 0, [], {rectangle:{corner:"chamfer",size:NaN}})).toThrow();
  expect(() => compileDrawMethod("rectang", [{x:0,y:0},{x:10,y:0}], 0)).toThrow();
  expect(() => compileDrawMethod("rectang.3p", [{x:0,y:0},{x:10,y:0},{x:2,y:0}], 0)).toThrow();
  expect(compileDrawMethod("rectang.center", points, 0, [], {rectangle:{square:true}})?.params)
    .toEqual({p1:[-10,-10],p2:[10,10]});
  expect(compileDrawMethod("rectang.3p", [...points,{x:0,y:-5}], 0, [], {rectangle:{square:true}})?.params.p2)
    .toEqual([expect.closeTo(16,9),expect.closeTo(-4,9)]);
  expect(compileDrawMethod("rectang.center-rotated", [{x:0,y:0},{x:10,y:0},{x:0,y:-5}], 0, [], {rectangle:{square:true}})?.params)
    .toEqual({p1:[-10,10],p2:[10,-10],rotation:0});
});
test("draw methods compile native commands without committing incomplete input", () => {
  expect(compileDrawMethod("circle.2p", p.slice(0, 1), 10)).toBeNull();
  expect(compileDrawMethod("circle.cd", p.slice(0, 2), 10)).toEqual({
    command: "circle",
    params: { center: [0, 0], diameter: 10 },
  });
  expect(compileDrawMethod("circle.3p", p, 10)?.params).toEqual({
    p1: [0, 0],
    p2: [10, 0],
    p3: [5, 5],
  });
  expect(compileDrawMethod("polygon.edge", p.slice(0, 2), 6)?.params).toEqual({
    sides: 6,
    edge: [
      [0, 0],
      [10, 0],
    ],
  });
  expect(compileDrawMethod("polygon.out", p.slice(0, 2), 6)?.params).toMatchObject({
    sides: 6,
    inscribed: false,
    radius: 10,
  });
});
test("invalid inputs never create native commands", () => {
  expect(() => compileDrawMethod("circle.3p", [p[0]!, p[1]!, { x: 20, y: 0 }], 1)).toThrow();
  expect(() => compileDrawMethod("arc.ser", p.slice(0, 2), 2)).toThrow();
  expect(() => compileDrawMethod("polygon.edge", p.slice(0, 2), 2)).toThrow();
  expect(() => compileDrawMethod("circle.2p", [p[0]!, p[0]!], 1)).toThrow();
});
test("all advertised methods have unique identifiers and usable instructions", () => {
  const methods = Object.values(DRAW_METHODS).flat();
  expect(new Set(methods.map((m) => m.id)).size).toBe(methods.length);
  for (const m of methods) expect(m.steps.length).toBeGreaterThan(0);
});
test("ellipse arc angles follow the normalized major axis rather than elliptic parameters", () => {
  const result = compileDrawMethod(
    "ellipse.arc",
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 8, y: 20 },
      { x: 15, y: 0 },
      { x: 5, y: 10 },
    ],
    1,
  );
  expect(result?.params).toMatchObject({ distance: 20, start: -90, end: 0 });
  const diagonal = compileDrawMethod(
    "ellipse.arc",
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 10 },
      { x: 10, y: 5 },
    ],
    1,
  );
  expect(diagonal?.params.start).toBeCloseTo(45);
});
