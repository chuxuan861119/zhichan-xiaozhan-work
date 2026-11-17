import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD right-click completes commands, confirms picks and repeats the last native or patent tool", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const line = panel.getByRole("button", { name: "直线", exact: true });
  // The transient tool settings occupy the upper-left of the canvas.
  const rightClick = () => canvas.click({ button: "right", position: { x: 500, y: 500 } });
  await expect(line).toBeEnabled({ timeout: 60_000 });
  await line.click();
  await canvas.click({ position: { x: 150, y: 150 } });
  await canvas.click({ position: { x: 350, y: 150 } });
  await rightClick();
  await expect(line).toHaveAttribute("aria-pressed", "false");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await rightClick();
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await expect(canvas.locator('[data-cad-preview="line"] polyline')).toHaveCount(0);
  await rightClick();
  const move = panel.getByRole("button", { name: "移动", exact: true });
  await move.click();
  await rightClick();
  await expect(move).toHaveAttribute("aria-pressed", "false");
  await rightClick();
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await canvas.click({ position: { x: 250, y: 150 } });
  await rightClick();
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await expect(workspace.locator(".cad-instruction-card")).toContainText("选择操作基点");
  await rightClick();
  await expect(move).toHaveAttribute("aria-pressed", "false");

  const detail = panel.getByRole("button", { name: "局部放大", exact: true });
  await detail.click();
  await expect(detail).toHaveAttribute("aria-pressed", "true");
  await rightClick();
  await expect(detail).toHaveAttribute("aria-pressed", "false");
  await rightClick();
  await expect(detail).toHaveAttribute("aria-pressed", "true");
  await rightClick();
  const label = page.getByRole("button", { name: "标号", exact: true });
  await label.click();
  await rightClick();
  await expect(label).toHaveAttribute("aria-pressed", "false");
  await rightClick();
  await expect(label).toHaveAttribute("aria-pressed", "true");
  await rightClick();
  await line.click();
  await rightClick();
  await rightClick();
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await expect(detail).toHaveAttribute("aria-pressed", "false");

  await rightClick();
  const text = panel.getByRole("button", { name: "文字", exact: true });
  await text.click();
  await canvas.click({ position: { x: 200, y: 300 } });
  await page.getByRole("textbox", { name: "画布文字", exact: true }).fill("右键完成文字");
  await rightClick();
  await expect(page.getByRole("textbox", { name: "画布文字", exact: true })).toBeHidden();
  await expect(text).toHaveAttribute("aria-pressed", "false");
  await rightClick();
  await expect(text).toHaveAttribute("aria-pressed", "true");
  await rightClick();

  await canvas.click({ position: { x: 250, y: 150 } });
  const array = panel.getByRole("button", { name: "阵列", exact: true });
  await array.click();
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await rightClick();
  await expect(array).toHaveAttribute("aria-pressed", "false");
  await rightClick();
  await expect(array).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
