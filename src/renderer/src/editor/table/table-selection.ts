import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { CellSelection, mergeCells, TableMap } from "@tiptap/pm/tables";
import { hasFirstRowHeader } from "./table-header-state";
import {
  editorContentWidthMm,
  renderedTableWidthMm,
  scaleColumnWidths,
} from "./table-layout-width";
import { fitConstrainedWidths, tableWidthConstraints } from "./table-width-constraints";

export type TableSelectionKind = "none" | "text" | "cell" | "cells" | "row" | "column" | "table";
export type Mixed<T> = T | "mixed" | null;

export type TableSelectionSnapshot = {
  kind: TableSelectionKind;
  tableFrom: number | null;
  rowCount: number;
  columnCount: number;
  selectedCellCount: number;
  horizontalAlignment: Mixed<"left" | "center" | "right" | "justify">;
  verticalAlignment: Mixed<"top" | "middle" | "bottom">;
  borderStyle: Mixed<"none" | "single" | "double">;
  rowHeightMm: Mixed<number>;
  rowHeightRule: Mixed<"at-least" | "exact">;
  columnWidthMm: Mixed<number>;
  layoutMode: "fit-page" | "fixed" | null;
  selectedRowIndexes: readonly number[];
  selectedColumnIndexes: readonly number[];
  canMerge: boolean;
  canSplit: boolean;
  canAddRowBefore: boolean;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
  lineSpacing?: Mixed<number>;
  padding?: Record<"top" | "right" | "bottom" | "left", Mixed<number>>;
  overflowsPage?: boolean;
  firstRowHeader?: boolean;
  tableAlignment?: "left" | "center" | "right";
  tableNameEnabled?: boolean;
  tableName?: string;
  tableNoteEnabled?: boolean;
  tableNote?: string;
};

export const EMPTY_TABLE_SELECTION: TableSelectionSnapshot = {
  kind: "none",
  tableFrom: null,
  rowCount: 0,
  columnCount: 0,
  selectedCellCount: 0,
  horizontalAlignment: null,
  verticalAlignment: null,
  borderStyle: null,
  rowHeightMm: null,
  rowHeightRule: null,
  columnWidthMm: null,
  layoutMode: null,
  selectedRowIndexes: [],
  selectedColumnIndexes: [],
  canMerge: false,
  canSplit: false,
  canAddRowBefore: false,
  canDeleteRow: false,
  canDeleteColumn: false,
};

type TableContext = {
  table: ProseMirrorNode;
  tableFrom: number;
  tableStart: number;
  map: TableMap;
};

function tableContext($position: ResolvedPos): TableContext | null {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if ($position.node(depth).type.spec.tableRole !== "table") continue;
    const tableFrom = $position.before(depth);
    const tableStart = $position.start(depth);
    const table = $position.node(depth);
    return { table, tableFrom, tableStart, map: TableMap.get(table) };
  }
  return null;
}

function containingCellPosition($position: ResolvedPos): number | null {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const role = $position.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return $position.before(depth);
  }
  return null;
}

function uniform<T>(values: readonly T[]): Mixed<T> {
  if (values.length === 0) return null;
  return values.every((value) => value === values[0]) ? (values[0] ?? null) : "mixed";
}

function roundedMillimetres(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1_000) / 1_000;
}

function selectedIndexes(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function selectedCellOffsets(
  map: TableMap,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const offsets = new Set<number>();
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      offsets.add(map.map[row * map.width + column] ?? 0);
    }
  }
  return [...offsets].filter((offset) => offset > 0);
}

function kindForRange(
  map: TableMap,
  left: number,
  top: number,
  right: number,
  bottom: number,
  cellCount: number,
): TableSelectionKind {
  if (cellCount === 1) return "cell";
  if (left === 0 && top === 0 && right === map.width && bottom === map.height) return "table";
  if (left === 0 && right === map.width) return "row";
  if (top === 0 && bottom === map.height) return "column";
  return "cells";
}

