import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DecorationSet } from "@tiptap/pm/view";
import { createPatentExtensions } from "../extensions";
import { createPatentTableCellNodeView } from "./table-cell-node-view";

function firstCell(editor: Editor) {
  let found: ProseMirrorNode | null = null;
  editor.state.doc.descendants((node) => {
    if (found === null && node.type.name === "tableCell") found = node;
  });
  if (!found) throw new Error("测试表格单元格不存在");
  return found as ProseMirrorNode;
}

test("renders a real table cell with an editable inner content container", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>单元格</td></tr></table>",
  });
  const cell = firstCell(editor);
  const nodeView = createPatentTableCellNodeView(cell, "td");

  expect(nodeView.dom.tagName).toBe("TD");
  expect(nodeView.contentDOM?.className).toBe("patent-table-cell-content");
  expect(nodeView.dom.contains(nodeView.contentDOM ?? null)).toBe(true);

  const updated = cell.type.create(
    { ...cell.attrs, horizontalAlignment: "center", rowspan: 2 },
    cell.content,
    cell.marks,
  );
  expect(nodeView.update?.(updated, [], DecorationSet.empty)).toBe(true);
  expect(nodeView.dom.getAttribute("data-horizontal-alignment")).toBe("center");
  expect(nodeView.dom.getAttribute("rowspan")).toBe("2");
  nodeView.destroy?.();
  editor.destroy();
});

test("content or decoration updates do not rewrite unchanged cell attributes", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>原文</td></tr></table>",
  });
  const cell = firstCell(editor);
  const view = createPatentTableCellNodeView(cell, "td");
  const attributes = vi.spyOn(view.dom, "setAttribute");
  const styles = vi.spyOn(view.dom.style, "setProperty");
  try {
    const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text("新内容"));
    const updated = cell.type.create(cell.attrs, paragraph);
    expect(view.update?.(updated, [], DecorationSet.empty)).toBe(true);
    expect(attributes).not.toHaveBeenCalled();
    expect(styles).not.toHaveBeenCalled();
  } finally {
    attributes.mockRestore();
    styles.mockRestore();
    view.destroy?.();
    editor.destroy();
  }
});

test("renders each stored border edge in the editing surface", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>单元格</td></tr></table>",
  });
  const cell = firstCell(editor);
  const bordered = cell.type.create(
    {
      ...cell.attrs,
      borderTop: "none",
      borderRight: "double",
      borderBottom: "single",
      borderLeft: "none",
    },
    cell.content,
    cell.marks,
  );
  const nodeView = createPatentTableCellNodeView(bordered, "td");
  const element = nodeView.dom as HTMLTableCellElement;

  expect(element.style.borderTopStyle).toBe("none");
  expect(element.style.borderRightStyle).toBe("double");
  expect(element.style.borderBottomStyle).toBe("solid");
  expect(element.style.borderLeftStyle).toBe("none");
  nodeView.destroy?.();
  editor.destroy();
});
