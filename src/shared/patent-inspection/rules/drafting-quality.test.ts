import type { BlockNode, ParagraphNode, TableNode } from "../../document/model.js";
import { createBlankPatent } from "../../patent/defaults.js";
import { DEFAULT_PATENT_INSPECTION_RULES } from "../default-rules.js";
import { runPatentInspection } from "../engine.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const p = (text: string, n = 1): ParagraphNode => ({
  id: id(n),
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
function fixture(description: BlockNode[] = [], claims: BlockNode[] = []) {
  const patent = createBlankPatent({ patentType: "invention", name: "检查对照" });
  for (const book of patent.books)
    if (book.kind === "description" || book.kind === "claims")
      book.document.content = book.kind === "description" ? description : claims;
  return patent;
}
function issues(patent: ReturnType<typeof fixture>, code: string) {
  return runPatentInspection(patent, DEFAULT_PATENT_INSPECTION_RULES).issues.filter(
    (i) => i.legacyCode === code,
  );
}
const table = (name: string, n: number): TableNode => ({
  id: id(n),
  type: "table",
  tableNameEnabled: true,
  tableName: name,
  columnWidthsMm: [80],
  rows: [
    {
      id: id(n + 100),
      cells: [
        {
          id: id(n + 200),
          rowSpan: 1,
          colSpan: 1,
          horizontalAlignment: "left",
          verticalAlignment: "top",
          borderStyle: "single",
          content: [p("数值", n + 300)],
        },
      ],
    },
  ],
});

test("claims pictures are reported while structured formulas and chemical structures are exempt", () => {
  const patent = fixture(
    [],
    [
      { id: id(2), type: "figure", assetId: id(90), widthMm: 80, alignment: "center" },
      p("表达式：", 3),
      { id: id(4), type: "block-formula", source: "x+1", formulaKind: "math" },
      {
        id: id(5),
        type: "chemical-structure",
        ketSource: "{}",
        previewAssetId: id(91),
        widthMm: 80,
        alignment: "center",
      },
    ],
  );
  const found = issues(patent, "claim-ordinary-image");
  expect(found).toHaveLength(1);
  expect(found[0]?.locations[0]?.targetId).toBe(id(2));
  expect(found[0]?.confidence).toBe("certain");
});

test("reference mark mismatches require an explicit registered name and bare bracketed number", () => {
  const patent = fixture([p("壳体（2）连接控制器（3）。壳体（2个）长20mm。", 1)]);
  patent.referenceMarks = [
    { referenceMarkId: id(80), keyword: "壳体", number: 1 },
    { referenceMarkId: id(81), keyword: "控制器", number: 3 },
  ];
  expect(issues(patent, "reference-mark-number-mismatch")).toHaveLength(1);
  patent.books.find((b) => b.kind === "description")!.document.content = [
    p("壳体（1）设有壳体盖（2）；购买壳体（2个）。文献记载“壳体（2）”。"),
  ];
  expect(issues(patent, "reference-mark-number-mismatch")).toEqual([]);
});

test("Chinese pairs may span paragraphs and interval/enumeration notation is left alone", () => {
  expect(issues(fixture([p("控制器（设有传感器。")]), "unbalanced-text-pair")).toHaveLength(1);
  expect(
    issues(
      fixture([p("说明为：“第一部分", 1), p("与第二部分”。区间（0，1]；（1）组装。", 2)]),
      "unbalanced-text-pair",
    ),
  ).toEqual([]);
  expect(issues(fixture([p("左侧）连接。")]), "unbalanced-text-pair")).toHaveLength(1);
});

test("single closing ASCII parentheses in numbered steps are not unbalanced prose", () => {
  expect(issues(fixture([p("1) 组装壳体；\n2) 安装控制器。")]), "unbalanced-text-pair")).toEqual(
    [],
  );
  expect(issues(fixture([p("左侧)连接。")]), "unbalanced-text-pair")).toHaveLength(1);
});

test("bare and fullwidth reference numbers agree with the registered marks, not quantities", () => {
  const patent = fixture([
    p("壳体2连接壳体（２）。壳体1内放置壳体2个，壳体20mm；壳体盖2。文献记载“壳体2”。"),
  ]);
  patent.referenceMarks = [{ referenceMarkId: id(80), keyword: "壳体", number: 1 }];
  const found = issues(patent, "reference-mark-number-mismatch");
  expect(found).toHaveLength(2);
  expect(found.map((i) => i.evidence[0]?.excerpt)).toEqual(
    expect.arrayContaining(["壳体2", "壳体（２）"]),
  );
});

