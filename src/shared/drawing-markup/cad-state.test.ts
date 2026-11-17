import { describe, expect, it } from "vitest";
import { remapAssetIds } from "../document/asset-references.js";
import { createBlankPatent } from "../patent/defaults.js";
import { planDisableDrawingBooks } from "../patent/drawing-books.js";
import { CanonicalPatentSchema } from "../patent/model.js";
import { CadCheckpointSchema, cadToPage, drawingAssetIds, pageToCad } from "./cad-state.js";
import { DrawingProjectSchema } from "./model.js";
import { drawingProjectFixture } from "./test-fixture.js";

const sourceId = "00000000-0000-4000-8000-000000000811";
const checkpointId = "00000000-0000-4000-8000-000000000812";
const frozenId = "00000000-0000-4000-8000-000000000813";
const cad = {
  version: 1 as const,
  assetId: checkpointId,
  engine: "cadcraft" as const,
  engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
  mapping: { originX: -300, originY: 250, scale: 2 },
};

describe("editable CAD checkpoints", () => {
  it("protects current and frozen CAD assets from missing references and removal", () => {
    const asset = (assetId: string) => ({
      assetId,
      kind: "drawing-source" as const,
      originalName: "drawing.dxf",
      mediaType: "image/vnd.dxf" as const,
      extension: "dxf" as const,
      byteLength: 10,
      sha256: "A".repeat(64),
      widthPx: 100,
      heightPx: 100,
      previewByteLength: 10,
      previewSha256: "B".repeat(64),
    });
    const legacy = drawingProjectFixture(sourceId);
    const project = {
      ...legacy,
      cad,
      detailViews: legacy.detailViews!.map((detail) => ({
        ...detail,
        cadSource: { ...cad, assetId: frozenId, baseAssetId: sourceId },
      })),
    };
    const input = {
      ...createBlankPatent({ patentType: "invention", name: null }),
      drawingProjects: [project],
      assets: [sourceId, checkpointId, frozenId].map(asset),
    };
    const patent = CanonicalPatentSchema.parse(input);
    expect(patent.formatVersion).toBe(14);
    expect(CanonicalPatentSchema.safeParse({ ...input, assets: [asset(sourceId)] }).success).toBe(
      false,
    );
    const disabled = planDisableDrawingBooks(patent, {
      now: () => new Date(),
      createId: () => crypto.randomUUID(),
    });
    expect(disabled.assetIdsForPostCommitGarbageCollection).toEqual([]);
  });
  it("round-trips CAD coordinates without changing mapping when geometry bounds change", () => {
    expect(cadToPage({ x: -250, y: 200 }, cad.mapping)).toEqual({ x: 100, y: 100 });
    expect(pageToCad({ x: 100, y: 100 }, cad.mapping)).toEqual({ x: -250, y: 200 });
  });
  it("rejects singular, unbounded and unknown checkpoint formats", () => {
    expect(CadCheckpointSchema.safeParse(cad).success).toBe(true);
    for (const scale of [0, -1, Infinity, NaN, 1e20])
      expect(
        CadCheckpointSchema.safeParse({ ...cad, mapping: { ...cad.mapping, scale } }).success,
      ).toBe(false);
    expect(CadCheckpointSchema.safeParse({ ...cad, version: 2 }).success).toBe(false);
  });
  it("preserves legacy drawings and stores independently frozen detail sources", () => {
    const legacy = drawingProjectFixture(sourceId);
    expect(DrawingProjectSchema.parse(legacy)).toEqual(legacy);
    const project = {
      ...legacy,
      cad,
      detailViews: legacy.detailViews!.map((detail) => ({
        ...detail,
        cadSource: { ...cad, assetId: frozenId, baseAssetId: sourceId },
      })),
    };
    expect(DrawingProjectSchema.parse(project)).toEqual(project);
    expect([...drawingAssetIds(project)].sort()).toEqual([sourceId, checkpointId, frozenId].sort());
    const remapped = remapAssetIds(project, new Map([[checkpointId, frozenId]]));
    expect(remapped.cad.assetId).toBe(frozenId);
    expect(remapped.sourceAssetId).toBe(sourceId);
  });
});
