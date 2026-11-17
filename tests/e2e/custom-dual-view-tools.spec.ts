import type { Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function openCustom(page: Page) {
  await page.getByRole("button", { name: "打开常用双文档搭配", exact: true }).click();
  await page.getByRole("menuitem", { name: "自定义", exact: true }).click();
  return page.getByRole("dialog", { name: "自定义同屏双显", exact: true });
}

test("saves, restores and activates book/CAD and flowchart/CAD custom presets in the background", async ({
  workbench,
}) => {
  const application = await workbench.launchAllowMultipleInstances();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1920, height: 1000 });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称" }).fill("自定义双显工具验收");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();

  let dialog = await openCustom(page);
  await dialog.getByRole("button", { name: "添加预设", exact: true }).click();
  await dialog.getByLabel("第 1 组右侧文档", { exact: true }).selectOption("drawing-markup");
  await dialog.getByRole("button", { name: "添加预设", exact: true }).click();
  await dialog.getByLabel("第 2 组左侧文档", { exact: true }).selectOption("flowchart");
  await dialog.getByLabel("第 2 组右侧文档", { exact: true }).selectOption("drawing-markup");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openCustom(page);
  await expect(dialog.getByLabel("第 1 组右侧文档", { exact: true })).toHaveValue("drawing-markup");
  await expect(dialog.getByLabel("第 2 组左侧文档", { exact: true })).toHaveValue("flowchart");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  await page.getByRole("button", { name: "说明书｜CAD标号", exact: true }).click();
  const left = page.getByRole("region", { name: "左侧文档", exact: true });
  const right = page.getByRole("region", { name: "右侧文档", exact: true });
  await expect(left.locator(".tiptap").first()).toBeVisible();
  await expect(right.getByRole("button", { name: "切换右侧文档" }).first()).toContainText(
    "CAD标号",
  );
  await expect(page.getByRole("region", { name: "CAD标号", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "流程图 / 电路图｜CAD标号", exact: true }).click();
  await expect(left.getByRole("button", { name: "切换左侧文档" }).first()).toContainText(
    "流程图 / 电路图",
  );
  await expect(page.locator('iframe[title="流程图编辑器"]')).toHaveCount(1);
  await expect(page.getByRole("region", { name: "CAD标号", exact: true })).toHaveCount(1);
  await expect(
    page
      .frameLocator('iframe[title="流程图编辑器"]')
      .frameLocator('iframe[title="draw.io"]')
      .locator(".geDiagramContainer"),
  ).toBeVisible();
  const state = await application.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
  );
  expect(state).toBe(true);
  await application.close();
});
