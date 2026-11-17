import { expect, test } from "vitest";
import { rectangleSelection } from "./crossing-selection.js";
import { bounds, clippedAnnotations } from "./geometry.js";
import type { DrawingAnnotation } from "./model.js";

const mark: DrawingAnnotation = {
  id: "a",
  text: "12",
  x: 600,
  y: 100,
  fontSize: 20,
  lineWidth: 1,
  points: [
    { x: 100, y: 100 },
    { x: 580, y: 100 },
  ],
};
test("left-to-right keeps the exact rectangle even when it crosses a leader", () => {
  const r = rectangleSelection({ x: 300, y: 90 }, { x: 350, y: 110 }, [mark]);
  expect(r.crossing).toBe(false);
  expect(r.annotationIds).toEqual([]);
  expect(bounds(r.points)).toEqual({ x: 300, y: 90, width: 50, height: 20 });
});
test("right-to-left includes a whole label when only the middle of its leader is touched", () => {
  const r = rectangleSelection({ x: 350, y: 90 }, { x: 300, y: 110 }, [mark]);
  expect(r.crossing).toBe(true);
  expect(r.annotationIds).toEqual([mark.id]);
  const b = bounds(r.points);
  expect(b.x).toBeLessThan(100);
  expect(b.x + b.width).toBeGreaterThan(610);
  expect(clippedAnnotations([mark], r.points)).toEqual([]);
});
test("touching a digit edge, leader endpoint or stroke edge counts as crossing", () => {
  for (const [start, end] of [
    [
      { x: 617, y: 96 },
      { x: 608, y: 104 },
    ],
    [
      { x: 100, y: 90 },
      { x: 90, y: 100 },
    ],
    [
      { x: 350, y: 100.5 },
      { x: 300, y: 105 },
    ],
  ] as const) {
    expect(bounds(rectangleSelection(start, end, [mark]).points).width).toBeGreaterThan(500);
  }
});
test("a diagonal bounding box alone does not count and expanded margins do not cascade", () => {
  const diagonal = {
    ...mark,
    x: 600,
    y: 600,
    points: [
      { x: 100, y: 100 },
      { x: 580, y: 580 },
    ],
  };
  expect(
    bounds(rectangleSelection({ x: 400, y: 180 }, { x: 350, y: 220 }, [diagonal]).points),
  ).toEqual({ x: 350, y: 180, width: 50, height: 40 });
  const other = {
    ...mark,
    id: "b",
    x: 900,
    y: 100,
    points: [
      { x: 590, y: 100 },
      { x: 880, y: 100 },
    ],
  };
  const b = bounds(rectangleSelection({ x: 350, y: 90 }, { x: 300, y: 110 }, [mark, other]).points);
  expect(b.x + b.width).toBeLessThan(700);
});
test("all directly touched annotations are included, and direction can switch mid-gesture", () => {
  const second = {
    ...mark,
    id: "b",
    x: 700,
    y: 200,
    points: [
      { x: 50, y: 200 },
      { x: 680, y: 200 },
    ],
  };
  const b = bounds(
    rectangleSelection({ x: 350, y: 80 }, { x: 300, y: 220 }, [mark, second]).points,
  );
  expect(b.x).toBeLessThan(50);
  expect(b.x + b.width).toBeGreaterThan(710);
  expect(rectangleSelection({ x: 350, y: 80 }, { x: 400, y: 220 }, [mark, second]).crossing).toBe(
    false,
  );
});
