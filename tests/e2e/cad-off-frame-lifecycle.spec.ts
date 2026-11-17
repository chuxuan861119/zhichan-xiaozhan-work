import sharp from "sharp";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("off-frame geometry remains aligned through save, reopen, view changes and history", async ({ workbench }) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("radio", { name: "实用新型", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const open = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  };
  await open();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = ws.getByRole("application", { name: "CAD标号画布" });
  const saved = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
    await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
    await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled();
  };
  await saved();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 250, box.y + 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 250, box.y + 500, { steps: 12 });
  await page.mouse.up({ button: "middle" });
  await expect(canvas).toHaveCSS("transform", "none");
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 230, y: 160 } });
  await canvas.click({ position: { x: 430, y: 280 } });
  await saved();
  await canvas.press("Escape");

  const alignment = async (stage: string) => {
    await canvas.press("Escape");
    await page.mouse.move(10, 10);
    const clip = { x: box.x + 50, y: box.y + 40, width: 650, height: 550 };
    const black = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    await canvas.press("Control+a");
    await expect(ws.locator(".cad-selection-overlay")).toBeAttached();
    const blue = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    await sharp(black.data, { raw: black.info }).png().toFile(test.info().outputPath(`${stage}-black.png`));
    await sharp(blue.data, { raw: blue.info }).png().toFile(test.info().outputPath(`${stage}-blue.png`));
    const { width, height, channels } = blue.info;
    let points = 0, aligned = 0;
    for (let y = 3; y < height - 3; y++) for (let x = 3; x < width - 3; x++) {
      const i = (y * width + x) * channels;
      if (blue.data[i]! > 80 || blue.data[i + 1]! < 70 || blue.data[i + 1]! > 190 || blue.data[i + 2]! < 200) continue;
      points++;
      let found = false;
      for (let dy = -3; dy <= 3 && !found; dy++) for (let dx = -3; dx <= 3; dx++) {
        const j = ((y + dy) * width + x + dx) * channels;
        if (black.data[j]! < 200 && black.data[j + 1]! < 200 && black.data[j + 2]! < 200) { found = true; break; }
      }
      if (found) aligned++;
    }
    expect(points, stage).toBeGreaterThan(100);
    expect(aligned / points, stage).toBeGreaterThan(0.97);
  };
  await alignment("saved off-frame rectangle");
  const savedView = await canvas.getAttribute("viewBox");
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await open();
  await saved();
  const pan = await canvas.evaluate((el, savedView) => {
    const svg = el as SVGSVGElement;
    const old = savedView!.split(" ").map(Number);
    const current = svg.viewBox.baseVal;
    const matrix = svg.getScreenCTM()!;
    return { x: (current.x - old[0]!) * matrix.a, y: (current.y - old[1]!) * matrix.d };
  }, savedView);
  await page.mouse.move(box.x + 250, box.y + 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 250 + pan.x, box.y + 100 + pan.y, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  await expect(canvas).toHaveCSS("transform", "none");
  await alignment("reopened off-frame rectangle");
  await ws.getByRole("button", { name: "放大图纸", exact: true }).click();
  await alignment("zoomed rectangle");
  await panel.getByRole("button", { name: "移动", exact: true }).click();
  await canvas.click({ position: { x: 300, y: 300 } });
  await canvas.click({ position: { x: 340, y: 330 } });
  await saved();
  await alignment("moved rectangle");
  await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await saved();
  await alignment("undo");
  await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await saved();
  await alignment("redo");
  await ws.getByRole("button", { name: "适合窗口", exact: true }).click();
  await expect.poll(() => ws.locator(".cad-selection-overlay").evaluate(el => {
    const selection = (el as unknown as SVGGraphicsElement).getBoundingClientRect();
    const viewport = document.querySelector('[aria-label="CAD标号画布"]')!.getBoundingClientRect();
    return selection.top >= viewport.top && selection.bottom <= viewport.bottom &&
      selection.left >= viewport.left && selection.right <= viewport.right;
  })).toBe(true);
  await ws.getByRole("button", { name: "预览成图", exact: true }).click();
  const image = page.getByRole("dialog", { name: "成图预览" }).getByAltText("取图导出预览");
  await expect(image).toBeVisible();
  expect(await image.evaluate(async (el) => { const img = el as HTMLImageElement; await img.decode(); return img.naturalWidth / img.naturalHeight; })).toBeCloseTo(200 / 120, 1);
});
