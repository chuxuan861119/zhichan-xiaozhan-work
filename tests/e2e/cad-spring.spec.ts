import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
import { begin, end } from "./helpers/cad-performance-probe.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
for (const extension of [false, true]) {
  test(`${extension ? "extension" : "compression"} spring draws in CAD, exports editable DXF and leaves ordinary tools usable`, async ({
    workbench,
  }, testInfo) => {
    test.setTimeout(180_000);
    const app = await workbench.launch();
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("弹簧示意图验收");
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
    await expect(panel.getByRole("button", { name: "弹簧选项", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await panel.getByRole("button", { name: "弹簧选项", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: extension ? "拉伸弹簧" : "压缩弹簧", exact: true })
      .click();
    const settings = page
      .getByRole("dialog")
      .getByRole("region", { name: extension ? "拉伸弹簧设置" : "弹簧设置" });
    await settings.getByRole("spinbutton", { name: "弹簧线径" }).fill("2");
    await settings.getByRole("spinbutton", { name: "弹簧线径" }).press("Enter");
    await canvas.click({ position: { x: 550, y: 500 } });
    await canvas.click({ position: { x: extension ? 750 : 650, y: 500 } });
    await canvas.hover({ position: { x: extension ? 650 : 600, y: extension ? 470 : 450 } });
    await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
    await canvas.click({ position: { x: extension ? 650 : 600, y: extension ? 470 : 450 } });
    await expect(settings).toBeHidden();
    await canvas.click({ position: { x: extension ? 650 : 600, y: 500 } });
    const selected = page
      .getByRole("dialog", { name: "弹簧设置" })
      .getByRole("region", { name: "弹簧设置" });
    await expect(selected).toBeVisible();
    await expect(canvas.locator(".cad-selection-overlay rect")).toHaveCount(2);
    const widthGrip = canvas.locator('.cad-selection-overlay polygon[fill="white"]');
    await expect(widthGrip).toHaveCount(1);
    await expect(widthGrip).toBeVisible();
    const widthBefore = Number(
      await selected.getByRole("spinbutton", { name: "弹簧宽度" }).inputValue(),
    );
    const gripBox = await widthGrip.boundingBox();
    if (!gripBox) throw new Error("弹簧宽度控制点未显示");
    const gripX = gripBox.x + gripBox.width / 2;
    const gripY = gripBox.y + gripBox.height / 2;
    await page.mouse.move(gripX, gripY);
    await page.mouse.down();
    await begin(page, ".cad-gesture-preview");
    await page.mouse.move(gripX, gripY - 20, { steps: 72 });
    const metrics = await end(page, extension ? "extension spring width grip" : "compression spring width grip");
    console.info(JSON.stringify(metrics));
    await testInfo.attach("spring-grip-performance.json", {body:JSON.stringify(metrics,null,2),contentType:"application/json"});
    await page.mouse.up();
    await expect
      .poll(async () =>
        Number(await selected.getByRole("spinbutton", { name: "弹簧宽度" }).inputValue()),
      )
      .toBeGreaterThan(widthBefore);
    await selected.getByRole("spinbutton", { name: "弹簧圈数" }).fill("8");
    await selected.getByRole("button", { name: "应用", exact: true }).click();
    await expect(selected.getByRole("spinbutton", { name: "弹簧圈数" })).toHaveValue("8");
    await selected.getByRole("spinbutton", { name: "弹簧圈数" }).fill("7");
    await selected.getByRole("spinbutton", { name: "弹簧长度" }).fill(extension ? "82.7" : "88.25");
    await selected.getByRole("spinbutton", { name: "弹簧宽度" }).fill(extension ? "20" : "45");
    await selected.getByRole("spinbutton", { name: "弹簧线径" }).fill(extension ? "2.3" : "4.5");
    await selected.getByRole("button", { name: "应用", exact: true }).click();
    await expect(selected.getByRole("spinbutton", { name: "弹簧圈数" })).toHaveValue("7");
    await expect(selected.getByRole("spinbutton", { name: "弹簧长度" })).toHaveValue(
      extension ? "82.7" : "88.3",
    );
    await expect(selected.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
    await expect(page.getByText("已保存", { exact: true }).last()).toBeVisible();
    await canvas.click({ position: { x: 800, y: 300 } });
    await page.screenshot({ path: testInfo.outputPath("cad-spring.png") });
    const file = join(workbench.root, "spring.dxf");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, file);
    await page.getByRole("button", { name: "导出 DXF", exact: true }).click();
    await expect(workspace.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const dxf = await readFile(file, "utf8");
    expect(
      dxf.includes(extension ? "PatentWorkbenchExtensionSpring:2:" : "PatentWorkbenchSpring:5:"),
    ).toBe(true);
    expect(dxf).toContain('"turns":7');
    expect(dxf).toContain("LWPOLYLINE");
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}
