import { expect, test } from "vitest";
import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import { compileDrawMethod, DRAW_METHODS } from "./cad-draw-methods";
import { extensionSpringPaths } from "./cad-extension-spring-geometry";
import { springGripPreview } from "./cad-spring-geometry";

test.each([
  [82.7, 20, 2.3, 15],
  [110, 20, 2.3, 15],
  [80, 30, 2, 6],
  [72.2, 20, 2.3, 15],
  [155, 20, 5, 24],
  [44.6, 20, 2.3, 3],
  [53.52, 20, 2.3, 3],
  [144.4, 20, 2.3, 15],
])(
  "extension spring visible outlines do not cross at %s × %s, wire %s, turns %s",
  (length, width, wire, turns) => {
    const paths = extensionSpringPaths(length, width, wire, turns);
    const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
    let intersections = 0;
    for (let a = 0; a < paths.length; a++)
      for (let b = a + 1; b < paths.length; b++)
        for (let i = 1; i < paths[a]!.length; i++)
          for (let j = 1; j < paths[b]!.length; j++) {
            const p = paths[a]![i - 1]!,
              q = paths[b]![j - 1]!;
            const u = paths[a]![i]!.map((v, k) => v - p[k]!);
            const v = paths[b]![j]!.map((v, k) => v - q[k]!);
            const d = cross(u[0]!, u[1]!, v[0]!, v[1]!);
            if (Math.abs(d) < 1e-12) continue;
            const t = cross(q[0] - p[0], q[1] - p[1], v[0]!, v[1]!) / d;
            const s = cross(q[0] - p[0], q[1] - p[1], u[0]!, u[1]!) / d;
            if (t > 1e-7 && t < 1 - 1e-7 && s > 1e-7 && s < 1 - 1e-7) intersections++;
          }
    expect(intersections).toBe(0);
    for (let a = 0; a < paths.length; a++)
      for (const p of [paths[a]![0]!, paths[a]!.at(-1)!]) {
        let gap = Infinity;
        for (let b = 0; b < paths.length; b++) {
          if (a === b) continue;
          for (let j = 1; j < paths[b]!.length; j++) {
            const q = paths[b]![j - 1]!,
              end = paths[b]![j]!;
            const dx = end[0] - q[0],
              dy = end[1] - q[1];
            const t = Math.max(
              0,
              Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / (dx * dx + dy * dy)),
            );
            gap = Math.min(gap, Math.hypot(p[0] - q[0] - t * dx, p[1] - q[1] - t * dy));
          }
        }
        expect(gap, `unjoined outline ${a}`).toBeLessThan(width * 1e-6);
      }
  },
);

test("extension hook seams stay closed at different widths and wire sizes", () => {
  for (const turns of [3, 6, 15, 24])
    for (const [width, wire] of [
      [20, 2.3],
      [30, 2],
      [20, 5],
    ] as const) {
      const length = 2 * width + (turns - 1) * wire + 10;
      const paths = extensionSpringPaths(length, width, wire, turns);
      expect(paths).toHaveLength(2 * turns + 12);
      const vertices = paths.flat();
      expect(vertices.every((p) => p.every(Number.isFinite))).toBe(true);
      expect(Math.min(...vertices.map((p) => p[0]))).toBeGreaterThan(-0.05);
      expect(Math.max(...vertices.map((p) => p[0]))).toBeLessThan(length + 0.05);
      expect(paths[2]?.[0]).toEqual(paths[0]?.at(-1));
      expect(paths[3]?.at(-1)).toEqual(paths[1]?.[0]);
      expect(paths[6 + 2 * turns]?.at(-1)).toEqual(paths[8 + 2 * turns]?.[0]);
    }
});

