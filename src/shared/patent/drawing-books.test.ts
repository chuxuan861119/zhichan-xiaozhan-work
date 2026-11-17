import { createBlankPatent } from "./defaults.js";
import {
  type DrawingBookTransitionDependencies,
  planDisableDrawingBooks,
  planEnableDrawingBooks,
} from "./drawing-books.js";
import { CanonicalPatentSchema } from "./model.js";

const TEST_TIMESTAMP = new Date("2026-08-08T12:00:00.000Z");

test("disabling drawing books preserves inline pictures in the description", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "行内图片" }, dependencies(1));
  const picture = imageAsset(600);
  const description = patent.books.find((book) => book.kind === "description");
  const paragraph = description?.document.content.find((node) => node.type === "paragraph");
  if (!paragraph) throw new Error("fixture paragraph");
  paragraph.content.push({
    type: "inline-figure",
    id: id(601),
    assetId: picture.assetId,
    widthMm: 20,
    alignment: "center",
  });
  patent.assets = [picture];
  expect(CanonicalPatentSchema.safeParse(patent).success).toBe(true);
  const plan = planDisableDrawingBooks(patent, dependencies(100));
  expect(plan.patent.assets).toEqual([picture]);
  expect(plan.assetIdsForPostCommitGarbageCollection).toEqual([]);
  expect(CanonicalPatentSchema.safeParse(plan.patent).success).toBe(true);
});

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function createIds(start = 100): () => string {
  let current = start;
  return () => id(current++);
}

function dependencies(start = 100): DrawingBookTransitionDependencies {
  return { now: () => TEST_TIMESTAMP, createId: createIds(start) };
}

function imageAsset(index: number) {
  return {
    assetId: id(index),
    kind: "image" as const,
    originalName: `asset-${index}.png`,
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 1,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 100,
    previewByteLength: 1,
    previewSha256: "B".repeat(64),
  };
}

function chemicalPreviewAsset(index: number) {
  return {
    assetId: id(index),
    kind: "chemical-preview" as const,
    originalName: `structure-${index}.svg`,
    mediaType: "image/svg+xml" as const,
    extension: "svg" as const,
    byteLength: 1,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 100,
    previewByteLength: 1,
    previewSha256: "B".repeat(64),
  };
}

