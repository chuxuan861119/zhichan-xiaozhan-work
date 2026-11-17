import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TableMap } from "@tiptap/pm/tables";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { tableRegressionDocument } from "../../../../shared/document/table-regression-fixture";
import { runEditorCommand } from "../commands";
import { createPatentExtensions } from "../extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";
import { sanitizePastedHtmlWithFormulas } from "../paste-sanitizer";
import { insertPatentTable, runTableCommand, type TableCommand } from "./table-commands";
import { inspectTableSelection } from "./table-selection";

function tableNode(editor: Editor) {
  const node = editor.state.doc.firstChild;
  if (node?.type.name !== "table") throw new Error("Missing table");
  return node;
}

function firstCellPosition(editor: Editor) {
  const position = cells(editor)[0];
  if (position === undefined) throw new Error("Missing cell");
  return position;
}

test.each(["center", "right"])(
  "implicit cell alignment %s survives saving without overriding explicit paragraphs",
  (alignment) => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    const base = createBlankBookDocument("继承对齐");
    try {
      editor.commands.insertContent(
        `<table><tr><td data-horizontal-alignment="${alignment}"><p>继承</p><p style="text-align:left">明确左对齐</p></td></tr></table>`,
      );
      const saved = tiptapToPatentBookDocument(editor.getJSON(), base, new Set());
      if (!saved.ok) throw new Error(JSON.stringify(saved));
      const table = saved.value.content[0];
      if (table?.type !== "table") throw new Error("Missing table");
      expect(table.rows[0]?.cells[0]?.content.map((p) => p.attrs.alignment)).toEqual([
        alignment,
        "left",
      ]);
    } finally {
      editor.destroy();
    }
  },
);

test("merged unequal columns and original formatting survive reload, editing, clipboard and history", () => {
  const { document: fixture, table } = tableRegressionDocument();
  const document = { ...createBlankBookDocument("表格回归"), content: fixture.content };
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: canonicalToTiptap(document),
  });
  try {
    expect(TableMap.get(tableNode(editor)).problems).toBeNull();
    expect(tableNode(editor).child(2).child(0).attrs.colwidth).toEqual([151]);
    expect(tableNode(editor).child(2).child(1).attrs.colwidth).toEqual([227]);
    const before = editor.getJSON();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    editor.commands.insertContent("新增");
    const after = editor.getJSON();
    expect(tableNode(editor).attrs.columnWidthsMm).toEqual(table.columnWidthsMm);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
    const saved = tiptapToPatentBookDocument(editor.getJSON(), document, new Set());
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    editor.commands.setContent(canonicalToTiptap(saved.value));
    const reopened = tiptapToPatentBookDocument(editor.getJSON(), saved.value, new Set());
    if (!reopened.ok) throw new Error(JSON.stringify(reopened));
    expect(reopened.value.content).toEqual(saved.value.content);
    const html = editor.view.serializeForClipboard(
      editor.state.doc.slice(0, editor.state.doc.content.size),
    ).dom.innerHTML;
    const pasted = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    pasted.commands.insertContent(sanitizePastedHtmlWithFormulas(html).html);
    try {
      expect(TableMap.get(tableNode(pasted)).problems).toBeNull();
      const copied = tiptapToPatentBookDocument(pasted.getJSON(), saved.value, new Set());
      if (!copied.ok) throw new Error(JSON.stringify(copied));
      const copiedTable = copied.value.content[0];
      const originalTable = saved.value.content[0];
      if (copiedTable?.type !== "table" || originalTable?.type !== "table")
        throw new Error("Missing table");
      expect(copiedTable.columnWidthsMm).toEqual(originalTable.columnWidthsMm);
      expect(
        copiedTable.rows.map((row) =>
          row.cells.map((cell) => ({
            ...cell,
            id: null,
            content: cell.content.map((p) => ({ ...p, id: null })),
          })),
        ),
      ).toEqual(
        originalTable.rows.map((row) =>
          row.cells.map((cell) => ({
            ...cell,
            id: null,
            content: cell.content.map((p) => ({ ...p, id: null })),
          })),
        ),
      );
    } finally {
      pasted.destroy();
    }
  } finally {
    editor.destroy();
  }
});