test("extension spring has its own placement method and keeps hooks when stretched", () => {
  expect(DRAW_METHODS.spring?.map((m) => m.label)).toEqual(["压缩弹簧", "拉伸弹簧"]);
  const command = compileDrawMethod(
    "spring.extension",
    [
      { x: 0, y: 0 },
      { x: 82.7, y: 0 },
      { x: 40, y: 10 },
    ],
    15,
    [],
    { springWire: 2.3 },
  );
  expect(command?.params).toMatchObject({ kind: "extension", turns: 15, wire: 2.3, width: 20 });
  const spring = {
    kind: "extension" as const,
    at: [0, 0] as [number, number],
    end: [82.7, 0] as [number, number],
    length: 82.7,
    width: 20,
    wire: 2.3,
    turns: 15,
    rotation: 0,
  };
  const original = springGripPreview(spring, 1, { x: 82.7, y: 0 });
  const stretched = springGripPreview(spring, 1, { x: 110, y: 0 });
  expect(original).toHaveLength(2 * 15 + 12);
  expect(stretched[0]).toEqual(original[0]); // First hook stays circular, not axially stretched.
  expect(Math.min(...original.flat().map((p) => p.x))).toBeCloseTo(0, 1);
  expect(Math.max(...original.flat().map((p) => p.x))).toBeCloseTo(82.7, 1);
  expect(Math.max(...stretched.flat().map((p) => p.x))).toBeCloseTo(110, 1);
  expect(() =>
    compileDrawMethod(
      "spring.extension",
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 20, y: 10 },
      ],
      15,
      [],
      { springWire: 2.3 },
    ),
  ).toThrow();
});

test("spring is placed by axis then overall width, with coil count and wire diameter", () => {
  expect(DRAW_METHODS.spring?.[0]?.steps).toHaveLength(3);
  expect(
    compileDrawMethod(
      "spring",
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
      ],
      6,
    ),
  ).toBeNull();
  expect(
    compileDrawMethod(
      "spring",
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 40, y: 15 },
      ],
      6,
      [],
      { springWire: 2 },
    ),
  ).toEqual({
    command: "bridge.spring",
    params: { at: [0, 0], end: [80, 0], width: 30, turns: 6, wire: 2 },
  });
});

test("spring grip preview redraws geometry immediately for length, width and turns", () => {
  const spring = {
    at: [0, 0] as [number, number],
    end: [80, 0] as [number, number],
    length: 80,
    width: 30,
    wire: 2,
    turns: 6,
    rotation: 0,
  };
  const length = springGripPreview(spring, 1, { x: 100, y: 0 });
  const width = springGripPreview(spring, 2, { x: 40, y: 20 });
  const turns = springGripPreview(spring, 3, { x: 75, y: 15 });
  expect(length).toHaveLength(2 * spring.turns + 5);
  expect(Math.max(...length.flat().map((p) => p.x))).toBeGreaterThan(99);
  expect(Math.max(...width.flat().map((p) => p.y))).toBeCloseTo(20, 1);
  expect(turns.length).toBeGreaterThan(length.length);
});

test("spring grip preview shows separate visible coil outlines", () => {
  const contours = springGripPreview(
    {
      at: [0, 0],
      end: [80, 0],
      length: 80,
      width: 30,
      wire: 2,
      turns: 6,
      rotation: 0,
    },
    1,
    { x: 80, y: 0 },
  );
  expect(contours).toHaveLength(2 * 6 + 5);
  const left = contours[3] ?? [];
  const right = contours[9] ?? [];
  expect(Math.max(...left.map((point) => point.y))).toBeGreaterThan(14);
  expect(Math.min(...right.map((point) => point.y))).toBeLessThan(-14);
});

test("spring grip preview keeps the sample's close unground end turns", () => {
  const paths = springGripPreview(
    {
      at: [0, 0],
      end: [88.25, 0],
      length: 88.25,
      width: 45,
      wire: 4.5,
      turns: 7,
      rotation: 0,
    },
    1,
    { x: 88.25, y: 0 },
  );
  expect(paths).toHaveLength(2 * 7 + 5);
  const span = (path: (typeof paths)[number]) =>
    Math.max(...path.map((point) => point.x)) - Math.min(...path.map((point) => point.x));
  expect(span(paths[0] ?? [])).toBeLessThan(span(paths[3] ?? []) * 0.75);
  const starts = Array.from({ length: 4 }, (_, i) => paths[2 + i]?.[0]?.x ?? 0);
  for (let i = 0; i < 3; i++)
    expect((starts[i + 1] ?? 0) - (starts[i] ?? 0)).toBeCloseTo((14.95 * 88.25) / 90.37951188, 1);
  expect(paths.at(-3)?.length).toBeGreaterThanOrEqual(13);
  expect(paths[3]?.[0]?.x).toBeCloseTo(36.82, 0);
  expect(paths[3]?.[0]?.y).toBeCloseTo(-11.76, 0);
  expect(paths[10]?.[0]?.x).toBeCloseTo(58.72, 0);
  expect(paths[10]?.[0]?.y).toBeCloseTo(11.8, 0);
});