export function inspectTableSelection(editor: Editor): TableSelectionSnapshot {
  const { selection } = editor.state;
  const context = tableContext(selection.$from);
  if (!context) return EMPTY_TABLE_SELECTION;

  const { map, table, tableFrom, tableStart } = context;
  let left: number;
  let right: number;
  let top: number;
  let bottom: number;
  let kind: TableSelectionKind;

  if (selection instanceof CellSelection) {
    const anchor = map.findCell(selection.$anchorCell.pos - tableStart);
    const head = map.findCell(selection.$headCell.pos - tableStart);
    left = Math.min(anchor.left, head.left);
    right = Math.max(anchor.right, head.right);
    top = Math.min(anchor.top, head.top);
    bottom = Math.max(anchor.bottom, head.bottom);
  } else {
    const cellPosition = containingCellPosition(selection.$from);
    if (cellPosition === null) return EMPTY_TABLE_SELECTION;
    const rectangle = map.findCell(cellPosition - tableStart);
    ({ left, right, top, bottom } = rectangle);
    kind = "text";
  }

  const offsets = selectedCellOffsets(map, left, top, right, bottom);
  const cells = offsets
    .map((offset) => editor.state.doc.nodeAt(tableStart + offset))
    .filter((cell): cell is ProseMirrorNode => cell !== null);
  if (cells.length === 0) return EMPTY_TABLE_SELECTION;
  if (!(selection instanceof CellSelection)) kind = "text";
  else kind = kindForRange(map, left, top, right, bottom, cells.length);

  const horizontal: Array<"left" | "center" | "right" | "justify"> = [];
  const inheritedAlignment = (cell: ProseMirrorNode) =>
    cell.attrs.horizontalAlignment === "center" || cell.attrs.horizontalAlignment === "right"
      ? cell.attrs.horizontalAlignment
      : cell.type.spec.tableRole === "header_cell"
        ? "center"
        : "left";
  if (selection instanceof CellSelection) {
    cells.forEach((cell) => {
      cell.descendants((paragraph) => {
        if (paragraph.type.name === "paragraph")
          horizontal.push(paragraph.attrs.textAlign ?? inheritedAlignment(cell));
      });
    });
  } else {
    editor.state.doc.nodesBetween(selection.from, selection.to, (paragraph, position) => {
      if (paragraph.type.name !== "paragraph") return;
      const parent = editor.state.doc.resolve(position).parent;
      horizontal.push(paragraph.attrs.textAlign ?? inheritedAlignment(parent));
    });
  }
  const vertical = cells.map((cell) => cell.attrs.verticalAlignment ?? "top") as Array<
    "top" | "middle" | "bottom"
  >;
  const border = cells.flatMap((cell) => {
    const fallback =
      cell.attrs.borderStyle === "none" || cell.attrs.borderStyle === "double"
        ? cell.attrs.borderStyle
        : "single";
    return [
      cell.attrs.borderTop ?? fallback,
      cell.attrs.borderRight ?? fallback,
      cell.attrs.borderBottom ?? fallback,
      cell.attrs.borderLeft ?? fallback,
    ] as Array<"none" | "single" | "double">;
  });
  const onlyCell = cells.length === 1 ? (cells[0] ?? null) : null;
  const selectedRowIndexes = selectedIndexes(top, bottom);
  const selectedColumnIndexes = selectedIndexes(left, right);
  const selectedRows = selectedRowIndexes
    .map((rowIndex) => table.child(rowIndex))
    .filter((row): row is ProseMirrorNode => row !== null);
  const rowHeights = selectedRows.map((row) => roundedMillimetres(row.attrs.rowHeightMm));
  const rowRules = selectedRows.map((row) =>
    row.attrs.rowHeightRule === "at-least" || row.attrs.rowHeightRule === "exact"
      ? row.attrs.rowHeightRule
      : null,
  );
  const storedWidths = Array.isArray(table.attrs.columnWidthsMm) ? table.attrs.columnWidthsMm : [];
  const displayedWidths = scaleColumnWidths(
    storedWidths,
    table.attrs.layoutMode === "fixed" ? null : renderedTableWidthMm(editor, tableFrom),
  );
  const columnWidths = Array.isArray(table.attrs.columnWidthsMm)
    ? selectedColumnIndexes.map((columnIndex) => roundedMillimetres(displayedWidths[columnIndex]))
    : [];

  const lineSpacings: number[] = [];
  if (selection instanceof CellSelection)
    cells.forEach((cell) => {
      cell.descendants((node) => {
        if (node.type.name === "paragraph") lineSpacings.push(node.attrs.lineHeight ?? 1.5);
      });
    });
  else
    editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if (node.type.name === "paragraph") lineSpacings.push(node.attrs.lineHeight ?? 1.5);
    });
  const padding = (side: string) =>
    uniform(cells.map((cell) => cell.attrs[`padding${side}Mm`] ?? 2));
  const contentWidth = editorContentWidthMm(editor);
  const tableWidth = renderedTableWidthMm(editor, tableFrom);

  return {
    lineSpacing: uniform(lineSpacings),
    padding: {
      top: padding("Top"),
      right: padding("Right"),
      bottom: padding("Bottom"),
      left: padding("Left"),
    },
    overflowsPage:
      !!(contentWidth && tableWidth && tableWidth > contentWidth + 0.5) ||
      !fitConstrainedWidths(
        Array(map.width).fill(1),
        ((contentWidth ?? 165) * 96) / 25.4,
        tableWidthConstraints(table),
      ),
    firstRowHeader: hasFirstRowHeader(table),
    kind,
    tableFrom,
    rowCount: bottom - top,
    columnCount: right - left,
    selectedCellCount: cells.length,
    horizontalAlignment: uniform(horizontal),
    verticalAlignment: uniform(vertical),
    borderStyle: uniform(border),
    rowHeightMm: uniform(rowHeights),
    rowHeightRule: uniform(rowRules),
    columnWidthMm: uniform(columnWidths),
    layoutMode: table.attrs.layoutMode === "fixed" ? "fixed" : "fit-page",
    tableAlignment: table.attrs.tableAlignment ?? "left",
    tableNameEnabled: table.attrs.tableNameEnabled === true,
    tableName: table.attrs.tableName ?? "",
    tableNoteEnabled: table.attrs.tableNoteEnabled === true,
    tableNote: table.attrs.tableNote ?? "",
    selectedRowIndexes,
    selectedColumnIndexes,
    canMerge: selection instanceof CellSelection && cells.length > 1 && mergeCells(editor.state),
    canSplit:
      onlyCell !== null && ((onlyCell.attrs.colspan ?? 1) > 1 || (onlyCell.attrs.rowspan ?? 1) > 1),
    canAddRowBefore: !(top === 0 && table.firstChild?.firstChild?.type.name === "tableHeader"),
    canDeleteRow: bottom - top < map.height,
    canDeleteColumn: right - left < map.width,
  };
}
