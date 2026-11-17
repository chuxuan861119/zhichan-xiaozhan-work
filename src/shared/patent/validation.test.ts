import { createBlankPatent } from "./defaults.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import type { CanonicalPatent } from "./model.js";
import { inspectPatent, validatePatent } from "./validation.js";

function abstractBookWithText(patent: CanonicalPatent, text: string): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind === "abstract"
        ? {
            ...book,
            document: {
              ...book.document,
              content: [
                {
                  id: "00000000-0000-4000-8000-000000000801",
                  type: "paragraph",
                  attrs: {
                    alignment: "left",
                    paragraphIndentMm: 0,
                    lineSpacing: 1.5,
                    defaultFontFamily: "SimSun",
                    defaultFontSizePt: 12,
                  },
                  content: [{ type: "text", text, marks: [] }],
                },
              ],
            },
          }
        : book,
    ),
  };
}

function claimsBookWithText(
  patent: CanonicalPatent,
  paragraphs: readonly string[],
): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind === "claims"
        ? {
            ...book,
            document: {
              ...book.document,
              content: paragraphs.map((text, index) => ({
                id: `00000000-0000-4000-8000-${(880 + index).toString(16).padStart(12, "0")}`,
                type: "paragraph",
                attrs: {
                  alignment: "left",
                  paragraphIndentMm: 0,
                  lineSpacing: 1.5,
                  defaultFontFamily: "SimSun",
                  defaultFontSizePt: 12,
                },
                content: [{ type: "text", text, marks: [] }],
              })),
            },
          }
        : book,
    ),
  };
}

