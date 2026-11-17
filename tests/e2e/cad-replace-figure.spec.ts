import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

// This acceptance suite must never activate a native verification window.
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function settle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    await new Promise(requestAnimationFrame);
  });
}

async function select(page: Page, x: number, y: number, width: number, height: number) {
  await settle(page);
  const points = await page.getByRole("application", { name: "CAD标号画布" }).evaluate(
    (svg, rect) => {
      const matrix = (svg as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error("Canvas transform unavailable");
      return [
        new DOMPoint(rect.x, rect.y),
        new DOMPoint(rect.x + rect.width, rect.y + rect.height),
      ].map((p) => {
        const q = p.matrixTransform(matrix);
        return { x: q.x, y: q.y };
      });
    },
    { x, y, width, height },
  );
  const [start, end] = points;
  if (!start || !end) throw new Error("Selection endpoints missing");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

async function saved(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { patentApi: PatentApi }).patentApi;
    const list = await api.patents.list("active");
    if (!list.ok || !list.value[0]) throw new Error("Patent missing");
    const opened = await api.patents.open(list.value[0].patentId);
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.value.patent;
  });
}

test("CAD replacement compares real images, preserves figure identity and survives undo, redo and reopen", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("CAD替换验收");
    await create.getByRole("radio", { name: "实用新型" }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    const buffer = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="100" y="100" width="220" height="140" fill="none" stroke="black" stroke-width="3"/><circle cx="700" cy="500" r="100" fill="none" stroke="black" stroke-width="3"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await workspace
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "替换测试.png", mimeType: "image/png", buffer });
    await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
    await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
    await select(page, 70, 70, 290, 210);
    await expect(workspace.getByRole("button", { name: "替换附图", exact: true })).toBeDisabled();
    await workspace.getByRole("button", { name: "插入附图", exact: true }).click();
    await expect(workspace.locator("[data-published-figure]")).toHaveCount(1);
    await expect(workspace.getByRole("button", { name: "插入附图", exact: true })).toBeDisabled();
    await select(page, 70, 70, 290, 210);
    await workspace.getByRole("button", { name: "插入附图", exact: true }).click();
    await expect(workspace.locator("[data-published-figure]")).toHaveCount(2);
    await expect(workspace.getByRole("button", { name: "插入附图", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.getByRole("button", { name: "选择图2", exact: true }).click();
    const resize = page.getByRole("button", { name: "从右下角缩放图2", exact: true });
    for (let step = 0; step < 6; step += 1) await resize.press("Shift+ArrowLeft");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const before = await saved(page);
    const original = before.figures[1];
    if (!original) throw new Error("Second figure missing");
    expect(original.widthMm).toBeCloseTo(90, 1);
    await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
    await select(page, 570, 370, 270, 270);
    await workspace.getByRole("button", { name: "替换附图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "替换说明书附图", exact: true });
    await dialog.getByLabel("选择要替换的附图").selectOption(original.figureId);
    const confirm = dialog.getByRole("button", { name: "替换图 2", exact: true });
    await expect(confirm).toBeEnabled();
    await settle(page);
    await expect(dialog.getByRole("button", { name: "实际尺寸（100%）" })).toHaveCount(2);
    await expect(dialog.getByRole("img", { name: "当前选区成图预览" })).toHaveAttribute(
      "style",
      /width: 90mm/u,
    );
    await dialog.screenshot({ path: testInfo.outputPath("comparison.png") });
    const paneBoxes = await dialog.locator(".drawing-replace-pane").evaluateAll((panes) =>
      panes.map((pane) => {
        const r = pane.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    const [left, right] = paneBoxes;
    if (!left || !right) throw new Error("Comparison panes missing");
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(left.height).toBeCloseTo(right.height, 0);
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 560, height: 720 });
    await settle(page);
    const narrow = await dialog
      .locator(".drawing-replace-pane")
      .evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().y));
    expect(narrow[1]).toBeGreaterThan(narrow[0] ?? 0);
    await dialog.screenshot({ path: testInfo.outputPath("comparison-narrow.png") });
    await page.setViewportSize(originalViewport ?? { width: 1280, height: 900 });
    await settle(page);
    const preview = await dialog
      .getByRole("img", { name: "当前选区成图预览" })
      .evaluate(async (image) =>
        Array.from(
          new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer()),
        ),
      );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.locator(".standard-dialog-overlay:has(.drawing-replace-dialog)"),
    ).toHaveAttribute("data-motion", "exit");
    await expect(dialog).toBeHidden();
    expect((await saved(page)).figures).toEqual(before.figures);
    await workspace.getByRole("button", { name: "替换附图", exact: true }).click();
    await dialog.getByLabel("选择要替换的附图").selectOption(original.figureId);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(workspace.locator(".drawing-status")).toContainText("已替换说明书附图");
    const after = await saved(page);
    const replaced = after.figures[1];
    if (!replaced) throw new Error("Replaced figure missing");
    expect(after.figures).toHaveLength(2);
    expect(after.figures[0]).toEqual(before.figures[0]);
    expect(replaced).toMatchObject({
      figureId: original.figureId,
      widthMm: original.widthMm,
      rotationDeg: 0,
    });
    expect(replaced.assetId).not.toBe(original.assetId);
    expect(after.assets.some((asset) => asset.assetId === original.assetId)).toBe(true);
    expect(after.assets.find((asset) => asset.assetId === replaced.assetId)?.sha256).toBe(
      createHash("sha256").update(Uint8Array.from(preview)).digest("hex").toUpperCase(),
    );
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await saved(page)).figures).toEqual(before.figures);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await saved(page)).figures).toEqual(after.figures);
    await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
    await page.getByRole("button", { name: "关闭CAD替换验收", exact: true }).click();
    await page
      .getByRole("article", { name: "CAD替换验收", exact: true })
      .getByRole("button", { name: "更多操作" })
      .click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    expect((await saved(page)).figures).toEqual(after.figures);
  } finally {
    await app.close();
  }
});
