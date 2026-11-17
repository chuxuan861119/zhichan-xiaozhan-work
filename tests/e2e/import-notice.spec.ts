import { expect, test } from "./helpers/workbench.js";

test("first-use import notices fit the window and cancel without importing", async ({
  workbench,
}, testInfo) => {
  const profile = await workbench.launchProfile("import-notices");
  try {
    const page = await profile.application.firstWindow();
    const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library).toBeVisible();
    if (await welcome.isVisible()) {
      await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
      await expect(welcome).toBeHidden();
    }
    for (const [menu, title, format] of [
      ["导入专利压缩包", "压缩包导入须知", "zip"],
      ["导入 PATDOC", "PATDOC 导入须知", "patdoc"],
      ["导入 DOCX", "DOCX 导入须知", "docx"],
    ] as const) {
      await library.getByRole("button", { name: "导入", exact: true }).click();
      await page.getByRole("menuitem", { name: menu }).click();
      const notice = page.getByRole("dialog", { name: title });
      await expect(notice).toBeVisible();
      // Wait for the actual entry animation before capturing a hidden Electron window.
      await notice.evaluate(async (element) => {
        await Promise.all(
          element
            .parentElement!.getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        );
      });
      const geometry = await notice.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const body = element.querySelector(".standard-dialog__body")!;
        return {
          top: box.top,
          bottom: box.bottom,
          right: box.right,
          height: window.innerHeight,
          width: window.innerWidth,
          overflow: body.scrollHeight - body.clientHeight,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(40);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: testInfo.outputPath(`${format}-notice.png`),
        animations: "disabled",
      });
      await notice.getByRole("button", { name: "取消", exact: true }).click();
      await expect(notice).toHaveCount(0);
      expect(
        await page.evaluate(
          (value) => localStorage.getItem(`patent-workbench:import-notice:${value}:v1`),
          format,
        ),
      ).toBeNull();
    }
    await expect(page.getByRole("main", { name: "专利编辑区" })).toHaveCount(0);
  } finally {
    await profile.application.close();
  }
});
