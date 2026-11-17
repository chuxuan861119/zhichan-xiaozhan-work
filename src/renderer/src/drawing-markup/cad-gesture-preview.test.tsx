import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadGesturePreview, type CadPreview, type CadPreviewHandle } from "./cad-gesture-preview";

afterEach(cleanup);

test("gear grip preview keeps the selected stroke and does not redraw the old gear", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1, engine: "cadcraft", engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId, unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg role="img" aria-label="齿轮夹点预览">
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  const primitive = {
    handle: "G", kind: "polyline", points: [[0, 0], [10, 0]] as [number, number][],
    color: [0, 0, 0] as [number, number, number], aci7: true, lineweight: 0,
  };
  act(() => ref.current?.update({
    mode: "select", anchor: null, points: [], cursor: { x: 20, y: 0 },
    snapped: false, handles: ["G"], gripTarget: { handle: "G", index: 1 },
    trimOriginal: [primitive], hideOriginal: true,
    trimResult: [{ ...primitive, points: [[0, 0], [20, 0]] }],
    scene: {
      revision: 0, entityCount: 1, selection: [], bounds: null,
      svgFrame: { origin: [0, 0], width: 100, height: 100 },
      entities: [{ handle: "G", type: "Block Reference", layer: "0", grips: [[0, 0]],
        gear: { kind: "external", size: 20, teeth: 20, hole: true } }],
      primitives: [primitive],
    },
  }));
  const lines = container.querySelectorAll("[data-trim-context] polyline");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.getAttribute("stroke")).toBe("#007aff");
  expect(lines[0]?.getAttribute("stroke-width")).toBe("2");
  expect(container.querySelector('[data-cad-gear-feedback="active"]')).toBeTruthy();
});

test("trim preview mutes removed geometry with solid light gray and renders solid fills without triangle outlines", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg>
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  const line = {
    handle: "A",
    kind: "polyline",
    points: [
      [0, 0],
      [10, 0],
    ] as [number, number][],
    color: [0, 0, 0] as [number, number, number],
    aci7: true,
    lineweight: 0,
  };
  const fill = {
    ...line,
    handle: "H",
    kind: "triangles",
    points: [
      [0, 0],
      [10, 0],
      [0, 10],
    ] as [number, number][],
  };
  act(() =>
    ref.current?.update({
      mode: "trim",
      anchor: null,
      points: [],
      cursor: { x: 5, y: 0 },
      snapped: false,
      handles: [],
      scene: {
        revision: 0,
        entityCount: 2,
        selection: [],
        entities: [],
        primitives: [
          line,
          fill,
          {
            ...line,
            handle: "far-away",
            points: [
              [10000, 10000],
              [10010, 10010],
            ],
          },
        ],
        bounds: null,
        svgFrame: { origin: [0, 0], width: 100, height: 100 },
      },
      trimOriginal: [line, fill],
      curvePaths: [
        [
          { x: 7, y: 0 },
          { x: 10, y: 0 },
        ],
      ],
    }),
  );
  expect(container.querySelector('[data-trim-original="true"]')?.getAttribute("stroke")).toBe(
    "#c4c4c4",
  );
  expect(
    container.querySelector('[data-trim-original="true"]')?.getAttribute("stroke-dasharray"),
  ).toBe("none");
  expect(container.querySelector('[data-trim-original="true"][fill="#c4c4c4"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-trim-context="true"] polyline')).toHaveLength(1);
  expect(
    container.querySelector('[data-trim-original="true"][fill="#c4c4c4"]')?.getAttribute("stroke"),
  ).toBe("none");
});

