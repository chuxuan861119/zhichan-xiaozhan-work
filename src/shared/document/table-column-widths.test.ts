import type { TableNode } from "./model.js";
import { normalizeTableColumnWidths } from "./table-column-widths.js";

function table(): TableNode {
  const cell = (rowSpan = 1, colSpan = 1) => ({
    id: crypto.randomUUID(),
    rowSpan,
    colSpan,
    horizontalAlignment: "left" as const,
    verticalAlignment: "top" as const,
    borderStyle: "single" as const,
    content: [],
  });
  return {
    id: crypto.randomUUID(),
    type: "table",
    columnWidthsMm: [20, 30, 40, 50],
    rows: [
      { id: crypto.randomUUID(), cells: [cell(2), cell(1, 2)] },
      { id: crypto.randomUUID(), cells: [cell(), cell()] },
    ],
  };
}
test("normalizes metadata using logical columns including horizontal and vertical merges", () => {
  const original = table();
  const normalized = normalizeTableColumnWidths(original);
  expect(normalized.columnWidthsMm).toEqual([20, 30, 40]);
  expect(normalized.rows).toBe(original.rows);
  expect(original.columnWidthsMm).toHaveLength(4);
});
test("never disguises a ragged table as a width metadata repair", () => {
  const original = table();
  original.rows[1]?.cells.pop();
  expect(normalizeTableColumnWidths(original)).toBe(original);
});
test("keeps exact valid metadata and does not guess missing grid columns", () => {
  const original = table();
  original.columnWidthsMm = [20, 30, 40];
  expect(normalizeTableColumnWidths(original)).toBe(original);
  original.columnWidthsMm = [20];
  expect(normalizeTableColumnWidths(original)).toBe(original);
});
