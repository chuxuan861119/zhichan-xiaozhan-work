import type { BlockNode, ParagraphNode, TableNode } from "../../document/model.js";
import { createBlankPatent } from "../../patent/defaults.js";
import { DEFAULT_PATENT_INSPECTION_RULES } from "../default-rules.js";
import { runPatentInspection } from "../engine.js";

const p = (text: string, id = "p"): ParagraphNode => ({
  id,
  type: "paragraph",
  attrs: {
    alignment: "left",
    paragraphIndentMm: 0,
    lineSpacing: 1.5,
    defaultFontFamily: "SimSun",
    defaultFontSizePt: 12,
  },
  content: [{ type: "text", text, marks: [] }],
});
function table(...paragraphs: ParagraphNode[]): TableNode {
  return {
    id: "table",
    type: "table",
    columnWidthsMm: paragraphs.map(() => 40),
    rows: [
      {
        id: "row",
        cells: paragraphs.map((paragraph, i) => ({
          id: `cell-${i}`,
          rowSpan: 1,
          colSpan: 1,
          horizontalAlignment: "left",
          verticalAlignment: "top",
          borderStyle: "single",
          content: [paragraph],
        })),
      },
    ],
  };
}
function inspect(blocks: BlockNode[], code: string) {
  const patent = createBlankPatent({ patentType: "invention", name: "检查样例" });
  const description = patent.books.find((b) => b.kind === "description");
  if (!description) throw new Error("Missing description fixture");
  description.document.content = blocks;
  const before = JSON.stringify(patent);
  const report = runPatentInspection(patent, DEFAULT_PATENT_INSPECTION_RULES);
  expect(JSON.stringify(patent)).toBe(before);
  expect(report.degradedRules).toEqual([]);
  return report.issues.filter((i) => i.legacyCode === code);
}

test("formula source is not prose punctuation, while later prose retains offsets", () => {
  const paragraph = p("说明：");
  const source = "\\text{a,,b}";
  paragraph.content.push(
    { type: "inline-formula", source, formulaKind: "math" },
    { type: "text", text: "结束。。", marks: [] },
  );
  const found = inspect([paragraph], "repeated-punctuation");
  expect(found).toHaveLength(1);
  expect(found[0]?.locations[0]).toMatchObject({
    targetId: "p",
    startOffset: 3 + source.length + 2,
  });
});

test("separate cells cannot synthesize promotional phrases", () => {
  expect(inspect([table(p("世界", "a"), p("领先", "b"))], "promotional-language")).toEqual([]);
});

test.each([
  ["世界领先", "promotional-language"],
  ["本实用新型", "terminology-mismatch"],
  ["范围80至20mm", "numeric-range-reversed"],
])("nested text %s is located in its paragraph", (text, code) => {
  const found = inspect([table(p("正常", "a"), p(text, "b"))], code);
  expect(found).toHaveLength(1);
  expect(found[0]?.locations[0]?.targetId).toBe("b");
});

test("numeric ranges cannot be joined across cells", () => {
  expect(inspect([table(p("80-", "a"), p("20mm", "b"))], "numeric-range-reversed")).toEqual([]);
});

test("different cells are not conflicting definitions in the same paragraph", () => {
  expect(
    inspect([table(p("x=1；", "a"), p("x=2；", "b"))], "formula-duplicate-definition"),
  ).toEqual([]);
  expect(inspect([table(p("x=1；x=2；", "a"))], "formula-duplicate-definition")).toHaveLength(1);
});

test("zero denominators in table inline math are checked", () => {
  const paragraph = p("计算：", "a");
  paragraph.content.push({ type: "inline-formula", source: "\\frac{1}{0}", formulaKind: "math" });
  const found = inspect([table(paragraph)], "formula-literal-zero-denominator");
  expect(found).toHaveLength(1);
  expect(found[0]?.locations[0]?.targetId).toBe("a");
});

test("subtraction inside structured math is not a reversed numeric range", () => {
  const paragraph = p("计算：", "a");
  paragraph.content.push({ type: "inline-formula", source: "80-20=60", formulaKind: "math" });
  expect(
    inspect(
      [paragraph, { id: "math", type: "block-formula", source: "80-20=60", formulaKind: "math" }],
      "numeric-range-reversed",
    ),
  ).toEqual([]);
});

test("ASCII parentheses are checked with an exact symbol excerpt", () => {
  const found = inspect([p("控制器(连接传感器。")], "unbalanced-text-pair");
  expect(found).toHaveLength(1);
  expect(found[0]?.evidence[0]?.excerpt).toBe("(");
  expect(
    inspect(
      [p("范围[0,1)，步骤(1)；说明(第一部分", "a"), p("与第二部分)。", "b")],
      "unbalanced-text-pair",
    ),
  ).toEqual([]);
});

test("table captions and notes remain independently checked", () => {
  const node = table(p("正常", "a"));
  Object.assign(node, {
    tableNameEnabled: true,
    tableName: "世界",
    tableNoteEnabled: true,
    tableNote: "领先",
  });
  expect(inspect([node], "promotional-language")).toEqual([]);
  node.tableNote = "世界领先";
  expect(inspect([node], "promotional-language")).toHaveLength(1);
});

test("numeric comparisons see table contents before the note", () => {
  const node = table(p("父范围温度10℃至20℃。", "a"));
  Object.assign(node, { tableNoteEnabled: true, tableNote: "子范围温度5℃至15℃。" });
  expect(inspect([node], "numeric-subrange-out-of-bounds")).toHaveLength(1);
});
