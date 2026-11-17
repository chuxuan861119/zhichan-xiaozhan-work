import {
  bounds,
  clippedAnnotations,
  geometricBounds,
  outputSize,
  pointInside,
} from "./geometry.js";

const rectangle = [
  { x: 100, y: 200 },
  { x: 500, y: 200 },
  { x: 500, y: 400 },
  { x: 100, y: 400 },
];
test("export dimensions derive from physical width and DPI, independent of viewport", () => {
  expect(outputSize(rectangle, 127, 300)).toMatchObject({ width: 1500, height: 750, scale: 3.75 });
  expect(outputSize(rectangle, 127, 600)).toMatchObject({ width: 3000, height: 1500 });
  expect(() =>
    bounds([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
  ).toThrow();
});
test("lasso includes boundary and excludes bounding box corners outside polygon", () => {
  const triangle = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 100 },
  ];
  expect(pointInside({ x: 50, y: 50 }, triangle)).toBe(true);
  expect(pointInside({ x: 90, y: 90 }, triangle)).toBe(false);
  expect(pointInside({ x: 50, y: 0 }, triangle)).toBe(true);
});
test("warns about a leader crossing the selection edge", () => {
  expect(
    clippedAnnotations(
      [
        {
          id: "1",
          text: "12",
          x: 300,
          y: 300,
          fontSize: 20,
          lineWidth: 1,
          points: [{ x: 20, y: 300 }],
        },
      ],
      rectangle,
    ),
  ).toEqual(["12"]);
});

test("sub-unit crops export at high zoom while degenerate ranges remain invalid", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0.2, y: 0.1 },
    { x: 0, y: 0.1 },
  ];
  expect(geometricBounds(points)).toEqual({ x: 0, y: 0, width: 0.2, height: 0.1 });
  expect(bounds(points)).toEqual({ x: 0, y: 0, width: 0.2, height: 0.1 });
  expect(outputSize(points, 127, 300).height).toBe(750);
});

test("invalid coordinates and unrepresentable output scales are rejected", () => {
  expect(() =>
    bounds([
      { x: 0, y: 0 },
      { x: NaN, y: 1 },
      { x: 1, y: 1 },
    ]),
  ).toThrow();
  expect(() =>
    outputSize(
      [
        { x: 0, y: 0 },
        { x: 1e-320, y: 0 },
        { x: 1e-320, y: 1e-320 },
      ],
      127,
      300,
    ),
  ).toThrow();
});
