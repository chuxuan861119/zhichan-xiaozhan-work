import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { defaultDocumentFontSizePt } from "../../../../shared/document/font-policy";
import {
  TABLE_ROW_HEIGHT_MAX_MM,
  TABLE_ROW_HEIGHT_MIN_MM,
} from "../../../../shared/document/model";
import type { TableAnnotationUpdate } from "../../../../shared/document/table-annotations";
import { randomUuid } from "../../../../shared/id";
import { showAppAlert } from "../../shared/app-dialog";
import { PATENT_TABLE_CELL_MIN_WIDTH_PX } from "../nodes/table-nodes";
import { type CellWidthMeasurement, calculateContentColumnWidths } from "./table-autofit";
import { TABLE_COMMAND_COLUMN_WIDTH_META } from "./table-column-width-sync";
import { hasFirstRowHeader } from "./table-header-state";
import {
  prepareTableDeletionAnimation,
  prepareTableInsertionAnimation,
  prepareTableLayoutAnimation,
} from "./table-insertion-animation";
import {
  editorContentWidthMm,
  renderedTableWidthMm,
  scaleColumnWidths,
} from "./table-layout-width";
import { inspectTableSelection } from "./table-selection";
import { buildSplitTable, type TableSplitRequest } from "./table-split";
import { fitConstrainedWidths, tableWidthConstraints } from "./table-width-constraints";
import { normalizeTableTransaction, TABLE_WIDTH_MESSAGE } from "./table-width-policy";

function enforceTableWidth(editor: Editor, tr: Transaction): boolean {
  if (normalizeTableTransaction(tr, editorContentWidthMm(editor) ?? 165)) return true;
  // Tiptap chains dispatch even when a command returns false unless explicitly cancelled.
  tr.setMeta("preventDispatch", true);
  showAppAlert(TABLE_WIDTH_MESSAGE);
  return false;
}

export type TableInsertRequest = {
  rows: number;
  columns: number;
  headerRowCount: 0 | 1;
  layoutMode: "fit-page" | "fixed";
};

export type TableCommand =
  | "add-column-before"
  | "add-column-after"
  | "delete-column"
  | "add-row-before"
  | "add-row-after"
  | "delete-row"
  | "delete-table"
  | "merge-cells"
  | "split-cell"
  | "clear-cells"
  | "auto-fit-content"
  | "auto-arrange"
  | "align-table-left"
  | "align-table-center"
  | "align-table-right"
  | "fit-page"
  | "fixed-width"
  | "distribute-columns"
  | "distribute-rows"
  | "toggle-header-row";

export type TableCellAttribute = "horizontalAlignment" | "verticalAlignment" | "borderStyle";
export type TableBorderPreset = "all" | "outer" | "inner" | "none";
export type TableRowHeightRule = "at-least" | "exact";
export type TableRowHeightRequest = {
  heightMm: number;
  rule: TableRowHeightRule;
};
export type TableFormattingRequest = {
  lineSpacing?: number;
  padding?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  autoHeight?: boolean;
  compact?: boolean;
};
type BorderStyle = "single" | "double";
const PRINTABLE_WIDTH_MM = 165;
const DEFAULT_COLUMN_WIDTH_PX = 113;
const TABLE_COLUMN_WIDTH_MIN_MM = 10;
const TABLE_COLUMN_WIDTH_MAX_MM = 300;

type SelectedTableCells = {
  table: ProseMirrorNode;
  tableFrom: number;
  tableStart: number;
  map: TableMap;
  positions: number[];
  rect: { left: number; top: number; right: number; bottom: number };
};

const INHERITED_CELL_FORMATTING_ATTRIBUTES = [
  "paddingTopMm",
  "paddingRightMm",
  "paddingBottomMm",
  "paddingLeftMm",
  "horizontalAlignment",
  "verticalAlignment",
] as const;

const INHERITED_PARAGRAPH_FORMATTING_ATTRIBUTES = [
  "lineHeight",
  "paragraphIndentMm",
  "spaceBeforePt",
  "spaceAfterPt",
  "textAlign",
  "defaultFontFamily",
  "defaultFontSizePt",
] as const;

type InheritedCellFormatting = {
  cell: Record<string, unknown>;
  paragraph: Record<string, unknown> | null;
};

function formattingAttributes(
  attrs: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, attrs[name]]));
}

function inheritedCellFormatting(cell: ProseMirrorNode | null): InheritedCellFormatting | null {
  if (!cell) return null;
  let paragraph: Record<string, unknown> | null = null;
  cell.descendants((node) => {
    if (paragraph || node.type.name !== "paragraph") return;
    paragraph = formattingAttributes(node.attrs, INHERITED_PARAGRAPH_FORMATTING_ATTRIBUTES);
    return false;
  });
  return {
    cell: formattingAttributes(cell.attrs, INHERITED_CELL_FORMATTING_ATTRIBUTES),
    paragraph,
  };
}

export function isBlankTableCell(cell: ProseMirrorNode): boolean {
  if (cell.childCount === 0) return false;
  for (let index = 0; index < cell.childCount; index += 1) {
    const child = cell.child(index);
    if (child.type.name !== "paragraph" || child.content.size !== 0) return false;
  }
  return true;
}

