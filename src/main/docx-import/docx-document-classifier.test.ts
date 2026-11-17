import { describe, expect, it } from "vitest";
import { classifyDocxDocuments } from "./docx-document-classifier.js";
import type {
  ParsedWordDocument,
  WordBlock,
  WordParagraphBlock,
} from "./wordprocessingml-parser.js";

function paragraph(text: string, headingLevel: 1 | 2 | 3 | null = null): WordParagraphBlock {
  return {
    type: "paragraph",
    headingLevel,
    alignment: "left",
    firstLineIndentMm: null,
    lineSpacing: null,
    list: null,
    inlines: [{ type: "text", text, style: {} }],
  };
}

function document(
  sourceFileName: string,
  blocks: readonly WordBlock[],
): {
  sourceFileName: string;
  document: ParsedWordDocument;
} {
  return { sourceFileName, document: { blocks, warnings: [] } };
}

describe("classifyDocxDocuments", () => {
  it.each([
    { type: "formula", latex: "E=mc^2" } as const,
    { type: "unsupported", label: "图表", warningCode: "UNSUPPORTED_CHART" } as const,
  ])("preserves non-text content at section edges and before headings: %j", (inline) => {
    const object = { ...paragraph(""), inlines: [inline] };
    for (const blocks of [[object], [object, paragraph("正文"), object]]) {
      const result = classifyDocxDocuments([
        {
          ...document("公式.docx", [paragraph(""), ...blocks, paragraph("")]),
          document: {
            blocks: [paragraph(""), ...blocks, paragraph("")],
            warnings: [],
            sections: [
              { startBlockIndex: 0, endBlockIndex: blocks.length + 2, headerText: "说明书" },
            ],
          },
        },
      ]);
      expect(result.units[0]?.blocks).toEqual(blocks);
    }
    const leading = classifyDocxDocuments([
      document("标题前公式.docx", [object, paragraph("说明书"), paragraph("正文")]),
    ]);
    expect(leading.units[0]?.suggestedTarget.kind).toBe("unrecognized");
    expect(leading.units[0]?.blocks).toContainEqual(object);
  });

  it("does not guess an arbitrary picture or a short technical note is an official book", () => {
    const result = classifyDocxDocuments([
      document("图片记录.docx", [
        {
          ...paragraph(""),
          inlines: [
            {
              type: "image",
              relationshipId: "r1",
              partName: "word/media/1.png",
              widthEmu: null,
              heightEmu: null,
            },
          ],
        },
      ]),
      document("技术笔记.docx", [paragraph("本发明涉及一种电机，待进一步讨论。")]),
    ]);
    expect(result.units.every((unit) => unit.suggestedTarget.kind === "unrecognized")).toBe(true);
  });
  it("splits a combined five-book document at exact heading boundaries", () => {
    const result = classifyDocxDocuments([
      document("五书合一.docx", [
        paragraph("权 利 要 求 书", 1),
        paragraph("1. 一种装置……"),
        paragraph("说明书", 1),
        paragraph("技术领域"),
        paragraph("说明书附图", 1),
        paragraph("图1"),
        paragraph("说明书摘要", 1),
        paragraph("本发明公开……"),
        paragraph("摘要附图", 1),
      ]),
    ]);

    expect(result.units.map((unit) => unit.suggestedTarget)).toEqual([
      { kind: "official-book", bookKind: "claims" },
      { kind: "official-book", bookKind: "description" },
      { kind: "official-book", bookKind: "description-drawings" },
      { kind: "official-book", bookKind: "abstract" },
      { kind: "official-book", bookKind: "abstract-drawing" },
    ]);
    expect(result.units[4]?.title).toBe("摘要附图（待选择）");
    expect(result.units.every((unit) => unit.confidence === "high")).toBe(true);
    expect(result.units[0]?.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", text: "1. 一种装置……" }],
    });
    expect(JSON.stringify(result.units.map((unit) => unit.blocks))).not.toContain("权 利 要 求 书");
  });

  it("recognizes a single official book from heading variants and content signals", () => {
    const [claims, description, abstract] = classifyDocxDocuments([
      document("要求.docx", [paragraph("权利要求"), paragraph("1、一种电池，包括……")]),
      document("技术材料.docx", [
        paragraph("技术领域"),
        paragraph("背景技术"),
        paragraph("具体实施方式"),
      ]),
      document("摘要.docx", [paragraph("摘 要"), paragraph("本实用新型公开了一种……")]),
    ]).units;

    expect(claims?.suggestedTarget).toEqual({ kind: "official-book", bookKind: "claims" });
    expect(description?.suggestedTarget).toEqual({
      kind: "official-book",
      bookKind: "description",
    });
    expect(abstract?.suggestedTarget).toEqual({ kind: "official-book", bookKind: "abstract" });
  });

  it.each([false, true])(
    "splits body headings despite a shared specification header (page sections: %s)",
    (pageSections) => {
      const source = document("共用页眉五合一.docx", [
        paragraph("说明书摘要"),
        paragraph("摘要正文"),
        paragraph("摘要附图"),
        paragraph("摘要图内容"),
        paragraph("权利要求书"),
        paragraph("1. 一种装置"),
        paragraph("说明书附图"),
        paragraph("图1"),
        paragraph("说明书"),
        paragraph("技术领域"),
      ]);
      const result = classifyDocxDocuments([
        {
          ...source,
          document: {
            ...source.document,
            sections: pageSections
              ? [0, 2, 4, 6, 8].map((startBlockIndex) => ({
                  startBlockIndex,
                  endBlockIndex: startBlockIndex + 2,
                  headerText: "说明书",
                }))
              : [
                  {
                    startBlockIndex: 0,
                    endBlockIndex: 10,
                    headerText: "说明书",
                  },
                ],
          },
        },
      ]);
      expect(result.units.map((unit) => unit.suggestedTarget)).toEqual(
        ["abstract", "abstract-drawing", "claims", "description-drawings", "description"].map(
          (bookKind) => ({ kind: "official-book", bookKind }),
        ),
      );
      expect(result.units.map((unit) => unit.blocks)).toEqual(
        [1, 3, 5, 7, 9].map((index) => [source.document.blocks[index]]),
      );
      expect(result.conflicts).toEqual([]);
    },
  );

  it("combines section-only recognition with heading-split sections without moving content", () => {
    const source = document("混合分节.docx", [
      paragraph("摘要正文"),
      paragraph("权利要求书"),
      paragraph("1. 一种装置"),
      paragraph("说明书"),
      paragraph("技术领域"),
      paragraph("图1"),
    ]);
    const result = classifyDocxDocuments([
      {
        ...source,
        document: {
          ...source.document,
          sections: [
            { startBlockIndex: 0, endBlockIndex: 1, headerText: "说明书摘要" },
            { startBlockIndex: 1, endBlockIndex: 5, headerText: "说明书" },
            { startBlockIndex: 5, endBlockIndex: 6, headerText: "说明书附图" },
          ],
        },
      },
    ]);
    expect(result.units.map((unit) => unit.suggestedTarget)).toEqual(
      ["abstract", "claims", "description", "description-drawings"].map((bookKind) => ({
        kind: "official-book",
        bookKind,
      })),
    );
    expect(result.units.map((unit) => unit.blocks)).toEqual(
      [0, 2, 4, 5].map((index) => [source.document.blocks[index]]),
    );
  });

  it("keeps duplicate official assignments separate and reports a conflict", () => {
    const result = classifyDocxDocuments([
      document("权利要求A.docx", [paragraph("权利要求书")]),
      document("权利要求B.docx", [paragraph("权利要求书")]),
    ]);

    expect(result.units).toHaveLength(2);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ bookKind: "claims", unitIds: expect.arrayContaining([]) }),
    ]);
    expect(result.conflicts[0]?.unitIds).toHaveLength(2);
  });

  it("marks unknown content and splits independently recognized headings", () => {
    const result = classifyDocxDocuments([
      document("检测记录.docx", [paragraph("实验记录"), paragraph("温度 25℃")]),
      document("含糊.docx", [paragraph("说明书摘要"), paragraph("权利要求书")]),
    ]);

    expect(result.units.map((unit) => unit.suggestedTarget)).toEqual([
      { kind: "unrecognized" },
      { kind: "official-book", bookKind: "abstract" },
      { kind: "official-book", bookKind: "claims" },
    ]);
    expect(result.units.map((unit) => unit.confidence)).toEqual(["low", "high", "high"]);
  });

  it("recognizes a standalone abstract drawing for figure matching", () => {
    const result = classifyDocxDocuments([
      document("摘要附图.docx", [
        paragraph("摘要附图"),
        {
          ...paragraph(""),
          inlines: [
            {
              type: "image",
              relationshipId: "rId1",
              partName: "word/media/image1.png",
              widthEmu: null,
              heightEmu: null,
            },
          ],
        },
      ]),
    ]);

    expect(result.units[0]).toMatchObject({
      title: "摘要附图（待选择）",
      suggestedTarget: { kind: "official-book", bookKind: "abstract-drawing" },
      recognizedBookKind: "abstract-drawing",
      confidence: "high",
    });
  });

  it("recognizes an image-only specification drawing from image content and its file name", () => {
    const result = classifyDocxDocuments([
      document("说明书附图.docx", [
        {
          ...paragraph(""),
          alignment: "center",
          inlines: [
            {
              type: "image",
              relationshipId: "rId1",
              partName: "word/media/image1.jpeg",
              widthEmu: null,
              heightEmu: null,
            },
          ],
        },
        paragraph("图 1"),
      ]),
    ]);

    expect(result.units[0]).toMatchObject({
      suggestedTarget: { kind: "official-book", bookKind: "description-drawings" },
      confidence: "high",
    });
  });

  it("splits app-exported combined DOCX files by section headers without importing the headers", () => {
    const blocks = [
      paragraph("摘要正文"),
      paragraph("1. 权利要求正文"),
      paragraph("发明名称"),
      paragraph("技术领域"),
      {
        ...paragraph(""),
        inlines: [
          {
            type: "image" as const,
            relationshipId: "rIdImage",
            partName: "word/media/image.png",
            widthEmu: null,
            heightEmu: null,
          },
        ],
      },
    ];
    const result = classifyDocxDocuments([
      {
        sourceFileName: "软件导出的五合一.docx",
        document: {
          blocks,
          warnings: [],
          sections: [
            { startBlockIndex: 0, endBlockIndex: 1, headerText: "说明书摘要" },
            { startBlockIndex: 1, endBlockIndex: 2, headerText: "权利要求书" },
            { startBlockIndex: 2, endBlockIndex: 4, headerText: "说明书" },
            { startBlockIndex: 4, endBlockIndex: 5, headerText: "说明书附图" },
          ],
        },
      },
    ]);

    expect(result.units.map((unit) => unit.suggestedTarget)).toEqual([
      { kind: "official-book", bookKind: "abstract" },
      { kind: "official-book", bookKind: "claims" },
      { kind: "official-book", bookKind: "description" },
      { kind: "official-book", bookKind: "description-drawings" },
    ]);
    expect(JSON.stringify(result.units.map((unit) => unit.blocks))).not.toContain("说明书摘要");
  });
});
