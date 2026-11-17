import { expect, it } from "vitest";
import { leaderPoints, placeLabel } from "./label-layout.js";

it("places text directly above the cursor in every leader direction", () => {
  for (const [x, y] of [
    [100, 0],
    [-100, 0],
    [0, 100],
    [0, -100],
    [100, 100],
    [-100, 100],
    [100, -100],
    [-100, -100],
  ]) {
    const start = { x: 0, y: 0 },
      pointer = { x: x!, y: y! };
    const a = placeLabel(start, pointer, "123", 24, 1);
    const end = a.points.at(-1)!;
    expect(a.x).toBe(pointer.x);
    expect(pointer.y - (a.y + 24 * 0.55)).toBeCloseTo(4);
    expect(Math.abs(end.x * a.y - end.y * a.x)).toBeLessThan(1e-7);
    expect(Math.hypot(a.x - end.x, a.y - end.y)).toBeGreaterThan(12);
  }
});
it("realigns legacy endpoints without moving the existing number or anchor", () => {
  const a = {
    text: "12",
    fontSize: 20,
    x: 100,
    y: 100,
    points: [
      { x: 0, y: 0 },
      { x: 92, y: 111 },
    ],
  };
  const points = leaderPoints(a);
  expect(points[0]).toEqual({ x: 0, y: 0 });
  expect(points[1]!.x).toBeCloseTo(points[1]!.y);
  expect(points[1]!.x).toBeLessThan(89);
  expect(a.points[1]).toEqual({ x: 92, y: 111 });
});

it("keeps the cursor gap constant on screen across font sizes and zoom levels", () => {
  for (const fontSize of [12, 24, 48]) {
    for (const unitsPerPixel of [0.25, 1, 4]) {
      const pointer = { x: 200, y: 150 };
      const a = placeLabel({ x: 0, y: 0 }, pointer, "123", fontSize, unitsPerPixel);
      expect(a.x).toBe(pointer.x);
      expect((pointer.y - a.y - fontSize * 0.55) / unitsPerPixel).toBeCloseTo(4);
    }
  }
});
