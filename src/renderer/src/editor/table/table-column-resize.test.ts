import { Editor } from "@tiptap/core";
import { columnResizingPluginKey, TableMap } from "@tiptap/pm/tables";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";

test("dragging a table selection clears column hover feedback", () => {
  const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  try {
    const cell = editor.view.dom.querySelector<HTMLElement>("td");
    if (!cell) throw new Error("Missing table cell");
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 40,
      width: 100,
      height: 40,
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => cell,
    });
    editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: 2 }));
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(2);

    cell.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 99, clientY: 20 }),
    );

    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(-1);
    expect(editor.view.dom.classList.contains("resize-cursor")).toBe(false);
  } finally {
    if (originalElementFromPoint)
      Object.defineProperty(document, "elementFromPoint", originalElementFromPoint);
    else Reflect.deleteProperty(document, "elementFromPoint");
    editor.destroy();
  }
});

test.each([
  [0.5, 20, 180],
  [1, 20, 180],
  [2, 20, 180],
  [0.25, 10000, 360],
  [1, -10000, 40],
])(
  "column drag at zoom %s and delta %s preserves valid widths",
  async (scale, delta, expectedWidth) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content:
        '<table data-layout-mode="fit-page" data-column-widths-mm="20,30"><tr><td colwidth="76">甲</td><td colwidth="113">乙</td></tr></table>',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = editor.getJSON();
      const table = editor.view.dom.querySelector("table");
      if (!table) throw new Error("Missing table");
      Object.defineProperty(table, "offsetWidth", { configurable: true, value: 400 });
      vi.spyOn(table, "getBoundingClientRect").mockReturnValue({ width: 400 * scale } as DOMRect);
      let cell = -1;
      editor.state.doc.descendants((node, pos) => {
        if (cell < 0 && node.type.name === "tableCell") cell = pos;
      });
      editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: cell }));
      const down = new MouseEvent("mousedown", { clientX: 100, button: 0, cancelable: true });
      editor.view.someProp("handleDOMEvents", (handlers) =>
        handlers.mousedown?.(editor.view, down),
      );
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 100 + delta * scale }));
      const widths = editor.state.doc.firstChild?.attrs.columnWidthsMm;
      expect(widths[0]).toBeCloseTo((expectedWidth * 25.4) / 96, 2);
      expect(widths[1]).toBeCloseTo(((400 - expectedWidth) * 25.4) / 96, 2);
      expect(editor.state.doc.firstChild?.attrs.layoutMode).toBe("fixed");
      expect(
        tiptapToPatentBookDocument(editor.getJSON(), createBlankBookDocument("列宽"), new Set()).ok,
      ).toBe(true);
      const after = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(after);
    } finally {
      editor.destroy();
    }
  },
);

test("resizing a merged cell updates its logical column and survives save/reload", async () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table data-column-widths-mm="30,20,50"><tr><td colspan="2">合并</td><td>丙</td></tr><tr><td>甲</td><td>乙</td><td>丁</td></tr></table>',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const table = editor.view.dom.querySelector("table");
    if (!table) throw new Error("Missing table");
    Object.defineProperty(table, "offsetWidth", { configurable: true, value: 400 });
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue({ width: 400 } as DOMRect);
    editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: 2 }));
    const down = new MouseEvent("mousedown", { clientX: 100 });
    editor.view.someProp("handleDOMEvents", (handlers) => handlers.mousedown?.(editor.view, down));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 120 }));
    const node = editor.state.doc.firstChild;
    if (!node) throw new Error("Missing table node");
    expect(TableMap.get(node).problems).toBeNull();
    expect(node.child(0).child(0).attrs.colwidth).toEqual([120, 100]);
    expect(node.child(1).child(1).attrs.colwidth).toEqual([100]);
    const saved = tiptapToPatentBookDocument(
      editor.getJSON(),
      createBlankBookDocument("表格"),
      new Set(),
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    editor.commands.setContent(canonicalToTiptap(saved.value));
    const reloaded = tiptapToPatentBookDocument(editor.getJSON(), saved.value, new Set());
    if (!reloaded.ok) throw new Error(JSON.stringify(reloaded));
    expect(reloaded.value.content).toEqual(saved.value.content);
  } finally {
    editor.destroy();
  }
});

test.each([
  "click",
  "Escape",
  "blur",
  "readonly",
  "document",
  "outside-table",
  "selection",
  "destroy",
  "right-click",
])("column drag cancels safely on %s", async (reason) => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table><p>尾部</p>",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const table = editor.view.dom.querySelector("table");
    if (!table) throw new Error("Missing table");
    Object.defineProperty(table, "offsetWidth", { configurable: true, value: 400 });
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue({ width: 400 } as DOMRect);
    const originalStyle = table.style.cssText;
    editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: 2 }));
    const down = new MouseEvent("mousedown", {
      clientX: 100,
      button: reason === "right-click" ? 2 : 0,
    });
    editor.view.someProp("handleDOMEvents", (handlers) => handlers.mousedown?.(editor.view, down));
    if (reason !== "click")
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, buttons: 1 }));
    if (reason === "Escape")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    if (reason === "readonly") editor.setEditable(false);
    if (reason === "document") editor.commands.insertContent("改动");
    if (reason === "outside-table")
      editor.view.dispatch(editor.state.tr.insertText("改动", editor.state.doc.content.size - 2));
    if (reason === "selection") editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    if (reason === "destroy") editor.destroy();
    const before = editor.getJSON();
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: reason === "click" ? 100 : 130 }));
    expect(editor.getJSON()).toEqual(before);
    if (reason !== "document" && reason !== "destroy")
      expect(
        table.style.cssText
          .split(";")
          .map((rule) => rule.trim())
          .filter(Boolean)
          .sort(),
      ).toEqual(
        originalStyle
          .split(";")
          .map((rule) => rule.trim())
          .filter(Boolean)
          .sort(),
      );
  } finally {
    if (!editor.isDestroyed) editor.destroy();
  }
});
