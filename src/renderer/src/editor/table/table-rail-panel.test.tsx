import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { vi } from "vitest";
import { EditorCommandBus } from "../../app/command-bus";
import * as appDialogs from "../../shared/app-dialog";
import { createPatentExtensions } from "../extensions";
import { insertPatentTable, setSelectedCellAttribute } from "./table-commands";
import { TableRailPanel } from "./table-rail-panel";
import { EMPTY_TABLE_SELECTION, type TableSelectionSnapshot } from "./table-selection";

function firstCellPosition(editor: Editor): number {
  let position = -1;
  editor.state.doc.descendants((node, currentPosition) => {
    if (position < 0 && node.type.name === "tableCell") position = currentPosition;
  });
  if (position < 0) throw new Error("测试表格单元格不存在");
  return position;
}

function tableSelection(overrides: Partial<TableSelectionSnapshot> = {}): TableSelectionSnapshot {
  return {
    ...EMPTY_TABLE_SELECTION,
    kind: "text",
    tableFrom: 1,
    rowCount: 1,
    columnCount: 1,
    selectedCellCount: 1,
    rowHeightMm: 15,
    rowHeightRule: "at-least",
    columnWidthMm: 42,
    layoutMode: "fit-page",
    ...overrides,
  };
}

function tableRailBus(selection: TableSelectionSnapshot, commandResult = true) {
  return {
    getTableSelection: vi.fn(() => selection),
    subscribeTableSelection: vi.fn(() => () => undefined),
    setTableRowHeight: vi.fn(() => true),
    splitTableCell: vi.fn(() => commandResult),
    setTableColumnWidth: vi.fn(() => true),
    runTableCommand: vi.fn(() => commandResult),
    previewTableInsertion: vi.fn(),
    setTableCellAttribute: vi.fn(() => true),
    setTableAnnotation: vi.fn(() => true),
    setTableCellBorders: vi.fn(() => true),
  } as unknown as EditorCommandBus;
}