function applyInheritedFormatting(
  transaction: Transaction,
  tableFrom: number,
  target: { axis: "row" | "column"; index: number },
  sourceFormatting: readonly (InheritedCellFormatting | null)[],
): boolean {
  const table = transaction.doc.nodeAt(tableFrom);
  if (table?.type.spec.tableRole !== "table") return false;
  const map = TableMap.get(table);
  const tableStart = tableFrom + 1;
  const seen = new Set<number>();
  const count = target.axis === "row" ? map.width : map.height;
  for (let index = 0; index < count; index += 1) {
    const row = target.axis === "row" ? target.index : index;
    const column = target.axis === "column" ? target.index : index;
    const offset = map.map[row * map.width + column];
    if (offset === undefined || seen.has(offset)) continue;
    const rectangle = map.findCell(offset);
    // When insertion crosses a spanning cell, upstream extends that cell instead of creating one.
    if (
      (target.axis === "row" &&
        (rectangle.top !== target.index || rectangle.bottom !== target.index + 1)) ||
      (target.axis === "column" &&
        (rectangle.left !== target.index || rectangle.right !== target.index + 1))
    )
      continue;
    seen.add(offset);
    const formatting = sourceFormatting[index];
    const position = tableStart + offset;
    const cell = transaction.doc.nodeAt(position);
    if (!formatting || !cell) continue;
    transaction.setNodeMarkup(position, undefined, { ...cell.attrs, ...formatting.cell });
    if (!formatting.paragraph) continue;
    cell.descendants((node, paragraphOffset) => {
      if (node.type.name !== "paragraph") return;
      transaction.setNodeMarkup(position + 1 + paragraphOffset, undefined, {
        ...node.attrs,
        ...formatting.paragraph,
      });
    });
  }
  return true;
}

function selectedTableCells(editor: Editor): SelectedTableCells | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { selection } = editor.state;
  let tableDepth = -1;
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    if (selection.$from.node(depth).type.spec.tableRole === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return null;
  const table = selection.$from.node(tableDepth);
  const tableFrom = selection.$from.before(tableDepth);
  const tableStart = selection.$from.start(tableDepth);
  const map = TableMap.get(table);
  let rect: SelectedTableCells["rect"];
  if (selection instanceof CellSelection) {
    rect = map.rectBetween(
      selection.$anchorCell.pos - tableStart,
      selection.$headCell.pos - tableStart,
    );
  } else {
    let cellPosition: number | null = null;
    for (let depth = selection.$from.depth; depth > tableDepth; depth -= 1) {
      const role = selection.$from.node(depth).type.spec.tableRole;
      if (role === "cell" || role === "header_cell") {
        cellPosition = selection.$from.before(depth);
        break;
      }
    }
    if (cellPosition === null) return null;
    rect = map.findCell(cellPosition - tableStart);
  }
  return {
    table,
    tableFrom,
    tableStart,
    map,
    rect,
    positions: map.cellsInRect(rect).map((offset) => tableStart + offset),
  };
}

export function setTableAnnotation(editor: Editor, update: TableAnnotationUpdate): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const keys = Object.keys(update);
  if (
    !keys.length ||
    keys.some(
      (key) => !["tableNameEnabled", "tableName", "tableNoteEnabled", "tableNote"].includes(key),
    )
  )
    return false;
  if (
    (update.tableName !== undefined &&
      (typeof update.tableName !== "string" || update.tableName.length > 2000)) ||
    (update.tableNote !== undefined &&
      (typeof update.tableNote !== "string" || update.tableNote.length > 10000)) ||
    (update.tableNameEnabled !== undefined && typeof update.tableNameEnabled !== "boolean") ||
    (update.tableNoteEnabled !== undefined && typeof update.tableNoteEnabled !== "boolean")
  )
    return false;
  const tr = keys.some((key) => key.endsWith("Enabled"))
    ? closeHistory(editor.state.tr)
    : editor.state.tr;
  editor.view.dispatch(
    tr.setNodeMarkup(selected.tableFrom, undefined, { ...selected.table.attrs, ...update }),
  );
  return true;
}

export function insertPatentTable(editor: Editor, request: TableInsertRequest): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const animate = prepareTableLayoutAnimation(editor, selectedTableCells(editor)?.tableFrom);
  const result = insertPatentTableWithoutMotion(editor, request);
  if (result) animate();
  return result;
}

function insertPatentTableWithoutMotion(editor: Editor, request: TableInsertRequest): boolean {
  if (
    editor.isDestroyed ||
    !editor.isEditable ||
    !Number.isInteger(request.rows) ||
    !Number.isInteger(request.columns) ||
    request.rows < 1 ||
    request.rows > 100 ||
    request.columns < 1 ||
    request.columns > 30 ||
    editor.isActive("table")
  ) {
    return false;
  }
  const fontSizePt =
    editor.getAttributes("textStyle").fontSizePt ??
    editor.getAttributes("paragraph").defaultFontSizePt ??
    defaultDocumentFontSizePt();
  return editor
    .chain()
    .focus()
    .insertTable({
      rows: request.rows,
      cols: request.columns,
      withHeaderRow: request.headerRowCount === 1,
    })
    .updateAttributes("table", {
      headerRowCount: request.headerRowCount,
      layoutMode: request.layoutMode,
    })
    .fixTables()
    .command(({ tr }) => {
      const $from = tr.selection.$from;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.spec.tableRole !== "table") continue;
        $from.node(depth).descendants((node, offset, parent) => {
          const pos = $from.start(depth) + offset;
          if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell")
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              paddingTopMm: 1,
              paddingBottomMm: 1,
              paddingLeftMm: 2,
              paddingRightMm: 2,
              verticalAlignment: "middle",
              ...(node.type.spec.tableRole === "header_cell"
                ? { horizontalAlignment: "center" }
                : {}),
            });
          else if (node.type.name === "paragraph")
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              lineHeight: 1,
              paragraphIndentMm: 0,
              spaceBeforePt: 0,
              spaceAfterPt: 0,
              defaultFontSizePt: fontSizePt,
              ...(parent?.type.spec.tableRole === "header_cell" ? { textAlign: "center" } : {}),
            });
        });
        break;
      }
      return true;
    })
    .command(({ tr }) => enforceTableWidth(editor, tr))
    .run();
}

