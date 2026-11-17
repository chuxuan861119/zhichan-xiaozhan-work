import { fitConstrainedWidths, resizeConstrainedWidths } from "./table-width-constraints";

test("inner divider balances adjacent columns and respects visible cell widths", () => {
  const constraints = [
    { left: 0, right: 1, minimum: 40 },
    { left: 1, right: 2, minimum: 40 },
  ];
  expect(resizeConstrainedWidths([160, 240], 0, 20, 400, constraints)).toEqual([180, 220]);
  expect(resizeConstrainedWidths([160, 240], 0, 1000, 400, constraints)).toEqual([360, 40]);
  expect(resizeConstrainedWidths([160, 240], 1, 1000, 400, constraints)).toEqual([160, 240]);
});
test("refined grid tracks do not each require the width of a visible cell", () => {
  const constraints = [
    { left: 0, right: 3, minimum: 40 },
    { left: 0, right: 1, minimum: 40 },
    { left: 1, right: 3, minimum: 40 },
  ];
  const fit = fitConstrainedWidths([40, 1, 39], 80, constraints);
  expect(fit).toEqual([40, 1, 39]);
  expect(fitConstrainedWidths([40, 1, 39], 70, constraints)).toBeNull();
});
