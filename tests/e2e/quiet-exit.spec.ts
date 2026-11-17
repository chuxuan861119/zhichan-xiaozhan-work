import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("fast exit preserves the last editor input and a readable recovery point", async ({
  workbench,
}) => {
  const first = await workbench.launchAllowMultipleInstances();
  try {
    const page = await first.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("快速退出验证");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const configured = await page.evaluate(() =>
      window.patentApi.settings.update({ closeToTray: false }),
    );
    expect(configured.ok).toBe(true);
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await editor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.insertText("退出前最后输入XYZ");
    const exited = new Promise<void>((resolve) => first.once("close", resolve));
    await first
      .evaluate(({ app, BrowserWindow }) => {
        // Closing the last Mac window keeps the application in the Dock; quitting
        // exercises the same save barrier as the native Quit menu.
        if (process.platform === "darwin") app.quit();
        else BrowserWindow.getAllWindows()[0]?.close();
      })
      .catch(() => undefined);
    await exited;
  } finally {
    await first.close().catch(() => undefined);
  }
  const second = await workbench.launchAllowMultipleInstances();
  try {
    const page = await second.firstWindow();
    await dismissWorkbenchWelcome(page);
    const recovery = await page.evaluate(async () => {
      const result = await window.patentApi.snapshot.list();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.entries.filter((entry) => entry.displayName === "快速退出验证");
    });
    expect(recovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "application-close", status: "healthy" }),
      ]),
    );
    const card = page.getByRole("article", { name: "快速退出验证", exact: true });
    await card.dblclick();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书", exact: true })).toContainText(
      "退出前最后输入XYZ",
    );
  } finally {
    await second.close();
  }
});
