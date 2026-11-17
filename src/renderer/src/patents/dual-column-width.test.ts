import { dualColumnWidth } from "./dual-column-width";

test.each([700, 1000, 1500, 1800, 1950, 2200, 3000])(
  "initial columns fill %i pixels with controls matching available space",
  (width) => {
    const result = dualColumnWidth(width, 820, 100, true);
    const wide = width >= 1707;
    expect(result.railFits).toBe(wide);
    expect(result.railWidth).toBe(wide ? 292 : 48);
    expect(result.rulerWidth).toBe(wide ? 76 : 20);
    expect(result.groupWidth).toBeLessThanOrEqual(width);
    expect(width - result.groupWidth).toBeLessThanOrEqual(wide ? 14 : 2);
    expect(result.zoom * 820 * 2 + (result.rulerWidth + 8) * 2 + 34 + result.railWidth).toBeCloseTo(
      result.groupWidth,
    );
  },
);

test("zoom grows only pages and collapses controls when space becomes limited", () => {
  const base = dualColumnWidth(2200, 820, 100, true);
  const larger = dualColumnWidth(2200, 820, 110, true);
  expect(larger.zoom).toBeCloseTo(base.zoom * 1.1);
  expect(larger.rulerWidth).toBe(76);
  expect(larger.railFits).toBe(false);
  const largest = dualColumnWidth(2200, 820, 130, false);
  expect(largest.rulerWidth).toBe(20);
  expect(largest.groupWidth).toBeLessThanOrEqual(2200);
});

test.each([700, 1000, 1600, 2200, 3000, 5000])(
  "maximum zoom fits both pages and collapsed controls within %i pixels",
  (width) => {
    const result = dualColumnWidth(width, 820, 200, true);
    expect(result.groupWidth).toBeLessThanOrEqual(width);
    expect(result.maxZoomPercent).toBeLessThanOrEqual(150);
    expect(result.rulerWidth).toBeGreaterThanOrEqual(20);
    expect(result.railWidth).toBeGreaterThanOrEqual(48);
  },
);

test("manually collapsed rail does not leave an expanded-width empty slot", () => {
  const expanded = dualColumnWidth(3000, 820, 100, true);
  const collapsed = dualColumnWidth(3000, 820, 100, false);
  expect(collapsed.zoom).toBe(expanded.zoom);
  expect(expanded.groupWidth - collapsed.groupWidth).toBe(292 - 48);
});

test("resizing across the comfortable-width boundary preserves the established page scale", () => {
  const initial = dualColumnWidth(1706, 794, 100, true);
  const resized = dualColumnWidth(1707, 794, 100, true, { baseZoom: initial.zoom });
  expect(resized.zoom).toBeCloseTo(initial.zoom);
  const narrower = dualColumnWidth(1400, 794, 100, true, { baseZoom: initial.zoom });
  expect(narrower.groupWidth).toBeLessThanOrEqual(1400);
});

test.each([1710, 1800, 2200, 3000])(
  "columns restore their rail at the original %i-pixel width",
  (width) => {
    const original = dualColumnWidth(width, 794, 100, true);
    expect(original.railFits).toBe(true);
    const narrow = dualColumnWidth(width - 100, 794, 100, false, {
      baseZoom: original.baseZoom,
      railSpace: "fits",
    });
    expect(narrow.railFits).toBe(false);
    const restored = dualColumnWidth(width, 794, 100, false, {
      baseZoom: original.baseZoom,
      railSpace: "constrained",
    });
    expect(restored.railFits).toBe(true);
    expect(restored.zoom).toBeCloseTo(original.zoom);
  },
);

test.each([985, 1400, 1671])(
  "laptop width %i uses compact controls to keep both pages readable",
  (width) => {
    const result = dualColumnWidth(width, 794, 100, true);
    expect(result.rulerWidth).toBe(20);
    expect(result.railWidth).toBe(48);
    expect(result.railFits).toBe(false);
    expect(result.groupWidth).toBeLessThanOrEqual(width);
    expect(result.zoom * 794).toBeGreaterThanOrEqual((width - 139) / 2 - 1);
  },
);
