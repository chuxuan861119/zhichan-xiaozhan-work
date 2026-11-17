import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadSelectionOverlay } from "./cad-editing-panel";
import type { CadScene } from "./cadcraft-client";

afterEach(cleanup);

test("active tools retain selection strokes and restore grips on returning to selection", () => {
  const props = { project, selection: { scene, handles: ["line"] } };
  const {container,rerender} = render(<svg><CadSelectionOverlay {...props} showGrips={false}/></svg>);
  expect(container.querySelector("polyline")).not.toBeNull();
  expect(container.querySelector(".cad-control-points")).toBeNull();
  rerender(<svg><CadSelectionOverlay {...props} showGrips/></svg>);
  expect(container.querySelector(".cad-control-points")).not.toBeNull();
});

test("meshed gear controls use the shared grip color when selection order changes",()=>{
  const gears:CadScene={...scene,entities:["103","107"].map((handle,i)=>({handle,type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},gearMate:i?"103":"107",grips:[[i*100,0],[i*100+40,0]] as [number,number][]}))};
  const props={project:{...project,cad:{...project.cad,objects:[]}},selection:{scene:gears,handles:["103","107"]}};
  const {container,rerender}=render(<svg><CadSelectionOverlay {...props}/></svg>);
  const stroke=(h:string)=>container.querySelector(`[data-cad-gear-handle="${h}"]`)?.getAttribute("stroke");
  expect(stroke("103")).toBe("var(--drawing-grip, #c45a00)");expect(stroke("107")).toBe("var(--drawing-grip, #c45a00)");
  const unlinked={...gears,entities:gears.entities.map(e=>{const copy={...e};delete copy.gearMate;return copy;})};
  rerender(<svg><CadSelectionOverlay {...props} selection={{scene:unlinked,handles:["107","103"]}}/></svg>);
  expect(stroke("103")).toBe("var(--drawing-grip, #c45a00)");expect(stroke("107")).toBe("var(--drawing-grip, #c45a00)");
  rerender(<svg><CadSelectionOverlay {...props} selection={{scene:gears,handles:["107"]}}/></svg>);
  expect(stroke("107")).toBe("var(--drawing-grip, #c45a00)");
});

test("unified CAD control points are not clipped to the original finite drawing page", () => {
  const { container } = render(
    <svg role="img" aria-label="无限画布夹点预览">
      <CadSelectionOverlay
        project={{ ...project, cad: { ...project.cad, unified: 1, objects: [] } }}
        selection={{
          scene: {
            ...scene,
            entities: [
              {
                handle: "G",
                type: "Block Reference",
                layer: "0",
                gear: { kind: "external", teeth: 20, hole: true, size: 80 },
                grips: [
                  [-20, 120],
                  [20, 120],
                  [-70, 120],
                  [-20, 176],
                ],
              },
            ],
          },
          handles: ["G"],
        }}
      />
    </svg>,
  );
  const control = container.querySelector('[data-cad-gear-grip="3"]');
  expect(control).toBeTruthy();
  expect(control?.closest("[clip-path]")).toBeNull();
});

test.each(["external", "internal", "rack"] as const)(
  "%s gear handles have distinguishable labelled shapes and respect detail ownership",
  (kind) => {
    const entity = {
      handle: "G",
      type: "Block Reference",
      layer: "0",
      gear: { kind, teeth: 20, hole: true, size: 80 },
      grips: [[0, 0], [40, 0], [-50, 0], ...(kind === "rack" ? [] : [[0, 56]])] as [
        number,
        number,
      ][],
    };
    const selection = { scene: { ...scene, entities: [entity] }, handles: ["G"] };
    const { container, rerender } = render(
      <svg role="img" aria-label="齿轮夹点预览">
        <CadSelectionOverlay
          project={{ ...project, cad: { ...project.cad, objects: [] } }}
          selection={selection}
        />
      </svg>,
    );
    expect(container.querySelector('[data-cad-gear-grip="1"] rect')).toBeTruthy();
    expect(container.querySelector('[data-cad-gear-grip="2"] path')).toBeTruthy();
    expect(
      container.querySelector('[data-cad-gear-grip="2"]')?.getAttribute("aria-label"),
    ).toContain("齿数");
    expect(container.querySelectorAll('[data-cad-gear-grip="3"]')).toHaveLength(
      kind === "rack" ? 0 : 1,
    );
    const owned = {
      ...project,
      cad: { ...project.cad, objects: [{ id: "detail", kind: "detail" as const, body: ["G"] }] },
    };
    rerender(
      <svg role="img" aria-label="详图外夹点预览">
        <CadSelectionOverlay project={owned} selection={selection} />
      </svg>,
    );
    expect(container.querySelectorAll("[data-cad-gear-grip]")).toHaveLength(0);
    rerender(
      <svg role="img" aria-label="详图内夹点预览">
        <CadSelectionOverlay project={owned} selection={selection} inside="detail" />
      </svg>,
    );
    expect(container.querySelectorAll("[data-cad-gear-grip]")).toHaveLength(
      kind === "rack" ? 3 : 4,
    );
  },
);

