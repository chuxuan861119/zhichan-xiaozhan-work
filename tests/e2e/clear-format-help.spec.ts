import type { Locator } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

test("clear-format help matches approved sizes and switches without changing documents", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const paintedWidth = async (panel: Locator) => {
      // A hidden Electron window advances compositor animations during capture.
      await page.screenshot();
      return (await panel.boundingBox())?.width;
    };
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("悬浮说明隔离验证");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    const trigger = page.getByRole("button", { name: "清除多余格式", exact: true });
    await expect(trigger).toBeVisible();
    const before = await page.locator(".tiptap").first().innerHTML();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Let the initial fit-to-window layout settle before starting a hover dwell.
    await page.screenshot();
    await page.waitForTimeout(300);
    const descriptionTrigger = page.locator(
      ".patent-global-function-rail-slot .claims-description-tool__toggle:visible",
    );
    await descriptionTrigger.hover();
    await expect(page.getByRole("dialog", { name: "说明书说明" })).toBeVisible();
    await descriptionTrigger.click();
    for (const [name, selector] of [
      ["发明内容", ".claims-description-tool__invention-action"],
      ["具体实施方式", ".claims-description-tool__embodiments-action"],
    ]) {
      await page.locator(`.claims-description-menu ${selector}:visible`).hover();
      const chapterPanel = page.getByRole("dialog", { name: `${name}说明` });
      await expect(chapterPanel).toBeVisible();
      await expect(chapterPanel).toContainText("一种支撑装置，包括底座(1)，其特征在于");
      expect((await chapterPanel.boundingBox())?.width).toBeCloseTo(520, 2);
      await chapterPanel.screenshot({ path: testInfo.outputPath(`${name}-detailed.png`) });
      await chapterPanel.getByRole("switch").click();
      await expect.poll(() => paintedWidth(chapterPanel)).toBeCloseTo(360, 2);
      await expect(chapterPanel.locator(".description-help__details")).toHaveCount(0);
      await chapterPanel.getByRole("switch").click();
      await page.keyboard.press("Escape");
    }
    expect(await page.locator(".tiptap").first().innerHTML()).toBe(before);
    await descriptionTrigger.click();
    await page
      .locator(
        ".patent-global-function-rail-slot .patent-book-tools__insert-dependent-claim:visible",
      )
      .hover();
    const dependentPanel = page.getByRole("dialog", { name: "插入从权说明" });
    await expect(dependentPanel).toBeVisible();
    expect((await dependentPanel.boundingBox())?.width).toBeCloseTo(560, 2);
    await expect(
      dependentPanel.getByRole("region", { name: "插入前示意" }).locator("em"),
    ).toHaveCount(0);
    await expect(dependentPanel.getByRole("region", { name: "插入后示意" })).toContainText(
      "根据权利要求3",
    );
    await dependentPanel.screenshot({ path: testInfo.outputPath("dependent-detailed.png") });
    await dependentPanel.getByRole("switch", { name: "详细介绍" }).click();
    await expect.poll(() => paintedWidth(dependentPanel)).toBeCloseTo(380, 2);
    await expect(dependentPanel.locator(".dependent-claim-help__details")).toHaveCount(0);
    await dependentPanel.screenshot({ path: testInfo.outputPath("dependent-compact.png") });
    expect(await page.locator(".tiptap").first().innerHTML()).toBe(before);
    await dependentPanel.getByRole("switch", { name: "详细介绍" }).click();
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.screenshot();
    await page.waitForTimeout(200);
    await page.mouse.move(400, 50);
    await trigger.hover();
    const panel = page.getByRole("dialog", { name: "清除多余格式说明" });
    await expect(panel).toBeVisible();
    const control = panel.getByRole("switch", { name: "详细介绍" });
    await expect(control).toBeChecked();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await panel.hover();
    await expect(panel).toBeVisible();
    const expanded = await panel.boundingBox();
    if (!expanded) throw new Error("Help panel is not visible");
    expect(expanded?.width).toBeCloseTo(680, 2);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(expanded.x).toBeGreaterThanOrEqual(8);
    expect(expanded.y).toBeGreaterThanOrEqual(40);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(viewport.width);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(viewport.height);
    await panel.screenshot({ path: testInfo.outputPath("detailed.png") });
    const middleWidth = await control.evaluate((button) => {
      (button as HTMLButtonElement).focus({ preventScroll: true });
      (button as HTMLButtonElement).click();
      return new Promise<number>((resolve) =>
        requestAnimationFrame(() => {
          const shell = button.closest(".clear-format-help") as HTMLElement;
          const animation = shell.getAnimations()[0];
          if (!animation) throw new Error("Missing size transition");
          animation.pause();
          animation.currentTime = 100;
          const width = shell.getBoundingClientRect().width;
          animation.play();
          resolve(width);
        }),
      );
    });
    expect(middleWidth).toBeGreaterThan(360);
    expect(middleWidth).toBeLessThan(680);
    await expect(control).not.toBeChecked();
    await expect(panel.locator(".comparison")).toHaveCount(0);
    await expect(panel.locator(".brand-corner img")).toBeVisible();
    await expect.poll(() => paintedWidth(panel)).toBeCloseTo(360, 2);
    await panel.screenshot({ path: testInfo.outputPath("compact.png") });
    expect(await page.locator(".tiptap").first().innerHTML()).toBe(before);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    for (const name of ["说明书", "说明书摘要"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await trigger.hover();
      await expect(panel).toBeVisible();
      await expect(control).not.toBeChecked();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const supplementTrigger = page.locator(
      ".patent-global-function-rail-slot .patent-book-tools__supplement-reference-numbers:visible",
    );
    await expect(supplementTrigger).toBeVisible();
    await supplementTrigger.hover();
    const supplementPanel = page.getByRole("dialog", { name: "增补编号说明" });
    await expect(supplementPanel).toBeVisible();
    await expect.poll(() => paintedWidth(supplementPanel)).toBeCloseTo(360, 2);
    await supplementPanel.getByRole("switch", { name: "详细介绍" }).click();
    await expect.poll(() => paintedWidth(supplementPanel)).toBeCloseTo(540, 2);
    await expect(supplementPanel).toContainText("附图标记已登记");
    await expect(
      supplementPanel.getByRole("region", { name: "增补后示意" }).locator("em"),
    ).toHaveCount(2);
    expect(await page.locator(".tiptap").first().innerHTML()).toBe(before);
    await supplementPanel.getByRole("switch", { name: "详细介绍" }).click();
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await trigger.hover();
    await expect(panel).toBeVisible();
    await control.click();
    await expect(control).toBeChecked();
    await expect(panel.locator(".comparison img")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1024, height: 760 });
    await page.screenshot();
    await page.waitForTimeout(200);
    const expandRail = page.getByRole("button", { name: "展开功能栏", exact: true });
    if (await expandRail.isVisible()) await expandRail.click();
    await trigger.hover();
    await expect(panel).toBeVisible();
    await panel.hover();
    await page.waitForTimeout(600);
    await expect(panel).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(panel).toHaveAttribute("data-function-rail-owner", /.+/);
    const quickTrigger = page
      .locator(".patent-global-function-rail-slot .patent-book-tools__problem-check-button:visible")
      .first();
    await expect(quickTrigger).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await quickTrigger.hover();
    const quickPanel = page.getByRole("dialog", { name: "本地检查说明" });
    await expect(quickPanel).toBeVisible();
    await expect(quickPanel).toContainText("文字、编号与标点等常见格式性问题");
    await expect(quickPanel.locator(".quick-check-help__flow")).toBeVisible();
    const quickExpanded = await quickPanel.boundingBox();
    expect(quickExpanded?.width).toBeCloseTo(580, 2);
    await quickPanel.getByRole("switch", { name: "详细介绍" }).click();
    await expect.poll(() => paintedWidth(quickPanel)).toBeCloseTo(400, 2);
    await expect(quickPanel.locator(".quick-check-help__details")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(quickPanel).toHaveCount(0);
  } finally {
    await app.close();
  }
});
