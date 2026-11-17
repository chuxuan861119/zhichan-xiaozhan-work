import {
  clampDualDocumentSplitPercent,
  DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX,
  DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT,
  dualDocumentSplitIsCentered,
  dualDocumentSplitPercentAfterDrag,
  dualDocumentSplitRange,
  dualDocumentSplitTemplate,
} from "./dual-document-split";

test("defaults to an equal split and keeps the original grid template string", () => {
  expect(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT).toBe(50);
  expect(dualDocumentSplitTemplate(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT)).toBe(
    "minmax(0, 1fr) auto minmax(0, 1fr)",
  );
});

test("turns a split percent into left and right fr columns", () => {
  expect(dualDocumentSplitTemplate(65)).toBe("minmax(0, 1.3fr) auto minmax(0, 0.7fr)");
  expect(dualDocumentSplitTemplate(25)).toBe("minmax(0, 0.5fr) auto minmax(0, 1.5fr)");
  expect(dualDocumentSplitTemplate(50.31)).toBe("minmax(0, 1.0062fr) auto minmax(0, 0.9938fr)");
});

test("converts a horizontal drag into a simultaneous two-sided change", () => {
  // 2000px 可分栏宽度里向右拖 200px：左栏 +10%，右栏相应 -10%。
  expect(dualDocumentSplitPercentAfterDrag(50, 200, 2015)).toBe(60);
  expect(dualDocumentSplitPercentAfterDrag(50, -300, 2015)).toBe(35);
});

test("moves immediately when a drag starts from the equal split", () => {
  expect(dualDocumentSplitPercentAfterDrag(50, 4, 2015)).toBe(50.2);
  expect(dualDocumentSplitPercentAfterDrag(50, -4, 2015)).toBe(49.8);
});

test("keeps both panes at or above the minimum width while dragging", () => {
  // 2000px 可分栏宽度：每侧至少 528px，保留 52% 页面和收起的控件。
  expect(dualDocumentSplitRange(2015)).toEqual({ min: 26.4, max: 73.6 });
  expect(dualDocumentSplitPercentAfterDrag(50, 900, 2015)).toBe(73.6);
  expect(dualDocumentSplitPercentAfterDrag(50, -900, 2015)).toBe(26.4);
});

test("keeps a hard 20% floor when the workspace is very wide and degrades to equal when tiny", () => {
  expect(dualDocumentSplitRange(3015)).toEqual({ min: 20, max: 80 });
  expect(dualDocumentSplitRange(400)).toEqual({ min: 50, max: 50 });
});

test("rounds dragged percentages to two decimals so values stay comparable", () => {
  expect(dualDocumentSplitPercentAfterDrag(60, 2.469, 2015)).toBe(60.12);
  // 位移小到可以忽略时回到等宽写法，不留下 1fr/1fr 之外的噪声。
  expect(dualDocumentSplitPercentAfterDrag(50, 0.02, 2015)).toBe(50);
});

test("falls back to the stored percent when the container width is unusable", () => {
  expect(dualDocumentSplitPercentAfterDrag(50, 120, 0)).toBe(50);
  expect(dualDocumentSplitPercentAfterDrag(62, 120, Number.NaN)).toBe(62);
  expect(clampDualDocumentSplitPercent(Number.NaN, 2015)).toBe(50);
  expect(dualDocumentSplitRange(0)).toEqual({ min: 20, max: 80 });
});

test("snaps within twenty pixels of the center without quantizing other widths", () => {
  expect(DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX).toBe(20);
  // 1000px 宽：进入半径（19px）就贴回严格的 50%，拖回来不必像素级对齐。
  expect(dualDocumentSplitPercentAfterDrag(60, -181, 2015)).toBe(50);
  expect(dualDocumentSplitPercentAfterDrag(40, 181, 2015)).toBe(50);
  // 刚好越过半径（21px）就保持精确占比，不把附近的宽度一起吞掉。
  expect(dualDocumentSplitPercentAfterDrag(60, -179, 2015)).toBe(51.05);
  // Starting at the center remains direct manipulation instead of creating a 20px dead zone.
  expect(dualDocumentSplitPercentAfterDrag(50, 19, 2015)).toBe(50.95);
  // Once the same gesture has left the snap radius, returning to 19px can snap again.
  expect(dualDocumentSplitPercentAfterDrag(50, 19, 2015, undefined, true)).toBe(50);
  expect(dualDocumentSplitPercentAfterDrag(60, 80, 2015)).toBe(64);
  expect(dualDocumentSplitTemplate(50.31)).toBe("minmax(0, 1.0062fr) auto minmax(0, 0.9938fr)");
});

test("reports whether the split sits exactly at the equal-width position", () => {
  expect(dualDocumentSplitIsCentered(DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT)).toBe(true);
  expect(dualDocumentSplitIsCentered(dualDocumentSplitPercentAfterDrag(60, -181, 2015))).toBe(true);
  expect(dualDocumentSplitIsCentered(dualDocumentSplitPercentAfterDrag(60, -179, 2015))).toBe(
    false,
  );
  expect(dualDocumentSplitIsCentered(52.1)).toBe(false);
});

test("bounds both panes using their actual page widths", () => {
  const range = dualDocumentSplitRange(2015, [700, 600]);
  expect(range).toEqual({ min: 35, max: 70 });
  expect(clampDualDocumentSplitPercent(10, 2015, [700, 600])).toBe(35);
  expect(clampDualDocumentSplitPercent(90, 2015, [700, 600])).toBe(70);
  for (const width of [1280, 1366, 1920, 2560]) {
    const { min, max } = dualDocumentSplitRange(width);
    expect(((width - 15) * min) / 100).toBeGreaterThanOrEqual(528);
    expect((width - 15) * (1 - max / 100)).toBeGreaterThanOrEqual(528);
  }
});
