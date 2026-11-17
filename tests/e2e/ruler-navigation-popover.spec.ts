import type { Editor } from "@tiptap/core";
import { choosePaneBook, dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("ruler navigation adapts to dual columns, single and split views without overflowing", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("标尺导航验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.getByRole("textbox", { name: "编辑 说明书", exact: true }).evaluate((element) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: [
        "技术领域",
        ...Array.from({ length: 70 }, (_, i) => `第${i + 1}段，底座支撑连接杆。`),
        "具体实施方式",
      ].map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    });
  });
  const checkMenu = async (name: string, rightColumn = false) => {
    await page.screenshot();
    const ruler = page
      .getByRole("complementary", { name: "文档结构标尺", exact: true })
      .filter({ visible: true })
      .first();
    await expect(ruler).toHaveAttribute("data-mode", "compact");
    const rect = await ruler.boundingBox();
    if (!rect) throw new Error("missing ruler");
    const right = rightColumn
      ? await page.locator('.dual-column-layout .dual-column-paper[data-side="1"]').boundingBox()
      : null;
    const pointerX = right ? right.x + 15 : Math.max(2, rect.x + rect.width - 5);
    await page.mouse.move(pointerX, 250);
    // Explicit scrolling must not cancel the right-column hover and strand navigation.
    if (rightColumn) await page.mouse.wheel(0, 150);
    const menu = page.getByRole("navigation", { name: "文档导航" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "技术领域", exact: true })).toHaveCSS(
      "font-weight",
      "700",
    );
    await expect(menu.locator('[data-kind="description-paragraph"]').first()).toHaveCSS(
      "font-weight",
      "400",
    );
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("missing navigation bounds");
    expect(box.width).toBeCloseTo(136, 2);
    expect(box.height).toBeGreaterThan(viewport.height * 0.75);
    await expect(ruler.locator(".document-structure-ruler__label--wide").first()).toBeHidden();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeLessThanOrEqual(pointerX);
    expect(box.x + box.width).toBeGreaterThan(pointerX);
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) =>
            Boolean(document.elementFromPoint(x, y)?.closest(".ruler-navigation-popover")),
          { x: pointerX, y: 250 },
        ),
      )
      .toBe(true);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(box.y).toBeGreaterThan(100);
    expect(box.y + box.height).toBeLessThan(viewport.height);
    await menu.hover();
    await expect(menu).toBeVisible();
    const list = menu.locator(".ruler-navigation-popover__list");
    const before = await list.evaluate((element) => element.scrollTop);
    const documentScroll = await ruler.evaluate(
      (element) => element.closest(".editor-workspace")?.scrollTop,
    );
    await list.hover();
    await page.mouse.wheel(0, 150);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    expect(await ruler.evaluate((element) => element.closest(".editor-workspace")?.scrollTop)).toBe(
      documentScroll,
    );
    await page.screenshot({ path: testInfo.outputPath(`ruler-popover-${name}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  };
  const maximizePageZoom = async () => {
    // Hidden Electron needs a compositor frame after mode/window changes before
    // its measured zoom budget is authoritative. This never activates the OS window.
    await page.screenshot();
    for (let step = 0; step < 20; step++) {
      const plus = page.getByRole("button", { name: "放大", exact: true });
      if (await plus.isDisabled()) break;
      await plus.click();
      await page.screenshot();
    }
  };
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await maximizePageZoom();
  await checkMenu("columns");
  await checkMenu("columns-right", true);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toHaveCount(0);
  // Maximum page zoom releases the wide ruler before shrinking the document.
  await page.setViewportSize({ width: 1000, height: 1000 });
  await maximizePageZoom();
  const singleRuler = page
    .getByRole("complementary", { name: "文档结构标尺", exact: true })
    .filter({ visible: true });
  await expect(singleRuler).toHaveAttribute("data-mode", "compact");
  await expect(singleRuler.locator(".document-structure-ruler__label--wide").first()).toBeHidden();
  const singleBounds = await singleRuler.boundingBox();
  expect(singleBounds?.x).toBeGreaterThanOrEqual(0);
  await expect(page.getByRole("navigation", { name: "文档导航" })).toHaveCount(0);
  expect(
    await singleRuler.evaluate((element) => {
      const viewport = element.closest<HTMLElement>(".editor-workspace");
      if (!viewport) throw new Error("missing editor workspace");
      return viewport.scrollWidth - viewport.clientWidth;
    }),
  ).toBeLessThanOrEqual(1);
  await checkMenu("single");
  await page.getByRole("button", { name: "同屏双显", exact: true }).click();
  await expect(page.locator(".dual-document-pane")).toHaveCount(2);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await maximizePageZoom();
  await checkMenu("split");

  await choosePaneBook(page, "right", "标尺导航验收", "权利要求书");
  const rightPane = page.getByRole("region", { name: "右侧文档", exact: true });
  await rightPane
    .getByRole("textbox", { name: "编辑 权利要求书", exact: true })
    .evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
        type: "doc",
        content: Array.from({ length: 70 }, (_, i) => ({
          type: "paragraph",
          content: [{ type: "text", text: `${i + 1}. 一种装置，包括底座和支撑杆。` }],
        })),
      });
    });
  await page.mouse.move(2, 2);
  const rightRuler = rightPane.getByRole("complementary", { name: "文档结构标尺", exact: true });
  await expect(rightRuler).toHaveAttribute("data-mode", "compact");
  await page.screenshot();
  const rightBounds = await rightRuler.boundingBox();
  if (!rightBounds) throw new Error("missing right ruler");
  const workspace = rightPane.locator(".editor-workspace");
  const beforeScroll = await workspace.evaluate((element) => element.scrollTop);
  await page.mouse.move(rightBounds.x + rightBounds.width - 3, 250);
  await page.mouse.wheel(0, 150);
  const rightMenu = page.getByRole("navigation", { name: "文档导航" });
  await expect(rightMenu).toBeVisible();
  await expect(rightMenu.getByRole("button", { name: "权利要求 1", exact: true })).toBeVisible();
  expect(await workspace.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
  await page.screenshot({ path: testInfo.outputPath("ruler-popover-right-immediate-wheel.png") });
  await page.keyboard.press("Escape");
  await expect(rightMenu).toHaveCount(0);
});