export function setTableFormatting(editor: Editor, request: TableFormattingRequest): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  if (
    request.lineSpacing !== undefined &&
    (!Number.isFinite(request.lineSpacing) || request.lineSpacing < 1 || request.lineSpacing > 3)
  )
    return false;
  if (
    request.padding &&
    Object.values(request.padding).some(
      (value) => !Number.isFinite(value) || value < 0 || value > 20,
    )
  )
    return false;
  const tr = closeHistory(editor.state.tr);
  const padding = request.compact ? { top: 1, right: 2, bottom: 1, left: 2 } : request.padding;
  for (const position of selected.positions) {
    const cell = tr.doc.nodeAt(position);
    if (!cell || !padding) continue;
    const attrs = { ...cell.attrs };
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (padding[side] !== undefined)
        attrs[`padding${side[0]?.toUpperCase()}${side.slice(1)}Mm`] = padding[side];
    }
    tr.setNodeMarkup(position, undefined, attrs);
  }
  const lineHeight = request.compact ? 1 : request.lineSpacing;
  if (lineHeight !== undefined) {
    const applyParagraph = (node: ProseMirrorNode, pos: number) => {
      if (node.type.name === "paragraph")
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          lineHeight,
          ...(request.compact ? { spaceBeforePt: 0, spaceAfterPt: 0 } : {}),
        });
    };
    if (request.compact || editor.state.selection instanceof CellSelection) {
      for (const pos of selected.positions) {
        const cell = tr.doc.nodeAt(pos);
        cell?.descendants((node, offset) => applyParagraph(node, pos + 1 + offset));
      }
    } else {
      const { from, to } = editor.state.selection;
      tr.doc.nodesBetween(from, to, (node, pos) => applyParagraph(node, pos));
    }
  }
  if (request.autoHeight)
    selected.table.forEach((row, offset, index) => {
      if (index >= selected.rect.top && index < selected.rect.bottom)
        tr.setNodeMarkup(selected.tableStart + offset, undefined, {
          ...row.attrs,
          rowHeightMm: null,
          rowHeightRule: null,
        });
    });
  if (tr.docChanged) {
    if (!enforceTableWidth(editor, tr)) return false;
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr));
  }
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

export function setSelectedCellAttribute(
  editor: Editor,
  name: TableCellAttribute,
  value: string,
): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const transaction = editor.state.tr;
  for (const position of selected.positions) {
    const cell = transaction.doc.nodeAt(position);
    if (!cell) continue;
    if (cell.attrs[name] !== value)
      transaction.setNodeMarkup(position, undefined, {
        ...cell.attrs,
        [name]: value,
      });
    // Explicit paragraph alignment overrides the cell's inherited CSS alignment.
    // Synchronize even when the cell already matches (for imported/toolbar-formatted text).
    if (name === "horizontalAlignment")
      cell.descendants((node, offset) => {
        if (node.type.name !== "paragraph" || node.attrs.textAlign === value) return;
        transaction.setNodeMarkup(position + 1 + offset, undefined, {
          ...node.attrs,
          textAlign: value,
        });
      });
  }
  if (transaction.docChanged) editor.view.dispatch(transaction);
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

export function setSelectedCellBorders(
  editor: Editor,
  preset: TableBorderPreset,
  style: BorderStyle,
): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const transaction = editor.state.tr;
  for (const position of selected.positions) {
    const cell = transaction.doc.nodeAt(position);
    if (!cell) continue;
    const cellRect = selected.map.findCell(position - selected.tableStart);
    const next = { ...cell.attrs };
    const edgeStyle = preset === "none" ? "none" : style;
    if (
      preset === "all" ||
      preset === "none" ||
      (preset === "outer" && cellRect.top === selected.rect.top)
    )
      next.borderTop = edgeStyle;
    if (
      preset === "all" ||
      preset === "none" ||
      (preset === "outer" && cellRect.right === selected.rect.right)
    )
      next.borderRight = edgeStyle;
    if (
      preset === "all" ||
      preset === "none" ||
      (preset === "outer" && cellRect.bottom === selected.rect.bottom)
    )
      next.borderBottom = edgeStyle;
    if (
      preset === "all" ||
      preset === "none" ||
      (preset === "outer" && cellRect.left === selected.rect.left)
    )
      next.borderLeft = edgeStyle;
    if (preset === "inner") {
      if (cellRect.top > selected.rect.top) next.borderTop = style;
      if (cellRect.right < selected.rect.right) next.borderRight = style;
      if (cellRect.bottom < selected.rect.bottom) next.borderBottom = style;
      if (cellRect.left > selected.rect.left) next.borderLeft = style;
    }
    transaction.setNodeMarkup(position, undefined, next);
  }
  editor.view.dispatch(transaction);
  editor.commands.focus();
  return true;
}

function clearSelectedCells(editor: Editor): boolean {
  const selected = selectedTableCells(editor);
  const paragraph = editor.schema.nodes.paragraph;
  if (!selected || !paragraph) return false;
  const transaction = editor.state.tr;
  for (const position of [...selected.positions].sort((left, right) => right - left)) {
    const cell = transaction.doc.nodeAt(position);
    if (!cell) continue;
    transaction.replaceWith(
      position + 1,
      position + cell.nodeSize - 1,
      paragraph.create({ ...cell.firstChild?.attrs, nodeId: randomUuid() }),
    );
  }
  editor.view.dispatch(transaction);
  editor.commands.focus();
  return true;
}

