import { createBlankPatent } from "./defaults.js";
import {
  type AuxiliaryDocument,
  availablePatentBookKinds,
  type CanonicalPatent,
  CanonicalPatentSchema,
  isPatentBookAvailable,
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  PatentFigureSchema,
  parsePatentWithVerifiedBooks,
} from "./model.js";
import { createFactoryPatentTemplates } from "./templates.js";

function replaceBookKinds(patent: CanonicalPatent, kinds: readonly string[]): unknown[] {
  const source = patent.books[0];
  if (!source) throw new Error("测试专利缺少五书夹具。");

  return kinds.map((kind, index) => ({
    ...structuredClone(patent.books[index % patent.books.length] ?? source),
    bookId: `00000000-0000-4000-8000-${(index + 100).toString(16).padStart(12, "0")}`,
    kind,
  }));
}

describe("canonical patent aggregate", () => {
  test("incremental validation still rejects changed books, duplicate identities and broken links", () => {
    const verified = CanonicalPatentSchema.parse(
      createBlankPatent({ patentType: "invention", name: "增量校验" }),
    );
    expect(parsePatentWithVerifiedBooks({ ...verified, customer: "更新客户" }, verified)).toEqual({
      ...verified,
      customer: "更新客户",
    });
    const changed = {
      ...verified,
      books: verified.books.map((book, index) =>
        index === 0
          ? {
              ...book,
              document: { ...book.document, content: [{ type: "paragraph", id: "invalid" }] },
            }
          : book,
      ),
    };
    expect(() => parsePatentWithVerifiedBooks(changed, verified)).toThrow();
    const duplicate = {
      ...verified,
      books: verified.books.map((book, index) =>
        index === 0 ? { ...book, bookId: verified.books[1]!.bookId } : book,
      ),
    };
    expect(() => parsePatentWithVerifiedBooks(duplicate, verified)).toThrow();
    expect(() =>
      parsePatentWithVerifiedBooks(
        { ...verified, abstractDrawingFigureId: "00000000-0000-4000-8000-000000000901" },
        verified,
      ),
    ).toThrow();
    const corruptedTrust = structuredClone(verified);
    corruptedTrust.books[0]!.document.content = [];
    expect(() =>
      parsePatentWithVerifiedBooks(
        { ...corruptedTrust, assets: [{ assetId: "invalid" }] },
        corruptedTrust,
      ),
    ).toThrow();
  });
  test("limits description drawing rotation to quarter turns", () => {
    const figure = {
      figureId: "00000000-0000-4000-8000-000000000620",
      assetId: "00000000-0000-4000-8000-000000000621",
      widthMm: 80,
      rotationDeg: 270,
    };

    expect(PatentFigureSchema.safeParse(figure).success).toBe(true);
    expect(PatentFigureSchema.safeParse({ ...figure, rotationDeg: 45 }).success).toBe(false);
  });

  test("accepts an auxiliary document whose title and document title match", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "导入专利" });
    const source = patent.books[0];
    if (!source) throw new Error("fixture");
    const auxiliary: AuxiliaryDocument = {
      auxiliaryDocumentId: "00000000-0000-4000-8000-000000000701",
      title: "审查意见答复草稿",
      document: {
        ...structuredClone(source.document),
        documentId: "00000000-0000-4000-8000-000000000702",
        title: "审查意见答复草稿",
      },
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: "答复草稿.docx",
    };

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        auxiliaryDocuments: [auxiliary],
      }).success,
    ).toBe(true);
  });

  test("rejects invalid auxiliary identity, title, and referenced assets", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "导入专利" });
    const source = patent.books[0];
    if (!source) throw new Error("fixture");
    const auxiliary = {
      auxiliaryDocumentId: "00000000-0000-4000-8000-000000000711",
      title: "其他材料",
      document: {
        ...structuredClone(source.document),
        documentId: "00000000-0000-4000-8000-000000000712",
        title: "不同标题",
        content: [
          {
            id: "00000000-0000-4000-8000-000000000713",
            type: "figure",
            assetId: "00000000-0000-4000-8000-000000000714",
            widthMm: 80,
            alignment: "center",
            caption: null,
          },
        ],
      },
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: null,
    };

    const mismatch = CanonicalPatentSchema.safeParse({
      ...patent,
      auxiliaryDocuments: [auxiliary],
    });
    expect(mismatch.success).toBe(false);

    const matching = {
      ...auxiliary,
      document: { ...auxiliary.document, title: auxiliary.title },
    };
    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        auxiliaryDocuments: [matching],
      }).success,
    ).toBe(false);

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        auxiliaryDocuments: [
          { ...matching, document: { ...matching.document, content: [] } },
          {
            ...matching,
            document: {
              ...matching.document,
              documentId: "00000000-0000-4000-8000-000000000715",
              content: [],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("creates exactly the five fixed books and opens description by default", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: null,
      customer: "  测试客户  ",
    });

    expect(patent.books.map((book) => book.kind)).toEqual(PATENT_BOOK_ORDER);
    expect(new Set(patent.books.map((book) => book.bookId)).size).toBe(5);
    expect(patent.activeBookKind).toBe("description");
    expect(patent.drawingBooksEnabled).toBe(true);
    expect(patent.customer).toBe("测试客户");
    expect(patent).not.toHaveProperty("scientificChartProjects");
    expect(CanonicalPatentSchema.parse(patent)).toEqual(patent);
  });

  test("derives three available books for an invention with drawings disabled", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "工艺方法" });
    patent.drawingBooksEnabled = false;

    expect(availablePatentBookKinds(patent)).toEqual(["claims", "description", "abstract"]);
    expect(isPatentBookAvailable(patent, "description-drawings")).toBe(false);
    expect(isPatentBookAvailable(patent, "abstract-drawing")).toBe(false);
    expect(CanonicalPatentSchema.safeParse(patent).success).toBe(true);
  });

  test("rejects an unavailable drawing book as the active book", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "工艺方法" });
    patent.drawingBooksEnabled = false;
    patent.activeBookKind = "description-drawings";

    expect(CanonicalPatentSchema.safeParse(patent).success).toBe(false);
  });

  test("rejects a utility model with drawings disabled", () => {
    const patent = createBlankPatent({ patentType: "utility-model", name: "夹具" });
    patent.drawingBooksEnabled = false;

    expect(CanonicalPatentSchema.safeParse(patent).success).toBe(false);
  });

  test("instantiates only text books from the selected template group", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const patent = createBlankPatent(
      { patentType: "invention", name: "环保回收装置", templates },
      { now: () => new Date("2026-08-02T00:00:00.000Z"), createId: () => crypto.randomUUID() },
    );

    const claims = patent.books.find((book) => book.kind === "claims")?.document;
    const firstClaim = claims?.content[0];
    expect(firstClaim).toMatchObject({
      type: "paragraph",
      content: expect.arrayContaining([
        { type: "text", text: "环保回收装置", marks: [{ type: "color", value: "#FF0000" }] },
        { type: "text", text: " ".repeat(12), marks: [{ type: "underline" }] },
      ]),
    });
    expect(
      JSON.stringify(patent.books.find((book) => book.kind === "description")?.document),
    ).toContain("环保回收装置");
    expect(
      patent.books.find((book) => book.kind === "description-drawings")?.document.content,
    ).toEqual([]);
    expect(patent.books.find((book) => book.kind === "abstract-drawing")?.document.content).toEqual(
      [],
    );
    expect(JSON.stringify(patent)).not.toContain('"templates"');
  });

  test("requires an explicit patent type but permits an empty name", () => {
    const patent = createBlankPatent({ patentType: "utility-model", name: null });

    expect(CanonicalPatentSchema.safeParse({ ...patent, patentType: null }).success).toBe(false);
    expect(CanonicalPatentSchema.parse({ ...patent, name: null }).name).toBeNull();
  });

  test.each([
    ["missing", ["claims", "description", "description-drawings", "abstract"]],
    ["duplicate", ["claims", "description", "description-drawings", "abstract", "abstract"]],
    [
      "extra",
      ["claims", "description", "description-drawings", "abstract", "abstract-drawing", "claims"],
    ],
    ["renamed", ["claims", "description", "description-drawings", "abstract", "summary-drawing"]],
  ])("rejects a %s five-book set", (_case, kinds) => {
    const patent = createBlankPatent({ patentType: "invention", name: "测试专利" });

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: replaceBookKinds(patent, kinds),
      }).success,
    ).toBe(false);
  });

  test("keeps aggregate-only fields out of book-owned documents", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "可变专利名称" });

    for (const book of patent.books) {
      expect(book.document.title).toBe(PATENT_BOOK_LABELS[book.kind]);
      expect(book.document).not.toHaveProperty("patentType");
      expect(book.document).not.toHaveProperty("assets");
    }

    const book = patent.books[0];
    if (!book) throw new Error("测试专利缺少五书夹具。");

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: [
          {
            ...book,
            document: { ...book.document, patentType: null, assets: [] },
          },
          ...patent.books.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate stable identities across books and figures", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const firstBook = patent.books[0];
    const secondBook = patent.books[1];
    if (!firstBook || !secondBook) throw new Error("测试专利缺少五书夹具。");

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: [firstBook, { ...secondBook, bookId: firstBook.bookId }, ...patent.books.slice(2)],
      }).success,
    ).toBe(false);

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: [
          firstBook,
          {
            ...secondBook,
            document: { ...secondBook.document, documentId: firstBook.document.documentId },
          },
          ...patent.books.slice(2),
        ],
      }).success,
    ).toBe(false);

    const asset = {
      assetId: "00000000-0000-4000-8000-000000000201",
      kind: "image" as const,
      originalName: "figure.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 1,
      sha256: "A".repeat(64),
      widthPx: 1,
      heightPx: 1,
      previewByteLength: 1,
      previewSha256: "B".repeat(64),
    };
    const figure = {
      figureId: "00000000-0000-4000-8000-000000000301",
      assetId: asset.assetId,
      widthMm: 100,
      rotationDeg: 0 as const,
    };

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        assets: [asset],
        figures: [figure, { ...figure }],
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate book content nodes and missing patent-level assets", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const book = patent.books[0];
    if (!book) throw new Error("测试专利缺少五书夹具。");

    const paragraph = {
      id: "00000000-0000-4000-8000-000000000401",
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
    const figure = {
      id: "00000000-0000-4000-8000-000000000402",
      type: "figure" as const,
      assetId: "00000000-0000-4000-8000-000000000403",
      widthMm: 100,
      alignment: "center" as const,
      rotationDeg: 0 as const,
    };

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: [
          {
            ...book,
            document: { ...book.document, content: [paragraph, { ...paragraph }] },
          },
          ...patent.books.slice(1),
        ],
      }).success,
    ).toBe(false);

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        books: [
          {
            ...book,
            document: { ...book.document, content: [figure] },
          },
          ...patent.books.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  test("accepts a sanitized SVG chemical asset whose stored preview is PNG", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "化学结构" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("测试专利缺少说明书夹具。");
    const preview = {
      assetId: "00000000-0000-4000-8000-000000000501",
      kind: "chemical-preview" as const,
      originalName: "structure.svg",
      mediaType: "image/svg+xml" as const,
      extension: "svg" as const,
      byteLength: 128,
      sha256: "A".repeat(64),
      widthPx: 320,
      heightPx: 240,
      previewByteLength: 256,
      previewSha256: "B".repeat(64),
    };
    const structure = {
      id: "00000000-0000-4000-8000-000000000502",
      type: "chemical-structure" as const,
      ketSource: "(ket) (atom C)",
      previewAssetId: preview.assetId,
      widthMm: 80,
      alignment: "center" as const,
    };

    expect(
      CanonicalPatentSchema.safeParse({
        ...patent,
        assets: [preview],
        books: patent.books.map((book) =>
          book.kind === "description"
            ? { ...book, document: { ...book.document, content: [structure] } }
            : book,
        ),
      }).success,
    ).toBe(true);
  });
});
