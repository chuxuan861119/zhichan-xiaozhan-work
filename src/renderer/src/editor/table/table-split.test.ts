import { Editor } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";
import { runTableCommand, splitSelectedTableCell } from "./table-commands";

function initializeIds(editor: Editor) {
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if ("nodeId" in node.attrs)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: crypto.randomUUID() });
  });
  editor.view.dispatch(tr.setMeta("addToHistory", false));
}

function selectCell(editor: Editor, text: string) {
  initializeIds(editor);
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell" && node.textContent === text)
      editor.commands.setTextSelection(pos + 2);
  });
}

test.each([
  [2, 3],
  [3, 1],
  [1, 2],
])("splits a normal cell into %s rows and %s columns without losing neighbors", (rows, columns) => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table data-column-widths-mm="80,80"><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>',
  });
  try {
    selectCell(editor, "甲");
    const before = editor.getJSON();
    expect(splitSelectedTableCell(editor, { rows, columns })).toBe(true);
    const table = editor.state.doc.firstChild!;
    expect(TableMap.get(table).problems).toBeNull();
    expect(table.textContent).toBe("甲乙丙丁");
    expect(TableMap.get(table).width).toBe(columns + 1);
    expect(table.childCount).toBe(rows + 1);
    expect(table.child(0).lastChild?.attrs.rowspan).toBe(rows);
    expect(table.lastChild?.firstChild?.attrs.colspan).toBe(columns);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    editor.commands.redo();
    expect(TableMap.get(editor.state.doc.firstChild!).problems).toBeNull();
  } finally {
    editor.destroy();
  }
});

test("splits merged cells into requested dimensions even when old grid differs", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table data-column-widths-mm="20,40,30"><tr><td colspan="2" rowspan="2">甲</td><td>乙</td></tr><tr><td>丙</td></tr><tr><td>丁</td><td>戊</td><td>己</td></tr></table>',
  });
  try {
    selectCell(editor, "甲");
    expect(splitSelectedTableCell(editor, { rows: 3, columns: 3 })).toBe(true);
    const table = editor.state.doc.firstChild!;
    expect(TableMap.get(table).problems).toBeNull();
    expect(table.textContent).toBe("甲乙丙丁戊己");
    expect((table.attrs.columnWidthsMm as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(90);
    const ids: string[] = [];
    table.descendants((node) => {
      if (node.attrs.nodeId) ids.push(node.attrs.nodeId);
    });
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
    const saved = tiptapToPatentBookDocument(
      editor.getJSON(),
      createBlankBookDocument("拆分"),
      new Set(),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("Split table cannot be saved");
    const restored = new Editor({
      extensions: createPatentExtensions(),
      content: canonicalToTiptap(saved.value),
    });
    try {
      const roundtrip = tiptapToPatentBookDocument(restored.getJSON(), saved.value, new Set());
      expect(roundtrip.ok).toBe(true);
      if (!roundtrip.ok) throw new Error("Reloaded table cannot be saved");
      expect(roundtrip.value.content).toEqual(saved.value.content);
    } finally {
      restored.destroy();
    }
  } finally {
    editor.destroy();
  }
});

test("invalid splits and read-only operations leave content untouched", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr></table>",
  });
  try {
    selectCell(editor, "甲");
    const before = editor.getJSON();
    for (const rows of [0, 1.5, 101, Number.NaN])
      expect(splitSelectedTableCell(editor, { rows, columns: 2 })).toBe(false);
    expect(splitSelectedTableCell(editor, { rows: 1, columns: 1 })).toBe(false);
    expect(splitSelectedTableCell(editor, { rows: 1, columns: 30 })).toBe(false);
    editor.setEditable(false);
    expect(splitSelectedTableCell(editor, { rows: 2, columns: 2 })).toBe(false);
    expect(runTableCommand(editor, "distribute-rows")).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    editor.destroy();
  }
});

