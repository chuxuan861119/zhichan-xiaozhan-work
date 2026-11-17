import type { TableNode } from "./model.js";

/** Fit-page widths are proportions in the editor, not fixed physical dimensions. */
export function resolveTableColumnWidthsMm(table: TableNode, contentWidthMm: number): number[] {
  const widths = normalizeTableColumnWidths(table).columnWidthsMm;
  if (table.layoutMode === "fixed") return [...widths];
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map((width) => (width / total) * contentWidthMm);
}

/** Derive the rectangular grid from cells, independently of potentially stale width metadata. */
export function tableGridColumnCount(table: {
  rows: readonly { cells: readonly { rowSpan: number; colSpan: number }[] }[];
}): number | null {
  const width = table.rows[0]?.cells.reduce((sum, cell) => sum + cell.colSpan, 0) ?? 0;
  if (width < 1 || width > 1_000) return null;
  const occupied = Array<number>(width).fill(0);
  for (const [rowIndex, row] of table.rows.entries()) {
    let column = 0;
    const skipOccupied = () => {
      while (column < width && (occupied[column] ?? 0) > rowIndex) column += 1;
    };
    for (const cell of row.cells) {
      skipOccupied();
      const end = column + cell.colSpan;
      if (
        end > width ||
        rowIndex + cell.rowSpan > table.rows.length ||
        occupied.slice(column, end).some((until) => until > rowIndex)
      )
        return null;
      for (; column < end; column += 1) occupied[column] = rowIndex + cell.rowSpan;
    }
    skipOccupied();
    if (column !== width) return null;
  }
  return width;
}

/** Repair width metadata only. Never invent/remove cells or reinterpret malformed merges. */
export function normalizeTableColumnWidths(table: TableNode): TableNode {
  const width = tableGridColumnCount(table);
  if (width === null || table.columnWidthsMm.length <= width) return table;
  return {
    ...table,
    columnWidthsMm: table.columnWidthsMm.slice(0, width),
  };
}
