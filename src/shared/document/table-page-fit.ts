import type { PageSettings, TableNode } from "./model.js";
import {
  normalizeTableColumnWidths,
  resolveTableColumnWidthsMm,
  tableGridColumnCount,
} from "./table-column-widths.js";
import { type CellWidthConstraint, fitConstrainedWidths } from "./table-width-solver.js";

const PX_PER_MM = 96 / 25.4;
export function pageBodyWidthMm(page: PageSettings): number {
  return page.widthMm - page.marginLeftMm - page.marginRightMm;
}

export function canonicalTableConstraints(table: TableNode): CellWidthConstraint[] {
  const width = tableGridColumnCount(table);
  if (!width) return [];
  const occupied = Array<number>(width).fill(0),
    result: CellWidthConstraint[] = [];
  table.rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      while ((occupied[column] ?? 0) > rowIndex) column++;
      let font = 0,
        objectWidth = 0;
      for (const paragraph of cell.content) {
        font = Math.max(font, paragraph.attrs.defaultFontSizePt);
        for (const inline of paragraph.content) {
          if (inline.type === "text")
            for (const mark of inline.marks) {
              if (mark.type === "font-size") font = Math.max(font, mark.valuePt);
            }
          if (inline.type === "inline-figure")
            objectWidth = Math.max(objectWidth, inline.widthMm * PX_PER_MM);
        }
      }
      const padding = ((cell.paddingMm?.left ?? 2) + (cell.paddingMm?.right ?? 2)) * PX_PER_MM;
      result.push({
        left: column,
        right: column + cell.colSpan,
        minimum: Math.max(40, padding + Math.max((font * 96) / 72, objectWidth) + 2),
      });
      for (let i = column; i < column + cell.colSpan; i++) occupied[i] = rowIndex + cell.rowSpan;
      column += cell.colSpan;
    }
  });
  return result;
}

/** Only adjust widths. Content, typography, borders and manual minimum heights are retained. */
export function fitCanonicalTableToPage(table: TableNode, bodyMm: number): TableNode | null {
  const normalized = normalizeTableColumnWidths(table);
  if (!tableGridColumnCount(normalized)) return null;
  const widths = resolveTableColumnWidthsMm(normalized, bodyMm).map((w) => w * PX_PER_MM);
  const total = widths.reduce((a, b) => a + b, 0);
  const constraints = canonicalTableConstraints(normalized);
  const fitted =
    fitConstrainedWidths(widths, Math.min(total, bodyMm * PX_PER_MM), constraints) ??
    fitConstrainedWidths(widths, bodyMm * PX_PER_MM, constraints);
  if (!fitted) return null;
  if (fitted.every((w, i) => Math.abs(w - (widths[i] ?? 0)) < 0.01)) return normalized;
  return { ...normalized, columnWidthsMm: fitted.map((w) => w / PX_PER_MM) };
}

export function tableExceedsPage(table: TableNode, bodyMm: number): boolean {
  const widths = resolveTableColumnWidthsMm(table, bodyMm);
  return (
    widths.reduce((a, b) => a + b, 0) > bodyMm + 0.01 ||
    fitConstrainedWidths(
      widths.map((w) => w * PX_PER_MM),
      bodyMm * PX_PER_MM,
      canonicalTableConstraints(table),
    ) === null
  );
}

export function fitDocumentTables<
  T extends { page: PageSettings; content: readonly { type: string }[] },
>(document: T, page: PageSettings, preserveLegacyOverflow = true): T | null {
  const content = [];
  for (const node of document.content) {
    if (node.type !== "table") {
      content.push(node);
      continue;
    }
    if (preserveLegacyOverflow && pageBodyWidthMm(page) >= pageBodyWidthMm(document.page)) {
      content.push(node);
      continue;
    }
    const fitted = fitCanonicalTableToPage(node as TableNode, pageBodyWidthMm(page));
    if (!fitted) return null;
    content.push(fitted);
  }
  return { ...document, page, content };
}
