import { describe, expect, test } from "vitest";
import { createBlankDocument } from "../../shared/document/defaults.js";
import type { CanonicalDocument } from "../../shared/document/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { millimetresToTwips } from "./docx-exporter.js";
import { renderPrintHtml } from "./print-template.js";

/**
 * 导出一致性验证（T05）：
 * 导出层（docx-exporter / print-template）不改代码，只从 document.page 读取边距。
 * 这里验证：给定 document.page = 新默认值（25.4/31.7/25.4/31.7），
 * 打印模板 @page margin 与 DOCX twips 换算正确。
 */
describe("export layer consistency with Word default page margins", () => {
  test("DOCX twips conversion maps 25.4mm to one inch and 31.7mm to the Word side margin", () => {
    // millimetresToTwips = Math.round(mm * 1440 / 25.4)
    expect(millimetresToTwips(25.4)).toBe(1440);
    expect(millimetresToTwips(31.7)).toBe(Math.round((31.7 * 1440) / 25.4));
    expect(millimetresToTwips(0)).toBe(0);
  });

  test("print template emits @page margin from document.page under default A4 settings", async () => {
    const document = createBlankDocument("导出一致性");
    expect(document.page).toEqual({
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });

    const html = await renderPrintHtml(document, [] as StoredAsset[]);

    expect(html).toContain("@page { size: A4 portrait; margin: 25.4mm 31.7mm 25.4mm 31.7mm; }");
    // The printable content excludes @page margins; a full-sheet minimum adds a blank page.
    expect(html).not.toContain("min-height: 297mm");
  });

  test("print template follows a custom page.margin when provided", async () => {
    const document = createBlankDocument("自定义边距");
    (document as CanonicalDocument).page = {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 30,
      marginRightMm: 20,
      marginBottomMm: 30,
      marginLeftMm: 20,
    };

    const html = await renderPrintHtml(document, [] as StoredAsset[]);

    expect(html).toContain("@page { size: A4 portrait; margin: 30mm 20mm 30mm 20mm; }");
  });

  test("content width under Word defaults leaves 146.6mm for A4", () => {
    const document = createBlankDocument("内容区");
    const contentWidthMm = Math.max(
      1,
      document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm,
    );
    const contentHeightMm = Math.max(
      1,
      document.page.heightMm - document.page.marginTopMm - document.page.marginBottomMm,
    );
    expect(contentWidthMm).toBeCloseTo(146.6, 9);
    expect(contentHeightMm).toBeCloseTo(246.2, 9);
  });
});
