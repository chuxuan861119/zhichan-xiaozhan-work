import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("editable CAD creates geometry, checkpoints it and survives reopening", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill("CAD实体编辑验收");
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(
    workspace.getByText("图纸已导入。选中线条、图形和标号后即可预览或插入附图。", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await canvas.click({ position: { x: 150, y: 150 } });
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 350, bounds.y + 250);
  await expect(canvas.locator('[data-cad-preview="line"] polyline').first()).toBeVisible();
  await canvas.click({ position: { x: 350, y: 250 } });
  await expect(
    workspace.getByText("指定下一点；Enter / 空格完成，Esc 结束。", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await canvas.press("Escape");
  await canvas.click({ position: { x: 250, y: 200 } });
  await expect(workspace.getByText("已选择 1 个对象。", { exact: true })).toBeVisible();
  await canvas.press("Escape");
  await expect(workspace.getByText("已取消选择。拖动或点击两角框选。", { exact: true })).toBeVisible();
  await page.mouse.move(bounds.x + 80, bounds.y + 80);
  await page.mouse.down();
  // A drag is intentionally distinguished from click jitter by a 120 ms hold.
  await page.waitForTimeout(150);
  await page.mouse.move(bounds.x + 380, bounds.y + 280, { steps: 8 });
  await expect(canvas.locator('[data-cad-preview="window"] .cad-window-contained')).toBeVisible();
  await page.mouse.up();
  await expect(workspace.getByText("已选择 1 个对象。", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "移动", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 100 } });
  await page.mouse.move(bounds.x + 120, bounds.y + 120);
  await expect(canvas.locator('[data-cad-preview="move"] polyline').first()).toBeVisible();
  await canvas.click({ position: { x: 120, y: 120 }, button: "right" });
  await expect(
    workspace.getByText("点击或框选追加选择，Shift 移除选择；右键重复上个工具，Esc 清除选择。", { exact: true }),
  ).toBeVisible();
  await expect(canvas.locator('[data-cad-preview="move"]')).toHaveCount(0);
  await canvas.press("Delete");
  await expect(workspace.getByText("已保存。可继续绘图或选择对象。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  const target = join(workbench.root, "editable.dwg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole("button", { name: "导出 DWG", exact: true }).click();
  await expect(workspace.getByText("已导出 DWG 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect((await readFile(target)).subarray(0, 6).toString()).toBe("AC1032");
  await panel.getByRole("button", { name: "样条曲线", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 320 } });
  await canvas.click({ position: { x: 200, y: 320 } });
  await expect(page.getByRole("button", { name: "完成绘制（2 点）", exact: true })).toBeEnabled();
  await page.locator(".drawing-viewport").evaluate((element) => {
    const observer = new MutationObserver(() => {
      if (!element.querySelector(".drawing-vector-preview"))
        (element as HTMLElement).dataset.cadBaseMissing = "true";
    });
    observer.observe(element, { childList: true, subtree: true });
  });
  await canvas.press("Enter");
  await expect(workspace.getByText("已保存。可继续绘图或选择对象。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await expect(page.locator(".drawing-viewport")).not.toHaveAttribute(
    "data-cad-base-missing",
    "true",
  );
  await panel.evaluate((element) => {
    const body = element.closest<HTMLElement>(".patent-global-function-rail__body");
    if (body) body.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath("ux-after.png") });
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await app.close();
  const again = await workbench.launch();
  const reopened = await again.firstWindow();
  await dismissWorkbenchWelcome(reopened);
  const safety = reopened.getByRole("button", { name: "稍后设置", exact: true });
  if (await safety.isVisible()) await safety.click();
  await reopened.getByText("CAD实体编辑验收", { exact: true }).first().dblclick();
  await reopened.getByRole("button", { name: "插入", exact: true }).click();
  await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const restored = reopened.getByRole("region", { name: "CAD标号", exact: true });
  await expect(restored.getByRole("button", { name: "新图纸.dxf", exact: true })).toBeVisible();
  const openRail = reopened.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if ((await openRail.isVisible()) && (await openRail.getAttribute("aria-expanded")) !== "true")
    await openRail.click();
  await expect(reopened.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  // Re-export through the real restored checkpoint, not a retained worker session.
  const restoredTarget = join(workbench.root, "restored.dxf");
  await again.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, restoredTarget);
  const closeSafety = reopened.getByRole("button", { name: "暂时关闭数据安全提示", exact: true });
  if (await closeSafety.isVisible()) await closeSafety.click();
  await reopened.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(restored.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await readFile(restoredTarget, "utf8")).toMatch(/\bLINE\b/u);
});
