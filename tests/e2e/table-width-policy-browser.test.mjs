import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;
for (const [width, zoom] of [
  [850, 0.75],
  [1400, 1],
  [1800, 1.5],
]) {
  test(`page-width constraint uses document units at window ${width}, zoom ${zoom}`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (zoom) => {
        const { insertPatentTable, runTableCommand } = await import(
          "/src/editor/table/table-commands.ts"
        );
        const editor = window.resizeTestEditor;
        editor.view.dom.style.width = "146.6mm";
        editor.view.dom.style.maxWidth = "none";
        editor.view.dom.style.zoom = String(zoom);
        editor.commands.setContent("<p></p>");
        const inserted = insertPatentTable(editor, {
          rows: 2,
          columns: 13,
          headerRowCount: 0,
          layoutMode: "fit-page",
        });
        const before = JSON.stringify(editor.getJSON());
        const added = runTableCommand(editor, "add-column-after");
        const table = editor.view.dom.querySelector("table");
        return {
          inserted,
          added,
          unchanged: before === JSON.stringify(editor.getJSON()),
          tableWidth: table.offsetWidth,
          bodyWidth: editor.view.dom.clientWidth,
        };
      }, zoom);
      assert.equal(result.inserted, true);
      assert.equal(result.added, false);
      assert.equal(result.unchanged, true);
      assert.ok(result.tableWidth <= result.bodyWidth + 1);
    } finally {
      await browser.close();
    }
  });
}

test("dragging the right table edge to the page limit does not create horizontal overflow", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    await page.evaluate(() => {
      const editor = window.resizeTestEditor;
      editor.commands.setContent(
        `<table><tr>${Array.from({ length: 6 }, (_, index) => `<td><p>${index + 1}</p></td>`).join("")}</tr></table><p></p>`,
      );
      editor.view.dom.style.width = "620px";
      editor.view.dom.style.maxWidth = "none";
    });

    const lastCell = await page.locator("td").last().boundingBox();
    assert.ok(lastCell);
    const x = lastCell.x + lastCell.width - 1;
    const y = lastCell.y + lastCell.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 200, y, { steps: 5 });

    const during = await page.evaluate(() => {
      const wrapper = document.querySelector(".tableWrapper");
      return { clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth };
    });
    await page.mouse.up();
    const after = await page.evaluate(() => {
      const wrapper = document.querySelector(".tableWrapper");
      return { clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth };
    });

    assert.ok(during.scrollWidth <= during.clientWidth);
    assert.ok(after.scrollWidth <= after.clientWidth);
  } finally {
    await browser.close();
  }
});
