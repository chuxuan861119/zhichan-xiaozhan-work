import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

async function withPage(run) {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    await run(page);
  } finally {
    await browser.close();
  }
}

async function setup(page, { zoom = 1, alignment = "left", tail = "", full = false } = {}) {
  await page.evaluate(
    ({ zoom, alignment, tail, full }) => {
      const editor = window.resizeTestEditor;
      editor.view.dom.style.width = "640px";
      editor.view.dom.style.zoom = String(zoom);
      editor.commands.setContent(
        `<table data-layout-mode="${full ? "fit-page" : "fixed"}" data-column-widths-mm="40,40" data-table-alignment="${alignment}"><tr><td>前格</td><td><p>末格</p><p>最后一行</p></td></tr></table>${tail}`,
      );
      let pos = 0;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "paragraph" && editor.state.doc.resolve(position).depth > 1)
          pos = position + 1 + node.content.size;
      });
      editor.commands.setTextSelection(pos);
      editor.view.focus();
    },
    { zoom, alignment, tail, full },
  );
}

async function state(page) {
  return page.evaluate(() => {
    const editor = window.resizeTestEditor;
    return {
      selection: editor.state.selection.toJSON(),
      doc: editor.getJSON(),
      depth: editor.state.selection.$from.depth,
      count: editor.state.doc.childCount,
      table: editor.state.doc.firstChild.textContent,
      last: editor.state.doc.lastChild.textContent,
    };
  });
}

for (const zoom of [0.75, 1, 1.5]) {
  for (const alignment of ["left", "center", "right"]) {
    test(`right blank click creates only the outside caret: ${alignment}, zoom ${zoom}`, () =>
      withPage(async (page) => {
        await setup(page, { zoom, alignment });
        const before = await state(page);
        const table = await page.locator("table").boundingBox();
        assert.ok(table);
        await page.mouse.click(table.x + table.width + 8, table.y + table.height - 15 * zoom);
        assert.equal((await state(page)).selection.type, "patent-table-end");
        assert.deepEqual((await state(page)).doc, before.doc);
        const caret = page.locator(".table-end-caret:not([hidden])");
        await caret.waitFor({ state: "attached" });
        const bounds = await caret.boundingBox();
        assert.ok(Math.abs(bounds.x - table.x - table.width - 3) < 1);
        const lastLine = await page.locator("td").last().locator("p").last().boundingBox();
        assert.ok(bounds.y >= lastLine.y - 1 && bounds.y < lastLine.y + lastLine.height);
        assert.equal(
          await page.locator(".tableWrapper").evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
        );
        await page.keyboard.insertText("表格后正文");
        const result = await state(page);
        assert.equal(result.depth, 1);
        assert.equal(result.last, "表格后正文");
        assert.equal(result.table, before.table);
      }));
  }
}

test("full-width table still has a right-side click zone without overflow", () =>
  withPage(async (page) => {
    await setup(page, { full: true });
    const table = await page.locator("table").boundingBox();
    await page.mouse.click(table.x + table.width + 8, table.y + table.height - 15);
    assert.equal((await state(page)).selection.type, "patent-table-end");
    assert.equal(
      await page.locator(".tableWrapper").evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
  }));

test("arrow, typing, backward deletion, undo and redo follow the boundary", () =>
  withPage(async (page) => {
    await setup(page);
    const before = await state(page);
    await page.keyboard.press("ArrowRight");
    assert.equal((await state(page)).selection.type, "patent-table-end");
    await page.keyboard.press("ArrowLeft");
    assert.equal((await state(page)).depth, 4);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    assert.deepEqual((await state(page)).doc, before.doc);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("正文");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    assert.equal((await state(page)).selection.type, "patent-table-end");
    assert.deepEqual((await state(page)).doc, before.doc);
    await page.keyboard.press("Control+z");
    assert.equal((await state(page)).count, 2);
    await page.keyboard.press("Control+y");
    assert.equal((await state(page)).selection.type, "patent-table-end");
  }));

test("normal Enter, Ctrl+Enter and Tab keep their in-cell meaning", () =>
  withPage(async (page) => {
    await setup(page);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal((await state(page)).depth, 4);
    assert.equal((await state(page)).count, 1);
    await page.keyboard.press("Control+Enter");
    assert.equal((await state(page)).depth, 4);
    assert.ok(await page.locator("td p br:not(.ProseMirror-trailingBreak)").count());
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => window.resizeTestEditor.state.doc.firstChild.childCount),
      2,
    );
  }));

test("Chinese composition at table-end retains all characters below the table", () =>
  withPage(async (page) => {
    await setup(page);
    await page.keyboard.press("ArrowRight");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "中文正文" });
    assert.equal((await state(page)).last, "中文正文");
    assert.equal((await state(page)).depth, 1);
    assert.equal((await state(page)).table, "前格末格最后一行");
    await cdp.detach();
  }));

test("note editing is not intercepted, and new body text follows the note", () =>
  withPage(async (page) => {
    await setup(page);
    await page.evaluate(async () => {
      const { setTableAnnotation } = await import("/src/editor/table/table-commands.ts");
      setTableAnnotation(window.resizeTestEditor, {
        tableNoteEnabled: true,
        tableNote: "表格说明",
      });
    });
    await page.locator(".table-annotation--note .table-annotation__text").click();
    await page.getByRole("textbox", { name: "编辑补充说明" }).fill("保留说明");
    await page.getByRole("textbox", { name: "编辑补充说明" }).press("Tab");
    const table = await page.locator("table").boundingBox();
    await page.mouse.click(table.x + table.width + 8, table.y + table.height - 15);
    await page.keyboard.insertText("说明后的正文");
    assert.equal((await state(page)).last, "说明后的正文");
    const note = await page.locator(".table-annotation--note").boundingBox();
    const body = await page.locator(".ProseMirror > p").boundingBox();
    assert.ok(body.y >= note.y + note.height);
  }));

