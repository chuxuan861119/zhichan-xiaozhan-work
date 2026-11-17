import { rulerPopoverPosition } from "./ruler-popover-position";

test.each([0, 950, 1900])("keeps a readable popover inside window at ruler x=%i", (left) => {
  const rect = rulerPopoverPosition({ left, right: left + 20, top: 100, bottom: 900 }, 1920, 1000);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.left + rect.width).toBeLessThanOrEqual(1912);
  expect(rect.top).toBeGreaterThanOrEqual(108);
  expect(rect.top + rect.height).toBeLessThanOrEqual(892);
  expect(rect.width).toBe(136);
});
test.each([0, 40, 950])("overlays the compact ruler and extends right at x=%i", (left) => {
  const rect = rulerPopoverPosition({ left, right: left + 20, top: 100, bottom: 900 }, 1920, 1000);
  expect(rect.left).toBe(left);
  expect(rect.left + rect.width).toBeGreaterThan(left + 20);
});
test("even short lists fill the visible document height", () => {
  const rect = rulerPopoverPosition({ left: 0, right: 20, top: 100, bottom: 900 }, 1200, 1000);
  expect(rect.top + rect.height / 2).toBe(500);
  expect(rect.top).toBe(108);
  expect(rect.height).toBe(784);
});
