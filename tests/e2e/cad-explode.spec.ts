import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD EXPLODE supports both selection orders, independent parts, cancellation and repeat", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
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
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 60_000 },
  );

  const explode = panel.getByRole("button", { name: "分解", exact: true });
  await expect(explode).toBeEnabled();
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 200, y: 200 } });
  await canvas.click({ position: { x: 400, y: 320 } });
  await expect(workspace.getByRole("button", { name: "撤销标号编辑", exact: true })).toBeEnabled();
  await canvas.press("Escape");
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(8);
  const view = await canvas.getAttribute("viewBox");
  await explode.click();
  await expect(workspace.getByRole("status", { name: /^选择对象：已分解 1/ })).toBeVisible();
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(0);
  expect(await canvas.getAttribute("viewBox")).toBe(view);
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(3);
  await canvas.press("Escape");
  // Right-click repeats EXPLODE, then Enter confirms a newly selected simple line.
  await canvas.click({ button: "right", position: { x: 550, y: 350 } });
  await expect(explode).toHaveAttribute("aria-pressed", "true");
  await canvas.click({ position: { x: 300, y: 200 } });
  await canvas.press("Enter");
  await expect(workspace.getByRole("status", { name: /无法分解/ })).toBeVisible();
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(8);
  await canvas.press("Escape");
  await explode.click();
  await canvas.click({ position: { x: 300, y: 200 } });
  await canvas.press("Escape");
  await expect(explode).toHaveAttribute("aria-pressed", "false");
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(0);
  await explode.click();
  await canvas.click({ position: { x: 300, y: 200 } });
  await canvas.click({ button: "right", position: { x: 550, y: 350 } });
  await expect(workspace.getByRole("status", { name: /^选择对象：已分解 1/ })).toBeVisible();
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(0);
  await page.screenshot({ path: "test-results/cad-explode-result.png" });
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
