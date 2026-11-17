import { describe, expect, test } from "vitest";
import type { ParagraphNode } from "../document/model.js";
import { createBlankPatent } from "../patent/defaults.js";
import type { CanonicalPatent, PatentBookKind } from "../patent/model.js";
import { inspectPatent } from "../patent/validation.js";

function paragraph(text: string): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    },
    content: [{ type: "text", text, marks: [] }],
  };
}
function setBook(patent: CanonicalPatent, kind: PatentBookKind, texts: string[]) {
  const book = patent.books.find((item) => item.kind === kind);
  if (!book) throw new Error("fixture");
  book.document.content = texts.map(paragraph);
}
function sample() {
  const patent = createBlankPatent({ name: "一种装置", patentType: "invention" });
  setBook(patent, "description", [
    "技术领域",
    "本发明涉及一种装置。",
    "背景技术",
    "已有装置存在不足。",
    "发明内容",
    "本发明提供一种装置。",
    "具体实施方式",
    "装置包括壳体。",
  ]);
  setBook(patent, "claims", ["1. 一种装置，包括壳体。"]);
  setBook(patent, "abstract", ["本发明公开一种装置。"]);
  patent.drawingBooksEnabled = false;
  return patent;
}
function findings(text: string, code: string) {
  const patent = sample();
  setBook(patent, "description", [text]);
  return inspectPatent(patent).issues.filter((issue) => issue.legacyCode === code);
}
describe("actionable local inspection", () => {
  test("accepts a complete percentage total and reports its actual excess", () => {
    expect(findings("同一个混合物包括60%和40%的组分。", "numeric-percentage-total")).toEqual([]);
    expect(
      findings("同一个混合物包括60%和50%的组分。", "numeric-percentage-total")[0]?.summary,
    ).toContain("110%");
    expect(
      findings("同一个混合物包括20%和30%的组分，余量为水。", "numeric-percentage-total"),
    ).toEqual([]);
  });
  test("does not assume that separately connected inlets and channels are one-to-one", () => {
    expect(findings("两个入口分别连接三个通道。", "numeric-quantity-mapping")).toEqual([]);
    expect(findings("两个入口与三个通道一一对应。", "numeric-quantity-mapping")).toHaveLength(1);
    expect(findings("三个入口与两个通道一一对应。", "numeric-quantity-mapping")).toHaveLength(1);
    expect(findings("第一入口与第三通道一一对应。", "numeric-quantity-mapping")).toEqual([]);
  });
  test("compares ranges after compatible units are normalized", () => {
    expect(
      findings("长度下限为0.000001nm，上限为0.0000002nm。", "numeric-range-reversed")[0]
        ?.confidence,
    ).toBe("certain");
    expect(findings("长度下限为80mm，上限为20cm。", "numeric-range-reversed")).toEqual([]);
    expect(findings("长度下限为20cm，上限为80mm。", "numeric-range-reversed")[0]?.confidence).toBe(
      "certain",
    );
    expect(
      findings(
        "长度范围为1cm至2cm，在上述范围内优选为12mm至18mm。",
        "numeric-subrange-out-of-bounds",
      ),
    ).toEqual([]);
    expect(
      findings(
        "长度范围为1cm至2cm，在上述范围内优选为12mm至28mm。",
        "numeric-subrange-out-of-bounds",
      ),
    ).toHaveLength(1);
    expect(findings("温度下限为250K，上限为20℃。", "numeric-range-reversed")).toEqual([]);
  });
  test("does not treat voltage and current unit prefixes as different dimensions", () => {
    expect(
      findings(
        "电压为5V，电压为300mV。电流为2A，电流为30mA。频率为2kHz，频率为1000Hz。",
        "numeric-unit-mismatch",
      ),
    ).toEqual([]);
  });
  test("does not warn for equal repeated equations", () => {
    expect(findings("x=1，x=1。", "formula-duplicate-definition")).toEqual([]);
    expect(findings("x=1，x=2。", "formula-duplicate-definition")).toHaveLength(1);
  });
  test("finds symbol explanations outside the immediately adjacent paragraphs", () => {
    const patent = sample();
    setBook(patent, "description", [
      "F表示作用力，m表示质量，a表示加速度。",
      "装置固定在壳体上。",
      "传感器用于检测。",
      "计算公式如下：",
    ]);
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push({
      id: crypto.randomUUID(),
      type: "block-formula",
      source: "F=ma",
      formulaKind: "math",
    });
    expect(
      inspectPatent(patent).issues.filter(
        (issue) => issue.legacyCode === "formula-undefined-symbol",
      ),
    ).toEqual([]);
  });
  test("reports every unfilled template paragraph", () => {
    const patent = sample();
    setBook(patent, "claims", ["1. 一种______装置。", "2. 根据权利要求1所述的装置，包括______。"]);
    expect(
      inspectPatent(patent).issues.filter(
        (issue) => issue.legacyCode === "unresolved-template-placeholder",
      ),
    ).toHaveLength(2);
  });
  test("does not cascade five missing chapter findings from one empty book", () => {
    const patent = sample();
    setBook(patent, "description", [""]);
    const report = inspectPatent(patent);
    expect(
      report.issues.filter((issue) => issue.legacyCode === "empty-required-book"),
    ).toHaveLength(1);
    expect(
      report.issues.filter((issue) => issue.legacyCode === "missing-description-chapter"),
    ).toEqual([]);
  });
  test("does not treat an unused drawing heading as a drawing reference", () => {
    const patent = sample();
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push(paragraph("附图说明"), paragraph(""));
    expect(
      inspectPatent(patent).issues.filter(
        (issue) => issue.legacyCode === "drawing-reference-without-drawing-books",
      ),
    ).toEqual([]);
  });
  test("keeps percentage ranges out of arithmetic totals", () => {
    expect(findings("同一个混合物包括20至30%和80%的组分。", "numeric-percentage-total")).toEqual(
      [],
    );
  });
  test("finds a missing required book even when it is absent from the book collection", () => {
    const patent = sample();
    patent.books = patent.books.filter((book) => book.kind !== "abstract");
    expect(
      inspectPatent(patent).issues.find((issue) => issue.legacyCode === "empty-required-book")
        ?.locations[0]?.bookKind,
    ).toBe("abstract");
  });
  test("keeps method-related product names out of method-claim warnings", () => {
    const patent = sample();
    patent.patentType = "utility-model";
    setBook(patent, "claims", ["1. 一种方法兰连接装置，其检测电路采用检测方法获取信号。"]);
    expect(
      inspectPatent(patent).issues.filter(
        (issue) => issue.legacyCode === "utility-model-method-wording",
      ),
    ).toEqual([]);
    setBook(patent, "claims", ["1. 一种检测方法，包括采样步骤。"]);
    expect(
      inspectPatent(patent).issues.filter(
        (issue) => issue.legacyCode === "utility-model-method-wording",
      ),
    ).toHaveLength(1);
  });
  test("reports a mid-claim period once in a full check", () => {
    const patent = sample();
    setBook(patent, "claims", ["1. 一种装置，包括壳体。", "壳体具有通孔；", "通孔连接管道。"]);
    expect(
      inspectPatent(patent).issues.filter((issue) => issue.legacyCode === "claim-paragraph-ending"),
    ).toHaveLength(1);
  });
});
