import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { renderPrintHtml } from "../../src/main/exports/print-template.js";
import { CanonicalDocumentSchema } from "../../src/shared/document/model.js";

for (const merged of [false, true])
  test(`printed tables respect row heights and fixed narrow widths (merged=${merged})`, async () => {
    const document = CanonicalDocumentSchema.parse(
      JSON.parse(await readFile(resolve("tests/fixtures/documents/export-reference.json"), "utf8")),
    );
    const table = document.content.find((node) => node.type === "table");
    if (!table?.rows[0] || !table.rows[1]) throw new Error("Missing table fixture");
    document.content = [table];
    document.assets = [];
    table.layoutMode = "fixed";
    table.columnWidthsMm = merged ? [15, 15, 15] : [15, 15];
    table.rows[0].rowHeightMm = 12;
    table.rows[0].rowHeightRule = "exact";
    table.rows[1].rowHeightMm = 30;
    table.rows[1].rowHeightRule = merged ? "exact" : "at-least";
    for (const [index, row] of table.rows.entries()) {
      for (const cell of row.cells) {
        if (!merged) {
          cell.rowSpan = 1;
          cell.colSpan = 1;
        }
        const paragraph = cell.content[0];
        if (!paragraph) throw new Error("Missing cell paragraph");
        paragraph.content = [
          { type: "text", text: index === 0 ? "长内容测试".repeat(30) : "1", marks: [] },
        ];
      }
    }
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.emulateMedia({ media: "print" });
      await page.setContent(await renderPrintHtml(document, []));
      const mm = 96 / 25.4;
      const heights = await page
        .locator("tr")
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      const [firstHeight, secondHeight] = heights;
      if (firstHeight === undefined || secondHeight === undefined)
        throw new Error("Missing rendered rows");
      expect(firstHeight / mm).toBeLessThan(13);
      expect(secondHeight / mm).toBeGreaterThanOrEqual(29.8);
      const width = await page
        .locator("table")
        .evaluate((node) => node.getBoundingClientRect().width);
      // Collapsed outside borders add less than one millimetre to the column grid.
      expect(Math.abs(width / mm - table.columnWidthsMm.reduce((a, b) => a + b, 0))).toBeLessThan(
        1,
      );
      expect((await page.pdf({ format: "A4" })).length).toBeGreaterThan(1000);
    } finally {
      await browser.close();
    }
  });
