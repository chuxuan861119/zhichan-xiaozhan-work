import {
  createBlankDocument,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../shared/document/defaults.js";
import type { TableNode } from "../../shared/document/model.js";
import {
  fitCanonicalTableToPage,
  fitDocumentTables,
  tableExceedsPage,
} from "../../shared/document/table-page-fit.js";
import { AssetStore } from "../assets/asset-store.js";
import { createDocxPackage } from "./docx-exporter.js";
import { renderPrintHtml } from "./print-template.js";

function table(columns = 3): TableNode {
  return {
    type: "table",
    id: crypto.randomUUID(),
    layoutMode: "fixed",
    columnWidthsMm: Array(columns).fill(60),
    rows: [
      {
        id: crypto.randomUUID(),
        cells: Array.from({ length: columns }, (_, i) => ({
          id: crypto.randomUUID(),
          rowSpan: 1,
          colSpan: 1,
          horizontalAlignment: "left",
          verticalAlignment: "middle",
          borderStyle: "single",
          content: [
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES, lineSpacing: 1 },
              content: [{ type: "text", text: `实验数据${i}`, marks: [] }],
            },
          ],
        })),
      },
    ],
  };
}
test("page fitting preserves contents, formatting and original data", () => {
  const original = table(),
    before = structuredClone(original);
  const fit = fitCanonicalTableToPage(original, 146.6)!;
  expect(fit.columnWidthsMm.reduce((a, b) => a + b, 0)).toBeCloseTo(146.6);
  expect(fit.rows).toBe(original.rows);
  expect(original).toEqual(before);
  expect(tableExceedsPage(original, 146.6)).toBe(true);
  expect(tableExceedsPage(fit, 146.6)).toBe(false);
});
test("a margin change fails atomically when one table cannot fit", () => {
  const document = createBlankDocument("边距");
  document.content = [table(2), table(20)];
  const before = structuredClone(document);
  expect(
    fitDocumentTables(document, { ...document.page, marginLeftMm: 50, marginRightMm: 50 }),
  ).toBeNull();
  expect(document).toEqual(before);
});
test("DOCX and PDF rendering reject oversized tables before producing output", async () => {
  const document = createBlankDocument("超宽表格");
  document.content = [table()];
  await expect(
    createDocxPackage({ sessionId: "test", document }, new AssetStore()),
  ).rejects.toThrow("表格");
  await expect(renderPrintHtml(document, [])).rejects.toThrow("表格");
});
test("new imports fit widths but legacy reads preserve their original geometry", () => {
  const document = createBlankDocument("导入");
  document.content = [table()];
  expect(fitDocumentTables(document, document.page)!.content[0]).toBe(document.content[0]);
  const imported = fitDocumentTables(document, document.page, false)!;
  expect(tableExceedsPage(imported.content[0] as TableNode, 146.6)).toBe(false);
  document.content = [table(30)];
  expect(fitDocumentTables(document, document.page, false)).toBeNull();
});
