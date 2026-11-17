import { readFileSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";

test("resizable dialogs grow beyond their initial height while staying inside the viewport", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.setContent(`<style>${readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8")}</style>
      <div class="standard-dialog-overlay"><div class="standard-dialog standard-dialog--xl standard-dialog--resizable" style="height:900px">预览</div></div>`);
    const dialog = page.locator(".standard-dialog");
    await expect.poll(() => dialog.evaluate((element) => element.clientHeight)).toBe(900);
    await dialog.evaluate((element) => {
      (element as HTMLElement).style.height = "1100px";
    });
    await expect.poll(() => dialog.evaluate((element) => element.clientHeight)).toBe(1100);
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect.poll(() => dialog.evaluate((element) => element.clientHeight)).toBe(752);
    await page.setViewportSize({ width: 1600, height: 1200 });
    await dialog.evaluate((element) => element.classList.remove("standard-dialog--resizable"));
    await expect.poll(() => dialog.evaluate((element) => element.clientHeight)).toBe(720);
  } finally {
    await browser.close();
  }
});