test("hatch edit preview clears the previous pattern and restores underlying drawing context", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg role="img" aria-label="填充预览">
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  const primitive = {
    handle: "line",
    kind: "polyline",
    points: [
      [0, 0],
      [10, 10],
    ] as [number, number][],
    color: [0, 0, 0] as [number, number, number],
    aci7: true,
    lineweight: 0.25,
  };
  act(() =>
    ref.current?.update({
      mode: "hatch",
      anchor: null,
      points: [],
      cursor: { x: 0, y: 0 },
      snapped: false,
      handles: [],
      scene: {
        revision: 0,
        entityCount: 1,
        selection: [],
        entities: [],
        primitives: [],
        bounds: null,
        svgFrame: { origin: [0, 0], width: 100, height: 100 },
      },
      hatchContext: { bounds: [0, 0, 10, 10], primitives: [primitive] },
      nativePrimitives: [primitive],
    }),
  );
  expect(container.querySelector('[data-hatch-context] rect[fill="white"]')).not.toBeNull();
  expect(container.querySelector('[data-hatch-context] polyline[stroke="black"]')).not.toBeNull();
  expect(container.querySelector("[data-hatch-lines]")?.getAttribute("stroke-width")).toBe("0.75");
});

test.each(["move", "scale"] as const)(
  "%s preview does not stroke wipeout triangles as a striped grid",
  (mode) => {
    const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
    project.cad = {
      version: 1,
      engine: "cadcraft",
      engineVersion: "a".repeat(40),
      assetId: project.sourceAssetId,
      unified: 1,
      mapping: { originX: 0, originY: 100, scale: 1 },
    };
    const ref = createRef<CadPreviewHandle>();
    const { container } = render(
      <svg role="img" aria-label="变换预览">
        <CadGesturePreview ref={ref} project={project} unit={1} />
      </svg>,
    );
    const preview: CadPreview = {
      mode,
      anchor: { x: 0, y: 0 },
      cursor: { x: 10, y: 20 },
      points: [],
      handles: ["mask", "line"],
      snapped: false,
      ...(mode === "scale"
        ? { transform: { command: "scale" as const, base: [0, 0] as [number, number], factor: 2 } }
        : {}),
      scene: {
        revision: 0,
        entityCount: 2,
        selection: [],
        entities: [],
        bounds: null,
        svgFrame: { origin: [0, 0], width: 100, height: 100 },
        primitives: ["mask", "polyline"].map((kind, i) => ({
          kind,
          handle: i ? "line" : "mask",
          points: [
            [0, 0],
            [20, 0],
            [20, 20],
          ] as [number, number][],
          color: [255, 255, 255] as [number, number, number],
          aci7: false,
          lineweight: 0,
        })),
      },
    };
    act(() => ref.current?.update(preview));
    const affine = container.querySelector("[data-cad-affine-preview]");
    expect(affine?.getAttribute("transform")).toBe("matrix(1 0 0 -1 0 100)");
    expect(affine?.firstElementChild?.getAttribute("transform")).toBe(
      mode === "move" ? null : "translate(0 0) scale(2) translate(0 0)",
    );
    expect(affine?.querySelectorAll('polyline[points="0,0 20,0 20,20"]')).toHaveLength(1);
  },
);

