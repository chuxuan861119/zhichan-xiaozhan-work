import type { Editor } from "@tiptap/core";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { expect, test } from "./helpers/workbench.js";

test("column wheel motion is smooth, synchronized and interruptible", async ({ workbench }) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列滚轮验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.evaluate((element) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 80 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `${index + 1}. 一种装置，其特征在于：底座连接支撑杆。` }],
      })),
    });
  });
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  const scrollbar = columnScrollbar(page);
  await scrollbar.fill("0");
  // Let resize/font/layout entry work settle before freezing the frame clock.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const position = () =>
    layout.evaluate((element) => Number((element as HTMLElement).dataset.columnPosition));
  const wheel = (deltaY: number) =>
    layout.evaluate((element, delta) => {
      const bounds = element.getBoundingClientRect();
      element.querySelector(":scope > .patent-page-zoom-frame")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: delta,
          clientX: bounds.left + 250,
          clientY: bounds.top + 250,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, deltaY);
  await wheel(120);
  expect(await position()).toBe(0);
  await page.clock.runFor(32);
  const intermediate = await position();
  expect(intermediate).toBeGreaterThan(0);
  expect(intermediate).toBeLessThan(120);
  // Compare the visible mirror (the active column's unused copy is display:none).
  const alignment = () =>
    layout.evaluate((element) => {
      const zoom = Number.parseFloat(
        (element as HTMLElement).style.getPropertyValue("--column-zoom"),
      );
      const y = (selector: string) => {
        const target = element.querySelector(selector);
        if (!target) throw new Error(`Missing ${selector}`);
        return new DOMMatrix(getComputedStyle(target).transform).f;
      };
      const active = Number((element as HTMLElement).dataset.activeColumn);
      const inactive = 1 - active;
      const height = Number((element as HTMLElement).dataset.columnHeight);
      const copyY = y(`.dual-column-paper[data-side="${inactive}"] .dual-column-copy`);
      const offset = active * 20 + (inactive - active) * height;
      return [
        y(":scope > .patent-page-zoom-frame") * zoom - offset - copyY,
        y(":scope > .document-structure-ruler") - offset - copyY,
      ];
    });
  for (const error of await alignment()) expect(Math.abs(error)).toBeLessThan(0.01);
  await layout.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const width = Number.parseFloat(
      (element as HTMLElement).style.getPropertyValue("--column-width"),
    );
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: bounds.left + width + 250,
        clientY: bounds.top + 250,
      }),
    );
  });
  await expect(layout).toHaveAttribute("data-active-column", "1");
  for (const error of await alignment()) expect(Math.abs(error)).toBeLessThan(0.01);
  await wheel(120);
  await page.clock.runFor(200);
  expect(await position()).toBe(240);
  await wheel(120);
  await page.clock.runFor(32);
  const turning = await position();
  await wheel(-60);
  await page.clock.runFor(32);
  expect(await position()).toBeLessThan(turning);
  await scrollbar.fill("400");
  await page.clock.runFor(300);
  expect(await position()).toBe(400);
  await wheel(120);
  await page.clock.runFor(32);
  await editor.dispatchEvent("pointerdown", { button: 0, clientX: 350, clientY: 350 });
  const stopped = await position();
  await page.clock.runFor(300);
  expect(await position()).toBe(stopped);
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  await wheel(120);
  expect(await position()).toBe(stopped + 120);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "false";
  });
  await wheel(120);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await page.clock.runFor(300);
  await expect(layout).toHaveCount(0);
  await expect(editor).toBeVisible();
});
