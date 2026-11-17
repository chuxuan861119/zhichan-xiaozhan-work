import type { CanonicalPatent, PatentBook, PatentFigure } from "./model.js";

export function drawingFiguresForBook(
  patent: CanonicalPatent,
  kind: PatentBook["kind"],
): PatentFigure[] {
  if (kind === "description-drawings") return [...patent.figures];
  if (kind !== "abstract-drawing" || patent.abstractDrawingFigureId === null) return [];
  return patent.figures.filter((figure) => figure.figureId === patent.abstractDrawingFigureId);
}

/** Consume one imported node per canonical drawing, retaining intentional copies. */
export function drawingBookContent(
  patent: CanonicalPatent,
  book: PatentBook,
): PatentBook["document"]["content"] {
  if (book.editorState.canonicalDrawingsNormalized === true) return book.document.content;
  const remaining = drawingFiguresForBook(patent, book.kind);
  return book.document.content.filter((node) => {
    if (node.type !== "figure") return true;
    const byId = remaining.findIndex((figure) => figure.figureId === node.id);
    const index =
      byId >= 0 ? byId : remaining.findIndex((figure) => figure.assetId === node.assetId);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/** Normalize before mutating figures. Persist the marker so later edits and undo
 * cannot mistake intentional standalone copies for imported duplicate nodes. */
export function normalizeDrawingBooks(patent: CanonicalPatent): CanonicalPatent["books"] {
  return patent.books.map((book) => {
    if (book.kind !== "description-drawings" && book.kind !== "abstract-drawing") return book;
    if (book.editorState.canonicalDrawingsNormalized === true) return book;
    return {
      ...book,
      document: { ...book.document, content: drawingBookContent(patent, book) },
      editorState: { ...book.editorState, canonicalDrawingsNormalized: true },
    };
  });
}
