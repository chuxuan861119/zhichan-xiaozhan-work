/** CSS 行高比值：西文单倍行距约为字号的 1.2 倍，但中文字体（宋体/SimSun）的
 *  单倍行距实际约为字号的 1.35 倍。直接用 1.2 会导致四号字 1.5 倍行距明显偏挤，
 *  视觉上接近 Word 的单倍行距。 */
const WORD_SINGLE_LINE_HEIGHT_IN_CSS_EM = 1.35;
const CSS_PIXELS_PER_POINT = 96 / 72;

export function lineSpacingToCssLineHeight(lineSpacing: number): number {
  return Number((lineSpacing * WORD_SINGLE_LINE_HEIGHT_IN_CSS_EM).toFixed(3));
}

export function lineSpacingToScreenPixels(
  lineSpacing: number,
  fontSizePt: number,
  devicePixelRatio: number,
): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const rawCssPixels = fontSizePt * CSS_PIXELS_PER_POINT * lineSpacingToCssLineHeight(lineSpacing);
  return Number((Math.round(rawCssPixels * ratio) / ratio).toFixed(3));
}

/** Reduce the strut when every text run is smaller; larger runs grow their own lines. */
export function effectiveParagraphFontSizePt(
  defaultSize: number,
  textSizes: Iterable<number>,
): number {
  let maximum: number | undefined;
  for (const size of textSizes) maximum = maximum === undefined ? size : Math.max(maximum, size);
  return maximum === undefined ? defaultSize : Math.min(defaultSize, maximum);
}
