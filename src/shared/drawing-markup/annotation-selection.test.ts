import { expect, it } from "vitest";
import { selectAnnotationIds, translateAnnotation } from "./annotation-selection.js";
import type { DrawingAnnotation } from "./model.js";

const a: DrawingAnnotation = {
  id: "a",
  text: "12",
  x: 100,
  y: 100,
  fontSize: 12,
  lineWidth: 1,
  points: [
    { x: 0, y: 0 },
    { x: 90, y: 90 },
  ],
};
const square = (l: number, t: number, r: number, b: number) => [
  { x: l, y: t },
  { x: r, y: t },
  { x: r, y: b },
  { x: l, y: b },
];
it("selects complete labels with windows and touched lines or numbers with crossing polygons", () => {
  expect(selectAnnotationIds([a], square(40, 40, 60, 60), false)).toEqual([]);
  expect(selectAnnotationIds([a], square(40, 40, 60, 60), true)).toEqual(["a"]);
  expect(selectAnnotationIds([a], square(105, 98, 115, 104), true)).toEqual(["a"]);
  expect(selectAnnotationIds([a], square(-2, -2, 120, 120), false)).toEqual(["a"]);
  expect(selectAnnotationIds([a], square(0, 50, 10, 60), true)).toEqual([]);
  expect(
    selectAnnotationIds(
      [a],
      [
        { x: 40, y: 60 },
        { x: 60, y: 40 },
        { x: 65, y: 60 },
      ],
      true,
    ),
  ).toEqual(["a"]);
  expect(selectAnnotationIds([a], [], true)).toEqual([]);
});
it("moves the complete leader and number without modifying the original", () => {
  const moved = translateAnnotation(a, 20, -10);
  expect(moved).toMatchObject({
    x: 120,
    y: 90,
    points: [
      { x: 20, y: -10 },
      { x: 110, y: 80 },
    ],
  });
  expect(a.points[0]).toEqual({ x: 0, y: 0 });
});
