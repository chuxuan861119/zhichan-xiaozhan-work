import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { aiContentBlocks, mixedSelection } from "../../shared/ai-correction/mixed-content.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import {
  buildPatentCorrectionContext,
  buildPatentPolishSelection,
} from "./patent-context-builder.js";

describe("patent correction context builder", () => {
  test("preserves the actual ordered list numbering and separate list identity", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((book) => book.kind === "description");
    const paragraph = book?.document.content.find((node) => node.type === "paragraph");
    if (!book || paragraph?.type !== "paragraph") throw new Error("fixture");
    book.document.content = [5, 12].map((start) => ({
      id: randomUUID(),
      type: "ordered-list" as const,
      start,
      items: [0, 1].map(() => ({
        id: randomUUID(),
        content: [
          {
            ...paragraph,
            id: randomUUID(),
            content: [{ type: "text" as const, text: "测试步骤。", marks: [] }],
          },
        ],
      })),
    }));
    const context = buildPatentCorrectionContext(
      patent,
      { kind: "current-book", bookKind: "description" },
      50000,
    );
    expect(context.segments.map((segment) => segment.structure)).toEqual([
      expect.stringContaining("项5"),
      expect.stringContaining("项6"),
      expect.stringContaining("项12"),
      expect.stringContaining("项13"),
    ]);
  });
  test("describes selected claim paragraph boundaries without uploading surrounding text", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((book) => book.kind === "claims");
    const paragraph = book?.document.content.find((node) => node.type === "paragraph");
    if (!book || paragraph?.type !== "paragraph") throw new Error("fixture");
    book.document.content = [
      "1.一种装置，其特征在于：",
      "包含一个支架；",
      "该支架连接底座。",
      "2.根据权利要求1所述的装置。",
    ].map((text) => ({
      ...paragraph,
      id: randomUUID(),
      content: [{ type: "text", text, marks: [] }],
    }));
    const id = book.document.content[1]?.id;
    if (!id) throw new Error("fixture");
    const context = buildPatentCorrectionContext(
      patent,
      {
        kind: "selection",
        bookKind: "claims",
        blocks: [{ blockId: id, blockType: "paragraph", startOffset: 2, endOffset: 5 }],
        selectedTextHash: createHash("sha256").update("一个支").digest("hex"),
      },
      50_000,
    );
    expect(context.segments[0]).toMatchObject({
      text: "一个支",
      boundary: { startsAtParagraphStart: false, endsAtParagraphEnd: false },
      claim: { number: "1", paragraphIndex: 2, paragraphCount: 3 },
    });
    expect(JSON.stringify(context.segments)).not.toContain("底座");
  });
  test("allows text after unselected objects but rejects selected objects in polish requests", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const block = patent.books
      .find((book) => book.kind === "description")
      ?.document.content.find((node) => node.type === "paragraph");
    if (block?.type !== "paragraph") throw new Error("fixture");
    block.content = [
      { type: "text", text: "前文", marks: [] },
      { type: "hard-break" },
      { type: "text", text: "需要润色", marks: [] },
    ];
    const scope = {
      kind: "selection" as const,
      bookKind: "description" as const,
      blocks: [
        { blockId: block.id, blockType: "paragraph" as const, startOffset: 3, endOffset: 7 },
      ],
      selectedTextHash: createHash("sha256").update("需要润色").digest("hex"),
    };
    expect(buildPatentPolishSelection(patent, scope, 1000).text).toBe("需要润色");
    expect(() =>
      buildPatentPolishSelection(
        patent,
        {
          ...scope,
          blocks: [{ blockId: block.id, blockType: "paragraph", startOffset: 0, endOffset: 7 }],
          selectedTextHash: createHash("sha256").update("前文\n需要润色").digest("hex"),
        },
        1000,
      ),
    ).toThrow();
  });
  test("extracts only the authorized book and excludes patent metadata", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "不能上传的名称" });
    patent.customer = "不能上传的客户";
    const book = patent.books.find((candidate) => candidate.kind === "description");
    if (!book) throw new Error("fixture");
    const blockId = randomUUID();
    book.document.content = [
      {
        id: blockId,
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "需要纠错的文本", marks: [] }],
      },
    ];

    const context = buildPatentCorrectionContext(
      patent,
      {
        kind: "current-book",
        bookKind: "description",
      },
      1_000,
    );

    expect(context.segments).toEqual([
      {
        segmentId: "segment-1",
        blockId,
        bookKind: "description",
        sourceStartOffset: 0,
        text: "需要纠错的文本",
        boundary: { startsAtParagraphStart: true, endsAtParagraphEnd: true },
        structure: "paragraph",
        claim: undefined,
      },
    ]);
    expect(JSON.stringify(context)).not.toContain("不能上传");
  });

  test("marks a select-all request as complete without uploading another book", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((candidate) => candidate.kind === "description");
    const source = book?.document.content.find((candidate) => candidate.type === "paragraph");
    if (!book || source?.type !== "paragraph") throw new Error("fixture");
    const blocks = ["技术领域。", "背景技术。"].map((text) => ({
      ...structuredClone(source),
      id: randomUUID(),
      content: [{ type: "text" as const, text, marks: [] }],
    }));
    book.document.content = blocks;

    const context = buildPatentCorrectionContext(
      patent,
      {
        kind: "selection",
        bookKind: "description",
        blocks: blocks.map((block) => ({
          blockId: block.id,
          blockType: "paragraph" as const,
          startOffset: 0,
          endOffset: block.content[0]?.text.length ?? 0,
        })),
        selectedTextHash: createHash("sha256").update("技术领域。\n背景技术。").digest("hex"),
      },
      1_000,
    );

    expect(context.documentComplete).toBe(true);
  });

  test("preserves one offset position for inline formulas in provider text", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((candidate) => candidate.kind === "description");
    const block = book?.document.content.find((candidate) => candidate.type === "paragraph");
    if (!book || block?.type !== "paragraph") throw new Error("fixture");
    block.content = [
      { type: "text", text: "公式", marks: [] },
      { type: "inline-formula", source: "x^2", formulaKind: "math" },
      { type: "text", text: "后的错字", marks: [] },
    ];

    expect(
      buildPatentCorrectionContext(patent, { kind: "current-book", bookKind: "description" }, 1_000)
        .segments[0]?.text,
    ).toBe("公式\uFFFC后的错字");
  });

  test("requires selection text and hash to match persisted content", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((candidate) => candidate.kind === "claims");
    if (!book) throw new Error("fixture");
    const block = book.document.content.find((candidate) => candidate.type === "paragraph");
    if (block?.type !== "paragraph") throw new Error("fixture");
    block.content = [{ type: "text", text: "一种测试装置", marks: [] }];
    const selected = "测试";
    const selectedTextHash = createHash("sha256").update(selected).digest("hex");

    expect(
      buildPatentCorrectionContext(
        patent,
        {
          kind: "selection",
          bookKind: "claims",
          blocks: [{ blockId: block.id, blockType: "paragraph", startOffset: 2, endOffset: 4 }],
          selectedTextHash,
        },
        1_000,
      ).segments[0]?.text,
    ).toBe(selected);
    expect(() =>
      buildPatentCorrectionContext(
        patent,
        {
          kind: "selection",
          bookKind: "claims",
          blocks: [{ blockId: block.id, blockType: "paragraph", startOffset: 2, endOffset: 4 }],
          selectedTextHash: "0".repeat(64),
        },
        1_000,
      ),
    ).toThrow();
  });

  test("extracts one continuous selection across consecutive paragraphs", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((candidate) => candidate.kind === "description");
    const source = book?.document.content.find((candidate) => candidate.type === "paragraph");
    if (!book || source?.type !== "paragraph") throw new Error("fixture");
    const first = {
      ...structuredClone(source),
      id: randomUUID(),
      content: [{ type: "text" as const, text: "第一段文字", marks: [] }],
    };
    const second = {
      ...structuredClone(source),
      id: randomUUID(),
      content: [{ type: "text" as const, text: "第二段文字", marks: [] }],
    };
    book.document.content = [first, second];
    const selected = "段文字\n第二段";
    const context = buildPatentCorrectionContext(
      patent,
      {
        kind: "selection",
        bookKind: "description",
        blocks: [
          { blockId: first.id, blockType: "paragraph", startOffset: 2, endOffset: 5 },
          { blockId: second.id, blockType: "paragraph", startOffset: 0, endOffset: 3 },
        ],
        selectedTextHash: createHash("sha256").update(selected).digest("hex"),
      },
      1_000,
    );
    expect(context.segments).toMatchObject([
      { blockId: first.id, sourceStartOffset: 2, text: "段文字" },
      { blockId: second.id, sourceStartOffset: 0, text: "第二段" },
    ]);
  });

  test("requires text polish blocks to remain structurally consecutive", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books.find((candidate) => candidate.kind === "description");
    const source = book?.document.content.find((candidate) => candidate.type === "paragraph");
    if (!book || source?.type !== "paragraph") throw new Error("fixture");
    const blocks = ["第一段", "插入段", "第三段"].map((text) => ({
      ...structuredClone(source),
      id: randomUUID(),
      content: [{ type: "text" as const, text, marks: [] }],
    }));
    const firstBlock = blocks[0];
    const thirdBlock = blocks[2];
    if (!firstBlock || !thirdBlock) throw new Error("fixture");
    book.document.content = blocks;
    const selectedText = "第一段\n第三段";

    expect(() =>
      buildPatentPolishSelection(
        patent,
        {
          kind: "selection",
          bookKind: "description",
          blocks: [
            {
              blockId: firstBlock.id,
              blockType: "paragraph",
              startOffset: 0,
              endOffset: 3,
            },
            {
              blockId: thirdBlock.id,
              blockType: "paragraph",
              startOffset: 0,
              endOffset: 3,
            },
          ],
          selectedTextHash: createHash("sha256").update(selectedText).digest("hex"),
        },
        1_000,
      ),
    ).toThrow("选中文字已变化");
  });
});