test("pointer-only transforms retain the selected geometry instead of walking all vertices again", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 2 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg>
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  let reads = 0;
  const points: [number, number][] = [
    [0, 0],
    [10, 20],
  ];
  const primitive = {
    handle: "A",
    kind: "polyline",
    get points() {
      reads++;
      return points;
    },
    color: [0, 0, 0] as [number, number, number],
    aci7: true,
    lineweight: 0,
  };
  const preview: CadPreview = {
    mode: "move",
    anchor: { x: 0, y: 0 },
    cursor: { x: 5, y: 5 },
    points: [],
    handles: ["A"],
    snapped: false,
    scene: {
      revision: 1,
      entityCount: 1,
      selection: [],
      entities: [],
      bounds: null,
      svgFrame: { origin: [0, 0], width: 100, height: 100 },
      primitives: [primitive],
    },
  };
  act(() => ref.current?.update(preview));
  const first = container.querySelector("[data-cad-affine-preview] polyline");
  const initialReads = reads;
  act(() => ref.current?.update({ ...preview, cursor: { x: 10, y: 15 } }));
  expect(reads).toBe(initialReads);
  expect(container.querySelector("[data-cad-affine-preview] polyline")).toBe(first);
  // Pattern/hatch previews also keep their geometry when only the pointer label moves.
  const nativePrimitives = [primitive];
  act(() => ref.current?.update({ ...preview, mode: "arrayrect", anchor: null, nativePrimitives }));
  const native = container.querySelector('[data-cad-preview="arrayrect"] polyline');
  const retainedReads = reads;
  act(() =>
    ref.current?.update({
      ...preview,
      mode: "arrayrect",
      anchor: null,
      nativePrimitives,
      cursor: { x: 30, y: 40 },
    }),
  );
  expect(reads).toBe(retainedReads);
  expect(container.querySelector('[data-cad-preview="arrayrect"] polyline')).toBe(native);
});
test("ordinary pointer movement has no duplicate cursor but retains the drawing rubber band", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg role="img" aria-label="CAD测试画布">
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  const preview: CadPreview = {
    mode: "line",
    anchor: { x: 10, y: 20 },
    points: [],
    cursor: { x: 30, y: 40 },
    snapped: false,
    handles: [],
    scene: {
      revision: 0,
      entityCount: 0,
      selection: [],
      entities: [],
      primitives: [],
      bounds: null,
      svgFrame: { origin: [0, 0], width: 100, height: 100 },
    },
  };
  act(() => ref.current?.update(preview));
  expect(container.querySelector(".cad-cursor")).toBeNull();
  expect(container.querySelector("polyline")?.getAttribute("points")).toBe("10,80 30,60");
  expect(container.querySelector("clipPath")).toBeNull();
  expect(ref.current).toHaveProperty("advanceLine", expect.any(Function));
  act(() => ref.current?.advanceLine({ x: 30, y: 40 }));
  expect(container.querySelector("polyline")?.getAttribute("points")).toBe("30,60 30,60");
  act(() => ref.current?.update({ ...preview, snapped: true, snapType: "intersection" }));
  const marker = container.querySelector(".cad-cursor.is-snapped");
  expect(marker?.querySelector("rect")).toBeNull();
  expect(marker?.getAttribute("data-cad-snap")).toBe("intersection");
  const intersection = marker?.querySelector("path")?.getAttribute("d");
  expect(intersection).toBe("M23 53L37 67M23 67L37 53");
  const shapes = new Set<string>();
  for (const snapType of [
    "endpoint",
    "midpoint",
    "center",
    "quadrant",
    "intersection",
    "nearest",
    "node",
    "insertion",
  ] as const) {
    act(() => ref.current?.update({ ...preview, snapped: true, snapType }));
    const active = container.querySelector(".cad-cursor.is-snapped");
    expect(active?.getAttribute("data-cad-snap")).toBe(snapType);
    expect(active?.querySelector("path")?.getAttribute("d")).toBeTruthy();
    shapes.add(active!.querySelector("path")!.getAttribute("d")!);
  }
  expect(shapes.size).toBe(8);
  act(() => ref.current?.update({ ...preview, mode: "select", snapped: true, snapType: "insertion", gripHint: "调整宽度" }));
  expect(container.querySelector(".cad-snap-label")?.textContent).toBe("调整宽度");
  expect(container.querySelector(".cad-cursor")?.getAttribute("aria-label")).toBe("调整宽度吸附");
  act(() => ref.current?.update({ ...preview, snapped: true, snapType: "insertion" }));
  expect(container.querySelector(".cad-snap-label")?.textContent).toBe("插入点");
  act(() =>
    ref.current?.update({ ...preview, cursor: { x: 30, y: 20 }, snapped: true, snapType: "polar" }),
  );
  expect(container.querySelector(".cad-snap-label")?.textContent).toBe("水平");
  act(() => ref.current?.update({ ...preview, mode: "select", cursor: { x: 30, y: 20 }, snapped: true, snapType: "polar", gripTarget: { handle: "A", index: 0 }, gripHint: "调整起点" }));
  expect(container.querySelector(".cad-snap-label")?.textContent).toBe("调整起点 · 水平");
  act(() =>
    ref.current?.update({ ...preview, cursor: { x: 10, y: 40 }, snapped: true, snapType: "polar" }),
  );
  expect(container.querySelector(".cad-snap-label")?.textContent).toBe("竖直");
  for (const [x, y, label] of [
    [30, 40, "45°"],
    [-10, 40, "135°"],
    [-10, 0, "225°"],
    [30, 0, "315°"],
  ] as const) {
    act(() =>
      ref.current?.update({
        ...preview,
        cursor: { x, y },
        snapped: true,
        snapType: "polar",
      }),
    );
    expect(container.querySelector(".cad-snap-label")?.textContent).toBe(label);
  }
  act(() =>
    ref.current?.update({
      ...preview,
      snapped: true,
      snapType: "tangent-pending",
      guides: [
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      ],
      references: [{ x: 10, y: 20 }],
    }),
  );
  expect(container.querySelector(".cad-cursor.is-deferred")?.getAttribute("data-cad-snap")).toBe(
    "tangent-pending",
  );
  expect(container.querySelectorAll(".cad-tracking-guide")).toHaveLength(1);
  expect(container.querySelectorAll(".cad-tracking-reference")).toHaveLength(1);
  act(() =>
    ref.current?.update({
      ...preview,
      invalid: true,
      curvePaths: [
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      ],
    }),
  );
  expect(container.querySelectorAll("polyline")).toHaveLength(0);
  act(() => ref.current?.update(null));
  expect(container.querySelector(".cad-gesture-preview")).toBeNull();
});