function currentColumnWidths(selected: SelectedTableCells): number[] {
  const widths = Array.from({ length: selected.map.width }, () => DEFAULT_COLUMN_WIDTH_PX);
  const fullRect = { left: 0, top: 0, right: selected.map.width, bottom: selected.map.height };
  for (const offset of selected.map.cellsInRect(fullRect)) {
    const cell = selected.table.nodeAt(offset);
    if (!cell) continue;
    const rect = selected.map.findCell(offset);
    const colwidth = Array.isArray(cell.attrs.colwidth) ? cell.attrs.colwidth : [];
    for (let index = 0; index < rect.right - rect.left; index += 1) {
      const width = colwidth[index];
      if (typeof width === "number" && width > 0) widths[rect.left + index] = width;
    }
  }
  return widths;
}

function pixelsToMillimetres(pixels: number): number {
  return Math.round(((pixels * 25.4) / 96) * 1_000) / 1_000;
}

function millimetresToPixels(millimetres: number): number {
  return Math.round((millimetres * 96) / 25.4);
}

function currentColumnWidthsMm(selected: SelectedTableCells, editor: Editor): number[] {
  const preciseWidths = selected.table.attrs.columnWidthsMm;
  if (
    Array.isArray(preciseWidths) &&
    preciseWidths.length === selected.map.width &&
    preciseWidths.every((width) => typeof width === "number" && Number.isFinite(width) && width > 0)
  ) {
    return scaleColumnWidths(
      preciseWidths,
      selected.table.attrs.layoutMode === "fixed"
        ? null
        : renderedTableWidthMm(editor, selected.tableFrom),
    );
  }
  return scaleColumnWidths(
    currentColumnWidths(selected).map(pixelsToMillimetres),
    selected.table.attrs.layoutMode === "fixed"
      ? null
      : renderedTableWidthMm(editor, selected.tableFrom),
  );
}

function applyColumnWidths(
  editor: Editor,
  selected: SelectedTableCells,
  widthsPx: readonly number[],
  options: {
    layoutMode?: "fit-page" | "fixed";
    widthsMm?: readonly number[];
    autoHeight?: boolean;
  } = {},
): boolean {
  let transaction = editor.state.tr.setNodeMarkup(selected.tableFrom, undefined, {
    ...selected.table.attrs,
    columnWidthsMm: options.widthsMm ?? widthsPx.map(pixelsToMillimetres),
    ...(options.layoutMode ? { layoutMode: options.layoutMode } : {}),
  });
  const fullRect = { left: 0, top: 0, right: selected.map.width, bottom: selected.map.height };
  for (const offset of selected.map.cellsInRect(fullRect)) {
    const position = selected.tableStart + offset;
    const cell = transaction.doc.nodeAt(position);
    if (!cell) continue;
    const rect = selected.map.findCell(offset);
    transaction = transaction.setNodeMarkup(position, undefined, {
      ...cell.attrs,
      colwidth: widthsPx.slice(rect.left, rect.right),
    });
  }
  if (options.autoHeight)
    selected.table.forEach((row, offset) => {
      transaction = transaction.setNodeMarkup(selected.tableStart + offset, undefined, {
        ...row.attrs,
        rowHeightMm: null,
        rowHeightRule: null,
      });
    });
  if (!enforceTableWidth(editor, transaction)) return false;
  closeHistory(transaction);
  editor.view.dispatch(transaction.setMeta(TABLE_COMMAND_COLUMN_WIDTH_META, true));
  editor.commands.focus();
  return true;
}

export function setSelectedRowHeight(
  editor: Editor,
  request: TableRowHeightRequest,
  logicalRows?: readonly number[],
): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const rows = logicalRows
    ? logicalRows.filter((row) => row >= selected.rect.top && row < selected.rect.bottom)
    : Array.from(
        { length: selected.rect.bottom - selected.rect.top },
        (_, index) => selected.rect.top + index,
      );
  return setTableRowHeightByIndexes(editor, selected.tableFrom, request, rows);
}

