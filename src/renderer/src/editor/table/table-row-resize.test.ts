import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";

test.each([0, 1, 2])(
  "dragging column %s resizes the row without changing cell content",
  (column) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        "<table><tr><td>甲</td><td>乙</td><td>丙</td></tr><tr><td>丁</td><td>戊</td><td>己</td></tr></table>",
    });
    try {
      const before = editor.state.doc.textContent;
      const handles = editor.view.dom.querySelectorAll<HTMLElement>("[data-table-row-resize='0']");
      expect(handles).toHaveLength(3);
      const handle = handles[column];
      if (!handle) throw new Error("Missing column drag target");
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 140 }));
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(editor.state.doc.firstChild?.child(0).attrs.rowHeightRule).toBe("at-least");
      expect(editor.state.doc.firstChild?.child(1).attrs.rowHeightMm).toBeNull();
      expect(editor.state.doc.textContent).toBe(before);
    } finally {
      editor.destroy();
    }
  },
);

test("a horizontally merged cell has one continuous row drag target", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr><td colspan="2">甲乙</td><td>丙</td></tr><tr><td>丁</td><td>戊</td><td>己</td></tr></table>',
  });
  try {
    expect(editor.view.dom.querySelectorAll("[data-table-row-resize='0']")).toHaveLength(2);
    expect(
      editor.view.dom.querySelectorAll("td[colspan='2'] [data-table-row-resize]"),
    ).toHaveLength(1);
  } finally {
    editor.destroy();
  }
});

test.each(["click", "readonly", "became-readonly"])(
  "row handles do not modify the document on %s",
  (mode) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      editable: mode !== "readonly",
      content: "<table><tr><td>甲</td></tr></table>",
    });
    try {
      editor.commands.setContent(editor.getJSON());
      const before = editor.getJSON();
      const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
      if (!handle) throw new Error("Missing row handle");
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100 }));
      if (mode !== "click") document.dispatchEvent(new MouseEvent("mousemove", { clientY: 140 }));
      if (mode === "became-readonly") editor.setEditable(false);
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  },
);

test("dragging a minimum-height row starts from its displayed height, not its minimum", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="5" data-row-height-rule="at-least"><td>多行内容</td></tr></table>',
  });
  try {
    const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
    const row = handle?.closest("tr");
    if (!handle || !row) throw new Error("Missing row");
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: 76 });
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 114 } as DOMRect);
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 157 }));
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBeCloseTo(30.1, 0);
  } finally {
    editor.destroy();
  }
});

test("dragging another table's first row does not resize the previously selected table", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr></table><p>中间</p><table><tr><td>乙</td></tr></table>",
  });
  try {
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    const handle = editor.view.dom.querySelectorAll<HTMLElement>("[data-table-row-resize='0']")[1];
    if (!handle) throw new Error("Missing second table handle");
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 138 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(editor.state.doc.child(0).firstChild?.attrs.rowHeightMm).toBeNull();
    expect(editor.state.doc.child(2).firstChild?.attrs.rowHeightMm).toBeGreaterThan(3);
  } finally {
    editor.destroy();
  }
});

test.each(["Escape", "blur", "selection", "document", "destroy", "right-click"])(
  "row drag is cancelled on %s",
  (cancel) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<table><tr><td>甲</td></tr><tr><td>乙</td></tr></table>",
    });
    const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
    if (!handle) throw new Error("Missing handle");
    handle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientY: 100,
        button: cancel === "right-click" ? 2 : 0,
      }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 140 }));
    if (cancel === "Escape")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    if (cancel === "blur") window.dispatchEvent(new Event("blur"));
    if (cancel === "selection") editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    if (cancel === "document") editor.commands.insertContent("更改");
    if (cancel === "destroy") editor.destroy();
    const before = editor.getJSON();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(editor.getJSON()).toEqual(before);
    expect(handle.dataset.tableRowResizeValue).toBeUndefined();
    if (!editor.isDestroyed) editor.destroy();
  },
);

test("a row handle inside a vertically merged cell resizes its logical row only", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<table><tr><td>甲</td><td rowspan="2">合并</td></tr><tr><td>乙</td></tr></table>',
  });
  try {
    const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='1']");
    if (!handle) throw new Error("Missing row handle");
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 138 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const table = editor.state.doc.firstChild;
    expect(table?.child(0).attrs.rowHeightMm).toBeNull();
    expect(table?.child(1).attrs.rowHeightMm).toBeGreaterThan(3);
  } finally {
    editor.destroy();
  }
});