test("dragging a selected polyline grip previews the stretched outline and midpoint translation", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadPreviewHandle>();
  const { container } = render(
    <svg role="img" aria-label="夹点拉伸预览">
      <CadGesturePreview ref={ref} project={project} unit={1} />
    </svg>,
  );
  const scene: CadPreview["scene"] = {
    revision: 0,
    entityCount: 1,
    selection: ["P"],
    bounds: null,
    svgFrame: { origin: [0, 0], width: 100, height: 100 },
    entities: [
      {
        handle: "P",
        type: "LWPolyline",
        layer: "0",
        grips: [
          [0, 0],
          [10, 0],
          [20, 0],
          [20, 10],
          [20, 20],
          [10, 20],
          [0, 20],
          [0, 10],
        ],
        geometry: {
          type: "LwPolyline",
          closed: true,
          vertices: [
            { p: { x: 0, y: 0 }, bulge: 0 },
            { p: { x: 20, y: 0 }, bulge: 0 },
            { p: { x: 20, y: 20 }, bulge: 0 },
            { p: { x: 0, y: 20 }, bulge: 0 },
          ],
        },
      },
    ],
    primitives: [
      {
        handle: "P",
        kind: "polyline",
        points: [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
          [0, 0],
        ],
        color: [0, 0, 0],
        aci7: true,
        lineweight: 0,
      },
    ],
  };
  const preview: CadPreview = {
    mode: "select",
    anchor: null,
    points: [],
    cursor: { x: 5, y: 5 },
    snapped: false,
    handles: ["P"],
    scene,
    gripFrom: { x: 0, y: 0 },
  };
  act(() => ref.current?.update({ ...preview, gripTarget: { handle: "P", index: 0 } }));
  expect(container.querySelector(".cad-grip-shape polyline")?.getAttribute("points")).toBe(
    "5,95 20,100 20,80 0,80 5,95",
  );
  act(() =>
    ref.current?.update({
      ...preview,
      cursor: { x: 10, y: 5 },
      gripTarget: { handle: "P", index: 1 },
    }),
  );
  expect(container.querySelector(".cad-grip-shape polyline")?.getAttribute("points")).toBe(
    "0,95 20,95 20,80 0,80 0,95",
  );
});