describe("objective patent validation", () => {
  test("checks drawing-book state during a full patent inspection", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: "无附图工艺",
    });
    patent.drawingBooksEnabled = false;
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("测试专利缺少说明书。");
    const drawingsHeading = description.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
    );
    if (
      !drawingsHeading ||
      (drawingsHeading.type !== "heading" && drawingsHeading.type !== "paragraph")
    ) {
      throw new Error("测试说明书缺少附图说明标题。");
    }
    description.document.content.push({
      id: "00000000-0000-4000-8000-000000000798",
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [{ type: "text", text: "如图1所示，反应器包括壳体。", marks: [] }],
    });

    expect(
      validatePatent(patent).some(
        (issue) => issue.code === "drawing-reference-without-drawing-books",
      ),
    ).toBe(true);
  });

  test("requires a drawing-explanation heading only after figures have been added", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: "带附图装置",
    });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("测试专利缺少说明书。");
    description.document.content = description.document.content.filter(
      (block) => classifyDescriptionChapterBlock(block) !== "drawing-explanation",
    );
    expect(
      validatePatent(patent).some((issue) => issue.code === "missing-drawing-explanation-heading"),
    ).toBe(false);
    patent.figures = [{ figureId: crypto.randomUUID(), assetId: crypto.randomUUID(), widthMm: 80 }];

    expect(
      validatePatent(patent).some((issue) => issue.code === "missing-drawing-explanation-heading"),
    ).toBe(true);
  });

  test("checks the reference-mark component against description text", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: "附图标记检查",
    });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000000799",
        number: 1,
        keyword: "待撰写部件",
      },
    ];

    expect(
      validatePatent(patent).some(
        (issue) => issue.code === "reference-mark-missing-in-description",
      ),
    ).toBe(true);

    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("测试专利缺少说明书。");
    const paragraph = description.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("测试专利缺少说明书段落。");
    paragraph.content = [{ type: "text", text: "待撰写部件用于支撑。", marks: [] }];

    expect(
      validatePatent(patent).some(
        (issue) => issue.code === "reference-mark-missing-in-description",
      ),
    ).toBe(false);
  });

  test("reports draft incompleteness and abstract length without blocking", () => {
    const patent = abstractBookWithText(
      createBlankPatent({ patentType: "invention", name: "计数名称" }),
      "。".repeat(301),
    );

    expect(validatePatent(patent).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "missing-description-chapter",
        "unresolved-template-placeholder",
        "abstract-too-long",
      ]),
    );
  });

  test("does not report a protected chapter as empty after body text is added", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("测试专利缺少说明书。");
    const technicalFieldHeadingIndex = description.document.content.findIndex((block) =>
      JSON.stringify(block).includes("技术领域"),
    );

    const filledPatent: CanonicalPatent = {
      ...patent,
      books: patent.books.map((book) =>
        book.kind === "description"
          ? {
              ...book,
              document: {
                ...book.document,
                content: [
                  ...book.document.content.slice(0, technicalFieldHeadingIndex + 1),
                  {
                    id: "00000000-0000-4000-8000-000000000802",
                    type: "paragraph",
                    attrs: {
                      alignment: "left",
                      paragraphIndentMm: 0,
                      lineSpacing: 1.5,
                      defaultFontFamily: "SimSun",
                      defaultFontSizePt: 12,
                    },
                    content: [
                      {
                        type: "text",
                        text: "本发明属于机械结构领域。",
                        marks: [],
                      },
                    ],
                  },
                  ...book.document.content.slice(technicalFieldHeadingIndex + 1),
                ],
              },
            }
          : book,
      ),
    };

    expect(
      validatePatent(filledPatent).some(
        (issue) =>
          issue.code === "missing-description-chapter" && issue.targetId === "technical-field",
      ),
    ).toBe(false);
  });

  test("reports terminology mismatch together with drawing metadata issues", () => {
    const patent = abstractBookWithText(
      createBlankPatent({ patentType: "utility-model", name: null }),
      "本发明涉及一种结构。",
    );

    const codes = validatePatent(patent).map((issue) => issue.code);
    expect(codes).toContain("terminology-mismatch");
    expect(codes).toContain("missing-figure-explanation");
    expect(codes).not.toContain("missing-abstract-drawing");
  });

  test("reports textual claim numbering and reference warnings", () => {
    const patent = claimsBookWithText(
      createBlankPatent({ patentType: "utility-model", name: null }),
      ["1. 一种结构，其特征在于：", "3. 根据权利要求9所述的结构，其特征在于通过方法实现。"],
    );

    const codes = validatePatent(patent).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["claim-numbering-warning", "claim-reference-warning"]),
    );
    expect(codes).not.toContain("utility-model-method-wording");
  });

  test("reports mixed claim number separators and accepts a single consistent style", () => {
    const mixed = claimsBookWithText(createBlankPatent({ patentType: "invention", name: null }), [
      "1. 一种结构，其特征在于：",
      "2、根据权利要求1所述的结构，其特征在于：",
    ]);
    const mixedIssues = validatePatent(mixed).filter(
      (issue) => issue.code === "claim-numbering-warning",
    );
    expect(mixedIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("分隔符不一致"),
        }),
      ]),
    );

    const consistentDunhao = claimsBookWithText(
      createBlankPatent({ patentType: "invention", name: null }),
      ["1、一种结构，其特征在于：", "2、根据权利要求1所述的结构，其特征在于："],
    );
    const dunhaoIssues = validatePatent(consistentDunhao).filter(
      (issue) => issue.code === "claim-numbering-warning",
    );
    expect(dunhaoIssues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("分隔符不一致") }),
      ]),
    );
  });

  test("keeps separate identities for multiple missing claim references", () => {
    const patent = claimsBookWithText(createBlankPatent({ patentType: "invention", name: null }), [
      "1. 一种结构，其特征在于：",
      "2. 根据权利要求8或权利要求9所述的结构，其特征在于：",
    ]);

    const issues = inspectPatent(patent).issues.filter(
      (issue) => issue.legacyCode === "claim-reference-warning",
    );

    expect(issues.map((issue) => issue.summary)).toEqual([
      "权利要求2引用了不存在的权利要求8。",
      "权利要求2引用了不存在的权利要求9。",
    ]);
    expect(new Set(issues.map((issue) => issue.fingerprint)).size).toBe(2);
  });

  test("checks missing abstract drawings before comparing their selection", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });

    const codes = validatePatent({
      ...patent,
      figures: [
        {
          figureId: "00000000-0000-4000-8000-000000000901",
          assetId: "00000000-0000-4000-8000-000000000902",
          widthMm: 100,
        },
      ],
    }).map((issue) => issue.code);
    expect(codes).toContain("missing-abstract-drawing");
    expect(codes).not.toContain("drawing-abstract-selection-mismatch");
  });

  test("checks fixed table row heights during full inspection", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const exactRowId = "00000000-0000-4000-8000-000000000921";
    const warningRows = [
      {
        id: exactRowId,
        rowHeightMm: 12.7,
        rowHeightRule: "exact" as const,
        cells: [
          {
            id: "00000000-0000-4000-8000-000000000922",
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left" as const,
            verticalAlignment: "top" as const,
            borderStyle: "single" as const,
            content: [
              {
                id: "00000000-0000-4000-8000-000000000923",
                type: "paragraph" as const,
                attrs: {
                  alignment: "left" as const,
                  paragraphIndentMm: 0,
                  lineSpacing: 1.5,
                  defaultFontFamily: "SimSun",
                  defaultFontSizePt: 12,
                },
                content: [{ type: "text" as const, text: "可能溢出的内容", marks: [] }],
              },
            ],
          },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000924",
        rowHeightMm: 12.7,
        rowHeightRule: "at-least" as const,
        cells: [
          {
            id: "00000000-0000-4000-8000-000000000925",
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left" as const,
            verticalAlignment: "top" as const,
            borderStyle: "single" as const,
            content: [
              {
                id: "00000000-0000-4000-8000-000000000926",
                type: "paragraph" as const,
                attrs: {
                  alignment: "left" as const,
                  paragraphIndentMm: 0,
                  lineSpacing: 1.5,
                  defaultFontFamily: "SimSun",
                  defaultFontSizePt: 12,
                },
                content: [{ type: "text" as const, text: "自然行高", marks: [] }],
              },
            ],
          },
        ],
      },
    ];
    const withTable: CanonicalPatent = {
      ...patent,
      books: patent.books.map((book) =>
        book.kind === "description"
          ? {
              ...book,
              document: {
                ...book.document,
                content: [
                  ...book.document.content,
                  {
                    id: "00000000-0000-4000-8000-000000000920",
                    type: "table" as const,
                    columnWidthsMm: [80],
                    rows: warningRows,
                  },
                ],
              },
            }
          : book,
      ),
    };

    expect(
      validatePatent(withTable).some((issue) => issue.code === "table-fixed-row-height-warning"),
    ).toBe(true);
  });
});
