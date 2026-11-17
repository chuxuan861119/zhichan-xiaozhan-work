import { convertParsedWordDocument } from "./docx-canonical-converter.js";
import type { ParsedWordDocument, WordParagraphBlock } from "./wordprocessingml-parser.js";

const parsed: ParsedWordDocument = {
  warnings: [{ code: "UNSUPPORTED_SMARTART", message: "SmartArt 暂不支持。" }],
  blocks: [
    {
      type: "paragraph",
      headingLevel: 1,
      alignment: "center",
      firstLineIndentMm: 5,
      lineSpacing: 2,
      list: null,
      inlines: [
        {
          type: "text",
          text: "彩色标题",
          style: {
            bold: true,
            fontFamily: "Arial",
            fontSizePt: 18,
            color: "#FF0000",
            backgroundColor: "#FFFF00",
          },
        },
      ],
    },
    {
      type: "paragraph",
      headingLevel: null,
      alignment: "left",
      firstLineIndentMm: null,
      lineSpacing: null,
      list: { kind: "ordered", level: 0, start: 1 },
      inlines: [{ type: "text", text: "列表项一", style: {} }],
    },
    {
      type: "paragraph",
      headingLevel: null,
      alignment: "left",
      firstLineIndentMm: null,
      lineSpacing: null,
      list: { kind: "ordered", level: 0, start: 1 },
      inlines: [{ type: "text", text: "列表项二", style: {} }],
    },
    {
      type: "paragraph",
      headingLevel: null,
      alignment: "left",
      firstLineIndentMm: null,
      lineSpacing: null,
      list: null,
      inlines: [
        { type: "formula", latex: "x^{2}" },
        { type: "unsupported", label: "SmartArt", warningCode: "UNSUPPORTED_SMARTART" },
      ],
    },
  ],
};

