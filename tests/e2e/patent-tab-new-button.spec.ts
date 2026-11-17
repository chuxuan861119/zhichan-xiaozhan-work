import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function createPatentFromPlus(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "新建专利（加号）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("new-patent plus follows tabs and remains usable when the strip fills", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launchAllowMultipleInstances();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1500, height: 900 });
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await createPatentFromPlus(page, "标签验收 1");
  await expect(
    page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "新建", exact: true }),
  ).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = document
          .querySelector(".patent-tabs__patent-tab-shell")!
          .getBoundingClientRect();
        const plus = document.querySelector(".patent-tabs__new-patent")!.getBoundingClientRect();
        return plus.left - tab.right;
      }),
    )
    .toBeLessThan(20);

  for (let index = 2; index <= 8; index++) await createPatentFromPlus(page, `标签验收 ${index}`);
  for (const width of [1500, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "全部专利", exact: true })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      };
      const viewport = document.querySelector(".patent-tabs__patent-viewport")!;
      return {
        plus: rect(".patent-tabs__new-patent"),
        viewport: rect(".patent-tabs__patent-viewport"),
        overflow: rect(".patent-tabs__overflow-trigger"),
        ipc: rect(".ipc-data-center-trigger"),
        scrolls: viewport.scrollWidth > viewport.clientWidth,
        bodyFits: document.documentElement.scrollWidth <= window.innerWidth,
        chromeBoundary: window.innerWidth - 138,
      };
    });
    expect(geometry.scrolls).toBe(true);
    expect(geometry.bodyFits).toBe(true);
    expect(geometry.plus.width).toBe(32);
    expect(geometry.plus.left).toBeGreaterThanOrEqual(geometry.viewport.right);
    expect(geometry.plus.right).toBeLessThanOrEqual(geometry.overflow.left);
    expect(geometry.ipc.right).toBeLessThanOrEqual(geometry.chromeBoundary);
    await page.getByRole("button", { name: "新建专利（加号）", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".patent-tabs__patent-tab-shell")).toHaveCount(8);
  }

  await page.getByRole("button", { name: "全部专利", exact: true }).click();
  const menu = page.getByRole("menu", { name: "全部已打开专利" });
  await expect(menu.getByRole("menuitem")).toHaveCount(8);
  await menu.getByRole("menuitem", { name: /标签验收 1/u }).click();
  await expect(page.getByRole("tab", { name: "标签验收 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await createPatentFromPlus(page, "标签验收 9");
  await expect(page.locator(".patent-tabs__patent-tab-shell")).toHaveCount(9);
  await application.close();
});
