// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadDrawingPipeline } from "./cad-drawing-pipeline";
import { editCadTransaction } from "./cad-edit-transaction";
import type { CadScene } from "./cadcraft-client";

await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
const run = (k: CadcraftSession, c: string, p: object) =>
  JSON.parse(k.execute(c, JSON.stringify(p)));
const scene = (k: CadcraftSession): CadScene => JSON.parse(k.scene());
const spec = { kind: "external", teeth: 20, hole: true, at: [50, 50], size: 20, rotation: 0 };
test("invalid offset is a rejected gesture, not a save failure, and can immediately be corrected",()=>{
  const kernel=new CadcraftSession();
  try{
    const handle=run(kernel,"circle",{center:[0,0],radius:10}).handle as string;
    const before=kernel.export_dxf();
    expect(editCadTransaction(kernel,"offset",{handle,distance:20,side:[0,0]}).rejected).toBeTruthy();
    expect(kernel.export_dxf()).toEqual(before);
    expect(editCadTransaction(kernel,"offset",{handle,distance:2,side:[20,0]}).rejected).toBeUndefined();
    expect(scene(kernel).entities).toHaveLength(2);
    run(kernel,"undo",{});
    expect(scene(kernel).entities).toHaveLength(1);
  }finally{kernel.free();}
});
function fixture() {
  const kernel = new CadcraftSession();
  const handle = run(kernel, "bridge.gear", spec).handle as string;
  const project = drawingProjectFixture(crypto.randomUUID());
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: crypto.randomUUID(),
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1,
    objects: [{ id: "detail", kind: "detail", body: [handle] }],
  };
  project.detailViews = [
    createDetailView(project, { x: 10, y: 10 }, 20, { x: 50, y: 50 }, "A", 2, 8, 1, "detail"),
  ];
  const context = {
    project,
    inside: "detail",
    before: scene(kernel).entities.map((e) => e.handle),
  };
  return { kernel, handle, context };
}

test("meshing rejects an outside follower atomically and can immediately be corrected", () => {
  const { kernel, handle, context } = fixture();
  try {
    const second = run(kernel, "bridge.gear", { ...spec, teeth: 80, at: [55, 50] })
      .handle as string;
    context.project.cad!.objects![0]!.body!.push(second);
    context.before = scene(kernel).entities.map((e) => e.handle);
    const before = kernel.export_dxf();
    expect(
      editCadTransaction(
        kernel,
        "bridge.gear_mesh",
        { handles: [handle, second], enabled: true },
        context,
      ).rejected,
    ).toContain("超出圆形范围");
    expect(kernel.export_dxf()).toEqual(before);
    expect(scene(kernel).entities.every((e) => !e.gearMate)).toBe(true);
    run(kernel, "bridge.gear", { ...spec, handle, size: 8 });
    run(kernel, "bridge.gear", { ...spec, handle: second, size: 8 });
    expect(
      editCadTransaction(
        kernel,
        "bridge.gear_mesh",
        { handles: [handle, second], enabled: true },
        context,
      ).rejected,
    ).toBeUndefined();
    expect(scene(kernel).entities.find((e) => e.handle === handle)?.gearMate).toBe(second);
    run(kernel, "undo", {});
    expect(scene(kernel).entities.every((e) => !e.gearMate)).toBe(true);
  } finally {
    kernel.free();
  }
});

test("a rejected meshed edit leaves the save queue usable even without a detail context", () => {
  const kernel = new CadcraftSession();
  try {
    const a = run(kernel, "bridge.gear", spec).handle as string;
    const b = run(kernel, "bridge.gear", { ...spec, at: [100, 50] }).handle as string;
    run(kernel, "bridge.gear_mesh", { handles: [a, b], enabled: true });
    run(kernel, "layer.set", { name: "0", locked: true });
    const before = kernel.export_dxf();
    expect(
      editCadTransaction(kernel, "rotate", { handles: [a], base: [50, 50], angle: 30 }).rejected,
    ).toContain("锁定图层");
    expect(kernel.export_dxf()).toEqual(before);
    run(kernel, "layer.set", { name: "0", locked: false });
    expect(
      editCadTransaction(kernel, "rotate", { handles: [a], base: [50, 50], angle: 30 }).rejected,
    ).toBeUndefined();
  } finally {
    kernel.free();
  }
});

