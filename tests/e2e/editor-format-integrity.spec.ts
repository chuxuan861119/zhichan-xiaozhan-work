import type { Editor } from "@tiptap/core";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("font baselines and inherited paste colors survive real editing and reopening", async ({
  workbench,
}) => {
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    const name = "字体与格式保存回归";
    await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    // Adjacent marks may share a span; inspect the actual text leaf, not wrapper boundaries.
    const textColor = (text: string) =>
      editor.evaluate((element, expectedText) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node.textContent?.includes(expectedText) && node.parentElement)
            return getComputedStyle(node.parentElement).color;
          node = walker.nextNode();
        }
        return null;
      }, text);
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setContent("<p></p><p>保留正文</p><p></p>");
      e.commands.setTextSelection(1);
    });
    const font = page.locator(".tool-bar").getByRole("combobox", { name: "字体", exact: true });
    await font.selectOption("KaiTi");
    await expect(editor.locator(":scope > p").first()).toHaveAttribute(
      "data-default-font-family",
      "KaiTi",
    );
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    const card = page.getByRole("article", { name, exact: true });
    await card.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(editor.locator(":scope > p").first()).toHaveAttribute(
      "data-default-font-family",
      "KaiTi",
    );
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setTextSelection(e.state.doc.content.size - 1);
      const data = new DataTransfer();
      data.setData(
        "text/html",
        '<div style="color:#123456"><p>继承颜色<strong>加粗</strong><font color="blue">蓝色</font></p></div>',
      );
      data.setData("text/plain", "继承颜色加粗蓝色");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
    });
    await expect(editor).toContainText("继承颜色加粗蓝色");
    await expect.poll(() => textColor("继承颜色")).toBe("rgb(18, 52, 86)");
    await expect.poll(() => textColor("蓝色")).toBe("rgb(0, 0, 255)");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(editor).not.toContainText("继承颜色");
    await expect(editor).toContainText("保留正文");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(editor).toContainText("继承颜色加粗蓝色");
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    await card.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect.poll(() => textColor("继承颜色")).toBe("rgb(18, 52, 86)");
    await expect.poll(() => textColor("蓝色")).toBe("rgb(0, 0, 255)");
    await expect(editor.locator(":scope > p").first()).toHaveAttribute(
      "data-default-font-family",
      "KaiTi",
    );
  } finally {
    // This disposable profile checks document reopen, not the application's quit handshake.
    await application.evaluate(({ app }) => app.exit(0));
    await application.close();
  }
});