export function setTableRowHeightByIndexes(
  editor: Editor,
  tableFrom: number,
  request: TableRowHeightRequest,
  logicalRows: readonly number[],
  options: { compactBlankCells?: boolean } = {},
): boolean {
  if (
    editor.isDestroyed ||
    !Number.isSafeInteger(tableFrom) ||
    !Number.isFinite(request.heightMm) ||
    request.heightMm < TABLE_ROW_HEIGHT_MIN_MM ||
    request.heightMm > TABLE_ROW_HEIGHT_MAX_MM ||
    (request.rule !== "at-least" && request.rule !== "exact")
  ) {
    return false;
  }
  const table = editor.state.doc.nodeAt(tableFrom);
  if (!table || table.type.spec.tableRole !== "table") return false;
  const rows = new Set(logicalRows);
  let transaction = editor.state.tr;
  let changed = false;
  table.forEach((row, offset, rowIndex) => {
    if (!rows.has(rowIndex)) return;
    const rowPosition = tableFrom + 1 + offset;
    if (row.attrs.rowHeightMm !== request.heightMm || row.attrs.rowHeightRule !== request.rule) {
      transaction = transaction.setNodeMarkup(rowPosition, undefined, {
        ...row.attrs,
        rowHeightMm: request.heightMm,
        rowHeightRule: request.rule,
      });
      changed = true;
    }
    if (!options.compactBlankCells) return;
    row.forEach((cell, cellOffset) => {
      if (!isBlankTableCell(cell)) return;
      const cellPosition = rowPosition + 1 + cellOffset;
      const compactCell = {
        ...cell.attrs,
        paddingTopMm: 1,
        paddingRightMm: 2,
        paddingBottomMm: 1,
        paddingLeftMm: 2,
      };
      if (
        cell.attrs.paddingTopMm !== 1 ||
        cell.attrs.paddingRightMm !== 2 ||
        cell.attrs.paddingBottomMm !== 1 ||
        cell.attrs.paddingLeftMm !== 2
      ) {
        transaction = transaction.setNodeMarkup(cellPosition, undefined, compactCell);
        changed = true;
      }
      cell.forEach((paragraph, paragraphOffset) => {
        if (paragraph.type.name !== "paragraph") return;
        if (
          paragraph.attrs.lineHeight === 1 &&
          paragraph.attrs.paragraphIndentMm === 0 &&
          paragraph.attrs.spaceBeforePt === 0 &&
          paragraph.attrs.spaceAfterPt === 0
        )
          return;
        transaction = transaction.setNodeMarkup(cellPosition + 1 + paragraphOffset, undefined, {
          ...paragraph.attrs,
          lineHeight: 1,
          paragraphIndentMm: 0,
          spaceBeforePt: 0,
          spaceAfterPt: 0,
        });
        changed = true;
      });
    });
  });
  if (!changed) return true;
  editor.view.dispatch(transaction);
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

export function setSelectedColumnWidth(editor: Editor, widthMm: number): boolean {
  if (
    editor.isDestroyed ||
    !Number.isFinite(widthMm) ||
    widthMm < TABLE_COLUMN_WIDTH_MIN_MM ||
    widthMm > TABLE_COLUMN_WIDTH_MAX_MM
  ) {
    return false;
  }
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const widthsMm = currentColumnWidthsMm(selected, editor);
  for (let column = selected.rect.left; column < selected.rect.right; column += 1) {
    widthsMm[column] = widthMm;
  }
  const total = widthsMm.reduce((sum, width) => sum + width, 0);
  if (total > (editorContentWidthMm(editor) ?? PRINTABLE_WIDTH_MM) + 0.01) return false;
  return applyColumnWidths(editor, selected, widthsMm.map(millimetresToPixels), {
    layoutMode: "fixed",
    widthsMm,
  });
}

export function fixCurrentTableWidths(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const widthsMm = currentColumnWidthsMm(selected, editor);
  return applyColumnWidths(editor, selected, widthsMm.map(millimetresToPixels), {
    layoutMode: "fixed",
    widthsMm,
  });
}

function measuredContentWidths(
  editor: Editor,
  selected: SelectedTableCells,
): CellWidthMeasurement[] {
  const fullRect = { left: 0, top: 0, right: selected.map.width, bottom: selected.map.height };
  const measurements: CellWidthMeasurement[] = [];
  for (const offset of selected.map.cellsInRect(fullRect)) {
    const cellPosition = selected.tableStart + offset;
    const cellNode = editor.state.doc.nodeAt(cellPosition);
    const cell = editor.view.nodeDOM(cellPosition);
    if (!(cell instanceof HTMLElement)) continue;
    const content = cell.querySelector<HTMLElement>(".patent-table-cell-content");
    if (!content) continue;
    const measurementRoot = document.createElement("div");
    measurementRoot.className = "patent-prosemirror";
    measurementRoot.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    const contentProbe = content.cloneNode(true) as HTMLElement;
    contentProbe.removeAttribute("contenteditable");
    contentProbe.style.width = "max-content";
    contentProbe.style.minWidth = "0";
    contentProbe.style.maxWidth = "none";
    contentProbe.style.overflow = "visible";
    measurementRoot.append(contentProbe);
    document.body.append(measurementRoot);
    const intrinsicContentWidth = Math.max(
      contentProbe.scrollWidth,
      contentProbe.getBoundingClientRect().width,
    );
    measurementRoot.remove();
    let hasNonTextContent = false;
    cellNode?.descendants((node) => {
      if (node.isAtom && !node.isText && node.type.name !== "hardBreak") {
        hasNonTextContent = true;
        return false;
      }
      return true;
    });
    const hasMeasurableContent = Boolean(cellNode?.textContent.trim()) || hasNonTextContent;
    const contentWidth =
      intrinsicContentWidth > 0
        ? intrinsicContentWidth
        : hasMeasurableContent
          ? content.scrollWidth
          : 0;
    const styles = getComputedStyle(cell);
    const extras = [
      styles.paddingLeft,
      styles.paddingRight,
      styles.borderLeftWidth,
      styles.borderRightWidth,
    ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    const rect = selected.map.findCell(offset);
    measurements.push({
      left: rect.left,
      right: rect.right,
      requiredWidthMm: pixelsToMillimetres(contentWidth + extras),
    });
  }
  return measurements;
}

function fitTableToContent(editor: Editor, autoArrange = false): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const pageMm = editorContentWidthMm(editor) ?? PRINTABLE_WIDTH_MM;
  const constraints = tableWidthConstraints(selected.table);
  const measurements = measuredContentWidths(editor, selected);
  const contentWidths = calculateContentColumnWidths(
    [
      ...measurements.map((measurement) => ({
        ...measurement,
        requiredWidthMm: autoArrange
          ? Math.min(measurement.requiredWidthMm, pageMm * 0.65)
          : measurement.requiredWidthMm,
      })),
      ...constraints.map((constraint) => ({
        left: constraint.left,
        right: constraint.right,
        requiredWidthMm: (constraint.minimum * 25.4) / 96,
      })),
    ],
    currentColumnWidthsMm(selected, editor),
    editorContentWidthMm(editor) ?? PRINTABLE_WIDTH_MM,
  );
  if (contentWidths.length !== selected.map.width) return false;
  const totalPx =
    (Math.min(
      editorContentWidthMm(editor) ?? PRINTABLE_WIDTH_MM,
      contentWidths.reduce((sum, width) => sum + width, 0),
    ) *
      96) /
    25.4;
  const fitted = fitConstrainedWidths(
    contentWidths.map((width) => (width * 96) / 25.4),
    totalPx,
    constraints,
  );
  if (!fitted) return false;
  const widthsMm = fitted.map((width) => (width * 25.4) / 96);
  return applyColumnWidths(editor, selected, widthsMm.map(millimetresToPixels), {
    layoutMode: "fixed",
    widthsMm,
    autoHeight: autoArrange,
  });
}

function fitTableToPage(editor: Editor): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const currentWidthsPx = currentColumnWidthsMm(selected, editor).map(
    (width) => (width * 96) / 25.4,
  );
  const contentWidthMm = editorContentWidthMm(editor) ?? PRINTABLE_WIDTH_MM;
  const fitted = fitConstrainedWidths(
    currentWidthsPx,
    (contentWidthMm * 96) / 25.4,
    tableWidthConstraints(selected.table),
  );
  if (!fitted) return false;
  const widthsMm = fitted.map((width) => Math.round(((width * 25.4) / 96) * 1000) / 1000);
  const roundingDifference = contentWidthMm - widthsMm.reduce((sum, width) => sum + width, 0);
  widthsMm[widthsMm.length - 1] =
    Math.round(((widthsMm.at(-1) ?? 0) + roundingDifference) * 1_000) / 1_000;
  const widthsPx = widthsMm.map((width) => Math.round((width * 96) / 25.4));
  return applyColumnWidths(editor, selected, widthsPx, {
    layoutMode: "fit-page",
    widthsMm,
  });
}

