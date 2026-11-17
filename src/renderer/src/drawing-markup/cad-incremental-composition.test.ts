// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadIncrementalComposition } from "./cad-incremental-composition";
import { CadJournal } from "./cad-journal";
import { CadDraftCheckpoints } from "./cad-draft-checkpoints";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});

test("saved geometry supersedes a stale replay log during later label synchronization and history restore", async () => {
  const kernel = new CadcraftSession(), reopened = new CadcraftSession();
  try {
    kernel.execute("circle", JSON.stringify({center:[50,50],radius:10}));
    const bytes = kernel.export_dxf();
    const nativeScene = JSON.parse(kernel.scene());
    const project: DrawingProject = {
      ...drawingProjectFixture(crypto.randomUUID()), width:100,height:100,annotations:[],detailViews:[],baseFragments:undefined,
      cad:{version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:crypto.randomUUID(),unified:1,mapping:{originX:0,originY:100,scale:1},objects:[]},
    };
    // The old worker already saved the correct geometry. A replacement solver
    // can no longer replay its old transient object ID; never use that log again.
    const store = new CadDraftCheckpoints(async()=>({cad:{...project.cad!,assetId:crypto.randomUUID()},assets:[],previewId:crypto.randomUUID()}),async()=>bytes);
    const draft = store.stage(project,{source:bytes,edits:[{command:"trim",params:{handle:"NO_LONGER_VALID",pick:[0,0]}}]},nativeScene,[],true);
    await store.resolve(draft);
    const source = store.get(draft.cad!.assetId)?.checkpoint ?? bytes;
    const next = {...draft,annotations:[{...drawingProjectFixture("p").annotations[0]!,id:"label",text:"1"}]};
    const composition = new CadIncrementalComposition(kernel);
    const result = composition.synchronize(next,new Map([[draft.cad!.assetId,source]]),draft);
    expect(result.objects.find(o=>o.id==="label")?.label?.length).toBeGreaterThan(0);
    const journal = new CadJournal(reopened);
    journal.load(result.checkpoint);
    const saved = reopened.export_dxf();
    reopened.load_dxf(saved);
    const scene = JSON.parse(reopened.scene());
    expect(scene.entities.filter((e:{type:string})=>e.type==="Circle")).toHaveLength(1);
    expect(scene.entities.some((e:{text?:string})=>e.text==="1")).toBe(true);
    // Restore the older drawing revision without replaying its obsolete log.
    reopened.load_dxf(bytes);
    expect(JSON.parse(reopened.scene()).entities).toHaveLength(1);
  } finally {kernel.free();reopened.free();}
});

test("successive semantic changes reuse the model without loading, exporting or tessellating unchanged geometry", () => {
  const kernel = new CadcraftSession();
  const source = kernel.export_dxf();
  const load = vi.spyOn(kernel, "load_dxf"),
    fullScene = vi.spyOn(kernel, "scene"),
    exportDxf = vi.spyOn(kernel, "export_dxf");
  const composition = new CadIncrementalComposition(kernel);
  const project = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
    detailViews: [],
    baseFragments: undefined,
    cad: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "a".repeat(40),
      assetId: "00000000-0000-4000-8000-000000000002",
      unified: 1 as const,
      mapping: { originX: 0, originY: 800, scale: 1 },
      objects: [],
    },
  };
  try {
    const first = composition.synchronize(project, new Map([[project.cad.assetId, source]]));
    const before = { ...project, cad: { ...project.cad, objects: first.objects } };
    const next = {
      ...before,
      annotations: [...before.annotations, { ...before.annotations[0]!, id: "new", text: "2" }],
    };
    load.mockClear();
    fullScene.mockClear();
    exportDxf.mockClear();
    const second = composition.synchronize(
      next,
      new Map([[next.cad.assetId, first.checkpoint]]),
      before,
    );
    expect(load).not.toHaveBeenCalled();
    expect(fullScene).not.toHaveBeenCalled();
    expect(exportDxf).not.toHaveBeenCalled();
    expect(second.objects.find((o) => o.id === before.annotations[0]!.id)).toEqual(
      first.objects[0],
    );
    expect(second.objects.find((o) => o.id === "new")?.label?.length).toBeGreaterThan(0);
  } finally {
    kernel.free();
  }
});

