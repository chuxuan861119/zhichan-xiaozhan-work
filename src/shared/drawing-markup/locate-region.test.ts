import { locateRegionView } from "./locate-region.js";

const view = { x: 100, y: 200, width: 400, height: 300 };
const viewport = { width: 800, height: 600 };
const rectangle = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

test("a completely visible region only needs its marker, without moving the view", () => {
  expect(locateRegionView(view, viewport, rectangle(110, 210, 80, 90))).toBe(view);
  expect(locateRegionView(view, viewport, rectangle(100, 200, 400, 300))).toBe(view);
});

test.each([
  [450, 300, 100, 100],
  [900, 900, 100, 100],
  [0, 0, 1000, 800],
])(
  "centers partially visible, offscreen and oversized regions without zooming",
  (x, y, width, height) => {
    const located = locateRegionView(view, viewport, rectangle(x, y, width, height));
    expect(located.width).toBe(view.width);
    expect(located.height).toBe(view.height);
    expect(located.x + located.width / 2).toBe(x + width / 2);
    expect(located.y + located.height / 2).toBe(y + height / 2);
  },
);

test("counts the extra visible area of a wide or tall SVG viewport", () => {
  expect(locateRegionView(view, { width: 1200, height: 600 }, rectangle(10, 220, 50, 50))).toBe(
    view,
  );
  expect(locateRegionView(view, { width: 800, height: 1000 }, rectangle(120, 120, 50, 50))).toBe(
    view,
  );
});

test.each([
  [viewport, rectangle(110, 210, 80, 90)],
  [viewport, rectangle(0, 0, 1000, 800)],
  [{ width: 1200, height: 500 }, rectangle(-300, 800, 40, 400)],
  [{ width: 400, height: 900 }, rectangle(900, -500, 1000, 20)],
])("CAD fitting always centers the full region with margins and the viewport aspect ratio", (screen, points) => {
  const fitted = locateRegionView(view, screen, points, true);
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  const width = Math.max(...points.map(p => p.x)) - left;
  const height = Math.max(...points.map(p => p.y)) - top;
  expect(fitted.x + fitted.width / 2).toBeCloseTo(left + width / 2);
  expect(fitted.y + fitted.height / 2).toBeCloseTo(top + height / 2);
  expect(fitted.width / fitted.height).toBeCloseTo(screen.width / screen.height);
  expect(width / fitted.width).toBeLessThanOrEqual(0.80000001);
  expect(height / fitted.height).toBeLessThanOrEqual(0.80000001);
  expect(Math.max(width / fitted.width, height / fitted.height)).toBeCloseTo(0.8);
});

test("CAD fitting is independent of previous pan or magnification and ignores hidden viewports", () => {
  const points = rectangle(400, 500, 100, 80);
  expect(locateRegionView({ ...view, x: -9000, width: 1, height: 1 }, viewport, points, true))
    .toEqual(locateRegionView(view, viewport, points, true));
  for (const screen of [{ width: 0, height: 500 }, { width: 500, height: 0 }, { width: NaN, height: 500 }])
    expect(locateRegionView(view, screen, points, true)).toBe(view);
});
