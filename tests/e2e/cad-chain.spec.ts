import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
import { begin, end } from "./helpers/cad-performance-probe.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("chain drive draws, grip previews without committing, exports, and ordinary tools remain usable", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("链传动验收");
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
  const panel = page.getByRole("region", { name: "CAD实体编辑" }),
    canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(panel.getByRole("button", { name: "链条", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  await panel.getByRole("button", { name: "链条", exact: true }).click();
  await canvas.click({ position: { x: 500, y: 450 } });
  await canvas.hover({ position: { x: 850, y: 450 } });
  await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
  await canvas.click({ position: { x: 850, y: 450 } });
  await expect(page.locator(".cad-instruction-card")).toContainText(
    "已保存。可继续绘图或选择对象。",
  );
  await canvas.press("Control+a");
  const grips = canvas.locator("[data-cad-chain-grip]");
  await expect(grips).toHaveCount(8);
  const settings = page.getByRole("region", { name: "链轮设置" });
  await expect(settings).toBeVisible();
  const before = Number(
    await settings.getByRole("spinbutton", { name: "中心距", exact: true }).inputValue(),
  );
  const box = await canvas.locator('[data-cad-chain-grip="2"]').boundingBox();
  if (!box) throw new Error("缺少轮心控制点");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.screenshot({ path: testInfo.outputPath("before-grip.png") });
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[role="application"]')
          ?.getAttribute("aria-label"),
      { x, y },
    ),
  ).toBe("CAD标号画布");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await begin(page, ".cad-gesture-preview");
  await page.mouse.move(x + 25, y + 15, { steps: 72 });
  const centerMetrics = await end(page, "chain center grip");
  await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
  await expect(settings.getByRole("spinbutton", { name: "中心距", exact: true })).toHaveValue(
    String(before),
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await settings.getByRole("spinbutton", { name: "中心距", exact: true }).inputValue()),
    )
    .toBeGreaterThan(before);
  const teethBefore = Number(
    await settings.getByRole("spinbutton", { name: "右轮齿数" }).inputValue(),
  );
  const wheelGrip = await canvas.locator('[data-cad-chain-grip="4"]').boundingBox();
  if (!wheelGrip) throw new Error("缺少轮径控制点");
  await page.mouse.move(wheelGrip.x + wheelGrip.width / 2, wheelGrip.y + wheelGrip.height / 2);
  await page.mouse.down();
  await begin(page, ".cad-gesture-preview");
  await page.mouse.move(wheelGrip.x + wheelGrip.width / 2, wheelGrip.y - 75, { steps: 72 });
  const teethMetrics = await end(page, "chain teeth grip");
  console.info(JSON.stringify({centerMetrics, teethMetrics}));
  await testInfo.attach("chain-grip-performance.json", {body: JSON.stringify({centerMetrics, teethMetrics}, null, 2), contentType:"application/json"});
  await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
  await expect(settings.getByRole("spinbutton", { name: "右轮齿数" })).toHaveValue(
    String(teethBefore),
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await settings.getByRole("spinbutton", { name: "右轮齿数" }).inputValue()),
    )
    .toBeGreaterThan(teethBefore);
  await page.screenshot({ path: testInfo.outputPath("chain-drive.png") });
  const file = join(workbench.root, "chain.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
  await page.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(workspace.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
    timeout: 60000,
  });
  expect(await readFile(file, "utf8")).toContain("PatentWorkbenchChain:1:");
  const chainOptions = panel.getByRole("button", { name: "链条选项", exact: true });
  // Export is at the bottom of the scrollable rail; finish scrolling before opening its menu.
  await chainOptions.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await chainOptions.click();
  await page.getByRole("menuitemradio", { name: "链轮", exact: true }).click();
  await canvas.click({ position: { x: 600, y: 600 } });
  await canvas.click({ position: { x: 640, y: 600 } });
  await expect(page.locator(".cad-instruction-card")).toContainText(
    "已保存。可继续绘图或选择对象。",
  );
  await canvas.press("Control+a");
  await expect(grips).toHaveCount(12);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
