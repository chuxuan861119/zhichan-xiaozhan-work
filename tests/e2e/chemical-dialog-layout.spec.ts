import { expect, test } from "./helpers/workbench.js";

test("pins the chemistry header and fully exposes the element panel when height permits", async ({
  workbench,
}) => {
  const application = await workbench.launchAllowMultipleInstances("--headless");
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建专利" });
    await createDialog.getByRole("textbox", { name: "专利名称" }).fill("化学弹窗布局测试");
    await createDialog.getByRole("radio", { name: "发明", exact: true }).check();
    await createDialog.getByRole("button", { name: "创建专利" }).click();
    await expect(createDialog).toBeHidden({ timeout: 30_000 });
    const backup = page.getByRole("button", { name: "稍后设置" });
    if (await backup.isVisible()) await backup.click();
    await page.getByRole("button", { name: "插入化学方程式", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "插入化学方程式" });
    await dialog.getByRole("button", { name: "展开元素面板" }).click();

    const layout = await dialog.evaluate((element) => {
      const fixedTop = element.querySelector<HTMLElement>(".chemistry-dialog-fixed-top");
      const body = element.querySelector<HTMLElement>(".chemistry-dialog-scroll-body");
      const panel = element.querySelector<HTMLElement>(".chemical-periodic-panel");
      if (!fixedTop || !body || !panel) throw new Error("化学弹窗布局节点缺失");
      const dialogRect = element.getBoundingClientRect();
      const topBefore = fixedTop.getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      const topAfter = fixedTop.getBoundingClientRect().top;
      const panelRect = panel.getBoundingClientRect();
      return {
        topBefore,
        topAfter,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        panelHasOwnScroll: panel.scrollHeight > panel.clientHeight,
        panelTop: panelRect.top,
        panelBottom: panelRect.bottom,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
      };
    });

    expect(layout.bodyScrollable).toBe(true);
    expect(layout.topAfter).toBe(layout.topBefore);
    expect(layout.panelHasOwnScroll).toBe(false);
    expect(layout.panelTop).toBeGreaterThanOrEqual(layout.dialogTop);
    expect(layout.panelBottom).toBeLessThanOrEqual(layout.dialogBottom);

    await page.setViewportSize({ width: 1280, height: 650 });
    const compactLayout = await dialog.evaluate((element) => {
      const tray = element.querySelector<HTMLElement>(".chemistry-periodic-tray");
      if (!tray) throw new Error("元素面板展示区缺失");
      return {
        trayScrollable: tray.scrollHeight > tray.clientHeight,
      };
    });
    expect(compactLayout.trayScrollable).toBe(true);
  } finally {
    await application.close();
  }
});
