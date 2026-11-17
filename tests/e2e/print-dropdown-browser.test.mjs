import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const css = await readFile(
  new URL("../../src/renderer/src/exports/print-center.css", import.meta.url),
  "utf8",
);

test("print settings and preview menus open below their controls without clipping", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent(`<style>${css}</style>
      <div class="print-center-dialog"><div class="print-center-dialog__body">
        <aside class="print-settings-panel" style="height:100px;width:280px">
          <label class="print-field">纸张<select aria-label="纸张">
            <option>A3</option><option selected>A4</option><option>A5</option>
          </select></label>
        </aside>
        <div class="print-preview-toolbar"><label>预览缩放<select aria-label="预览缩放">
          <option>适合页面</option><option selected>100%</option><option>150%</option>
        </select></label></div>
      </div></div>`);
    for (const label of ["纸张", "预览缩放"]) {
      const select = page.getByRole("combobox", { name: label });
      assert.equal(
        await select.evaluate((element) => getComputedStyle(element).appearance),
        "base-select",
      );
      await select.click();
      assert.equal(
        await select.evaluate(
          (element) => getComputedStyle(element, "::picker(select)").borderRadius,
        ),
        "12px",
      );
      const control = await select.boundingBox();
      const firstOption = select.locator("option").first();
      const option = await firstOption.boundingBox();
      assert.ok(option.y >= control.y + control.height, `${label} must open below the control`);
      assert.ok(Math.abs(option.x - control.x) < 12, `${label} must align with the control`);
      await firstOption.click();
      assert.equal(await select.inputValue(), label === "纸张" ? "A3" : "适合页面");
      assert.equal(await select.evaluate((element) => element.matches(":open")), false);
      await select.click();
      await page.keyboard.press("Escape");
      assert.equal(await select.evaluate((element) => element.matches(":open")), false);
      await select.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(await select.inputValue(), label === "纸张" ? "A4" : "100%");
    }
  } finally {
    await browser.close();
  }
});
