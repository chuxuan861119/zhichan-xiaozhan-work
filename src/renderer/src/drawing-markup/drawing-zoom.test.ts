import { expect, test } from "vitest";
import { cadPreviewRegion, minimumDrawingViewWidth } from "./drawing-zoom";

test("caps the displayed zoom at 100000 percent and preserves coordinate precision", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  expect((1000 * 1.08 * 100) / minimumDrawingViewWidth(1000, view)).toBe(100000);
  expect(minimumDrawingViewWidth(0.001, { ...view, x: 1e7 })).toBeGreaterThan(0.00000108);
});
test("retains ordinary full rendering and bounds high zoom to a reusable overscan region", () => {
  const project = { width: 1000, height: 800 };
  expect(cadPreviewRegion(project, { x: 0, y: 0, width: 1000, height: 800 }, 1)).toEqual({
    x: 0,
    y: 0,
    ...project,
  });
  const view = { x: 500, y: 400, width: 1.08, height: 0.864 };
  const tile = cadPreviewRegion(project, view, 1000);
  expect(tile.width).toBeLessThanOrEqual(view.width * 3);
  expect(tile.x).toBeLessThan(view.x);
  expect(tile.x + tile.width).toBeGreaterThan(view.x + view.width);
  expect(cadPreviewRegion(project, { ...view, x: 500.1 }, 1000)).toEqual(tile);
});

test("an editable CAD viewport has coverage beyond all stored drawing edges", () => {
  const project = { width: 1000, height: 800 };
  for (const view of [
    { x: -1400, y: -900, width: 700, height: 400 },
    { x: 1600, y: 1400, width: 700, height: 400 },
  ]) {
    const tile = cadPreviewRegion(project, view, 1, true);
    expect(tile.x).toBeLessThan(view.x);
    expect(tile.y).toBeLessThan(view.y);
    expect(tile.x + tile.width).toBeGreaterThan(view.x + view.width);
    expect(tile.y + tile.height).toBeGreaterThan(view.y + view.height);
    expect(tile.width).toBeLessThanOrEqual(view.width * 3);
  }
});

test("wide CAD views do not allocate a square preview far beyond the visible height", () => {
  const project = { width: 2000, height: 2000 };
  const view = { x: 503, y: -81, width: 2400, height: 1350 };
  const tile = cadPreviewRegion(project, view, 1, true);
  expect(tile.width).toBeGreaterThan(view.width);
  expect(tile.height).toBeGreaterThan(view.height);
  expect(tile.x).toBeLessThan(view.x);
  expect(tile.y).toBeLessThan(view.y);
  expect(tile.x + tile.width).toBeGreaterThan(view.x + view.width);
  expect(tile.y + tile.height).toBeGreaterThan(view.y + view.height);
  expect(tile.height).toBeLessThan(tile.width);
});
