import { expect, test } from "vitest";
import { findNewLabelOverlap } from "./label-overlap";

const box = (x: number, y: number, width: number, height = 10) => ({ x, y, width, height });
test("reports only newly introduced glyph overlaps, including negative coordinates", () => {
  const labels = [
    { text: "12", original: box(-20, 0, 10), output: box(-24, 0, 20) },
    { text: "13", original: box(-8, 0, 10), output: box(-12, 0, 20) },
  ];
  expect(findNewLabelOverlap(labels, 20)).toEqual(["12", "13"]);
  expect(
    findNewLabelOverlap(
      labels.map((label) => ({ ...label, original: label.output })),
      20,
    ),
  ).toBeNull();
  expect(
    findNewLabelOverlap([{ ...labels[0]! }, { ...labels[1]!, output: box(-4, 0, 20) }], 20),
  ).toBeNull();
});
test("checks long glyph bounds across cells and a full 5000-label non-overlapping drawing", () => {
  const labels = Array.from({ length: 5000 }, (_, index) => ({
    text: String(index),
    original: box(0, index * 50, 4),
    output: box(-200, index * 50, 400),
  }));
  expect(findNewLabelOverlap(labels, 20)).toBeNull();
  labels.push({ text: "overlap", original: box(180, 0, 4), output: box(180, 0, 40) });
  expect(findNewLabelOverlap(labels, 20)).toEqual(["0", "overlap"]);
});
