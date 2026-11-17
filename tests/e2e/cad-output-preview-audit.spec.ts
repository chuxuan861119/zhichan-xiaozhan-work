import sharp from "sharp";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD sidebar creation and output preview interaction audit", async ({ workbench }) => {
  test.setTimeout(150_000);
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
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  const source = workspace.locator(".drawing-sources");
  const newButton = source.getByRole("button", { name: "新建图纸", exact: true });
  const imported = source.getByRole("button", { name: "导入图纸", exact: true });
  expect((await newButton.boundingBox())!.y).toBeLessThan((await imported.boundingBox())!.y);
  await expect(workspace.locator(".drawing-header").getByText("新建图纸")).toHaveCount(0);
  await newButton.click();
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(canvas).toBeVisible();
  await expect(newButton).toBeEnabled({ timeout: 60_000 });
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1600"><rect width="1000" height="1600" fill="white"/><rect x="150" y="150" width="600" height="1300" fill="none" stroke="black" stroke-width="8"/><path d="M150 150L750 1450" stroke="black" stroke-width="8"/></svg>',
  );
  const buffer = await sharp(svg).png().toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "preview-audit.png", mimeType: "image/png", buffer });
  await expect(workspace.locator(".drawing-heading")).toContainText("preview-audit.png");
  await expect(imported).toBeEnabled({ timeout: 60_000 });
  await workspace.getByRole("button", { name: "适合窗口", exact: true }).click();
  await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  const points = await canvas.evaluate((element) => {
    const matrix = (element as SVGSVGElement).getScreenCTM()!;
    return [
      [100, 100],
      [800, 1500],
    ].map(([x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: p.x, y: p.y };
    });
  });
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
  await page.mouse.up();
  const previewButton = workspace.getByRole("button", { name: "预览成图", exact: true });
  await expect(previewButton).toBeEnabled();
  const started = Date.now();
  await previewButton.click();
  const dialog = page.getByRole("dialog", { name: "成图预览", exact: true });
  const image = dialog.getByAltText("取图导出预览");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await dialog.evaluate(async (el) => {
    await Promise.all(
      el
        .parentElement!.getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const geometry = () =>
    image.evaluate((el) => {
      const image = el.getBoundingClientRect();
      const pane = el.parentElement!.getBoundingClientRect();
      return {
        imageWidth: image.width,
        imageHeight: image.height,
        paneWidth: pane.width,
        paneHeight: pane.height,
        fits:
          image.top >= pane.top &&
          image.left >= pane.left &&
          image.right <= pane.right &&
          image.bottom <= pane.bottom,
      };
    });
  const initial = await geometry();
  expect(initial.fits).toBe(true);
  await expect(dialog).toHaveClass(/flowchart-export-dialog/);
  const optionsBox = (await dialog.locator(".flowchart-export-options").boundingBox())!;
  const previewBox = (await dialog.locator(".flowchart-export-preview").boundingBox())!;
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(optionsBox.x);
  const openMs = Date.now() - started;
  await page.screenshot({ path: test.info().outputPath("preview-initial.png") });
  await dialog.getByRole("button", { name: "重置预览", exact: true }).click();
  const fitted = await geometry();
  expect(fitted.fits).toBe(true);
  await dialog.getByRole("button", { name: "放大预览", exact: true }).click();
  const zoom = await dialog.getByLabel("预览缩放比例").textContent();
  const viewport = dialog.getByTestId("flowchart-image-preview-viewport");
  const box = (await viewport.boundingBox())!;
  const before = await image.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const after = (await image.boundingBox())!;
  expect(after.x - before!.x).toBeCloseTo(60, 0);
  expect(after.y - before!.y).toBeCloseTo(30, 0);
  await dialog.getByRole("button", { name: "缩小预览", exact: true }).click();
  const afterZoomOut = (await image.boundingBox())!;
  expect(afterZoomOut.x + afterZoomOut.width / 2).toBeCloseTo(after.x + after.width / 2, 0);
  expect(afterZoomOut.y + afterZoomOut.height / 2).toBeCloseTo(after.y + after.height / 2, 0);
  await page.setViewportSize({ width: 900, height: 650 });
  await dialog.getByRole("button", { name: "重置预览", exact: true }).click();
  expect((await geometry()).fits).toBe(true);
  const footer = await dialog.locator(".standard-dialog__footer").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(650);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole("button", { name: "实际尺寸（100%）", exact: true }).click();
  await expect(dialog.getByLabel("预览缩放比例")).toHaveText("100%");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(canvas).toBeFocused();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const focusAfterClose = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute("aria-label"),
  }));
  await previewButton.click();
  await expect(image).toBeVisible();
  await dialog.getByRole("button", { name: /关闭/ }).click();
  await expect(dialog).toBeHidden();
  await expect(canvas).toBeFocused();
  await previewButton.click();
  await expect(image).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(canvas).toBeFocused();
  await test.info().attach("audit", {
    body: JSON.stringify(
      { initial, fitted, openMs, zoom, afterPan: after, afterZoomOut, focusAfterClose },
      null,
      2,
    ),
    contentType: "application/json",
  });
  console.log(
    "PREVIEW_AUDIT",
    JSON.stringify({
      initial,
      fitted,
      openMs,
      zoom,
      afterPan: after,
      afterZoomOut,
      focusAfterClose,
    }),
  );
});
