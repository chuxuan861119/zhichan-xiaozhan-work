import { expect, test } from "./helpers/workbench.js";

test("column resize preserves its zoom basis and controls follow the actual remaining room", async ({
  workbench,
}, testInfo) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列宽度联动验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  const width = () =>
    layout.evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.getPropertyValue("--column-paper-width")),
    );
  await expect(layout).toHaveAttribute("data-column-rail-space", "fits");
  const initial = await width();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(layout).toHaveAttribute("data-column-rail-space", "constrained");
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const viewport = element.closest(".editor-workspace") as HTMLElement;
        return viewport.scrollWidth - viewport.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+-");
  await expect(layout).toHaveAttribute("data-column-rail-space", "fits");
  await expect(
    layout.locator(
      ':scope > .patent-global-function-rail-slot[data-layout="docked"][data-expanded="true"] .patent-global-function-rail',
    ),
  ).toBeVisible();
  await expect
    .poll(() =>
      layout.evaluate((element) =>
        (element as HTMLElement).style.getPropertyValue("--column-ruler-width"),
      ),
    )
    .toBe("76px");
  const smaller = await width();
  expect(smaller).toBeLessThan(initial);
  for (const viewportWidth of [1718, 1719, 2200]) {
    await page.setViewportSize({ width: viewportWidth, height: 1000 });
    await expect.poll(width).toBeCloseTo(smaller, 0);
  }
  await page.keyboard.press("Control+0");
  await expect
    .poll(() =>
      layout.evaluate(
        (element) =>
          (element.parentElement?.clientWidth ?? 0) - element.getBoundingClientRect().width,
      ),
    )
    .toBeLessThan(2);
  await expect(layout).toHaveAttribute("data-column-position", "0");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+=");
  await expect(page.getByRole("button", { name: "放大", exact: true })).toBeDisabled();
  await expect(layout).toHaveAttribute("data-column-rail-space", "constrained");
  await expect(layout).toHaveAttribute("data-column-position", "0");
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const viewport = element.closest(".editor-workspace") as HTMLElement;
        return viewport.scrollWidth - viewport.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("column-max-fit.png") });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveCount(0);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveAttribute("data-column-rail-space", "fits");
});
