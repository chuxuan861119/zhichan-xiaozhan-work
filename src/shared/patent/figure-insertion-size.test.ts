import { DEFAULT_PAGE_SETTINGS } from "../document/defaults.js";
import type { AssetDescriptor } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import { fitInsertedFigures, insertedFigureWidthMm } from "./figure-insertion-size.js";

const page = { ...DEFAULT_PAGE_SETTINGS, marginLeftMm: 20, marginRightMm: 20 };
test.each([
  [200, 100, 165],
  [100, 100, 165],
  [100, 200, 100],
  [100, 400, 50],
])("fits %i by %i pixels to the existing figure limits", (widthPx, heightPx, expected) => {
  expect(insertedFigureWidthMm(page, { widthPx, heightPx })).toBe(expected);
});

test("uses the actual drawing page margins and leaves 25 mm vertically", () => {
  expect(insertedFigureWidthMm(DEFAULT_PAGE_SETTINGS, { widthPx: 200, heightPx: 100 })).toBe(146.6);
  expect(insertedFigureWidthMm({ ...page, heightMm: 200 }, { widthPx: 100, heightPx: 200 })).toBe(
    62.1,
  );
  expect(insertedFigureWidthMm(page, { widthPx: 200, heightPx: 100 }, 90)).toBe(100);
});

test("height limits also apply to landscape content on short pages without rounding overflow", () => {
  const shortPage = { ...page, heightMm: 140, marginTopMm: 20, marginBottomMm: 20 };
  for (const [widthPx, heightPx] of [[200, 100], [100, 100], [100, 300]] as const) {
    const width = insertedFigureWidthMm(shortPage, { widthPx, heightPx });
    expect(width * heightPx / widthPx).toBeLessThanOrEqual(75);
  }
  expect(insertedFigureWidthMm(page, { widthPx: 100, heightPx: 300 }) * 3).toBeLessThanOrEqual(200);
});

test("fits new and replacement assets but preserves manual sizing and reordering", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const a = { assetId: "a", widthPx: 200, heightPx: 100 } as AssetDescriptor;
  const b = { assetId: "b", widthPx: 100, heightPx: 400 } as AssetDescriptor;
  patent.assets = [a];
  const original = { figureId: "old", assetId: "a", widthMm: 60 };
  patent.figures = [original];
  const resized = { ...original, widthMm: 45 };
  expect(
    fitInsertedFigures(patent, [resized, { figureId: "new", assetId: "b", widthMm: 120 }], [b]),
  ).toEqual([resized, { figureId: "new", assetId: "b", widthMm: 50 }]);
  expect(
    fitInsertedFigures(patent, [{ figureId: "old", assetId: "b", widthMm: 60 }], [b])[0]?.widthMm,
  ).toBe(50);
  expect(
    fitInsertedFigures(patent, [{ figureId: "copy", assetId: "a", widthMm: 60 }, resized], [])[0]
      ?.widthMm,
  ).toBe(146.6);
  expect(patent.figures[0]?.widthMm).toBe(60);
});

test("inserts chemical structures at their natural size and preserves an edited figure's geometry", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const image = {
    assetId: "chemical",
    kind: "chemical-preview",
    widthPx: 300,
    heightPx: 360,
  } as AssetDescriptor;
  const figure = { figureId: "structure", assetId: image.assetId, widthMm: 80 };
  const inserted = fitInsertedFigures(patent, [figure], [image]);
  expect(inserted[0]?.widthMm).toBeCloseTo(25.4, 1);
  patent.figures = [{ ...figure, widthMm: 46, rotationDeg: 90 }];
  patent.assets = [image];
  const replacement = { ...patent.figures[0]!, assetId: "edited" };
  expect(
    fitInsertedFigures(patent, [replacement], [{ ...image, assetId: "edited", widthPx: 500 }])[0],
  ).toEqual(replacement);
});

test("explicit CAD replacement keeps existing widths without changing normal insertion rules", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const image = {
    assetId: "replacement",
    kind: "image",
    widthPx: 300,
    heightPx: 200,
  } as AssetDescriptor;
  const original = { figureId: "original", assetId: "old", widthMm: 90 };
  patent.figures = [original];
  const replacement = { ...original, assetId: image.assetId, rotationDeg: 0 as const };
  expect(fitInsertedFigures(patent, [replacement], [image], true)).toEqual([replacement]);
  expect(fitInsertedFigures(patent, [replacement], [image])[0]?.widthMm).toBe(146.6);
  expect(
    fitInsertedFigures(patent, [{ ...replacement, figureId: "new" }], [image], true)[0]?.widthMm,
  ).toBe(146.6);
});

test("replacement keeps the requested width only while both page dimensions remain valid", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  patent.figures = [{ figureId: "original", assetId: "old", widthMm: 90 }];
  const image = { assetId: "tall", kind: "image", widthPx: 300, heightPx: 1800 } as AssetDescriptor;
  const replacement = { ...patent.figures[0]!, assetId: image.assetId };
  const fitted = fitInsertedFigures(patent, [replacement], [image], true)[0]!;
  expect(fitted.widthMm * image.heightPx / image.widthPx).toBeLessThanOrEqual(200);
  expect(fitted.widthMm).toBeLessThanOrEqual(replacement.widthMm);
  expect(fitInsertedFigures(patent, [{ ...replacement, rotationDeg: 90 }], [image], true)[0]!.widthMm).toBe(90);
});

test("keeps a small flowchart at its requested width and only shrinks oversized ones", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const image = {
    assetId: "flow",
    kind: "flowchart-preview",
    widthPx: 600,
    heightPx: 300,
  } as AssetDescriptor;
  expect(
    fitInsertedFigures(patent, [{ figureId: "new", assetId: "flow", widthMm: 36 }], [image])[0]
      ?.widthMm,
  ).toBe(36);
  expect(
    fitInsertedFigures(patent, [{ figureId: "large", assetId: "flow", widthMm: 165 }], [image])[0]
      ?.widthMm,
  ).toBe(146.6);
});

test("explicit generated-image insertion retains natural width without changing ordinary imports", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const image = {
    assetId: "formula",
    kind: "image",
    widthPx: 300,
    heightPx: 100,
  } as AssetDescriptor;
  const figures = [
    { figureId: "formula", assetId: image.assetId, widthMm: 25.4 },
    { figureId: "large", assetId: image.assetId, widthMm: 165 },
    { figureId: "ordinary", assetId: image.assetId, widthMm: 25.4 },
  ];
  expect(
    fitInsertedFigures(patent, figures, [image], false, ["formula", "large"]).map((f) => f.widthMm),
  ).toEqual([25.4, 146.6, 146.6]);
});
