import { expect, test } from "vitest";
import { drawingProjectFixture } from "./test-fixture.js";
import { imagePdfPage, isImageDrawing, rotateImageSelection } from "./image-editing.js";

const assetId = "00000000-0000-4000-8000-000000000901";
const legacyCad = {
  version: 1 as const,
  engine: "cadcraft" as const,
  engineVersion: "a".repeat(40),
  assetId,
  mapping: { originX: 0, originY: 800, scale: 1 },
  overlayAssetId: assetId,
  unified: 1 as const,
};
test("routes by source kind, including image work drafts with a legacy CAD overlay", () => {
  const p = drawingProjectFixture(assetId);
  expect(isImageDrawing(p)).toBe(true);
  const legacy = { ...p, cad: legacyCad };
  expect(isImageDrawing(legacy)).toBe(true);
  expect(isImageDrawing({ ...p, sourceKind: "pdf" })).toBe(true);
  expect(isImageDrawing({ ...p, sourceKind: "dwg" })).toBe(false);
  expect(isImageDrawing({ ...p, sourceKind: "dxf" })).toBe(false);
  expect(isImageDrawing(undefined)).toBe(false);
});

test("a PDF page starts independently without inheriting another page's CAD or edits", () => {
  const p = { ...drawingProjectFixture(assetId), sourceKind: "pdf" as const, cad: legacyCad };
  const original = structuredClone(p);
  const page = imagePdfPage(p, 2, 600, 900, assetId);
  expect(page.cad).toBeUndefined();
  expect(page.annotations).toEqual([]);
  expect(page.regions).toEqual([]);
  expect(page.baseFragments).toBeUndefined();
  expect(page.detailViews).toBeUndefined();
  expect(page).toMatchObject({
    sourceAssetId: p.sourceAssetId,
    baseAssetId: p.sourceAssetId,
    sourceKind: "pdf",
    pageNumber: 2,
    width: 600,
    height: 900,
    revision: 0,
  });
  expect(p).toEqual(original);
});

test("image rotation transforms selected pixels and labels without mutating the saved revision", () => {
  const p = drawingProjectFixture(assetId);
  const before = structuredClone(p);
  const region = p.regions[0]!;
  const result = rotateImageSelection(p, region, 90, "turn");
  expect(p).toEqual(before);
  expect(result.annotations[0]).toMatchObject({ x: 400, y: 200 });
  expect(result.annotations[0]!.fontSize).toBe(p.annotations[0]!.fontSize);
  expect(result.baseFragments!.some((f) => f.rotation === 90)).toBe(true);
  expect(result.regions[0]!.kind).toBe("lasso");
  expect(() => rotateImageSelection({ ...p, sourceKind: "dxf" }, region, 90, "turn")).toThrow();
});
