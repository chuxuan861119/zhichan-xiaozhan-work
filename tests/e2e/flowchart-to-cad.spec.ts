import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { expect, test } from "./helpers/workbench.js";

for (const mode of ["流程图", "电路图"]) {
  test(`exports ${mode} to CAD and opens the imported drawing`, async ({ workbench }) => {
    test.setTimeout(120_000);
    const app = await workbench.launchAllowMultipleInstances();
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
      if (await welcome.isVisible())
        await welcome.getByRole("button", { name: "暂不创建" }).click();
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const create = page.getByRole("dialog", { name: "新建专利", exact: true });
      await create.getByRole("textbox", { name: "专利名称" }).fill("流程图转CAD测试");
      await create.getByRole("radio", { name: "发明", exact: true }).check();
      await create.getByRole("button", { name: "创建专利", exact: true }).click();
      await openDrawingEntry(page, "插入流程图");
      await expect
        .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
        .toBe(1);
      const frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
      if (!frame) throw new Error("Missing flowchart frame");
      await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
      // Hidden Electron's nested custom-protocol iframe can misroute CDP mouse
      // coordinates. Exercise its real button handlers without activating a window.
      const clickFrameButton = async (name: string) => {
        const button = frame.getByRole("button", { name, exact: true });
        await expect(button).toBeEnabled();
        await button.evaluate(element => (element as HTMLButtonElement).click());
      };
      await clickFrameButton("基础流程");
      await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
      if (mode === "电路图") await clickFrameButton("电路图");
      await clickFrameButton("导出至电脑");
      await page.getByRole("button", { name: "导出至CAD标号", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "导出至电脑", exact: true })).toBeHidden();
      await expect(page.getByLabel("图纸编辑工作区", { exact: true })).toBeVisible();
      await expect(page.locator(".drawing-feedback").filter({ hasText: "图纸已导入" })).toBeVisible(
        { timeout: 60_000 },
      );
      expect(errors).toEqual([]);
    } finally {
      // The isolated fixture contains only this test document; avoid close prompts during teardown.
      await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    }
  });
}