test("right paper margin works after the editor is moved into its React-style host", () =>
  withPage(async (page) => {
    await setup(page, { full: true });
    await page.evaluate(() => {
      const mount = document.querySelector("#editor");
      const paper = document.createElement("div");
      paper.className = "patent-book-rich-text";
      paper.style.cssText = "width:840px;padding:60px;box-sizing:border-box";
      mount.before(paper);
      paper.append(mount);
    });
    const table = await page.locator("table").boundingBox();
    const before = await state(page);
    await page.mouse.click(table.x + table.width + 35, table.y + 10);
    assert.equal((await state(page)).selection.type, "patent-table-end");
    assert.deepEqual((await state(page)).doc, before.doc);
    await page.keyboard.insertText("页边距入口");
    assert.equal((await state(page)).last, "页边距入口");
  }));

test("cancelled Chinese composition restores the original boundary and empty paragraph state", () =>
  withPage(async (page) => {
    for (const tail of ["", '<p style="text-align:center"></p>']) {
      await setup(page, { tail });
      const before = await state(page);
      await page.keyboard.press("ArrowRight");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "中文",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      await page.waitForFunction(
        () => window.resizeTestEditor.state.selection.toJSON().type === "patent-table-end",
      );
      assert.deepEqual((await state(page)).doc, before.doc);
      await cdp.detach();
    }
  }));

for (const zoom of [0.75, 1, 1.5]) {
  test(`the entire right exterior blank band opens the table-end caret at zoom ${zoom}`, () =>
    withPage(async (page) => {
      await setup(page, { full: true, zoom });
      await page.evaluate(() => {
        const mount = document.querySelector("#editor");
        const workspace = document.createElement("div");
        workspace.className = "patent-page-with-rail";
        workspace.style.cssText = "width:1380px;min-height:400px";
        const frame = document.createElement("div");
        frame.className = "patent-page-zoom-frame";
        frame.style.width = "840px";
        const paper = document.createElement("div");
        paper.className = "patent-book-rich-text";
        paper.style.cssText = "width:840px;padding:60px;box-sizing:border-box";
        mount.before(workspace);
        workspace.append(frame);
        frame.append(paper);
        paper.append(mount);
      });
      const rect = await page.locator("table").boundingBox();
      const wrapper = await page.locator(".tableWrapper").boundingBox();
      const before = await state(page);
      for (const point of [
        { x: rect.x + rect.width + 3, y: rect.y + 10 },
        { x: rect.x + rect.width + 12, y: wrapper.y + wrapper.height - 2 },
        { x: 1370, y: rect.y + rect.height / 2 },
      ]) {
        await page.evaluate(() => {
          window.resizeTestEditor.commands.setTextSelection(4);
          window.resizeTestEditor.view.focus();
        });
        await page.mouse.click(point.x, point.y);
        assert.equal((await state(page)).selection.type, "patent-table-end");
        assert.deepEqual((await state(page)).doc, before.doc);
      }
      await page.evaluate(() => {
        const workspace = document.querySelector(".patent-page-with-rail");
        workspace.style.position = "relative";
        const rail = document.createElement("div");
        rail.className = "patent-global-function-rail-slot";
        rail.style.cssText =
          "position:absolute;right:0;top:0;width:80px;height:350px;background:#eee";
        workspace.append(rail);
        window.resizeTestEditor.commands.setTextSelection(4);
        window.resizeTestEditor.view.focus();
      });
      await page.mouse.click(1370, rect.y + rect.height / 2);
      assert.notEqual((await state(page)).selection.type, "patent-table-end");
    }));
}

test("real Backspace clears indentation on its own before returning to the table", () =>
  withPage(async (page) => {
    await setup(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.evaluate(() =>
      window.resizeTestEditor.commands.updateAttributes("paragraph", { paragraphIndentMm: 9.88 }),
    );
    await page.keyboard.press("Backspace");
    const unindented = await state(page);
    assert.equal(unindented.depth, 1);
    assert.equal(unindented.doc.content.at(-1).attrs.paragraphIndentMm, 0);
    assert.equal(unindented.count, 2);
    await page.keyboard.press("Backspace");
    assert.equal((await state(page)).selection.type, "patent-table-end");
    assert.equal((await state(page)).count, 1);
    await page.keyboard.press("Backspace");
    assert.equal((await state(page)).depth, 4);
    assert.equal((await state(page)).table, "前格末格最后一行");
  }));

test("native rich paste at the boundary preserves existing following text", () =>
  withPage(async (page) => {
    await setup(page, { tail: "<p>不能覆盖的正文</p>" });
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", "<p>粘贴第一段</p><p>粘贴第二段</p>");
      window.resizeTestEditor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    const result = await state(page);
    assert.equal(result.count, 4);
    assert.equal(result.doc.content[1].content[0].text, "粘贴第一段");
    assert.equal(result.doc.content[2].content[0].text, "粘贴第二段");
    assert.equal(result.last, "不能覆盖的正文");
  }));
