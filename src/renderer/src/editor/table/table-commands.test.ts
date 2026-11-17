import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { createPatentExtensions } from "../extensions";
import {
  insertPatentTable,
  runTableCommand,
  setSelectedCellAttribute,
  setSelectedCellBorders,
  setSelectedColumnWidth,
  setSelectedRowHeight,
  setTableAnnotation,
  setTableRowHeightByIndexes,
  type TableInsertRequest,
} from "./table-commands";
import { inspectTableSelection } from "./table-selection";

const INSERT: TableInsertRequest = {
  rows: 2,
  columns: 2,
  headerRowCount: 0,
  layoutMode: "fit-page",
};

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

function tableJson(editor: Editor): JSONContent {
  const table = editor.getJSON().content?.find((node) => node.type === "table");
  if (!table) throw new Error("测试表格不存在");
  return table;
}

describe("table commands", () => {
  test("optional table annotations preserve hidden text and undo independently", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    try {
      insertPatentTable(editor, INSERT);
      editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
      expect(tableJson(editor).attrs?.tableNameEnabled).toBe(false);
      expect(setTableAnnotation(editor, { tableNameEnabled: true, tableName: "测试结果" })).toBe(
        true,
      );
      expect(
        setTableAnnotation(editor, {
          tableNoteEnabled: true,
          tableNote: "三次测试的平均值。\n单位为秒。",
        }),
      ).toBe(true);
      expect(setTableAnnotation(editor, { tableNameEnabled: false })).toBe(true);
      expect(tableJson(editor).attrs).toMatchObject({
        tableNameEnabled: false,
        tableName: "测试结果",
        tableNoteEnabled: true,
      });
      expect(editor.commands.undo()).toBe(true);
      expect(tableJson(editor).attrs?.tableNameEnabled).toBe(true);
      expect(editor.commands.redo()).toBe(true);
      expect(tableJson(editor).attrs?.tableNameEnabled).toBe(false);
    } finally {
      editor.destroy();
    }
  });
  test.each(["left", "center", "right"] as const)(
    "synchronizes paragraph alignment to %s even when the cell already matches",
    (alignment) => {
      for (const multiple of [false, true]) {
        const editor = new Editor({
          extensions: createPatentExtensions(),
          content: `<p>outside</p><table><tr><td data-horizontal-alignment="${alignment}"><p style="text-align: right"><strong>first</strong></p><p style="text-align: left">second</p></td><td><p style="text-align: right">neighbor</p></td></tr></table>`,
        });
        try {
          const initialized = editor.state.tr;
          editor.state.doc.descendants((node, position) => {
            if ("nodeId" in node.attrs && !node.attrs.nodeId)
              initialized.setNodeMarkup(position, undefined, {
                ...node.attrs,
                nodeId: crypto.randomUUID(),
              });
          });
          editor.view.dispatch(initialized.setMeta("addToHistory", false));
          const [first, second] = cellPositions(editor);
          if (first === undefined || second === undefined) throw new Error("Missing cells");
          if (multiple) editor.commands.setCellSelection({ anchorCell: first, headCell: second });
          else editor.commands.setTextSelection(first + 2);
          editor.view.dispatch(closeHistory(editor.state.tr));
          const before = editor.getJSON();
          const untouched = editor.state.doc.nodeAt(second);
          if (!untouched) throw new Error("Missing neighbor cell");
          expect(setSelectedCellAttribute(editor, "horizontalAlignment", alignment)).toBe(true);
          for (const position of multiple ? [first, second] : [first]) {
            const cell = editor.state.doc.nodeAt(position);
            expect(cell?.attrs.horizontalAlignment).toBe(alignment);
            cell?.descendants((node) => {
              if (node.type.name === "paragraph") expect(node.attrs.textAlign).toBe(alignment);
            });
          }
          if (!multiple) expect(editor.state.doc.nodeAt(second)?.eq(untouched)).toBe(true);
          expect(editor.state.doc.nodeAt(first)?.firstChild?.firstChild?.marks[0]?.type.name).toBe(
            "bold",
          );
          const after = editor.getJSON();
          expect(inspectTableSelection(editor).horizontalAlignment).toBe(alignment);
          expect(editor.commands.undo()).toBe(true);
          expect(editor.getJSON()).toEqual(before);
          expect(editor.commands.redo()).toBe(true);
          expect(editor.getJSON()).toEqual(after);
        } finally {
          editor.destroy();
        }
      }
    },
  );
  test.each(["add-row-before", "add-row-after"] as const)(
    "%s works in a fixed-width table with multiple rows",
    (command) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<p>前文</p><table data-layout-mode="fixed" data-column-widths-mm="20,30"><tr><td colwidth="76"><p>甲</p></td><td colwidth="113"><p>乙</p></td></tr><tr><td colwidth="76"><p>丙</p></td><td colwidth="113"><p>丁</p></td></tr><tr><td colwidth="76"><p>戊</p></td><td colwidth="113"><p>己</p></td></tr></table><p></p>',
      });
      try {
        editor.commands.setTextSelection((cellPositions(editor)[2] ?? 0) + 2);
        expect(runTableCommand(editor, command)).toBe(true);
        expect(tableJson(editor).content).toHaveLength(4);
        expect(editor.commands.undo()).toBe(true);
        expect(tableJson(editor).content).toHaveLength(3);
        expect(editor.commands.redo()).toBe(true);
        expect(tableJson(editor).content).toHaveLength(4);
      } finally {
        editor.destroy();
      }
    },
  );
  test.each(["add-row-after", "delete-table", "clear-cells", "fit-page"] as const)(
    "rejects %s when the editor becomes read-only",
    (command) => {
      const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
      try {
        insertPatentTable(editor, INSERT);
        editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
        editor.setEditable(false);
        const before = editor.getJSON();
        expect(runTableCommand(editor, command)).toBe(false);
        expect(editor.getJSON()).toEqual(before);
      } finally {
        editor.destroy();
      }
    },
  );

  test("rejects table insertion and formatting after editing is disabled", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    try {
      editor.setEditable(false);
      expect(insertPatentTable(editor, INSERT)).toBe(false);
      editor.setEditable(true);
      insertPatentTable(editor, INSERT);
      editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
      editor.setEditable(false);
      const before = editor.getJSON();
      expect(setSelectedCellAttribute(editor, "horizontalAlignment", "center")).toBe(false);
      expect(setSelectedCellBorders(editor, "all", "double")).toBe(false);
      expect(setSelectedRowHeight(editor, { heightMm: 20, rule: "exact" })).toBe(false);
      expect(setSelectedColumnWidth(editor, 42)).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("distributing columns preserves precise widths of unselected columns", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fixed" data-column-widths-mm="25.4,50.8,33.333"><tr><td colwidth="96">甲</td><td colwidth="192">乙</td><td colwidth="126">丙</td></tr></table>',
    });
    try {
      const initialized = editor.state.tr;
      editor.state.doc.descendants((node, position) => {
        if ("nodeId" in node.attrs && !node.attrs.nodeId)
          initialized.setNodeMarkup(position, undefined, {
            ...node.attrs,
            nodeId: crypto.randomUUID(),
          });
      });
      editor.view.dispatch(initialized);
      const cells = cellPositions(editor);
      editor.commands.setCellSelection({ anchorCell: cells[0] ?? 0, headCell: cells[1] ?? 0 });
      editor.view.dispatch(closeHistory(editor.state.tr));
      const before = editor.getJSON();
      expect(runTableCommand(editor, "distribute-columns")).toBe(true);
      expect(tableJson(editor).attrs?.columnWidthsMm).toEqual([38.1, 38.1, 33.333]);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });
  test("merges and splits a three-column header row without secure-context randomUUID", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    try {
      insertPatentTable(editor, { ...INSERT, columns: 3, headerRowCount: 1 });
      const positions = allCellPositions(editor);
      editor.commands.setCellSelection({
        anchorCell: positions[0] ?? 0,
        headCell: positions[2] ?? 0,
      });
      expect(runTableCommand(editor, "merge-cells")).toBe(true);
      expect(inspectTableSelection(editor).canSplit).toBe(true);
      const original = crypto.randomUUID;
      try {
        Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
        expect(runTableCommand(editor, "split-cell")).toBe(true);
      } finally {
        Object.defineProperty(crypto, "randomUUID", { configurable: true, value: original });
      }
      expect(tableJson(editor).content?.[0]?.content).toHaveLength(3);
    } finally {
      editor.destroy();
    }
  });
  test.each(["fixed-width", "set-width"])(
    "%s preserves rendered widths of untouched fit-page columns",
    (command) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<table data-layout-mode="fit-page" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
      });
      try {
        const table = editor.view.dom.querySelector("table");
        if (!table) throw new Error("Missing table");
        // Layout widths are unscaled CSS pixels, including when an ancestor is zoomed.
        Object.defineProperty(table, "offsetWidth", { configurable: true, value: 400 });
        editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
        if (command === "fixed-width") expect(runTableCommand(editor, command)).toBe(true);
        else expect(setSelectedColumnWidth(editor, 42)).toBe(true);
        const widths = tableJson(editor).attrs?.columnWidthsMm;
        expect(widths[0]).toBeCloseTo(
          command === "fixed-width" ? ((400 * 25.4) / 96) * 0.4 : 42,
          2,
        );
        expect(widths[1]).toBeCloseTo(((400 * 25.4) / 96) * 0.6, 2);
      } finally {
        editor.destroy();
      }
    },
  );

  test("fit-page metadata uses the actual editor content width", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    try {
      Object.defineProperty(editor.view.dom, "clientWidth", { configurable: true, value: 400 });
      editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);
      expect(runTableCommand(editor, "fit-page")).toBe(true);
      const widths = tableJson(editor).attrs?.columnWidthsMm as number[];
      expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo((400 * 25.4) / 96, 2);
    } finally {
      editor.destroy();
    }
  });

  test("merging a whole row preserves fixed column widths and table size", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fixed" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
    });
    try {
      const [first, second] = cellPositions(editor);
      if (first === undefined || second === undefined) throw new Error("Missing cells");
      const width = editor.view.dom.querySelector("table")?.style.width;
      editor.commands.setCellSelection({ anchorCell: first, headCell: second });
      editor.view.dispatch(closeHistory(editor.state.tr));
      expect(runTableCommand(editor, "merge-cells")).toBe(true);
      expect(editor.state.doc.nodeAt(first)?.attrs.colwidth).toEqual([76, 113]);
      expect(editor.view.dom.querySelector("table")?.style.width).toBe(width);
      expect(editor.getText()).toContain("甲");
      expect(editor.getText()).toContain("乙");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.view.dom.querySelector("table")?.style.width).toBe(width);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.nodeAt(first)?.attrs.colwidth).toEqual([76, 113]);
    } finally {
      editor.destroy();
    }
  });
  test.each([
    ["horizontalAlignment", "center"],
    ["verticalAlignment", "middle"],
    ["borderStyle", "double"],
  ] as const)(
    "applies %s to a mixed selection even when the head already matches",
    (name, value) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: "<p></p>",
      });
      try {
        insertPatentTable(editor, INSERT);
        const [first, second] = cellPositions(editor);
        if (first === undefined || second === undefined) throw new Error("Missing cells");
        if (name === "verticalAlignment") {
          editor.commands.setTextSelection(first + 2);
          setSelectedCellAttribute(editor, name, "top");
        }
        editor.commands.setTextSelection(second + 2);
        expect(setSelectedCellAttribute(editor, name, value)).toBe(true);
        editor.commands.setCellSelection({
          anchorCell: first,
          headCell: second,
        });
        editor.view.dispatch(closeHistory(editor.state.tr));
        const before = editor.getJSON();
        expect(setSelectedCellAttribute(editor, name, value)).toBe(true);
        expect(editor.state.doc.nodeAt(first)?.attrs[name]).toBe(value);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.redo()).toBe(true);
        expect(editor.state.doc.nodeAt(first)?.attrs[name]).toBe(value);
      } finally {
        editor.destroy();
      }
    },
  );
  test("inner borders preserve the outside edges after removing all borders", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, INSERT);
    const positions = cellPositions(editor);
    const first = positions[0];
    const last = positions[3];
    if (first === undefined || last === undefined) throw new Error("Missing table cells");
    editor.commands.setCellSelection({ anchorCell: first, headCell: last });
    setSelectedCellBorders(editor, "none", "single");
    setSelectedCellBorders(editor, "inner", "single");
    expect(editor.state.doc.nodeAt(first)?.attrs).toMatchObject({
      borderTop: "none",
      borderLeft: "none",
      borderRight: "single",
      borderBottom: "single",
    });
    expect(editor.state.doc.nodeAt(last)?.attrs).toMatchObject({
      borderBottom: "none",
      borderRight: "none",
      borderLeft: "single",
      borderTop: "single",
    });
    editor.destroy();
  });
  test("rejects invalid table dimensions and nested insertion", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });

    expect(insertPatentTable(editor, { ...INSERT, rows: 0 })).toBe(false);
    expect(insertPatentTable(editor, { ...INSERT, columns: 31 })).toBe(false);
    expect(insertPatentTable(editor, INSERT)).toBe(true);
    expect(insertPatentTable(editor, INSERT)).toBe(false);
    editor.destroy();
  });

  test("formats all selected cells and keeps a merged result selected for splitting", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, INSERT);
    const [first, second] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    editor.commands.setCellSelection({ anchorCell: first, headCell: second });
    expect(setSelectedCellAttribute(editor, "horizontalAlignment", "center")).toBe(true);
    expect(runTableCommand(editor, "merge-cells")).toBe(true);
    expect(inspectTableSelection(editor)).toMatchObject({ kind: "cell", canSplit: true });
    expect(runTableCommand(editor, "split-cell")).toBe(true);
    editor.destroy();
  });

  test("does not delete the last remaining table row or column", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, { ...INSERT, rows: 1, columns: 1 });
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "delete-row")).toBe(false);
    expect(runTableCommand(editor, "delete-column")).toBe(false);
    editor.destroy();
  });

  test("persists requested header-row and layout attributes on insertion", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });

    expect(insertPatentTable(editor, { ...INSERT, headerRowCount: 1, layoutMode: "fixed" })).toBe(
      true,
    );
    expect(tableJson(editor).attrs).toMatchObject({ headerRowCount: 1, layoutMode: "fixed" });
    expect(tableJson(editor).content?.[0]?.content?.[0]?.type).toBe("tableHeader");
    editor.destroy();
  });

  test("clears selected cell content without changing the table structure", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>",
    });
    const [first, second] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    editor.commands.setCellSelection({ anchorCell: first, headCell: second });

    expect(runTableCommand(editor, "clear-cells")).toBe(true);
    expect(tableJson(editor).content?.[0]?.content).toHaveLength(2);
    expect(editor.state.doc.textContent).toBe("");
    editor.destroy();
  });

  test("applies a four-sided border preset to every selected cell", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>",
    });
    const [first, second] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    editor.commands.setCellSelection({ anchorCell: first, headCell: second });

    expect(setSelectedCellBorders(editor, "all", "double")).toBe(true);
    for (const cell of tableJson(editor).content?.[0]?.content ?? []) {
      expect(cell.attrs).toMatchObject({
        borderTop: "double",
        borderRight: "double",
        borderBottom: "double",
        borderLeft: "double",
      });
    }
    editor.destroy();
  });

  test("turns the first row into horizontally and vertically centered header cells", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, INSERT);
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "toggle-header-row")).toBe(true);
    expect(tableJson(editor).attrs?.headerRowCount).toBe(1);
    const headerCells = tableJson(editor).content?.[0]?.content ?? [];
    expect(headerCells.every((cell) => cell.type === "tableHeader")).toBe(true);
    expect(
      headerCells.every(
        (cell) =>
          cell.attrs?.horizontalAlignment === "center" &&
          cell.attrs?.verticalAlignment === "middle",
      ),
    ).toBe(true);
    expect(
      headerCells.every((cell) =>
        (cell.content ?? []).every(
          (paragraph) => paragraph.type !== "paragraph" || paragraph.attrs?.textAlign === "center",
        ),
      ),
    ).toBe(true);
    editor.destroy();
  });

  test("does not insert a row above the first header row", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, { ...INSERT, headerRowCount: 1 });
    const first = allCellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "add-row-before")).toBe(false);
    expect(tableJson(editor).content).toHaveLength(2);
    expect(
      tableJson(editor).content?.[0]?.content?.every((cell) => cell.type === "tableHeader"),
    ).toBe(true);
    editor.destroy();
  });

  test("shrinking a row compacts only blank cells that would otherwise keep it tall", async () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr data-row-height-mm="20" data-row-height-rule="at-least"><td><p></p></td><td><p>保留正文格式</p></td></tr></table><p></p>',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      editor.view.dispatch(closeHistory(editor.state.tr));
      const before = editor.getJSON();
      expect(
        setTableRowHeightByIndexes(editor, 0, { heightMm: 3, rule: "at-least" }, [0], {
          compactBlankCells: true,
        }),
      ).toBe(true);

      const row = tableJson(editor).content?.[0];
      expect(row?.content?.[0]?.attrs).toMatchObject({
        paddingTopMm: 1,
        paddingRightMm: 2,
        paddingBottomMm: 1,
        paddingLeftMm: 2,
      });
      expect(row?.content?.[0]?.content?.[0]?.attrs).toMatchObject({
        lineHeight: 1,
        paragraphIndentMm: 0,
        spaceBeforePt: 0,
        spaceAfterPt: 0,
      });
      expect(row?.content?.[1]?.attrs?.paddingTopMm).toBeNull();
      expect(row?.content?.[1]?.content?.[0]?.attrs?.lineHeight).toBe(1.5);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("setting row height without a shrink gesture preserves blank-cell formatting", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td><p></p></td></tr></table><p></p>",
    });
    try {
      expect(setTableRowHeightByIndexes(editor, 0, { heightMm: 20, rule: "at-least" }, [0])).toBe(
        true,
      );
      const cell = tableJson(editor).content?.[0]?.content?.[0];
      expect(cell?.attrs?.paddingTopMm).toBeNull();
      expect(cell?.content?.[0]?.attrs?.lineHeight).toBe(1.5);
    } finally {
      editor.destroy();
    }
  });

  test.each([
    ["add-row-after", 1],
    ["add-row-before", 0],
  ] as const)(
    "%s inherits cell and paragraph formatting from the adjacent row",
    (command, rowIndex) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<table><tr><td data-padding-top-mm="0.5" data-padding-right-mm="2.5" data-padding-bottom-mm="0.75" data-padding-left-mm="3" data-horizontal-alignment="center" data-vertical-alignment="middle"><p data-line-height="1" data-space-before-pt="2" data-space-after-pt="3" data-paragraph-indent-mm="1" style="text-align:right">甲</p></td><td data-padding-top-mm="1.25" data-padding-right-mm="4" data-padding-bottom-mm="1.5" data-padding-left-mm="5" data-horizontal-alignment="right" data-vertical-alignment="bottom"><p data-line-height="1.15" data-space-before-pt="4" data-space-after-pt="5" data-paragraph-indent-mm="2" style="text-align:center">乙</p></td></tr><tr><td><p>丙</p></td><td><p>丁</p></td></tr></table>',
      });
      try {
        editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);

        expect(runTableCommand(editor, command)).toBe(true);

        const inserted = tableJson(editor).content?.[rowIndex];
        expect(inserted?.content?.[0]?.attrs).toMatchObject({
          paddingTopMm: 0.5,
          paddingRightMm: 2.5,
          paddingBottomMm: 0.75,
          paddingLeftMm: 3,
          horizontalAlignment: "center",
          verticalAlignment: "middle",
        });
        expect(inserted?.content?.[0]?.content?.[0]?.attrs).toMatchObject({
          lineHeight: 1,
          spaceBeforePt: 2,
          spaceAfterPt: 3,
          paragraphIndentMm: 1,
          textAlign: "right",
        });
        expect(inserted?.content?.[1]?.attrs).toMatchObject({
          paddingTopMm: 1.25,
          paddingRightMm: 4,
          paddingBottomMm: 1.5,
          paddingLeftMm: 5,
          horizontalAlignment: "right",
          verticalAlignment: "bottom",
        });
        expect(inserted?.content?.[1]?.content?.[0]?.attrs).toMatchObject({
          lineHeight: 1.15,
          spaceBeforePt: 4,
          spaceAfterPt: 5,
          paragraphIndentMm: 2,
          textAlign: "center",
        });
      } finally {
        editor.destroy();
      }
    },
  );

  test.each([
    ["add-column-after", 1],
    ["add-column-before", 0],
  ] as const)(
    "%s inherits each row's adjacent cell and paragraph formatting",
    (command, columnIndex) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content:
          '<table><tr><td data-padding-top-mm="0.5" data-horizontal-alignment="center"><p data-line-height="1" data-space-after-pt="2">甲</p></td><td><p>乙</p></td></tr><tr><td data-padding-top-mm="1.25" data-horizontal-alignment="right"><p data-line-height="1.15" data-space-after-pt="5">丙</p></td><td><p>丁</p></td></tr></table>',
      });
      try {
        editor.commands.setTextSelection((cellPositions(editor)[0] ?? 0) + 2);

        expect(runTableCommand(editor, command)).toBe(true);

        const rows = tableJson(editor).content ?? [];
        expect(rows[0]?.content?.[columnIndex]?.attrs).toMatchObject({
          paddingTopMm: 0.5,
          horizontalAlignment: "center",
        });
        expect(rows[0]?.content?.[columnIndex]?.content?.[0]?.attrs).toMatchObject({
          lineHeight: 1,
          spaceAfterPt: 2,
        });
        expect(rows[1]?.content?.[columnIndex]?.attrs).toMatchObject({
          paddingTopMm: 1.25,
          horizontalAlignment: "right",
        });
        expect(rows[1]?.content?.[columnIndex]?.content?.[0]?.attrs).toMatchObject({
          lineHeight: 1.15,
          spaceAfterPt: 5,
        });
      } finally {
        editor.destroy();
      }
    },
  );

  test("normalizes stray header cells when toggling the first header row", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "table",
            attrs: { headerRowCount: 0 },
            content: [
              {
                type: "tableRow",
                content: [{ type: "tableCell", content: [{ type: "paragraph", content: [] }] }],
              },
              {
                type: "tableRow",
                content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [] }] }],
              },
            ],
          },
        ],
      },
    });
    const first = allCellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "toggle-header-row")).toBe(true);
    expect(tableJson(editor).attrs?.headerRowCount).toBe(1);
    expect(tableJson(editor).content?.map((row) => row.content?.[0]?.type)).toEqual([
      "tableHeader",
      "tableCell",
    ]);

    expect(runTableCommand(editor, "toggle-header-row")).toBe(true);
    expect(tableJson(editor).attrs?.headerRowCount).toBe(0);
    expect(tableJson(editor).content?.map((row) => row.content?.[0]?.type)).toEqual([
      "tableCell",
      "tableCell",
    ]);
    editor.destroy();
  });

  test("fits all columns proportionally to the printable width without changing text", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>",
    });
    const first = cellPositions(editor)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, second] = cellPositions(editor);
    if (second === undefined) return;
    let transaction = editor.state.tr.setNodeMarkup(first, undefined, {
      ...editor.state.doc.nodeAt(first)?.attrs,
      colwidth: [100],
    });
    transaction = transaction.setNodeMarkup(second, undefined, {
      ...transaction.doc.nodeAt(second)?.attrs,
      colwidth: [300],
    });
    editor.view.dispatch(transaction);
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "fit-page")).toBe(true);
    expect(tableJson(editor).attrs?.layoutMode).toBe("fit-page");
    expect(tableJson(editor).attrs?.columnWidthsMm).toEqual([41.25, 123.75]);
    expect(editor.state.doc.textContent).toBe("甲乙");
    editor.destroy();
  });

  test("distributes the selected columns evenly", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>",
    });
    const [first, second] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    let transaction = editor.state.tr.setNodeMarkup(first, undefined, {
      ...editor.state.doc.nodeAt(first)?.attrs,
      colwidth: [100],
    });
    transaction = transaction.setNodeMarkup(second, undefined, {
      ...transaction.doc.nodeAt(second)?.attrs,
      colwidth: [300],
    });
    editor.view.dispatch(transaction);
    editor.commands.setCellSelection({ anchorCell: first, headCell: second });

    expect(runTableCommand(editor, "distribute-columns")).toBe(true);
    const cells = tableJson(editor).content?.[0]?.content ?? [];
    expect(cells[0]?.attrs?.colwidth).toEqual([200]);
    expect(cells[1]?.attrs?.colwidth).toEqual([200]);
    editor.destroy();
  });

  test("sets selected row heights in one undoable operation and rejects invalid values", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
    });
    const [first, , , last] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    editor.commands.setCellSelection({ anchorCell: first, headCell: last });

    expect(setSelectedRowHeight(editor, { heightMm: 18, rule: "exact" })).toBe(true);
    expect(tableJson(editor).content?.map((row) => row.attrs)).toEqual([
      expect.objectContaining({ rowHeightMm: 18, rowHeightRule: "exact" }),
      expect.objectContaining({ rowHeightMm: 18, rowHeightRule: "exact" }),
    ]);
    expect(setSelectedRowHeight(editor, { heightMm: 2.9, rule: "exact" })).toBe(false);
    expect(editor.commands.undo()).toBe(true);
    expect(tableJson(editor).content?.map((row) => row.attrs?.rowHeightMm)).toEqual([null, null]);
    editor.destroy();
  });

  test("sets only selected logical columns to a fixed millimetre width", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
    });
    const [, second] = cellPositions(editor);
    expect(second).toBeDefined();
    if (second === undefined) return;
    editor.commands.setTextSelection(second + 2);

    expect(setSelectedColumnWidth(editor, 42)).toBe(true);
    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: [29.898, 42],
      layoutMode: "fixed",
    });
    expect(setSelectedColumnWidth(editor, 9.9)).toBe(false);
    editor.destroy();
  });

  test("fits widths to content and locks the resulting column proportions", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    const [first, second] = cellPositions(editor);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const content = editor.view.dom.querySelectorAll<HTMLElement>(".patent-table-cell-content");
    Object.defineProperty(content[0] as HTMLElement, "scrollWidth", {
      configurable: true,
      value: (45 * 96) / 25.4 - 2,
    });
    Object.defineProperty(content[1] as HTMLElement, "scrollWidth", {
      configurable: true,
      value: (60 * 96) / 25.4 - 2,
    });
    editor.commands.setTextSelection(first + 2);

    expect(runTableCommand(editor, "auto-fit-content")).toBe(true);
    expect(tableJson(editor).attrs).toMatchObject({
      columnWidthsMm: [45, 60],
      layoutMode: "fixed",
    });
    expect(runTableCommand(editor, "fixed-width")).toBe(true);
    expect(tableJson(editor).attrs?.layoutMode).toBe("fixed");
    editor.destroy();
  });

  test("minimum width succeeds for short and empty cells", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td></td></tr></table>",
    });
    editor.commands.setTextSelection(cellPositions(editor)[0]! + 2);
    expect(runTableCommand(editor, "auto-fit-content")).toBe(true);
    const widths = tableJson(editor).attrs?.columnWidthsMm as number[];
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThan(30);
    expect(widths.every((width) => width >= (40 * 25.4) / 96 - 0.01)).toBe(true);
    editor.destroy();
  });

  test.each(["left", "center", "right"] as const)(
    "sets entire table alignment to %s without changing cell alignment",
    (alignment) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: "<table><tr><td>甲</td></tr></table>",
      });
      editor.commands.setTextSelection(cellPositions(editor)[0]! + 2);
      expect(runTableCommand(editor, `align-table-${alignment}`)).toBe(true);
      expect(tableJson(editor).attrs?.tableAlignment).toBe(alignment);
      expect(tableJson(editor).content?.[0]?.content?.[0]?.attrs?.horizontalAlignment).toBe("left");
      expect(editor.commands.undo()).toBe(true);
      expect(tableJson(editor).attrs?.tableAlignment).toBe("left");
      editor.destroy();
    },
  );

  test("fit page preserves precise stored column proportions", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fixed" data-column-widths-mm="30.123,54.877"><tr><td colwidth="113">甲</td><td colwidth="207">乙</td></tr></table>',
    });
    editor.commands.setTextSelection(cellPositions(editor)[0]! + 2);
    expect(runTableCommand(editor, "fit-page")).toBe(true);
    const widths = tableJson(editor).attrs?.columnWidthsMm as number[];
    expect(widths[0]! / widths[1]!).toBeCloseTo(30.123 / 54.877, 4);
    editor.destroy();
  });

  test("automatic arrangement clears manual heights and undoes in one step", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr data-row-height-mm="40" data-row-height-rule="exact"><td>甲</td><td>乙</td></tr></table>',
    });
    editor.commands.setTextSelection(cellPositions(editor)[0]! + 2);
    const before = JSON.parse(
      JSON.stringify(editor.getJSON(), (key, value) => (key === "nodeId" ? undefined : value)),
    );
    expect(runTableCommand(editor, "auto-arrange")).toBe(true);
    expect(tableJson(editor).content?.[0]?.attrs?.rowHeightMm).toBeNull();
    expect(editor.getText()).toContain("甲");
    expect(editor.commands.undo()).toBe(true);
    expect(
      JSON.parse(
        JSON.stringify(editor.getJSON(), (key, value) => (key === "nodeId" ? undefined : value)),
      ),
    ).toEqual(before);
    editor.destroy();
  });
});
