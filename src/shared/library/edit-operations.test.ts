import {
  type AssetDescriptor,
  type BlockNode,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type CanonicalDocument,
  type ParagraphAttributes,
  type ParagraphNode,
  type TableNode,
} from "../document/model.js";
import {
  applyCanonicalOperations,
  CanonicalEditOperationSchema,
  diffCanonicalDocument,
  LibraryEditBatchSchema,
} from "./edit-operations.js";

const timestamp = "2026-08-01T00:00:00.000Z";

const paragraphAttrs: ParagraphAttributes = {
  alignment: "left",
  paragraphIndentMm: 0,
  lineSpacing: 1.5,
  defaultFontFamily: "SimSun",
  defaultFontSizePt: 12,
};

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function paragraph(id: string, text = ""): ParagraphNode {
  return {
    id,
    type: "paragraph",
    attrs: { ...paragraphAttrs },
    content: text.length > 0 ? [{ type: "text", text, marks: [] }] : [],
  };
}

function blockFormula(id: string, source: string): BlockNode {
  return { id, type: "block-formula", source, formulaKind: "math" };
}

function table(id: string, text: string): TableNode {
  return {
    id,
    type: "table",
    columnWidthsMm: [60],
    rows: [
      {
        id: testUuid(20),
        cells: [
          {
            id: testUuid(21),
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left",
            verticalAlignment: "top",
            borderStyle: "single",
            content: [paragraph(testUuid(22), text)],
          },
        ],
      },
    ],
  };
}

function assetDescriptor(assetId: string, originalName: string): AssetDescriptor {
  return {
    assetId,
    kind: "image",
    originalName,
    mediaType: "image/png",
    extension: "png",
    byteLength: 1024,
    sha256: "A".repeat(64),
    widthPx: 640,
    heightPx: 480,
    previewByteLength: 256,
    previewSha256: "B".repeat(64),
  };
}

function canonicalDocument(
  content: BlockNode[],
  assets: AssetDescriptor[] = [],
): CanonicalDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: testUuid(1),
    title: "往复式夹具",
    patentType: "invention",
    createdAt: timestamp,
    modifiedAt: timestamp,
    page: {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25,
      marginRightMm: 15,
      marginBottomMm: 15,
      marginLeftMm: 25,
    },
    content,
    assets,
  };
}

function expectRoundTrip(
  before: CanonicalDocument,
  after: CanonicalDocument,
  expectedOperations?: ReturnType<typeof diffCanonicalDocument>,
): void {
  const operations = diffCanonicalDocument(before, after);
  if (expectedOperations) expect(operations).toEqual(expectedOperations);
  expect(applyCanonicalOperations(before, operations)).toEqual(after);
}

