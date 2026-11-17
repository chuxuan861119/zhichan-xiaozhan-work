import {
  PATENT_BODY_FONT_SIZE_PT,
  PATENT_BODY_PARAGRAPH_ATTRIBUTES,
  PATENT_FIRST_LINE_INDENT_MM,
  PATENT_HEADING_ATTRIBUTES,
  PATENT_TITLE_ATTRIBUTES,
} from "./formatting.js";

describe("patent formatting constants", () => {
  test("defines four-point patent body text and two-character first-line indent", () => {
    expect(PATENT_BODY_FONT_SIZE_PT).toBe(14);
    expect(PATENT_FIRST_LINE_INDENT_MM).toBe(9.88);
    expect(PATENT_BODY_PARAGRAPH_ATTRIBUTES).toEqual({
      alignment: "justify",
      paragraphIndentMm: 9.88,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    });
  });

  test("defines separate title and heading attributes", () => {
    expect(PATENT_TITLE_ATTRIBUTES).toEqual({
      alignment: "center",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    });
    expect(PATENT_HEADING_ATTRIBUTES).toEqual({
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    });
    expect(PATENT_BODY_PARAGRAPH_ATTRIBUTES).not.toBe(PATENT_TITLE_ATTRIBUTES);
    expect(PATENT_BODY_PARAGRAPH_ATTRIBUTES).not.toBe(PATENT_HEADING_ATTRIBUTES);
  });
});
