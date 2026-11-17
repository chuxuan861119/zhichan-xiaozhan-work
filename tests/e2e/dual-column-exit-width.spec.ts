import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("leaving columns retains the visible page width instead of stale single zoom", async ({
  workbench,
}) => {
  test.setTimeout(120000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列退出宽度回归");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Opening now fits the window; explicitly establish this test's 100% baseline.
  await page.getByRole("button", { name: /缩放 .*点击重置/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "缩小", exact: true }).click();
  const frame = page.locator(".patent-page-with-rail > .patent-page-zoom-frame");
  await expect.poll(() => frame.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(600);
  const before = await frame.evaluate((e) => e.getBoundingClientRect().width);
  await page.setViewportSize({ width: 2100, height: 1100 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  await page.setViewportSize({ width: 2100, height: 1100 });
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await expect
    .poll(() => frame.evaluate((e) => e.getBoundingClientRect().width))
    .toBeGreaterThan(before + 30);
  const columnWidth = await frame.evaluate((e) => e.getBoundingClientRect().width);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toHaveCount(0);
  await expect
    .poll(async () =>
      Math.abs((await frame.evaluate((e) => e.getBoundingClientRect().width)) - columnWidth),
    )
    .toBeLessThan(5);
  // A constrained column uses a fitted scale rather than its displayed 100% value.
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 800 });
  for (let step = 0; step < 10; step++) await page.keyboard.press("Control+-");
  await expect.poll(() => frame.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(350);
  const fittedWidth = await frame.evaluate((e) => e.getBoundingClientRect().width);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toHaveCount(0);
  await expect
    .poll(async () =>
      Math.abs((await frame.evaluate((e) => e.getBoundingClientRect().width)) - fittedWidth),
    )
    .toBeLessThan(5);
  // A below-50% fitted scale must not jump up when the user asks to zoom out.
  await page.keyboard.press("Control+-");
  await expect
    .poll(async () =>
      Math.abs((await frame.evaluate((e) => e.getBoundingClientRect().width)) - fittedWidth),
    )
    .toBeLessThan(5);
  await page.keyboard.press("Control+=");
  await expect
    .poll(async () =>
      Math.abs((await frame.evaluate((e) => e.getBoundingClientRect().width)) - fittedWidth - 79.4),
    )
    .toBeLessThan(5);
  // The temporary fitted size is not sent to settings as an invalid preference.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await (
          window as unknown as { patentApi: PatentApi }
        ).patentApi.settings.read();
        return result.ok ? result.value.zoomPercent : null;
      }),
    )
    .toBe(50);
});
