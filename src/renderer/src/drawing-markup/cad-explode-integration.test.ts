// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { editCadTransaction } from "./cad-edit-transaction";
import { planCadExplode } from "../../../shared/drawing-markup/cad-explode";
import { synchronizeCad } from "../../../shared/drawing-markup/cad-unified";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { parseDrawingEdit } from "../../../shared/drawing-markup/performance";

await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
it("whole detail explode preserves all geometry and other smart labels through save, reload, undo and redo", () => {
  const kernel = new CadcraftSession(),
    blank = new CadcraftSession();
  try {
    kernel.register_font(
      "Source Han Serif CN",
      readFileSync(
        new URL("../../../shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
      ),
    );
    kernel.execute("rectang", JSON.stringify({ p1: [47, 47], p2: [53, 53] }));
    const project: DrawingProject = {
      projectId: "00000000-0000-4000-8000-000000000801",
      name: "图",
      sourceKind: "dxf",
      pageNumber: 1,
      sourceAssetId: "00000000-0000-4000-8000-000000000901",
      baseAssetId: "00000000-0000-4000-8000-000000000902",
      width: 100,
      height: 100,
      revision: 0,
      regions: [],
      warnings: [],
      annotations: [
        {
          id: "a",
          text: "12",
          x: 20,
          y: 10,
          fontSize: 8,
          lineWidth: 1,
          points: [
            { x: 5, y: 5 },
            { x: 20, y: 10 },
          ],
        },
      ],
      cad: {
        version: 1,
        engine: "cadcraft",
        engineVersion: "0".repeat(40),
        assetId: "00000000-0000-4000-8000-000000000903",
        mapping: { originX: 0, originY: 100, scale: 1 },
      },
    };
    project.detailViews = [
      createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
    ];
    const first = synchronizeCad(
      kernel,
      blank.export_dxf(),
      project,
      new Map([[project.cad!.assetId, kernel.export_dxf()]]),
    );
    const before = parseDrawingEdit({
      ...project,
      cad: { ...project.cad!, unified: 1, objects: first.objects },
    });
    const detail = before.cad!.objects!.find((o) => o.id === "d")!;
    const members = [...(detail.body ?? []), ...(detail.frame ?? []), ...(detail.source ?? [])];
    const plan = planCadExplode(before, [...(detail.body ?? []), ...(detail.frame ?? [])]);
    const edited = editCadTransaction(kernel, "explode", plan, {
      project: before,
      before: first.scene.entities.map((e) => e.handle),
    });
    expect(edited.rejected).toBeUndefined();
    if (edited.rejected) throw Error(edited.rejected);
    expect(edited.result!.detached).toEqual(["d"]);
    const next = parseDrawingEdit(edited.metadata!);
    expect(next.detailViews).toEqual([]);
    expect(next.annotations).toEqual(before.annotations);
    const afterBytes = kernel.export_dxf();
    const saved = synchronizeCad(
      kernel,
      blank.export_dxf(),
      next,
      new Map([[next.cad!.assetId, afterBytes]]),
    );
    const detachedPrimitives = (scene: typeof saved.scene) =>
      scene.primitives.filter((p) => members.includes(p.handle));
    expect(detachedPrimitives(saved.scene)).toEqual(detachedPrimitives(first.scene));
    expect(saved.objects.map((o) => o.id)).toEqual(["a"]);
    expect(saved.scene.groups?.some((g) => g.name.startsWith("PW_DETAIL_"))).toBe(false);
    kernel.load_dxf(saved.bytes);
    const reloaded = JSON.parse(kernel.scene());
    expect(detachedPrimitives(reloaded)).toEqual(detachedPrimitives(saved.scene));
    const checkpoint = {
      ...next,
      cad: {
        ...next.cad!,
        assetId: "00000000-0000-4000-8000-000000000904",
        objects: saved.objects,
      },
    };
    const undo = synchronizeCad(
      kernel,
      blank.export_dxf(),
      before,
      new Map([[before.cad!.assetId, first.bytes]]),
      checkpoint,
    );
    expect(undo.objects.find((o) => o.id === "d")?.body).toEqual(detail.body);
    const restored = undo.objects.find((o) => o.id === "d")!;
    const restoredHandles = [
      ...(restored.body ?? []),
      ...(restored.frame ?? []),
      ...(restored.source ?? []),
    ];
    const appearance = (primitives: typeof first.scene.primitives) =>
      primitives.map(({ handle: _handle, ...p }) => p);
    expect(
      appearance(undo.scene.primitives.filter((p) => restoredHandles.includes(p.handle))),
    ).toEqual(appearance(detachedPrimitives(first.scene)));
    const redo = synchronizeCad(
      kernel,
      blank.export_dxf(),
      checkpoint,
      new Map([[checkpoint.cad!.assetId, saved.bytes]]),
      before,
    );
    expect(redo.objects.map((o) => o.id)).toEqual(["a"]);
    expect(detachedPrimitives(redo.scene)).toEqual(detachedPrimitives(saved.scene));
    expect(kernel.export_patent_svg()).toContain("<svg");
  } finally {
    kernel.free();
    blank.free();
  }
});
