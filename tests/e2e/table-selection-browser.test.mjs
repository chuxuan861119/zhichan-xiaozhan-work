import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

for (const rowHeightRule of ["at-least", "exact"]) {
  test(`whole-table handle is visible, clickable and separate from insertion controls (${rowHeightRule})`, async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.TABLE_TEST_BROWSER_PATH
        ? { executablePath: process.env.TABLE_TEST_BROWSER_PATH }
        : { channel: "chrome" }),
    });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      await page.evaluate((rule) => {
        const editor = window.resizeTestEditor;
        editor.view.dom.style.margin = "80px";
        editor.commands.setContent(
          `<p>测试</p><table><tr data-row-height-rule="${rule}" data-row-height-mm="12"><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>`,
        );
      }, rowHeightRule);

      const table = await page.locator("table").boundingBox();
      const handle = page.locator("[data-table-selection-table]");
      await page.mouse.move(table.x + 40, table.y + 20);
      assert.equal(await handle.evaluate((element) => getComputedStyle(element).opacity), "1");
      const corner = await handle.boundingBox();
      assert.ok(corner.x + corner.width < table.x);
      assert.ok(corner.y + corner.height < table.y);

      const axisHandles = page.locator("[data-table-selection-row], [data-table-selection-column]");
      for (const axis of ["row", "column", "table"]) {
        const axisHandle = await page
          .locator(`[data-table-selection-${axis}]`)
          .first()
          .boundingBox();
        await page.mouse.move(axisHandle.x + 7, axisHandle.y + 7);
        assert.deepEqual(
          await axisHandles.evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).opacity),
          ),
          ["1", "1", "1", "1"],
          `hovering a ${axis} handle must reveal every row and column handle`,
        );
      }

      for (const [axis, x, y] of [
        ["row", table.x - 8, table.y],
        ["column", table.x, table.y - 8],
      ]) {
        await page.mouse.move(table.x + 40, table.y + 20);
        await page.mouse.move(x, y);
        const insert = page.locator(".table-insert-handle");
        await insert.waitFor({ state: "visible", timeout: 5_000 });
        assert.equal(await insert.getAttribute("aria-label"), axis === "row" ? "插入行" : "插入列");
        const plus = await insert.boundingBox();
        assert.ok(
          corner.x + corner.width <= plus.x ||
            plus.x + plus.width <= corner.x ||
            corner.y + corner.height <= plus.y ||
            plus.y + plus.height <= corner.y,
          `${axis} insertion hit area must not overlap the whole-table handle`,
        );
      }

      await page.mouse.move(corner.x + 7, corner.y + 7);
      assert.equal(
        await handle.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return document.elementFromPoint(bounds.x + 7, bounds.y + 7) === element;
        }),
        true,
      );
      await handle.click();
      assert.equal(await page.locator(".selectedCell").count(), 4);
    } finally {
      await browser.close();
    }
  });
}

for (const axis of ["row", "column"]) {
  test(`inserting a ${axis} with the plus selects the new section`, async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.TABLE_TEST_BROWSER_PATH
        ? { executablePath: process.env.TABLE_TEST_BROWSER_PATH }
        : { channel: "chrome" }),
    });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      await page.evaluate(() => {
        window.resizeTestEditor.view.dom.style.margin = "80px";
        window.resizeTestEditor.commands.setContent(
          "<p>测试</p><table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
        );
      });
      const table = await page.locator("table").boundingBox();
      const cell = await page.locator("td").first().boundingBox();
      await page.mouse.move(
        axis === "row" ? table.x - 8 : cell.x + cell.width,
        axis === "row" ? cell.y + cell.height : table.y - 8,
      );
      await page.locator(".table-insert-handle").click();
      const selection = await page.evaluate(async () => {
        const { inspectTableSelection } = await import("/src/editor/table/table-selection.ts");
        return inspectTableSelection(window.resizeTestEditor);
      });
      assert.equal(selection.kind, axis);
      assert.equal(selection.selectedCellCount, 2);
      assert.deepEqual(
        axis === "row" ? selection.selectedRowIndexes : selection.selectedColumnIndexes,
        [1],
      );
      assert.equal(await page.locator("table").first().locator(".selectedCell").count(), 2);
    } finally {
      await browser.close();
    }
  });
}
