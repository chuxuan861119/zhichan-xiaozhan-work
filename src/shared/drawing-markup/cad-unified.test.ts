// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import init, { CadcraftSession } from "../../../resources/cadcraft/wasm/cadcraft.js";
import { alignSelectedAnnotations } from "./annotation-alignment.js";
import { deleteBase } from "./base-fragments.js";
import { pasteCadMetadata } from "./cad-clipboard.js";
import { planCadExplode } from "./cad-explode.js";
import { applyCadMutation } from "./cad-mutation.js";
import { cadObjectGroup, remapPatentHandles } from "./cad-objects.js";
import { synchronizeCad } from "./cad-unified.js";
import { createDetailView } from "./detail-view.js";
import type { DrawingProject } from "./model.js";

const font = readFileSync(
  new URL("../document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
);
await init({
  module_or_path: readFileSync(
    new URL("../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
const p = (): DrawingProject => ({
  projectId: "00000000-0000-4000-8000-000000000801",
  name: "图",
  sourceAssetId: "00000000-0000-4000-8000-000000000901",
  baseAssetId: "00000000-0000-4000-8000-000000000902",
  sourceKind: "dxf",
  pageNumber: 1,
  width: 100,
  height: 100,
  regions: [],
  warnings: [],
  revision: 0,
  annotations: [
    {
      id: "a",
      text: "12",
      x: 30,
      y: 20,
      fontSize: 10,
      lineWidth: 1,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
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
});
describe("Unified CAD real kernel composition", () => {
  it.each([{ exploded: false, inside: undefined }, { exploded: false, inside: "parent" }, { exploded: true, inside: undefined }])(
    "keeps a cropped nested fill above its masks (exploded=$exploded, inside=$inside)", ({ exploded, inside }) => {
    const kernel = new CadcraftSession(), blank = new CadcraftSession();
    try {
      const project = p(); project.annotations = [];
      project.cad = { ...project.cad!, unified: 1, objects: [] };
      kernel.execute("rectang", JSON.stringify({ p1: [47, 47], p2: [53, 53] }));
      project.detailViews = [createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "parent")];
      const original = kernel.export_dxf();
      const first = synchronizeCad(kernel, blank.export_dxf(), project, new Map([[project.cad!.assetId, original]]));
      const firstId = "00000000-0000-4000-8000-000000000904";
      const live: DrawingProject = { ...project, cad: { ...project.cad!, assetId: firstId, unified: 1, objects: first.objects } };
      const nested = createDetailView(live, { x: 83, y: 20 }, 5, { x: 30, y: 80 }, "B", 3, 8, 1, "nested");
      const candidate = { ...live, detailViews: [...live.detailViews!, nested] };
      const composed = synchronizeCad(kernel, blank.export_dxf(), candidate,
        new Map([[project.cad!.assetId, original], [firstId, first.bytes]]), live);
      let current = { ...candidate, cad: { ...candidate.cad!, objects: composed.objects } };
      const originalBody = new Set(current.cad.objects.find(o => o.id === "nested")!.body);
      if (exploded) {
        const object = current.cad.objects.find(o => o.id === "nested")!;
        const params = planCadExplode(current, [...object.body!, ...object.frame!]);
        const before = JSON.parse(kernel.scene());
        const result = JSON.parse(kernel.execute("explode", JSON.stringify(params)));
        const after = JSON.parse(kernel.scene());
        current = applyCadMutation(current, { command: "explode", params, result,
          before: before.entities.map((e: any) => e.handle), after: after.entities.map((e: any) => e.handle) }, () => "unused") as typeof current;
      }
      const before = JSON.parse(kernel.scene());
      const originalBytes = kernel.export_dxf();
      const params = { points: [[42, 20]], pattern: "ANSI31", scale: 0.5 };
      const preview = JSON.parse(kernel.execute("bridge.preview_modify", JSON.stringify({ command: "hatch", params, compact: true })));
      expect(preview.acceptedPointIndices).toEqual([0]);
      expect(kernel.export_dxf()).toEqual(originalBytes);
      const result = JSON.parse(kernel.execute("hatch", JSON.stringify(params)));
      const after = JSON.parse(kernel.scene());
      const editedBytes = kernel.export_dxf();
      kernel.execute("undo", "{}"); expect(kernel.export_dxf()).toEqual(originalBytes);
      kernel.execute("redo", "{}"); expect(kernel.export_dxf()).toEqual(editedBytes);
      const metadata = applyCadMutation(current, { command: "hatch", params, result,
        before: before.entities.map((e: any) => e.handle), after: after.entities.map((e: any) => e.handle), primitives: after.primitives, inside }, () => "unused");
      if (!exploded) expect(metadata.cad!.objects!.find(o => o.id === "nested")!.body,
        JSON.stringify({ hatches: result.hatches, frame: current.cad!.objects!.find(o => o.id === "nested")!.frame }))
        .toContain(result.handle);
      const saved = synchronizeCad(kernel, blank.export_dxf(), metadata,
        new Map([[firstId, kernel.export_dxf()]]), current);
      expect(saved.scene.primitives.findIndex(p => p.handle === result.handle)).toBeGreaterThan(
        saved.scene.primitives.findLastIndex(p => originalBody.has(p.handle) && p.kind === "mask"));
      kernel.load_dxf(saved.bytes);
      const reopened = JSON.parse(kernel.scene());
      expect(reopened.entities.find((e: any) => e.handle === result.handle).geometry)
        .toMatchObject(after.entities.find((e: any) => e.handle === result.handle).geometry);
      expect(reopened.primitives.findIndex((p: any) => p.handle === result.handle)).toBeGreaterThan(
        reopened.primitives.findLastIndex((p: any) => originalBody.has(p.handle) && p.kind === "mask"));
    } finally { kernel.free(); blank.free(); }
  });
  it.each([
    { exploded: false, outsidePage: false },
    { exploded: true, outsidePage: false },
    { exploded: false, outsidePage: true },
    { exploded: true, outsidePage: true },
  ])("hatches the complete nested detail (exploded=$exploded, outsidePage=$outsidePage)", ({ exploded, outsidePage }) => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      const project = p();
      project.annotations = [];
      project.cad = { ...project.cad!, unified: 1, objects: [] };
      const sourceX = outsidePage ? -50 : 50;
      kernel.execute("rectang", JSON.stringify({ p1: [sourceX - 3, 47], p2: [sourceX + 3, 53] }));
      project.detailViews = [
        createDetailView(project, { x: sourceX, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "parent"),
      ];
      const original = kernel.export_dxf();
      const first = synchronizeCad(kernel, blank.export_dxf(), project,
        new Map([[project.cad!.assetId, original]]));
      const firstId = "00000000-0000-4000-8000-000000000904";
      const live: DrawingProject = {
        ...project,
        cad: { ...project.cad!, assetId: firstId, unified: 1, objects: first.objects },
      };
      const nested = createDetailView(live, { x: 80, y: 20 }, 9, { x: 30, y: 80 }, "B", 3, 8, 1, "nested");
      let candidate = { ...live, detailViews: [...live.detailViews!, nested] };
      const composed = synchronizeCad(kernel, blank.export_dxf(), candidate,
        new Map([[project.cad!.assetId, original], [firstId, first.bytes]]), live);
      candidate = { ...candidate, cad: { ...candidate.cad!, objects: composed.objects } };
      const body = composed.objects.find((o) => o.id === "nested")!;
      if (exploded) {
        const plan = planCadExplode(candidate, [...body.body!, ...body.frame!]);
        expect(plan.details).toHaveLength(1);
        kernel.execute("explode", JSON.stringify(plan));
      }
      const before = kernel.export_dxf();
      const params = { points: [[29, 19]], pattern: "ANSI31", scale: 1 };
      const preview = JSON.parse(kernel.execute("bridge.preview_modify",
        JSON.stringify({ command: "hatch", params, compact: true })));
      expect(preview.acceptedPointIndices).toEqual([0]);
      expect(kernel.export_dxf()).toEqual(before);
      const result = JSON.parse(kernel.execute("hatch", JSON.stringify(params)));
      const scene = JSON.parse(kernel.scene());
      const hatch = scene.entities.find((e: any) => e.handle === result.handle);
      const vertices = hatch.geometry.loops.find((l: any) => l.outer).vertices;
      const points: [number, number][] = vertices.map((v: any) => {
        const point = v.p ?? v;
        return [point[0] ?? point.x, point[1] ?? point.y];
      });
      expect(Math.min(...points.map((v) => v[0]))).toBeCloseTo(12, 4);
      expect(Math.max(...points.map((v) => v[0]))).toBeCloseTo(48, 4);
      expect(Math.min(...points.map((v) => v[1]))).toBeCloseTo(2, 4);
      expect(Math.max(...points.map((v) => v[1]))).toBeCloseTo(38, 4);
      const area = points.reduce((sum, v, i) => {
        const next = points[(i + 1) % points.length]!;
        return sum + v[0] * next[1] - next[0] * v[1];
      }, 0) / 2;
      expect(Math.abs(area)).toBeCloseTo(36 * 36, 4);
      const after = kernel.export_dxf();
      kernel.execute("undo", "{}");
      expect(kernel.export_dxf()).toEqual(before);
      kernel.execute("redo", "{}");
      expect(kernel.export_dxf()).toEqual(after);
      kernel.load_dxf(after);
      expect(JSON.parse(kernel.scene()).entities.find((e: any) => e.handle === result.handle).geometry)
        .toMatchObject(hatch.geometry);
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("uses physical leader weight instead of treating drawing units as pixels, preserving source and overrides", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      const original = p();
      original.width = 2178.519157;
      original.annotations[0]!.lineWidth = 5.446297893;
      kernel.execute("bridge.appearance", JSON.stringify({ lineweight: 0.8 }));
      const line = JSON.parse(
        kernel.execute(
          "line",
          JSON.stringify({
            points: [
              [0, 0],
              [10, 0],
            ],
          }),
        ),
      ).handles[0];
      const first = synchronizeCad(
        kernel,
        blank.export_dxf(),
        original,
        new Map([[original.cad!.assetId, kernel.export_dxf()]]),
      );
      const read = () => JSON.parse(kernel.scene()).entities;
      const label = first.objects.find((o) => o.kind === "label")!;
      expect(read().find((e: any) => e.handle === label.label![0]).appearance.lineweight).toBe(0.3);
      expect(read().find((e: any) => e.handle === line).appearance.lineweight).toBe(0.8);
      const next = {
        ...original,
        cad: { ...original.cad!, unified: 1 as const, objects: first.objects },
      };
      next.cad.objects.find((o) => o.kind === "label")!.appearance = {
        label: { color: "#123456", lineweight: 0.7, linetype: "DASHED", lineWidthAtEdit: original.annotations[0]!.lineWidth },
      };
      next.annotations[0]!.lineWidth *= 2;
      const second = synchronizeCad(
        kernel,
        blank.export_dxf(),
        next,
        new Map([[next.cad.assetId, first.bytes]]),
      );
      const secondLabel = second.objects.find((o) => o.kind === "label")!;
      expect(read().find((e: any) => e.handle === secondLabel.label![0]).appearance).toEqual({
        color: "#123456",
        lineweight: 0.7,
        linetype: "DASHED",
      });
      expect(read().find((e: any) => e.handle === line).appearance.lineweight).toBe(0.8);
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("exports aligned native label text once at the new coordinates and preserves leader anchors", () => {
    const kernel = new CadcraftSession(), blank = new CadcraftSession();
    try {
      const original = p();
      kernel.execute("line", JSON.stringify({ points: [[0, 0], [100, 100]] }));
      original.annotations.push({
        ...original.annotations[0]!, id: "b", text: "13", x: 70, y: 40,
        points: [{ x: 80, y: 80 }, { x: 70, y: 40 }],
      });
      const initial = synchronizeCad(kernel, blank.export_dxf(), original,
        new Map([[original.cad!.assetId, kernel.export_dxf()]]));
      const previous = {
        ...original,
        cad: { ...original.cad!, unified: 1 as const, objects: initial.objects },
      };
      const horizontal = {
        ...previous,
        annotations: [...alignSelectedAnnotations(previous.annotations, new Set(["a", "b"]), "horizontal", {
          left: 0, top: 0, right: previous.width, bottom: previous.height,
        })!],
      };
      expect(horizontal.annotations[0]!.y).toBe(horizontal.annotations[1]!.y);
      expect(horizontal.annotations.map((a) => a.points[0])).toEqual(
        previous.annotations.map((a) => a.points[0]),
      );
      const saved = synchronizeCad(kernel, blank.export_dxf(), horizontal,
        new Map([[horizontal.cad.assetId, initial.bytes]]), previous);
      const reopened = new CadcraftSession();
      try {
        reopened.register_font("Source Han Serif CN", font);
        reopened.load_dxf(saved.bytes);
        const text = JSON.parse(reopened.scene()).entities.filter((entity: { type: string }) =>
          entity.type === "Text",
        ) as { handle: string; text: string; textOrigin: [number, number] }[];
        expect(text).toHaveLength(2);
        expect(text.map((entity) => entity.text).sort()).toEqual(["12", "13"]);
        expect(text[0]!.textOrigin[1]).toBeCloseTo(text[1]!.textOrigin[1], 4);
        expect(saved.objects.filter((object) => object.kind === "label")
          .flatMap((object) => object.label ?? []).filter((handle) =>
            text.some((entity) => entity.handle === handle),
          )).toHaveLength(2);
        expect(text.every((entity) => saved.scene.primitives.some((primitive) =>
          primitive.handle === entity.handle,
        ))).toBe(true);
        // Patent-preview strips native label proxies; the raster composer adds them once.
        expect(reopened.export_patent_svg()).not.toContain("12");
        const horizontalSaved = {
          ...horizontal, cad: { ...horizontal.cad, objects: saved.objects },
        };
        const vertical = {
          ...horizontalSaved,
          annotations: [...alignSelectedAnnotations(horizontalSaved.annotations, new Set(["a", "b"]), "vertical", {
            left: 0, top: 0, right: horizontalSaved.width, bottom: horizontalSaved.height,
          })!],
        };
        const next = synchronizeCad(kernel, blank.export_dxf(), vertical,
          new Map([[vertical.cad.assetId, saved.bytes]]), horizontalSaved);
        reopened.load_dxf(next.bytes);
        const verticalText = JSON.parse(reopened.scene()).entities.filter((entity: { type: string }) =>
          entity.type === "Text",
        ) as { handle: string; geometry: { insert: { x: number } } }[];
        expect(verticalText).toHaveLength(2);
        expect(verticalText[0]!.geometry.insert.x).toBeCloseTo(verticalText[1]!.geometry.insert.x, 4);
        expect(verticalText.some((entity) => text.some((old) => old.handle === entity.handle))).toBe(false);
      } finally { reopened.free(); }
    } finally { kernel.free(); blank.free(); }
  });
  it("edits and deletes a native patent label without leaving old text or leader entities", () => {
    const kernel = new CadcraftSession(), blank = new CadcraftSession();
    try {
      const original = p();
      const first = synchronizeCad(kernel, blank.export_dxf(), original,
        new Map([[original.cad!.assetId, kernel.export_dxf()]]));
      const initialHandles = first.objects.find((o) => o.id === "a")!.label!;
      expect(initialHandles).toHaveLength(2);
      const previous = { ...original, cad: { ...original.cad!, unified: 1 as const, objects: first.objects } };
      const changed = { ...previous, annotations: [{ ...previous.annotations[0]!, text: "13", x: 45 }] };
      const second = synchronizeCad(kernel, blank.export_dxf(), changed,
        new Map([[changed.cad.assetId, first.bytes]]), previous);
      const updatedHandles = second.objects.find((o) => o.id === "a")!.label!;
      expect(updatedHandles).toHaveLength(2);
      expect(updatedHandles.some((handle) => initialHandles.includes(handle))).toBe(false);
      expect(second.scene.entities.some((entity) => initialHandles.includes(entity.handle))).toBe(false);
      const edited = { ...changed, cad: { ...changed.cad, objects: second.objects } };
      const deleted = { ...edited, annotations: [] };
      const third = synchronizeCad(kernel, blank.export_dxf(), deleted,
        new Map([[deleted.cad.assetId, second.bytes]]), edited);
      expect(third.objects.some((object) => object.id === "a")).toBe(false);
      expect(third.scene.entities.some((entity) => updatedHandles.includes(entity.handle))).toBe(false);
      kernel.load_dxf(third.bytes);
      expect(JSON.parse(kernel.scene()).entities.filter((entity: { type: string }) => entity.type === "Text")).toHaveLength(0);
    } finally { kernel.free(); blank.free(); }
  });
  it("adding one label preserves existing label and detail handles", () => {
    const kernel = new CadcraftSession(), blank = new CadcraftSession();
    try {
      const original = p();
      kernel.execute("circle", JSON.stringify({ center: [50, 50], radius: 5 }));
      original.detailViews = [createDetailView(original, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d")];
      const first = synchronizeCad(kernel, blank.export_dxf(), original,
        new Map([[original.cad!.assetId, kernel.export_dxf()]]));
      const previous = { ...original, cad: { ...original.cad!, unified: 1 as const, objects: first.objects } };
      const next = { ...previous, annotations: [...previous.annotations, { ...previous.annotations[0]!, id: "b", text: "13", x: 40 }] };
      const second = synchronizeCad(kernel, blank.export_dxf(), next,
        new Map([[next.cad.assetId, first.bytes]]), previous);
      expect(second.objects.find(o => o.id === "a")).toEqual(first.objects.find(o => o.id === "a"));
      expect(second.objects.find(o => o.id === "d")).toEqual(first.objects.find(o => o.id === "d"));
      expect(second.objects.find(o => o.id === "b")?.label?.length).toBeGreaterThan(0);
      kernel.load_dxf(second.bytes);
      expect(JSON.parse(kernel.scene()).entities.filter((e: { type: string }) => e.type === "Text").length).toBe(5);
    } finally { kernel.free(); blank.free(); }
  });
  it("retains label and detail-frame properties through regeneration and DXF reopening", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      const original = p();
      kernel.execute("circle", JSON.stringify({ center: [50, 50], radius: 5 }));
      original.detailViews = [
        createDetailView(original, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
      ];
      const first = synchronizeCad(
        kernel,
        blank.export_dxf(),
        original,
        new Map([[original.cad!.assetId, kernel.export_dxf()]]),
      );
      let project = {
        ...original,
        cad: { ...original.cad!, unified: 1 as const, objects: first.objects },
      };
      const handles = first.objects.flatMap((o) => [...(o.label ?? []), ...(o.frame ?? [])]);
      const before = JSON.parse(kernel.scene()).entities.map((e: { handle: string }) => e.handle);
      const params = { handles, color: "#123456", lineweight: 0.7, linetype: "DASHED" };
      kernel.execute("bridge.appearance", JSON.stringify(params));
      project = applyCadMutation(
        project,
        { command: "bridge.appearance", params, result: {}, before, after: before },
        () => "unused",
      ) as typeof project;
      const previous = structuredClone(project);
      project.detailViews![0]!.center.x += 5;
      const second = synchronizeCad(
        kernel,
        blank.export_dxf(),
        project,
        new Map([[project.cad.assetId, kernel.export_dxf()]]),
        previous,
      );
      kernel.load_dxf(second.bytes);
      const sc = JSON.parse(kernel.scene());
      const styled = new Set(
        second.objects.flatMap((o) => [...(o.label ?? []), ...(o.frame ?? [])]),
      );
      expect(
        sc.entities
          .filter((e: { handle: string }) => styled.has(e.handle))
          .every(
            (e: { appearance: unknown }) =>
              JSON.stringify(e.appearance) ===
              JSON.stringify({ color: "#123456", linetype: "DASHED", lineweight: 0.7 }),
          ),
      ).toBe(true);
      expect(second.objects.find((o) => o.kind === "label")?.appearance?.label?.color).toBe(
        "#123456",
      );
      expect(second.objects.find((o) => o.kind === "detail")?.appearance?.source).toBeUndefined();
      expect(original.cad!.objects).toBeUndefined();
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("preserves drawing defaults while regenerating patent labels and details", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      const project = p();
      kernel.execute(
        "bridge.appearance",
        JSON.stringify({ color: "#123456", lineweight: 0.7, linetype: "DASHED" }),
      );
      kernel.execute("circle", JSON.stringify({ center: [50, 50], radius: 5 }));
      const before = JSON.parse(kernel.scene()).appearance;
      project.detailViews = [
        createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
      ];
      const result = synchronizeCad(
        kernel,
        blank.export_dxf(),
        project,
        new Map([[project.cad!.assetId, kernel.export_dxf()]]),
      );
      expect(JSON.parse(kernel.scene()).appearance).toEqual(before);
      kernel.load_dxf(result.bytes);
      expect(JSON.parse(kernel.scene()).appearance).toEqual(before);
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it.each(["ANSI31", "SOLID", "legacy", "legacy-resize"])(
    "keeps %s detail fill above its mask through save and resize",
    (variant) => {
      const kernel = new CadcraftSession(),
        blank = new CadcraftSession();
      try {
        const project = p();
        project.annotations = [];
        kernel.execute("rectang", JSON.stringify({ p1: [47, 47], p2: [53, 53] }));
        project.detailViews = [
          createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
        ];
        const first = synchronizeCad(
          kernel,
          blank.export_dxf(),
          project,
          new Map([[project.cad!.assetId, kernel.export_dxf()]]),
        );
        const live = {
          ...project,
          cad: { ...project.cad!, unified: 1 as const, objects: first.objects },
        };
        kernel.load_dxf(first.bytes);
        const before = JSON.parse(kernel.scene());
        const params = {
          points: [[80, 80]],
          pattern: variant === "SOLID" ? "SOLID" : "ANSI31",
          scale: 0.5,
        };
        const result = JSON.parse(kernel.execute("hatch", JSON.stringify(params)));
        const after = JSON.parse(kernel.scene());
        const metadata = variant.startsWith("legacy")
          ? live
          : applyCadMutation(
              live,
              {
                command: "hatch",
                params,
                result,
                before: before.entities.map((e: { handle: string }) => e.handle),
                after: after.entities.map((e: { handle: string }) => e.handle),
              },
              () => "unused",
            );
        const candidate =
          variant === "legacy-resize"
            ? { ...metadata, detailViews: metadata.detailViews!.map((d) => ({ ...d, ratio: 3 })) }
            : metadata;
        const saved = synchronizeCad(
          kernel,
          blank.export_dxf(),
          candidate,
          new Map([[live.cad.assetId, kernel.export_dxf()]]),
          variant === "legacy-resize" ? live : undefined,
        );
        if (variant === "legacy-resize")
          expect(
            Math.max(
              ...saved.scene.primitives
                .filter((p) => p.handle === result.handle)
                .flatMap((p) => p.points.map(([x]) => x)),
            ),
          ).toBeGreaterThan(86);
        expect(saved.objects.find((o) => o.id === "d")!.body).toContain(result.handle);
        const mask = saved.scene.primitives.find((p) => p.kind === "mask")!;
        expect(saved.scene.primitives.findIndex((p) => p.handle === result.handle)).toBeGreaterThan(
          saved.scene.primitives.findLastIndex((p) => p.handle === mask.handle),
        );
        kernel.load_dxf(saved.bytes);
        const reopened = JSON.parse(kernel.scene());
        expect(
          reopened.primitives.findIndex((p: { handle: string }) => p.handle === result.handle),
        ).toBeGreaterThan(
          reopened.primitives.findLastIndex((p: { handle: string }) => p.handle === mask.handle),
        );
        const old = { ...candidate, cad: { ...candidate.cad!, objects: saved.objects } };
        const resized = { ...old, detailViews: old.detailViews!.map((d) => ({ ...d, ratio: 4 })) };
        const next = synchronizeCad(
          kernel,
          blank.export_dxf(),
          resized,
          new Map([[live.cad.assetId, saved.bytes]]),
          old,
        );
        expect(next.objects.find((o) => o.id === "d")!.body).toContain(result.handle);
        const hatch = next.scene.primitives.filter((p) => p.handle === result.handle);
        expect(Math.max(...hatch.flatMap((p) => p.points.map(([x]) => x)))).toBeGreaterThan(86);
      } finally {
        kernel.free();
        blank.free();
      }
    },
  );
  it("resizes materialized detail geometry without parsing frozen originals or reparsing the live checkpoint", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      const project = p();
      kernel.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 50],
            [100, 50],
          ],
        }),
      );
      project.detailViews = [
        createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
      ];
      const first = synchronizeCad(
        kernel,
        blank.export_dxf(),
        project,
        new Map([[project.cad!.assetId, kernel.export_dxf()]]),
      );
      const frozenId = project.cad!.assetId;
      const old = {
        ...project,
        cad: {
          ...project.cad!,
          assetId: "00000000-0000-4000-8000-000000000999",
          unified: 1 as const,
          objects: first.objects,
        },
      };
      const calls: Uint8Array[] = [],
        commands: string[] = [];
      let renders = 0;
      const traced = {
        load_dxf(bytes: Uint8Array) {
          calls.push(bytes);
          kernel.load_dxf(bytes);
        },
        scene: () => {
          renders++;
          return kernel.scene();
        },
        export_dxf: () => kernel.export_dxf(),
        execute(command: string, params: string) {
          commands.push(command === "ungroup" ? `${command}:${JSON.parse(params).name}` : command);
          return kernel.execute(command, params);
        },
      };
      const resized = { ...old, detailViews: old.detailViews!.map((d) => ({ ...d, ratio: 3 })) };
      const second = synchronizeCad(
        traced,
        blank.export_dxf(),
        resized,
        new Map([
          [old.cad.assetId, first.bytes],
          [frozenId, first.bytes],
        ]),
        old,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(first.bytes);
      expect(renders).toBe(1);
      expect(commands).not.toContain(
        `ungroup:${cadObjectGroup({ id: "d", kind: "detail", role: "body" })}`,
      );
      expect(second.objects.find((o) => o.id === "d")?.body).toEqual(
        first.objects.find((o) => o.id === "d")?.body,
      );
      const body = new Set(second.objects.find((o) => o.id === "d")?.body);
      expect(second.scene.primitives.filter((p) => body.has(p.handle)).length).toBeGreaterThan(0);
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("transforms an edited detail once and restores undo/redo checkpoints without transforming them again", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      kernel.register_font("Source Han Serif CN", font);
      kernel.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 50],
            [100, 50],
          ],
        }),
      );
      const project = p();
      project.detailViews = [
        createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
      ];
      const first = synchronizeCad(
        kernel,
        blank.export_dxf(),
        project,
        new Map([[project.cad!.assetId, kernel.export_dxf()]]),
      );
      const old = {
        ...project,
        cad: { ...project.cad!, unified: 1 as const, objects: first.objects },
      };
      const changed = {
        ...old,
        detailViews: old.detailViews!.map((d) => ({ ...d, ratio: 3, center: { x: 50, y: 80 } })),
      };
      const second = synchronizeCad(
        kernel,
        blank.export_dxf(),
        changed,
        new Map([[old.cad.assetId, first.bytes]]),
        old,
      );
      const body = new Set(first.objects.find((o) => o.id === "d")!.body);
      const oldBody = first.scene.primitives.filter((e) => body.has(e.handle));
      const newBody = second.scene.primitives.filter((e) => body.has(e.handle));
      const rounded = (primitives: typeof newBody) =>
        primitives.map((p) => ({
          ...p,
          points: p.points.map((point) => point.map((n) => Number(n.toFixed(8)))),
        }));
      expect(newBody.length).toBeGreaterThan(0);
      for (let i = 0; i < oldBody.length; i++)
        for (let j = 0; j < oldBody[i]!.points.length; j++) {
          const [x, y] = oldBody[i]!.points[j]!;
          expect(newBody[i]!.points[j]![0]).toBeCloseTo(80 + (x - 80) * 1.5 - 30, 5);
          expect(newBody[i]!.points[j]![1]).toBeCloseTo(80 + (y - 80) * 1.5 - 60, 5);
        }
      const next = {
        ...changed,
        cad: {
          ...changed.cad,
          assetId: "00000000-0000-4000-8000-000000000904",
          objects: second.objects,
        },
      };
      const undo = synchronizeCad(
        kernel,
        blank.export_dxf(),
        old,
        new Map([[old.cad.assetId, first.bytes]]),
        next,
      );
      expect(rounded(undo.scene.primitives.filter((e) => body.has(e.handle)))).toEqual(
        rounded(oldBody),
      );
      const redo = synchronizeCad(
        kernel,
        blank.export_dxf(),
        next,
        new Map([[next.cad.assetId, second.bytes]]),
        old,
      );
      expect(rounded(redo.scene.primitives.filter((e) => body.has(e.handle)))).toEqual(
        rounded(newBody),
      );
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("pastes frozen mixed geometry after its original label is deleted, without duplicate proxy text", () => {
    const kernel = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      kernel.register_font("Source Han Serif CN", font);
      kernel.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 50],
            [100, 50],
          ],
        }),
      );
      const project = p();
      const first = synchronizeCad(
        kernel,
        blank.export_dxf(),
        project,
        new Map([[project.cad!.assetId, kernel.export_dxf()]]),
      );
      const source = {
        ...project,
        cad: { ...project.cad!, unified: 1 as const, objects: first.objects },
      };
      const captured = first.scene.entities.map((e) => e.handle);
      kernel.execute("erase", JSON.stringify({ handles: first.objects[0]!.label }));
      const target = { ...source, annotations: [], cad: { ...source.cad, objects: [] } };
      const before = JSON.parse(kernel.scene()).entities.map((e: { handle: string }) => e.handle);
      const pasted = JSON.parse(
        kernel.paste_dxf(first.bytes, JSON.stringify({ handles: captured, delta: [10, 0] })),
      );
      const after = JSON.parse(kernel.scene()).entities.map((e: { handle: string }) => e.handle);
      const metadata = pasteCadMetadata(
        target,
        source,
        captured,
        pasted.handles,
        [10, 0],
        before,
        after,
        () => "copy",
      );
      expect(metadata.annotations).toHaveLength(1);
      expect(metadata.annotations[0]).toMatchObject({ id: "copy", text: "12", x: 40, y: 20 });
      const result = synchronizeCad(
        kernel,
        blank.export_dxf(),
        metadata,
        new Map([[metadata.cad!.assetId, kernel.export_dxf()]]),
      );
      expect(result.scene.entities).toHaveLength(4);
      const oldHandles = metadata.cad!.objects![0]!.label!;
      expect(result.objects[0]!.label!.length).toBe(2);
      const selection = remapPatentHandles(
        metadata.cad!.objects!,
        result.objects,
        oldHandles,
        new Set(result.scene.entities.map((e) => e.handle)),
      );
      expect(selection).toEqual(result.objects[0]!.label);
      expect(oldHandles.some((h) => selection.includes(h))).toBe(false);
    } finally {
      kernel.free();
      blank.free();
    }
  });
  it("migrates legacy numbers and details, is idempotent, and retains internal edits through proxy regeneration", () => {
    const source = new CadcraftSession(),
      output = new CadcraftSession(),
      blank = new CadcraftSession();
    try {
      output.register_font("Source Han Serif CN", font);
      source.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 50],
            [100, 50],
          ],
        }),
      );
      const project = p();
      project.detailViews = [
        createDetailView(project, { x: 50, y: 50 }, 10, { x: 80, y: 20 }, "A", 2, 8, 1, "d"),
      ];
      const sourceBytes = source.export_dxf();
      const first = synchronizeCad(
        output,
        blank.export_dxf(),
        project,
        new Map([[project.cad!.assetId, sourceBytes]]),
      );
      expect(first.objects.find((o) => o.id === "a")!.label!.length).toBe(2);
      const body = first.objects.find((o) => o.id === "d")!.body!;
      expect(body.length).toBeGreaterThan(1);
      const unified = {
        ...project,
        cad: { ...project.cad!, unified: 1 as const, objects: first.objects },
      };
      const second = synchronizeCad(
        output,
        blank.export_dxf(),
        unified,
        new Map([[project.cad!.assetId, first.bytes]]),
      );
      expect(second.scene.entities.length).toBe(first.scene.entities.length);
      expect(second.objects.find((o) => o.id === "d")!.body).toEqual(body);
      output.load_dxf(second.bytes);
      output.execute(
        "scale",
        JSON.stringify({ handles: [body.at(-1)], base: [80, 80], factor: 0.5 }),
      );
      const moved = JSON.parse(output.scene()).entities.find(
        (e: { handle: string }) => e.handle === body.at(-1),
      ).grips;
      const third = synchronizeCad(
        output,
        blank.export_dxf(),
        { ...unified, cad: { ...unified.cad, objects: second.objects } },
        new Map([[project.cad!.assetId, output.export_dxf()]]),
      );
      expect(third.scene.entities.find((e) => e.handle === body.at(-1))).toMatchObject({
        grips: moved,
      });
      const stable = { ...unified, cad: { ...unified.cad, objects: third.objects } };
      const cropped = {
        ...stable,
        baseFragments: deleteBase(stable, [
          { x: 0, y: 40 },
          { x: 30, y: 40 },
          { x: 30, y: 60 },
          { x: 0, y: 60 },
        ]),
      };
      const cropResult = synchronizeCad(
        output,
        blank.export_dxf(),
        cropped,
        new Map([[project.cad!.assetId, third.bytes]]),
        stable,
      );
      expect(cropResult.objects.find((o) => o.id === "d")!.body!.length).toBeGreaterThan(0);
      const sourceHandles = third.objects.find((o) => o.id === "d")!.source!;
      output.load_dxf(third.bytes);
      output.execute("erase", JSON.stringify({ handles: sourceHandles }));
      const erasedScene = JSON.parse(output.scene());
      const hidden = applyCadMutation(
        stable,
        {
          command: "erase",
          params: { handles: sourceHandles },
          result: {},
          before: third.scene.entities.map((e) => e.handle),
          after: erasedScene.entities.map((e: { handle: string }) => e.handle),
        },
        () => "copy",
      );
      const hiddenResult = synchronizeCad(
        output,
        blank.export_dxf(),
        hidden,
        new Map([[project.cad!.assetId, output.export_dxf()]]),
      );
      expect(hiddenResult.objects.find((o) => o.id === "d")!.source).toBeUndefined();
      expect(hidden.detailViews![0]!.markerHidden).toBe(true);
      const deleted = {
        ...unified,
        annotations: [],
        detailViews: [],
        cad: { ...unified.cad, objects: third.objects },
      };
      const fourth = synchronizeCad(
        output,
        blank.export_dxf(),
        deleted,
        new Map([[project.cad!.assetId, third.bytes]]),
      );
      expect(fourth.scene.entities.length).toBe(1);
      expect(fourth.objects).toEqual([]);
    } finally {
      source.free();
      output.free();
      blank.free();
    }
  });
});
