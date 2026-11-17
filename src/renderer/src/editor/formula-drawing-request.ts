import type { ChemicalStructureSource } from "../../../shared/chemistry/structure-source";
import type { ChemicalPreviewAssetDescriptor } from "../../../shared/document/model";
import {
  fitInsertedFigures,
  insertedFigureWidthMm,
} from "../../../shared/patent/figure-insertion-size";
import type { CanonicalPatent } from "../../../shared/patent/model";
import {
  MAX_PATENT_FIGURE_WIDTH_MM,
  MIN_PATENT_FIGURE_WIDTH_MM,
} from "../../../shared/patent/model";

export type FormulaDrawingRequest =
  | {
      kind: "mathematical" | "physics" | "chemical-equation";
      latex: string;
      operation?: "insert" | "replace";
    }
  | {
      kind: "chemical-structure";
      descriptor: ChemicalPreviewAssetDescriptor;
      png: Uint8Array;
      svg?: string;
      source?: ChemicalStructureSource;
      operation?: "insert" | "replace";
    };

export function formulaDrawingRequestedWidthMm(widthPx: number): number {
  // Match the raster density used by formula-fallback; PNG pixels are not CSS pixels.
  return Math.min(
    MAX_PATENT_FIGURE_WIDTH_MM,
    Math.max(MIN_PATENT_FIGURE_WIDTH_MM, Math.round(((widthPx * 25.4) / 300) * 100) / 100),
  );
}

/** Uses the same insertion rule as the eventual figure edit. */
export function formulaDrawingFigureWidthMm(
  patent: CanonicalPatent,
  request: FormulaDrawingRequest,
  image: { widthPx: number; heightPx: number },
  replaceFigureId?: string,
): number {
  if (replaceFigureId) {
    const target = patent.figures.find((figure) => figure.figureId === replaceFigureId);
    if (!target) throw new Error("目标附图已发生变化，请重新选择。");
    return target.widthMm;
  }
  const page = patent.books.find((book) => book.kind === "description-drawings")?.document.page;
  if (!page) throw new Error("缺少说明书附图页面信息。");
  if (request.kind !== "chemical-structure")
    return Math.min(
      formulaDrawingRequestedWidthMm(image.widthPx),
      insertedFigureWidthMm(page, image),
    );
  const fitted = fitInsertedFigures(
    patent,
    [
      {
        figureId: replaceFigureId ?? "preview-chemical-figure",
        assetId: request.descriptor.assetId,
        widthMm: formulaDrawingRequestedWidthMm(image.widthPx),
      },
    ],
    [request.descriptor],
  )[0];
  if (!fitted) throw new Error("无法确定附图插入尺寸。");
  return fitted.widthMm;
}
