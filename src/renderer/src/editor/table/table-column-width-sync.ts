import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";

export const TABLE_COLUMN_WIDTH_SYNC_META = "patentTableColumnWidthSync";
export const TABLE_COMMAND_COLUMN_WIDTH_META = "patentTableCommandColumnWidth";

const DEFAULT_COLUMN_WIDTH_PX = 113;
const MILLIMETRES_PER_PIXEL = 25.4 / 96;

type TableAtPosition = { node: ProseMirrorNode; position: number };

function sameWidths(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((width, index) => width === right[index])
  );
}

function tableNodes(document: ProseMirrorNode): TableAtPosition[] {
  const tables: TableAtPosition[] = [];
  document.descendants((node, position) => {
    if (node.type.spec.tableRole === "table") tables.push({ node, position });
  });
  return tables;
}

function hasChangedCellColumnWidths(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  const beforeMap = TableMap.get(before);
  const afterMap = TableMap.get(after);
  if (beforeMap.width !== afterMap.width) return true;
  // Cell offsets and colspan arrays change during typing, merging and splitting.
  // Only a change to the logical column widths represents an actual resize.
  return !sameWidths(physicalColumnWidths(before, true), physicalColumnWidths(after, true));
}

function changedTablePositions(transactions: readonly Transaction[]): Set<number> {
  const positions = new Set<number>();
  for (const transaction of transactions) {
    if (!transaction.docChanged) continue;
    const before = new Map(
      tableNodes(transaction.before).map((table) => [table.position, table.node]),
    );
    for (const table of tableNodes(transaction.doc)) {
      const previous = before.get(table.position);
      if (previous && hasChangedCellColumnWidths(previous, table.node))
        positions.add(table.position);
    }
  }
  return positions;
}

function millimetresToPixels(millimetres: unknown): number | null {
  if (typeof millimetres !== "number" || !Number.isFinite(millimetres) || millimetres <= 0)
    return null;
  return Math.round(millimetres / MILLIMETRES_PER_PIXEL);
}

function pixelsToMillimetres(pixels: number): number {
  return Math.round(pixels * MILLIMETRES_PER_PIXEL * 1_000) / 1_000;
}

function physicalColumnWidths(table: ProseMirrorNode, allowUnmeasured = false): number[] | null {
  const map = TableMap.get(table);
  const canonical = Array.isArray(table.attrs.columnWidthsMm)
    ? table.attrs.columnWidthsMm.map(millimetresToPixels)
    : [];
  if (canonical.some((width) => width === null)) return null;
  const widths = Array.from(
    { length: map.width },
    (_, index) => canonical[index] ?? DEFAULT_COLUMN_WIDTH_PX,
  );
  const assigned = Array.from({ length: map.width }, () => false);
  const offsets = new Set(map.map);

  for (const offset of offsets) {
    const cell = table.nodeAt(offset);
    if (!cell) return null;
    const colwidth = cell.attrs.colwidth;
    if (colwidth === null || colwidth === undefined) continue;
    if (!Array.isArray(colwidth)) return null;
    const rect = map.findCell(offset);
    if (colwidth.length !== rect.right - rect.left) return null;
    for (let index = 0; index < colwidth.length; index += 1) {
      const width = colwidth[index];
      // ProseMirror uses zero for unmeasured parts of a merged cell.
      if (allowUnmeasured && width === 0) continue;
      if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
      const column = rect.left + index;
      if (assigned[column] && widths[column] !== width) return null;
      widths[column] = width;
      assigned[column] = true;
    }
  }

  return widths.every((width) => Number.isFinite(width) && width > 0) ? widths : null;
}

function sameCanonicalWidths(current: unknown, next: readonly number[]): boolean {
  return (
    Array.isArray(current) &&
    current.length === next.length &&
    current.every((width, index) => width === next[index])
  );
}

export const TableColumnWidthSync = Extension.create({
  name: "tableColumnWidthSync",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (
            transactions.some(
              (transaction) =>
                transaction.getMeta(TABLE_COLUMN_WIDTH_SYNC_META) ||
                isHistoryTransaction(transaction) ||
                transaction.getMeta(TABLE_COMMAND_COLUMN_WIDTH_META),
            )
          )
            return null;

          const changedPositions = changedTablePositions(transactions);
          const changedTables = tableNodes(newState.doc).filter((table) =>
            changedPositions.has(table.position),
          );
          if (changedTables.length === 0) return null;

          let transaction = newState.tr;
          let changed = false;
          for (const table of changedTables) {
            const widthsPx = physicalColumnWidths(table.node);
            if (!widthsPx) continue;
            const widthsMm = widthsPx.map(pixelsToMillimetres);
            const previous = oldState.doc.nodeAt(table.position);
            const structureChanged =
              previous?.type.spec.tableRole === "table" &&
              TableMap.get(previous).width !== TableMap.get(table.node).width;
            const pasted = transactions.some((item) => item.getMeta("uiEvent") === "paste");
            const layoutMode = structureChanged || pasted ? table.node.attrs.layoutMode : "fixed";
            if (
              table.node.attrs.layoutMode === layoutMode &&
              sameCanonicalWidths(table.node.attrs.columnWidthsMm, widthsMm)
            )
              continue;
            transaction = transaction.setNodeMarkup(table.position, undefined, {
              ...table.node.attrs,
              columnWidthsMm: widthsMm,
              layoutMode,
            });
            changed = true;
          }
          return changed ? transaction.setMeta(TABLE_COLUMN_WIDTH_SYNC_META, true) : null;
        },
      }),
    ];
  },
});