test("versioned mixed scope validates formulas and supplies protected context without unrelated content", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const book = patent.books.find((b) => b.kind === "description")!;
  const paragraph = book.document.content.find((b) => b.type === "paragraph")!;
  if (paragraph.type !== "paragraph") throw new Error("fixture");
  const formula = {
    id: randomUUID(),
    type: "block-formula" as const,
    source: "Q=\\frac{P}{R}",
    formulaKind: "math" as const,
  };
  paragraph.content = [{ type: "text", text: "依据公式（1）计算。", marks: [] }];
  book.document.content = [
    paragraph,
    formula,
    {
      ...paragraph,
      id: randomUUID(),
      content: [{ type: "text", text: "未选择的保密内容", marks: [] }],
    },
  ];
  const blocks = [
    { blockId: paragraph.id, blockType: "paragraph" as const, startOffset: 0, endOffset: 10 },
    { blockId: formula.id, blockType: "object" as const, startOffset: 0, endOffset: 1 },
  ];
  blocks[0]!.endOffset = "依据公式（1）计算。".length;
  const text = mixedSelection(aiContentBlocks(book.document.content), blocks).text;
  const scope = {
    kind: "selection" as const,
    formatVersion: 2 as const,
    bookKind: "description" as const,
    blocks,
    selectedTextHash: createHash("sha256").update(text).digest("hex"),
  };
  const polish = buildPatentPolishSelection(patent, scope, 20000);
  expect(polish.formatVersion).toBe(2);
  expect(polish.text).toBe(text);
  const correction = buildPatentCorrectionContext(patent, scope, 20000);
  expect(correction.segments[1]?.objects?.[0]?.description).toContain("frac");
  expect(JSON.stringify(correction.segments)).not.toContain("保密内容");
  formula.source = "Q=P*R";
  expect(() => buildPatentPolishSelection(patent, scope, 20000)).toThrow();
  expect(() => buildPatentCorrectionContext(patent, scope, 20000)).toThrow();
});
