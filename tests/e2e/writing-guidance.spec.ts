import { expect, test } from "./helpers/workbench.js";

test("writing guidance locates tools without resizing or editing the document", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect(welcome).toBeHidden();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("快速工具教程测试");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const safety = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await safety.isVisible()) await safety.click();
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
          animation.finish();
      }
    });
    await page.locator(".patent-global-function-rail").first().waitFor({ state: "visible" });
    const editor = page.locator(".tiptap").filter({ visible: true }).first();
    await expect(editor).toBeVisible();
    let previousBounds = "";
    let stableFrames = 0;
    await expect
      .poll(
        async () => {
          const bounds = JSON.stringify(await editor.boundingBox());
          stableFrames = bounds === previousBounds ? stableFrames + 1 : 0;
          previousBounds = bounds;
          return stableFrames;
        },
        { intervals: [150, 150, 150, 150] },
      )
      .toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: "test-results/guidance-before.png", animations: "disabled" });
    const before = await editor.boundingBox();
    const text = await editor.textContent();
    const dismissTour = page.getByRole("button", { name: "跳过", exact: true });
    if (await dismissTour.isVisible()) await dismissTour.click();
    await page.getByRole("button", { name: "快速工具教程", exact: true }).click();
    await page.getByRole("button", { name: "查看原有撰写路线", exact: true }).click();
    await page.getByRole("button", { name: "撰写权利要求", exact: true }).click();
    await page.getByRole("button", { name: "给部件登记编号", exact: true }).click();
    await page.getByRole("button", { name: "带我操作", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续写作", exact: true })).toBeVisible();
    await expect(page.locator(".writing-guidance-ring")).toBeVisible();
    await page.screenshot({ path: "test-results/guidance-after.png" });
    expect(await editor.boundingBox()).toEqual(before);
    expect(await editor.textContent()).toEqual(text);
    await page.keyboard.press("Escape");
    await expect(page.locator(".writing-guidance-card")).toHaveCount(0);
    await page.getByRole("button", { name: "快速工具教程", exact: true }).click();
    await page.getByRole("button", { name: "查看原有撰写路线", exact: true }).click();
    await expect(page.getByText("从当前文档开始", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/writing-guidance-desktop.png" });
    await page.setViewportSize({ width: 900, height: 700 });
    await expect
      .poll(async () => {
        const card = await page.locator(".writing-guidance-card").boundingBox();
        return card ? card.x + card.width : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(900);
    await page.screenshot({ path: "test-results/writing-guidance-narrow.png" });
    await page.getByText("其他写作任务", { exact: true }).click();
    await page.getByRole("button", { name: "完善说明书", exact: true }).click();
    await page.getByRole("button", { name: "直接完善说明书", exact: true }).click();
    await page.getByRole("button", { name: "带我操作", exact: true }).click();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("button", { name: "继续写作", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.locator(".writing-guidance-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});
