import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";
import { inspectTableSelection } from "./table-selection";

test("fit-page column width reports the displayed dimension rather than stored proportions", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table data-layout-mode="fit-page" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
  });
  try {
    const table = editor.view.dom.querySelector("table");
    if (!table) throw new Error("Missing table");
    Object.defineProperty(table, "offsetWidth", { configurable: true, value: 400 });
    editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
    expect(inspectTableSelection(editor).columnWidthMm).toBeCloseTo(((400 * 25.4) / 96) * 0.4, 2);
  } finally {
    editor.destroy();
  }
});

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell") positions.push(position);
  });
  return positions;
}

function allCellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader")
      positions.push(position);
  });
  return positions;
}

function createTableEditor(): Editor {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { columnWidthsMm: [30, 40], layoutMode: "fixed" },
          content: [
            {
              type: "tableRow",
              attrs: { rowHeightMm: 12.5, rowHeightRule: "at-least" },
              content: [
                {
                  type: "tableCell",
                  attrs: { horizontalAlignment: "left", verticalAlignment: "top" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { horizontalAlignment: "center", verticalAlignment: "middle" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              attrs: { rowHeightMm: 18, rowHeightRule: "exact" },
              content: [
                {
                  type: "tableCell",
                  attrs: { horizontalAlignment: "left", verticalAlignment: "top" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "丙" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { horizontalAlignment: "center", verticalAlignment: "middle" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "丁" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
}

describe("table selection", () => {
  test("does not offer a merge that cuts through an existing merged cell", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr><td colspan="2">A</td><td>C</td></tr><tr><td>D</td><td>E</td><td>F</td></tr></table>',
    });
    const positions = cellPositions(editor);
    editor.commands.setCellSelection({
      anchorCell: positions[1] ?? 0,
      headCell: positions[3] ?? 0,
    });
    expect(editor.can().mergeCells()).toBe(false);
    expect(inspectTableSelection(editor).canMerge).toBe(false);
    editor.destroy();
  });
  test("reports the cell containing a text cursor", () => {
    const editor = createTableEditor();
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    editor.commands.setTextSelection(first + 2);

    expect(inspectTableSelection(editor)).toMatchObject({
      kind: "text",
      rowCount: 1,
      columnCount: 1,
      selectedCellCount: 1,
      horizontalAlignment: "left",
      verticalAlignment: "top",
      canMerge: false,
    });
    editor.destroy();
  });

  test("reports a rectangular cell selection and mixed cell attributes", () => {
    const editor = createTableEditor();
    const [first, , , last] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    editor.commands.setCellSelection({ anchorCell: first, headCell: last });

    expect(inspectTableSelection(editor)).toMatchObject({
      kind: "table",
      rowCount: 2,
      columnCount: 2,
      selectedCellCount: 4,
      horizontalAlignment: "mixed",
      verticalAlignment: "mixed",
      canMerge: true,
      canSplit: false,
      canDeleteRow: false,
      canDeleteColumn: false,
    });
    editor.destroy();
  });

  test("reports selected physical indexes and mixed table dimensions", () => {
    const editor = createTableEditor();
    const [first, , , last] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    editor.commands.setTextSelection(first + 2);
    expect(inspectTableSelection(editor)).toMatchObject({
      selectedRowIndexes: [0],
      selectedColumnIndexes: [0],
      rowHeightMm: 12.5,
      rowHeightRule: "at-least",
      columnWidthMm: 30,
      layoutMode: "fixed",
    });

    editor.commands.setCellSelection({ anchorCell: first, headCell: last });
    expect(inspectTableSelection(editor)).toMatchObject({
      selectedRowIndexes: [0, 1],
      selectedColumnIndexes: [0, 1],
      rowHeightMm: "mixed",
      rowHeightRule: "mixed",
      columnWidthMm: "mixed",
      layoutMode: "fixed",
    });
    editor.destroy();
  });

  test("reports natural row height as an unset value", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>自然行高</td></tr></table>",
    });
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    editor.commands.setTextSelection(first + 2);
    expect(inspectTableSelection(editor)).toMatchObject({
      rowHeightMm: null,
      rowHeightRule: null,
    });
    editor.destroy();
  });

  test("reports border state from the four rendered edges", () => {
    const editor = createTableEditor();
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);
    let transaction = editor.state.tr.setNodeMarkup(first, undefined, {
      ...editor.state.doc.nodeAt(first)?.attrs,
      borderTop: "double",
      borderRight: "double",
      borderBottom: "double",
      borderLeft: "double",
    });
    editor.view.dispatch(transaction);

    expect(inspectTableSelection(editor).borderStyle).toBe("double");

    transaction = editor.state.tr.setNodeMarkup(first, undefined, {
      ...editor.state.doc.nodeAt(first)?.attrs,
      borderTop: "none",
    });
    editor.view.dispatch(transaction);
    expect(inspectTableSelection(editor).borderStyle).toBe("mixed");
    editor.destroy();
  });

  test("prevents inserting above the first header row", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const first = allCellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);

    expect(inspectTableSelection(editor).canAddRowBefore).toBe(false);
    editor.destroy();
  });
});
