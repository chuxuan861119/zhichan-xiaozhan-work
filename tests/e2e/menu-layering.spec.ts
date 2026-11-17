import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

const fixture = new URL("./fixtures/submenu-hover.html", import.meta.url).pathname;
const origin = process.env.SUBMENU_TEST_ORIGIN ?? "http://127.0.0.1:5173";

for (const mode of ["single", "double", "illustrated"]) {
  test(`top menus stay above the sticky library header in ${mode} view`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/@fs${fixture}?library=${mode}`);
    await expect(page.getByRole("article").first()).toBeVisible();
    for (const group of ["file", "edit", "insert", "format", "view", "tools", "help"]) {
      const trigger = page
        .locator(`.menu-bar__menu-group[data-menu-group="${group}"] > button`)
        .first();
      await trigger.click();
      const menu = page
        .locator(`.menu-bar__menu-group[data-menu-group="${group}"] .file-menu`)
        .first();
      await expect(menu).toBeVisible();
      const paintedAbove = await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [20, 65, 110]
          .filter((offset) => offset < rect.height - 8)
          .every((offset) =>
            element.contains(document.elementFromPoint(rect.right - 12, rect.top + offset)),
          );
      });
      expect(paintedAbove, `${group} menu must receive pointer hits over library content`).toBe(
        true,
      );
      await page.keyboard.press("Escape");
    }
    await page.locator(".library-view").evaluate((element) => {
      element.scrollTop = 300;
    });
    const stickyHeaderAboveCards = await page.locator(".library-toolbar").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.right - 15, rect.top + 40));
    });
    expect(stickyHeaderAboveCards).toBe(true);
  });
}
