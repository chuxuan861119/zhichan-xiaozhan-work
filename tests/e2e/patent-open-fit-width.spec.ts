import { writeFile } from "node:fs/promises";
import { expect, test } from "./helpers/workbench.js";

test("opening a patent keeps the original page width, including reopening from the library", async ({
  workbench,
}, testInfo) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1450, height: 900 });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("打开时适配宽度回归");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const metrics = () =>
    page.locator(".patent-page-with-rail:visible").evaluate((e) => {
      const frame = e.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
      const rail = e.querySelector<HTMLElement>(":scope > .patent-global-function-rail-slot");
      if (!frame || !rail) return { gap: Infinity, docked: "pending", width: 0, scale: 0 };
      const bounds = e.getBoundingClientRect();
      // The ruler occupies a reserved grid track, including its necessary side gap.
      const rulerReservation = Number.parseFloat(getComputedStyle(e).gridTemplateColumns) || 0;
      return {
        gap:
          bounds.width -
          (rail.getBoundingClientRect().right -
            frame.getBoundingClientRect().left +
            rulerReservation),
        docked: rail.dataset.layout,
        width: frame.getBoundingClientRect().width,
        scale: frame.getBoundingClientRect().width / frame.offsetWidth,
      };
    });
  const expectFitted = async () => {
    await expect.poll(async () => (await metrics()).docked).toBe("docked");
    await expect.poll(async () => (await metrics()).scale).toBeCloseTo(1, 2);
    await expect.poll(async () => (await metrics()).gap).toBeGreaterThan(100);
  };
  await expectFitted();
  await expect.poll(async () => (await metrics()).docked).toBe("docked");
  const fitted = (await metrics()).width;
  await page.setViewportSize({ width: 1920, height: 900 });
  await expectFitted();
  await expect.poll(async () => (await metrics()).width).toBeCloseTo(fitted, 1);
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await expect.poll(async () => (await metrics()).width).toBeLessThan(fitted - 50);
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect.poll(async () => (await metrics()).width).toBeLessThan(fitted - 50);
  await page.getByRole("tab", { name: "专利库", exact: true }).click();
  const card = page.getByRole("article", { name: "打开时适配宽度回归" });
  await card.getByRole("button", { name: "更多操作" }).click();
  await card.getByRole("menuitem", { name: "继续编辑" }).click();
  await expectFitted();
  await expect.poll(async () => (await metrics()).docked).toBe("docked");
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Test window is missing");
    // Hidden capture needs the compositor to present the final layout after DOM measurements.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return (await window.webContents.capturePage(undefined, { stayHidden: true }))
      .toPNG()
      .toString("base64");
  });
  await writeFile(testInfo.outputPath("fit-width.png"), Buffer.from(png, "base64"));
});
