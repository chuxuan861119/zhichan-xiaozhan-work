import { expect, test } from "./helpers/workbench.js";

test("dual-column floating rail follows its edge handle after resizing", async ({ workbench }) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("功能栏定位验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  for (const width of [1900, 1800]) {
    await page.setViewportSize({ width, height: 1000 });
    // Initial columns keep the rail expanded; explicitly zoom to its overlay state.
    for (let step = 0; step < 20; step++) await page.keyboard.press("Control+=");
    const handle = page.locator(".dual-column-edge-toggle");
    await expect(handle).toBeVisible();
    await handle.getByRole("button", { name: "展开功能栏", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "说明书全局功能栏", exact: true });
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const card = await panel.boundingBox();
        const toggle = await handle.boundingBox();
        return card && toggle ? Math.abs(toggle.x - card.x - card.width - 12) : Infinity;
      })
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/dual-column-rail-anchor-${width}.png` });
    await panel.getByRole("button", { name: "收起功能栏", exact: true }).click();
  }
});
