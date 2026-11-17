import { retainCurrentPatentAssets } from "./asset-references.js";
import { createBlankDrawingPatentBook } from "./defaults.js";
import { type CanonicalPatent, DRAWING_BOOK_KINDS, type PatentBookKind } from "./model.js";

export type DrawingBookTransitionDependencies = {
  now(): Date;
  createId(): string;
};

export type DisableDrawingBooksPlan = {
  patent: CanonicalPatent;
  retainedAssetIds: string[];
  assetIdsForPostCommitGarbageCollection: string[];
};

export function planDisableDrawingBooks(
  patent: CanonicalPatent,
  dependencies: DrawingBookTransitionDependencies,
): DisableDrawingBooksPlan {
  assertCanDisableDrawingBooks(patent);

  const timestamp = dependencies.now().toISOString();
  const next = retainCurrentPatentAssets({
    ...patent,
    modifiedAt: timestamp,
    drawingBooksEnabled: false,
    activeBookKind: isDrawingBook(patent.activeBookKind) ? "description" : patent.activeBookKind,
    books: patent.books.map((book) =>
      isDrawingBook(book.kind)
        ? createBlankDrawingPatentBook(book.kind, timestamp, dependencies.createId)
        : book,
    ),
    figures: [],
    abstractDrawingFigureId: null,
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: false },
  });
  const retainedAssetIds = new Set(next.assets.map((asset) => asset.assetId));
  return {
    patent: next,
    retainedAssetIds: [...retainedAssetIds],
    assetIdsForPostCommitGarbageCollection: patent.assets
      .map((asset) => asset.assetId)
      .filter((assetId) => !retainedAssetIds.has(assetId)),
  };
}

export function planEnableDrawingBooks(
  patent: CanonicalPatent,
  dependencies: DrawingBookTransitionDependencies,
): CanonicalPatent {
  if (patent.drawingBooksEnabled) {
    throw new Error("说明书附图和摘要附图已启用。");
  }

  const timestamp = dependencies.now().toISOString();
  return {
    ...patent,
    modifiedAt: timestamp,
    drawingBooksEnabled: true,
    activeBookKind: "description-drawings",
    books: patent.books.map((book) =>
      isDrawingBook(book.kind)
        ? createBlankDrawingPatentBook(book.kind, timestamp, dependencies.createId)
        : book,
    ),
  };
}

function assertCanDisableDrawingBooks(patent: CanonicalPatent): void {
  if (patent.patentType !== "invention") {
    throw new Error("只有发明专利可以删除附图书。");
  }
  if (!patent.drawingBooksEnabled) {
    throw new Error("说明书附图和摘要附图已删除。");
  }
}

function isDrawingBook(
  kind: PatentBookKind,
): kind is Extract<PatentBookKind, "description-drawings" | "abstract-drawing"> {
  return DRAWING_BOOK_KINDS.includes(kind as (typeof DRAWING_BOOK_KINDS)[number]);
}
