import { createBlankPatent } from "../../shared/patent/defaults.js";
import { drawingBookContent } from "./patent-drawing-content.js";

test("legacy drawing images survive without a canonical list and ordinary body images stay unchanged", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "导出兼容" });
  const image = {
    id: crypto.randomUUID(),
    type: "figure" as const,
    assetId: crypto.randomUUID(),
    widthMm: 80,
    alignment: "center" as const,
  };
  for (const book of patent.books) {
    book.document.content = [image];
    expect(drawingBookContent(patent, book)).toEqual([image]);
  }
  patent.figures = [{ figureId: crypto.randomUUID(), assetId: image.assetId, widthMm: 80 }];
  for (const book of patent.books) {
    expect(drawingBookContent(patent, book)).toEqual(
      book.kind === "description-drawings" ? [] : [image],
    );
  }
  patent.abstractDrawingFigureId = patent.figures[0]?.figureId ?? null;
  const summary = patent.books.find((book) => book.kind === "abstract-drawing");
  if (!summary) throw new Error("Missing abstract drawing book");
  expect(drawingBookContent(patent, summary)).toEqual([]);
});
