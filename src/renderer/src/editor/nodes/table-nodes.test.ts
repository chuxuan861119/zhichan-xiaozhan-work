import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";
import { TABLE_COMMAND_COLUMN_WIDTH_META } from "../table/table-column-width-sync";

function tablePosition(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && node.type.name === "table") found = position;
  });
  if (found < 0) throw new Error("测试表格不存在");
  return found;
}

test("undoing the first column resize clears stale fixed DOM widths", async () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const widths = () => [...editor.view.dom.querySelectorAll("col")].map((col) => col.style.width);
    const before = widths();
    let tr = editor.state.tr;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell")
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: [200] });
    });
    editor.view.dispatch(tr);
    expect(widths()).toEqual(["50%", "50%"]);
    expect(editor.commands.undo()).toBe(true);
    expect(widths()).toEqual(before);
  } finally {
    editor.destroy();
  }
});

test("同步表格尺寸元数据到可编辑表格 DOM 并在节点更新后刷新", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content:
      '<table data-layout-mode="fixed" data-column-widths-mm="42.069,42.069"><tr><td>甲</td><td>乙</td></tr></table>',
  });
  const table = element.querySelector("table");
  expect(table).not.toBeNull();
  expect(table?.getAttribute("data-layout-mode")).toBe("fixed");
  expect(table?.getAttribute("data-column-widths-mm")).toBe("42.069,42.069");

  const position = tablePosition(editor);
  const node = editor.state.doc.nodeAt(position);
  if (!node) throw new Error("测试表格节点不存在");
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(position, undefined, {
        ...node.attrs,
        layoutMode: "fit-page",
        columnWidthsMm: [30, 54],
      })
      .setMeta(TABLE_COMMAND_COLUMN_WIDTH_META, true),
  );

  const updatedTable = element.querySelector("table");
  expect(updatedTable?.getAttribute("data-layout-mode")).toBe("fit-page");
  expect(updatedTable?.getAttribute("data-column-widths-mm")).toBe("30,54");
  expect(updatedTable?.style.width).toBe("100%");
  editor.destroy();
  element.remove();
});

test("根据页面表格不会保留像素最小宽度", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { layoutMode: "fit-page", columnWidthsMm: [82.5, 82.5] },
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colwidth: [312] },
                  content: [{ type: "paragraph", content: [] }],
                },
                {
                  type: "tableCell",
                  attrs: { colwidth: [312] },
                  content: [{ type: "paragraph", content: [] }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const table = element.querySelector("table");
  const columns = [...element.querySelectorAll("col")];

  expect(table?.style.width).toBe("100%");
  expect(table?.style.minWidth).toBe("");
  expect(columns.map((column) => (column as HTMLElement).style.width)).toEqual(["50%", "50%"]);
  editor.destroy();
  element.remove();
});