test("new headers are explicitly centered and deleting a header keeps metadata and history consistent", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
  try {
    insertPatentTable(editor, { rows: 3, columns: 2, headerRowCount: 1, layoutMode: "fit-page" });
    const table = tableNode(editor);
    expect(table.child(0).child(0).attrs.horizontalAlignment).toBe("center");
    expect(table.child(0).child(0).child(0).attrs.textAlign).toBe("center");
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    const before = editor.getJSON();
    expect(runTableCommand(editor, "delete-row")).toBe(true);
    expect(inspectTableSelection(editor).firstRowHeader).toBe(false);
    expect(tableNode(editor).attrs.headerRowCount).toBe(0);
    const after = editor.getJSON();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(inspectTableSelection(editor).firstRowHeader).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  } finally {
    editor.destroy();
  }
});

test("toolbar alignment stays paragraph-specific through save and undo redo", () => {
  const base = createBlankBookDocument("段落对齐");
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p></p>",
  });
  try {
    editor.commands.insertContent(
      '<table><tr><td><p><em>原文甲</em></p><p style="text-align:right">原文乙</p></td></tr></table>',
    );
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    editor.commands.insertContent("保留");
    editor.view.dispatch(closeHistory(editor.state.tr));
    const before = editor.getJSON();
    expect(runEditorCommand(editor, "align-center")).toBe(true);
    expect(inspectTableSelection(editor).horizontalAlignment).toBe("center");
    const after = editor.getJSON();
    const cell = tableNode(editor).child(0).child(0);
    expect(cell.child(1).attrs.textAlign).toBe("right");
    expect(cell.attrs.horizontalAlignment).toBe("left");
    editor.commands.setCellSelection({ anchorCell: firstCellPosition(editor) });
    expect(inspectTableSelection(editor).horizontalAlignment).toBe("mixed");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
    const saved = tiptapToPatentBookDocument(editor.getJSON(), base, new Set());
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    const table = saved.value.content[0];
    if (table?.type !== "table") throw new Error("Missing table");
    expect(table.rows[0]?.cells[0]?.content.map((p) => p.attrs.alignment)).toEqual([
      "center",
      "right",
    ]);
    editor.commands.setContent(canonicalToTiptap(saved.value));
    expect(editor.state.doc.textContent).toBe("保留原文甲原文乙");
    expect(
      tableNode(editor)
        .child(0)
        .child(0)
        .child(0)
        .child(0)
        .marks.some((mark) => mark.type.name === "italic"),
    ).toBe(true);
  } finally {
    editor.destroy();
  }
});

function cells(editor: Editor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (["tableCell", "tableHeader"].includes(node.type.name)) positions.push(pos);
  });
  return positions;
}

