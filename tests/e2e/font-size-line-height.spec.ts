import type { Editor } from "@tiptap/core";
import { expect, test } from "./helpers/workbench.js";

test("small paragraph line height survives the toolbar, undo, closing and reopening", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    for (const name of ["暂不创建", "稍后设置"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible()) await button.click();
    }
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    const name = "小字号行距保存验收";
    await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setContent(
        '<p data-default-font-size-pt="14">首行文字<br>次行文字<br>第三行文字</p>',
      );
      e.commands.selectAll();
    });
    await page.getByRole("combobox", { name: "字号", exact: true }).selectOption("10.5");
    await expect(editor.locator("p")).toHaveAttribute("data-default-font-size-pt", "10.5");
    await expect(editor.locator("p")).toHaveCSS("font-size", "14px");
    await expect(editor.locator("p")).toHaveCSS("line-height", "28.35px");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(editor.locator("p")).toHaveAttribute("data-default-font-size-pt", "14");
    await expect(editor).toHaveText("首行文字次行文字第三行文字");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(editor.locator("p")).toHaveAttribute("data-default-font-size-pt", "10.5");
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    const card = page.getByRole("article", { name });
    await card.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(editor.locator("p")).toHaveCSS("font-size", "14px");
    await expect(editor.locator("p")).toHaveCSS("line-height", "28.35px");
    await expect(editor).toHaveText("首行文字次行文字第三行文字");
  } finally {
    await app.close();
  }
});