describe("DOCX canonical converter", () => {
  test.each(["table", "list", "claims"])(
    "retains resolved images inside %s paragraphs",
    (container) => {
      const paragraph: WordParagraphBlock = {
        type: "paragraph",
        headingLevel: null,
        alignment: "left",
        firstLineIndentMm: 0,
        lineSpacing: 1.5,
        list: container === "table" ? null : { kind: "ordered", level: 0, start: 1 },
        inlines: [
          { type: "text", text: "前", style: {} },
          {
            type: "image",
            relationshipId: "rId1",
            partName: "word/media/image.png",
            widthEmu: 1080000,
            heightEmu: 720000,
          },
          { type: "text", text: "后", style: {} },
        ],
      };
      const result = convertParsedWordDocument(
        {
          warnings: [],
          blocks:
            container === "table"
              ? [
                  {
                    type: "table",
                    columnWidthsTwips: [3000],
                    rows: [
                      { cells: [{ colSpan: 1, verticalMerge: null, paragraphs: [paragraph] }] },
                    ],
                  },
                ]
              : [paragraph],
        },
        {
          title: "图片导入",
          mode: "formal-book",
          bookKind: container === "claims" ? "claims" : "description",
          resolveImage: () => ({ assetId: "00000000-0000-4000-8000-000000000001" }),
        },
      );
      expect(JSON.stringify(result.document)).not.toContain("未导入");
      expect(JSON.stringify(result.document)).toContain('"type":"inline-figure"');
      expect(JSON.stringify(result.document)).toContain('"widthMm":30');
    },
  );

  test("retains supported formatting in auxiliary mode", () => {
    const result = convertParsedWordDocument(parsed, { title: "实验记录", mode: "auxiliary" });
    const heading = result.document.content[0];

    expect(heading).toMatchObject({
      type: "heading",
      level: 1,
      attrs: { alignment: "center", paragraphIndentMm: 5, lineSpacing: 2 },
      content: [
        {
          type: "text",
          marks: [
            { type: "bold" },
            { type: "font-family", value: "Arial" },
            { type: "font-size", valuePt: 18 },
            { type: "color", value: "#FF0000" },
            { type: "background-color", value: "#FFFF00" },
          ],
        },
      ],
    });
    expect(result.document.content[1]).toMatchObject({
      type: "ordered-list",
      start: 1,
      items: [
        { content: [{ content: [{ text: "列表项一" }] }] },
        { content: [{ content: [{ text: "列表项二" }] }] },
      ],
    });
    expect(result.document.content[2]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "inline-formula", source: "x^{2}" },
        { type: "text", text: "[未导入：SmartArt]" },
      ],
    });
  });

  test("normalizes typography and paragraph layout in formal-book mode", () => {
    const result = convertParsedWordDocument(parsed, { title: "说明书", mode: "formal-book" });
    const heading = result.document.content[0];

    expect(heading).toMatchObject({
      type: "heading",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 14,
      },
      content: [{ marks: [{ type: "bold" }] }],
    });
  });

  test("uses patent title and chapter styles for an imported specification", () => {
    const result = convertParsedWordDocument(
      {
        warnings: [],
        blocks: [
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: 9.88,
            lineSpacing: null,
            list: null,
            inlines: [{ type: "text", text: "一种建筑施工装置", style: { bold: true } }],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: 9.88,
            lineSpacing: null,
            list: null,
            inlines: [{ type: "text", text: "技术领域", style: { bold: true } }],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [{ type: "text", text: "本实用新型涉及施工技术领域。", style: {} }],
          },
        ],
      },
      { title: "说明书", mode: "formal-book", bookKind: "description" },
    );

    expect(result.document.content[0]).toMatchObject({
      type: "paragraph",
      attrs: { alignment: "center", paragraphIndentMm: 0 },
      semanticRole: "invention-title",
    });
    expect(result.document.content[1]).toMatchObject({
      type: "heading",
      level: 1,
      attrs: { alignment: "left", paragraphIndentMm: 0 },
    });
    expect(result.document.content[2]).toMatchObject({
      type: "paragraph",
      attrs: { alignment: "justify", paragraphIndentMm: 9.88 },
    });
  });

  test("cleans layout-only whitespace, blank paragraphs and page breaks in formal books", () => {
    const result = convertParsedWordDocument(
      {
        warnings: [],
        blocks: [
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [{ type: "text", text: "　\t  第一段　 ", style: {} }],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [
              { type: "text", text: "分页前", style: {} },
              { type: "page-break" },
              { type: "text", text: "分页后", style: {} },
            ],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [],
          },
        ],
      },
      { title: "说明书摘要", mode: "formal-book", bookKind: "abstract" },
    );

    expect(result.document.content).toHaveLength(4);
    expect(result.document.content.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(result.document.content[0]).toMatchObject({
      content: [{ type: "text", text: "第一段" }],
    });
    expect(result.document.content[1]).toMatchObject({ content: [] });
    expect(result.document.content[2]).toMatchObject({
      content: [{ type: "text", text: "分页前" }],
    });
    expect(result.document.content[3]).toMatchObject({
      content: [{ type: "text", text: "分页后" }],
    });
  });

  test("converts Word auto-numbered claims into editable numbered claim paragraphs", () => {
    const result = convertParsedWordDocument(
      {
        warnings: [],
        blocks: [
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: { kind: "ordered", level: 0, start: 1 },
            inlines: [{ type: "text", text: "一种装置，其特征在于……", style: {} }],
          },
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: { kind: "ordered", level: 0, start: 1 },
            inlines: [
              {
                type: "text",
                text: "根据权利要求1所述的装置，其特征在于……",
                style: {},
              },
            ],
          },
        ],
      },
      { title: "权利要求书", mode: "formal-book", bookKind: "claims" },
    );

    expect(result.document.content).toMatchObject([
      {
        type: "paragraph",
        content: [{ type: "text", text: "1. 一种装置，其特征在于……" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "2. 根据权利要求1所述的装置，其特征在于……" }],
      },
    ]);
  });

  test("keeps source whitespace and page breaks in auxiliary documents", () => {
    const result = convertParsedWordDocument(
      {
        warnings: [],
        blocks: [
          {
            type: "paragraph",
            headingLevel: null,
            alignment: "left",
            firstLineIndentMm: null,
            lineSpacing: null,
            list: null,
            inlines: [
              { type: "text", text: "  原始文本  ", style: {} },
              { type: "page-break" },
              { type: "text", text: "下一页", style: {} },
            ],
          },
        ],
      },
      { title: "其他文档", mode: "auxiliary" },
    );

    expect(result.document.content.map((block) => block.type)).toEqual([
      "paragraph",
      "page-break",
      "paragraph",
    ]);
    expect(result.document.content[0]).toMatchObject({
      content: [{ type: "text", text: "  原始文本  " }],
    });
  });
});
