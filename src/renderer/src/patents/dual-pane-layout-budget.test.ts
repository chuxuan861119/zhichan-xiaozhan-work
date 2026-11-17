import {
  DUAL_PANE_COLLAPSED_RAIL,
  DUAL_PANE_COMPACT_RULER,
  DUAL_PANE_RULER,
  fitDualPanePage,
  minimumDualPaneWidth,
} from "./dual-pane-layout-budget";
import { nextFunctionRailSpace } from "./function-rail/function-rail-state";

test("automatic fit remains continuous across the docked-controls threshold", () => {
  for (let width = 900; width < 1400; width += 1) {
    const before = fitDualPanePage(width, 794, 39, undefined, 600);
    const after = fitDualPanePage(width + 1, 794, 39, undefined, 600);
    const delta = (after.fitScale - before.fitScale) * 794;
    expect(delta).toBeGreaterThanOrEqual(-0.001);
    expect(delta).toBeLessThanOrEqual(1.001);
  }
});

test("automatic docked fitting leaves enough recovery space after widening a compact pane", () => {
  const fit = fitDualPanePage(1272, 794, 39, undefined, 600);
  expect(fit.initialRailSpace).toBe("fits");
  // clientWidth is integer-rounded while the rendered pane can end on a half pixel.
  expect(
    nextFunctionRailSpace("constrained", 1272 - 39 - 0.5, fit.fitScale * 794, DUAL_PANE_RULER),
  ).toBe("fits");
  expect(fit.fitScale).toBeGreaterThanOrEqual(1);
});

test.each([600, 794, 1123])(
  "the readable minimum fits a %i pixel page with collapsed controls",
  (width) => {
    const fit = fitDualPanePage(minimumDualPaneWidth(width), width);
    expect(fit.initialRailSpace).toBe("constrained");
    expect(fit.fitZoomPercent).toBeGreaterThanOrEqual(52);
    expect(fit.fitScale * width).toBeLessThanOrEqual(fit.pageAvailableWidth);
  },
);
test("splitter minimum reserves the same compact controls as the fitted page", () => {
  expect(minimumDualPaneWidth(794, 39)).toBe(
    Math.ceil(794 * 0.52 + DUAL_PANE_COMPACT_RULER + DUAL_PANE_COLLAPSED_RAIL + 39),
  );
});
test("switches to a collapsed rail before crossing the readability floor", () => {
  const wide = fitDualPanePage(1272, 794);
  const narrow = fitDualPanePage(528, 794);
  expect(wide.initialRailSpace).toBe("fits");
  expect(narrow.initialRailSpace).toBe("constrained");
  expect(narrow.fitZoomPercent).toBe(52);
});
test("measured and native-width paths use the same padding and scrollbar budget", () => {
  expect(fitDualPanePage(960)).toEqual(fitDualPanePage(921, undefined, 0));
});

test("laptop panes reserve compact controls instead of shrinking the page to dock both panels", () => {
  const fit = fitDualPanePage(865, 794);
  expect(fit.initialRailSpace).toBe("constrained");
  expect(fit.pageAvailableWidth).toBe(750);
  expect(fit.fitZoomPercent).toBe(94);
});
test("large panes keep the full ruler and docked tools when a natural-size page fits", () => {
  expect(fitDualPanePage(1272, 794)).toMatchObject({
    initialRailSpace: "fits",
    fitZoomPercent: 106,
  });
});

test("physical width keeps a high resolution laptop compact and uses 50cm as the boundary", () => {
  expect(fitDualPanePage(1272, 794, 39, undefined, 345).initialRailSpace).toBe("constrained");
  expect(fitDualPanePage(1272, 794, 39, undefined, 499).initialRailSpace).toBe("constrained");
  expect(fitDualPanePage(1272, 794, 39, undefined, 500).initialRailSpace).toBe("fits");
  expect(fitDualPanePage(1272, 794, 39, undefined, null).initialRailSpace).toBe("constrained");
  expect(fitDualPanePage(865, 794, 39, undefined, 600).initialRailSpace).toBe("constrained");
});
