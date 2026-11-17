import { createBlankPatent } from "../../../shared/patent/defaults";
import { fitInsertedFigures } from "../../../shared/patent/figure-insertion-size";
import { type FormulaDrawingRequest, formulaDrawingFigureWidthMm } from "./formula-drawing-request";

test("replacement previews preserve the existing figure width", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  patent.figures = [{ figureId: "target", assetId: "old", widthMm: 87 }];
  expect(
    formulaDrawingFigureWidthMm(
      patent,
      { kind: "mathematical", latex: "x" },
      { widthPx: 200, heightPx: 100 },
      "target",
    ),
  ).toBe(87);
});

test.each([
  [300, 360],
  [3000, 1000],
  [300, 5000],
])("previews a %i by %i chemical image at its actual inserted width", (widthPx, heightPx) => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const descriptor = {
    assetId: "chemical",
    kind: "chemical-preview",
    widthPx,
    heightPx,
  } as Extract<FormulaDrawingRequest, { kind: "chemical-structure" }>["descriptor"];
  const request = { kind: "chemical-structure", descriptor, png: new Uint8Array() } as const;
  const actual = fitInsertedFigures(
    patent,
    [{ figureId: "new", assetId: "chemical", widthMm: 80 }],
    [descriptor],
  )[0]?.widthMm;
  expect(formulaDrawingFigureWidthMm(patent, request, descriptor)).toBe(actual);
});

test.each(["mathematical", "physics", "chemical-equation"] as const)(
  "%s keeps its 300-DPI natural size instead of filling the page",
  (kind) => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    expect(
      formulaDrawingFigureWidthMm(patent, { kind, latex: "x" }, { widthPx: 300, heightPx: 100 }),
    ).toBe(25.4);
  },
);

test("only shrinks oversized formulas to the drawing page's margins", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const page = patent.books.find((book) => book.kind === "description-drawings")?.document.page;
  if (!page) throw Error("fixture missing drawing page");
  page.marginLeftMm = 40;
  page.marginRightMm = 40;
  expect(
    formulaDrawingFigureWidthMm(
      patent,
      { kind: "mathematical", latex: "x" },
      { widthPx: 2000, heightPx: 100 },
    ),
  ).toBe(130);
});
