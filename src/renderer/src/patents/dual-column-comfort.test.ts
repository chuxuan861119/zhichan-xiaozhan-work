import { expect, test } from "vitest";
import { canFitComfortableColumns, resizedColumnPosition } from "./dual-column-comfort";

test("requires two 600px pages, two rulers and the expanded rail", () => {
  expect(canFitComfortableColumns(1706)).toBe(false);
  expect(canFitComfortableColumns(1707)).toBe(true);
});
test("keeps the active column reading anchor when height and scale change", () => {
  const next = resizedColumnPosition(900, 600, 1, 800, 1.2, 1);
  expect((next + 800 + 800 / 3) / 1.2).toBeCloseTo(900 + 600 + 600 / 3);
});
test("keeps the first pair of columns at the top when zoom or viewport size changes", () => {
  expect(resizedColumnPosition(0, 600, 1, 600, 1.2, 0)).toBe(0);
});
