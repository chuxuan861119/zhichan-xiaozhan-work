import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

for (const panelClass of [
  "patent-check-panel patent-check-panel--mint",
  "ai-correction-panel",
  "ai-correction-panel text-polish-panel",
]) {
  test(`overflow menu remains clickable above ${panelClass} but below dialogs`, async ({
    page,
  }) => {
    await page.setContent(`
      <div class="tool-bar" style="margin-top:90px;height:40px">
        <button class="more-tools">更多工具</button>
        <div class="toolbar-overflow-menu">
          <button>查找</button><button>替换</button><button id="target">插入表格</button>
        </div>
      </div>
      <aside class="assistant-side-panel ${panelClass}">面板内容</aside>
    `);
    await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
    await page.evaluate(() => {
      const target = document.getElementById("target");
      if (!target) throw new Error("missing overflow item");
      target.onclick = () => {
        document.body.dataset.clicked = "true";
      };
    });
    const target = page.locator("#target");
    // Hit testing detects stacking-context failures, not just DOM visibility.
    const isOnTop = () =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      });
    await expect.poll(isOnTop).toBe(true);
    await target.click();
    await expect(page.locator("body")).toHaveAttribute("data-clicked", "true");

    await page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.className = "dialog-backdrop";
      document.body.append(dialog);
    });
    await expect.poll(isOnTop).toBe(false);
    await page.locator(".dialog-backdrop").evaluate((element) => element.remove());
    await page.locator(".toolbar-overflow-menu").evaluate((element) => element.remove());
    await expect(page.locator(".tool-bar")).toHaveCSS("z-index", "10");
  });
}