function distributeSelectedColumns(editor: Editor): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const widths = currentColumnWidthsMm(selected, editor);
  const selectedWidths = widths.slice(selected.rect.left, selected.rect.right);
  if (selectedWidths.length === 0) return false;
  const average =
    Math.round(
      (selectedWidths.reduce((sum, width) => sum + width, 0) / selectedWidths.length) * 1_000,
    ) / 1_000;
  for (let column = selected.rect.left; column < selected.rect.right; column += 1)
    widths[column] = average;
  return applyColumnWidths(editor, selected, widths.map(millimetresToPixels), { widthsMm: widths });
}

function distributeSelectedRows(editor: Editor): boolean {
  const selected = selectedTableCells(editor);
  if (!selected || selected.rect.bottom - selected.rect.top < 2) return false;
  const node = editor.view.nodeDOM(selected.tableFrom);
  const table =
    node instanceof HTMLTableElement
      ? node
      : node instanceof HTMLElement
        ? node.querySelector("table")
        : null;
  const heights: number[] = [];
  for (let index = selected.rect.top; index < selected.rect.bottom; index += 1) {
    const row = table?.rows[index];
    // offsetHeight is independent of document zoom.
    heights.push(
      row && row.offsetHeight > 0
        ? (row.offsetHeight * 25.4) / 96
        : Number(selected.table.child(index).attrs.rowHeightMm) || TABLE_ROW_HEIGHT_MIN_MM,
    );
  }
  let contentMinimum = TABLE_ROW_HEIGHT_MIN_MM;
  if (table) {
    for (const offset of new Set(selected.map.map)) {
      const rect = selected.map.findCell(offset);
      const covered =
        Math.min(rect.bottom, selected.rect.bottom) - Math.max(rect.top, selected.rect.top);
      if (covered <= 0) continue;
      const cell = editor.view.nodeDOM(selected.tableStart + offset);
      if (!(cell instanceof HTMLElement)) continue;
      const content = cell.querySelector<HTMLElement>(".patent-table-cell-content");
      if (!content) continue;
      const style = getComputedStyle(cell);
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0) +
        1;
      let outside = 0;
      for (let row = rect.top; row < rect.bottom; row += 1) {
        if (row < selected.rect.top || row >= selected.rect.bottom)
          outside += ((table.rows[row]?.offsetHeight ?? 0) * 25.4) / 96;
      }
      contentMinimum = Math.max(
        contentMinimum,
        (((content.scrollHeight + padding) * 25.4) / 96 - outside) / covered,
      );
    }
  }
  const average = Math.min(
    TABLE_ROW_HEIGHT_MAX_MM,
    Math.max(
      Math.ceil(contentMinimum * 10) / 10,
      Math.round((heights.reduce((sum, height) => sum + height, 0) / heights.length) * 10) / 10,
    ),
  );
  editor.view.dispatch(closeHistory(editor.state.tr));
  return setSelectedRowHeight(editor, { heightMm: average, rule: "at-least" });
}

export function splitSelectedTableCell(editor: Editor, request: TableSplitRequest): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const animate = prepareTableLayoutAnimation(editor, selectedTableCells(editor)?.tableFrom);
  const result = splitSelectedTableCellWithoutMotion(editor, request);
  if (result) animate();
  return result;
}

