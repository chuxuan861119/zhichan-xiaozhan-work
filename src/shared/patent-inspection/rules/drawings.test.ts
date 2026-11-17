import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../patent/defaults.js";
import { runPatentInspection } from "../engine.js";
import { DRAWING_RULE_IDS, structuredDrawingRules } from "./drawings.js";

const ID = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

function paragraph(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "paragraph" as const,
    ...extra,
    attrs: {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text" as const, text, marks: [] }],
  };
}

function patentWithDrawingText(bodyText: string, explanations: readonly string[]) {
  const patent = createBlankPatent({ patentType: "invention", name: "附图测试" });
  const figureId = ID(300);
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  description.document.content = [
    paragraph(ID(301), "附图说明"),
    paragraph(ID(302), bodyText),
    ...explanations.map((text, index) => paragraph(ID(303 + index), text)),
  ];
  patent.figures = [{ figureId, assetId: ID(310), widthMm: 80 }];
  return patent;
}

describe("structured drawing consistency rules", () => {
  test("publishes the stable drawing rule ids", () => {
    expect(DRAWING_RULE_IDS).toEqual([
      "core.drawings.missing-figure",
      "core.drawings.duplicate-label",
      "core.drawings.explanation-mismatch",
      "core.drawings.abstract-selection-mismatch",
    ]);
  });

  test("accepts matching body references and one explanation per figure", () => {
    expect(
      runPatentInspection(patentWithDrawingText("如图1所示。", ["图1为结构示意图。"]), [
        ...structuredDrawingRules,
      ]).issues,
    ).toEqual([]);
  });

  test("uses visible drawing explanation text and ignores stale hidden links", () => {
    const patent = patentWithDrawingText("如图1所示。", ["附图1为结构示意图。"]);
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const explanation = description.document.content.find((block) => block.id === ID(303));
    if (explanation?.type !== "paragraph") throw new Error("fixture");
    explanation.semanticRole = "description-drawing-explanation";
    explanation.figureId = ID(399);

    expect(runPatentInspection(patent, [...structuredDrawingRules]).issues).toEqual([]);
  });

  test("reports missing and duplicate figure explanations at structured locations", () => {
    const missing = runPatentInspection(patentWithDrawingText("如图2所示。", []), [
      ...structuredDrawingRules,
    ]).issues;
    expect(missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.drawings.missing-figure",
          locations: [expect.objectContaining({ kind: "book", bookKind: "description" })],
        }),
      ]),
    );

    const duplicate = runPatentInspection(
      patentWithDrawingText("如图1所示。", ["图1为结构示意图。", "图1为另一结构示意图。"]),
      [...structuredDrawingRules],
    ).issues;
    expect(duplicate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.drawings.duplicate-label",
          locations: expect.arrayContaining([
            expect.objectContaining({ kind: "book", bookKind: "description" }),
          ]),
        }),
      ]),
    );
  });

  test("accepts a valid abstract selection without a duplicate image in the book", () => {
    const patent = patentWithDrawingText("如图1所示。", ["图1为结构示意图。"]);
    const figure = patent.figures[0];
    const abstractDrawing = patent.books.find((book) => book.kind === "abstract-drawing");
    if (!figure || !abstractDrawing) throw new Error("fixture");
    patent.abstractDrawingFigureId = figure.figureId;
    abstractDrawing.document.content = [];

    expect(runPatentInspection(patent, [...structuredDrawingRules]).issues).toEqual([]);
  });

  test("explains a deleted abstract selection and navigates to its document", () => {
    const patent = patentWithDrawingText("如图1所示。", ["图1为结构示意图。"]);
    patent.abstractDrawingFigureId = ID(999);
    const issue = runPatentInspection(patent, [...structuredDrawingRules]).issues.find(
      (item) => item.legacyCode === "drawing-abstract-selection-mismatch",
    );
    expect(issue?.summary).toBe("原来选择的摘要附图已不存在，请重新选择。");
    expect(issue?.locations[0]).toMatchObject({ bookKind: "abstract-drawing", targetId: null });
  });

  test("reports explanation order and abstract selection mismatches", () => {
    const mismatchedExplanation = runPatentInspection(
      patentWithDrawingText("如图1所示。", ["图2为结构示意图。"]),
      [...structuredDrawingRules],
    ).issues;
    expect(mismatchedExplanation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "core.drawings.explanation-mismatch" }),
      ]),
    );

    const patent = patentWithDrawingText("如图1所示。", ["图1为结构示意图。"]);
    const figure = patent.figures[0];
    const abstractDrawing = patent.books.find((book) => book.kind === "abstract-drawing");
    if (!figure || !abstractDrawing) throw new Error("fixture");
    patent.abstractDrawingFigureId = figure.figureId;
    abstractDrawing.document.content = [
      {
        id: ID(320),
        type: "figure",
        semanticRole: "abstract-drawing",
        assetId: ID(321),
        widthMm: 80,
        alignment: "center",
      },
    ];
    expect(runPatentInspection(patent, [...structuredDrawingRules]).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "core.drawings.abstract-selection-mismatch" }),
      ]),
    );
    const abstractFigure = abstractDrawing.document.content[0];
    if (abstractFigure?.type !== "figure") throw new Error("fixture");
    abstractFigure.assetId = figure.assetId;
    expect(runPatentInspection(patent, [...structuredDrawingRules]).issues).toEqual([]);
  });
});
