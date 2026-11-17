import { OFFICIAL_WEBSITES } from "../../src/shared/official-websites.js";
import { expect, test } from "./helpers/workbench.js";

test("Help official websites use the native browser bridge and fit the window", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ shell }) => {
      Object.defineProperty(shell, "openExternal", {
        configurable: true,
        value: async (url: string) => {
          process.env.OFFICIAL_WEBSITE_TEST_URL = url;
        },
      });
    });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    for (const site of OFFICIAL_WEBSITES) {
      await page.getByRole("button", { name: "帮助", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "常用官方网站", exact: true })
        .dispatchEvent("pointerover");
      const menu = page.getByRole("menu", { name: "常用官方网站", exact: true });
      await expect(menu.getByRole("menuitem")).toHaveCount(19);
      const rowsDoNotOverlap = await menu.locator("fieldset").evaluateAll((groups) =>
        groups.every((group) => {
          const rows = [...group.querySelectorAll('.file-menu-label, [role="menuitem"]')];
          return rows.every(
            (row, index) =>
              index === 0 ||
              row.getBoundingClientRect().top >= rows[index - 1]!.getBoundingClientRect().bottom,
          );
        }),
      );
      expect(rowsDoNotOverlap).toBe(true);
      const bounds = await menu.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await menu.getByRole("menuitem", { name: site.label, exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expect
        .poll(() => app.evaluate(() => process.env.OFFICIAL_WEBSITE_TEST_URL))
        .toBe(site.url);
    }
  } finally {
    await app.close();
  }
});
