import { initialChemicalStructureWidthMm } from "../chemistry/structure-size.js";
import type { AssetDescriptor, ImageRotation, PageSettings } from "../document/model.js";
import {
  type CanonicalPatent,
  MAX_PATENT_FIGURE_WIDTH_MM,
  MIN_PATENT_FIGURE_WIDTH_MM,
  type PatentFigure,
} from "./model.js";

/** The description-drawings import rule, shared by every image-producing tool. */
export function insertedFigureWidthMm(
  page: PageSettings,
  image: Pick<AssetDescriptor, "widthPx" | "heightPx">,
  rotation: ImageRotation = 0,
): number {
  const maximumWidthMm = Math.min(
    MAX_PATENT_FIGURE_WIDTH_MM,
    page.widthMm - page.marginLeftMm - page.marginRightMm,
  );
  const maximumPortraitHeightMm = Math.min(
    200,
    page.heightMm - page.marginTopMm - page.marginBottomMm - 25,
  );
  const aspectRatio =
    rotation === 90 || rotation === 270
      ? image.widthPx / image.heightPx
      : image.heightPx / image.widthPx;
  const widthMm =
    aspectRatio > 1
      ? Math.min(maximumWidthMm, maximumPortraitHeightMm / aspectRatio)
      : maximumWidthMm;
  return Math.round(Math.max(MIN_PATENT_FIGURE_WIDTH_MM, widthMm) * 100) / 100;
}

export function fitInsertedFigures(
  patent: Pick<CanonicalPatent, "books" | "figures" | "assets">,
  figures: readonly PatentFigure[],
  assets: readonly AssetDescriptor[],
  preserveReplacementWidths = false,
  // Generated rasters carry an explicit physical width. Ordinary user image imports still fill the page.
  naturalSizeFigureIds: readonly string[] = [],
): PatentFigure[] {
  const previous = new Map(patent.figures.map((figure) => [figure.figureId, figure]));
  const images = new Map([...patent.assets, ...assets].map((asset) => [asset.assetId, asset]));
  return figures.map((figure) => {
    // Editing an existing image's width/order is not an insertion. Undo/redo bypasses this entry.
    if (previous.get(figure.figureId)?.assetId === figure.assetId) return figure;
    if (preserveReplacementWidths && previous.has(figure.figureId)) return figure;
    const page = patent.books.find((book) => book.kind === "description-drawings")?.document.page;
    const image = images.get(figure.assetId);
    if (!page || !image) throw new Error("缺少说明书附图页面或图片信息，无法确定插入尺寸。");
    const old = previous.get(figure.figureId);
    if (image.kind === "chemical-preview") {
      if (old && images.get(old.assetId)?.kind === "chemical-preview") return figure;
      return {
        ...figure,
        widthMm: Math.min(
          initialChemicalStructureWidthMm(image),
          insertedFigureWidthMm(page, image, figure.rotationDeg),
        ),
      };
    }
    const maximumWidthMm = insertedFigureWidthMm(page, image, figure.rotationDeg);
    return {
      ...figure,
      widthMm:
        image.kind === "flowchart-preview" || naturalSizeFigureIds.includes(figure.figureId)
          ? Math.min(figure.widthMm, maximumWidthMm)
          : maximumWidthMm,
    };
  });
}
