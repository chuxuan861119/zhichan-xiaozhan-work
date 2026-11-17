import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("CAD drafts, grips, groups and precise picking remain coherent after checkpoints", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
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
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  const settle = async () => {
    await expect(button("直线")).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 60_000 },
    );
  };
  await settle();
  await button("直线").click();
  await canvas.click({ position: { x: 150, y: 150 } });
  await canvas.click({ position: { x: 350, y: 250 } });
  await settle();
  await panel.getByRole("button", { name: "样条曲线", exact: true }).click();
  await canvas.click({ position: { x: 120, y: 330 } });
  await canvas.click({ position: { x: 220, y: 330 } });
  await expect(page.getByRole("button", { name: "完成绘制（2 点）", exact: true })).toBeEnabled();
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成绘制（0 点）", exact: true })).toBeDisabled();
  await canvas.press("Enter");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await canvas.click({ position: { x: 250, y: 200 } });
  await expect(workspace.getByText("已选择 1 个对象。", { exact: true })).toBeVisible();
  const grips = canvas.locator('g[pointer-events="none"][stroke="#007aff"] circle');
  const before = await grips.first().boundingBox();
  expect(before).not.toBeNull();
  const start = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Stay outside both the line and the polar tracking snap apertures.
  await page.mouse.move(start.x + 35, start.y + 80, { steps: 5 });
  await page.mouse.up();
  await expect(workspace.getByText("已保存。可继续绘图或选择对象。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await settle();
  const after = await grips.first().boundingBox();
  // Native pointer coordinates quantize to CSS pixels.
  expect(Math.abs(after!.x - before!.x - 35)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.y - before!.y - 80)).toBeLessThanOrEqual(1);
  await button("编组").click();
  await settle();
  await expect(button("取消编组")).toBeEnabled();
  await button("取消编组").click();
  await settle();
  await expect(button("取消编组")).toBeDisabled();
  await expect(workspace.getByText("精确坐标输入", { exact: true })).toHaveCount(0);
  await canvas.click({ position: { x: 500, y: 300 } });
  await expect(
    workspace.getByText("点击框选的另一角；从右向左为交叉选择。Esc 取消。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "圆弧选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "三点", exact: true }).click();
  await expect(workspace.locator(".cad-instruction-card")).toContainText("圆弧起点、经过点、终点");
  await canvas.click({ position: { x: 150, y: 150 } });
  await canvas.click({ position: { x: 250, y: 220 } });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 350, box.y + 150);
  await expect
    .poll(async () => {
      const points = await canvas
        .locator('[data-cad-preview="arc"] polyline')
        .first()
        .getAttribute("points");
      return points?.trim().split(/\s+/u).length ?? 0;
    })
    .toBeGreaterThan(10);
  await canvas.press("Escape");
});
