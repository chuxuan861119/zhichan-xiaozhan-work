import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD tools guide object picking, base transforms, native previews and line undo without a command bar", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
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
  const drawLine = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await button("直线").click();
    await canvas.click({ position: a });
    await canvas.click({ position: b });
    await canvas.press("Enter");
    await settle();
  };
  await drawLine({ x: 150, y: 150 }, { x: 350, y: 250 });
  await expect(button("移动")).toBeEnabled();
  await button("移动").click();
  await canvas.click({ position: { x: 250, y: 200 } });
  await canvas.press("Enter");
  await expect(workspace.locator(".cad-instruction-card")).toContainText("选择操作基点");
  await canvas.click({ position: { x: 100, y: 100 } });
  await canvas.click({ position: { x: 110, y: 110 } });
  await settle();
  await button("旋转").click();
  await expect(workspace.locator(".cad-instruction-card")).toContainText("选择旋转基点");
  await canvas.click({ position: { x: 100, y: 100 } });
  const rect = await canvas.boundingBox();
  if (!rect) throw new Error("CAD canvas unavailable");
  await page.mouse.move(rect.x + 100, rect.y + 80);
  await expect(canvas.locator('[data-cad-preview="rotate"] polyline')).not.toHaveCount(0);
  await canvas.press("Escape");
  await button("缩放").click();
  await canvas.click({ position: { x: 100, y: 100 } });
  await page.mouse.move(rect.x + 140, rect.y + 100);
  await expect(canvas.locator('[data-cad-preview="scale"] polyline')).not.toHaveCount(0);
  await canvas.press("Escape");
  await canvas.press("Escape");
  await drawLine({ x: 150, y: 350 }, { x: 300, y: 350 });
  await drawLine({ x: 300, y: 350 }, { x: 300, y: 450 });
  await button("圆角").click();
  await canvas.hover({ position: { x: 300, y: 350 } });
  await canvas.click({ position: { x: 300, y: 350 } });
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(1);
  await settle();
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  await button("直线").click();
  await canvas.click({ position: { x: 100, y: 500 } });
  await canvas.click({ position: { x: 200, y: 500 } });
  await canvas.click({ position: { x: 250, y: 450 } });
  await canvas.press("Control+z");
  await settle();
  await expect(button("直线")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", {name:"闭合",exact:true})).toBeEnabled();
  await canvas.press("c");
  await settle();
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await expect(page.getByRole("textbox", { name: /命令栏|CAD命令/ })).toHaveCount(0);
});
