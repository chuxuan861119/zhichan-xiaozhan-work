import { describe, expect, test } from "vitest";
import { drawingProjectFixture } from "../drawing-markup/test-fixture.js";
import { createBlankPatent } from "../patent/defaults.js";
import { CanonicalPatentSchema, parsePatentWithVerifiedBooks } from "../patent/model.js";
import { AutomationDrawingRenderSchema, applyDrawingOperation } from "./drawings.js";

test("drawing render accepts a validated optional automatic label ratio", () => {
  const input = {
    patentId: "00000000-0000-4000-8000-000000000901",
    expectedRevision: 0,
    projectId: "00000000-0000-4000-8000-000000000902",
    expectedProjectRevision: 0,
    regionId: "all",
  };
  expect(AutomationDrawingRenderSchema.parse(input).autoLabelScale).toBeUndefined();
  for (const ratio of [0.5, 1, 1.5, 2])
    expect(
      AutomationDrawingRenderSchema.parse({ ...input, autoLabelScale: ratio }).autoLabelScale,
    ).toBe(ratio);
  for (const ratio of [0, 0.49, 2.01, Number.NaN, Infinity])
    expect(
      AutomationDrawingRenderSchema.safeParse({ ...input, autoLabelScale: ratio }).success,
    ).toBe(false);
});

function tiledPatent() {
  const sourceId = "00000000-0000-4000-8000-000000000901";
  const tileId = "00000000-0000-4000-8000-000000000902";
  const common = {
    widthPx: 1000,
    heightPx: 800,
    byteLength: 100,
    sha256: "A".repeat(64),
    previewByteLength: 100,
    previewSha256: "A".repeat(64),
  };
  return CanonicalPatentSchema.parse({
    ...createBlankPatent({ patentType: "invention", name: "分块回归" }),
    assets: [
      {
        ...common,
        assetId: sourceId,
        kind: "drawing-source",
        originalName: "source.dwg",
        mediaType: "image/vnd.dwg",
        extension: "dwg",
      },
      {
        ...common,
        assetId: tileId,
        kind: "drawing-tiles",
        originalName: "base.cadtiles",
        mediaType: "application/vnd.zxw.cad-tiles+zip",
        extension: "cadtiles",
      },
    ],
    drawingProjects: [
      { ...drawingProjectFixture(sourceId), sourceKind: "dwg", baseAssetId: tileId },
    ],
  });
}
describe("tiled drawing integration", () => {
  test("incremental refresh retains the same format version as full validation", () => {
    const verified = tiledPatent();
    const input = { ...verified, formatVersion: 12, customer: "刷新" };
    expect(parsePatentWithVerifiedBooks(input, verified)).toEqual(
      CanonicalPatentSchema.parse(input),
    );
    const normal = createBlankPatent({ patentType: "invention", name: null });
    expect(
      parsePatentWithVerifiedBooks({ ...normal, formatVersion: 13 }, normal).formatVersion,
    ).toBe(12);
  });
  test("automation can update and create a tiled DWG project, but cannot use tiles for an image source", () => {
    const patent = tiledPatent();
    const { projectId, revision, ...content } = patent.drawingProjects[0]!;
    applyDrawingOperation(patent, {
      type: "updateDrawingProject",
      projectId,
      expectedProjectRevision: revision,
      project: { ...content, name: "更新" },
    });
    expect(patent.drawingProjects[0]).toMatchObject({ name: "更新", revision: 1 });
    applyDrawingOperation(patent, {
      type: "deleteDrawingProject",
      projectId,
      expectedProjectRevision: 1,
    });
    applyDrawingOperation(patent, { type: "createDrawingProject", project: content });
    expect(CanonicalPatentSchema.parse(patent).drawingProjects).toHaveLength(1);
    expect(() =>
      applyDrawingOperation(patent, {
        type: "createDrawingProject",
        project: { ...content, sourceKind: "image", sourceAssetId: content.baseAssetId },
      }),
    ).toThrow();
  });
});
