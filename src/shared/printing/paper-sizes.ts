export const STANDARD_PAPER_SIZE_NAMES = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "Legal",
  "Letter",
  "Tabloid",
] as const;

export type StandardPaperSize = (typeof STANDARD_PAPER_SIZE_NAMES)[number];
export type PrintOrientation = "portrait" | "landscape";

export type PaperSizeMillimetres = {
  widthMm: number;
  heightMm: number;
};

export type DocumentPageLike = {
  widthMm: number;
  heightMm: number;
};

export const STANDARD_PAPER_SIZES_MM = {
  A0: { widthMm: 841, heightMm: 1189 },
  A1: { widthMm: 594, heightMm: 841 },
  A2: { widthMm: 420, heightMm: 594 },
  A3: { widthMm: 297, heightMm: 420 },
  A4: { widthMm: 210, heightMm: 297 },
  A5: { widthMm: 148, heightMm: 210 },
  A6: { widthMm: 105, heightMm: 148 },
  Legal: { widthMm: 215.9, heightMm: 355.6 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
  Tabloid: { widthMm: 279.4, heightMm: 431.8 },
} as const satisfies Record<StandardPaperSize, PaperSizeMillimetres>;

const DOCUMENT_SIZE_MATCH_TOLERANCE_MM = 0.5;

function dimensionsMatch(left: PaperSizeMillimetres, right: PaperSizeMillimetres): boolean {
  return (
    Math.abs(left.widthMm - right.widthMm) <= DOCUMENT_SIZE_MATCH_TOLERANCE_MM &&
    Math.abs(left.heightMm - right.heightMm) <= DOCUMENT_SIZE_MATCH_TOLERANCE_MM
  );
}

export function getPaperSizeMillimetres(
  paperSize: StandardPaperSize,
  orientation: PrintOrientation,
): PaperSizeMillimetres {
  const dimensions = STANDARD_PAPER_SIZES_MM[paperSize];

  if (orientation === "landscape") {
    return { widthMm: dimensions.heightMm, heightMm: dimensions.widthMm };
  }

  return { widthMm: dimensions.widthMm, heightMm: dimensions.heightMm };
}

export function inferStandardPaperSize(
  documentPageSettings: DocumentPageLike,
): StandardPaperSize | null {
  for (const paperSize of STANDARD_PAPER_SIZE_NAMES) {
    const dimensions = STANDARD_PAPER_SIZES_MM[paperSize];
    if (dimensionsMatch(documentPageSettings, dimensions)) return paperSize;

    const landscapeDimensions = {
      widthMm: dimensions.heightMm,
      heightMm: dimensions.widthMm,
    };
    if (dimensionsMatch(documentPageSettings, landscapeDimensions)) return paperSize;
  }

  return null;
}

export function getDefaultPaperSize(
  documentPageSettings?: DocumentPageLike | null,
): StandardPaperSize {
  if (!documentPageSettings) return "A4";

  return inferStandardPaperSize(documentPageSettings) ?? "A4";
}