test("splitting a later cell keeps recent typing when undone", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
  });
  try {
    selectCell(editor, "丁");
    editor.commands.insertContent("追加");
    const before = editor.getJSON();
    expect(splitSelectedTableCell(editor, { rows: 2, columns: 2 })).toBe(true);
    expect(TableMap.get(editor.state.doc.child(0)).problems).toBeNull();
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    editor.commands.redo();
    expect(editor.state.doc.textContent).toBe("甲乙丙追加丁");
  } finally {
    editor.destroy();
  }
});

test("multiple selected cells cannot accidentally be replaced by a single split", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  try {
    initializeIds(editor);
    const map = TableMap.get(editor.state.doc.child(0));
    editor.commands.setCellSelection({
      anchorCell: 1 + (map.map[0] ?? 0),
      headCell: 1 + (map.map[1] ?? 0),
    });
    const before = editor.getJSON();
    expect(splitSelectedTableCell(editor, { rows: 2, columns: 2 })).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    editor.destroy();
  }
});

test("splitting a header keeps the first row as header and preserves saved content", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table data-header-row-count="1" data-column-widths-mm="80,80"><tr><th>标题甲</th><th>标题乙</th></tr><tr><td>数据</td><td>其他</td></tr></table>',
  });
  try {
    initializeIds(editor);
    editor.commands.setTextSelection(4);
    expect(splitSelectedTableCell(editor, { rows: 2, columns: 2 })).toBe(true);
    const table = editor.state.doc.child(0);
    expect(table.attrs.headerRowCount).toBe(1);
    expect(table.child(0).firstChild?.type.name).toBe("tableHeader");
    expect(table.child(1).firstChild?.type.name).toBe("tableCell");
    expect(TableMap.get(table).problems).toBeNull();
    expect(
      tiptapToPatentBookDocument(editor.getJSON(), createBlankBookDocument("标题拆分"), new Set())
        .ok,
    ).toBe(true);
  } finally {
    editor.destroy();
  }
});

test("equal row heights cannot be smaller than the tallest cell's content", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="20" data-row-height-rule="exact"><td>甲</td></tr><tr data-row-height-mm="10" data-row-height-rule="exact"><td>乙</td></tr></table>',
  });
  try {
    initializeIds(editor);
    const map = TableMap.get(editor.state.doc.child(0));
    editor.commands.setCellSelection({
      anchorCell: 1 + (map.map[0] ?? 0),
      headCell: 1 + (map.map[1] ?? 0),
    });
    const content = editor.view.dom.querySelector(".patent-table-cell-content");
    if (!content) throw new Error("Missing content");
    Object.defineProperty(content, "scrollHeight", { value: 180 });
    expect(runTableCommand(editor, "distribute-rows")).toBe(true);
    const table = editor.state.doc.child(0);
    expect(table.child(0).attrs.rowHeightMm).toBeGreaterThanOrEqual((180 * 25.4) / 96);
    expect(table.child(1).attrs.rowHeightMm).toBe(table.child(0).attrs.rowHeightMm);
  } finally {
    editor.destroy();
  }
});

test("distributes selected row heights in a single undoable operation", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="20" data-row-height-rule="at-least"><td>甲</td></tr><tr data-row-height-mm="40" data-row-height-rule="exact"><td>乙</td></tr><tr><td>丙</td></tr></table>',
  });
  try {
    initializeIds(editor);
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell") positions.push(pos);
    });
    editor.commands.setCellSelection({ anchorCell: positions[0]!, headCell: positions[1]! });
    const before = editor.getJSON();
    expect(runTableCommand(editor, "distribute-rows")).toBe(true);
    const table = editor.state.doc.firstChild!;
    for (const i of [0, 1])
      expect(table.child(i).attrs).toMatchObject({ rowHeightMm: 30, rowHeightRule: "at-least" });
    expect(table.child(2).attrs.rowHeightMm).toBeNull();
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  } finally {
    editor.destroy();
  }
});
