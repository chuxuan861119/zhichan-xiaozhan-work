import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { APPLICATION_NAME } from "../../src/shared/branding.js";
import { choosePaneBook, enterDualView, expect, swapDualPanes, test } from "./helpers/workbench.js";

async function createTestPatent(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const welcome = page.getByRole("dialog", { name: `欢迎使用${APPLICATION_NAME}`, exact: true });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
  await expect(welcome).toBeHidden();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("对象工具条验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  return page.getByRole("textbox", { name: "编辑 说明书", exact: true });
}

test("table context icon tools operate continuously and stay within the active dual pane", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    const editor = await createTestPatent(page);
    await editor.evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
        "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p>表格之外</p>",
      );
    });
    const table = editor.locator("table");
    await table.locator("td").first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "文档右键菜单", exact: true });
    const tools = menu.getByRole("toolbar", { name: "表格工具" });
    await expect(tools).toBeVisible();
    expect(await tools.getByRole("button").count()).toBe(15);
    expect(await tools.locator("button svg").count()).toBe(15);
    await tools.getByRole("button", { name: "删除列", exact: true }).hover();
    const hint = page.getByRole("tooltip");
    await expect(hint).toHaveText("删除列");
    await expect(hint).toHaveClass(/tool-action-tooltip--compact/);
    await expect(tools.getByRole("button", { name: "删除列", exact: true })).not.toHaveAttribute(
      "title",
    );
    const hintBounds = await hint.boundingBox();
    if (!hintBounds) throw new Error("按钮名称未显示");
    expect(hintBounds.x).toBeGreaterThanOrEqual(8);
    expect(hintBounds.x + hintBounds.width).toBeLessThanOrEqual(1592);
    expect(await tools.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await tools.getByRole("button", { name: "下方插入行", exact: true }).click();
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(tools).toBeVisible();
    await tools.getByRole("button", { name: "删除行", exact: true }).click();
    await expect(table.locator("tr")).toHaveCount(2);
    await tools.getByRole("button", { name: "右侧插入列", exact: true }).click();
    await expect(table.locator("td")).toHaveCount(6);
    await tools.getByRole("button", { name: "删除列", exact: true }).click();
    await expect(table.locator("td")).toHaveCount(4);
    await page.screenshot({ path: test.info().outputPath("table-tools.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await enterDualView(page);
    await choosePaneBook(page, "right", "对象工具条验收", "权利要求书");
    const leftBefore = await page
      .getByRole("region", { name: "右侧文档" })
      .getByRole("textbox", { name: "编辑 权利要求书", exact: true })
      .evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await swapDualPanes(page);
    const rightPane = page.getByRole("region", { name: "右侧文档" });
    const right = rightPane.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await right.locator("td").last().click({ button: "right" });
    await tools.getByRole("button", { name: "单元格居中", exact: true }).click();
    await expect(tools.getByRole("button", { name: "单元格居中", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const bounds = await rightPane.boundingBox();
    const rect = await menu.boundingBox();
    if (!bounds || !rect) throw new Error("右侧菜单未显示");
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    const left = page
      .getByRole("region", { name: "左侧文档" })
      .getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    expect(
      await left.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.getJSON(),
      ),
    ).toEqual(leftBefore);
  } finally {
    await app.close();
  }
});

test("image context icon tools preserve the bitmap and layout through rotation and resizing", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    await app.evaluate(
      ({ dialog }, path) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        });
      },
      join(process.cwd(), "tests", "fixtures", "images", "sample.png"),
    );
    const page = await app.firstWindow();
    const editor = await createTestPatent(page);
    await editor.evaluate((element) =>
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
        "<p>图片工具条测试</p>",
      ),
    );
    await page.getByRole("button", { name: "插入图片", exact: true }).click();
    const image = editor.locator(".patent-figure img");
    await expect(image).toBeVisible();
    await image.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "文档右键菜单", exact: true });
    const tools = menu.getByRole("toolbar", { name: "图片工具" });
    await expect(tools).toBeVisible();
    expect(await tools.locator("button svg").count()).toBe(10);
    await tools.getByRole("button", { name: "图片右对齐", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("图片右对齐");
    const readImage = () =>
      editor.evaluate((element) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        return e.state.doc.nodeAt(e.state.selection.from)?.attrs;
      });
    const original = await readImage();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const frame = editor.locator(".patent-figure > .image-selection-frame");
    const initial = await frame.boundingBox();
    if (!initial) throw new Error("图片未显示");
    for (const label of ["图片左对齐", "图片居中", "图片右对齐"]) {
      await tools.getByRole("button", { name: label, exact: true }).click();
      const motion = await frame.evaluate((element) =>
        element.getAnimations().map((animation) => ({
          property: (animation as CSSTransition).transitionProperty,
          duration: animation.effect?.getTiming().duration,
        })),
      );
      expect(
        motion.some((animation) => animation.property === "left" && Number(animation.duration) > 0),
      ).toBe(true);
      await frame.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const aligned = await frame.boundingBox();
      if (!aligned) throw new Error("图片对齐后未显示");
      expect(aligned.width).toBeCloseTo(initial.width, 2);
      expect(aligned.height).toBeCloseTo(initial.height, 2);
      expect(aligned.y).toBeCloseTo(initial.y, 2);
      expect((await readImage())?.assetId).toBe(original?.assetId);
    }
    const wrapper = await editor.locator(".patent-figure").boundingBox();
    const aligned = await frame.boundingBox();
    if (!wrapper || !aligned) throw new Error("图片对齐布局未显示");
    expect(aligned.x + aligned.width).toBeCloseTo(wrapper.x + wrapper.width, 1);
    const interrupted = await frame.evaluate(async (element) => {
      const tools = document.querySelector('[role="toolbar"][aria-label="图片工具"]');
      const left = tools?.querySelector<HTMLButtonElement>('[aria-label="图片左对齐"]');
      const right = tools?.querySelector<HTMLButtonElement>('[aria-label="图片右对齐"]');
      if (!left || !right) throw new Error("图片对齐工具未显示");
      left.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const before = element.getBoundingClientRect().x;
      right.click();
      const after = element.getBoundingClientRect().x;
      // React node-view updates commit on the next frame after synthetic clicks.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
      return { jump: Math.abs(after - before), right: element.getBoundingClientRect().right };
    });
    expect(interrupted.jump).toBeLessThan(1);
    expect(interrupted.right).toBeCloseTo(wrapper.x + wrapper.width, 1);
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = "true";
    });
    await tools.getByRole("button", { name: "图片左对齐", exact: true }).click();
    expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0);
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = "false";
    });
    await tools.getByRole("button", { name: "向右旋转90°", exact: true }).click();
    const rotated = await readImage();
    expect(rotated?.assetId).toBe(original?.assetId);
    expect(rotated?.rotationDeg).toBe(90);
    await tools.getByRole("button", { name: "缩小图片", exact: true }).click();
    expect((await readImage())?.widthMm).toBeCloseTo(Math.max(10, rotated?.widthMm - 10), 5);
    await tools.getByRole("button", { name: "嵌入型", exact: true }).click();
    await expect(editor.locator(".patent-inline-figure")).toHaveCount(1);
    await expect(tools.getByRole("button", { name: "图片右对齐", exact: true })).toBeDisabled();
    await tools.getByRole("button", { name: "独立成行", exact: true }).click();
    await expect(editor.locator(".patent-figure")).toHaveCount(1);
    expect((await readImage())?.assetId).toBe(original?.assetId);
    await page.screenshot({ path: test.info().outputPath("image-tools.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.state.doc.descendants((node, position) => {
        if (node.isTextblock && node.textContent.includes("图片工具条测试")) {
          e.commands.setTextSelection({ from: position + 1, to: position + 4 });
          return false;
        }
      });
    });
    await editor.press("Shift+F10");
    await menu.getByRole("button", { name: "加粗", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("加粗");
    await expect(page.getByRole("tooltip")).toHaveClass(/tool-action-tooltip--compact/);
    await page.screenshot({ path: test.info().outputPath("text-tool-hint.png") });
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});
