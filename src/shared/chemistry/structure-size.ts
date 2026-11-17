export const CHEMICAL_PREVIEW_DENSITY = 300;

/** New structures use a readable natural size; subsequent edits keep the user's width. */
export function initialChemicalStructureWidthMm(image: {
  widthPx: number;
  heightPx: number;
}): number {
  const naturalWidth = (image.widthPx * 25.4) / CHEMICAL_PREVIEW_DENSITY;
  const heightLimitedWidth = (140 * image.widthPx) / image.heightPx;
  return Math.round(Math.max(10, Math.min(120, naturalWidth, heightLimitedWidth)) * 100) / 100;
}
