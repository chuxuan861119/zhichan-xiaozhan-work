import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

async function styles(page: import("@playwright/test").Page) {
  for (const path of [
    "app/app.css",
    "editor/ui/toolbar-dropdowns.css",
    "shared/button-feedback.css",
  ])
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${path}`, "utf8") });
}

test("overflow and import/export menus stay inside narrow and split panes", async ({ page }) => {
  for (const width of [480, 800, 1200]) {
    await page.setViewportSize({ width, height: 720 });
    for (const kind of ["overflow", "import", "export"]) {
      await page.setContent(`<div class="tool-bar" style="position:absolute;right:0;top:80px;width:320px;height:40px">
        <div class="toolbar-${kind}-picker" style="margin-left:auto"><button class="more-tools" style="display:block">更多</button>
        ${kind === "overflow" ? "</div>" : ""}<div class="spatial-presence" data-motion="enter"><div role="menu" class="toolbar-${kind}-menu"><button>插入化学结构式</button></div></div>${kind !== "overflow" ? "</div>" : ""}</div>`);
      await styles(page);
      const box = await page.getByRole("menu").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 7);
    }
  }
});

test("figure selection and resize hit areas remain transparent on hover", async ({ page }) => {
  await page.setContent(
    '<div class="drawing-figure-frame" style="width:200px;height:200px;background:red"><button aria-label="选择图1" class="drawing-figure-select-target"></button></div><button class="dialog-resize" style="background:transparent;width:20px;height:20px">resize</button>',
  );
  await styles(page);
  for (const selector of [".drawing-figure-select-target", ".dialog-resize"]) {
    const button = page.locator(selector);
    await button.hover();
    await expect
      .poll(() => button.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe("rgba(0, 0, 0, 0)");
  }
});