test.each([0.5, 1, 2])("selection grips use a smaller three-pixel radius at unit %s", (unit) => {
  const { container } = render(
    <svg role="img" aria-label="选择夹点预览">
      <CadSelectionOverlay
        project={{ ...project, cad: { ...project.cad, objects: [] } }}
        selection={{ scene, handles: ["line"] }}
        unit={unit}
      />
    </svg>,
  );
  expect(container.querySelector("circle")?.getAttribute("r")).toBe(String(3 * unit));
  expect(container.querySelector(".cad-selection-overlay")?.getAttribute("pointer-events")).toBe(
    "none",
  );
});

test("hatch selection highlights its strokes without exposing a move grip", () => {
  const { container } = render(
    <svg role="img" aria-label="填充选择预览">
      <CadSelectionOverlay
        project={{ ...project, cad: { ...project.cad, objects: [] } }}
        selection={{
          scene: {
            ...scene,
            entities: [{ handle: "line", type: "Hatch", layer: "0", grips: [[0, 0]] }],
          },
          handles: ["line"],
        }}
      />
    </svg>,
  );
  expect(container.querySelectorAll("polyline")).toHaveLength(1);
  expect(container.querySelectorAll("circle")).toHaveLength(0);
});

test("a saved-preview handoff never exposes the old frame or old body grips", () => {
  const oldObjects = [{ id: "detail", kind: "detail" as const, body: ["line"], frame: ["fill"] }];
  const { container } = render(
    <svg role="img" aria-label="选择预览">
      <CadSelectionOverlay
        project={project}
        selection={{ scene, handles: ["line", "fill"], objects: oldObjects }}
      />
    </svg>,
  );
  expect(container.querySelectorAll("circle")).toHaveLength(0);
  expect(container.querySelectorAll('path[stroke="none"]')).toHaveLength(0);
});

test("an old selection scene is hidden until its replacement checkpoint loads", () => {
  const { container } = render(
    <svg role="img" aria-label="旧场景">
      <CadSelectionOverlay
        project={project}
        selection={{ scene, handles: ["line"], checkpointId: "old" }}
      />
    </svg>,
  );
  expect(container.querySelector("g")).toBeNull();
});

const project = {
  ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
  cad: {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "a".repeat(40),
    assetId: "00000000-0000-4000-8000-000000000002",
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1 as const,
    objects: [{ id: "detail", kind: "detail" as const, body: ["mask", "line", "fill"] }],
  },
};
const primitive = (handle: string, kind: string): CadScene["primitives"][number] => ({
  handle,
  kind,
  points: [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 0],
    [20, 20],
    [0, 20],
  ],
  color: [255, 255, 255],
  aci7: false,
  lineweight: 0,
});
const scene: CadScene = {
  revision: 1,
  entityCount: 3,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: ["mask", "line", "fill"].map((handle) => ({
    handle,
    type: handle === "mask" ? "Wipeout" : "Line",
    layer: "0",
    grips: [[0, 0]],
  })),
  primitives: [
    primitive("mask", "mask"),
    primitive("line", "polyline"),
    primitive("fill", "triangles"),
  ],
};

test.each([undefined, "detail"])(
  "selection hides wipeout tessellation without hiding real geometry (inside: %s)",
  (inside) => {
    const { container } = render(
      <svg role="img" aria-label="选择预览">
        <CadSelectionOverlay
          project={project}
          selection={{ scene, handles: ["mask", "line", "fill"] }}
          inside={inside}
        />
      </svg>,
    );
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
    expect(container.querySelector("polyline")?.getAttribute("points")).toContain("20,100");
    const fills = [...container.querySelectorAll('path[stroke="none"]')];
    expect(fills.flatMap(p => p.getAttribute("d")?.match(/Z/g) ?? [])).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(inside ? 2 : 0);
  },
);

test("large selections suppress grips at 101 and restore them at 100 without losing highlight", () => {
  const entities = Array.from({length: 101}, (_, i) => ({ ...scene.entities[1]!, handle: String(i) }));
  const selection = {scene: {...scene, entities, primitives: entities.map(e => primitive(e.handle, "polyline"))}, handles: entities.map(e => e.handle)};
  const {container, rerender} = render(<svg><CadSelectionOverlay project={project} selection={selection}/></svg>);
  expect(container.querySelector(".cad-control-points")).toBeNull();
  expect([...container.querySelectorAll("path")].flatMap(p => p.getAttribute("d")?.match(/M/g) ?? [])).toHaveLength(101);
  rerender(<svg><CadSelectionOverlay project={project} selection={{...selection, handles: selection.handles.slice(0,100)}}/></svg>);
  expect(container.querySelector(".cad-control-points")).not.toBeNull();
  expect(container.querySelectorAll(".cad-control-points circle")).toHaveLength(100);
});
