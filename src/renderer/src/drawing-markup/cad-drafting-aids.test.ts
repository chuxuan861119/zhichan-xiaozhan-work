import { expect, test, vi } from "vitest";
import { CadDraftingAids, DEFAULT_AID_SETTINGS } from "./cad-drafting-aids";
import * as geometry from "./cad-drafting-geometry";
import type { CadScene } from "./cadcraft-client";

const scene: CadScene = {
  revision: 1,
  entityCount: 3,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: [
    {
      handle: "A",
      type: "Line",
      layer: "0",
      grips: [
        [0, 0],
        [5, 0],
        [10, 0],
      ],
      geometry: { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    },
    {
      handle: "B",
      type: "Line",
      layer: "0",
      grips: [
        [20, 10],
        [25, 10],
        [30, 10],
      ],
      geometry: { type: "line", a: { x: 20, y: 10 }, b: { x: 30, y: 10 } },
    },
    {
      handle: "C",
      type: "Circle",
      layer: "0",
      radius: 5,
      grips: [
        [40, 0],
        [45, 0],
        [40, 5],
        [35, 0],
        [40, -5],
      ],
      geometry: { type: "circle", center: { x: 40, y: 0 }, radius: 5 },
    },
  ],
  primitives: [],
};

test("pointer capture does not project distant edges for every mouse sample", () => {
  const distant: CadScene = {
    ...scene,
    entities: [
      ...scene.entities,
      ...Array.from({ length: 1000 }, (_, i) => ({
        handle: `far${i}`,
        type: "Line",
        layer: "0",
        geometry: { type: "line", a: { x: 1000 + i, y: 1000 }, b: { x: 1005 + i, y: 1010 } },
      })),
    ],
  };
  const project = vi.spyOn(geometry, "perpendicularFoot");
  try {
    const result = new CadDraftingAids().resolve({ x: 5, y: 0.1 }, distant, 0.4, {
      anchor: { x: 5, y: 4 },
      hover: true,
    });
    expect(result.point).toEqual({ x: 5, y: 0 });
    expect(project.mock.calls.length).toBeLessThan(10);
  } finally {
    project.mockRestore();
  }
});
test("hover acquires at 250ms, tracks two references and clears at command boundaries", () => {
  const aids = new CadDraftingAids();
  const hover = (x: number, y: number, now: number) =>
    aids.resolve({ x, y }, scene, 0.4, { hover: true, now });
  hover(0, 0, 0);
  expect(hover(0, 0, 249).references).toHaveLength(0);
  expect(hover(0, 0, 250).references).toHaveLength(1);
  expect(hover(0, 7, 260).type).toBe("tracking");
  hover(20, 10, 300);
  hover(20, 10, 550);
  const cross = hover(0.1, 10.1, 560);
  expect(cross.point).toEqual({ x: 0, y: 10 });
  expect(cross.guides).toHaveLength(2);
  aids.clear();
  expect(hover(0.1, 10.1, 600).references).toHaveLength(0);
});
test("extension and parallel lines come only from acquired edges", () => {
  const aids = new CadDraftingAids();
  aids.resolve({ x: 10, y: 0 }, scene, 0.4, { hover: true, now: 0 });
  aids.resolve({ x: 10, y: 0 }, scene, 0.4, { hover: true, now: 250 });
  expect(aids.resolve({ x: 15, y: 0.1 }, scene, 0.4, { forced: "extension" }).point).toEqual({
    x: 15,
    y: 0,
  });
  aids.clear();
  const ctx = { anchor: { x: 0, y: 20 }, hover: true };
  aids.resolve({ x: 3, y: 0 }, scene, 0.4, { ...ctx, now: 0 });
  aids.resolve({ x: 3, y: 0 }, scene, 0.4, { ...ctx, now: 250 });
  const parallel = aids.resolve({ x: 9, y: 20.1 }, scene, 0.4, {
    anchor: ctx.anchor,
    forced: "parallel",
  });
  expect(parallel.type).toBe("parallel");
  expect(parallel.point).toEqual({ x: 9, y: 20 });
});

test.each([
  [
    { x: 0, y: 20 },
    { x: 20.1, y: 20.2 },
  ],
  [
    { x: 0, y: 0 },
    { x: 20.1, y: 20.2 },
  ],
])("polar and acquired tracking paths snap to their shared intersection (%j)", (anchor, cursor) => {
  const aids = new CadDraftingAids();
  const settings = { ...DEFAULT_AID_SETTINGS, angle45: true };
  aids.resolve({ x: 20, y: 10 }, scene, 0.4, { hover: true, now: 0 }, settings);
  aids.resolve({ x: 20, y: 10 }, scene, 0.4, { hover: true, now: 250 }, settings);
  const result = aids.resolve(cursor, scene, 0.4, { anchor }, settings);
  expect(result.type).toBe("tracking");
  expect(result.point.x).toBeCloseTo(20, 8);
  expect(result.point.y).toBeCloseTo(20, 8);
  expect(result.guides).toHaveLength(2);
  expect(result.guides.map(([from]) => from)).toContainEqual(anchor);
  expect(result.guides.map(([from]) => from)).toContainEqual({ x: 20, y: 10 });
});
test("tangency supports a deferred first point and does not invent a tangent inside a circle", () => {
  const aids = new CadDraftingAids();
  const first = aids.resolve({ x: 43, y: 4 }, scene, 0.4, { tangent: true, forced: "tangent" });
  expect(first.type).toBe("tangent-pending");
  expect(first.deferred?.handle).toBe("C");
  const result = aids.resolve({ x: 53, y: 0 }, scene, 0.4, {
    tangent: true,
    deferred: first.deferred,
  });
  expect(result.type).toBe("tangent");
  const from = result.start!;
  expect((from.x - 40) * (53 - from.x) + from.y * -from.y).toBeCloseTo(0, 8);
  expect(
    aids.resolve({ x: 41, y: 0 }, scene, 0.4, { tangent: true, deferred: first.deferred }).invalid,
  ).toBe(true);
});
test("perpendicular, 45 degree option and orthogonal constraints use real solved coordinates", () => {
  const aids = new CadDraftingAids();
  expect(
    aids.resolve({ x: 3, y: 0.1 }, scene, 0.4, { anchor: { x: 3, y: 8 }, forced: "perpendicular" })
      .point,
  ).toEqual({ x: 3, y: 0 });
  const diagonal = aids.resolve(
    { x: 8, y: 8.1 },
    scene,
    0.4,
    { anchor: { x: 0, y: 0 } },
    { ...DEFAULT_AID_SETTINGS, angle45: true },
  );
  expect(diagonal.type).toBe("polar");
  expect(diagonal.point.x).toBeCloseTo(diagonal.point.y, 9);
  const constrained = aids.resolve({ x: 20.1, y: 10.1 }, scene, 0.4, {
    anchor: { x: 0, y: 0 },
    orthogonal: true,
  });
  expect(constrained.type).toBeUndefined();
  expect(constrained.point).toEqual({ x: 20.1, y: 0 });
});
test("a stationary hover is consumed only once and re-hovering toggles the reference", () => {
  const aids = new CadDraftingAids();
  const h = (x: number, y: number, now: number) =>
    aids.resolve({ x, y }, scene, 0.4, { hover: true, now });
  h(0, 0, 0);
  h(0, 0, 250);
  expect(h(0, 0, 900).references).toHaveLength(1);
  h(4, 9, 950);
  h(0, 0, 1000);
  expect(h(0, 0, 1250).references).toHaveLength(0);
});

test("a one-shot deferred tangent remains solvable when permanent tangency is disabled", () => {
  const aids = new CadDraftingAids();
  const settings = {
    ...DEFAULT_AID_SETTINGS,
    enabled: new Set([...DEFAULT_AID_SETTINGS.enabled].filter((t) => t !== "tangent")),
  };
  const first = aids.resolve(
    { x: 43, y: 4 },
    scene,
    0.4,
    { tangent: true, forced: "tangent" },
    settings,
  );
  const result = aids.resolve(
    { x: 53, y: 0 },
    scene,
    0.4,
    { tangent: true, deferred: first.deferred },
    settings,
  );
  expect(result.invalid).not.toBe(true);
  expect(result.type).toBe("tangent");
});

test("the far perpendicular foot is available even when the near foot is outside a finite arc", () => {
  const arcScene: CadScene = {
    ...scene,
    entities: [
      {
        handle: "arc",
        type: "Arc",
        layer: "0",
        geometry: {
          type: "arc",
          center: { x: 0, y: 0 },
          radius: 5,
          start: Math.PI * 0.75,
          end: Math.PI * 1.25,
        },
      },
    ],
  };
  const result = new CadDraftingAids().resolve({ x: -5, y: 0.01 }, arcScene, 0.4, {
    anchor: { x: 10, y: 0 },
    forced: "perpendicular",
  });
  expect(result.type).toBe("perpendicular");
  expect(result.point).toEqual({ x: -5, y: 0 });
  const contact = new CadDraftingAids().resolve({ x: -5, y: 0.01 }, arcScene, 0.4, {
    anchor: { x: 10, y: 0 },
    circle: true,
    forced: "tangent",
  });
  expect(contact.type).toBe("tangent");
  expect(contact.point).toEqual({ x: -5, y: 0 });
  expect(
    new CadDraftingAids().resolve({ x: 5, y: 0.01 }, arcScene, 0.4, {
      anchor: { x: 10, y: 0 },
      circle: true,
      forced: "tangent",
    }).type,
  ).toBeUndefined();
});

test("Tab keeps the chosen tangent through mouse-down and only resets when it leaves eligibility", () => {
  const aids = new CadDraftingAids();
  const context = { anchor: { x: 53, y: 0 }, tangent: true, forced: "tangent" as const };
  const point = { x: 43, y: 4 };
  const initial = aids.resolve(point, scene, 0.4, context);
  expect(aids.cycle()).toBe(true);
  const chosen = aids.resolve(point, scene, 0.4, context);
  expect(chosen.point).not.toEqual(initial.point);
  expect(aids.resolve(point, scene, 0.4, context).point).toEqual(chosen.point);
  aids.clear();
  expect(aids.resolve(point, scene, 0.4, context).point).toEqual(initial.point);
});

test("a real line connection takes priority over a coincident parallel or polar guide", () => {
  const aids = new CadDraftingAids();
  const anchor = { x: 0, y: 0 };
  aids.resolve(anchor, scene, 0.4, { hover: true, now: 0 });
  aids.resolve(anchor, scene, 0.4, { hover: true, now: 250 });
  const result = aids.resolve({ x: 3, y: 0.1 }, scene, 0.4, { anchor });
  expect(result.type).toBe("nearest");
  expect(result.point).toEqual({ x: 3, y: 0 });
});

test("deferred circle-to-circle tangency cycles exact common tangents and respects F8", () => {
  const second = {
    handle: "D",
    type: "Circle",
    layer: "0",
    geometry: { type: "circle", center: { x: 60, y: 0 }, radius: 5 },
  };
  const twoCircles = { ...scene, entities: [...scene.entities, second] };
  const aids = new CadDraftingAids();
  const first = aids.resolve({ x: 43, y: 4 }, twoCircles, 0.4, {
    tangent: true,
    forced: "tangent",
  });
  const context = { tangent: true, anchor: first.point, deferred: first.deferred };
  const target = { x: 57, y: 4 };
  const result = aids.resolve(target, twoCircles, 0.4, context);
  expect(result.type).toBe("tangent");
  if (!result.start) throw new Error("Common tangent start missing");
  const dx = result.point.x - result.start.x,
    dy = result.point.y - result.start.y;
  expect((result.start.x - 40) * dx + result.start.y * dy).toBeCloseTo(0, 8);
  expect((result.point.x - 60) * dx + result.point.y * dy).toBeCloseTo(0, 8);
  expect(aids.cycle()).toBe(true);
  expect(aids.resolve(target, twoCircles, 0.4, context).point).not.toEqual(result.point);
  aids.clear();
  const orthogonal = aids.resolve(target, twoCircles, 0.4, { ...context, orthogonal: true });
  expect(orthogonal.start?.y).toBe(orthogonal.point.y);
  expect(orthogonal.invalid).not.toBe(true);
});

test("radius endpoint contact with a finite line or circle is classified as tangency, not a normal foot", () => {
  const aids = new CadDraftingAids();
  const context = { anchor: { x: 3, y: 8 }, circle: true };
  expect(aids.resolve({ x: 3, y: 0.1 }, scene, 0.4, context).type).toBe("tangent");
  const length = Math.hypot(13, 12);
  expect(
    aids.resolve({ x: 40 + 65 / length, y: 60 / length }, scene, 0.4, {
      anchor: { x: 53, y: 12 },
      circle: true,
    }).type,
  ).toBe("tangent");
  expect(aids.resolve({ x: 3, y: 0.1 }, scene, 0.4, { anchor: context.anchor }).type).toBe(
    "perpendicular",
  );
});

test("a line starting on a circle follows the tangent instead of snapping back to its own start", () => {
  const point = { x: 45, y: 8 };
  const result = new CadDraftingAids().resolve(point, scene, 0.4, {
    anchor: { x: 45, y: 0 },
    tangent: true,
  });
  expect(result.type).toBe("tangent");
  expect(result.point).toEqual(point);
});

test("the third arc point snaps to a true line contact, not the perpendicular from the middle point", () => {
  const result = new CadDraftingAids().resolve({ x: 3, y: 0.1 }, scene, 0.4, {
    anchor: { x: 5, y: 2 },
    arc: [
      { x: 1, y: 2 },
      { x: 5, y: 2 },
    ],
  });
  expect(result.type).toBe("tangent");
  expect(result.point.x).toBeCloseTo(3, 8);
  expect(result.point.y).toBeCloseTo(0, 8);
});

test("arc-to-arc contact uses the new arc's circle, and does not report an intermediate arc point as perpendicular", () => {
  const target: CadScene = {
    ...scene,
    entities: [
      {
        handle: "arc",
        type: "Arc",
        layer: "0",
        grips: [
          [10, 2],
          [8, 0],
          [10, -2],
          [10, 0],
        ],
        geometry: {
          type: "arc",
          center: { x: 10, y: 0 },
          radius: 2,
          start: Math.PI / 2,
          end: (3 * Math.PI) / 2,
        },
      },
    ],
  };
  const result = new CadDraftingAids().resolve({ x: 8, y: 0 }, target, 0.4, {
    anchor: { x: 6, y: -2 },
    arc: [
      { x: 4, y: 0 },
      { x: 6, y: -2 },
    ],
  });
  expect(result.type).toBe("tangent");
  expect(result.point.x).toBeCloseTo(8, 8);
  expect(result.point.y).toBeCloseTo(0, 8);
  expect(
    new CadDraftingAids().resolve({ x: 3, y: 0.1 }, scene, 0.4, {
      anchor: { x: 3, y: 8 },
      arc: [{ x: 3, y: 8 }],
    }).type,
  ).not.toBe("perpendicular");
});
