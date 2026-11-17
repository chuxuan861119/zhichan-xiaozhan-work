import { expect, test } from "./helpers/workbench.js";

test("illustrated IPC guide supports chapters, keyboard navigation and compact windows", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const welcome = page.getByRole("button", { name: "暂不创建", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "IPC数据中心", exact: true });
    await expect(dialog.getByRole("status")).toHaveCount(0, { timeout: 35000 });
    await dialog.getByRole("button", { name: "使用说明", exact: true }).click();
    const frame = page.frameLocator('iframe[title="IPC数据中心查询页面"]');
    const guide = frame.locator("#helpModal");
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("button", { name: "关闭使用说明" })).toBeFocused();
    const names = ["开始查询", "看懂结果", "复制与报告", "窗口操作"];
    for (const [i, name] of names.entries()) {
      await guide
        .getByRole("tab", { name: new RegExp(name) })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(guide.getByRole("tabpanel")).toHaveCount(1);
      await expect(guide.locator(`#guide-page-${i}`)).toBeVisible();
      expect(
        await guide.locator(".guide-shell").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      await guide.screenshot({ path: test.info().outputPath(`guide-${i + 1}.png`) });
    }
    await guide.getByRole("tab", { name: /窗口操作/ }).press("Home");
    await expect(guide.getByRole("tab", { name: /开始查询/ })).toBeFocused();
    await guide.getByRole("tab", { name: /开始查询/ }).press("ArrowRight");
    await expect(guide.locator("#guide-page-1")).toBeVisible();
    await dialog.evaluate((el) => {
      el.style.width = "480px";
      el.style.height = "360px";
    });
    await guide
      .getByRole("tab", { name: /开始查询/ })
      .evaluate((button: HTMLButtonElement) => button.click());
    expect(
      await guide.evaluate((el) => {
        const shell = el.querySelector(".guide-shell");
        const footer = el.querySelector(".guide-footer")?.getBoundingClientRect();
        if (!shell || !footer) return false;
        return (
          shell.scrollWidth <= shell.clientWidth + 1 &&
          footer.bottom <= innerHeight &&
          footer.top >= 0
        );
      }),
    ).toBe(true);
    await guide.screenshot({ path: test.info().outputPath("guide-compact.png") });
    await guide
      .getByRole("tab", { name: /窗口操作/ })
      .evaluate((button: HTMLButtonElement) => button.click());
    await guide
      .getByRole("button", { name: /开始使用/ })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(guide).toBeHidden();
    await expect(frame.locator("#classificationInput")).toBeFocused();
    expect(errors).toEqual([]);
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
      expect(await (await app.browserWindow(page)).evaluate((win) => win.isVisible())).toBe(false);
  } finally {
    await app.close();
  }
});
