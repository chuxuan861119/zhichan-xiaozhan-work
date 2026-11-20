import sharp from "sharp";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("detail figures retain their frame, separate the source marker, and clear selection after output", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1100 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("局部放大成图回归");
    await create.getByRole("radio", { name: "实用新型", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
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
    const panel = page.getByRole("region", { name: "CAD实体编辑" });
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const settled = () => expect(workspace).toHaveAttribute("data-cad-pending", "false");
    const saved = () =>
      page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) throw Error("Test patent missing");
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) throw Error(opened.error.message);
        return opened.value;
      });
    await panel.getByRole("button", { name: "矩形", exact: true }).click();
    await canvas.click({ position: { x: 220, y: 220 } });
    await canvas.click({ position: { x: 280, y: 280 } });
    await settled();
    await canvas.press("Escape");
    await panel.getByRole("button", { name: "局部放大", exact: true }).click();
    await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
    for (const [x, y] of [
      [250, 250],
      [310, 250],
      [400, 150],
      [600, 400],
    ] as const)
      await canvas.click({ position: { x, y } });
    await settled();
    await canvas.press("Escape");
    const baseline = (await saved()).patent.drawingProjects[0]!;
    const detail = baseline.detailViews![0]!;
    const object = baseline.cad!.objects!.find((o) => o.id === detail.id)!;
    const selectCircle = async (source = false) => {
      const circle = workspace.locator(
        `[data-detail="${detail.id}"] ${source ? "[data-detail-source-hit]" : 'circle[data-detail-part="content"]'}`,
      );
      const p = await circle.evaluate((node) => {
        const c = node as SVGCircleElement;
        const d = c.r.baseVal.value / Math.sqrt(2);
        const p = new DOMPoint(c.cx.baseVal.value + d, c.cy.baseVal.value + d).matrixTransform(
          c.getScreenCTM()!,
        );
        return { x: p.x, y: p.y };
      });
      await page.mouse.click(p.x, p.y);
      await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeEnabled();
    };
    const deselected = () =>
      expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeDisabled();
    await selectCircle();
    await expect(
      workspace.locator(
        `[data-detail="${detail.id}"] [data-detail-part="marker"] circle[stroke="black"]`,
      ),
    ).toHaveCount(1);
    await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
    await expect(preview).toBeVisible();
    await deselected();
    await preview.getByRole("button", { name: "插入说明书附图", exact: true }).click();
    await expect(preview).toBeHidden();
    await deselected();
    const inserted = await saved();
    const firstFigure = inserted.patent.figures[0]!;
    const region = inserted.patent.drawingProjects[0]!.regions.find(
      (r) => r.figureId === firstFigure.figureId,
    )!;
    expect(object.frame!.every((h) => region.cadHandles!.includes(h))).toBe(true);
    expect(object.source!.some((h) => region.cadHandles!.includes(h))).toBe(false);
    const bytes = await page.evaluate(
      async ({ sessionId, assetId }) => {
        const result = await window.patentApi.assets.getPreview(sessionId, assetId);
        if (!result.ok) throw Error(result.error.message);
        return Array.from(result.value);
      },
      { sessionId: inserted.sessionId, assetId: firstFigure.assetId },
    );
    const { data, info } = await sharp(Buffer.from(bytes))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // The lower semicircle must exist in the actual JPEG, not just its overlay.
    const radius = info.width / 2 - 2;
    let hits = 0;
    for (let step = 1; step < 12; step++) {
      const angle = (Math.PI * step) / 12;
      let ink = false;
      for (let offset = -5; offset <= 5; offset++) {
        const x = Math.round(info.width / 2 + (radius + offset) * Math.cos(angle));
        const y = Math.round(info.height - radius - 2 + (radius + offset) * Math.sin(angle));
        if (
          x >= 0 &&
          y >= 0 &&
          x < info.width &&
          y < info.height &&
          data[(y * info.width + x) * info.channels]! < 150
        )
          ink = true;
      }
      if (ink) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(9);
    const asset = inserted.patent.assets.find((a) => a.assetId === firstFigure.assetId)!;
    expect((firstFigure.widthMm * asset.heightPx) / asset.widthPx).toBeLessThanOrEqual(200.1);

    await selectCircle(true);
    await expect(
      workspace.locator(
        `[data-detail="${detail.id}"] circle[data-detail-part="content"][stroke="black"]`,
      ),
    ).toHaveCount(1);
    await workspace.getByRole("button", { name: "插入附图", exact: true }).click();
    await expect(workspace.locator(".drawing-status")).toContainText("已插入说明书附图");
    await expect.poll(async () => (await saved()).patent.figures.length).toBe(2);
    await deselected();
    const sourceInserted = (await saved()).patent;
    expect(sourceInserted.figures).toHaveLength(2);
    const sourceRegion = sourceInserted.drawingProjects[0]!.regions.find(
      (r) => r.figureId === sourceInserted.figures[1]!.figureId,
    )!;
    expect(object.source!.every((h) => sourceRegion.cadHandles!.includes(h))).toBe(true);
    expect(
      [...(object.body ?? []), ...(object.frame ?? [])].some((h) =>
        sourceRegion.cadHandles!.includes(h),
      ),
    ).toBe(false);

    await selectCircle();
    await workspace.getByRole("button", { name: "替换附图", exact: true }).click();
    const replace = page.getByRole("dialog", { name: "替换说明书附图", exact: true });
    await expect(replace.getByRole("button", { name: "替换图 1", exact: true })).toBeEnabled();
    await replace.getByRole("button", { name: "替换图 1", exact: true }).click();
    await expect(replace).toBeHidden();
    await deselected();
    const replaced = (await saved()).patent;
    expect(replaced.figures).toHaveLength(2);
    expect(replaced.figures[0]!.figureId).toBe(firstFigure.figureId);
    expect(replaced.figures[0]!.assetId).not.toBe(firstFigure.assetId);
    // Figure insertion/replacement belongs to the description-drawings history,
    // separately from native CAD geometry edits.
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await saved()).patent.figures[0]!.assetId)
      .toBe(firstFigure.assetId);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await saved()).patent.figures[0]!.assetId)
      .toBe(replaced.figures[0]!.assetId);
  } finally {
    // This isolated fixture owns only test data. Do not wait on a save/close
    // confirmation after a failed assertion, which would hide that assertion.
    await app
      .evaluate(({ app }) => {
        setTimeout(() => app.exit(0), 0);
      })
      .catch(() => undefined);
    await app.close();
  }
});