test.each([7, 31, 97])("mixed table operations remain saveable (seed %s)", (seed) => {
  const base = createBlankBookDocument("连续操作");
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: canonicalToTiptap(base),
  });
  let random = seed;
  const next = (limit: number) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % limit;
  };
  const commands: TableCommand[] = [
    "add-row-before",
    "add-row-after",
    "add-column-before",
    "add-column-after",
    "delete-row",
    "delete-column",
    "merge-cells",
    "split-cell",
    "clear-cells",
    "toggle-header-row",
  ];
  try {
    insertPatentTable(editor, { rows: 3, columns: 3, headerRowCount: 0, layoutMode: "fit-page" });
    for (const [index, position] of [...cells(editor).entries()].reverse()) {
      editor.view.dispatch(editor.state.tr.insertText(`数据${index}`, position + 2));
    }
    for (let step = 0; step < 60; step++) {
      const positions = cells(editor);
      editor.commands.setCellSelection({
        anchorCell: positions[next(positions.length)] ?? 0,
        headCell: positions[next(positions.length)] ?? 0,
      });
      const command = commands[next(commands.length)];
      if (!command) throw new Error("Missing command");
      editor.view.dispatch(closeHistory(editor.state.tr));
      const before = editor.getJSON();
      const changed = runTableCommand(editor, command);
      const after = editor.getJSON();
      const check = () => {
        editor.state.doc.descendants((node) => {
          if (node.type.name === "table") {
            expect(TableMap.get(node).problems, `${step}: ${command}`).toBeNull();
            const headers: boolean[] = [];
            node.firstChild?.forEach((cell) => {
              headers.push(cell.type.name === "tableHeader");
            });
            expect(node.attrs.headerRowCount).toBe(
              headers.length > 0 && headers.every(Boolean) ? 1 : 0,
            );
          }
        });
        const saved = tiptapToPatentBookDocument(editor.getJSON(), base, new Set());
        if (!saved.ok) throw new Error(`${step}: ${command}: ${JSON.stringify(saved)}`);
        const reloaded = new Editor({
          extensions: createPatentExtensions(),
          content: canonicalToTiptap(saved.value),
        });
        try {
          const roundtrip = tiptapToPatentBookDocument(reloaded.getJSON(), saved.value, new Set());
          if (!roundtrip.ok) throw new Error(`Reload: ${JSON.stringify(roundtrip)}`);
          expect(roundtrip.value.content).toEqual(saved.value.content);
        } finally {
          reloaded.destroy();
        }
      };
      check();
      if (changed && JSON.stringify(before) !== JSON.stringify(after)) {
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON(), `${step}: ${command}: undo`).toEqual(before);
        check();
        expect(editor.commands.redo()).toBe(true);
        expect(editor.getJSON(), `${step}: ${command}: redo`).toEqual(after);
        check();
      }
    }
  } finally {
    editor.destroy();
  }
});

test("fully merged rows remain saveable and reloadable", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
  try {
    insertPatentTable(editor, { rows: 2, columns: 2, headerRowCount: 0, layoutMode: "fit-page" });
    const positions = cells(editor);
    editor.commands.setCellSelection({
      anchorCell: positions[0] ?? 0,
      headCell: positions.at(-1) ?? 0,
    });
    expect(runTableCommand(editor, "merge-cells")).toBe(true);
    expect(inspectTableSelection(editor)).toMatchObject({
      canDeleteRow: false,
      canDeleteColumn: false,
    });
    const saved = tiptapToPatentBookDocument(
      editor.getJSON(),
      createBlankBookDocument("合并"),
      new Set(),
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    editor.commands.setContent(canonicalToTiptap(saved.value));
    editor.commands.setTextSelection((cells(editor)[0] ?? 0) + 2);
    expect(runTableCommand(editor, "split-cell")).toBe(true);
    expect(cells(editor)).toHaveLength(4);
  } finally {
    editor.destroy();
  }
});

test.each([
  "add-row-before",
  "add-row-after",
  "add-column-before",
  "add-column-after",
  "delete-row",
  "delete-column",
  "delete-table",
] as const)("%s preserves a valid saveable grid through undo/redo", (command: TableCommand) => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: canonicalToTiptap(createBlankBookDocument("操作")),
  });
  try {
    insertPatentTable(editor, { rows: 2, columns: 2, headerRowCount: 0, layoutMode: "fit-page" });
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.setTextSelection((cells(editor)[0] ?? 0) + 2);
    expect(runTableCommand(editor, command)).toBe(true);
    const check = () => {
      editor.state.doc.descendants((node) => {
        if (node.type.name === "table") expect(TableMap.get(node).problems).toBeNull();
      });
      const saved = tiptapToPatentBookDocument(
        editor.getJSON(),
        createBlankBookDocument("操作"),
        new Set(),
      );
      if (!saved.ok) throw new Error(JSON.stringify(saved));
    };
    check();
    expect(editor.commands.undo()).toBe(true);
    check();
    expect(editor.commands.redo()).toBe(true);
    check();
  } finally {
    editor.destroy();
  }
});
