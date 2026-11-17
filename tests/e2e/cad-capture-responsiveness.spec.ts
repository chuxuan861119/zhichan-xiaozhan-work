import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("CAD selection and consecutive labels stay responsive with a real CAD worker and persist on reopening", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("取图与连续标号验收");
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const open = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  };
  await open();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByLabel("选择图纸文件").setInputFiles({
    name: "capture.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile(resolve("tests/fixtures/cad/sample_AC1032.dwg")),
  });
  const label = workspace.getByRole("button", { name: "标号", exact: true });
  await expect(label).toBeEnabled({ timeout: 60_000 });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const box = (await canvas.boundingBox())!;
  const times: number[] = [];
  for (const tool of ["选择 / 移动", "圈选对象"]) {
    await workspace.getByRole("button", { name: tool, exact: true }).click();
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 350, box.y + 100, { steps: 4 });
    await page.mouse.move(box.x + 350, box.y + 350, { steps: 4 });
    if (tool === "圈选对象") await page.mouse.move(box.x + 100, box.y + 350, { steps: 4 });
    const started = Date.now();
    await page.mouse.up();
    await expect(canvas.locator("[data-region-outline]")).toHaveCount(0);
    await expect(label).toBeEnabled();
    times.push(Date.now() - started);
  }
  await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await canvas.press("Control+a");
  await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeEnabled();
  await label.click();
  for (let i = 0; i < 3; i++) {
    await canvas.click({ position: { x: 160 + i * 80, y: 200 } });
    await canvas.click({ position: { x: 160 + i * 80, y: 130 } });
    await expect(label).toBeEnabled();
    await expect(canvas.locator("[data-annotation]")).toHaveCount(i + 1);
  }
  await canvas.press("Control+z");
  await expect(canvas.locator("[data-annotation]")).toHaveCount(2, { timeout: 60_000 });
  await canvas.press("Control+Shift+z");
  await expect(canvas.locator("[data-annotation]")).toHaveCount(3, { timeout: 60_000 });
  await label.click();
  await canvas.press("Control+a");
  await expect(workspace.locator("[data-selected-annotation-count]")).toHaveText("已选中 3 个标号");
  await workspace.getByRole("button", { name: "水平对齐" }).click();
  const labelYs = () => canvas.locator("[data-annotation] text").evaluateAll((texts) =>
    texts.map((text) => Number(text.getAttribute("y"))),
  );
  await expect.poll(async () => {
    const positions = await labelYs();
    return Math.max(...positions) - Math.min(...positions);
  }).toBeLessThan(0.001);
  const alignedY = (await labelYs())[0]!;
  await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden({ timeout: 60_000 });
  await open();
  await expect(canvas.locator("[data-annotation]")).toHaveCount(3);
  await expect(canvas.locator("[data-annotation] text").first()).toHaveCSS("opacity", "1");
  await expect.poll(async () => (await labelYs()).every((y) => Math.abs(y - alignedY) < 0.001)).toBe(true);
  await expect(label).toBeEnabled({ timeout: 60_000 });
  await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await expect(workspace.locator('[data-cad-ready="true"]')).toBeVisible({ timeout: 60_000 });
  await canvas.press("Control+a");
  await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeEnabled();
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("img", { name: "取图导出预览", exact: true });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  expect(await preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const previewDialog = page.getByRole("dialog", { name: "成图预览" });
  const widthMm = await preview.evaluate((image: HTMLImageElement) => parseFloat(image.style.width));
  const sourceUrl = await preview.getAttribute("src");
  expect(await preview.evaluate((image: HTMLImageElement) => image.style.width)).toBe(`${widthMm}mm`);
  await expect(previewDialog.getByLabel("预览缩放比例")).toHaveText("100%");
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeCloseTo(widthMm * 96 / 25.4, 1);
  await previewDialog.getByRole("button", { name: "重置预览" }).click();
  await previewDialog.getByRole("button", { name: "放大预览", exact: true }).click();
  await previewDialog.getByRole("button", { name: "实际尺寸（100%）" }).click();
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeCloseTo(widthMm * 96 / 25.4, 1);
  await expect(preview).toHaveAttribute("src", sourceUrl!);
  await previewDialog.screenshot({ path: testInfo.outputPath("cad-actual-size-preview.png") });
  await page.getByRole("dialog", { name: "成图预览" }).getByRole("button", { name: "插入说明书附图" }).click();
  await expect(workspace.getByText(/已插入附图/)).toBeVisible({ timeout: 60_000 });
  await expect(workspace.getByRole("region", { name: "已插入附图" }).getByRole("button", { name: "定位图1" })).toBeVisible();
  const insertedWidth = await page.evaluate(async () => {
    const list = await window.patentApi.patents.list("active");
    if (!list.ok) throw Error(list.error.message);
    const opened = await window.patentApi.patents.open(list.value.find(p => p.name === "取图与连续标号验收")!.patentId);
    if (!opened.ok) throw Error(opened.error.message);
    return opened.value.patent.figures[0]!.widthMm;
  });
  expect(insertedWidth).toBe(widthMm);
  await testInfo.attach("capture-response-ms", {
    body: JSON.stringify(times),
    contentType: "application/json",
  });
  console.info(`Selection pointer-up to ready (rectangle/lasso): ${times.join(" / ")} ms`);
  await page.screenshot({ path: testInfo.outputPath("capture-and-labels.png") });
});
