import type { Page } from "@playwright/test";
import { enterDualView, expect, selectDualPane, test } from "./helpers/workbench.js";

async function prepare(page: Page, columns: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("功能栏显示策略回归");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.setViewportSize({ width: columns ? 2200 : 1400, height: 1000 });
  if (columns) {
    await page.getByRole("button", { name: "双列显示", exact: true }).click();
    await expect(page.locator(".dual-column-layout")).toHaveAttribute(
      "data-column-rail-space",
      "fits",
    );
  }
  await page.mouse.move(2, 2);
}

function railSlot(page: Page) {
  return page.locator('.patent-global-function-rail-slot[data-book-kind="description"]');
}

test("dual-column rail repeatedly recovers at its original width without shrinking either page", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await prepare(page, true);
  await expect(railSlot(page)).toHaveAttribute("data-expanded", "true");
  const pageWidth = () =>
    page
      .locator(".dual-column-layout > .patent-page-zoom-frame")
      .evaluate((frame) => frame.getBoundingClientRect().width);
  const original = await pageWidth();
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.setViewportSize({ width: 2100, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "false");
    await page.setViewportSize({ width: 2200, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "true");
    await expect(railSlot(page)).toHaveAttribute("data-layout", "docked");
    expect(Math.abs((await pageWidth()) - original)).toBeLessThanOrEqual(1);
  }
});

for (const columns of [false, true]) {
  test(`manually closed rail automatically recovers with enough space (${columns ? "columns" : "single"})`, async ({
    workbench,
  }) => {
    const app = await workbench.launchAllowMultipleInstances();
    const page = await app.firstWindow();
    await prepare(page, columns);
    const wide = columns ? 2200 : 1400;
    const narrow = columns ? 2100 : 1000;
    await page.setViewportSize({ width: narrow, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "false");
    await page.getByRole("button", { name: "展开功能栏", exact: true }).click();
    await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
    await page.mouse.move(2, 2);
    await page.setViewportSize({ width: wide, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "true");
    await expect(railSlot(page)).toHaveAttribute("data-layout", "docked");
    await page.setViewportSize({ width: narrow, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "false");
    await page.setViewportSize({ width: wide, height: 1000 });
    await expect(railSlot(page)).toHaveAttribute("data-expanded", "true");
  });
}

test("a manually closed dual-pane rail recovers independently when its pane widens", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await prepare(page, false);
  await enterDualView(page);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await selectDualPane(page, "left");
  for (let step = 0; step < 20; step++) await page.keyboard.press("Control+-");
  await page.mouse.move(2, 2);
  const pane = page.getByRole("region", { name: "左侧文档", exact: true });
  const rail = pane.locator(".patent-global-function-rail-slot");
  await expect(rail).toHaveAttribute("data-expanded", "true");
  await page.setViewportSize({ width: 1366, height: 1000 });
  await expect(rail).toHaveAttribute("data-expanded", "false");
  await pane.getByRole("button", { name: "展开功能栏", exact: true }).click();
  await pane.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await page.mouse.move(2, 2);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await expect(rail).toHaveAttribute("data-expanded", "true");
  await expect(rail).toHaveAttribute("data-layout", "docked");
});
