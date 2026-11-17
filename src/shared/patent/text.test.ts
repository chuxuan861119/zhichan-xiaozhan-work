import { DEFAULT_PAGE_SETTINGS, DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import { CANONICAL_DOCUMENT_FORMAT_VERSION, type PatentBookDocument } from "../document/model.js";
import { countUnicodeCharacters, visiblePatentBookText } from "./text.js";

function documentWithUnicodeAndFormula(): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: "00000000-0000-4000-8000-000000000901",
    title: "说明书",
    createdAt: "2026-08-02T00:00:00.000Z",
    modifiedAt: "2026-08-02T00:00:00.000Z",
    page: { ...DEFAULT_PAGE_SETTINGS },
    content: [
      {
        id: "00000000-0000-4000-8000-000000000902",
        type: "heading",
        level: 1,
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "环保回收装置", marks: [] }],
      },
      {
        id: "00000000-0000-4000-8000-000000000903",
        type: "paragraph",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [
          { type: "text", text: "技术领域", marks: [] },
          { type: "hard-break" },
          { type: "inline-formula", source: "E=mc²", formulaKind: "math" },
        ],
      },
    ],
  };
}

describe("patent visible text", () => {
  test("includes only enabled table annotation text", () => {
    const document = documentWithUnicodeAndFormula();
    document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        columnWidthsMm: [40],
        tableNameEnabled: true,
        tableName: "测试结果",
        tableNoteEnabled: true,
        tableNote: "单位：秒",
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
                content: [
                  {
                    id: crypto.randomUUID(),
                    type: "paragraph",
                    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
                    content: [{ type: "text", text: "数据", marks: [] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    expect(visiblePatentBookText(document)).toBe("测试结果数据单位：秒");
    const table = document.content[0]!;
    if (table.type !== "table") throw new Error("Missing table");
    table.tableNameEnabled = false;
    table.tableNoteEnabled = false;
    expect(visiblePatentBookText(document)).toBe("数据");
  });
  test("traverses headings, paragraphs, hard breaks and formulas", () => {
    expect(visiblePatentBookText(documentWithUnicodeAndFormula())).toBe(
      "环保回收装置技术领域\nE=mc²",
    );
  });

  test("counts Unicode code points instead of UTF-16 units", () => {
    expect(countUnicodeCharacters("装置😀A")).toBe(4);
  });

  test("keeps underlined placeholder spaces as ordinary spaces in plain text", () => {
    const document = documentWithUnicodeAndFormula();
    const paragraph = document.content[1];
    if (paragraph?.type !== "paragraph") throw new Error("paragraph fixture missing");
    paragraph.content = [
      { type: "text", text: "技术方案是", marks: [] },
      { type: "text", text: " ".repeat(6), marks: [{ type: "underline" }] },
      { type: "text", text: "。", marks: [] },
    ];

    expect(visiblePatentBookText(document)).toContain(`技术方案是${" ".repeat(6)}。`);
    expect(visiblePatentBookText(document)).not.toContain("_");
    expect(visiblePatentBookText(document)).not.toContain("[待填写]");
  });
});
