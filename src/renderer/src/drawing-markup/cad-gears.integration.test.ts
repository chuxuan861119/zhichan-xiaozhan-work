// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { cadObjectGroup } from "../../../shared/drawing-markup/cad-objects";
import { synchronizeCad } from "../../../shared/drawing-markup/cad-unified";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { editCadTransaction } from "./cad-edit-transaction";
import { cadGearSelection } from "./cad-gear-feedback";
import type { CadScene } from "./cadcraft-client";

await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
const font = readFileSync(
  new URL("../../../shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
);
const scene = (k: CadcraftSession): CadScene => JSON.parse(k.scene());
function fixture(detail = true) {
  const kernel = new CadcraftSession(),
    blank = new CadcraftSession();
  kernel.register_font("Source Han Serif CN", font);
  let project: DrawingProject = {
    projectId: crypto.randomUUID(),
    name: "gear integration",
    sourceAssetId: crypto.randomUUID(),
    baseAssetId: crypto.randomUUID(),
    sourceKind: "dxf",
    pageNumber: 1,
    width: 500,
    height: 500,
    regions: [],
    warnings: [],
    revision: 0,
    annotations: [
      {
        id: "label",
        text: "12",
        x: 150,
        y: 140,
        fontSize: 8,
        lineWidth: 1,
        points: [
          { x: 110, y: 110 },
          { x: 150, y: 140 },
        ],
      },
    ],
    cad: {
      version: 1,
      engine: "cadcraft",
      engineVersion: "0".repeat(40),
      assetId: crypto.randomUUID(),
      mapping: { originX: 0, originY: 500, scale: 1 },
      unified: 1,
      objects: [],
    },
  };
  const base = JSON.parse(
    kernel.execute(
      "bridge.gear",
      JSON.stringify({
        kind: "external",
        teeth: 20,
        hole: true,
        at: [100, 400],
        size: 60,
        rotation: 0,
      }),
    ),
  ).handle as string;
  if (detail)
    project.detailViews = [
      createDetailView(project, { x: 100, y: 100 }, 40, { x: 300, y: 100 }, "A", 2, 8, 1, "detail"),
    ];
  function save(next = project) {
    const saved = synchronizeCad(
      kernel,
      blank.export_dxf(),
      next,
      new Map([[next.cad!.assetId, kernel.export_dxf()]]),
      project,
    );
    project = {
      ...next,
      cad: { ...next.cad!, assetId: crypto.randomUUID(), unified: 1, objects: saved.objects },
    };
    kernel.load_dxf(saved.bytes);
    return saved;
  }
  function edit(params: object, inside?: string) {
    const result = editCadTransaction(kernel, "bridge.gear", params, {
      project,
      inside,
      before: scene(kernel).entities.map((e) => e.handle),
    });
    if (!result.rejected) save(result.metadata);
    return result;
  }
  save();
  return {
    kernel,
    base,
    save,
    edit,
    get project() {
      return project;
    },
    close() {
      kernel.free();
      blank.free();
    },
  };
}

test("tooth edits keep the partner, labels and frozen details fixed through real WASM and saved reload", () => {
  const f = fixture();
  try {
    const second = JSON.parse(f.kernel.execute("bridge.gear", JSON.stringify({
      kind: "external", teeth: 30, hole: true, at: [400, 300], size: 60, rotation: 0,
    }))).handle as string;
    f.kernel.execute("bridge.gear_mesh", JSON.stringify({ handles: [f.base, second], enabled: true }));
    f.save();
    const before = scene(f.kernel);
    const base = before.entities.find(e => e.handle === f.base)!;
    const fixed = before.entities.find(e => e.handle === second)!;
    const labels = structuredClone(f.project.annotations);
    const details = structuredClone(f.project.detailViews);
    const body = f.project.cad!.objects!.find(o => o.id === "detail")!.body!;
    const frozen = before.primitives.filter(p => body.includes(p.handle));
    const result = f.edit({ handle: f.base, kind: "external", teeth: 12, hole: true, size: base.gear!.size });
    expect(result.rejected).toBeUndefined();
    for (let i = 0; i < 2; i++) {
      const current = scene(f.kernel);
      expect(current.entities.find(e => e.handle === second)).toEqual(fixed);
      expect(current.entities.find(e => e.handle === f.base)!.gear!.size).toBeCloseTo(base.gear!.size * 14 / 22);
      expect(current.primitives.filter(p => body.includes(p.handle))).toEqual(frozen);
      expect(f.project.annotations).toEqual(labels);
      expect(f.project.detailViews).toEqual(details);
      f.save();
    }
  } finally { f.close(); }
});

test("twenty label saves keep normalized gear block counts and checkpoint size stable", () => {
  const f = fixture(false);
  try {
    let initial: { definitions: number; bytes: number } | undefined;
    for (let i = 0; i <= 20; i++) {
      // Keep glyph outlines constant so size changes measure definitions, not different numerals.
      const { bytes } = f.save({
        ...f.project,
        annotations: f.project.annotations.map((a) => ({ ...a, x: 150 + i })),
      });
      const definitions =
        new TextDecoder().decode(bytes).match(/PatentWorkbenchGear:1:/g)?.length ?? 0;
      initial ??= { definitions, bytes: bytes.byteLength };
      expect(definitions).toBe(initial.definitions);
      expect(bytes.byteLength).toBeLessThan(initial.bytes + 1024);
      expect(scene(f.kernel).entities.filter((e) => e.gear)).toHaveLength(1);
    }
  } finally {
    f.close();
  }
});

test("a dense train previews only its connected component without changing the checkpoint", () => {
  const kernel=new CadcraftSession();
  try {
    const handles:string[]=[];
    for (let i=0;i<8;i++) {
      const handle=JSON.parse(kernel.execute("bridge.gear",JSON.stringify({kind:"external",teeth:120-i*4,hole:true,at:[i*150,0],size:120,rotation:0}))).handle as string;
      if (i) kernel.execute("bridge.gear_mesh",JSON.stringify({handles:[handles[i-1],handle],enabled:true}));
      handles.push(handle);
    }
    kernel.execute("line",JSON.stringify({points:[[0,1000],[100,1000]]}));
    const checkpoint=kernel.export_dxf();
    const current=scene(kernel);
    expect([...cadGearSelection(current,[handles[7]!])].sort()).toEqual([...handles].sort());
    const times:number[]=[];
    for (let i=0;i<32;i++) {
      const start=performance.now();
      const preview:CadScene=JSON.parse(kernel.execute("bridge.preview_modify",JSON.stringify({command:"rotate",params:{handles:[handles[7]],base:current.entities.find(e=>e.handle===handles[7])!.grips![0],angle:i*15},compact:true})));
      times.push(performance.now()-start);
      if (i) expect(preview.entities).toHaveLength(8);
    }
    expect(kernel.export_dxf()).toEqual(checkpoint);
    times.sort((a,b)=>a-b);
    console.info(`8-gear WASM preview p50=${times[16]!.toFixed(2)}ms p95=${times[30]!.toFixed(2)}ms (geometry+JSON, not UI frame latency)`);
  } finally {kernel.free();}
});

test("meshed base gears retain labels, frozen details and their relationship through repeated saves", () => {
  const f = fixture();
  try {
    const labels = structuredClone(f.project.annotations);
    const body = f.project.cad!.objects!.find((o) => o.id === "detail")!.body!;
    const frozen = scene(f.kernel).primitives.filter((p) => body.includes(p.handle));
    const second = JSON.parse(
      f.kernel.execute(
        "bridge.gear",
        JSON.stringify({
          kind: "external",
          teeth: 30,
          hole: true,
          at: [200, 400],
          size: 40,
          rotation: 0,
        }),
      ),
    ).handle as string;
    function edit(command: string, params: object) {
      const result = editCadTransaction(f.kernel, command, params, {
        project: f.project,
        before: scene(f.kernel).entities.map((e) => e.handle),
      });
      expect(result.rejected).toBeUndefined();
      f.save(result.metadata);
    }
    edit("bridge.gear_mesh", { handles: [f.base, second], enabled: true });
    const third=JSON.parse(f.kernel.execute("bridge.gear",JSON.stringify({kind:"external",teeth:16,hole:true,at:[400,400],size:30,rotation:0}))).handle as string;
    const original=scene(f.kernel).entities.filter(e=>[f.base,second].includes(e.handle)).map(e=>e.geometry);
    edit("bridge.gear_mesh",{handles:[third,second],enabled:true});
    expect(scene(f.kernel).entities.filter(e=>[f.base,second].includes(e.handle)).map(e=>e.geometry)).toEqual(original);
    edit("group",{handles:[f.base,second],name:"user-gears"});
    edit("ungroup",{handles:[f.base,second]});
    edit("grip.move", { handle:f.base,index:3,to:[58,400],angle:450 });
    let count: number | undefined;
    for (let i = 0; i < 5; i++) {
      const saved = f.save();
      const definitions =
        new TextDecoder().decode(saved.bytes).match(/PatentWorkbenchGear:1:/g)?.length ?? 0;
      count ??= definitions;
      expect(definitions).toBe(count);
      expect(scene(f.kernel).entities.find((e) => e.handle === f.base)?.gearMate).toBe(second);
      expect(scene(f.kernel).entities.find(e=>e.handle===second)?.gearMates).toEqual([f.base,third]);
      expect(scene(f.kernel).primitives.filter((p) => body.includes(p.handle))).toEqual(frozen);
      expect(f.project.annotations).toEqual(labels);
    }
  } finally {
    f.close();
  }
});

test("cross-drawing full content paste keeps labels and frozen details independent and correctly rebased",()=>{
  const f=fixture();const target=new CadcraftSession(),blank=new CadcraftSession();
  try {
    const original=f.kernel.export_dxf();const originalLabels=structuredClone(f.project.annotations);
    const handles=scene(f.kernel).entities.map(e=>e.handle);
    const destination:DrawingProject={...structuredClone(f.project),projectId:crypto.randomUUID(),annotations:[],detailViews:[],cad:{...f.project.cad!,objects:[],mapping:{originX:-50,originY:600,scale:0.5}}};
    const result=editCadTransaction(target,"bridge.paste",{handles,delta:[100,-50]},{project:destination,before:[],clip:{project:f.project,handles}},original);
    expect(result.rejected).toBeUndefined();
    expect(result.scene?.partial).toBe(true);
    expect(result.metadata?.annotations).toHaveLength(1);
    expect(result.metadata!.annotations[0]!.id).not.toBe(originalLabels[0]!.id);
    expect(result.metadata!.annotations[0]).toMatchObject({text:"12",x:150,y:145,fontSize:4});
    expect(result.metadata!.detailViews).toHaveLength(1);
    expect(result.metadata!.detailViews![0]!.id).not.toBe(f.project.detailViews![0]!.id);
    expect(result.metadata!.detailViews![0]!.center).toEqual({x:225,y:125});
    const next=result.metadata!;
    const saved=synchronizeCad(target,blank.export_dxf(),next,new Map([[next.cad!.assetId,target.export_dxf()]]),destination);
    target.load_dxf(saved.bytes);
    expect(scene(target).entities.some(e=>e.gear)).toBe(true);
    expect(saved.objects.some(o=>o.kind==="label")).toBe(true);
    expect(saved.objects.some(o=>o.kind==="detail"&&!!o.body?.length)).toBe(true);
    expect(f.kernel.export_dxf()).toEqual(original);
    expect(f.project.annotations).toEqual(originalLabels);
  } finally {target.free();blank.free();f.close();}
});

test("gear rejection, frozen detail, independent body edits, resizing, labels and editable exports coexist", () => {
  const f = fixture();
  try {
    const labels = structuredClone(f.project.annotations);
    const detailBody = () =>
      scene(f.kernel).primitives.filter((p) =>
        f.project.cad!.objects!.find((o) => o.id === "detail")!.body!.includes(p.handle),
      );
    const frozen = detailBody();
    f.edit({ handle: f.base, kind: "external", teeth: 32, hole: false, size: 70 });
    expect(detailBody()).toEqual(frozen);
    const added = f.edit(
      { kind: "external", teeth: 16, hole: true, at: [300, 400], size: 30, rotation: 0 },
      "detail",
    );
    expect(added.rejected).toBeUndefined();
    const handle = added.result!.handle as string;
    const before = f.kernel.export_dxf();
    expect(
      f.edit({ handle, kind: "external", teeth: 24, hole: true, size: 300 }, "detail").rejected,
    ).toContain("超出圆形范围");
    expect(f.kernel.export_dxf()).toEqual(before);
    f.edit({ handle, kind: "external", teeth: 24, hole: true, size: 40 }, "detail");
    f.save({ ...f.project, detailViews: f.project.detailViews!.map((d) => ({ ...d, ratio: 3 })) });
    expect(scene(f.kernel).entities.find((e) => e.handle === handle)?.gear?.size).toBeCloseTo(60);
    expect(f.project.annotations).toEqual(labels);
    const codec = fileURLToPath(
      new URL("../../../../resources/cadcraft/cadcraft-codec.exe", import.meta.url),
    );
    // Native DWG is Windows-only here; the same WASM DXF path is exercised on all hosts.
    if (process.platform === "win32") {
      const dwg = execFileSync(codec, ["dxf-to-dwg"], {
        input: f.kernel.export_dxf(),
        windowsHide: true,
        maxBuffer: 30e6,
      });
      expect(dwg.subarray(0, 6).toString()).toBe("AC1032");
      f.kernel.load_dxf(
        execFileSync(codec, ["dwg-to-dxf"], { input: dwg, windowsHide: true, maxBuffer: 30e6 }),
      );
    } else f.kernel.load_dxf(f.kernel.export_dxf());
    expect(
      scene(f.kernel)
        .entities.filter((e) => e.gear)
        .map((e) => e.gear!.teeth)
        .sort(),
    ).toEqual([24, 32]);
    expect(
      scene(f.kernel).groups?.some(
        (g) => g.name === cadObjectGroup({ id: "label", kind: "label", role: "label" }),
      ),
    ).toBe(true);
    expect(f.project.cad!.objects!.find((o) => o.id === "detail")!.body).toContain(handle);
  } finally {
    f.close();
  }
});
