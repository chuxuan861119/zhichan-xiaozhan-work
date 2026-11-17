import { compileCadGesture, snapCadPoint } from "./cad-gesture";
import type { CadScene } from "./cadcraft-client";

test("ellipse accepts either axis first and normalizes its native major axis", () => {
  expect(
    compileCadGesture(
      "ellipse",
      [
        { x: 2, y: 3 },
        { x: 6, y: 3 },
        { x: 2, y: 13 },
      ],
      [],
      0,
    )?.params,
  ).toEqual({
    center: [2, 3],
    major: [0, 10],
    ratio: 0.4,
  });
  expect(
    compileCadGesture(
      "ellipse",
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: -8, y: 6 },
      ],
      [],
      0,
    )?.params,
  ).toEqual({
    center: [0, 0],
    major: [-8, 6],
    ratio: 0.5,
  });
});

test("builds native command parameters for three point drawing and dimensions", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 4 },
  ];
  expect(compileCadGesture("arc", points, [], 2)).toEqual({
    command: "arc",
    params: { p1: [0, 0], p2: [10, 0], p3: [5, 4] },
  });
  expect(compileCadGesture("ellipse", points, [], 2)?.params).toEqual({
    center: [0, 0],
    major: [10, 0],
    ratio: Math.hypot(5, 4) / 10,
  });
  expect(compileCadGesture("dimaligned", points, [], 2)?.params).toEqual({
    p1: [0, 0],
    p2: [10, 0],
    at: [5, 4],
  });
  expect(compileCadGesture("arc", points.slice(0, 2), [], 2)).toBeNull();
});
test("keeps selected handles explicit and rejects invalid geometry parameters", () => {
  expect(
    compileCadGesture(
      "mirror",
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      ["AB"],
      2,
    )?.params,
  ).toEqual({ handles: ["AB"], p1: [0, 0], p2: [0, 10] });
  expect(() =>
    compileCadGesture(
      "polygon",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ],
      [],
      2,
    ),
  ).toThrow();
});
test("snaps to endpoints and midpoints only inside the screen-derived aperture", () => {
  const scene = {
    primitives: [
      {
        kind: "polyline",
        points: [
          [0, 0],
          [10, 0],
        ],
      },
    ],
  } as CadScene;
  expect(snapCadPoint({ x: 4.9, y: 0.1 }, scene, 0.3)).toEqual({ x: 5, y: 0 });
  expect(snapCadPoint({ x: 4, y: 1 }, scene, 0.3)).toEqual({ x: 4, y: 1 });
});

test("captures every rectangle corner and edge midpoint before a first point exists", () => {
  const scene = {
    entities: [
      {
        handle: "A",
        type: "LWPolyline",
        layer: "0",
        grips: [
          [0, 0],
          [10, 0],
          [20, 0],
          [20, 5],
          [20, 10],
          [10, 10],
          [0, 10],
          [0, 5],
        ],
      },
    ],
    primitives: [
      {
        handle: "A",
        kind: "polyline",
        points: [
          [0, 0],
          [20, 0],
          [20, 10],
          [0, 10],
          [0, 0],
        ],
      },
    ],
  } as CadScene;
  for (const [x, y] of [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
    [10, 0],
    [20, 5],
    [10, 10],
    [0, 5],
  ]) {
    expect(snapCadPoint({ x: x! + 0.1, y: y! + 0.1 }, scene, 0.5)).toEqual({ x, y });
  }
});

test("captures a circle center and an exact nearest point on its circumference", () => {
  const scene = {
    entities: [
      {
        handle: "C",
        type: "Circle",
        layer: "0",
        radius: 10,
        grips: [
          [30, 40],
          [40, 40],
          [30, 50],
          [20, 40],
          [30, 30],
        ],
      },
    ],
    primitives: [
      {
        handle: "C",
        kind: "polyline",
        points: [
          [40, 40],
          [30, 50],
          [20, 40],
          [30, 30],
          [40, 40],
        ],
      },
    ],
  } as CadScene;
  expect(snapCadPoint({ x: 30.1, y: 40.1 }, scene, 0.5)).toEqual({ x: 30, y: 40 });
  const snapped = snapCadPoint({ x: 37.2, y: 47.2 }, scene, 0.5);
  expect(Math.hypot(snapped.x - 30, snapped.y - 40)).toBeCloseTo(10, 8);
});

test("captures arbitrary positions on a line but prefers a nearby defining feature", () => {
  const scene = {
    entities: [
      {
        handle: "L",
        type: "Line",
        layer: "0",
        grips: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      },
    ],
    primitives: [
      {
        handle: "L",
        kind: "polyline",
        points: [
          [0, 0],
          [20, 0],
        ],
      },
    ],
  } as CadScene;
  expect(snapCadPoint({ x: 7, y: 0.2 }, scene, 0.5)).toEqual({ x: 7, y: 0 });
  expect(snapCadPoint({ x: 10.1, y: 0.2 }, scene, 0.5)).toEqual({ x: 10, y: 0 });
  expect(snapCadPoint({ x: 25, y: 0.2 }, scene, 0.5)).toEqual({ x: 25, y: 0.2 });
  expect(
    snapCadPoint(
      { x: 7, y: 0.2 },
      { ...scene, entities: [{ ...scene.entities[0]!, visible: false }] },
      0.5,
    ),
  ).toEqual({ x: 7, y: 0.2 });
});

test("polygon follows cursor direction and rejects more than twenty sides", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
  ];
  expect(compileCadGesture("polygon", points, [], 20)?.params.angle).toBe(90);
  expect(() => compileCadGesture("polygon", points, [], 21)).toThrow();
});
