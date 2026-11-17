import { CANONICAL_DOCUMENT_FORMAT_VERSION } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import { migrateCanonicalPatent, migratePatentBookDocument } from "./migrations.js";
import { CANONICAL_PATENT_FORMAT_VERSION, UNIFIED_CAD_PATENT_FORMAT_VERSION } from "./model.js";
import { referenceNumberColor } from "./reference-marks.js";

describe("canonical patent migrations", () => {
  test("version 11 patents with version 3 books migrate without reformatting or mutating the source", () => {
    const current = createBlankPatent({
      patentType: "invention",
      name: "旧表兼容",
    });
    const firstBook = current.books[0];
    if (!firstBook) throw new Error("Missing book");
    const legacy = {
      ...current,
      formatVersion: 11,
      auxiliaryDocuments: [
        {
          auxiliaryDocumentId: "00000000-0000-4000-8000-000000000501",
          title: firstBook.document.title,
          document: {
            ...firstBook.document,
            documentId: "00000000-0000-4000-8000-000000000502",
            formatVersion: 3,
          },
          editorState: {},
          localRevision: 0,
          persistedRevision: 0,
          sourceFileName: null,
        },
      ],
      books: current.books.map((book) => ({
        ...book,
        document: { ...book.document, formatVersion: 3 },
      })),
    };
    const before = JSON.stringify(legacy);
    const migrated = migrateCanonicalPatent(legacy);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error(migrated.error.message);
    expect(migrated.value.books.map((book) => book.document.content)).toEqual(
      current.books.map((book) => book.document.content),
    );
    expect(
      migrated.value.books.every(
        (book) => book.document.formatVersion === CANONICAL_DOCUMENT_FORMAT_VERSION,
      ),
    ).toBe(true);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(migrated.value.auxiliaryDocuments[0]?.document.formatVersion).toBe(
      CANONICAL_DOCUMENT_FORMAT_VERSION,
    );
    expect(migrated.value.auxiliaryDocuments[0]?.document.content).toEqual(
      legacy.auxiliaryDocuments[0]?.document.content,
    );
    expect(migratePatentBookDocument(legacy.books[0]?.document).ok).toBe(true);
    expect(
      migrateCanonicalPatent({
        ...current,
        formatVersion: UNIFIED_CAD_PATENT_FORMAT_VERSION + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
  });
  test("converts legacy automatic reference colors to invisible semantic tokens", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "旧编号颜色" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009901", number: 1, keyword: "箱体" },
    ];
    const claims = patent.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      {
        type: "text",
        text: "箱体(1)",
        marks: [
          { type: "background-color", value: referenceNumberColor(1) },
          { type: "underline" },
        ],
      },
    ];

    const result = migrateCanonicalPatent(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const migratedClaims = result.value.books.find((book) => book.kind === "claims");
    expect(JSON.stringify(migratedClaims?.document)).not.toContain(referenceNumberColor(1));
    expect(JSON.stringify(migratedClaims?.document)).toContain("reference-mark-token");
    expect(JSON.stringify(migratedClaims?.document)).toContain("underline");
  });

  test.each([9, 10])(
    "migrates a main version %s patent without losing existing fields",
    (version) => {
      const current = createBlankPatent({ patentType: "invention", name: "核对状态迁移" });
      const input = structuredClone(current) as unknown as Record<string, unknown>;
      input.formatVersion = version;
      delete input.auxiliaryDocuments;
      delete input.docxImportReport;
      const snapshot = structuredClone(input);

      const result = migrateCanonicalPatent(input);

      expect(input).toEqual(snapshot);
      expect(result).toMatchObject({
        ok: true,
        value: {
          formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
          auxiliaryDocuments: [],
          docxImportReport: null,
          referenceMarkSettings: {
            synchronizedEditingEnabled: false,
          },
        },
      });
      if (!result.ok) throw new Error("fixture");
      expect(result.value.referenceMarkSettings.pendingReview).toBeUndefined();
      expect(result.value).toEqual(current);
    },
  );

  test("migrates a version 8 patent with no scientific projects without inferring figure links", () => {
    const current = createBlankPatent({ patentType: "invention", name: "历史实验图" });
    const input = structuredClone(current) as unknown as Record<string, unknown>;
    input.formatVersion = 8;
    delete input.scientificChartProjects;
    const snapshot = structuredClone(input);

    const result = migrateCanonicalPatent(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({ ok: true, value: {} });
    if (!result.ok) throw new Error("fixture");
    expect(result.value.figures.every((figure) => !("scientificChartLink" in figure))).toBe(true);
  });
  test("keeps an exact standalone drawing-description chapter untagged without mutating input", () => {
    const current = createBlankPatent({ patentType: "invention", name: "章节修复" });
    const description = current.books.find((book) => book.kind === "description");
    const drawings = description?.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
    );
    if (
      !description ||
      !drawings ||
      (drawings.type !== "paragraph" && drawings.type !== "heading")
    ) {
      throw new Error("fixture");
    }
    const input = structuredClone(description.document);

    const result = migratePatentBookDocument(input);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("fixture");
    expect(result.value).toEqual(input);
    expect(
      result.value.content.some(
        (block) =>
          classifyDescriptionChapterBlock(block) === "drawing-explanation" &&
          "semanticRole" in block &&
          block.semanticRole !== undefined,
      ),
    ).toBe(false);
  });

  test("migrates a version 3 patent and its version 1 book documents without mutation", () => {
    const current = createBlankPatent(
      { patentType: "invention", name: "迁移专利" },
      {
        now: () => new Date("2026-08-03T00:00:00.000Z"),
        createId: (() => {
          let index = 0;
          return () => `00000000-0000-4000-8000-${(++index).toString().padStart(12, "0")}`;
        })(),
      },
    );
    const input = {
      ...current,
      formatVersion: 3,
      books: current.books.map((book) => ({
        ...book,
        document: { ...book.document, formatVersion: 1 },
      })),
    };
    const snapshot = structuredClone(input);

    const result = migrateCanonicalPatent(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({
      ok: true,
      value: {
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        revision: snapshot.revision,
        figures: snapshot.figures,
        assets: snapshot.assets,
        books: snapshot.books.map((book) => ({
          document: {
            formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
            content: book.document.content,
          },
        })),
      },
    });
    if (result.ok) expect(result.value).not.toBe(input);
  });

  test("migrates a version 4 patent and keeps repeated migration stable", () => {
    const current = createBlankPatent({ patentType: "invention", name: "旧版专利" });
    const input = {
      ...current,
      formatVersion: 4,
      books: current.books.map((book) => ({
        ...book,
        document: { ...book.document, formatVersion: 2 },
      })),
    };
    const snapshot = structuredClone(input);

    const once = migrateCanonicalPatent(input);
    expect(input).toEqual(snapshot);
    expect(once).toMatchObject({
      ok: true,
      value: { formatVersion: CANONICAL_PATENT_FORMAT_VERSION },
    });
    if (!once.ok) throw new Error("fixture");
    const twice = migrateCanonicalPatent(once.value);
    expect(twice).toEqual(once);
  });

  test("removes legacy description-drawing-legend marked paragraphs on migration", () => {
    const current = createBlankPatent({ patentType: "invention", name: "旧图例清理" });
    const description = current.books.find((book) => book.kind === "description");
    const paragraph = description?.document.content.find((block) => block.type === "paragraph");
    if (!description || paragraph?.type !== "paragraph") throw new Error("fixture");
    description.document.content.push({
      ...structuredClone(paragraph),
      id: "00000000-0000-4000-8000-000000000777",
      semanticRole: "description-drawing-legend",
      content: [{ type: "text", text: "其中：1、箱体。", marks: [] }],
    } as unknown as typeof paragraph);

    const result = migrateCanonicalPatent(
      structuredClone(current) as unknown as Record<string, unknown>,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    const migratedDescription = result.value.books.find((book) => book.kind === "description");
    expect(JSON.stringify(migratedDescription?.document)).not.toContain(
      "description-drawing-legend",
    );
    // 删除标记段不影响文本模式解析派生附图标记。
    expect(result.value.referenceMarks).toEqual([]);
    // 幂等：再迁移一次结果不变。
    expect(migrateCanonicalPatent(result.value)).toEqual(result);
  });

  test("derives reference marks from a text-mode legend when the mark state row is absent", () => {
    const current = createBlankPatent({ patentType: "invention", name: "文本图例派生" });
    const description = current.books.find((book) => book.kind === "description");
    const paragraph = description?.document.content.find((block) => block.type === "paragraph");
    if (!description || paragraph?.type !== "paragraph") throw new Error("fixture");
    description.document.content.push({
      ...structuredClone(paragraph),
      id: "00000000-0000-4000-8000-000000000778",
      content: [{ type: "text", text: "其中：2、箱盖；5、回收箱。", marks: [] }],
    } as unknown as typeof paragraph);
    const input = structuredClone(current) as unknown as Record<string, unknown>;
    input.formatVersion = 5;
    delete input.referenceMarks;
    delete input.referenceMarkSettings;

    const result = migrateCanonicalPatent(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.value.referenceMarks).toEqual([
      expect.objectContaining({ number: 2, keyword: "箱盖" }),
      expect.objectContaining({ number: 5, keyword: "回收箱" }),
    ]);
  });

  test("migrates a version 7 patent with drawings enabled without mutating its content", () => {
    const current = createBlankPatent({ patentType: "invention", name: "版本迁移" });
    const input = structuredClone(current) as unknown as Record<string, unknown>;
    input.formatVersion = 7;
    delete input.drawingBooksEnabled;
    const snapshot = structuredClone(input);

    const result = migrateCanonicalPatent(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({
      ok: true,
      value: {
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        drawingBooksEnabled: true,

        books: snapshot.books,
        figures: snapshot.figures,
        referenceMarks: snapshot.referenceMarks,
      },
    });
  });

  test("migrates a legal version 5 description legend into structured reference marks", () => {
    const current = createBlankPatent({ patentType: "invention", name: "附图标记迁移" });
    const input = structuredClone(current) as unknown as Record<string, unknown>;
    input.formatVersion = 5;
    delete input.referenceMarks;
    delete input.referenceMarkSettings;
    const books = input.books as typeof current.books;
    const description = books.find((book) => book.kind === "description");
    const paragraph = description?.document.content.find((block) => block.type === "paragraph");
    if (!description || paragraph?.type !== "paragraph") throw new Error("fixture");
    description.document.content.push({
      ...structuredClone(paragraph),
      id: "00000000-0000-4000-8000-000000000555",
      semanticRole: "description-drawing-legend",
      content: [{ type: "text", text: "其中：1、箱体；3、箱盖。", marks: [] }],
    } as unknown as typeof paragraph);

    const result = migrateCanonicalPatent(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.value.referenceMarks).toEqual([
      expect.objectContaining({ number: 1, keyword: "箱体" }),
      expect.objectContaining({ number: 3, keyword: "箱盖" }),
    ]);
    expect(migrateCanonicalPatent(result.value)).toEqual(result);
  });

  test("migrates a version 2 book document to the current version", () => {
    const current = createBlankPatent({ patentType: "invention", name: "书册迁移" });
    const book = current.books[0];
    if (!book) throw new Error("fixture");
    const legacy = { ...book.document, formatVersion: 2 };

    const result = migratePatentBookDocument(legacy);

    expect(result).toMatchObject({
      ok: true,
      value: { formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION },
    });
  });

  test("preserves supported book fonts for platform display mapping", () => {
    const current = createBlankPatent({ patentType: "invention", name: "字体归一化专利" });
    const book = current.books[0];
    if (!book) throw new Error("fixture");
    const input = {
      ...book.document,
      formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000301",
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "KaiTi",
            defaultFontSizePt: 12,
          },
          content: [
            {
              type: "text",
              text: "楷体",
              marks: [{ type: "font-family", value: "FangSong" }],
            },
          ],
        },
      ],
    };
    const snapshot = structuredClone(input);

    const result = migratePatentBookDocument(input);

    expect(input).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    const paragraph = result.value.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    expect(paragraph.attrs.defaultFontFamily).toBe("KaiTi");
    const text = paragraph.content[0];
    if (text?.type !== "text") throw new Error("fixture");
    expect(text.marks).toContainEqual({ type: "font-family", value: "FangSong" });
  });

  test("rejects future patent versions protectively", () => {
    const result = migrateCanonicalPatent({
      formatVersion: UNIFIED_CAD_PATENT_FORMAT_VERSION + 1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
  });

  test("rejects version 2 book documents under a version 3 patent envelope", () => {
    const current = createBlankPatent({ patentType: "invention", name: "错误旧版外壳" });

    const result = migrateCanonicalPatent({ ...current, formatVersion: 3 });

    expect(result.ok).toBe(false);
  });

  test("rejects chemical structures under a version 3 patent envelope", () => {
    const current = createBlankPatent({ patentType: "invention", name: "错误化学旧版外壳" });
    const claims = current.books[0];
    if (!claims) throw new Error("fixture");
    const descriptor = {
      assetId: "00000000-0000-4000-8000-000000000901",
      kind: "image" as const,
      originalName: "structure.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 100,
      heightPx: 100,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    const input = {
      ...current,
      formatVersion: 3,
      assets: [descriptor],
      books: current.books.map((book, index) =>
        index === 0
          ? {
              ...claims,
              document: {
                ...claims.document,
                formatVersion: 2,
                content: [
                  {
                    id: "00000000-0000-4000-8000-000000000902",
                    type: "chemical-structure",
                    ketSource: "{}",
                    previewAssetId: descriptor.assetId,
                    widthMm: 80,
                    alignment: "center",
                  },
                ],
              },
            }
          : { ...book, document: { ...book.document, formatVersion: 1 } },
      ),
    };

    expect(migrateCanonicalPatent(input).ok).toBe(false);
  });

  test.each([
    ["patentType", "invention"],
    ["assets", []],
  ] as const)("rejects the aggregate-only field %s on a legacy book document", (field, value) => {
    const current = createBlankPatent({ patentType: "invention", name: "非法书册字段" });
    const book = current.books[0];
    if (!book) throw new Error("fixture");
    const document = { ...book.document, formatVersion: 1, [field]: value };

    expect(migratePatentBookDocument(document).ok).toBe(false);
  });
});
