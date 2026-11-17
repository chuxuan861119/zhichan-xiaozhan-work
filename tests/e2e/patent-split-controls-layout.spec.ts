import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("split menu chevron stays centered at different interface scales", async ({ page }) => {
  await page.setContent('<div class="menu-bar"><fieldset class="patent-split-controls"><div class="patent-split-controls__buttons"><button>双列显示</button><button>同屏双显</button><button class="patent-split-controls__menu-trigger"><svg width="14" height="14" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></div></fieldset></div>');
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  for (const scale of [0.85, 1, 1.25, 1.5]) {
    await page.locator(".menu-bar").evaluate((element, scale) => { element.style.zoom = String(scale); }, scale);
    const offset = await page.locator(".patent-split-controls__menu-trigger").evaluate((element) => {
      const button = element.getBoundingClientRect();
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      return {
        x: Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
        y: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
      };
    });
    expect(offset.x).toBeLessThanOrEqual(0.8);
    expect(offset.y).toBeLessThanOrEqual(0.8);
  }
});