describe("canonical document edit operations", () => {
  const before = canonicalDocument([paragraph(testUuid(2))]);

  test("represents one character edit as one affected block instead of a full document", () => {
    const after = structuredClone(before);
    const changedParagraph = after.content[0];
    if (changedParagraph?.type !== "paragraph") throw new Error("fixture");
    changedParagraph.content = [{ type: "text", text: "中", marks: [] }];

    expectRoundTrip(before, after, [{ type: "put-block", index: 0, block: changedParagraph }]);
  });

  test("represents mark changes as one affected block", () => {
    const markedBefore = canonicalDocument([paragraph(testUuid(3), "技术方案")]);
    const after = structuredClone(markedBefore);
    const changedParagraph = after.content[0];
    if (changedParagraph?.type !== "paragraph") throw new Error("fixture");
    changedParagraph.content = [{ type: "text", text: "技术方案", marks: [{ type: "bold" }] }];

    expectRoundTrip(markedBefore, after, [
      { type: "put-block", index: 0, block: changedParagraph },
    ]);
  });

  test("represents paragraph replacement as one affected block", () => {
    const paragraphBefore = canonicalDocument([paragraph(testUuid(4), "旧段落")]);
    const after = structuredClone(paragraphBefore);
    const changedParagraph = after.content[0];
    if (changedParagraph?.type !== "paragraph") throw new Error("fixture");
    changedParagraph.attrs = { ...changedParagraph.attrs, alignment: "justify" };
    changedParagraph.content = [{ type: "text", text: "完整替换后的段落", marks: [] }];

    expectRoundTrip(paragraphBefore, after, [
      { type: "put-block", index: 0, block: changedParagraph },
    ]);
  });

  test("represents table-cell edits as one affected table block", () => {
    const tableBefore = canonicalDocument([table(testUuid(5), "旧单元格")]);
    const after = structuredClone(tableBefore);
    const changedTable = after.content[0];
    if (changedTable?.type !== "table") throw new Error("fixture");
    const cellParagraph = changedTable.rows[0]?.cells[0]?.content[0];
    if (cellParagraph?.type !== "paragraph") throw new Error("fixture");
    cellParagraph.content = [{ type: "text", text: "新单元格", marks: [] }];

    expectRoundTrip(tableBefore, after, [{ type: "put-block", index: 0, block: changedTable }]);
  });

  test("represents block insertion, deletion, and reorder deterministically", () => {
    const first = paragraph(testUuid(6), "第一段");
    const second = paragraph(testUuid(7), "第二段");
    const removed = blockFormula(testUuid(8), "x+y");
    const inserted = paragraph(testUuid(9), "新增段落");
    const blockBefore = canonicalDocument([first, second, removed]);
    const after = canonicalDocument([second, inserted, first]);

    expectRoundTrip(blockBefore, after, [
      { type: "remove-block", blockId: removed.id },
      { type: "put-block", index: 1, block: inserted },
      { type: "set-order", blockIds: [second.id, inserted.id, first.id] },
    ]);
  });

  test("represents formula source changes as one affected block", () => {
    const formulaBefore = canonicalDocument([blockFormula(testUuid(10), "E=mc^2")]);
    const after = structuredClone(formulaBefore);
    const changedFormula = after.content[0];
    if (changedFormula?.type !== "block-formula") throw new Error("fixture");
    changedFormula.source = "\\int_a^b f(x) dx";

    expectRoundTrip(formulaBefore, after, [{ type: "put-block", index: 0, block: changedFormula }]);
  });

  test("represents title changes separately from block operations", () => {
    const after = { ...before, title: "改进型往复式夹具" };

    expectRoundTrip(before, after, [{ type: "set-title", title: after.title }]);
  });

  test("preserves canonical title whitespace during replay", () => {
    const after = { ...before, title: "  改进型往复式夹具  " };

    expectRoundTrip(before, after, [{ type: "set-title", title: after.title }]);
  });

  test("round-trips a moved block that is changed in the same diff", () => {
    const first = paragraph(testUuid(30), "第一段");
    const second = paragraph(testUuid(31), "第二段");
    const moveBefore = canonicalDocument([first, second]);
    const after = structuredClone(moveBefore);
    const movedAndChanged = after.content[1];
    if (movedAndChanged?.type !== "paragraph") throw new Error("fixture");
    movedAndChanged.content = [{ type: "text", text: "第二段已修改", marks: [] }];
    after.content = [movedAndChanged, after.content[0] as BlockNode];

    expectRoundTrip(moveBefore, after, [
      { type: "put-block", index: 1, block: movedAndChanged },
      { type: "set-order", blockIds: [movedAndChanged.id, first.id] },
    ]);
  });

  test("represents asset descriptor changes as one asset operation", () => {
    const assetId = testUuid(11);
    const assetBefore = canonicalDocument(
      [paragraph(testUuid(12), "附图说明")],
      [assetDescriptor(assetId, "old.png")],
    );
    const after = structuredClone(assetBefore);
    after.assets = [assetDescriptor(assetId, "new.png")];

    expectRoundTrip(assetBefore, after, [{ type: "set-assets", assets: after.assets }]);
  });

  test("represents page margin changes as one set-page operation", () => {
    const after = structuredClone(before);
    after.page = {
      ...after.page,
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    };

    expectRoundTrip(before, after, [{ type: "set-page", page: after.page }]);
  });

  test("emits the full page object when only a single margin changes", () => {
    const after = structuredClone(before);
    after.page = { ...after.page, marginTopMm: 30 };

    const operations = diffCanonicalDocument(before, after);
    expect(operations).toEqual([{ type: "set-page", page: after.page }]);
    expect(operations[0]?.type === "set-page" ? operations[0].page.marginRightMm : -1).toBe(15);
    expect(applyCanonicalOperations(before, operations)).toEqual(after);
  });

  test("does not emit set-page when the page is unchanged", () => {
    const operations = diffCanonicalDocument(before, structuredClone(before));
    expect(operations.some((operation) => operation.type === "set-page")).toBe(false);
    expect(operations).toEqual([]);
  });

  test("combines a set-page operation with content operations in one diff", () => {
    const after = structuredClone(before);
    after.page = { ...after.page, marginTopMm: 30 };
    const changedParagraph = after.content[0];
    if (changedParagraph?.type !== "paragraph") throw new Error("fixture");
    changedParagraph.content = [{ type: "text", text: "改了内容", marks: [] }];

    expectRoundTrip(before, after, [
      { type: "set-page", page: after.page },
      { type: "put-block", index: 0, block: changedParagraph },
    ]);
  });

  test("set-page application is idempotent across diff and apply", () => {
    const after = structuredClone(before);
    after.page = { ...after.page, marginTopMm: 30 };
    const replayed = applyCanonicalOperations(before, diffCanonicalDocument(before, after));
    expect(replayed).toEqual(after);
    expect(diffCanonicalDocument(after, replayed)).toEqual([]);
  });

  test("strictly validates set-page operations", () => {
    const valid = { type: "set-page" as const, page: before.page };
    expect(CanonicalEditOperationSchema.parse(valid)).toEqual(valid);
    expect(CanonicalEditOperationSchema.safeParse({ ...valid, unexpected: true }).success).toBe(
      false,
    );
    // PageSettingsSchema 允许 0~200mm（0~50 是设置/Dialog 层约束），但拒绝负数与未知键。
    expect(
      CanonicalEditOperationSchema.safeParse({
        type: "set-page",
        page: { ...before.page, marginTopMm: -1 },
      }).success,
    ).toBe(false);
    expect(
      CanonicalEditOperationSchema.safeParse({
        type: "set-page",
        page: { ...before.page, unexpected: 1 },
      }).success,
    ).toBe(false);
    expect(
      CanonicalEditOperationSchema.safeParse({ type: "set-page", page: undefined }).success,
    ).toBe(false);
  });

  test("rejects duplicate block IDs and an incomplete order list", () => {
    const duplicate = paragraph(before.content[0]?.id ?? testUuid(2), "重复段落");

    expect(() =>
      applyCanonicalOperations(before, [{ type: "put-block", index: 1, block: duplicate }]),
    ).toThrow();
    expect(() => applyCanonicalOperations(before, [{ type: "set-order", blockIds: [] }])).toThrow();
  });

  test("rejects unknown IDs, out-of-range indexes, and non-permutation order lists", () => {
    expect(() =>
      applyCanonicalOperations(before, [{ type: "remove-block", blockId: testUuid(13) }]),
    ).toThrow();
    expect(() =>
      applyCanonicalOperations(before, [
        { type: "put-block", index: 2, block: paragraph(testUuid(14), "越界") },
      ]),
    ).toThrow();
    expect(() =>
      applyCanonicalOperations(before, [
        { type: "set-order", blockIds: [before.content[0]?.id ?? testUuid(2), testUuid(15)] },
      ]),
    ).toThrow();
  });

  test("strictly validates edit operations and versioned edit batches", () => {
    const operation = { type: "set-title" as const, title: "改进型夹具" };
    const batch = {
      libraryDocumentId: testUuid(16),
      sessionId: testUuid(17),
      operationId: testUuid(18),
      baseRevision: 3,
      targetRevision: 4,
      modelVersion: 1 as const,
      operations: [operation],
      editorState: { selection: { anchor: 0 } },
    };

    expect(CanonicalEditOperationSchema.parse(operation)).toEqual(operation);
    expect(CanonicalEditOperationSchema.safeParse({ ...operation, unexpected: true }).success).toBe(
      false,
    );
    expect(LibraryEditBatchSchema.parse(batch)).toEqual(batch);
    expect(LibraryEditBatchSchema.safeParse({ ...batch, targetRevision: 5 }).success).toBe(false);
  });
});
