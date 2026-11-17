import type { ParagraphAttributes } from "../document/model.js";

export const PATENT_BODY_FONT_SIZE_PT = 14;
export const PATENT_FIRST_LINE_INDENT_MM = 9.88;

const PATENT_BASE_ATTRIBUTES = {
  lineSpacing: 1.5,
  defaultFontFamily: "SimSun",
  defaultFontSizePt: PATENT_BODY_FONT_SIZE_PT,
} as const;

export const PATENT_BODY_PARAGRAPH_ATTRIBUTES: ParagraphAttributes = {
  ...PATENT_BASE_ATTRIBUTES,
  alignment: "justify",
  paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM,
};

export const PATENT_TITLE_ATTRIBUTES: ParagraphAttributes = {
  ...PATENT_BASE_ATTRIBUTES,
  alignment: "center",
  paragraphIndentMm: 0,
};

export const PATENT_HEADING_ATTRIBUTES: ParagraphAttributes = {
  ...PATENT_BASE_ATTRIBUTES,
  alignment: "left",
  paragraphIndentMm: 0,
};
