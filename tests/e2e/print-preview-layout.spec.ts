import { chromium, expect, test } from "@playwright/test";
import {
  renderPrintDocumentsHtml,
  renderPrintHtml,
} from "../../src/main/exports/print-template.js";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createDefaultPrintSettings } from "../../src/shared/printing/model.js";

test("printed patent headers repeat and preserve paper and text geometry", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const margin of [25.4, 40, 15]) {
      const document = createBlankDocument("说明书");
      document.page.marginTopMm = margin;
      document.page.marginLeftMm = 31.7;
      document.page.marginRightMm = 31.7;
      const paragraph = {
        id: crypto.randomUUID(),
        type: "paragraph" as const,
        attrs: {
          alignment: "left" as const,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 14,
          lineSpacing: 1.5,
          paragraphIndentMm: 0,
        },
        content: [{ type: "text" as const, text: "正文测试", marks: [] }],
      };
      document.content = [
        paragraph,
        { id: crypto.randomUUID(), type: "page-break" },
        { ...paragraph, id: crypto.randomUUID() },
      ];
      await page.setContent(await renderPrintHtml(document, [], { patentBookLayout: true }));
      await page.evaluate(() => globalThis.document.fonts.ready);
      const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      const loading = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
      const pdf = await loading.promise;
      try {
        expect(pdf.numPages).toBe(2);
        for (let index = 1; index <= pdf.numPages; index++) {
          const sheet = await pdf.getPage(index);
          const viewport = sheet.getViewport({ scale: 1 });
          expect(viewport.width).toBeCloseTo((210 * 72) / 25.4, 0);
          const text = (await sheet.getTextContent()).items.filter((item) => "str" in item);
          const header = text.find((item) => item.str.includes("说明书"));
          const body = text.find((item) => item.str.includes("正文测试"));
          expect(header, `page ${index}, margin ${margin}`).toBeDefined();
          expect(body).toBeDefined();
          if (!header || !body) throw new Error("Missing printed header or body");
          expect(body.transform[4]).toBeCloseTo((31.7 * 72) / 25.4, 0);
          expect(body.height).toBeCloseTo(14, 0);
          const bodyTop = viewport.height - body.transform[5] - body.height;
          expect(bodyTop).toBeGreaterThanOrEqual((margin * 72) / 25.4 - 1);
          expect(bodyTop).toBeLessThan((margin * 72) / 25.4 + 10);
          expect(header.transform[5]).toBeGreaterThan(body.transform[5]);
        }
      } finally {
        await loading.destroy();
      }
    }
  } finally {
    await browser.close();
  }
});

test("combined preview starts every book on a new page and changes its running header", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    const titles = ["说明书摘要", "摘要附图", "权利要求书", "说明书", "说明书附图"];
    const documents = titles.map((title) => {
      const document = createBlankDocument(title);
      document.content = [];
      return document;
    });
    await page.setContent(
      await renderPrintDocumentsHtml(documents, [], createDefaultPrintSettings().layout),
    );
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const loading = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
    const pdf = await loading.promise;
    try {
      expect(pdf.numPages).toBe(5);
      for (const [index, title] of titles.entries()) {
        const sheet = await pdf.getPage(index + 1);
        const text = (await sheet.getTextContent()).items
          .filter((item) => "str" in item)
          .map((item) => item.str)
          .join("");
        expect(text).toBe(title);
      }
    } finally {
      await loading.destroy();
    }
  } finally {
    await browser.close();
  }
});
