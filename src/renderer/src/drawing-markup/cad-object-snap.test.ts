import { expect, test } from "vitest";
import { resolveCadSnap } from "./cad-object-snap";
import type { CadScene } from "./cadcraft-client";

function lines(...paths: [number, number][][]): CadScene {
  return {
    revision: 1,
    entityCount: paths.length,
    selection: [],
    bounds: null,
    svgFrame: { origin: [0, 0], width: 100, height: 100 },
    entities: paths.map((points, i) => ({
      handle: String(i),
      type: "Line",
      layer: "0",
      grips: [
        points[0]!,
        [(points[0]![0] + points[1]![0]) / 2, (points[0]![1] + points[1]![1]) / 2],
        points[1]!,
      ],
    })),
    primitives: paths.map((points, i) => ({
      handle: String(i),
      kind: "polyline",
      points,
      color: [0, 0, 0],
      aci7: true,
      lineweight: 0,
    })),
  };
}

test("gear parameter handles are not mistaken for real drawing snap nodes", () => {
  const scene = lines([
    [0, 0],
    [20, 0],
  ]);
  scene.entities = [
    {
      handle: "G",
      type: "Block Reference",
      layer: "0",
      gear: { kind: "external", teeth: 20, hole: true, size: 80 },
      grips: [
        [0, 0],
        [40, 0],
        [-50, 0],
        [0, 56],
      ],
    },
  ];
  scene.primitives = [];
  expect(resolveCadSnap({ x: -50, y: 0 }, scene, 0.5)).toBeNull();
  expect(resolveCadSnap({ x: 0, y: 56 }, scene, 0.5)).toBeNull();
  expect(resolveCadSnap({ x: 0, y: 0 }, scene, 0.5)?.point).toEqual({ x: 0, y: 0 });
});
test("reports endpoints, midpoints and arbitrary nearest positions distinctly", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = lines([
    [0, 0],
    [20, 0],
  ]);
  expect(resolveCadSnap({ x: 0.1, y: 0.1 }, scene, 0.5)).toEqual({
    point: { x: 0, y: 0 },
    type: "endpoint",
  });
  expect(resolveCadSnap({ x: 10.1, y: 0.1 }, scene, 0.5)).toEqual({
    point: { x: 10, y: 0 },
    type: "midpoint",
  });
  expect(resolveCadSnap({ x: 7, y: 0.1 }, scene, 0.5)).toEqual({
    point: { x: 7, y: 0 },
    type: "nearest",
  });
  expect(resolveCadSnap({ x: 7, y: 2 }, scene, 0.5)).toBeNull();
});
test("distinguishes all native rectangle corners and edge midpoints", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = lines([
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
    [0, 0],
  ]);
  scene.entities[0] = {
    handle: "0",
    type: "Polyline",
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
  };
  scene.entities[0].grips?.forEach(([x, y], index) => {
    expect(resolveCadSnap({ x: x + 0.1, y: y + 0.1 }, scene, 0.5)?.type).toBe(
      index % 2 ? "midpoint" : "endpoint",
    );
  });
});
function circle(scene: CadScene, center: [number, number], radius: number): CadScene {
  const handle = String(scene.entities.length);
  return {
    ...scene,
    entities: [
      ...scene.entities,
      {
        handle,
        type: "Circle",
        layer: "0",
        radius,
        grips: [
          center,
          [center[0] + radius, center[1]],
          [center[0], center[1] + radius],
          [center[0] - radius, center[1]],
          [center[0], center[1] - radius],
        ],
      },
    ],
  };
}
test("classifies curve centers, quadrants, nodes and insertion points", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = circle(lines(), [30, 40], 10);
  expect(resolveCadSnap({ x: 30.1, y: 40.1 }, scene, 0.5)?.type).toBe("center");
  expect(resolveCadSnap({ x: 40.1, y: 40.1 }, scene, 0.5)?.type).toBe("quadrant");
  const nearest = resolveCadSnap({ x: 37.2, y: 47.2 }, scene, 0.5);
  expect(nearest?.type).toBe("nearest");
  expect(Math.hypot(nearest!.point.x - 30, nearest!.point.y - 40)).toBeCloseTo(10, 8);
  for (const [type, expected] of [
    ["Point", "node"],
    ["Text", "insertion"],
    ["Block Reference", "insertion"],
  ]) {
    expect(
      resolveCadSnap(
        { x: 1, y: 1 },
        { ...lines(), entities: [{ handle: "P", type: type!, layer: "0", grips: [[1, 1]] }] },
        1,
      )?.type,
    ).toBe(expected);
  }
});
test("reports real segment intersections without extending finite lines", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = lines(
    [
      [0, 0],
      [20, 0],
    ],
    [
      [7, -5],
      [7, 5],
    ],
  );
  expect(resolveCadSnap({ x: 7.1, y: 0.1 }, scene, 0.5)).toEqual({
    point: { x: 7, y: 0 },
    type: "intersection",
  });
  const joined = lines(
    [
      [0, 0],
      [20, 0],
    ],
    [
      [20, 0],
      [20, 10],
    ],
  );
  expect(resolveCadSnap({ x: 20.1, y: 0.1 }, joined, 0.5)?.type).toBe("endpoint");
  const outside = lines(
    [
      [0, 0],
      [5, 0],
    ],
    [
      [7, -5],
      [7, 5],
    ],
  );
  expect(resolveCadSnap({ x: 7.1, y: 0.1 }, outside, 0.5)?.type).not.toBe("intersection");
});
test("computes circle-line and circle-circle intersections analytically", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = circle(
    lines([
      [-20, 6],
      [20, 6],
    ]),
    [0, 0],
    10,
  );
  const hit = resolveCadSnap({ x: 8.1, y: 6.1 }, scene, 0.5);
  expect(hit?.type).toBe("intersection");
  expect(hit?.point.x).toBeCloseTo(8, 8);
  expect(hit?.point.y).toBeCloseTo(6, 8);
  const circles = circle(circle(lines(), [0, 0], 5), [6, 0], 5);
  expect(resolveCadSnap({ x: 3.1, y: 4.1 }, circles, 0.5)).toEqual({
    point: { x: 3, y: 4 },
    type: "intersection",
  });
});
test("never reports a shallow bulged polyline display chord as an intersection", () => {
  const makeScene = (bulge: number): CadScene => {
    const scene = lines(
      [
        [0, 0],
        [20, 0],
      ],
      [
        [7, -5],
        [7, 6],
      ],
    );
    Object.assign(scene.entities[0]!, {
      type: "Polyline",
      geometry: {
        type: "lwPolyline",
        vertices: [
          { p: { x: 0, y: 0 }, bulge },
          { p: { x: 20, y: 0 }, bulge: 0 },
        ],
      },
    });
    // The native renderer can reduce a shallow arc to just its two endpoints.
    expect(scene.primitives[0]!.points).toHaveLength(2);
    return scene;
  };
  expect(resolveCadSnap({ x: 7.0001, y: 0.0001 }, makeScene(0.00005), 0.01)?.type).not.toBe(
    "intersection",
  );
  expect(resolveCadSnap({ x: 7.0001, y: 0.0001 }, makeScene(0), 0.01)).toEqual({
    point: { x: 7, y: 0 },
    type: "intersection",
  });
});
test("never uses invisible geometry or treats curve tessellation vertices as endpoints", () => {
  expect(resolveCadSnap).toBeTypeOf("function");
  const scene = lines(
    [
      [0, 0],
      [20, 0],
    ],
    [
      [7, -5],
      [7, 5],
    ],
  );
  scene.entities[1]!.visible = false;
  expect(resolveCadSnap({ x: 7.1, y: 0.1 }, scene, 0.5)?.type).toBe("nearest");
  const arc: CadScene = {
    ...lines(),
    entities: [
      {
        handle: "A",
        type: "Arc",
        layer: "0",
        grips: [
          [10, 0],
          [0, 10],
          [-10, 0],
          [0, 0],
        ],
      },
    ],
    primitives: [
      {
        handle: "A",
        kind: "polyline",
        points: [
          [10, 0],
          [7, 7],
          [0, 10],
          [-7, 7],
          [-10, 0],
        ],
        color: [0, 0, 0],
        aci7: true,
        lineweight: 0,
      },
    ],
  };
  expect(resolveCadSnap({ x: 0.1, y: 0.1 }, arc, 0.5)?.type).toBe("center");
  expect(resolveCadSnap({ x: 7.1, y: 7.1 }, arc, 0.5)?.type).toBe("nearest");
  expect(resolveCadSnap({ x: 10.1, y: 0.1 }, arc, 0.5)?.type).toBe("endpoint");
});
