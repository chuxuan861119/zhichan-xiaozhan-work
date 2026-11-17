import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadDetailGestureLayer, compileCadDetailScene, visibleNativeLabelIds } from "./cad-detail-gesture";
import type { CadScene } from "./cadcraft-client";

afterEach(cleanup);
const primitive = (handle: string, kind = "polyline"): CadScene["primitives"][number] => ({
  handle,
  kind,
  points: [
    [0, 0],
    [20, 0],
    [20, 20],
  ],
  color: [0, 0, 0],
  aci7: true,
  lineweight: 0.3,
});
const scene: CadScene = {
  revision: 1,
  entityCount: 5,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: [],
  primitives: [
    primitive("base"),
    primitive("mask", "mask"),
    primitive("mask"),
    primitive("body"),
    primitive("fill", "triangles"),
    primitive("frame"),
    primitive("source"),
  ],
};
const before = {
  ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
  cad: {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "a".repeat(40),
    assetId: "00000000-0000-4000-8000-000000000002",
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1 as const,
    objects: [
      {
        id: "detail",
        kind: "detail" as const,
        body: ["mask", "body", "fill"],
        frame: ["frame"],
        source: ["source"],
      },
    ],
  },
  detailViews: [
    {
      id: "detail",
      label: "D",
      source: { x: 5, y: 5 },
      center: { x: 20, y: 80 },
      title: { x: 20, y: 50 },
      marker: { x: 2, y: 2 },
      radius: 10,
      ratio: 2,
      fontSize: 12,
      lineWidth: 0.3,
      fragments: [],
    },
  ],
};

test("the live scene moves/scales the actual edited body and opaque mask, never old proxies", () => {
  const compiled = compileCadDetailScene(scene, before.cad.objects);
  const project = {
    ...before,
    detailViews: [{ ...before.detailViews[0]!, ratio: 4, center: { x: 30, y: 70 } }],
  };
  const { container, rerender } = render(
    <svg role="img" aria-label="实时图纸">
      <CadDetailGestureLayer project={project} preview={{ before, compiled, detailId: "detail" }} selectedDetailId="detail" />
    </svg>,
  );
  const body = container.querySelector('[data-cad-detail-live-body="detail"]')!;
  expect(body.getAttribute("transform")).toBe("translate(30 30) scale(2) translate(-20 -20)");
  expect(body.querySelector('path[fill="white"]')).not.toBeNull();
  expect(body.querySelectorAll('path[stroke="none"]')).toHaveLength(2);
  expect(container.querySelectorAll("path")).toHaveLength(4);
  expect(body.querySelector('path[stroke="#007aff"]')?.getAttribute("vector-effect")).toBe(
    "non-scaling-stroke",
  );
  const paths = [...container.querySelectorAll("path")];
  // A frame/mapping handoff shifts the whole camera, not the stored geometry.
  rerender(
    <svg role="img" aria-label="实时图纸">
      <CadDetailGestureLayer
        project={{
          ...project,
          cad: { ...project.cad, mapping: { originX: -10, originY: 110, scale: 1 } },
          detailViews: [{ ...project.detailViews[0]!, center: { x: 40, y: 80 } }],
        }}
        preview={{ before, compiled, detailId: "detail" }}
        selectedDetailId="detail"
      />
    </svg>,
  );
  expect(
    container.querySelector('[data-cad-detail-live-body="detail"]')?.getAttribute("transform"),
  ).toBe("translate(30 30) scale(2) translate(-20 -20)");
  expect([...container.querySelectorAll("path")]).toEqual(paths);
});

test("compilation reuses paths while preserving drawing order and excluding mask outlines", () => {
  const first = compileCadDetailScene(scene, before.cad.objects);
  expect(compileCadDetailScene(scene, before.cad.objects)).toBe(first);
  expect(first.map((run) => run.detailId)).toEqual([undefined, "detail"]);
  expect(first.flatMap((run) => run.paths).map((path) => path.fill)).toEqual([
    "none",
    "white",
    "none",
    "black",
  ]);
});

test("deselecting a detail clears its cached live highlight without changing geometry or native colors", () => {
  const coloredScene = {
    ...scene,
    selection: ["body", "fill"],
    primitives: [...scene.primitives, { ...primitive("colored"), aci7: false, color: [0, 122, 255] as [number, number, number] }],
  };
  const objects = [{ ...before.cad.objects[0]!, body: ["mask", "body", "fill", "colored"] }];
  const compiled = compileCadDetailScene(coloredScene, objects);
  const preview = { before, compiled, detailId: "detail" };
  const { container, rerender } = render(
    <svg aria-label="局部图选择"><CadDetailGestureLayer project={before} preview={preview} selectedDetailId="detail" /></svg>,
  );
  expect(container.querySelector('path[stroke="#007aff"]')).not.toBeNull();
  const paths = [...container.querySelectorAll("path")];
  rerender(<svg aria-label="局部图选择"><CadDetailGestureLayer project={before} preview={preview} /></svg>);
  expect(container.querySelector('path[stroke="#007aff"], path[fill="#007aff"]')).toBeNull();
  const body = container.querySelector('[data-cad-detail-live-body="detail"]')!;
  expect(body.querySelector('path[stroke="black"]')).not.toBeNull();
  expect(body.querySelector('path[fill="black"]')).not.toBeNull();
  expect(body.querySelector('path[stroke="rgb(0 122 255)"]')).not.toBeNull();
  expect(body.querySelector('path[fill="white"]')).not.toBeNull();
  expect([...container.querySelectorAll("path")]).toEqual(paths);
  expect(coloredScene.selection).toEqual(["body", "fill"]);
  expect(compileCadDetailScene(coloredScene, objects)).toBe(compiled);
});

