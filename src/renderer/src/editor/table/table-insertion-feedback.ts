import type { Editor } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { inspectTableSelection } from "./table-selection";

export type TableInsertionCommand = `add-${"row" | "column"}-${"before" | "after"}`;
export const TABLE_INSERTION_PREVIEW = "table-insertion-preview";

export function previewTableInsertion(editor: Editor, command: TableInsertionCommand | null): void {
  if (editor.isDestroyed) return;
  editor.view.dom.dispatchEvent(new CustomEvent(TABLE_INSERTION_PREVIEW, { detail: command }));
}

export function tableElement(editor: Editor, tableFrom: number): HTMLTableElement | null {
  const dom = editor.view.nodeDOM(tableFrom);
  return dom instanceof HTMLTableElement
    ? dom
    : dom instanceof Element
      ? dom.querySelector("table")
      : null;
}

export function selectedInsertionPreview(editor: Editor, command: TableInsertionCommand) {
  if (!editor.isEditable) return null;
  const selection = inspectTableSelection(editor);
  if (selection.tableFrom === null || (command === "add-row-before" && !selection.canAddRowBefore))
    return null;
  const axis: "row" | "column" = command.includes("row") ? "row" : "column";
  const indexes = axis === "row" ? selection.selectedRowIndexes : selection.selectedColumnIndexes;
  const index = command.endsWith("before") ? Math.min(...indexes) : Math.max(...indexes) + 1;
  const node = editor.state.doc.nodeAt(selection.tableFrom);
  const table = tableElement(editor, selection.tableFrom);
  if (!node || !table) return null;
  const map = TableMap.get(node);
  const bounds = table.getBoundingClientRect();
  for (const offset of new Set(map.map)) {
    const cell = editor.view.nodeDOM(selection.tableFrom + 1 + offset);
    if (!(cell instanceof HTMLElement)) continue;
    const rect = map.findCell(offset);
    const box = cell.getBoundingClientRect();
    const start = axis === "row" ? rect.top : rect.left;
    const end = axis === "row" ? rect.bottom : rect.right;
    if (start === index || end === index)
      return {
        axis,
        table: bounds,
        boundary:
          axis === "row"
            ? start === index
              ? box.top
              : box.bottom
            : start === index
              ? box.left
              : box.right,
      };
  }
  return null;
}
