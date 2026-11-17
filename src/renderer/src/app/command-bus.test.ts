import { Editor } from "@tiptap/core";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { createPatentExtensions } from "../editor/extensions";
import { EditorCommandBus, type EditorFormatState } from "./command-bus";

function editor(overrides: Partial<Editor> = {}) {
  return {
    isDestroyed: false,
    on: vi.fn(),
    off: vi.fn(),
    state: {
      selection: { empty: false, head: 7 },
    },
    commands: {
      focus: vi.fn(() => true),
      setTextSelection: vi.fn(() => true),
    },
    ...overrides,
  } as unknown as Editor;
}

function tableCellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell") positions.push(position);
  });
  return positions;
}

describe("editor command bus", () => {
  test("a header paragraph reports inherited centering until explicitly left aligned", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><th><p>表头</p></th></tr></table>",
    });
    const bus = new EditorCommandBus();
    bus.register("header", registered);
    try {
      registered.commands.setTextSelection(4);
      expect(bus.getFormatState("header").alignment).toBe("center");
      bus.execute("header", "align-left");
      expect(bus.getFormatState("header").alignment).toBe("left");
    } finally {
      registered.destroy();
    }
  });
  test("alignment state uses the selected cell alignment until its paragraph overrides it", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr><td data-horizontal-alignment="center"><p>居中内容</p></td><td data-horizontal-alignment="right"><p>右侧内容</p></td></tr></table>',
    });
    const bus = new EditorCommandBus();
    bus.register("alignment", registered);
    try {
      let firstText = 0;
      let secondText = 0;
      registered.state.doc.descendants((node, pos) => {
        if (node.text === "居中内容") firstText = pos;
        if (node.text === "右侧内容") secondText = pos;
      });
      registered.commands.setTextSelection(firstText);
      expect(bus.getFormatState("alignment").alignment).toBe("center");
      registered.commands.setTextSelection(secondText);
      expect(bus.getFormatState("alignment").alignment).toBe("right");
      bus.execute("alignment", "align-left");
      expect(bus.getFormatState("alignment").alignment).toBe("left");
      registered.commands.undo();
      expect(bus.getFormatState("alignment").alignment).toBe("right");
    } finally {
      registered.destroy();
    }
  });
  test("mixed cell alignment does not report only the last cell's explicit alignment", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table><tr><td><p style="text-align:center">甲</p></td><td><p style="text-align:right">乙</p></td></tr></table>',
    });
    const bus = new EditorCommandBus();
    bus.register("mixed-alignment", registered);
    try {
      const [first, second] = tableCellPositions(registered);
      if (first === undefined || second === undefined) throw new Error("Missing test cells");
      registered.view.dispatch(
        registered.state.tr.setSelection(CellSelection.create(registered.state.doc, first, second)),
      );
      // The existing toolbar uses left as its neutral fallback for mixed paragraphs.
      expect(bus.getFormatState("mixed-alignment").alignment).toBe("left");
      bus.execute("mixed-alignment", "align-center");
      expect(bus.getFormatState("mixed-alignment").alignment).toBe("center");
    } finally {
      registered.destroy();
    }
  });
  test("list availability follows supported selections without modifying table formatting", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>正文</p><table><tr><td><p>表格</p></td></tr></table>",
    });
    const bus = new EditorCommandBus();
    bus.register("lists", registered);
    expect(bus.getFormatState("lists")).toMatchObject({ listToolsAvailable: true });
    let cellText = 0;
    registered.state.doc.descendants((node, pos) => {
      if (node.text === "表格") cellText = pos;
    });
    registered.commands.setTextSelection(cellText);
    expect(bus.getFormatState("lists")).toMatchObject({ listToolsAvailable: false });
    const before = registered.getJSON();
    expect(bus.execute("lists", "ordered-list")).toBe(false);
    expect(registered.getJSON()).toEqual(before);
    registered.commands.selectAll();
    expect(bus.getFormatState("lists")).toMatchObject({ listToolsAvailable: false });
    registered.commands.setTextSelection(1);
    expect(bus.getFormatState("lists")).toMatchObject({ listToolsAvailable: true });
    registered.destroy();
  });
  test.each([true, false])(
    "detects mixed effective sizes and can unify them to five point-size (%s)",
    (explicitSecond) => {
      const registered = new Editor({
        extensions: createPatentExtensions(),
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { defaultFontSizePt: 14 },
              content: [
                {
                  type: "text",
                  text: "甲",
                  marks: [{ type: "textStyle", attrs: { fontSizePt: 10.5 } }],
                },
                {
                  type: "text",
                  text: "乙",
                  ...(explicitSecond
                    ? { marks: [{ type: "textStyle", attrs: { fontSizePt: 14 } }] }
                    : {}),
                },
              ],
            },
          ],
        },
      });
      const bus = new EditorCommandBus();
      bus.register("mixed-size", registered);
      registered.commands.setTextSelection({ from: 1, to: 3 });
      expect(bus.getFormatState("mixed-size")).toMatchObject({ mixedFontSize: true });
      expect(bus.getFormatState("mixed-size").fontSizePt).toBeUndefined();
      expect(bus.setFontSizePt("mixed-size", 10.5)).toBe(true);
      expect(bus.getFormatState("mixed-size").fontSizePt).toBe(10.5);
      expect(bus.getFormatState("mixed-size")).not.toMatchObject({ mixedFontSize: true });
      expect(registered.state.selection.from).toBe(1);
      expect(registered.state.selection.to).toBe(3);
      registered.destroy();
    },
  );

  test("does not mistake different marks with the same effective size for mixed sizes", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { defaultFontSizePt: 14 },
            content: [
              {
                type: "text",
                text: "甲",
                marks: [{ type: "textStyle", attrs: { fontSizePt: 14 } }],
              },
              { type: "text", text: "乙" },
            ],
          },
        ],
      },
    });
    const bus = new EditorCommandBus();
    bus.register("same-size", registered);
    registered.commands.setTextSelection({ from: 1, to: 3 });
    expect(bus.getFormatState("same-size").fontSizePt).toBe(14);
    expect(bus.getFormatState("same-size")).not.toMatchObject({ mixedFontSize: true });
    registered.destroy();
  });

  test("detects mixed fonts and paragraph styles without using just the first run", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { defaultFontFamily: "SimSun", defaultFontSizePt: 14 },
            content: [{ type: "text", text: "甲" }],
          },
          {
            type: "heading",
            attrs: { level: 1, defaultFontFamily: "Source Han Serif CN", defaultFontSizePt: 16 },
            content: [{ type: "text", text: "乙" }],
          },
        ],
      },
    });
    const bus = new EditorCommandBus();
    bus.register("mixed-blocks", registered);
    registered.commands.selectAll();
    expect(bus.getFormatState("mixed-blocks")).toMatchObject({
      mixedFontFamily: true,
      mixedFontSize: true,
      mixedParagraphStyle: true,
    });
    registered.destroy();
  });
  test("inspects only selected table cells and can unify mixed cell sizes", () => {
    const cell = (fontSizePt: number) => ({
      type: "tableCell",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "字", marks: [{ type: "textStyle", attrs: { fontSizePt } }] },
          ],
        },
      ],
    });
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              { type: "tableRow", content: [cell(10.5), cell(14)] },
              { type: "tableRow", content: [cell(10.5), cell(14)] },
            ],
          },
        ],
      },
    });
    const bus = new EditorCommandBus();
    bus.register("mixed-cells", registered);
    const positions = tableCellPositions(registered);
    const [topLeft, , bottomLeft, bottomRight] = positions;
    if (topLeft === undefined || bottomLeft === undefined || bottomRight === undefined)
      throw new Error("Missing test cells");
    registered.view.dispatch(
      registered.state.tr.setSelection(
        CellSelection.create(registered.state.doc, topLeft, bottomLeft),
      ),
    );
    expect(bus.getFormatState("mixed-cells").fontSizePt).toBe(10.5);
    expect(bus.getFormatState("mixed-cells").mixedFontSize).not.toBe(true);
    registered.view.dispatch(
      registered.state.tr.setSelection(
        CellSelection.create(registered.state.doc, topLeft, bottomRight),
      ),
    );
    expect(bus.getFormatState("mixed-cells").mixedFontSize).toBe(true);
    expect(bus.setFontSizePt("mixed-cells", 10.5)).toBe(true);
    expect(bus.getFormatState("mixed-cells").fontSizePt).toBe(10.5);
    expect(bus.getFormatState("mixed-cells").mixedFontSize).not.toBe(true);
    registered.destroy();
  });
  test("deduplicates figure metadata notifications but publishes size and selection changes", () => {
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "figure",
            attrs: {
              assetId: "00000000-0000-4000-8000-000000000301",
              widthMm: 80,
              alignment: "center",
              rotationDeg: 0,
            },
          },
          { type: "paragraph", content: [{ type: "text", text: "图后正文" }] },
        ],
      },
    });
    registered.commands.setNodeSelection(0);
    const bus = new EditorCommandBus();
    bus.register("figure-dedup", registered);
    const changes = vi.fn();
    const release = bus.subscribeFigureSelection("figure-dedup", changes);
    registered.view.dispatch(registered.state.tr.setMeta("unchanged", true));
    changes.mockClear();
    for (let index = 0; index < 10; index++)
      registered.view.dispatch(registered.state.tr.setMeta("unchanged", true));
    expect(changes.mock.calls.length).toBe(0);
    registered.commands.updateAttributes("figure", { widthMm: 90 });
    expect(changes.mock.calls.length).toBe(1);
    expect(changes.mock.calls[0]?.[0]).toMatchObject({ kind: "figure", widthMm: 90 });
    registered.commands.setTextSelection(registered.state.doc.content.size - 1);
    expect(changes.mock.calls.length).toBe(2);
    expect(changes.mock.calls[1]?.[0]).toEqual({ kind: "none" });
    release();
    registered.destroy();
  });
  test("deduplicates unchanged table notifications while publishing real selection changes", () => {
    const registered = new Editor({ extensions: createPatentExtensions(), content: "<p>原文</p>" });
    registered.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    registered.commands.setTextSelection(3);
    const bus = new EditorCommandBus();
    bus.register("table-dedup", registered);
    const changes = vi.fn();
    const release = bus.subscribeTableSelection("table-dedup", changes);
    registered.view.dispatch(registered.state.tr.setMeta("unchanged", true));
    changes.mockClear();
    for (let index = 0; index < 10; index++)
      registered.view.dispatch(registered.state.tr.setMeta("unchanged", true));
    expect(changes.mock.calls.length).toBe(0);
    registered.commands.setTextSelection(registered.state.doc.content.size - 1);
    expect(changes.mock.calls.length).toBe(1);
    expect(changes.mock.calls[0]?.[0].kind).toBe("none");
    release();
    registered.destroy();
  });
  test("routes history through the target editor adapter and distinguishes new edits from undo", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({ extensions: createPatentExtensions(), content: "<p>原文</p>" });
    bus.register("claims", registered);
    const execute = vi.fn((): boolean | null => true);
    const onEdit = vi.fn();
    const release = bus.setPatentHistoryAdapter({ execute, canExecute: () => true, onEdit });
    expect(bus.getHistoryState("claims").canUndo).toBe(true);
    expect(bus.execute("claims", "undo")).toBe(true);
    expect(execute).toHaveBeenCalledWith("claims", "undo");
    registered.commands.insertContent("新增");
    expect(onEdit).toHaveBeenCalledTimes(1);
    registered.commands.undo();
    expect(onEdit).toHaveBeenCalledTimes(1);
    registered.view.dispatch(registered.state.tr.insertText("外部").setMeta("addToHistory", false));
    expect(onEdit).toHaveBeenCalledTimes(1);
    release();
    registered.destroy();
  });
  test("publishes actual undo and redo availability after document transactions", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>原始内容</p>",
    });
    const states: { canUndo: boolean; canRedo: boolean }[] = [];
    const unsubscribe = bus.subscribeHistoryState("history-state", (state) => states.push(state));
    bus.register("history-state", registered);

    expect(states.at(-1)).toEqual({ canUndo: false, canRedo: false });
    registered.commands.insertContent("修改");
    expect(states.at(-1)).toEqual({ canUndo: true, canRedo: false });
    registered.commands.undo();
    expect(states.at(-1)).toEqual({ canUndo: false, canRedo: true });

    unsubscribe();
    registered.destroy();
  });

  test("retains one editor instance until its open-session id is disposed", () => {
    const bus = new EditorCommandBus();
    const created = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>保留历史</p>",
    });

    expect(bus.retainEditor("retained", () => created)).toBe(created);
    expect(
      bus.retainEditor(
        "retained",
        () =>
          new Editor({
            extensions: createPatentExtensions(),
            content: "<p>不应创建</p>",
          }),
      ),
    ).toBe(created);
    expect(bus.disposeRetainedEditorsExcept(new Set(["retained"]))).toBe(0);
    expect(bus.disposeRetainedEditorsExcept(new Set())).toBe(1);
    expect(created.isDestroyed).toBe(true);
  });

  test("replaces a registered document as one undoable and redoable history step", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>原始说明书内容。</p>",
    });
    bus.register("history:description", registered);

    expect(
      bus.replaceDocumentWithHistory("history:description", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "新填入的附图说明。" }] }],
      }),
    ).toBe(true);
    expect(registered.getText()).toBe("新填入的附图说明。");

    expect(registered.commands.undo()).toBe(true);
    expect(registered.getText()).toBe("原始说明书内容。");
    expect(registered.commands.redo()).toBe(true);
    expect(registered.getText()).toBe("新填入的附图说明。");

    registered.destroy();
  });

  test("notifies subscribers when an editor registers and unregisters", () => {
    const bus = new EditorCommandBus();
    const registered = editor();
    const listener = vi.fn();
    const unsubscribe = bus.subscribeEditors(listener);

    const unregister = bus.register("session:description", registered);
    expect(listener).toHaveBeenCalledWith("session:description", registered);
    unregister();
    expect(listener).toHaveBeenCalledWith("session:description", null);

    unsubscribe();
    bus.register("session:claims", editor());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("tracks the last focused editor and its selection bookmark", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>焦点目标</p>",
    });
    const unregister = bus.register("focus-target", registered);
    const states: unknown[] = [];
    const unsubscribe = bus.subscribeEditorFocus((snapshot) => states.push(snapshot));

    registered.commands.setTextSelection({ from: 2, to: 5 });
    expect(bus.publishEditorFocus("focus-target")).toBe(true);
    expect(states.at(-1)).toEqual({
      editorId: "focus-target",
      bookmark: { from: 2, to: 5 },
    });
    expect(bus.getFocusedEditor()).toEqual(states.at(-1));

    unregister();
    expect(states.at(-1)).toBeNull();
    unsubscribe();
    registered.destroy();
  });

  test("restores a non-empty text selection when the same editor is remounted", () => {
    const bus = new EditorCommandBus();
    const first = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙丁戊己</p>",
    });
    first.commands.setTextSelection({ from: 2, to: 6 });
    const unregisterFirst = bus.register("layout-selection", first);

    expect(bus.retainSelectionForNextRegistration("layout-selection")).toBe(true);
    unregisterFirst();
    const replacement = new Editor({
      extensions: createPatentExtensions(),
      content: first.state.doc.toJSON(),
    });
    expect(first.state.selection).toBeInstanceOf(TextSelection);
    expect(replacement.state.doc.toJSON()).toEqual(first.state.doc.toJSON());
    bus.register("layout-selection", replacement);

    expect(replacement.state.selection).toBeInstanceOf(TextSelection);
    expect(replacement.state.selection).toMatchObject({ from: 2, to: 6, empty: false });
    first.destroy();
    replacement.destroy();
  });

  test("restores a full-document selection when the same editor is remounted", () => {
    const bus = new EditorCommandBus();
    const first = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙</p><p>丙丁</p>",
    });
    first.commands.selectAll();
    const unregisterFirst = bus.register("layout-select-all", first);

    expect(bus.retainSelectionForNextRegistration("layout-select-all")).toBe(true);
    unregisterFirst();
    const replacement = new Editor({
      extensions: createPatentExtensions(),
      content: first.state.doc.toJSON(),
    });
    expect(first.state.selection).toBeInstanceOf(AllSelection);
    expect(replacement.state.doc.toJSON()).toEqual(first.state.doc.toJSON());
    bus.register("layout-select-all", replacement);

    expect(replacement.state.selection).toBeInstanceOf(AllSelection);
    expect(replacement.state.selection.empty).toBe(false);
    first.destroy();
    replacement.destroy();
  });

  test("does not restore a retained selection into changed document content", () => {
    const bus = new EditorCommandBus();
    const first = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>原始正文内容</p>",
    });
    first.commands.setTextSelection({ from: 2, to: 5 });
    const unregisterFirst = bus.register("changed-layout-selection", first);

    expect(bus.retainSelectionForNextRegistration("changed-layout-selection")).toBe(true);
    unregisterFirst();
    const replacement = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>已经变化的正文内容</p>",
    });
    bus.register("changed-layout-selection", replacement);

    expect(replacement.state.selection.empty).toBe(true);
    first.destroy();
    replacement.destroy();
  });

  test("does not retain a selection across an ordinary editor registration refresh", () => {
    const bus = new EditorCommandBus();
    const first = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>普通编辑器刷新</p>",
    });
    first.commands.setTextSelection({ from: 2, to: 5 });
    const unregisterFirst = bus.register("ordinary-refresh", first);

    unregisterFirst();
    const replacement = new Editor({
      extensions: createPatentExtensions(),
      content: first.state.doc.toJSON(),
    });
    bus.register("ordinary-refresh", replacement);

    expect(replacement.state.selection.empty).toBe(true);
    first.destroy();
    replacement.destroy();
  });

  test("retains selections from active and background editors for a layout remount", () => {
    const bus = new EditorCommandBus();
    const active = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>当前文档正文</p>",
    });
    const background = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>后台文档正文</p>",
    });
    active.commands.setTextSelection({ from: 2, to: 5 });
    background.commands.setTextSelection({ from: 3, to: 7 });
    const unregisterActive = bus.register("layout-active", active);
    const unregisterBackground = bus.register("layout-background", background);

    expect(bus.retainRegisteredSelectionsForNextRegistration()).toBe(2);
    unregisterActive();
    unregisterBackground();
    const activeReplacement = new Editor({
      extensions: createPatentExtensions(),
      content: active.state.doc.toJSON(),
    });
    const backgroundReplacement = new Editor({
      extensions: createPatentExtensions(),
      content: background.state.doc.toJSON(),
    });
    bus.register("layout-active", activeReplacement);
    bus.register("layout-background", backgroundReplacement);

    expect(activeReplacement.state.selection).toMatchObject({ from: 2, to: 5, empty: false });
    expect(backgroundReplacement.state.selection).toMatchObject({ from: 3, to: 7, empty: false });
    active.destroy();
    background.destroy();
    activeReplacement.destroy();
    backgroundReplacement.destroy();
  });

  test("opens chemistry only for the requested editor when it supports chemistry", () => {
    const bus = new EditorCommandBus();
    const firstOpenChemistry = vi.fn();
    const secondOpenChemistry = vi.fn();
    const unsupportedCapabilities = {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: false,
      images: true,
      pageBreaks: true,
    };
    const supportedCapabilities = { ...unsupportedCapabilities, chemistry: true };

    bus.register(
      "inactive",
      editor(),
      undefined,
      undefined,
      firstOpenChemistry,
      unsupportedCapabilities,
    );
    bus.register(
      "active",
      editor(),
      undefined,
      undefined,
      secondOpenChemistry,
      supportedCapabilities,
    );

    expect(bus.openChemistryEditor("inactive")).toBe(false);
    expect(bus.openChemistryEditor("active", "structure")).toBe(true);
    expect(firstOpenChemistry).not.toHaveBeenCalled();
    expect(secondOpenChemistry).toHaveBeenCalledOnce();
    expect(secondOpenChemistry).toHaveBeenCalledWith("structure");
  });

  test("forwards the complete table insertion request", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p></p>",
    });
    bus.register("table-insert-session", registered);

    expect(
      bus.insertTable("table-insert-session", {
        rows: 2,
        columns: 3,
        headerRowCount: 1,
        layoutMode: "fit-page",
      }),
    ).toBe(true);

    const table = registered.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    expect(table?.attrs).toMatchObject({ headerRowCount: 1, layoutMode: "fit-page" });
    expect(table?.childCount).toBe(2);
    expect(table?.firstChild?.firstChild?.type.name).toBe("tableHeader");
    registered.destroy();
  });

  test("applies table dimensions only for a live table-capable editor", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td></tr></table>",
    });
    const cell = tableCellPositions(registered)[0];
    expect(cell).toBeDefined();
    if (cell === undefined) return;
    registered.commands.setTextSelection(cell + 2);
    bus.register("table-dimensions", registered);

    expect(bus.setTableRowHeight("table-dimensions", { heightMm: 18, rule: "exact" })).toBe(true);
    expect(bus.setTableColumnWidth("table-dimensions", 42)).toBe(true);
    expect(bus.setTableRowHeight("missing", { heightMm: 18, rule: "exact" })).toBe(false);
    registered.destroy();
    expect(bus.setTableColumnWidth("table-dimensions", 42)).toBe(false);
  });

  test("reports and subscribes to the registered editor table selection", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p></p>",
    });
    registered.commands.insertTable({ rows: 1, cols: 2, withHeaderRow: false });
    const [firstCell, secondCell] = tableCellPositions(registered);
    expect(firstCell).toBeDefined();
    expect(secondCell).toBeDefined();
    if (firstCell === undefined || secondCell === undefined) return;
    bus.register("table-session", registered);

    expect(bus.getTableSelection("table-session")).toMatchObject({
      kind: "text",
      selectedCellCount: 1,
    });
    const listener = vi.fn();
    const unsubscribe = bus.subscribeTableSelection("table-session", listener);
    registered.commands.setCellSelection({ anchorCell: firstCell, headCell: secondCell });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "table", selectedCellCount: 2 }),
    );
    unsubscribe();
    registered.destroy();
  });

  test("retains table-selection subscribers across an editor registration refresh", () => {
    const bus = new EditorCommandBus();
    const first = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    const replacement = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
    });
    const [firstCell, secondCell] = tableCellPositions(replacement);
    expect(firstCell).toBeDefined();
    expect(secondCell).toBeDefined();
    if (firstCell === undefined || secondCell === undefined) return;

    const unregisterFirst = bus.register("table-refresh", first);
    const listener = vi.fn();
    bus.subscribeTableSelection("table-refresh", listener);
    unregisterFirst();
    const unregisterReplacement = bus.register("table-refresh", replacement);

    replacement.commands.setCellSelection({ anchorCell: firstCell, headCell: secondCell });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "table", selectedCellCount: 2 }),
    );
    unregisterReplacement();
    first.destroy();
    replacement.destroy();
  });

  test("focuses a registered editor without changing the selection", () => {
    const bus = new EditorCommandBus();
    const registered = editor();

    bus.register("session-1", registered);

    expect(bus.focus("session-1")).toBe(true);
    expect(registered.commands.setTextSelection).not.toHaveBeenCalled();
    expect(registered.commands.focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
    expect(bus.has("session-1")).toBe(true);
  });

  test("collapses a text selection to its active end before restoring focus", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: { selection: { empty: false, head: 7 } } as Editor["state"],
    });
    bus.register("session-1", registered);

    expect(bus.focus("session-1", { collapseSelection: true })).toBe(true);
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith(7);
    expect(registered.commands.focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
  });

  test("does not rewrite an already collapsed caret while restoring focus", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: { selection: { empty: true, head: 7 } } as Editor["state"],
    });
    bus.register("session-1", registered);

    expect(bus.focus("session-1", { collapseSelection: true })).toBe(true);
    expect(registered.commands.setTextSelection).not.toHaveBeenCalled();
  });

  test("reports only non-empty text selections", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙丁</p>",
    });
    const unregister = bus.register("session-1", registered);

    registered.commands.setTextSelection({ from: 1, to: 4 });
    expect(bus.hasNonEmptyTextSelection("session-1")).toBe(true);

    registered.commands.selectAll();
    expect(bus.hasNonEmptyTextSelection("session-1")).toBe(true);

    registered.commands.setTextSelection(2);
    expect(bus.hasNonEmptyTextSelection("session-1")).toBe(false);

    registered.commands.setNodeSelection(0);
    expect(bus.hasNonEmptyTextSelection("session-1")).toBe(false);
    expect(bus.hasNonEmptyTextSelection("missing")).toBe(false);

    unregister();
    registered.destroy();
    expect(bus.hasNonEmptyTextSelection("session-1")).toBe(false);
  });

  test("maps page margin coordinates into the editor before setting a text selection", () => {
    const bus = new EditorCommandBus();
    const posAtCoords = vi
      .fn()
      .mockReturnValueOnce({ pos: 3, inside: 1 })
      .mockReturnValueOnce({ pos: 9, inside: 1 });
    const registered = editor({
      view: {
        dom: {
          getBoundingClientRect: () => ({ left: 100, right: 500, top: 200, bottom: 800 }),
        },
        posAtCoords,
        focus: vi.fn(),
      } as unknown as Editor["view"],
    });
    bus.register("session-1", registered);

    expect(
      bus.setSelectionFromCoordinates("session-1", { x: 20, y: 300 }, { x: 600, y: 500 }),
    ).toBe(true);
    expect(posAtCoords).toHaveBeenNthCalledWith(1, { left: 101, top: 300 });
    expect(posAtCoords).toHaveBeenNthCalledWith(2, { left: 499, top: 500 });
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith({ from: 3, to: 9 });
    expect(registered.view.focus).toHaveBeenCalled();
    expect(registered.commands.focus).not.toHaveBeenCalled();
  });

  test("selects complete visual lines between two selection-gutter coordinates", () => {
    const bus = new EditorCommandBus();
    const posAtCoords = vi
      .fn()
      .mockReturnValueOnce({ pos: 3, inside: 1 })
      .mockReturnValueOnce({ pos: 11, inside: 1 });
    const registered = editor({
      view: {
        dom: {
          getBoundingClientRect: () => ({ left: 100, right: 500, top: 200, bottom: 800 }),
        },
        posAtCoords,
      } as unknown as Editor["view"],
    });
    bus.register("session-1", registered);

    expect(bus.selectVisualLinesFromCoordinates("session-1", 520, 300)).toBe(true);
    expect(posAtCoords).toHaveBeenNthCalledWith(1, { left: 101, top: 300 });
    expect(posAtCoords).toHaveBeenNthCalledWith(2, { left: 499, top: 520 });
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith({ from: 3, to: 11 });
  });

  test("selects the complete text block at a page coordinate", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙</p><p>丙丁</p>",
    });
    vi.spyOn(registered.view, "posAtCoords").mockReturnValue({ pos: 6, inside: 4 });
    bus.register("session-1", registered);

    expect(bus.selectParagraphFromCoordinates("session-1", { x: 20, y: 300 })).toBe(true);
    expect(
      registered.state.doc.textBetween(
        registered.state.selection.from,
        registered.state.selection.to,
      ),
    ).toBe("丙丁");
    registered.destroy();
  });

  test("selects the complete document", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙</p><p>丙丁</p>",
    });
    bus.register("session-1", registered);

    expect(bus.selectAll("session-1")).toBe(true);
    expect(
      registered.state.doc.textBetween(
        registered.state.selection.from,
        registered.state.selection.to,
        "\n",
      ),
    ).toBe("甲乙\n丙丁");
    registered.destroy();
  });

  test("selects the Chinese sentence containing a document position", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>第一句。第二句！第三句</p>",
    });
    bus.register("session-1", registered);

    expect(bus.selectSentenceAtPosition("session-1", 7)).toBe(true);
    expect(
      registered.state.doc.textBetween(
        registered.state.selection.from,
        registered.state.selection.to,
      ),
    ).toBe("第二句！");
    registered.destroy();
  });

  test("does not split a sentence at a decimal point", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>浓度为0.5 mg/mL。下一句。</p>",
    });
    bus.register("session-1", registered);

    expect(bus.selectSentenceAtPosition("session-1", 7)).toBe(true);
    expect(
      registered.state.doc.textBetween(
        registered.state.selection.from,
        registered.state.selection.to,
      ),
    ).toBe("浓度为0.5 mg/mL。");
    registered.destroy();
  });

  test("does not focus unknown or destroyed editors", () => {
    const bus = new EditorCommandBus();
    const destroyed = editor({ isDestroyed: true });
    bus.register("session-2", destroyed);

    expect(bus.focus("missing")).toBe(false);
    expect(bus.focus("session-2")).toBe(false);
    expect(bus.has("missing")).toBe(false);
    expect(bus.has("session-2")).toBe(false);
    expect(destroyed.commands.focus).not.toHaveBeenCalled();
  });

  test("captures and restores the editor text selection without scrolling", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: {
        selection: { empty: false, head: 5, from: 2, to: 5 },
        doc: { content: { size: 10 } },
      } as Editor["state"],
    });
    bus.register("selection-session", registered);

    const bookmark = bus.captureSelection("selection-session");

    expect(bookmark).toEqual({ from: 2, to: 5 });
    expect(bus.restoreSelection("selection-session", bookmark)).toBe(true);
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith({ from: 2, to: 5 });
    expect(registered.commands.focus).toHaveBeenCalledWith(undefined, {
      scrollIntoView: false,
    });
  });

  test("clamps a stale selection bookmark to the current document", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: {
        selection: { empty: true, head: 1, from: 1, to: 1 },
        doc: { content: { size: 5 } },
      } as Editor["state"],
    });
    bus.register("stale-selection", registered);

    expect(bus.restoreSelection("stale-selection", { from: 9, to: 2 })).toBe(true);
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith({ from: 5, to: 5 });
  });

  test("does not capture or restore a selection for unavailable editors or a null bookmark", () => {
    const bus = new EditorCommandBus();
    const destroyed = editor({ isDestroyed: true });
    bus.register("destroyed-selection", destroyed);

    expect(bus.captureSelection("missing")).toBeNull();
    expect(bus.captureSelection("destroyed-selection")).toBeNull();
    expect(bus.restoreSelection("missing", { from: 2, to: 5 })).toBe(false);
    expect(bus.restoreSelection("destroyed-selection", { from: 2, to: 5 })).toBe(false);
    expect(bus.restoreSelection("destroyed-selection", null)).toBe(false);
    expect(destroyed.commands.setTextSelection).not.toHaveBeenCalled();
    expect(destroyed.commands.focus).not.toHaveBeenCalled();
  });

  test("does not focus when restoring the text selection fails", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: {
        selection: { empty: true, head: 1, from: 1, to: 1 },
        doc: { content: { size: 5 } },
      } as Editor["state"],
      commands: {
        setTextSelection: vi.fn(() => false),
        focus: vi.fn(() => true),
      } as unknown as Editor["commands"],
    });
    bus.register("failed-selection", registered);

    expect(bus.restoreSelection("failed-selection", { from: -3, to: 20 })).toBe(false);
    expect(registered.commands.setTextSelection).toHaveBeenCalledWith({ from: 1, to: 5 });
    expect(registered.commands.focus).not.toHaveBeenCalled();
  });

  test("reads the active formatting state and text style attributes", () => {
    const bus = new EditorCommandBus();
    const isActive = vi.fn(
      (name?: string | Record<string, unknown>, attributes?: Record<string, unknown>) => {
        if (name === "bold" || name === "underline" || name === "bulletList") return true;
        if (name === "heading") return attributes?.level === 2;
        if (typeof name === "object") return name?.textAlign === "center";
        if (name === "textStyle") return attributes?.fontFamily === "SimSun";
        return false;
      },
    );
    const getAttributes = vi.fn((name: string) =>
      name === "textStyle" ? { fontFamily: "SimSun", fontSizePt: 14, color: "#112233" } : {},
    );
    bus.register("session-3", editor({ isActive, getAttributes }));

    expect(bus.getFormatState("session-3")).toEqual<EditorFormatState>({
      bold: true,
      italic: false,
      underline: true,
      subscript: false,
      superscript: false,
      alignment: "center",
      bulletList: true,
      orderedList: false,
      paragraphStyle: 2,
      fontFamily: "SimSun",
      fontSizePt: 14,
      color: "#112233",
    });
  });

  test("reads alignment from a real editor, including block math", () => {
    const bus = new EditorCommandBus();
    const real = new Editor({ extensions: createPatentExtensions(), content: "<p>正文</p>" });
    bus.register("real", real);

    expect(bus.getFormatState("real").alignment).toBe("left");

    real.commands.setTextAlign("center");
    expect(bus.getFormatState("real").alignment).toBe("center");

    real.commands.setTextAlign("right");
    expect(bus.getFormatState("real").alignment).toBe("right");

    real.commands.setTextAlign("justify");
    expect(bus.getFormatState("real").alignment).toBe("justify");
    real.destroy();

    const mathEditor = new Editor({ extensions: createPatentExtensions() });
    bus.register("math", mathEditor);
    mathEditor.commands.insertContent({ type: "blockMath", attrs: { latex: "x^2" } });
    mathEditor.commands.setNodeSelection(0);
    expect(bus.getFormatState("math").alignment).toBe("center");
    mathEditor.destroy();
  });

  test("collapses the selection after applying or clearing a highlight", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙丁</p>",
    });
    bus.register("highlight-session", registered);
    registered.commands.setTextSelection({ from: 1, to: 3 });

    expect(bus.setHighlightColor("highlight-session", "#FFFF00")).toBe(true);
    expect(registered.getHTML()).toContain("background-color: rgb(255, 255, 0)");
    expect(registered.state.selection.empty).toBe(true);
    expect(registered.state.selection.from).toBe(3);

    registered.commands.setTextSelection({ from: 1, to: 3 });
    expect(bus.setHighlightColor("highlight-session", null)).toBe(true);
    expect(registered.state.selection.empty).toBe(true);
    expect(registered.state.selection.from).toBe(3);
    registered.destroy();
  });

  test("continuous colors preserve the original selection without stealing control focus", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙丁</p>",
    });
    bus.register("continuous-color", registered);
    registered.commands.setTextSelection({ from: 1, to: 3 });
    const focus = vi.spyOn(registered.view, "focus");
    for (const color of ["#FF0000", "#00FF00", "#0000FF"]) {
      expect(bus.setColor("continuous-color", color, true, false)).toBe(true);
      expect(bus.setHighlightColor("continuous-color", color, true, false)).toBe(true);
      expect(registered.state.selection.from).toBe(1);
      expect(registered.state.selection.to).toBe(3);
    }
    expect(focus).not.toHaveBeenCalled();
    expect(registered.getHTML()).toContain("rgb(0, 0, 255)");
    registered.destroy();
  });

  test("rejects malformed highlight colors before touching the selection", () => {
    const bus = new EditorCommandBus();
    const registered = editor({
      state: { selection: { empty: false, head: 7 } } as Editor["state"],
    });
    bus.register("highlight-reject", registered);

    expect(bus.setHighlightColor("highlight-reject", "red")).toBe(false);
    expect(bus.setHighlightColor("missing", "#FFFF00")).toBe(false);
  });

  test("preserves the selected text range after applying a text color", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙丁</p>",
    });
    bus.register("color-session", registered);
    registered.commands.setTextSelection({ from: 1, to: 3 });

    expect(bus.setColor("color-session", "#FF0000")).toBe(true);
    expect(registered.getHTML()).toContain("color: rgb(255, 0, 0)");
    expect(registered.state.selection.empty).toBe(false);
    expect(registered.state.selection.from).toBe(1);
    expect(registered.state.selection.to).toBe(3);

    expect(bus.setColor("color-session", "red")).toBe(false);
    expect(bus.setColor("missing", "#FF0000")).toBe(false);
    registered.destroy();
  });

  test("reports a pending superscript mode at the caret without activating other inline buttons", () => {
    const bus = new EditorCommandBus();
    bus.register(
      "collapsed-selection",
      editor({
        state: { selection: { empty: true } } as Editor["state"],
        isActive: vi.fn((name: string) => name === "superscript"),
        getAttributes: vi.fn(() => ({})),
      }),
    );

    expect(bus.getFormatState("collapsed-selection")).toMatchObject({
      bold: false,
      italic: false,
      underline: false,
      subscript: false,
      superscript: true,
    });
  });

  test("returns defaults for missing or destroyed editors", () => {
    const bus = new EditorCommandBus();
    bus.register("destroyed", editor({ isDestroyed: true }));

    const expected: EditorFormatState = {
      bold: false,
      italic: false,
      underline: false,
      subscript: false,
      superscript: false,
      alignment: "left",
      bulletList: false,
      orderedList: false,
      paragraphStyle: "paragraph",
    };
    expect(bus.getFormatState("missing")).toEqual(expected);
    expect(bus.getFormatState("destroyed")).toEqual(expected);
  });

  test("binds a pending format-state subscription when its editor registers", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    let activeFormats = new Set(["bold:", "attrs:center"]);
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const registered = editor({
      on: on as unknown as Editor["on"],
      off: vi.fn((event: string, callback: () => void) =>
        listeners.get(event)?.delete(callback),
      ) as unknown as Editor["off"],
      isActive: vi.fn(
        (name?: string | Record<string, unknown>, attributes?: Record<string, unknown>) => {
          const key =
            typeof name === "object"
              ? `attrs:${String(name?.textAlign ?? "")}`
              : `${name}:${String(attributes?.textAlign ?? "")}`;
          return activeFormats.has(key);
        },
      ),
      getAttributes: vi.fn(() => ({})),
    });
    const listener = vi.fn();

    bus.subscribeFormatState("new", listener);
    bus.register("new", registered);
    activeFormats = new Set(["underline:"]);
    for (const callback of listeners.get("selectionUpdate") ?? []) callback();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bold: true, alignment: "center" }),
    );
    expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ underline: true }));
    expect(on).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
  });

  test("does not republish an unchanged format state when an editor re-registers", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const registered = editor({
      on: on as unknown as Editor["on"],
      off: vi.fn((event: string, callback: () => void) =>
        listeners.get(event)?.delete(callback),
      ) as unknown as Editor["off"],
      isActive: vi.fn((name: string) => name === "bold"),
      getAttributes: vi.fn(() => ({})),
    });
    const listener = vi.fn();

    bus.subscribeFormatState("registration-refresh", listener);
    bus.register("registration-refresh", registered);
    bus.register("registration-refresh", registered);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ bold: true }));
  });

  test("notifies format-state subscribers for selection and transaction changes", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    let activeFormats = new Set<string>();
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const off = vi.fn((event: string, callback: () => void) =>
      listeners.get(event)?.delete(callback),
    );
    const registered = editor({
      on: on as unknown as Editor["on"],
      off: off as unknown as Editor["off"],
      isActive: vi.fn(
        (name?: string | Record<string, unknown>, attributes?: Record<string, unknown>) => {
          const key =
            typeof name === "object"
              ? `attrs:${String(name?.textAlign ?? "")}`
              : `${name}:${String(attributes?.textAlign ?? "")}`;
          return activeFormats.has(key);
        },
      ),
      getAttributes: vi.fn(() => ({})),
    });
    const listener = vi.fn();
    bus.register("session-4", registered);

    const unsubscribe = bus.subscribeFormatState("session-4", listener);
    activeFormats = new Set(["bold:", "bulletList:"]);
    for (const callback of listeners.get("selectionUpdate") ?? []) callback();
    activeFormats = new Set(["superscript:", "attrs:center"]);
    for (const callback of listeners.get("transaction") ?? []) callback();
    unsubscribe();
    for (const callback of listeners.get("selectionUpdate") ?? []) callback();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bold: true, bulletList: true }),
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ superscript: true, alignment: "center" }),
    );
    expect(on).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(on).toHaveBeenCalledWith("transaction", expect.any(Function));
    expect(off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(off).toHaveBeenCalledWith("transaction", expect.any(Function));
  });

  test("cleans format-state subscriptions when its editor registration is released", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const off = vi.fn((event: string, callback: () => void) =>
      listeners.get(event)?.delete(callback),
    );
    const registered = editor({
      on: on as unknown as Editor["on"],
      off: off as unknown as Editor["off"],
      isActive: vi.fn(() => false),
      getAttributes: vi.fn(() => ({})),
    });
    const listener = vi.fn();
    const unregister = bus.register("session-5", registered);
    bus.subscribeFormatState("session-5", listener);

    unregister();
    for (const event of ["selectionUpdate", "transaction"]) {
      for (const callback of listeners.get(event) ?? []) callback();
    }

    expect(off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(off).toHaveBeenCalledWith("transaction", expect.any(Function));
    expect(listener).not.toHaveBeenCalled();
  });

  test("retains newer format subscriptions when a stale unsubscribe runs", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const off = vi.fn((event: string, callback: () => void) =>
      listeners.get(event)?.delete(callback),
    );
    const initial = editor({
      on: on as unknown as Editor["on"],
      off: off as unknown as Editor["off"],
      isActive: vi.fn(() => false),
      getAttributes: vi.fn(() => ({})),
    });
    const replacement = editor({
      on: on as unknown as Editor["on"],
      off: off as unknown as Editor["off"],
      isActive: vi.fn((name: string) => name === "bold"),
      getAttributes: vi.fn(() => ({})),
    });
    const staleUnsubscribe = bus.subscribeFormatState("session-5a", vi.fn());
    const unregisterInitial = bus.register("session-5a", initial);

    unregisterInitial();
    const listener = vi.fn();
    bus.subscribeFormatState("session-5a", listener);
    staleUnsubscribe();
    const unregisterReplacement = bus.register("session-5a", replacement);
    for (const callback of listeners.get("selectionUpdate") ?? []) callback();
    unregisterReplacement();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ bold: true }));
    expect(off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(off).toHaveBeenCalledWith("transaction", expect.any(Function));
  });

  test("does not remove replacement editor subscriptions when stale registration cleanup runs", () => {
    const bus = new EditorCommandBus();
    const oldListeners = new Map<string, Set<() => void>>();
    const replacementListeners = new Map<string, Set<() => void>>();
    const createEventfulEditor = (listeners: Map<string, Set<() => void>>) => {
      const on = vi.fn((event: string, callback: () => void) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(callback);
        listeners.set(event, eventListeners);
      });
      const off = vi.fn((event: string, callback: () => void) =>
        listeners.get(event)?.delete(callback),
      );
      return {
        editor: editor({
          on: on as unknown as Editor["on"],
          off: off as unknown as Editor["off"],
          isActive: vi.fn(() => false),
          getAttributes: vi.fn(() => ({})),
        }),
        off,
      };
    };
    const old = createEventfulEditor(oldListeners);
    const replacement = createEventfulEditor(replacementListeners);
    const oldListener = vi.fn();
    const replacementListener = vi.fn();
    const unregisterOld = bus.register("session-6", old.editor);
    bus.subscribeFormatState("session-6", oldListener);
    bus.register("session-6", replacement.editor);
    bus.subscribeFormatState("session-6", replacementListener);

    unregisterOld();
    for (const callback of replacementListeners.get("selectionUpdate") ?? []) callback();

    expect(old.off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(old.off).toHaveBeenCalledWith("transaction", expect.any(Function));
    expect(replacement.off).not.toHaveBeenCalled();
    expect(bus.has("session-6")).toBe(true);
    expect(oldListener).toHaveBeenCalledOnce();
    expect(replacementListener).toHaveBeenCalledOnce();
  });

  test("keeps a same-editor replacement registered after stale cleanup", () => {
    const bus = new EditorCommandBus();
    const listeners = new Map<string, Set<() => void>>();
    const on = vi.fn((event: string, callback: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback);
      listeners.set(event, eventListeners);
    });
    const off = vi.fn((event: string, callback: () => void) =>
      listeners.get(event)?.delete(callback),
    );
    const registered = editor({
      on: on as unknown as Editor["on"],
      off: off as unknown as Editor["off"],
      isActive: vi.fn((name: string) => name === "bold"),
      getAttributes: vi.fn(() => ({})),
    });
    const firstUnregister = bus.register("session-6a", registered);
    const listener = vi.fn();
    bus.subscribeFormatState("session-6a", listener);
    bus.register("session-6a", registered);

    firstUnregister();
    for (const callback of listeners.get("selectionUpdate") ?? []) callback();

    expect(bus.has("session-6a")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ bold: true }));
  });

  test("moves existing format subscriptions to a replacement editor", () => {
    const bus = new EditorCommandBus();
    const createEventfulEditor = (isActive: (name: string) => boolean) => {
      const listeners = new Map<string, Set<() => void>>();
      const on = vi.fn((event: string, callback: () => void) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(callback);
        listeners.set(event, eventListeners);
      });
      const off = vi.fn((event: string, callback: () => void) =>
        listeners.get(event)?.delete(callback),
      );
      return {
        editor: editor({
          on: on as unknown as Editor["on"],
          off: off as unknown as Editor["off"],
          isActive: vi.fn(isActive),
          getAttributes: vi.fn(() => ({})),
        }),
        listeners,
        off,
      };
    };
    const old = createEventfulEditor(() => false);
    const replacement = createEventfulEditor((name) => name === "bold");
    const listener = vi.fn();
    bus.register("session-7", old.editor);
    bus.subscribeFormatState("session-7", listener);

    bus.register("session-7", replacement.editor);
    for (const callback of old.listeners.get("selectionUpdate") ?? []) callback();
    for (const callback of replacement.listeners.get("selectionUpdate") ?? []) callback();

    expect(old.off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
    expect(old.off).toHaveBeenCalledWith("transaction", expect.any(Function));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ bold: true }));
  });
});

