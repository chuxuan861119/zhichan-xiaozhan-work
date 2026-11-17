import { describe, expect, test } from "vitest";
import type { PageSettings } from "../document/model.js";
import {
  applyPageMarginsToPage,
  DEFAULT_PAGE_MARGINS,
  PAGE_MARGIN_MAX_MM,
  PAGE_MARGIN_MIN_MM,
  type PageMargins,
  PageMarginsSchema,
  validatePageMargins,
  WORD_MARGIN_PRESETS_CM,
} from "./page-margins.js";

function page(overrides: Partial<PageSettings> = {}): PageSettings {
  return {
    widthMm: 210,
    heightMm: 297,
    marginTopMm: 25.4,
    marginRightMm: 31.7,
    marginBottomMm: 25.4,
    marginLeftMm: 31.7,
    ...overrides,
  };
}

describe("DEFAULT_PAGE_MARGINS", () => {
  test("matches Word A4 normal template: top/bottom 25.4mm, left/right 31.7mm", () => {
    expect(DEFAULT_PAGE_MARGINS).toEqual({
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
  });

  test("round trips to the Word cm presets", () => {
    expect(DEFAULT_PAGE_MARGINS.marginTopMm / 10).toBeCloseTo(2.54, 2);
    expect(DEFAULT_PAGE_MARGINS.marginLeftMm / 10).toBeCloseTo(3.17, 2);
  });
});

describe("WORD_MARGIN_PRESETS_CM", () => {
  test("defines the four Word presets with the documented cm values", () => {
    expect(WORD_MARGIN_PRESETS_CM.normal).toEqual({
      label: "普通",
      top: 2.54,
      right: 3.17,
      bottom: 2.54,
      left: 3.17,
    });
    expect(WORD_MARGIN_PRESETS_CM.narrow).toEqual({
      label: "窄",
      top: 1.27,
      right: 1.27,
      bottom: 1.27,
      left: 1.27,
    });
    expect(WORD_MARGIN_PRESETS_CM.moderate).toEqual({
      label: "适中",
      top: 2.54,
      right: 1.91,
      bottom: 2.54,
      left: 1.91,
    });
    expect(WORD_MARGIN_PRESETS_CM.wide).toEqual({
      label: "宽",
      top: 2.54,
      right: 5.08,
      bottom: 2.54,
      left: 5.08,
    });
  });
});

describe("PageMarginsSchema", () => {
  test("accepts the Word defaults", () => {
    expect(PageMarginsSchema.safeParse(DEFAULT_PAGE_MARGINS).success).toBe(true);
  });

  test("accepts boundary values 0 and 60", () => {
    const margins: PageMargins = {
      marginTopMm: PAGE_MARGIN_MIN_MM,
      marginRightMm: PAGE_MARGIN_MAX_MM,
      marginBottomMm: PAGE_MARGIN_MIN_MM,
      marginLeftMm: PAGE_MARGIN_MAX_MM,
    };
    expect(PageMarginsSchema.safeParse(margins).success).toBe(true);
  });

  test("accepts the Word wide preset with 50.8mm left and right margins", () => {
    expect(
      PageMarginsSchema.safeParse({
        marginTopMm: 25.4,
        marginRightMm: 50.8,
        marginBottomMm: 25.4,
        marginLeftMm: 50.8,
      }).success,
    ).toBe(true);
  });

  test("rejects a value above 60mm", () => {
    const result = PageMarginsSchema.safeParse({ ...DEFAULT_PAGE_MARGINS, marginTopMm: 60.1 });
    expect(result.success).toBe(false);
  });

  test("rejects a negative value", () => {
    const result = PageMarginsSchema.safeParse({ ...DEFAULT_PAGE_MARGINS, marginLeftMm: -0.1 });
    expect(result.success).toBe(false);
  });

  test("rejects NaN values", () => {
    const result = PageMarginsSchema.safeParse({
      ...DEFAULT_PAGE_MARGINS,
      marginBottomMm: Number.NaN,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys because the schema is strict", () => {
    const result = PageMarginsSchema.safeParse({
      ...DEFAULT_PAGE_MARGINS,
      extra: 1,
    } as unknown);
    expect(result.success).toBe(false);
  });
});

describe("applyPageMarginsToPage", () => {
  test("overwrites only the four margins and preserves the rest of the page", () => {
    const source = page({
      widthMm: 180,
      heightMm: 240,
      marginTopMm: 10,
      marginRightMm: 20,
      marginBottomMm: 30,
      marginLeftMm: 40,
    });
    const next = applyPageMarginsToPage(source, {
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
    expect(next).toEqual({
      widthMm: 180,
      heightMm: 240,
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
    expect(next).not.toBe(source);
  });
});

describe("validatePageMargins", () => {
  const a4 = { pageWidthMm: 210, pageHeightMm: 297 };
  const valid: PageMargins = { ...DEFAULT_PAGE_MARGINS };

  test("returns null for the Word defaults on A4", () => {
    expect(validatePageMargins(valid, a4.pageWidthMm, a4.pageHeightMm)).toBeNull();
  });

  test("accepts the single-side minimum 0mm", () => {
    expect(
      validatePageMargins(
        { ...valid, marginTopMm: 0, marginBottomMm: 0 },
        a4.pageWidthMm,
        a4.pageHeightMm,
      ),
    ).toBeNull();
  });

  test("accepts the single-side maximum 60mm", () => {
    expect(
      validatePageMargins(
        { ...valid, marginTopMm: 60, marginBottomMm: 60 },
        a4.pageWidthMm,
        a4.pageHeightMm,
      ),
    ).toBeNull();
  });

  test("accepts the Word wide preset on A4", () => {
    expect(
      validatePageMargins(
        { ...valid, marginLeftMm: 50.8, marginRightMm: 50.8 },
        a4.pageWidthMm,
        a4.pageHeightMm,
      ),
    ).toBeNull();
  });

  test("rejects a single side above 60mm", () => {
    expect(
      validatePageMargins({ ...valid, marginLeftMm: 60.1 }, a4.pageWidthMm, a4.pageHeightMm),
    ).toMatch(/不能超过 60mm/u);
  });

  test("rejects a negative single side", () => {
    expect(
      validatePageMargins({ ...valid, marginRightMm: -1 }, a4.pageWidthMm, a4.pageHeightMm),
    ).toMatch(/不能小于 0mm/u);
  });

  test("rejects NaN margin values", () => {
    expect(
      validatePageMargins({ ...valid, marginTopMm: Number.NaN }, a4.pageWidthMm, a4.pageHeightMm),
    ).toMatch(/有效数字/u);
  });

  test("accepts top+bottom exactly equal to pageHeight - 10mm", () => {
    // 页面高 110mm：上+下 ≤ 100mm，恰好顶格（单边 50mm 上限内）。
    expect(
      validatePageMargins({ ...valid, marginTopMm: 50, marginBottomMm: 50 }, 210, 110),
    ).toBeNull();
  });

  test("rejects top+bottom that exceed pageHeight - 10mm by 1mm", () => {
    // 页面高 109mm：上+下 ≤ 99mm，100mm 超出 1mm。
    expect(
      validatePageMargins({ ...valid, marginTopMm: 50, marginBottomMm: 50 }, 210, 109),
    ).toMatch(/上、下边距之和过大/u);
  });

  test("accepts left+right exactly equal to pageWidth - 10mm", () => {
    // 页面宽 110mm：左+右 ≤ 100mm，恰好顶格。
    expect(
      validatePageMargins({ ...valid, marginLeftMm: 50, marginRightMm: 50 }, 110, 297),
    ).toBeNull();
  });

  test("rejects left+right that exceed pageWidth - 10mm by 1mm", () => {
    // 页面宽 109mm：左+右 ≤ 99mm，100mm 超出 1mm。
    expect(
      validatePageMargins({ ...valid, marginLeftMm: 50, marginRightMm: 50 }, 109, 297),
    ).toMatch(/左、右边距之和过大/u);
  });

  test("returns a page-size error when the page dimensions are not finite", () => {
    expect(validatePageMargins(valid, Number.NaN, 297)).toMatch(/页面尺寸无效/u);
    expect(validatePageMargins(valid, 210, Number.POSITIVE_INFINITY)).toMatch(/页面尺寸无效/u);
  });

  test("validates against non-A4 page sizes", () => {
    // 100x100 page: left+right must be <= 90
    expect(
      validatePageMargins({ ...valid, marginLeftMm: 45, marginRightMm: 45 }, 100, 100),
    ).toBeNull();
    expect(
      validatePageMargins({ ...valid, marginLeftMm: 45, marginRightMm: 46 }, 100, 100),
    ).toMatch(/左、右边距之和过大/u);
  });
});