test("gear size grips share atomic detail boundary guards while teeth and centred rotation remain editable", () => {
  const { kernel, handle, context } = fixture();
  try {
    const before = kernel.export_dxf();
    expect(
      editCadTransaction(kernel, "grip.move", { handle, index: 1, to: [200, 50] }, context)
        .rejected,
    ).toContain("超出圆形范围");
    expect(kernel.export_dxf()).toEqual(before);
    const tooth = scene(kernel).entities[0]!.grips![2]!;
    expect(
      editCadTransaction(
        kernel,
        "grip.move",
        { handle, index: 2, to: [tooth[0] - 2, tooth[1]] },
        context,
      ).rejected,
    ).toBeUndefined();
    expect(scene(kernel).entities[0]?.gear?.teeth).toBe(24);
    expect(
      editCadTransaction(kernel, "grip.move", { handle, index: 3, to: [36, 50] }, context).rejected,
    ).toBeUndefined();
    expect(scene(kernel).entities[0]?.rotation).toBeCloseTo(90);
    expect(scene(kernel).entities[0]?.grips?.[0]).toEqual([50, 50]);
  } finally {
    kernel.free();
  }
});

test("rejects outside detail edits without poisoning saving, and accepts a corrected gear", async () => {
  const { kernel, handle, context } = fixture();
  try {
    const before = kernel.export_dxf();
    let saved = 0;
    const pipeline = new CadDrawingPipeline<number, ReturnType<typeof editCadTransaction>>({
      execute: async (size) =>
        editCadTransaction(kernel, "bridge.gear", { ...spec, handle, size }, context),
      save: async (output) => {
        if (!output.rejected) saved++;
      },
      onPending: () => {},
      onError: () => {},
    });
    pipeline.enqueue(300);
    expect(await pipeline.flush()).toBe(true);
    expect(saved).toBe(0);
    expect(pipeline.pending).toBe(false);
    expect(kernel.export_dxf()).toEqual(before);
    pipeline.enqueue(30);
    expect(await pipeline.flush()).toBe(true);
    expect(saved).toBe(1);
    expect(scene(kernel).entities[0]?.gear?.size).toBeCloseTo(30);
    run(kernel, "undo", {});
    expect(scene(kernel).entities[0]?.gear?.size).toBeCloseTo(20);
    run(kernel, "redo", {});
    expect(scene(kernel).entities[0]?.gear?.size).toBeCloseTo(30);
  } finally {
    kernel.free();
  }
});

test.each(["external", "internal", "rack"])(
  "rejects outside %s creation, retaining all source geometry",
  (kind) => {
    const { kernel, context } = fixture();
    try {
      const before = kernel.export_dxf();
      const result = editCadTransaction(
        kernel,
        "bridge.gear",
        { ...spec, kind, at: [200, 50] },
        context,
      );
      expect(result.rejected).toContain("超出圆形范围");
      expect(kernel.export_dxf()).toEqual(before);
    } finally {
      kernel.free();
    }
  },
);

test("the same boundary guards grip editing, other drawing tools and pasted geometry", () => {
  const { kernel, handle, context } = fixture();
  const source = new CadcraftSession();
  try {
    const before = kernel.export_dxf();
    for (const [command, params] of [
      ["scale", { handles: [handle], base: [50, 50], factor: 20 }],
      [
        "line",
        {
          points: [
            [50, 50],
            [200, 50],
          ],
        },
      ],
      ["move", { handles: [handle], delta: [100, 0] }],
    ] as const) {
      expect(editCadTransaction(kernel, command, params, context).rejected).toContain(
        "超出圆形范围",
      );
      expect(kernel.export_dxf()).toEqual(before);
    }
    const h = run(source, "bridge.gear", spec).handle;
    const clip = {
      project: {
        ...context.project,
        detailViews: [],
        cad: { ...context.project.cad!, objects: [] },
      },
      handles: [h],
    };
    const result = editCadTransaction(
      kernel,
      "bridge.paste",
      { handles: [h], delta: [200, 0] },
      { ...context, clip },
      source.export_dxf(),
    );
    expect(result.rejected).toContain("超出圆形范围");
    expect(kernel.export_dxf()).toEqual(before);
  } finally {
    kernel.free();
    source.free();
  }
});

test("whole detail transforms validate against their transformed frame, not the old circle", () => {
  const { kernel, handle, context } = fixture();
  try {
    const result = editCadTransaction(
      kernel,
      "move",
      { handles: [handle], delta: [200, 0] },
      { ...context, inside: undefined },
    );
    expect(result.rejected).toBeUndefined();
    expect(result.metadata?.detailViews?.[0]?.center).toEqual({ x: 250, y: 50 });
  } finally {
    kernel.free();
  }
});

test("native errors roll back and propagate rather than silently becoming successful saves", () => {
  const { kernel, context } = fixture();
  try {
    const before = kernel.export_dxf();
    expect(() =>
      editCadTransaction(kernel, "bridge.gear", { ...spec, teeth: 2 }, context),
    ).toThrow();
    expect(kernel.export_dxf()).toEqual(before);
    expect(editCadTransaction(kernel, "bridge.gear", spec, context).rejected).toBeUndefined();
  } finally {
    kernel.free();
  }
});
