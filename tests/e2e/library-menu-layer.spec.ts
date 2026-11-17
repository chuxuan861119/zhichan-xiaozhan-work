import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("patent card menu stays above the sticky library toolbar", async ({ workbench }) => {
  const profile = await workbench.launchProfile("library-menu-layer");
  try {
    const page = await profile.application.firstWindow();
    await page.waitForFunction(() => Boolean((window as { patentApi?: PatentApi }).patentApi));
    await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const result = await api.patents.create({
        name: "菜单层级验收专利",
        patentType: "invention",
      });
      if (!result.ok) throw new Error(result.error.message);
      const released = await api.patents.release(result.value.sessionId);
      if (!released.ok) throw new Error(released.error.message);
    });
    await page.reload();
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await library
      .getByRole("article", { name: "菜单层级验收专利" })
      .getByRole("button", { name: "更多操作" })
      .click();
    const menu = page.getByRole("menu", { name: "专利操作" });
    await expect(menu).toBeVisible();
    const layout = await menu.evaluate((element) => {
      const toolbar = document.querySelector(".library-toolbar");
      if (!toolbar) throw new Error("专利库固定工具栏不存在");
      const rect = element.getBoundingClientRect();
      return {
        inBody: element.parentElement === document.body,
        position: getComputedStyle(element).position,
        menuLayer: Number(getComputedStyle(element).zIndex),
        toolbarLayer: Number(getComputedStyle(toolbar).zIndex),
        withinViewport:
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });
    expect(layout.inBody).toBe(true);
    expect(layout.position).toBe("fixed");
    expect(layout.menuLayer).toBeGreaterThan(layout.toolbarLayer);
    expect(layout.withinViewport).toBe(true);
  } finally {
    await profile.application.close();
  }
});
