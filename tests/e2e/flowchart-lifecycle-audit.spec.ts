import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { expect, test } from "./helpers/workbench.js";

test("closing the host tab commits an unfinished shape label", async ({ workbench }) => {
  test.setTimeout(90_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");
    await expect
      .poll(() => page.frames().some((frame) => frame.url().endsWith("/embed.html")))
      .toBe(true);
    const frame = page.frames().find((candidate) => candidate.url().endsWith("/embed.html"));
    if (!frame) throw new Error("流程图未加载");
    await expect(page.getByTitle("流程图编辑器")).not.toHaveAttribute("inert", "");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "基础流程", exact: true }).click();
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    // Enter a label while the template change still has an automatic save pending.
    await frame.getByText("处理步骤", { exact: true }).click();
    await frame.locator("body").press("ArrowRight");
    await frame.getByText("处理步骤", { exact: true }).dblclick();
    const pendingLabel = frame.locator('.mxCellEditor[contenteditable="true"]:visible').last();
    await pendingLabel.fill("自动保存不能打断输入");
    await page.waitForTimeout(4_000); // Cross the engine and host autosave debounce while typing.
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    await expect(pendingLabel).toBeVisible();
    await pendingLabel.fill("处理步骤");
    await pendingLabel.press("Control+Enter");
    await frame.locator("body").press("Control+s");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    await frame.getByText("处理步骤", { exact: true }).dblclick();
    const label = frame.locator('.mxCellEditor[contenteditable="true"]:visible').last();
    await label.fill("关闭前尚未结束输入的标签");
    // Do not press Enter or click the canvas: the outer close action must flush editing.
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await expect(page.getByTitle("流程图编辑器")).toHaveCount(0);
    await openDrawingEntry(page, "插入流程图");
    await expect
      .poll(() => page.frames().some((candidate) => candidate.url().endsWith("/embed.html")))
      .toBe(true);
    const reopened = page.frames().find((candidate) => candidate.url().endsWith("/embed.html"));
    if (!reopened) throw new Error("流程图未重开");
    await expect(reopened.getByText("关闭前尚未结束输入的标签", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
