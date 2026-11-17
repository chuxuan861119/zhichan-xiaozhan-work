import type { CanonicalDocument } from "../document/model.js";
import { drawingBookContent } from "../patent/drawing-content.js";
import {
  availablePatentBookKinds,
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "../patent/model.js";

const ORDER: PatentBookKind[] = [
  "abstract",
  "abstract-drawing",
  "claims",
  "description",
  "description-drawings",
];

export function createPatentPrintSnapshot(patent: CanonicalPatent, currentKind: PatentBookKind) {
  const available = availablePatentBookKinds(patent);
  const figureLabels = Object.fromEntries(
    patent.figures.map((figure, index) => [figure.figureId, `图${index + 1}`]),
  );
  const documents = ORDER.filter((kind) => available.includes(kind)).map(
    (kind): CanonicalDocument => {
      const book = patent.books.find((candidate) => candidate.kind === kind);
      if (!book) throw new Error(`缺少${PATENT_BOOK_LABELS[kind]}`);
      const figures =
        kind === "description-drawings"
          ? patent.figures
          : kind === "abstract-drawing"
            ? patent.figures.filter((figure) => figure.figureId === patent.abstractDrawingFigureId)
            : [];
      return {
        ...structuredClone(book.document),
        title: PATENT_BOOK_LABELS[kind],
        patentType: patent.patentType,
        assets: structuredClone(patent.assets),
        content: [
          ...structuredClone(drawingBookContent(patent, book)),
          ...figures.map((figure) => ({
            id: figure.figureId,
            type: "figure" as const,
            assetId: figure.assetId,
            widthMm: figure.widthMm,
            alignment: "center" as const,
            rotationDeg: figure.rotationDeg ?? 0,
          })),
        ],
      };
    },
  );
  const current = documents.find((document) => document.title === PATENT_BOOK_LABELS[currentKind]);
  if (!current) throw new Error("当前文档不可打印");
  return { current, documents, figureLabels };
}
