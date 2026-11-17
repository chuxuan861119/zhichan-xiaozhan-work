import { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { afterEach, expect, test } from "vitest";
import { createPatentExtensions } from "../extensions";
import { insertPatentTable, runTableCommand } from "./table-commands";
import * as layoutWidth from "./table-layout-width";
import { normalizeTableTransaction } from "./table-width-policy";

const editors: Editor[] = [];
function editor(content = "<p>保留原文</p>") {
  const result = new Editor({ extensions: createPatentExtensions(), content });
  editors.push(result);
  return result;
}
afterEach(() => {
  for (const item of editors.splice(0)) item.destroy();
});
function tableHtml(columns: number) {
  return `<table data-layout-mode="fixed" data-column-widths-mm="${Array(columns).fill(30).join(",")}"><tr>${Array.from({ length: columns }, (_, i) => `<td><p>数据${i}</p></td>`).join("")}</tr></table>`;
}

test("ordinary text edits do not measure page width but changed table geometry does", () => {
  const e = editor(`${tableHtml(3)}<p>正文</p>`);
  const measure = vi.spyOn(layoutWidth, "editorContentWidthMm");
  try {
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.insertContent("继续输入");
    expect(measure).not.toHaveBeenCalled();
    e.commands.setTextSelection(4);
    e.commands.insertContent("表内文字");
    expect(measure).not.toHaveBeenCalled();
    runTableCommand(e, "add-column-after");
    expect(measure).toHaveBeenCalled();
  } finally {
    measure.mockRestore();
  }
});
test("creation refuses an impossible grid without replacing selected text", () => {
  const e = editor();
  e.commands.selectAll();
  const before = e.getJSON(),
    selection = e.state.selection.toJSON();
  expect(
    insertPatentTable(e, { rows: 2, columns: 30, headerRowCount: 0, layoutMode: "fit-page" }),
  ).toBe(false);
  expect(e.getJSON()).toEqual(before);
  expect(e.state.selection.toJSON()).toEqual(selection);
});
test("new tables use automatic heights and vertically centered compact cells", () => {
  const e = editor();
  expect(
    insertPatentTable(e, { rows: 2, columns: 3, headerRowCount: 0, layoutMode: "fit-page" }),
  ).toBe(true);
  e.state.doc.descendants((node) => {
    if (node.type.name === "tableCell") expect(node.attrs.verticalAlignment).toBe("middle");
    if (node.type.name === "tableRow") expect(node.attrs.rowHeightMm).toBeNull();
  });
});
test("inserting a column fits the table and undoes in one step", async () => {
  const e = editor(tableHtml(5));
  await new Promise((resolve) => setTimeout(resolve, 0));
  e.commands.setTextSelection(4);
  const before = e.getJSON();
  expect(runTableCommand(e, "add-column-after")).toBe(true);
  const table = e.state.doc.firstChild!;
  expect(TableMap.get(table).width).toBe(6);
  expect(table.attrs.columnWidthsMm.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(
    165.001,
  );
  expect(e.commands.undo()).toBe(true);
  expect(e.getJSON()).toEqual(before);
  expect(e.commands.redo()).toBe(true);
  expect(TableMap.get(e.state.doc.firstChild!).width).toBe(6);
});
test("a column that cannot fit is rejected with no partial insertion", () => {
  const e = editor(tableHtml(15));
  e.commands.setTextSelection(4);
  const before = e.getJSON();
  expect(runTableCommand(e, "add-column-after")).toBe(false);
  expect(e.getJSON()).toEqual(before);
});
test("old oversized tables remain editable without silently rewriting their widths", () => {
  const e = editor(tableHtml(20));
  e.commands.setTextSelection(4);
  const widths = e.state.doc.firstChild!.attrs.columnWidthsMm;
  e.commands.insertContent("新增文字");
  expect(e.state.doc.textContent).toContain("新增文字");
  expect(e.state.doc.firstChild!.attrs.columnWidthsMm).toEqual(widths);
});
test("whole mixed paste is preflighted before any normalization is applied", () => {
  const e = editor(),
    a = editor(tableHtml(6)),
    b = editor(tableHtml(30));
  const slice = new Slice(
    Fragment.fromArray([
      e.schema.nodeFromJSON(a.state.doc.firstChild!.toJSON()),
      e.schema.nodes.paragraph!.create(null, e.schema.text("中间段落")),
      e.schema.nodeFromJSON(b.state.doc.firstChild!.toJSON()),
    ]),
    0,
    0,
  );
  const tr = e.state.tr.replaceSelection(slice);
  const proposed = tr.doc.toJSON();
  expect(normalizeTableTransaction(tr, 165, { paste: true })).toBe(false);
  expect(tr.doc.toJSON()).toEqual(proposed);
  expect(e.state.doc.textContent).toBe("保留原文");
});
test("feasible pasted widths shrink without changing contents or font size", () => {
  const e = editor(),
    source = editor(tableHtml(8));
  const tr = e.state.tr.replaceSelection(
    new Slice(Fragment.from(e.schema.nodeFromJSON(source.state.doc.firstChild!.toJSON())), 0, 0),
  );
  expect(normalizeTableTransaction(tr, 165, { paste: true })).toBe(true);
  const table = tr.doc.content.content.find((n) => n.type.name === "table")!;
  expect(table.attrs.columnWidthsMm.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(165, 2);
  expect(table.textContent).toBe(source.state.doc.textContent);
});