test("spring grip preview retains the selected wire diameter at a different overall size", () => {
  const paths = springGripPreview(
    { at: [0, 0], end: [80, 0], length: 80, width: 30, wire: 2, turns: 6, rotation: 0 },
    1,
    { x: 80, y: 0 },
  );
  const endFace = paths[2 * 6 + 2] ?? [];
  const extent = (axis: "x" | "y") =>
    Math.max(...endFace.map((point) => point[axis])) -
    Math.min(...endFace.map((point) => point[axis]));
  expect(extent("x")).toBeCloseTo(2, 1);
  expect(extent("y")).toBeCloseTo(2, 1);
  expect(endFace[0]).toEqual(endFace.at(-1));
  expect(paths[5]?.at(-1)).toEqual(paths[16]?.[0]);
  expect(paths[6]?.[0]).toEqual(paths[15]?.at(-1));
  expect(paths[15]?.[0]).toEqual(paths[16]?.at(-1));
});

test.each([
  [80, 30, 2],
  [120, 45, 3],
  [80, 30, 5],
])(
  "spring body keeps the same wire diameter as its end face at %s × %s with wire %s",
  (length, width, wire) => {
    const paths = springGripPreview(
      { at: [0, 0], end: [length, 0], length, width, wire, turns: 6, rotation: 0 },
      1,
      { x: length, y: 0 },
    );
    const crossings = (points: (typeof paths)[number]) =>
      points.slice(1).flatMap((b, index) => {
        const a = points[index] as DrawingPoint;
        if (a.y * b.y > 0 || a.y === b.y) return [];
        return [{ x: a.x - (a.y * (b.x - a.x)) / (b.y - a.y), dx: b.x - a.x, dy: b.y - a.y }];
      });
    const outer = crossings(paths[3] ?? []).sort((a, b) => b.x - a.x)[0];
    const inner = crossings(paths[8] ?? []).sort((a, b) => a.x - b.x)[0];
    if (!outer || !inner) throw new Error("wire contours must cross the spring axis");
    const thickness = Math.abs((outer.x - inner.x) * inner.dy) / Math.hypot(inner.dx, inner.dy);
    expect(thickness).toBeGreaterThan(wire * 0.94);
    expect(thickness).toBeLessThan(wire * 1.06);
    for (const index of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
      const start = paths[index]?.[0];
      const previous = paths[index - 1];
      if (!start || !previous) throw new Error("visible turn is missing");
      const gap = Math.min(
        ...previous.slice(1).map((b, i) => {
          const a = previous[i] as DrawingPoint,
            dx = b.x - a.x,
            dy = b.y - a.y;
          const t = Math.max(
            0,
            Math.min(1, ((start.x - a.x) * dx + (start.y - a.y) * dy) / (dx * dx + dy * dy)),
          );
          return Math.hypot(start.x - a.x - t * dx, start.y - a.y - t * dy);
        }),
      );
      expect(gap).toBeLessThan(wire * 0.03);
    }
  },
);

test("spring placement rejects impossible geometry before native editing", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 40, y: 15 },
  ];
  expect(() => compileDrawMethod("spring", points, 2)).toThrow();
  expect(() => compileDrawMethod("spring", points, 6.5)).toThrow();
  expect(() => compileDrawMethod("spring", points, 6, [], { springWire: 20 })).toThrow();
});

test("coil grip preview safely skips an imported spring too short for three turns", () => {
  expect(
    springGripPreview(
      {
        at: [0, 0],
        end: [3, 0],
        length: 3,
        width: 30,
        wire: 2,
        turns: 6,
        rotation: 0,
      },
      3,
      { x: 3, y: 15 },
    ),
  ).toEqual([]);
});