describe("drawing book transitions", () => {
  test("disabling drawings replaces both drawing books and clears drawing-only state", () => {
    const patent = createBlankPatent(
      { patentType: "invention", name: "工艺方法" },
      dependencies(1),
    );
    const drawingAsset = imageAsset(10);
    patent.assets = [drawingAsset];
    patent.figures = [{ figureId: id(20), assetId: drawingAsset.assetId, widthMm: 80 }];
    patent.abstractDrawingFigureId = id(20);
    patent.referenceMarks = [{ referenceMarkId: id(30), number: 1, keyword: "反应器" }];
    patent.referenceMarkSettings = { synchronizedEditingEnabled: true };
    patent.activeBookKind = "abstract-drawing";
    const previousDrawingBooks = patent.books.filter((book) => book.kind.includes("drawing"));

    const plan = planDisableDrawingBooks(patent, dependencies(100));

    expect(plan.patent.drawingBooksEnabled).toBe(false);
    expect(plan.patent.activeBookKind).toBe("description");
    expect(plan.patent.figures).toEqual([]);
    expect(plan.patent.abstractDrawingFigureId).toBeNull();
    expect(plan.patent.referenceMarks).toEqual([]);
    expect(plan.patent.referenceMarkSettings).toEqual({ synchronizedEditingEnabled: false });
    expect(plan.patent.assets).toEqual([]);
    expect(plan.assetIdsForPostCommitGarbageCollection).toEqual([drawingAsset.assetId]);
    expect(CanonicalPatentSchema.parse(plan.patent)).toEqual(plan.patent);
    for (const previousBook of previousDrawingBooks) {
      const replacement = plan.patent.books.find((book) => book.kind === previousBook.kind);
      expect(replacement?.bookId).not.toBe(previousBook.bookId);
      expect(replacement?.document.documentId).not.toBe(previousBook.document.documentId);
      expect(replacement?.document.content).toEqual([]);
    }
  });

  test("disabling drawings retains assets referenced by the three available text books", () => {
    const patent = createBlankPatent(
      { patentType: "invention", name: "化工工艺" },
      dependencies(1),
    );
    const drawingOnlyAsset = imageAsset(10);
    const sharedTextAsset = chemicalPreviewAsset(11);
    const drawingBookAsset = imageAsset(12);
    const orphanedAsset = imageAsset(13);
    patent.assets = [drawingOnlyAsset, sharedTextAsset, drawingBookAsset, orphanedAsset];
    patent.figures = [{ figureId: id(20), assetId: drawingOnlyAsset.assetId, widthMm: 80 }];
    patent.books = patent.books.map((book) => {
      if (book.kind === "description") {
        return {
          ...book,
          document: {
            ...book.document,
            content: [
              {
                id: id(40),
                type: "chemical-structure" as const,
                ketSource: "(ket) (atom C)",
                previewAssetId: sharedTextAsset.assetId,
                widthMm: 80,
                alignment: "center" as const,
              },
            ],
          },
        };
      }
      if (book.kind === "description-drawings") {
        return {
          ...book,
          document: {
            ...book.document,
            content: [
              {
                id: id(41),
                type: "figure" as const,
                assetId: drawingBookAsset.assetId,
                widthMm: 80,
                alignment: "center" as const,
              },
            ],
          },
        };
      }
      return book;
    });

    const plan = planDisableDrawingBooks(patent, dependencies(100));

    expect(plan.patent.assets.map((asset) => asset.assetId)).toEqual([sharedTextAsset.assetId]);
    expect(plan.retainedAssetIds).toEqual([sharedTextAsset.assetId]);
    expect(plan.assetIdsForPostCommitGarbageCollection).toEqual([
      drawingOnlyAsset.assetId,
      drawingBookAsset.assetId,
      orphanedAsset.assetId,
    ]);
  });

  test("disabling drawings retains assets referenced by auxiliary documents", () => {
    const patent = createBlankPatent(
      { patentType: "invention", name: "补充材料" },
      dependencies(1),
    );
    const auxiliaryAsset = imageAsset(14);
    const source = patent.books[0];
    if (!source) throw new Error("fixture");
    patent.assets = [auxiliaryAsset];
    patent.auxiliaryDocuments = [
      {
        auxiliaryDocumentId: id(50),
        title: "试验照片",
        document: {
          ...structuredClone(source.document),
          documentId: id(51),
          title: "试验照片",
          content: [
            {
              id: id(52),
              type: "figure",
              assetId: auxiliaryAsset.assetId,
              widthMm: 80,
              alignment: "center",
            },
          ],
        },
        editorState: {},
        localRevision: 0,
        persistedRevision: 0,
        sourceFileName: null,
      },
    ];

    const plan = planDisableDrawingBooks(patent, dependencies(100));

    expect(plan.retainedAssetIds).toEqual([auxiliaryAsset.assetId]);
    expect(plan.assetIdsForPostCommitGarbageCollection).toEqual([]);
    expect(plan.patent.assets).toEqual([auxiliaryAsset]);
  });

  test("enabling drawings creates new empty books and opens description drawings", () => {
    const patent = createBlankPatent(
      { patentType: "invention", name: "工艺方法" },
      dependencies(1),
    );
    const disabled = planDisableDrawingBooks(patent, dependencies(100)).patent;
    const disabledDrawingBooks = disabled.books.filter((book) => book.kind.includes("drawing"));

    const plan = planEnableDrawingBooks(disabled, dependencies(200));

    expect(plan.drawingBooksEnabled).toBe(true);
    expect(plan.activeBookKind).toBe("description-drawings");
    expect(plan.books.filter((book) => book.kind.includes("drawing"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "description-drawings",
          document: expect.objectContaining({ content: [] }),
        }),
        expect.objectContaining({
          kind: "abstract-drawing",
          document: expect.objectContaining({ content: [] }),
        }),
      ]),
    );
    for (const previousBook of disabledDrawingBooks) {
      const replacement = plan.books.find((book) => book.kind === previousBook.kind);
      expect(replacement?.bookId).not.toBe(previousBook.bookId);
      expect(replacement?.document.documentId).not.toBe(previousBook.document.documentId);
    }
  });

  test("rejects disabling a utility model and repeated transitions with stable errors", () => {
    const utility = createBlankPatent(
      { patentType: "utility-model", name: "夹具" },
      dependencies(1),
    );
    const invention = createBlankPatent(
      { patentType: "invention", name: "方法" },
      dependencies(10),
    );

    expect(() => planDisableDrawingBooks(utility, dependencies(100))).toThrow(
      "只有发明专利可以删除附图书。",
    );
    expect(() =>
      planDisableDrawingBooks(
        planDisableDrawingBooks(invention, dependencies(100)).patent,
        dependencies(200),
      ),
    ).toThrow("说明书附图和摘要附图已删除。");
    expect(() => planEnableDrawingBooks(invention, dependencies(300))).toThrow(
      "说明书附图和摘要附图已启用。",
    );
  });
});
