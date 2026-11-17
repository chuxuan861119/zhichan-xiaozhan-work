import type { Page } from "@playwright/test";
import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function createPatent(page: Page, name: string) {
  const library = page.getByRole("tab", { name: "专利库", exact: true });
  if (await library.isVisible()) await library.click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}

test("one flowchart kernel restores each patent's native undo, redo and unfinished label", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createPatent(page, "会话甲");
  await openDrawingEntry(page, "插入流程图");
  await expect
    .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
    .toBe(1);
  const frame = page.frames().find((f) => f.url().endsWith("/embed.html"))!;
  await expect(page.getByTitle("流程图编辑器")).not.toHaveAttribute("inert", "");
  await expect(page.getByText("正在加载绘图编辑器…", { exact: true })).toBeHidden();
  await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  // Offscreen Electron does not route pointer input to this cross-origin nested
  // frame reliably. DOM events still exercise its real native editor/actions.
  await frame.getByRole("button", { name: "基础流程", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "撤销", exact: true })).toBeEnabled();
  await frame.getByRole("button", { name: "步骤编号", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.getByRole("button", { name: "重做", exact: true })).toBeEnabled();
  await createPatent(page, "会话乙");
  await openDrawingEntry(page, "插入流程图");
  await expect(page.getByTitle("流程图编辑器")).not.toHaveAttribute("inert", "");
  await expect(page.getByText("正在加载绘图编辑器…", { exact: true })).toBeHidden();
  await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  await expect(frame.getByText("处理步骤", { exact: true })).toHaveCount(0);
  await frame.getByRole("button", { name: "基础流程", exact: true }).dispatchEvent("click");
  await frame.getByRole("button", { name: "步骤编号", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "会话甲", exact: true }).click();
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "重做", exact: true })).toBeEnabled();
  await frame.getByRole("button", { name: "重做", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await frame.getByText("处理步骤", { exact: true }).dispatchEvent("dblclick");
  const text = frame.locator('.mxCellEditor[contenteditable="true"]:visible').last();
  await text.fill("甲专利未结束输入");
  await page.getByRole("tab", { name: "会话乙", exact: true }).click();
  await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
  await expect(frame.getByText("甲专利未结束输入", { exact: true })).toHaveCount(0);
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "会话甲", exact: true }).click();
  await expect(text).toBeVisible();
  await expect(text).toHaveText("甲专利未结束输入");
  await text.press("Control+Enter");
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  for (const name of ["会话乙", "会话甲", "会话乙", "会话甲"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    expect(frame.isDetached()).toBe(false);
    expect(page.frames().filter((f) => f.url().endsWith("/embed.html"))).toHaveLength(1);
    await expect(page.locator('iframe[src$="/adapter.html"]')).toHaveCount(1);
  }
  await frame.locator(".geTabContainer .geControlTab").first().dispatchEvent("click");
  await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(2);
  await frame.getByRole("button", { name: "基础流程", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "会话乙", exact: true }).click();
  await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(1);
  await page.getByRole("tab", { name: "会话甲", exact: true }).click();
  await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(2);
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toHaveCount(0);
  await frame.getByRole("button", { name: "撤销", exact: true }).dispatchEvent("click");
  await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(1);
  await frame.getByRole("button", { name: "重做", exact: true }).dispatchEvent("click");
  await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(2);
  await frame.getByRole("button", { name: "重做", exact: true }).dispatchEvent("click");
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "导出至电脑", exact: true }).dispatchEvent("click");
  const exporting = page.getByRole("dialog", { name: "导出至电脑" });
  await expect(exporting).toBeVisible();
  await expect(exporting.locator("img")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CAD keeps independent undo/redo and an unfinished LINE while leasing one worker", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  const openCad = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    await expect(page.getByRole("region", { name: "CAD实体编辑" })).toHaveAttribute(
      "data-cad-ready",
      "true",
      { timeout: 60000 },
    );
  };
  const workspace = () => page.getByRole("region", { name: "CAD标号", exact: true });
  const panel = () => page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = () => workspace().getByRole("application", { name: "CAD标号画布" });
  const count = () =>
    panel().evaluate((el) => {
      // Inspect the scene published by the real worker, not a screenshot stroke count.
      let fiber = (el as any)[Object.keys(el).find((key) => key.startsWith("__reactFiber"))!];
      for (; fiber; fiber = fiber.return)
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const value = hook.memoizedState?.current;
          if (Array.isArray(value?.entities) && Array.isArray(value?.primitives))
            return value.entities.length;
        }
      return -1;
    });
  const undo = () => workspace().getByRole("button", { name: "撤销标号编辑", exact: true });
  const redo = () => workspace().getByRole("button", { name: "重做标号编辑", exact: true });
  const switchTo = async (name: string) => {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(panel()).toHaveAttribute("data-cad-ready", "true");
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes("cadcraft-worker")).length)
      .toBe(1);
  };
  await createPatent(page, "CAD甲");
  await openCad();
  await panel().getByRole("button", { name: "直线", exact: true }).click();
  await canvas().click({ position: { x: 150, y: 150 } });
  await canvas().click({ position: { x: 280, y: 200 } });
  await canvas().click({ position: { x: 380, y: 300 } });
  await expect.poll(count).toBe(2);
  await expect(workspace()).toHaveAttribute("data-cad-pending", "false");
  await undo().click();
  await expect.poll(count).toBe(1);
  await createPatent(page, "CAD乙");
  await openCad();
  await panel().getByRole("button", { name: "直线", exact: true }).click();
  await canvas().click({ position: { x: 180, y: 160 } });
  await canvas().click({ position: { x: 320, y: 210 } });
  await expect.poll(count).toBe(1);
  await switchTo("CAD甲");
  await expect.poll(count).toBe(1);
  await redo().click();
  await expect.poll(count).toBe(2);
  await undo().click();
  await expect.poll(count).toBe(1);
  await switchTo("CAD乙");
  await expect.poll(count).toBe(1);
  // Continue the same line command, without selecting the tool or a new first point.
  await canvas().click({ position: { x: 420, y: 310 } });
  await expect.poll(count).toBe(2);
  await undo().click();
  await expect.poll(count).toBe(1);
  await switchTo("CAD甲");
  await redo().click();
  await expect.poll(count).toBe(2);
  await switchTo("CAD乙");
  await redo().click();
  await expect.poll(count).toBe(2);
});