test("merged-cell row handles expose only actual bottom boundaries at zoom", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<table><tr><td>甲</td><td rowspan="2">合并</td></tr><tr><td>乙</td></tr></table>',
  });
  try {
    const cell = editor.view.dom.querySelector<HTMLTableCellElement>("td[rowspan='2']");
    const rows = editor.view.dom.querySelectorAll("tr");
    if (!cell || !rows[0] || !rows[1]) throw new Error("Missing merged table");
    Object.defineProperty(cell, "offsetHeight", { configurable: true, value: 100 });
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
      height: 150,
      bottom: 150,
    } as DOMRect);
    vi.spyOn(rows[0], "getBoundingClientRect").mockReturnValue({ bottom: 60 } as DOMRect);
    vi.spyOn(rows[1], "getBoundingClientRect").mockReturnValue({ bottom: 150 } as DOMRect);
    editor.commands.setTextSelection(firstCellPosition(editor) + 2);
    expect(cell.querySelector("[data-table-row-resize='0']")).toBeNull();
    expect(cell.querySelector<HTMLElement>("[data-table-row-resize='1']")?.style.bottom).toBe("");
  } finally {
    editor.destroy();
  }
});

test("cancelling a resize restores the previously persisted row height", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="20" data-row-height-rule="exact"><td>甲</td></tr></table>',
  });
  try {
    const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
    const row = handle?.closest("tr");
    if (!handle || !row) throw new Error("Missing row handle");
    expect(row.style.getPropertyValue("--patent-row-height")).toBe("20mm");
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 140 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(row.style.getPropertyValue("--patent-row-height")).toBe("20mm");
    expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBe(20);
  } finally {
    editor.destroy();
  }
});

test.each([0.5, 1.5, 2])("converts row drag from screen coordinates at scale %s", (scale) => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr></table>",
  });
  const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
  const row = handle?.closest("tr");
  if (!handle || !row) throw new Error("Missing resize handle");
  Object.defineProperty(row, "offsetHeight", { configurable: true, value: 76 });
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 76 * scale } as DOMRect);
  handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
  );
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 100 + 38 * scale }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBeCloseTo(30.2, 1);
  editor.destroy();
});

function firstCellPosition(editor: Editor): number {
  let position: number | null = null;
  editor.state.doc.descendants((node, offset) => {
    if (position === null && node.type.name === "tableCell") position = offset;
  });
  if (position === null) throw new Error("测试表格单元格不存在");
  return position;
}

function resizeFirstRow(editor: Editor, options: { shiftKey?: boolean } = {}) {
  const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='0']");
  if (!handle) throw new Error("行高拖拽控件不存在");
  const row = handle.closest("tr");
  if (!row) throw new Error("行高拖拽控件未附着到表格行");
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 200,
    height: 75.6,
    top: 0,
    right: 200,
    bottom: 75.6,
    left: 0,
    toJSON: () => ({}),
  });
  handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100, ...options }),
  );
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 137.8 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 137.8 }));
}

test("commits one minimum row-height update after a row-edge drag and supports undo", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr></table>",
  });
  const cell = firstCellPosition(editor);
  editor.commands.setTextSelection(cell + 2);

  resizeFirstRow(editor);

  expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
    rowHeightMm: 30,
    rowHeightRule: "at-least",
  });
  editor.commands.undo();
  expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBeNull();
  editor.commands.redo();
  expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightRule).toBe("at-least");
  editor.destroy();
});

test("row-edge dragging keeps the text selection while resizing the targeted logical row", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr><tr><td>乙</td></tr></table>",
  });
  const cell = firstCellPosition(editor);
  editor.commands.setTextSelection(cell + 2);
  const selection = editor.state.selection;
  const handle = editor.view.dom.querySelector<HTMLElement>("[data-table-row-resize='1']");
  const row = handle?.closest("tr");
  if (!handle || !row) throw new Error("Missing second-row resize handle");
  Object.defineProperty(row, "offsetHeight", { configurable: true, value: 76 });
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 76 } as DOMRect);

  handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
  );
  expect(editor.state.selection.eq(selection)).toBe(true);
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 138 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 138 }));

  expect(editor.state.selection.eq(selection)).toBe(true);
  expect(editor.state.doc.firstChild?.child(0).attrs.rowHeightMm).toBeNull();
  expect(editor.state.doc.firstChild?.child(1).attrs.rowHeightMm).toBeCloseTo(30.2, 1);
  editor.destroy();
});

test("Shift does not change the minimum-height drag rule", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td></tr></table>",
  });
  const cell = firstCellPosition(editor);
  editor.commands.setTextSelection(cell + 2);

  resizeFirstRow(editor, { shiftKey: true });

  expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
    rowHeightMm: 30,
    rowHeightRule: "at-least",
  });
  editor.destroy();
});
