import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

for (const alignment of ["left", "center", "right"])
  test(`optional annotations edit inline and follow the ${alignment} table without overflow`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      await page.evaluate(async (alignment) => {
        const { setTableAnnotation, runTableCommand } = await import(
          "/src/editor/table/table-commands.ts"
        );
        const editor = window.resizeTestEditor;
        editor.view.dom.style.width = "640px";
        editor.commands.setContent(
          '<table data-layout-mode="fixed" data-column-widths-mm="30,30"><tr><td>甲</td><td>乙</td></tr></table><p></p>',
        );
        editor.commands.setTextSelection(4);
        runTableCommand(editor, `align-table-${alignment}`);
        setTableAnnotation(editor, {
          tableNameEnabled: true,
          tableName: "测试结果",
          tableNoteEnabled: true,
          tableNote: "测试条件",
        });
      }, alignment);
      const title = page.locator(".table-annotation--name .table-annotation__text");
      await title.click();
      await page.getByRole("textbox", { name: "编辑表名" }).fill("改后的名称");
      await page.getByRole("textbox", { name: "编辑表名" }).press("Tab");
      assert.equal(await title.textContent(), "表1 改后的名称");
      await page.locator(".table-annotation--note .table-annotation__text").click();
      await page.getByRole("textbox", { name: "编辑补充说明" }).fill("第一行\n第二行");
      await page.getByRole("textbox", { name: "编辑补充说明" }).press("Tab");
      const result = await page.evaluate(async () => {
        const { setTableAnnotation } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        const wrapper = editor.view.dom.querySelector(".tableWrapper");
        const table = wrapper.querySelector("table").getBoundingClientRect();
        const title = wrapper.querySelector(".table-annotation--name").getBoundingClientRect();
        const note = wrapper.querySelector(".table-annotation--note").getBoundingClientRect();
        setTableAnnotation(editor, { tableNameEnabled: false, tableNoteEnabled: false });
        const hidden = [...wrapper.querySelectorAll(".table-annotation")].every(
          (el) => el.getBoundingClientRect().height === 0,
        );
        setTableAnnotation(editor, { tableNameEnabled: true, tableNoteEnabled: true });
        return {
          table: { x: table.x, width: table.width },
          title: { x: title.x, width: title.width },
          note: { x: note.x, width: note.width },
          hidden,
          name: editor.state.doc.firstChild.attrs.tableName,
          noteText: editor.state.doc.firstChild.attrs.tableNote,
          overflow: wrapper.scrollWidth > wrapper.clientWidth,
        };
      });
      assert.ok(
        Math.abs(result.table.x - result.title.x) < 1 &&
          Math.abs(result.table.width - result.title.width) < 1,
        JSON.stringify(result),
      );
      assert.ok(Math.abs(result.table.x - result.note.x) < 1, JSON.stringify(result));
      assert.ok(result.hidden && !result.overflow, JSON.stringify(result));
      assert.equal(result.name, "改后的名称");
      assert.equal(result.noteText, "第一行\n第二行");
    } finally {
      await browser.close();
    }
  });

test("table names renumber on hiding, copying and undo while plain tables remain unchanged", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const result = await page.evaluate(async () => {
      const { setTableAnnotation } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.commands.setContent(
        "<table><tr><td>甲</td></tr></table><p></p><table><tr><td>乙</td></tr></table><p></p>",
      );
      const positions = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "tableCell") positions.push(pos);
      });
      const before = [...editor.view.dom.querySelectorAll(".table-annotation")].every(
        (el) => el.hidden,
      );
      editor.commands.setTextSelection(positions[0] + 2);
      setTableAnnotation(editor, { tableNameEnabled: true, tableName: "甲组" });
      editor.commands.setTextSelection(positions[1] + 2);
      setTableAnnotation(editor, { tableNameEnabled: true, tableName: "乙组" });
      const names = () =>
        [
          ...editor.view.dom.querySelectorAll(
            ".table-annotation--name:not([hidden]) .table-annotation__text",
          ),
        ].map((el) => el.textContent);
      const initial = names();
      editor.commands.setTextSelection(positions[0] + 2);
      setTableAnnotation(editor, { tableNameEnabled: false });
      const hiddenNames = names();
      editor.commands.undo();
      const undone = names();
      const html = editor.getHTML();
      const { sanitizePastedHtml } = await import("/src/editor/paste-sanitizer.ts");
      editor.commands.setContent(sanitizePastedHtml(html));
      const pasted = names();
      return { before, initial, hiddenNames, undone, pasted };
    });
    assert.ok(result.before);
    assert.deepEqual(result.initial, ["表1 甲组", "表2 乙组"]);
    assert.deepEqual(result.hiddenNames, ["表1 乙组"]);
    assert.deepEqual(result.undone, result.initial);
    assert.deepEqual(result.pasted, result.initial);
  } finally {
    await browser.close();
  }
});