test("live CAD scene paints native labels after synchronization and hides stale labels while pending", () => {
  const labeled = { ...scene, primitives: [...scene.primitives, primitive("label")] };
  const objects = [...before.cad.objects, { id: "a", kind: "label" as const, label: ["label"] }];
  const ready = compileCadDetailScene(labeled, objects);
  const pending = compileCadDetailScene(labeled, objects, false);
  expect(ready.flatMap((run) => run.paths).length).toBeGreaterThan(pending.flatMap((run) => run.paths).length);
  expect(compileCadDetailScene(labeled, objects)).toBe(ready);
  expect(compileCadDetailScene(labeled, objects, false)).toBe(pending);
});

test("native label selection recolors existing glyph paths without another font or changing their width",()=>{
  const labeled={...scene,entities:[...scene.entities,{handle:"label",type:"Polyline",layer:"0"}],primitives:[...scene.primitives,{...primitive("label"),lineweight:0.3}]};
  const objects=[...before.cad.objects,{id:"a",kind:"label" as const,label:["label"]}];
  const compiled=compileCadDetailScene(labeled,objects);
  const labelRun=compiled.find(run=>run.labelId==="a")!;
  expect(labelRun.paths[0]!.width).toBeCloseTo(0.3*96/25.4);
  const labeledProject={...before,annotations:[{id:"a",text:"1",x:10,y:20,fontSize:12,lineWidth:0.3,points:[]}]};
  const {container}=render(<svg aria-label="CAD 标号颜色测试"><CadDetailGestureLayer project={labeledProject} preview={{before:labeledProject,detailId:"",compiled}} labelColors={new Map([["a","#007AFF"]])}/></svg>);
  const paths=[...container.querySelectorAll('path')].filter(e=>e.getAttribute("stroke")==="#007AFF");
  expect(paths).toHaveLength(1);
  expect(Number(paths[0]!.getAttribute("stroke-width"))).toBeCloseTo(0.3*96/25.4);
  expect(container.querySelectorAll("text")).toHaveLength(0);
});

test("moving one CAD label keeps all other native glyphs unchanged", () => {
  const labels = [
    { id: "a", text: "1", x: 10, y: 20, fontSize: 12, lineWidth: 0.3, points: [{ x: 5, y: 40 }, { x: 10, y: 20 }] },
    { id: "b", text: "2", x: 40, y: 20, fontSize: 12, lineWidth: 0.3, points: [{ x: 35, y: 40 }, { x: 40, y: 20 }] },
  ];
  const original = { ...before, annotations: labels };
  const moved = { ...original, annotations: [{ ...labels[0]!, x: 20, points: [{ x: 5, y: 40 }, { x: 20, y: 20 }] }, labels[1]!] };
  const cadScene = {
    ...scene,
    entities: [
      { handle: "a-leader", type: "Polyline", layer: "0" },
      { handle: "a-text", type: "Text", layer: "0" },
      { handle: "b-leader", type: "Polyline", layer: "0" },
      { handle: "b-text", type: "Text", layer: "0" },
    ],
    primitives: [
      primitive("a-leader"), primitive("a-text", "triangles"),
      primitive("b-leader"), primitive("b-text", "triangles"),
    ],
  } satisfies CadScene;
  const objects = [
    { id: "a", kind: "label" as const, label: ["a-leader", "a-text"] },
    { id: "b", kind: "label" as const, label: ["b-leader", "b-text"] },
  ];
  const compiled = compileCadDetailScene(cadScene, objects);
  const preview = { before: original, detailId: "", compiled };
  expect([...visibleNativeLabelIds(moved, preview)]).toEqual(["a", "b"]);
  const { container } = render(<svg aria-label="CAD 标号拖动测试"><CadDetailGestureLayer project={moved} preview={preview} /></svg>);
  expect(container.querySelector('[data-cad-label="a"] [data-label-glyph-shift]')?.getAttribute("transform"))
    .toBe("translate(10 0)");
  expect(container.querySelector('[data-cad-label="b"] [data-label-glyph-shift]')).toBeNull();
  expect(container.querySelector('[data-cad-label="b"] path')?.getAttribute("d"))
    .toBe(compiled.find((run) => run.labelId === "b")!.paths[0]!.d);
  const textChanged = { ...moved, annotations: [{ ...moved.annotations[0]!, text: "10" }, labels[1]!] };
  expect([...visibleNativeLabelIds(textChanged, preview)]).toEqual(["b"]);
  const styled = { ...moved, annotations: [{ ...moved.annotations[0]!, lineWidth: 0.8 }, labels[1]!] };
  expect([...visibleNativeLabelIds(styled, preview)]).toEqual(["b"]);
});

test("opaque masks use the engine triangle list, not connecting edges between triangles", () => {
  const mask = {
    ...primitive("mask", "mask"),
    points: [
      [0, 0],
      [10, 0],
      [0, 10],
      [20, 20],
      [30, 20],
      [20, 30],
    ] as [number, number][],
  };
  const compiled = compileCadDetailScene({ ...scene, primitives: [mask] }, before.cad.objects);
  expect(compiled[0]?.paths[0]?.d).toBe("M0 0L10 0L0 10ZM20 20L30 20L20 30Z");
  expect(compiled[0]?.paths[0]?.stroke).toBe("none");
});
