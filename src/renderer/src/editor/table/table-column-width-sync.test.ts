import { Editor, Extension, type JSONContent } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { createPatentExtensions } from "../extensions";

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell") positions.push(position);
  });
  return positions;
}

function tableJson(editor: Editor): JSONContent {
  const table = editor.getJSON().content?.find((node) => node.type === "table");
  if (!table) throw new Error("测试表格不存在");
  return table;
}

function setColumnWidths(editor: Editor, widths: readonly number[]): void {
  const cells = cellPositions(editor);
  let transaction = editor.state.tr;
  for (const [index, position] of cells.entries()) {
    transaction = transaction.setNodeMarkup(position, undefined, {
      ...transaction.doc.nodeAt(position)?.attrs,
      colwidth: [widths[index]],
    });
  }
  editor.view.dispatch(transaction);
}

function captureInternalSyncs(captured: string[]) {
  return Extension.create({
    name: "tableColumnWidthSyncTestCapture",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction(transactions) {
            for (const transaction of transactions) {
              if (transaction.getMeta("patentTableColumnWidthSync")) captured.push("sync");
            }
            return null;
          },
        }),
      ];
    },
  });
}

describe("table column width sync", () => {
  test.each(["type", "merge", "split"])(
    "%s does not turn proportional widths into fixed widths",
    (operation) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<table data-layout-mode="fit-page" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
      });
      try {
        const [first, second] = cellPositions(editor);
        if (first === undefined || second === undefined) throw new Error("Missing cells");
        if (operation === "type")
          editor.view.dispatch(editor.state.tr.insertText("修订", first + 2));
        else {
          editor.commands.setCellSelection({
            anchorCell: first,
            headCell: second,
          });
          editor.commands.mergeCells();
          if (operation === "split") editor.commands.splitCell();
        }
        expect(tableJson(editor).attrs).toMatchObject({
          layoutMode: "fit-page",
          columnWidthsMm: [20, 30],
        });
      } finally {
        editor.destroy();
      }
    },
  );
  test("undoing a resize restores fit-page mode and its original width metadata", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fit-page" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
    });
    const before = tableJson(editor).attrs;
    setColumnWidths(editor, [100, 150]);
    expect(tableJson(editor).attrs?.layoutMode).toBe("fixed");
    editor.commands.undo();
    expect(tableJson(editor).attrs?.columnWidthsMm).toEqual(before?.columnWidthsMm);
    expect(tableJson(editor).attrs?.layoutMode).toBe(before?.layoutMode);
    editor.commands.redo();
    expect(tableJson(editor).attrs?.layoutMode).toBe("fixed");
    editor.destroy();
  });
  test.each(["addColumnBefore", "addColumnAfter"] as const)(
    "%s synchronizes the column count without changing fit-page layout",
    (command) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<table data-layout-mode="fit-page" data-column-widths-mm="30,40"><tr><td colwidth="113">甲</td><td colwidth="151">乙</td></tr></table>',
      });
      const first = cellPositions(editor)[0];
      if (first === undefined) throw new Error("Missing cell");
      editor.commands.setTextSelection(first + 2);
      editor.commands[command]();
      expect(tableJson(editor).attrs?.columnWidthsMm).toHaveLength(3);
      expect(tableJson(editor).attrs?.layoutMode).toBe("fit-page");
      editor.destroy();
    },
  );

  test("keeps width metadata consistent through deleting a column and undo redo", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fixed" data-column-widths-mm="20,30,40"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td><td colwidth="151">丙</td></tr></table>',
    });
    const second = cellPositions(editor)[1];
    if (second === undefined) throw new Error("Missing second cell");
    editor.commands.setTextSelection(second + 2);
    editor.commands.deleteColumn();
    expect(tableJson(editor).attrs?.columnWidthsMm).toHaveLength(2);
    const widths = tableJson(editor).attrs?.columnWidthsMm as number[];
    expect(widths[0]).toBeCloseTo(20, 0);
    expect(widths[1]).toBeCloseTo(40, 0);
    editor.commands.undo();
    expect(tableJson(editor).attrs?.columnWidthsMm).toHaveLength(3);
    editor.commands.redo();
    expect(tableJson(editor).attrs?.columnWidthsMm).toHaveLength(2);
    editor.destroy();
  });

  test("persists dragged logical column widths as fixed millimetre metadata", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });

    setColumnWidths(editor, [40, 55]);

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: [10.583, 14.552],
      layoutMode: "fixed",
    });
    editor.destroy();
  });

  test("updates fixed metadata after a later column drag", () => {
    const transactions: string[] = [];
    const editor = new Editor({
      extensions: [...createPatentExtensions(), captureInternalSyncs(transactions)],
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    setColumnWidths(editor, [40, 55]);
    transactions.length = 0;

    setColumnWidths(editor, [50, 55]);

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: [13.229, 14.552],
      layoutMode: "fixed",
    });
    expect(transactions).toEqual(["sync"]);
    editor.destroy();
  });

  test("does not append metadata when widths already match the canonical table metadata", () => {
    const transactions: string[] = [];
    const editor = new Editor({
      extensions: [...createPatentExtensions(), captureInternalSyncs(transactions)],
      content:
        '<table data-layout-mode="fixed" data-column-widths-mm="10.583,14.552"><tr><td>甲</td><td>乙</td></tr></table>',
    });

    setColumnWidths(editor, [40, 55]);

    expect(transactions).toEqual([]);
    editor.destroy();
  });

  test("does not recurse when processing its own metadata transaction", () => {
    const transactions: string[] = [];
    const editor = new Editor({
      extensions: [...createPatentExtensions(), captureInternalSyncs(transactions)],
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });

    setColumnWidths(editor, [40, 55]);

    expect(transactions).toEqual(["sync"]);
    editor.destroy();
  });

  test("does not rewrite exact command width metadata from a programmatic transaction", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    const [first, second] = cellPositions(editor);
    let tablePosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (tablePosition < 0 && node.type.name === "table") tablePosition = position;
    });
    if (first === undefined || second === undefined || tablePosition < 0)
      throw new Error("表格测试节点不存在");
    const table = editor.state.doc.nodeAt(tablePosition);
    if (!table) throw new Error("表格测试节点不存在");
    let transaction = editor.state.tr.setNodeMarkup(tablePosition, undefined, {
      ...table.attrs,
      columnWidthsMm: [42, 42],
      layoutMode: "fixed",
    });
    for (const cellPosition of [first, second]) {
      transaction = transaction.setNodeMarkup(cellPosition, undefined, {
        ...transaction.doc.nodeAt(cellPosition)?.attrs,
        colwidth: [159],
      });
    }

    editor.view.dispatch(transaction.setMeta("patentTableCommandColumnWidth", true));

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: [42, 42],
      layoutMode: "fixed",
    });
    editor.destroy();
  });

  test("ignores transactions that do not change cell colwidth attributes", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    const first = cellPositions(editor)[0];
    if (first === undefined) throw new Error("第一个单元格不存在");

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: null,
      layoutMode: "fit-page",
    });

    editor.view.dispatch(editor.state.tr.insertText("修订", first + 2));

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: null,
      layoutMode: "fit-page",
    });
    editor.destroy();
  });

  test("does not persist malformed physical column widths", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });

    setColumnWidths(editor, [40, 0]);

    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: null,
      layoutMode: "fit-page",
    });
    editor.destroy();
  });
});
