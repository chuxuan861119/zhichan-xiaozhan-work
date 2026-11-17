import type { Editor } from "@tiptap/core";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("complex search remains cancellable and ordinary search includes every final occurrence", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("查找完整性回归");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.evaluate((element) => {
    const e = (element as HTMLElement & { editor: Editor }).editor;
    e.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(500) + "!" }] }],
    });
    e.commands.focus();
  });
  await page.keyboard.press("Control+f");
  const query = page.getByRole("textbox", { name: "查找内容", exact: true });
  await page.getByRole("combobox", { name: "查找方式" }).selectOption("regex");
  await query.fill("a+a+a+a+b");
  await expect(page.getByText("正在查找全部内容…", { exact: true })).toBeVisible();
  // This action cannot complete if matching blocks the renderer thread.
  await query.fill("!", { timeout: 3000 });
  await expect(page.locator(".find-replace-panel__count")).toHaveText("0/1");
  await editor.evaluate((element) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 101 }, (_, i) => ({
        type: "paragraph",
        content: [{ type: "text", text: `技术${i} 技术` }],
      })),
    });
  });
  for (const mode of ["literal", "wildcard", "regex"]) {
    await page.getByRole("combobox", { name: "查找方式" }).selectOption(mode);
    await query.fill("技术");
    await expect(page.locator(".find-replace-panel__count")).toHaveText("0/202");
  }
  await page.getByRole("button", { name: "上一个", exact: true }).click();
  await expect(page.locator(".find-replace-panel__count")).toHaveText("202/202");
});
