import type { JSONContent } from "@tiptap/core";
import { createBlankBookDocument, createBlankDocument } from "../../../shared/document/defaults";
import type {
  BlockNode,
  ParagraphNode,
  PatentBookDocument,
  TextMark,
} from "../../../shared/document/model";
import { canonicalToTiptap, tiptapToCanonical, tiptapToPatentBookDocument } from "./model-adapter";

const PAGE_BREAK_ID = "00000000-0000-4000-8000-000000000201";

describe("canonical Tiptap adapter", () => {
  test.each([false, true])("round-trips hidden and visible table annotations %s", (enabled) => {
    const document = createBlankDocument("表格说明");
    const paragraph = document.content[0]!;
    if (paragraph.type !== "paragraph") throw new Error("Missing paragraph");
    document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        columnWidthsMm: [30],
        tableNameEnabled: enabled,
        tableName: "测试结果",
        tableNoteEnabled: enabled,
        tableNote: "均值\n单位：秒",
        rows: [
          {
            id: crypto.randomUUID(),
            cells: [
              {
                id: crypto.randomUUID(),
                rowSpan: 1,
                colSpan: 1,
                horizontalAlignment: "left",
                verticalAlignment: "top",
                borderStyle: "single",
                content: [paragraph],
              },
            ],
          },
        ],
      },
    ];
    const saved = tiptapToCanonical(canonicalToTiptap(document), document);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const table = saved.value.content[0];
      expect(table).toMatchObject({ tableName: "测试结果", tableNote: "均值\n单位：秒" });
      if (table?.type === "table") expect(table.tableNameEnabled ?? false).toBe(enabled);
      expect(canonicalToTiptap(saved.value).content?.[0]?.attrs?.tableNoteEnabled).toBe(enabled);
    }
  });
  test.each(["center", "right"] as const)(
    "round-trips entire table alignment %s",
    (tableAlignment) => {
      const document = createBlankDocument("表格位置");
      const paragraph = document.content[0]!;
      if (paragraph.type !== "paragraph") throw new Error("Missing paragraph");
      document.content = [
        {
          id: crypto.randomUUID(),
          type: "table",
          tableAlignment,
          layoutMode: "fixed",
          columnWidthsMm: [30],
          rows: [
            {
              id: crypto.randomUUID(),
              cells: [
                {
                  id: crypto.randomUUID(),
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left",
                  verticalAlignment: "top",
                  borderStyle: "single",
                  content: [paragraph],
                },
              ],
            },
          ],
        },
      ];
      const tiptap = canonicalToTiptap(document);
      expect(tiptap.content?.[0]?.attrs?.tableAlignment).toBe(tableAlignment);
      const saved = tiptapToCanonical(tiptap, document);
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(saved.value.content[0]).toMatchObject({ tableAlignment });
    },
  );
  test("repairs stale table width counts on load and refuses to persist stale editor widths", () => {
    const document = createBlankDocument("列宽一致性");
    const paragraph = document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        layoutMode: "fixed",
        columnWidthsMm: [20, 30, 40],
        rows: [
          {
            id: crypto.randomUUID(),
            cells: [20, 30].map(() => ({
              id: crypto.randomUUID(),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [{ ...paragraph, id: crypto.randomUUID() }],
            })),
          },
        ],
      },
    ];
    const editorContent = canonicalToTiptap(document);
    const table = editorContent.content?.[0];
    expect(table?.attrs?.columnWidthsMm).toEqual([20, 30]);
    if (!table?.attrs) throw new Error("Missing table");
    table.attrs.columnWidthsMm = [20, 30, 40];
    const saved = tiptapToCanonical(editorContent, document);
    expect(saved.ok).toBe(true);
    if (!saved.ok || saved.value.content[0]?.type !== "table")
      throw new Error("Missing saved table");
    expect(saved.value.content[0].columnWidthsMm).toHaveLength(2);
  });

  test("round-trips the canonical blank paragraph", () => {
    const document = createBlankDocument("往返测试");
    const tiptap = canonicalToTiptap(document);

    expect(tiptap).toMatchObject({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            nodeId: document.content[0]?.id,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
        },
      ],
    });

    const result = tiptapToCanonical(tiptap, document);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(document.content);
  });

  test("rejects unknown Tiptap nodes", () => {
    const document = createBlankDocument("未知节点");
    const result = tiptapToCanonical(
      { type: "doc", content: [{ type: "iframe", attrs: { src: "https://example.com" } }] },
      document,
    );

    expect(result.ok).toBe(false);
  });

  test("rejects heading levels outside one through three", () => {
    const document = createBlankDocument("非法标题");
    const result = tiptapToCanonical(
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: {
              nodeId: document.content[0]?.id,
              level: 4,
              textAlign: "left",
              lineHeight: 1.5,
              paragraphIndentMm: 0,
              defaultFontFamily: "SimSun",
              defaultFontSizePt: 12,
            },
            content: [{ type: "text", text: "非法标题" }],
          },
        ],
      },
      document,
    );

    expect(result.ok).toBe(false);
  });

  test("round-trips supported text marks and paragraph attributes", () => {
    const document = createBlankDocument("文字格式");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;

    const marks: TextMark[] = [
      { type: "font-family", value: "Microsoft YaHei" },
      { type: "font-size", valuePt: 14 },
      { type: "color", value: "#112233" },
      { type: "background-color", value: "#FFF2CC" },
      { type: "bold" },
      { type: "italic" },
      { type: "underline" },
      { type: "claim-reference-review" },
      { type: "reference-mark-token", number: 7 },
      { type: "subscript" },
      { type: "superscript" },
    ];
    const formatted: ParagraphNode = {
      ...paragraph,
      attrs: {
        alignment: "justify",
        paragraphIndentMm: 12,
        lineSpacing: 2,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [{ type: "text", text: "格式文字", marks }],
    };
    const input = { ...document, content: [formatted] };
    const result = tiptapToCanonical(canonicalToTiptap(input), input);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(input.content);
  });

  test("round-trips an explicit page break", () => {
    const document = createBlankDocument("分页符");
    const pageBreak: BlockNode = { id: PAGE_BREAK_ID, type: "page-break" };
    const input = { ...document, content: [...document.content, pageBreak] };
    const tiptap = canonicalToTiptap(input);

    expect(tiptap.content?.[1]).toEqual({
      type: "pageBreak",
      attrs: { nodeId: PAGE_BREAK_ID, semanticRole: null },
    });
    const result = tiptapToCanonical(tiptap, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(input.content);
  });

  test("normalizes legacy tables and round-trips title-row layout and four-sided borders", () => {
    const document = createBlankDocument("表格元数据");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;

    const legacyTable = {
      id: "00000000-0000-4000-8000-000000000241",
      type: "table" as const,
      columnWidthsMm: [35],
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000242",
          cells: [
            {
              id: "00000000-0000-4000-8000-000000000243",
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left" as const,
              verticalAlignment: "top" as const,
              borderStyle: "double" as const,
              content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000244" }],
            },
          ],
        },
      ],
    };
    const legacyTiptap = canonicalToTiptap({ ...document, content: [legacyTable] });
    expect(legacyTiptap.content?.[0]?.attrs).toMatchObject({
      headerRowCount: 0,
      layoutMode: "fit-page",
    });

    const titleRowTiptap = {
      type: "doc",
      content: [
        {
          type: "table",
          attrs: {
            nodeId: "00000000-0000-4000-8000-000000000251",
            semanticRole: null,
            columnWidthsMm: [35],
            headerRowCount: 1,
            layoutMode: "fixed",
          },
          content: [
            {
              type: "tableRow",
              attrs: { nodeId: "00000000-0000-4000-8000-000000000252" },
              content: [
                {
                  type: "tableHeader",
                  attrs: {
                    nodeId: "00000000-0000-4000-8000-000000000253",
                    colspan: 1,
                    rowspan: 1,
                    horizontalAlignment: "center",
                    verticalAlignment: "middle",
                    borderStyle: "single",
                    borderTop: "double",
                    borderRight: "single",
                    borderBottom: "none",
                    borderLeft: "double",
                  },
                  content: [
                    {
                      type: "paragraph",
                      attrs: {
                        nodeId: "00000000-0000-4000-8000-000000000254",
                        semanticRole: null,
                        figureId: null,
                        textAlign: "left",
                        lineHeight: 1.5,
                        paragraphIndentMm: 0,
                        defaultFontFamily: "SimSun",
                        defaultFontSizePt: 12,
                      },
                      content: [{ type: "text", text: "标题单元格" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = tiptapToCanonical(titleRowTiptap, document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = result.value.content[0] as unknown as {
      headerRowCount: number;
      layoutMode: string;
      rows: Array<{ cells: Array<{ borderEdges: Record<string, string> }> }>;
    };
    expect(table).toMatchObject({ headerRowCount: 1, layoutMode: "fixed" });
    expect(table.rows[0]?.cells[0]?.borderEdges).toEqual({
      top: "double",
      right: "single",
      bottom: "none",
      left: "double",
    });
  });

  test("expands a fit-page table without stored widths to the printable page width", () => {
    const document = createBlankDocument("表格页面宽度");
    const paragraph = canonicalToTiptap(document).content?.[0];
    expect(paragraph).toBeDefined();
    if (!paragraph) return;

    const result = tiptapToCanonical(
      {
        type: "doc",
        content: [
          {
            type: "table",
            attrs: {
              nodeId: "00000000-0000-4000-8000-000000000281",
              layoutMode: "fit-page",
              columnWidthsMm: null,
            },
            content: [
              {
                type: "tableRow",
                attrs: { nodeId: "00000000-0000-4000-8000-000000000282" },
                content: [
                  {
                    type: "tableCell",
                    attrs: {
                      nodeId: "00000000-0000-4000-8000-000000000283",
                      colspan: 1,
                      rowspan: 1,
                    },
                    content: [
                      {
                        ...paragraph,
                        attrs: {
                          ...paragraph.attrs,
                          nodeId: "00000000-0000-4000-8000-000000000284",
                        },
                      },
                    ],
                  },
                  {
                    type: "tableCell",
                    attrs: {
                      nodeId: "00000000-0000-4000-8000-000000000285",
                      colspan: 1,
                      rowspan: 1,
                    },
                    content: [
                      {
                        ...paragraph,
                        attrs: {
                          ...paragraph.attrs,
                          nodeId: "00000000-0000-4000-8000-000000000286",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      document,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = result.value.content[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.columnWidthsMm).toEqual([82.5, 82.5]);
  });

  test("round-trips optional table row height rules without changing legacy rows", () => {
    const document = createBlankDocument("表格行高");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;

    const input = {
      ...document,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000261",
          type: "table" as const,
          columnWidthsMm: [40],
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000262",
              cells: [
                {
                  id: "00000000-0000-4000-8000-000000000263",
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left" as const,
                  verticalAlignment: "top" as const,
                  borderStyle: "single" as const,
                  content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000264" }],
                },
              ],
            },
            {
              id: "00000000-0000-4000-8000-000000000265",
              rowHeightMm: 12.5,
              rowHeightRule: "at-least" as const,
              cells: [
                {
                  id: "00000000-0000-4000-8000-000000000266",
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left" as const,
                  verticalAlignment: "top" as const,
                  borderStyle: "single" as const,
                  content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000267" }],
                },
              ],
            },
            {
              id: "00000000-0000-4000-8000-000000000268",
              rowHeightMm: 18,
              rowHeightRule: "exact" as const,
              cells: [
                {
                  id: "00000000-0000-4000-8000-000000000269",
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left" as const,
                  verticalAlignment: "top" as const,
                  borderStyle: "single" as const,
                  content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000270" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const tiptap = canonicalToTiptap(input);
    const rows = tiptap.content?.[0]?.content;
    expect(rows?.[0]?.attrs).not.toHaveProperty("rowHeightMm");
    expect(rows?.[1]?.attrs).toMatchObject({ rowHeightMm: 12.5, rowHeightRule: "at-least" });
    expect(rows?.[2]?.attrs).toMatchObject({ rowHeightMm: 18, rowHeightRule: "exact" });

    const result = tiptapToCanonical(tiptap, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(input.content);
  });

  test("round-trips a chemical structure with its KET source, editor mode and preview asset reference", () => {
    const document = createBlankDocument("结构式往返");
    const structure: BlockNode = {
      id: "00000000-0000-4000-8000-000000000299",
      type: "chemical-structure",
      ketSource: "(ket) (atom C)",
      editorMode: "macromolecule",
      previewAssetId: "00000000-0000-4000-8000-000000000298",
      widthMm: 72,
      alignment: "right",
    };
    const input = {
      ...document,
      assets: [
        {
          assetId: structure.previewAssetId,
          kind: "image" as const,
          originalName: "chemical-structure.png",
          mediaType: "image/png" as const,
          extension: "png" as const,
          byteLength: 4,
          sha256: "A".repeat(64),
          widthPx: 72,
          heightPx: 72,
          previewByteLength: 4,
          previewSha256: "B".repeat(64),
        },
      ],
      content: [structure],
    };

    expect(canonicalToTiptap(input).content?.[0]).toEqual({
      type: "chemicalStructure",
      attrs: {
        nodeId: structure.id,
        ketSource: structure.ketSource,
        editorMode: "macromolecule",
        previewAssetId: structure.previewAssetId,
        widthMm: structure.widthMm,
        alignment: structure.alignment,
      },
    });
    expect(tiptapToCanonical(canonicalToTiptap(input), input)).toMatchObject({
      ok: true,
      value: { content: [structure] },
    });
  });

  test("defaults a legacy structure without an editor mode to molecule on round-trip", () => {
    const document = createBlankDocument("旧结构式往返");
    const structure: BlockNode = {
      id: "00000000-0000-4000-8000-000000000297",
      type: "chemical-structure",
      ketSource: "(ket) (atom H)",
      previewAssetId: "00000000-0000-4000-8000-000000000296",
      widthMm: 80,
      alignment: "center",
    };
    const input = {
      ...document,
      assets: [
        {
          assetId: structure.previewAssetId,
          kind: "image" as const,
          originalName: "chemical-structure.png",
          mediaType: "image/png" as const,
          extension: "png" as const,
          byteLength: 4,
          sha256: "A".repeat(64),
          widthPx: 72,
          heightPx: 72,
          previewByteLength: 4,
          previewSha256: "B".repeat(64),
        },
      ],
      content: [structure],
    };

    expect(canonicalToTiptap(input).content?.[0]?.attrs?.editorMode).toBe("molecule");
    const result = tiptapToCanonical(canonicalToTiptap(input), input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content[0]).toMatchObject({
        type: "chemical-structure",
        editorMode: "molecule",
        ketSource: structure.ketSource,
        previewAssetId: structure.previewAssetId,
      });
    }
  });

  test("round-trips a patent book with formatted text, structures and formulas", () => {
    const book = createBlankBookDocument("权利要求书", "2026-08-02T00:00:00.000Z");
    const paragraph = {
      id: "00000000-0000-4000-8000-000000000301",
      type: "paragraph" as const,
      attrs: {
        alignment: "left" as const,
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [
        { type: "text" as const, text: "H", marks: [{ type: "bold" as const }] },
        { type: "text" as const, text: "2", marks: [{ type: "subscript" as const }] },
        { type: "inline-formula" as const, source: "x^2", formulaKind: "math" as const },
      ],
    };
    const listParagraph = { ...paragraph, id: "00000000-0000-4000-8000-000000000303", content: [] };
    const tableParagraph = {
      ...paragraph,
      id: "00000000-0000-4000-8000-000000000307",
      content: [],
    };
    const input = {
      ...book,
      content: [
        paragraph,
        { ...paragraph, id: "00000000-0000-4000-8000-000000000302", content: [] },
        {
          id: "00000000-0000-4000-8000-000000000304",
          type: "bullet-list" as const,
          items: [{ id: "00000000-0000-4000-8000-000000000305", content: [listParagraph] }],
        },
        {
          id: "00000000-0000-4000-8000-000000000306",
          type: "table" as const,
          columnWidthsMm: [30],
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000308",
              cells: [
                {
                  id: "00000000-0000-4000-8000-000000000309",
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left" as const,
                  verticalAlignment: "top" as const,
                  borderStyle: "single" as const,
                  content: [tableParagraph],
                },
              ],
            },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000310",
          type: "block-formula" as const,
          source: "E=mc^2",
          formulaKind: "math" as const,
        },
      ],
    };

    const result = tiptapToPatentBookDocument(canonicalToTiptap(input), input, new Set());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { modifiedAt: _modifiedAt, ...rest } = result.value as PatentBookDocument &
        Record<string, unknown>;
      const { modifiedAt: _inputModifiedAt, ...inputRest } = input as PatentBookDocument &
        Record<string, unknown>;
      expect(rest).toEqual(inputRest);
      expect(result.value.modifiedAt).not.toBe(input.modifiedAt);
    }
  });

  test("round-trips underlined placeholder spaces without losing text or marks", () => {
    const book = createBlankBookDocument("权利要求书", "2026-08-02T00:00:00.000Z");
    const input: PatentBookDocument = {
      ...book,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000311",
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
          content: [
            { type: "text", text: "1. ", marks: [] },
            { type: "text", text: " ".repeat(12), marks: [{ type: "underline" }] },
            { type: "text", text: "。", marks: [] },
          ],
        },
      ],
    };

    const result = tiptapToPatentBookDocument(canonicalToTiptap(input), input, new Set());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(input.content);
  });

  test("rejects duplicate node identifiers in a patent book", () => {
    const book = createBlankBookDocument("重复编号", "2026-08-02T00:00:00.000Z");
    const paragraph = {
      id: "00000000-0000-4000-8000-000000000320",
      type: "paragraph" as const,
      attrs: {
        alignment: "left" as const,
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [],
    };
    const input = { ...book, content: [paragraph, { ...paragraph }] };

    expect(tiptapToPatentBookDocument(canonicalToTiptap(input), input, new Set())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("节点编号重复") },
    });
  });

  test("round-trips linked drawing explanation and legend paragraph semantics", () => {
    const book = createBlankBookDocument("说明书", "2026-08-02T00:00:00.000Z");
    const figureId = "00000000-0000-4000-8000-000000000411";
    const explanation: ParagraphNode = {
      id: "00000000-0000-4000-8000-000000000412",
      type: "paragraph",
      semanticRole: "description-drawing-explanation",
      figureId,
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [{ type: "text", text: "图1为整体结构示意图。", marks: [] }],
    };
    const legend: ParagraphNode = {
      ...explanation,
      id: "00000000-0000-4000-8000-000000000413",
      content: [{ type: "text", text: "其中，1、箱体。", marks: [] }],
    };
    delete legend.figureId;
    delete legend.semanticRole;
    const input = { ...book, content: [explanation, legend] };
    const tiptap = canonicalToTiptap(input);

    expect(tiptap.content?.[0]?.attrs).toMatchObject({
      semanticRole: "description-drawing-explanation",
      figureId,
    });
    // 图例段无特殊标记：按普通段落转换（Tiptap 属性中为空值）。
    expect(tiptap.content?.[1]?.attrs).toMatchObject({ semanticRole: null, figureId: null });
    const result = tiptapToPatentBookDocument(tiptap, input, new Set());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { modifiedAt: _modifiedAt, ...rest } = result.value as PatentBookDocument &
        Record<string, unknown>;
      const { modifiedAt: _inputModifiedAt, ...inputRest } = input as PatentBookDocument &
        Record<string, unknown>;
      expect(rest).toEqual(inputRest);
      expect(result.value.modifiedAt).not.toBe(input.modifiedAt);
    }
  });

  test("converts Tiptap rgb() color values to #RRGGBB", () => {
    // 模拟 Tiptap Color 扩展存储格式：浏览器规范化后的 rgb()
    const document = createBlankDocument("颜色转换");
    const red: TextMark = { type: "color", value: "#FF0000" };
    const content: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            nodeId: document.content[0]?.id,
            textAlign: "left",
            lineHeight: 1.5,
            paragraphIndentMm: 0,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
          content: [
            {
              type: "text",
              text: "红色文字",
              marks: [{ type: "textStyle", attrs: { color: "rgb(255, 0, 0)" } }],
            },
          ],
        },
      ],
    };
    const result = tiptapToCanonical(content, document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = (result.value.content[0] as ParagraphNode)?.content[0];
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        expect(text.marks).toEqual([red]);
      }
    }
  });

  test("ignores empty Tiptap font family attributes while preserving other text styles", () => {
    const document = createBlankDocument("Word 颜色粘贴");
    const content: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            nodeId: document.content[0]?.id,
            textAlign: "left",
            lineHeight: 1.5,
            paragraphIndentMm: 0,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
          content: [
            {
              type: "text",
              text: "Word 彩色文字",
              marks: [
                {
                  type: "textStyle",
                  attrs: {
                    fontFamily: "",
                    color: "#ff0000",
                    backgroundColor: "",
                    fontSizePt: null,
                  },
                },
                { type: "bold" },
              ],
            },
          ],
        },
      ],
    };

    const result = tiptapToCanonical(content, document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = (result.value.content[0] as ParagraphNode)?.content[0];
      expect(text).toEqual({
        type: "text",
        text: "Word 彩色文字",
        marks: [{ type: "color", value: "#FF0000" }, { type: "bold" }],
      });
    }
  });
});
