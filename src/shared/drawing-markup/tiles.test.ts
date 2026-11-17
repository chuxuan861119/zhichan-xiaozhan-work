import { DrawingTileIndexSchema, tilePreviewStrokes } from "./tiles.js";

test("reducing tile allocation preserves the displayed stroke and minimum width", () => {
  const full = tilePreviewStrokes(8, 8, 2, 2);
  const capped = tilePreviewStrokes(0.8, 8, 2, 2);
  expect(full.strokeScale).toBe(4);
  expect(capped.strokeScale).toBe(full.strokeScale);
  expect(capped.minimumPixels).toBeCloseTo(full.minimumPixels / 10);
  expect(tilePreviewStrokes(1e-5, 8, 2, 2).minimumPixels).toBe(0.01);
});

test("rejects duplicate tile IDs and a render rectangle that omits its core", () => {
  const tile = {
    id: "tile-0",
    core: { x: 0, y: 0, width: 100, height: 100 },
    render: { x: 0, y: 0, width: 100, height: 100 },
    byteLength: 20,
    sha256: "A".repeat(64),
  };
  const index = {
    version: 1,
    width: 100,
    height: 100,
    tier: "large",
    primitives: 2,
    tiles: [tile],
  };
  expect(DrawingTileIndexSchema.safeParse(index).success).toBe(true);
  expect(DrawingTileIndexSchema.safeParse({ ...index, tiles: [tile, tile] }).success).toBe(false);
  expect(
    DrawingTileIndexSchema.safeParse({
      ...index,
      tiles: [{ ...tile, render: { ...tile.render, width: 99 } }],
    }).success,
  ).toBe(false);
});
