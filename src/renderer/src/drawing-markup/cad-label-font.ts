/** The bundled Source Han Serif CN OS/2 cap height is 729 / 1000 em.
 * CAD text height measures capitals, whereas SVG font-size measures the em.
 * Keep temporary SVG text identical to the native glyphs while they load. */
export const CAD_LABEL_CAP_HEIGHT = 0.729;
export const CAD_LABEL_FONT_FAMILY = '"CAD Unified Text", serif';
export const cadLabelCssFontSize = (height: number) => height / CAD_LABEL_CAP_HEIGHT;
