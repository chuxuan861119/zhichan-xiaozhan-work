import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

for (const zoom of [0.75, 1, 1.5])
  test(`row shrink preview matches release at zoom ${zoom}`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const row = page.locator("tr");
      const handle = page.locator("[data-table-row-resize]").first();
      await handle.waitFor();
      await page.locator("#editor").evaluate((element, value) => {
        element.style.zoom = String(value);
      }, zoom);
      const before = await row.boundingBox();
      const box = await handle.boundingBox();
      const x = box.x + 20;
      const y = box.y + 4;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 80);
      assert.ok((await row.boundingBox()).height > before.height + 70);
      await page.mouse.move(x, y);
      assert.ok(Math.abs((await row.boundingBox()).height - before.height) < 1);
      await page.mouse.move(x, y - 30);
      const preview = (await row.boundingBox()).height;
      await page.mouse.up();
      const committed = (await row.boundingBox()).height;
      assert.ok(Math.abs(preview - committed) < 1, `preview ${preview}, committed ${committed}`);
      assert.ok(committed < before.height - 10);
      await page.evaluate(() => window.resizeTestEditor.commands.undo());
      assert.ok(Math.abs((await row.boundingBox()).height - before.height) < 1);
      await page.evaluate(() => window.resizeTestEditor.commands.redo());
      assert.ok(Math.abs((await row.boundingBox()).height - committed) < 1);
    } finally {
      await browser.close();
    }
  });

for (const mode of ["Escape", "blur", "return"])
  test(`resize ${mode} restores formatting and document`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const handle = page.locator("[data-table-row-resize]").first();
      await handle.waitFor();
      const doc = await page.evaluate(() => window.resizeTestEditor.getJSON());
      const row = page.locator("tr");
      const initial = (await row.boundingBox()).height;
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + 20, box.y + 4);
      await page.mouse.down();
      await page.mouse.move(box.x + 20, box.y - 30);
      assert.ok((await row.boundingBox()).height < initial - 10);
      if (mode === "Escape") await page.keyboard.press("Escape");
      else if (mode === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else await page.mouse.move(box.x + 20, box.y + 4);
      await page.mouse.up();
      assert.ok(Math.abs((await row.boundingBox()).height - initial) < 1);
      assert.deepEqual(await page.evaluate(() => window.resizeTestEditor.getJSON()), doc);
      assert.equal(await page.locator("[data-table-row-resize-compact]").count(), 0);
    } finally {
      await browser.close();
    }
  });