describe("plain text selection", () => {
  test("reads plain text split across different marks", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p><strong>箱</strong><u>体</u></p>",
    });
    bus.register("plain-marks", registered);
    registered.commands.setTextSelection({ from: 1, to: 3 });

    expect(bus.getPlainTextSelection("plain-marks")).toEqual({ ok: true, text: "箱体" });
    registered.destroy();
  });

  test("accepts a triple-click whole-paragraph selection", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲乙丙</p>",
    });
    bus.register("whole-paragraph", registered);
    // 三击整段 / 单段 Ctrl+A 产生覆盖整个段落节点边界的 TextSelection，
    // 不能因为 openStart/openEnd 为 0 而误判为 INVALID_SELECTION。
    registered.commands.selectAll();

    expect(bus.getPlainTextSelection("whole-paragraph")).toEqual({ ok: true, text: "甲乙丙" });
    registered.destroy();
  });

  test("rejects a selection crossing an inline formula", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({ extensions: createPatentExtensions(), content: "<p>甲</p>" });
    bus.register("formula", registered);
    registered.commands.insertContent({
      type: "inlineMath",
      attrs: { latex: "x^2", formulaKind: "math" },
    });
    registered.commands.insertContent("乙");
    registered.commands.setTextSelection({ from: 1, to: 4 });

    const result = bus.getPlainTextSelection("formula");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("fixture");
    expect(result.code).toBe("INVALID_SELECTION");
    expect(result.message).toContain("公式");
    registered.destroy();
  });

  test("rejects a selection crossing a hard break", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>甲<br>乙</p>",
    });
    bus.register("break", registered);
    registered.commands.setTextSelection({ from: 1, to: 4 });

    const result = bus.getPlainTextSelection("break");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("fixture");
    expect(result.code).toBe("INVALID_SELECTION");
    expect(result.message).toContain("硬换行");
    registered.destroy();
  });

  test("rejects an empty selection", () => {
    const bus = new EditorCommandBus();
    const registered = new Editor({ extensions: createPatentExtensions(), content: "<p>甲乙</p>" });
    bus.register("empty", registered);
    registered.commands.setTextSelection(1);

    expect(bus.getPlainTextSelection("empty")).toEqual({
      ok: false,
      code: "EMPTY_SELECTION",
      message: expect.any(String),
    });
    registered.destroy();
  });
});