describe("table rail panel", () => {
  test("groups compact table actions by operation and alignment axis", () => {
    const bus = tableRailBus(
      tableSelection({
        canAddRowBefore: true,
        canDeleteRow: true,
        canDeleteColumn: true,
        canMerge: true,
      }),
    );
    render(<TableRailPanel commandBus={bus} editorId="description" />);

    for (const group of ["行操作", "列操作", "单元格操作", "水平位置", "垂直位置"]) {
      expect(screen.getByRole("group", { name: group })).toBeDefined();
    }

    for (const label of [
      "上方插入行",
      "下方插入行",
      "删除行",
      "左侧插入列",
      "右侧插入列",
      "删除列",
      "合并单元格",
      "拆分单元格",
      "将首行设为标题行",
      "适应页面",
      "最小宽度",
      "自动整理",
      "表格靠左",
      "表格居中",
      "表格靠右",
    ]) {
      expect(screen.getByRole("button", { name: label }).querySelector("svg")).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "适应页面" }));
    fireEvent.click(screen.getByRole("button", { name: "最小宽度" }));
    fireEvent.click(screen.getByRole("button", { name: "自动整理" }));
    expect(bus.runTableCommand).toHaveBeenCalledWith("description", "fit-page");
    expect(bus.runTableCommand).toHaveBeenCalledWith("description", "auto-fit-content");
    expect(bus.runTableCommand).toHaveBeenCalledWith("description", "auto-arrange");
    fireEvent.click(screen.getByRole("button", { name: "表格居中" }));
    expect(bus.runTableCommand).toHaveBeenCalledWith("description", "align-table-center");
    const cell = screen.getByRole("group", { name: "单元格操作" });
    const horizontal = screen.getByRole("group", { name: "水平位置" });
    const vertical = screen.getByRole("group", { name: "垂直位置" });
    const tablePosition = screen.getByRole("group", { name: "表格位置" });
    expect(
      cell.compareDocumentPosition(horizontal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      horizontal.compareDocumentPosition(vertical) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      vertical.compareDocumentPosition(tablePosition) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "表格居中" }).querySelector("svg")?.getAttribute("class"),
    ).not.toBe(
      screen
        .getByRole("button", { name: /^居中$/ })
        .querySelector("svg")
        ?.getAttribute("class"),
    );
  });

  test("alignment buttons update paragraphs through the real command bus", async () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr><td><p style="text-align: right">甲</p><p style="text-align: center">乙</p></td></tr></table>',
    });
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    const bus = new EditorCommandBus();
    const unregister = bus.register("description", editor, undefined, undefined, undefined, {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: false,
      images: false,
      pageBreaks: true,
    });
    const rendered = render(<TableRailPanel commandBus={bus} editorId="description" />);
    try {
      for (const [label, alignment] of [
        ["左对齐", "left"],
        ["居中", "center"],
        ["右对齐", "right"],
      ] as const) {
        const button = screen.getByRole("button", { name: label });
        fireEvent.pointerDown(button);
        fireEvent.click(button);
        await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
        editor.state.doc.nodeAt(firstCellPosition(editor))?.descendants((node) => {
          if (node.type.name === "paragraph") expect(node.attrs.textAlign).toBe(alignment);
        });
      }
    } finally {
      rendered.unmount();
      unregister();
      editor.destroy();
    }
  });
  test.each([
    ["上方插入行", "add-row-before"],
    ["下方插入行", "add-row-after"],
    ["左侧插入列", "add-column-before"],
    ["右侧插入列", "add-column-after"],
  ])("previews %s on hover without running a command", (label, command) => {
    const bus = tableRailBus(tableSelection({ canAddRowBefore: true }));
    render(<TableRailPanel commandBus={bus} editorId="description" />);
    const button = screen.getByRole("button", { name: label });
    fireEvent.mouseEnter(button);
    expect(bus.previewTableInsertion).toHaveBeenLastCalledWith("description", command);
    expect(bus.runTableCommand).not.toHaveBeenCalled();
    fireEvent.mouseLeave(button);
    expect(bus.previewTableInsertion).toHaveBeenLastCalledWith("description", null);
  });
  test("splits ordinary cells with validated dimensions and supports cancelling", () => {
    const bus = tableRailBus(tableSelection());
    render(<TableRailPanel commandBus={bus} editorId="description" />);
    fireEvent.click(screen.getByRole("button", { name: "拆分单元格" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "拆分行数" }), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用拆分" }));
    expect(bus.splitTableCell).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("至少拆成两个");
    fireEvent.change(screen.getByRole("spinbutton", { name: "拆分行数" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "拆分列数" }), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用拆分" }));
    expect(bus.splitTableCell).toHaveBeenCalledWith("description", { rows: 2, columns: 3 });
    expect(screen.queryByRole("group", { name: "拆分单元格设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "拆分单元格" }));
    fireEvent.click(screen.getByRole("button", { name: "取消拆分" }));
    expect(bus.splitTableCell).toHaveBeenCalledTimes(1);
  });

  test("explains why unavailable table operations cannot run", () => {
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const commandBus = tableRailBus(
      tableSelection({
        canDeleteRow: false,
        canDeleteColumn: false,
        canMerge: false,
        canSplit: false,
      }),
    );
    render(<TableRailPanel commandBus={commandBus} editorId="description" />);

    fireEvent.click(screen.getByRole("button", { name: "删除行" }));
    fireEvent.click(screen.getByRole("button", { name: "删除列" }));
    fireEvent.click(screen.getByRole("button", { name: "合并单元格" }));

    expect(commandBus.runTableCommand).not.toHaveBeenCalled();
    expect(alert.mock.calls.map(([message]) => message)).toEqual([
      "选区覆盖全部行。若要移除整张表，请使用“删除表格”。",
      "选区覆盖全部列。若要移除整张表，请使用“删除表格”。",
      "请先选择两个或以上可合并的单元格。",
    ]);
    alert.mockRestore();
  });

  test("explains why a row cannot be inserted above the first header row", () => {
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const commandBus = tableRailBus(tableSelection({ canAddRowBefore: false }));
    render(<TableRailPanel commandBus={commandBus} editorId="description" />);

    const button = screen.getByRole("button", { name: "上方插入行" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-unavailable")).toBe("true");
    fireEvent.click(button);

    expect(commandBus.runTableCommand).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith("标题行必须位于表格第一行，不能在其上方插入新行。");
    alert.mockRestore();
  });

  test("only appears inside a table and reflects selected cell alignment", async () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>正文</p>" });
    const commandBus = new EditorCommandBus();
    const unregister = commandBus.register("description", editor, undefined, undefined, undefined, {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: false,
      images: false,
      pageBreaks: true,
    });
    render(<TableRailPanel commandBus={commandBus} editorId="description" />);

    expect(screen.queryByRole("region", { name: "表格功能" })).toBeNull();

    await act(async () => {
      expect(
        insertPatentTable(editor, {
          rows: 1,
          columns: 1,
          headerRowCount: 0,
          layoutMode: "fit-page",
        }),
      ).toBe(true);
      editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    });

    await waitFor(() => expect(screen.getByRole("region", { name: "表格功能" })).toBeDefined());
    expect(screen.getByRole("button", { name: "左对齐" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await act(async () => {
      expect(setSelectedCellAttribute(editor, "horizontalAlignment", "center")).toBe(true);
      expect(setSelectedCellAttribute(editor, "verticalAlignment", "middle")).toBe(true);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "居中" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "垂直居中" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    for (const [label, alignment] of [
      ["顶部对齐", "top"],
      ["垂直居中", "middle"],
      ["底部对齐", "bottom"],
    ] as const) {
      fireEvent.pointerDown(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
      expect(editor.state.doc.nodeAt(firstCellPosition(editor))?.attrs.verticalAlignment).toBe(
        alignment,
      );
    }

    expect(fireEvent.pointerDown(screen.getByRole("button", { name: "居中" }))).toBe(false);
    expect(screen.getByRole("button", { name: "将首行设为标题行" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拆分单元格" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "全部边框" })).toBeNull();

    expect(screen.getByRole("button", { name: "表名" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "表名内容" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "表名" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "表名内容" })).toBeDefined());
    const nameField = screen.getByRole("textbox", { name: "表名内容" }).closest("label");
    expect(nameField?.querySelector("span")?.textContent).toBe("表名");
    expect(nameField?.classList.contains("table-rail-panel__annotation-field")).toBe(true);
    expect(screen.getByRole("textbox", { name: "表名内容" }).hasAttribute("placeholder")).toBe(
      false,
    );
    expect(screen.getByRole("textbox", { name: "表名内容" }).getAttribute("rows")).toBe("1");
    fireEvent.change(screen.getByRole("textbox", { name: "表名内容" }), {
      target: { value: "测试结果" },
    });
    fireEvent.click(screen.getByRole("button", { name: "补充说明" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "补充说明内容" })).toBeDefined(),
    );
    expect(
      screen
        .getByRole("textbox", { name: "补充说明内容" })
        .closest("label")
        ?.classList.contains("table-rail-panel__annotation-field"),
    ).toBe(true);
    expect(screen.getByRole("textbox", { name: "补充说明内容" }).hasAttribute("placeholder")).toBe(
      false,
    );
    expect(screen.getByRole("textbox", { name: "补充说明内容" }).getAttribute("rows")).toBe("1");
    fireEvent.change(screen.getByRole("textbox", { name: "补充说明内容" }), {
      target: { value: "单位：秒" },
    });
    fireEvent.click(screen.getByRole("button", { name: "表名" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "表名内容" })).toBeNull());
    expect(commandBus.getTableSelection("description")).toMatchObject({
      tableNameEnabled: false,
      tableName: "测试结果",
      tableNoteEnabled: true,
      tableNote: "单位：秒",
    });
    fireEvent.click(screen.getByRole("button", { name: "表名" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "表名内容" }) as HTMLTextAreaElement).value).toBe(
        "测试结果",
      ),
    );

    unregister();
    editor.destroy();
  });
});
