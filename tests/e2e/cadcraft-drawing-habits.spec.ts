import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("CAD records mouse-down points and continues lines through smooth checkpoints", async ({
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
  await expect(
    workspace.getByText("图纸已导入。选中线条、图形和标号后即可预览或插入附图。", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const settle = async () => {
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 60_000 },
    );
  };
  await settle();
  await expect(panel.getByRole("button", { name: "绘图修改", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 150);
  await page.mouse.down();
  await page.waitForTimeout(130);
  await page.mouse.move(box.x + 260, box.y + 210, { steps: 4 });
  const preview = canvas.locator('[data-cad-preview="line"] polyline').first();
  await expect(preview).toBeVisible();
  const original = await preview.getAttribute("points");
  const endpoint = await preview.evaluate((element) => {
    const line = element as SVGPolylineElement;
    const point = line.points.getItem(1).matrixTransform(line.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  // Observe every painted frame as the native checkpoint replaces the source SVG.
  await page.evaluate(() => {
    const state = { running: true, missing: 0 };
    (window as unknown as { cadPaintProbe: typeof state }).cadPaintProbe = state;
    const sample = () => {
      if (!state.running) return;
      if (!document.querySelector(".drawing-vector-preview img")) state.missing++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.up();
  await settle();
  await page.mouse.move(box.x + 350, box.y + 250);
  await expect(preview).toBeVisible();
  const continuation = await preview.evaluate((element) => {
    const line = element as SVGPolylineElement;
    const point = line.points.getItem(0).matrixTransform(line.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  expect(continuation.x).toBeCloseTo(endpoint.x, 0);
  expect(continuation.y).toBeCloseTo(endpoint.y, 0);
  await canvas.click({ position: { x: 350, y: 250 } });
  await settle();
  await page.mouse.move(box.x + 440, box.y + 330);
  await expect(preview).toBeVisible();
  const second = await preview.getAttribute("points");
  expect(second?.split(" ")[0]).not.toBe(original?.split(" ")[0]);
  await canvas.click({ position: { x: 440, y: 330 } });
  await settle();
  await canvas.press("Enter");
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settle();
  await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await settle();
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await page.mouse.move(box.x + 180, box.y + 400);
  await page.mouse.down();
  await page.waitForTimeout(130);
  await page.mouse.move(box.x + 240, box.y + 420, { steps: 4 });
  await expect(canvas.locator('[data-cad-preview="circle"] circle')).toBeVisible();
  await page.mouse.up();
  await settle();
  await canvas.press(" ");
  await expect(panel.getByRole("button", { name: "圆", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await canvas.press("Escape");
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await page.mouse.move(box.x + 370, box.y + 400);
  await page.mouse.down();
  await page.waitForTimeout(130);
  await page.mouse.move(box.x + 480, box.y + 460, { steps: 4 });
  await expect(canvas.locator('[data-cad-preview="rectang"] polyline')).toBeVisible();
  await page.mouse.up();
  await settle();
  const beforePolyline = await workspace.locator("[data-cad-detail-live-scene]").innerHTML();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 500 } });
  await canvas.click({ position: { x: 200, y: 520 } });
  await canvas.press("Escape");
  await settle();
  await expect.poll(() => workspace.locator("[data-cad-detail-live-scene]").innerHTML()).not.toBe(beforePolyline);
  await expect(canvas).toHaveAttribute("data-cad-pickbox", "true");
  const gaps = await page.evaluate(() => {
    const state = (window as unknown as { cadPaintProbe: { running: boolean; missing: number } })
      .cadPaintProbe;
    state.running = false;
    return state.missing;
  });
  expect(gaps).toBe(0);
});