function splitSelectedTableCellWithoutMotion(editor: Editor, request: TableSplitRequest): boolean {
  if (
    !Number.isInteger(request.rows) ||
    !Number.isInteger(request.columns) ||
    request.rows < 1 ||
    request.rows > 100 ||
    request.columns < 1 ||
    request.columns > 30 ||
    request.rows * request.columns < 2
  )
    return false;
  const selected = selectedTableCells(editor);
  if (!selected || selected.positions.length !== 1) return false;
  const widths = currentColumnWidthsMm(selected, editor);
  const targetWidth = widths
    .slice(selected.rect.left, selected.rect.right)
    .reduce((sum, width) => sum + width, 0);
  // A new cell must fit the editor's minimum width; do not push the table outside the page.
  if (
    request.columns > 1 &&
    targetWidth / request.columns < pixelsToMillimetres(PATENT_TABLE_CELL_MIN_WIDTH_PX)
  )
    return false;
  const result = buildSplitTable(
    selected.table,
    selected.positions[0]! - selected.tableStart,
    request,
    widths,
  );
  if (!result) return false;
  const map = TableMap.get(result);
  const targetOffset = map.map[selected.rect.top * map.width + selected.rect.left];
  if (targetOffset === undefined) return false;
  const targetPosition = selected.tableStart + targetOffset;
  const transaction = closeHistory(editor.state.tr).replaceWith(
    selected.tableFrom,
    selected.tableFrom + selected.table.nodeSize,
    result,
  );
  transaction.setSelection(CellSelection.create(transaction.doc, targetPosition));
  if (!enforceTableWidth(editor, transaction)) return false;
  editor.view.dispatch(transaction.setMeta(TABLE_COMMAND_COLUMN_WIDTH_META, true));
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

function setFirstRowHeaderState(
  editor: Editor,
  selected: SelectedTableCells,
  enabled: boolean,
): boolean {
  const tableHeader = editor.schema.nodes.tableHeader;
  const tableCell = editor.schema.nodes.tableCell;
  if (!tableHeader || !tableCell) return false;
  const fullRect = { left: 0, top: 0, right: selected.map.width, bottom: selected.map.height };
  let transaction = editor.state.tr.setNodeMarkup(selected.tableFrom, undefined, {
    ...selected.table.attrs,
    headerRowCount: enabled ? 1 : 0,
  });
  for (const offset of selected.map.cellsInRect(fullRect)) {
    const position = selected.tableStart + offset;
    const cell = transaction.doc.nodeAt(position);
    if (!cell) continue;
    const rowIndex = selected.map.findCell(offset).top;
    const isFirstRowHeader = enabled && rowIndex === 0;
    const nodeType = isFirstRowHeader ? tableHeader : tableCell;
    const cellAttrs = isFirstRowHeader
      ? { ...cell.attrs, horizontalAlignment: "center", verticalAlignment: "middle" }
      : { ...cell.attrs };
    if (
      cell.type !== nodeType ||
      (isFirstRowHeader &&
        (cell.attrs.horizontalAlignment !== "center" || cell.attrs.verticalAlignment !== "middle"))
    )
      transaction = transaction.setNodeMarkup(position, nodeType, cellAttrs);
    if (isFirstRowHeader)
      cell.descendants((node, childOffset) => {
        if (node.type.name !== "paragraph" || node.attrs.textAlign === "center") return;
        transaction = transaction.setNodeMarkup(position + 1 + childOffset, undefined, {
          ...node.attrs,
          textAlign: "center",
        });
      });
  }
  editor.view.dispatch(transaction);
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

function mergeSelectedCells(editor: Editor): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const widths = Array.from({ length: selected.map.width }, () => 0);
  for (const offset of new Set(selected.map.map)) {
    const cell = selected.table.nodeAt(offset);
    const rect = selected.map.findCell(offset);
    const colwidth = cell?.attrs.colwidth;
    if (!Array.isArray(colwidth)) continue;
    colwidth.forEach((width, index) => {
      if (typeof width === "number" && Number.isFinite(width) && width > 0)
        widths[rect.left + index] = width;
    });
  }
  return editor
    .chain()
    .focus()
    .mergeCells()
    .command(({ tr }) => {
      const table = tr.doc.nodeAt(selected.tableFrom);
      if (!table) return false;
      const map = TableMap.get(table);
      const offset = map.map[selected.rect.top * map.width + selected.rect.left];
      if (offset === undefined) return false;
      const position = selected.tableStart + offset;
      const cell = tr.doc.nodeAt(position);
      if (!cell) return false;
      // Native merge retains only the first cell's widths; a fully merged row
      // otherwise loses the remaining columns' dimensions until the next reload.
      const colwidth = widths.slice(selected.rect.left, selected.rect.right);
      tr.setNodeMarkup(position, undefined, {
        ...cell.attrs,
        colwidth: colwidth.some((width) => width > 0) ? colwidth : null,
      });
      return true;
    })
    .fixTables()
    .run();
}

function addTableSectionWithInheritedFormatting(
  editor: Editor,
  axis: "row" | "column",
  side: "before" | "after",
): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const sourceFormatting: Array<InheritedCellFormatting | null> = [];
  if (axis === "row") {
    const sourceRow = side === "before" ? selected.rect.top : selected.rect.bottom - 1;
    for (let column = 0; column < selected.map.width; column += 1) {
      const offset = selected.map.map[sourceRow * selected.map.width + column];
      sourceFormatting.push(
        offset === undefined ? null : inheritedCellFormatting(selected.table.nodeAt(offset)),
      );
    }
  } else {
    const sourceColumn = side === "before" ? selected.rect.left : selected.rect.right - 1;
    for (let row = 0; row < selected.map.height; row += 1) {
      const offset = selected.map.map[row * selected.map.width + sourceColumn];
      sourceFormatting.push(
        offset === undefined ? null : inheritedCellFormatting(selected.table.nodeAt(offset)),
      );
    }
  }
  const targetIndex =
    axis === "row"
      ? side === "before"
        ? selected.rect.top
        : selected.rect.bottom
      : side === "before"
        ? selected.rect.left
        : selected.rect.right;
  const apply = ({ tr }: { tr: Transaction }) => {
    const inherited = applyInheritedFormatting(
      tr,
      selected.tableFrom,
      { axis, index: targetIndex },
      sourceFormatting,
    );
    if (!inherited || !enforceTableWidth(editor, tr)) return false;
    const table = tr.doc.nodeAt(selected.tableFrom)!;
    const map = TableMap.get(table);
    const anchorOffset = map.map[axis === "row" ? targetIndex * map.width : targetIndex]!;
    const headOffset =
      map.map[
        axis === "row"
          ? (targetIndex + 1) * map.width - 1
          : (map.height - 1) * map.width + targetIndex
      ]!;
    const $anchor = tr.doc.resolve(selected.tableStart + anchorOffset);
    const $head = tr.doc.resolve(selected.tableStart + headOffset);
    tr.setSelection(
      axis === "row"
        ? CellSelection.rowSelection($anchor, $head)
        : CellSelection.colSelection($anchor, $head),
    );
    return true;
  };
  const animate = prepareTableInsertionAnimation(editor, selected.tableFrom, axis, targetIndex);
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    });
  // tableEditing normalizes the dispatched document. Calling fixTables inside
  // this chain maps the new cell positions through the insertion a second time.
  const inserted =
    axis === "row"
      ? side === "before"
        ? chain.addRowBefore().command(apply).run()
        : chain.addRowAfter().command(apply).run()
      : side === "before"
        ? chain.addColumnBefore().command(apply).run()
        : chain.addColumnAfter().command(apply).run();
  if (inserted) animate();
  return inserted;
}

