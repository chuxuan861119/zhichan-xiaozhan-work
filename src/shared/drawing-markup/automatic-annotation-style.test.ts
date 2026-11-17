import { expect, test } from "vitest";
import { automaticAnnotationStyle } from "./automatic-annotation-style.js";

test("scales labels and leaders together with the visible drawing", () => {
  const normal = automaticAnnotationStyle({ width: 120, height: 120 })!;
  const large = automaticAnnotationStyle({ width: 1200, height: 1200 })!;
  expect(normal.fontSize).toBeCloseTo(7);
  expect(normal.lineWidth).toBeCloseTo(0.25);
  expect(large.fontSize).toBeCloseTo(normal.fontSize * 10);
  expect(large.lineWidth).toBeCloseTo(normal.lineWidth * 10);
});
test("ignores aspect ratio and rejects invalid geometry", () => {
  expect(automaticAnnotationStyle({ width: 120, height: 1 })!.fontSize).toBeCloseTo(7);
  expect(automaticAnnotationStyle({ width: 120, height: 10000 })!.fontSize).toBeCloseTo(7);
  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(automaticAnnotationStyle({ width, height: 10 })).toBeNull();
  }
});

test("scales automatic lettering without thickening leaders", () => {
  expect(automaticAnnotationStyle({ width: 120, height: 120 }, 1.5)).toEqual({
    fontSize: 10.5,
    lineWidth: 0.25,
  });
});
