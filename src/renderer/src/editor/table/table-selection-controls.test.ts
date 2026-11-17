import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";
import { inspectTableSelection } from "./table-selection";
import {
  collapseTableSelection,
  selectTableColumn,
  selectTableRow,
  selectWholeTable,
} from "./table-selection-controls";

test("metadata-only transactions preserve table handle DOM during pointer selection", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  // Let initial document normalization finish before testing a metadata-only update.
  editor.view.dispatch(editor.state.tr);
  const handles = [
    ...editor.view.dom.querySelectorAll(".table-selection-handle, .table-row-resize-handle"),
  ];
  editor.view.dispatch(editor.state.tr.setMeta("selection-menu", "hide"));
  const updated = [
    ...editor.view.dom.querySelectorAll(".table-selection-handle, .table-row-resize-handle"),
  ];
  expect(updated).toHaveLength(handles.length);
  for (let index = 0; index < handles.length; index += 1)
    expect(updated[index]).toBe(handles[index]);
  editor.destroy();
});

test("marks pointer selection drags so resize hover guides stay quiet", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  const cell = editor.view.dom.querySelector("td");
  expect(cell).not.toBeNull();

  const down = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  });
  Object.defineProperty(down, "target", { value: cell });
  editor.view.someProp("handleDOMEvents", (handlers) => {
    const handled = handlers.mousedown?.(editor.view, down);
    return editor.view.dom.dataset.tableSelectionDragging === "true" || handled;
  });
  expect(editor.view.dom.dataset.tableSelectionDragging).toBe("true");

  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  expect(editor.view.dom.dataset.tableSelectionDragging).toBeUndefined();
  editor.destroy();
});

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell") positions.push(position);
  });
  return positions;
}

test("Escape collapses a table cell range to a text caret in its anchor cell", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  const [first, second] = cellPositions(editor);
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  if (first === undefined || second === undefined) return;
  editor.commands.setCellSelection({ anchorCell: first, headCell: second });

  expect(collapseTableSelection(editor)).toBe(true);
  expect(editor.state.selection.empty).toBe(true);
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  editor.destroy();
});

test("table selection helpers create row, column, and whole-table selections", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
  });
  const firstCell = cellPositions(editor)[0];
  expect(firstCell).toBeDefined();
  if (firstCell === undefined) return;

  expect(selectTableRow(editor, firstCell, 0)).toBe(true);
  expect(inspectTableSelection(editor)).toMatchObject({ kind: "row", rowCount: 1, columnCount: 2 });
  expect(selectTableColumn(editor, firstCell, 1)).toBe(true);
  expect(inspectTableSelection(editor)).toMatchObject({
    kind: "column",
    rowCount: 2,
    columnCount: 1,
  });
  expect(selectWholeTable(editor, firstCell)).toBe(true);
  expect(inspectTableSelection(editor)).toMatchObject({
    kind: "table",
    rowCount: 2,
    columnCount: 2,
  });
  editor.destroy();
});

test("marks only the outside edges of a whole-table selection as boundaries", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
  });
  const firstCell = cellPositions(editor)[0];
  expect(firstCell).toBeDefined();
  if (firstCell === undefined) return;

  expect(selectWholeTable(editor, firstCell)).toBe(true);
  const selectedCells = [...editor.view.dom.querySelectorAll<HTMLElement>("td.selectedCell")];
  expect(selectedCells).toHaveLength(4);
  expect(
    selectedCells.map((cell) =>
      [...cell.classList].filter((name) => name.startsWith("table-selection-boundary-")),
    ),
  ).toEqual([
    ["table-selection-boundary-top", "table-selection-boundary-left"],
    ["table-selection-boundary-top", "table-selection-boundary-right"],
    ["table-selection-boundary-bottom", "table-selection-boundary-left"],
    ["table-selection-boundary-right", "table-selection-boundary-bottom"],
  ]);
  editor.destroy();
});

test("keeps an invisible single-cell selection target alongside edge handles", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });

  const cellHandle = editor.view.dom.querySelector<HTMLElement>(
    ".table-selection-handle:not([data-table-selection-row]):not([data-table-selection-column]):not([data-table-selection-table])",
  );
  expect(cellHandle).not.toBeNull();
  cellHandle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  expect(inspectTableSelection(editor)).toMatchObject({ kind: "cell", selectedCellCount: 1 });
  expect(editor.view.dom.querySelector("[data-table-selection-row='0']")).not.toBeNull();
  expect(editor.view.dom.querySelector("[data-table-selection-column='0']")).not.toBeNull();
  const tableHandle = editor.view.dom.querySelector<HTMLElement>("[data-table-selection-table]");
  expect(tableHandle).not.toBeNull();
  expect(tableHandle?.dataset.tableSelectionCell).toBeDefined();
  tableHandle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  expect(inspectTableSelection(editor)).toMatchObject({
    kind: "table",
    rowCount: 1,
    columnCount: 2,
  });
  editor.destroy();
});

test("wraps external handles in a larger reveal-only target without expanding click selection", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });

  for (const kind of ["row", "column", "table"]) {
    const reveal = editor.view.dom.querySelector<HTMLElement>(
      `[data-table-selection-reveal='${kind}']`,
    );
    const handle = reveal?.querySelector<HTMLElement>(`[data-table-selection-${kind}]`);
    expect(reveal).not.toBeNull();
    expect(handle).not.toBeNull();
    expect(reveal?.matches(".table-selection-handle")).toBe(false);
    expect(handle?.parentElement).toBe(reveal);
  }

  const cellHandle = editor.view.dom.querySelector<HTMLElement>(
    ".table-selection-handle:not([data-table-selection-row]):not([data-table-selection-column]):not([data-table-selection-table])",
  );
  expect(cellHandle?.parentElement?.classList.contains("table-selection-handle-reveal")).toBe(
    false,
  );
  editor.destroy();
});