test("detail resize, undo branch and exported journal retain body geometry and label bindings", () => {
  const kernel = new CadcraftSession(),
    replay = new CadcraftSession(),
    reopened = new CadcraftSession();
  const composition = new CadIncrementalComposition(kernel);
  try {
    kernel.execute("circle", JSON.stringify({ center: [50, 50], radius: 5 }));
    const source = kernel.export_dxf();
    const project: DrawingProject = {
      ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
      width: 100,
      height: 100,
      annotations: [],
      baseFragments: undefined,
      cad: {
        version: 1,
        engine: "cadcraft",
        engineVersion: "a".repeat(40),
        assetId: "source",
        unified: 1,
        mapping: { originX: 0, originY: 100, scale: 1 },
        objects: [],
      },
    };
    project.detailViews = [
      createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
    ];
    const first = composition.synchronize(project, new Map([["source", source]]));
    const before = { ...project, cad: { ...project.cad!, objects: first.objects } };
    const next = { ...before, detailViews: before.detailViews!.map((d) => ({ ...d, ratio: 3 })) };
    const load = vi.spyOn(kernel, "load_dxf"),
      exportDxf = vi.spyOn(kernel, "export_dxf");
    const second = composition.synchronize(next, new Map([["source", first.checkpoint]]), before);
    expect(load).not.toHaveBeenCalled();
    expect(exportDxf).not.toHaveBeenCalled();
    const body = second.objects.find((o) => o.id === "d")!.body!;
    expect(body).toEqual(first.objects.find((o) => o.id === "d")!.body);
    const diameter = (scene: typeof second.scene) => {
      const xs = scene.primitives
        .filter((p) => body.includes(p.handle) && p.kind !== "mask")
        .flatMap((p) => p.points.map(([x]) => x));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(diameter(second.scene)).toBeCloseTo(30, 1);
    const journal = new CadJournal(replay);
    journal.load(second.checkpoint);
    reopened.load_dxf(replay.export_dxf());
    expect(diameter(JSON.parse(reopened.scene()))).toBeCloseTo(30, 1);
    const native = {
      ...first.checkpoint,
      edits: [
        ...first.checkpoint.edits,
        { command: "scale", params: { handles: body, base: [80, 80], factor: 1.5 } },
      ],
    };
    const nativeResult = composition.synchronize(next, new Map([["source", native]]), before, true);
    expect(diameter(nativeResult.scene)).toBeCloseTo(30, 1);
    // Undo the resize, then take a different branch. No replay of abandoned commands.
    const branch = {
      ...before,
      detailViews: before.detailViews!.map((d) => ({ ...d, label: "B" })),
    };
    const third = composition.synchronize(branch, new Map([["source", first.checkpoint]]), before);
    journal.load(third.checkpoint);
    const restored = JSON.parse(replay.scene());
    expect(diameter(restored)).toBeCloseTo(20, 1);
    expect(restored.entities.some((e: { text?: string }) => e.text === "B")).toBe(true);
    // A genuinely new detail may read an older frozen checkpoint. Keep the
    // safe multi-source path and prove the final journal is still replayable.
    const frozen = createDetailView(
      before,
      { x: 50, y: 50 },
      10,
      { x: 20, y: 80 },
      "C",
      2,
      8,
      1,
      "e",
    );
    const multiBefore = {
      ...branch,
      cad: { ...branch.cad, assetId: "current", objects: third.objects },
    };
    const multiNext = { ...multiBefore, detailViews: [...multiBefore.detailViews!, frozen] };
    const fourth = composition.synchronize(
      multiNext,
      new Map([
        ["current", third.checkpoint],
        ["source", first.checkpoint],
      ]),
      multiBefore,
    );
    expect(fourth.objects.find((o) => o.id === "e")?.body?.length).toBeGreaterThan(0);
    journal.load(fourth.checkpoint);
    expect(JSON.parse(replay.scene()).primitives).toEqual(fourth.scene.primitives);
  } finally {
    kernel.free();
    replay.free();
    reopened.free();
  }
});

test("new native bytes under an existing asset identity are not mistaken for the cached source", () => {
  const kernel = new CadcraftSession(),
    drawing = new CadcraftSession();
  const composition = new CadIncrementalComposition(kernel);
  const project: DrawingProject = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000001"),
    annotations: [],
    detailViews: [],
    baseFragments: undefined,
    cad: {
      version: 1,
      engine: "cadcraft",
      engineVersion: "a".repeat(40),
      assetId: "same",
      unified: 1,
      mapping: { originX: 0, originY: 100, scale: 1 },
      objects: [],
    },
  };
  try {
    composition.synchronize(project, new Map([["same", drawing.export_dxf()]]));
    drawing.execute("circle", JSON.stringify({ center: [20, 20], radius: 5 }));
    const result = composition.synchronize(
      project,
      new Map([["same", drawing.export_dxf()]]),
      project,
      true,
    );
    expect(result.scene.entities.some((e) => e.type === "Circle")).toBe(true);
  } finally {
    kernel.free();
    drawing.free();
  }
});