function deleteTableSection(editor: Editor, axis: "row" | "column"): boolean {
  const selected = selectedTableCells(editor);
  if (!selected) return false;
  const from = axis === "row" ? selected.rect.top : selected.rect.left;
  const to = axis === "row" ? selected.rect.bottom : selected.rect.right;
  const animate = prepareTableDeletionAnimation(editor, selected.tableFrom, axis, from, to);
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    });
  const deleted = (axis === "row" ? chain.deleteRow() : chain.deleteColumn()).fixTables().run();
  if (deleted) animate();
  return deleted;
}

export function runTableCommand(editor: Editor, command: TableCommand): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const spatial = [
    "delete-table",
    "merge-cells",
    "split-cell",
    "auto-fit-content",
    "auto-arrange",
    "align-table-left",
    "align-table-center",
    "align-table-right",
    "fit-page",
    "fixed-width",
    "distribute-columns",
    "distribute-rows",
  ].includes(command);
  const animate = spatial
    ? prepareTableLayoutAnimation(editor, selectedTableCells(editor)?.tableFrom)
    : null;
  const result = runTableCommandWithoutMotion(editor, command);
  if (result) animate?.();
  return result;
}

function runTableCommandWithoutMotion(editor: Editor, command: TableCommand): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const selection = inspectTableSelection(editor);
  switch (command) {
    case "add-column-before":
      return addTableSectionWithInheritedFormatting(editor, "column", "before");
    case "add-column-after":
      return addTableSectionWithInheritedFormatting(editor, "column", "after");
    case "delete-column":
      return selection.canDeleteColumn && deleteTableSection(editor, "column");
    case "add-row-before":
      return (
        selection.canAddRowBefore && addTableSectionWithInheritedFormatting(editor, "row", "before")
      );
    case "add-row-after":
      return addTableSectionWithInheritedFormatting(editor, "row", "after");
    case "delete-row":
      return selection.canDeleteRow && deleteTableSection(editor, "row");
    case "delete-table":
      return editor.chain().focus().deleteTable().fixTables().run();
    case "merge-cells":
      return selection.canMerge && mergeSelectedCells(editor);
    case "split-cell":
      return (
        selection.canSplit &&
        editor
          .chain()
          .focus()
          .splitCell()
          .command(({ tr }) => {
            // ProseMirror copies all cell attributes when splitting, including our persisted ID.
            // Its disjoint changed ranges can hide duplicates from the generic UniqueID plugin.
            const seen = new Set<string>();
            tr.doc.descendants((node, pos) => {
              const role = node.type.spec.tableRole;
              if (role !== "cell" && role !== "header_cell") return;
              const id = node.attrs.nodeId;
              if (typeof id === "string" && seen.has(id)) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: randomUuid() });
              } else if (typeof id === "string") seen.add(id);
            });
            return true;
          })
          .fixTables()
          .run()
      );
    case "clear-cells":
      return clearSelectedCells(editor);
    case "auto-fit-content":
      return fitTableToContent(editor);
    case "auto-arrange":
      return fitTableToContent(editor, true);
    case "align-table-left":
    case "align-table-center":
    case "align-table-right": {
      const selected = selectedTableCells(editor);
      if (!selected) return false;
      const tableAlignment = command.slice("align-table-".length);
      editor.view.dispatch(
        closeHistory(editor.state.tr).setNodeMarkup(selected.tableFrom, undefined, {
          ...selected.table.attrs,
          tableAlignment,
        }),
      );
      editor.commands.focus(undefined, { scrollIntoView: false });
      return true;
    }
    case "toggle-header-row": {
      const selected = selectedTableCells(editor);
      if (!selected) return false;
      const enabled = !hasFirstRowHeader(selected.table);
      return setFirstRowHeaderState(editor, selected, enabled);
    }
    case "fit-page":
      return fitTableToPage(editor);
    case "fixed-width":
      return fixCurrentTableWidths(editor);
    case "distribute-columns":
      return distributeSelectedColumns(editor);
    case "distribute-rows":
      return distributeSelectedRows(editor);
  }
}
