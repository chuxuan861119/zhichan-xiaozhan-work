import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../patent/defaults.js";
import { runPatentInspection } from "../engine.js";
import { numericAndFormulaRules } from "./numeric-and-formula.js";

const ID = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

function patentWithDescription(...texts: readonly string[]) {
  const patent = createBlankPatent({ patentType: "invention", name: "数值测试" });
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  description.document.content = texts.map((text, index) => ({
    id: ID(200 + index),
    type: "paragraph" as const,
    attrs: {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text" as const, text, marks: [] }],
  }));
  return patent;
}

function reportFor(...texts: readonly string[]) {
  return runPatentInspection(patentWithDescription(...texts), numericAndFormulaRules);
}

describe("numeric and formula consistency rules", () => {
  test("accepts ordered inclusive ranges and reports a reversed range", () => {
    expect(reportFor("温度下限为20℃，上限为80℃").issues).toEqual([]);
    expect(reportFor("温度下限为80℃，上限为20℃").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.range-reversed",
          severity: "error",
          confidence: "certain",
        }),
      ]),
    );
    expect(reportFor("温度由80℃降至20℃").issues).toEqual([]);
  });

  test("does not use raw values to reverse ranges with different endpoint units", () => {
    expect(reportFor("长度下限为80mm，上限为20cm").issues).toEqual([]);
    expect(reportFor("长度下限为80cm，上限为20mm").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.range-reversed",
          severity: "error",
          confidence: "certain",
        }),
      ]),
    );
    expect(reportFor("范围下限为80℃，上限为20mm").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.range-reversed",
          severity: "suggestion",
          confidence: "likely",
        }),
      ]),
    );
  });

  test("treats equivalent unit spellings as the same range dimension without conversion", () => {
    expect(reportFor("温度下限为80℃，上限为20°C").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.range-reversed",
          severity: "error",
          confidence: "certain",
        }),
      ]),
    );
  });

  test("uses likely candidates for percentage totals and quantity mappings", () => {
    expect(reportFor("混合物整体包括60%和50%的组分。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.percentage-total",
          confidence: "likely",
        }),
      ]),
    );
    for (const text of [
      "同一个混合物包括60%和50%的组分。",
      "同一批包括60%和50%的组分。",
      "总和为60%和50%。",
    ]) {
      expect(reportFor(text).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "core.numeric.percentage-total",
            confidence: "likely",
          }),
        ]),
      );
    }
    expect(reportFor("第一混合物整体包括60%，第二混合物整体包括50%。").issues).toEqual([]);
    expect(reportFor("装置包括第一组60%的材料和第二组50%的材料。").issues).toEqual([]);
    expect(reportFor("第一装置整体占60%，第二装置整体占50%。").issues).toEqual([]);
    expect(reportFor("第一通道连接第一入口，第二通道连接第二入口。").issues).toEqual([]);
    expect(reportFor("两个入口分别连接两个通道。").issues).toEqual([]);
    expect(reportFor("两个入口分别连接三个通道。").issues).toEqual([]);
    expect(reportFor("两个入口与三个通道一一对应。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.quantity-mapping",
          confidence: "likely",
        }),
      ]),
    );
    expect(reportFor("第一入口分别连接第一、第二和第三通道。").issues).toEqual([]);
  });

  test("compares units by dimension and subranges of the same parameter only", () => {
    expect(reportFor("长度5 mm。", "长度3 kg。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.unit-mismatch",
          confidence: "likely",
        }),
      ]),
    );
    expect(reportFor("父范围温度10℃至20℃。", "子范围温度5℃至15℃。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.subrange-out-of-bounds",
          confidence: "likely",
        }),
      ]),
    );
    expect(
      reportFor("第一实施例中，温度范围为10℃至20℃。第二实施例中，温度范围为5℃至15℃。").issues,
    ).toEqual([]);
    expect(reportFor("温度范围为10℃至20℃，在上述范围内优选为5℃至15℃。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.subrange-out-of-bounds",
          confidence: "likely",
        }),
      ]),
    );
    expect(reportFor("温度范围为10℃至20℃，进一步限定为5℃至15℃。").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.numeric.subrange-out-of-bounds",
          confidence: "likely",
        }),
      ]),
    );
    expect(reportFor("长度范围为10 mm至20 mm。", "温度范围为5℃至15℃。").issues).toEqual([]);
  });

  test("checks mathematical formulas without checking chemical formulas", () => {
    expect(reportFor("计算结果为：", "\\frac{x}{0}").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.formula.literal-zero-denominator",
          severity: "error",
          confidence: "certain",
        }),
      ]),
    );
    expect(reportFor("x=1。", "计算结果为：", "x+y").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.formula.undefined-symbol",
          confidence: "likely",
        }),
      ]),
    );
    expect(reportFor("x=1，x=2。", "计算结果为：", "x+y").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core.formula.duplicate-definition",
          confidence: "likely",
        }),
      ]),
    );
    const crossBook = patentWithDescription("x=1。");
    const claims = crossBook.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("fixture");
    claims.document.content = [
      {
        id: ID(221),
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "x=2。", marks: [] }],
      },
    ];
    expect(runPatentInspection(crossBook, numericAndFormulaRules).issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "core.formula.duplicate-definition" }),
      ]),
    );
    const chemical = patentWithDescription("化学式为：");
    const description = chemical.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push({
      id: ID(220),
      type: "block-formula",
      source: "H_2O/0",
      formulaKind: "chemistry",
    });
    expect(runPatentInspection(chemical, numericAndFormulaRules).issues).toEqual([]);
  });
});

test("does not merge generic range endpoints or unrelated books as one parameter", () => {
  const patent = patentWithDescription(
    "温度下限为80℃，上限为20℃。",
    "宽度下限为20cm，上限为80mm。",
    "深度下限为80mm，上限为20cm。",
  );
  expect(
    runPatentInspection(patent, numericAndFormulaRules).issues.filter(
      (i) => i.legacyCode === "numeric-unit-mismatch",
    ),
  ).toEqual([]);
  patent.books.find((b) => b.kind === "description")!.document.content = patentWithDescription(
    "长度5mm。",
  ).books.find((b) => b.kind === "description")!.document.content;
  patent.books.find((b) => b.kind === "claims")!.document.content = patentWithDescription(
    "长度3kg。",
  ).books.find((b) => b.kind === "description")!.document.content;
  expect(
    runPatentInspection(patent, numericAndFormulaRules).issues.filter(
      (i) => i.legacyCode === "numeric-unit-mismatch",
    ),
  ).toEqual([]);
});