test("table references recognize the automatically rendered table numbers", () => {
  expect(
    issues(fixture([table("温度", 10), p("如表1所示。", 20)]), "table-reference-missing"),
  ).toEqual([]);
  expect(
    issues(fixture([table("表1 温度", 10), table("表1 压力", 20)]), "table-number-duplicate"),
  ).toEqual([]);
});

test("compact manual table captions remain valid, but reference sentences are not captions", () => {
  expect(
    issues(
      fixture([p("表1温度数据", 8), table("", 10), p("结果如表1所示。", 20)]),
      "table-reference-missing",
    ),
  ).toEqual([]);
  expect(
    issues(
      fixture([table("温度数据", 10), p("表2所示为温度数据。", 20)]),
      "table-reference-missing",
    ),
  ).toHaveLength(1);
});

test("instrument reference marks are not mistaken for table citations", () => {
  expect(issues(fixture([p("压力表1与电表2连接。")]), "table-reference-missing")).toEqual([]);
  expect(issues(fixture([p("结果如表2所示。")]), "table-reference-missing")).toHaveLength(1);
});

test("only consecutive long prose and differently numbered identical claims are duplicate candidates", () => {
  const long =
    "所述控制器设置于壳体内并与温度传感器连接，根据采集的温度控制冷却流道的阀门开度，保持冷却介质稳定流动。";
  expect(issues(fixture([p(long, 1), p(long, 2)]), "duplicate-drafting-content")).toHaveLength(1);
  expect(
    issues(
      fixture([p(long, 1), p("另一实施例：", 2), p(long, 3), p("技术领域", 4), p("技术领域", 5)]),
      "duplicate-drafting-content",
    ),
  ).toEqual([]);
  expect(
    issues(
      fixture(
        [],
        [
          p("1. 一种冷却装置，包括壳体和设置在壳体内的控制器。", 1),
          p("2. 一种冷却装置，包括壳体和设置在壳体内的控制器。", 2),
        ],
      ),
      "duplicate-drafting-content",
    ),
  ).toHaveLength(1);
});

test("checks manual table captions and references, excluding continuation and background citations", () => {
  const patent = fixture([
    p("表1 温度", 8),
    table("", 10),
    p("表1 压力", 18),
    table("", 20),
    p("性能如表3所示。", 30),
  ]);
  expect(issues(patent, "table-number-duplicate")).toHaveLength(1);
  expect(issues(patent, "table-reference-missing")).toHaveLength(1);
  expect(
    issues(
      fixture([
        p("表1 温度", 8),
        table("", 10),
        p("表1（续）", 18),
        table("", 20),
        p("由表1可见。", 30),
      ]),
      "table-number-duplicate",
    ),
  ).toEqual([]);
  expect(
    issues(fixture([p("背景技术", 1), p("文献中表3列出已有结构。", 2)]), "table-reference-missing"),
  ).toEqual([]);
});

test("validates inserted math syntax using the renderer grammar, leaving chemistry alone", () => {
  expect(
    issues(
      fixture([{ id: id(1), type: "block-formula", source: "\\frac{1}{", formulaKind: "math" }]),
      "formula-invalid-syntax",
    ),
  ).toHaveLength(1);
  expect(
    issues(
      fixture([
        {
          id: id(1),
          type: "block-formula",
          source: "\\frac{1}{2} + \\ce{H2O}",
          formulaKind: "math",
        },
        { id: id(2), type: "block-formula", source: "\\ce{H2O}", formulaKind: "chemistry" },
      ]),
      "formula-invalid-syntax",
    ),
  ).toEqual([]);
  const inline = p("值为", 3);
  inline.content.push({ type: "inline-formula", source: "\\sqrt{", formulaKind: "math" });
  expect(issues(fixture([inline]), "formula-invalid-syntax")).toHaveLength(1);
});

test("flags questionable cross-book references but leaves quoted/background text alone", () => {
  expect(
    issues(
      fixture([p("如权利要求1所述，控制器连接壳体。")], [p("1. 如图2所示的装置。")]),
      "cross-book-reference",
    ),
  ).toHaveLength(2);
  expect(
    issues(
      fixture([
        p("背景技术", 1),
        p("文献记载：如权利要求1所述。", 2),
        p("具体实施方式", 3),
        p("文献称“如权利要求1所述”。", 4),
      ]),
      "cross-book-reference",
    ),
  ).toEqual([]);
});

test("reports explicit unresolved markers in nested text, not ordinary XX model names", () => {
  const t = table("参数表", 10);
  t.rows[0]!.cells[0]!.content = [p("{{patentName}}【待补充】", 30)];
  expect(issues(fixture([t]), "unfinished-editing-marker")).toHaveLength(1);
  expect(
    issues(fixture([p("采用XX系列产品。{a}和普通文字。")]), "unfinished-editing-marker"),
  ).toEqual([]);
});
