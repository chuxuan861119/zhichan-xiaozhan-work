import type { Locator } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function requireBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("标号未出现在 CAD 画布中。");
  return box;
}

test("CAD label keeps its visual width after placement and aligns while an existing label is dragged", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const label = workspace.getByRole("button", { name: "标号", exact: true });
  await expect(label).toBeEnabled({ timeout: 60_000 });
  await label.click();
  const box = await requireBox(canvas);
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
  await page.mouse.click(at(200, 300).x, at(200, 300).y);
  await page.mouse.move(at(200, 230).x, at(200, 230).y);
  const previewGlyph = canvas.locator(
    '[data-drawing-preview="label"] [data-label-native-glyph] path',
  );
  await expect(previewGlyph.first()).toBeVisible({ timeout: 60_000 });
  const previewBox = await requireBox(canvas.locator("[data-label-native-glyph]"));
  const previewWidth = previewBox.width;
  await page.mouse.click(at(200, 230).x, at(200, 230).y);
  await expect(canvas.locator("[data-annotation]")).toHaveCount(1);
  const first = canvas.locator("[data-annotation]").first();
  const firstId = await first.getAttribute("data-annotation");
  const native = workspace.locator(`[data-cad-label="${firstId}"] path`);
  await expect.poll(() => native.count(), { timeout: 60_000 }).toBeGreaterThan(1);
  const nativeWidth = await workspace
    .locator(`[data-cad-label="${firstId}"] path[fill]:not([fill="none"])`)
    .evaluateAll((paths) => {
      const boxes = paths.map((path) => path.getBoundingClientRect());
      return (
        Math.max(...boxes.map((rect) => rect.right)) - Math.min(...boxes.map((rect) => rect.left))
      );
    });
  expect(Math.abs(nativeWidth - previewWidth) / previewWidth).toBeLessThan(0.02);

  await page.mouse.click(at(360, 300).x, at(360, 300).y);
  await page.mouse.click(at(360, 230).x, at(360, 230).y);
  await expect(canvas.locator("[data-annotation]")).toHaveCount(2);
  await label.click();
  const second = canvas.locator("[data-annotation]").last();
  const secondText = second.locator("text");
  const secondId = await second.getAttribute("data-annotation");
  const secondNative = workspace.locator(`[data-cad-label="${secondId}"] path`);
  await expect.poll(() => secondNative.count(), { timeout: 60_000 }).toBeGreaterThan(1);
  const firstBefore = await native.evaluateAll((paths) =>
    paths.map((path) => ({
      d: path.getAttribute("d"),
      fill: path.getAttribute("fill"),
      stroke: path.getAttribute("stroke"),
      width: path.getBoundingClientRect().width,
    })),
  );
  const secondGlyphBox = await requireBox(
    workspace.locator(`[data-cad-label="${secondId}"] path[fill]:not([fill="none"])`),
  );
  const secondGlyphWidth = secondGlyphBox.width;
  const originalLabelX = Number(await secondText.getAttribute("x"));
  const secondBox = await requireBox(secondText);
  await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    secondBox.x + secondBox.width / 2 - 120,
    secondBox.y + secondBox.height / 2,
    { steps: 4 },
  );
  const guideCount = await canvas.locator("[data-label-align-guide]").count();
  const draggedGlyph = canvas.locator("[data-label-drag-preview] [data-label-glyph-shift] path");
  await expect(draggedGlyph.first()).toBeVisible();
  const draggedWidth = (await requireBox(draggedGlyph)).width;
  expect(Math.abs(draggedWidth - secondGlyphWidth) / secondGlyphWidth).toBeLessThan(0.02);
  const firstDuring = await native.evaluateAll((paths) =>
    paths.map((path) => ({
      d: path.getAttribute("d"),
      fill: path.getAttribute("fill"),
      stroke: path.getAttribute("stroke"),
      width: path.getBoundingClientRect().width,
    })),
  );
  expect(firstDuring).toEqual(firstBefore);
  await page.mouse.up();
  expect(guideCount).toBeGreaterThan(0);
  await expect.poll(() => native.count()).toBeGreaterThan(1);
  expect(
    await native.evaluateAll((paths) =>
      paths.map((path) => ({
        d: path.getAttribute("d"),
        fill: path.getAttribute("fill"),
        stroke: path.getAttribute("stroke"),
        width: path.getBoundingClientRect().width,
      })),
    ),
  ).toEqual(firstDuring);
  await expect
    .poll(
      async () =>
        (
          await workspace
            .locator(`[data-cad-label="${secondId}"] path[fill]:not([fill="none"])`)
            .boundingBox()
        )?.width ?? 0,
    )
    .toBeGreaterThan(0);
  const placedWidth = (
    await requireBox(workspace.locator(`[data-cad-label="${secondId}"] path[fill]:not([fill="none"])`))
  ).width;
  expect(Math.abs(placedWidth - draggedWidth) / draggedWidth).toBeLessThan(0.02);
  const movedLabelX = Number(await secondText.getAttribute("x"));
  expect(movedLabelX).toBeLessThan(originalLabelX);
  await canvas.press("Control+z");
  await expect
    .poll(async () => Number(await secondText.getAttribute("x")))
    .toBeCloseTo(originalLabelX, 3);
  await canvas.press("Control+Shift+z");
  await expect
    .poll(async () => Number(await secondText.getAttribute("x")))
    .toBeCloseTo(movedLabelX, 3);
  await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await expect
    .poll(async () =>
      Number(await canvas.locator(`[data-annotation="${secondId}"] text`).getAttribute("x")),
    )
    .toBeCloseTo(movedLabelX, 3);
});
