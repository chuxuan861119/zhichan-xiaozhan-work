import type { Editor } from "@tiptap/core";
import { expect, test } from "./helpers/workbench.js";

test("scrolling keeps paper geometry out of document inheritance and avoids ruler measurement", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列滚动回归验证");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("textbox", { name: "编辑 权利要求书", exact: true }).evaluate((element) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 80 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `${index + 1}. 一种装置，其特征在于：底座连接支撑杆。` }],
      })),
    });
  });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.runFor(1000);
  const ruler = layout.locator(":scope > .document-structure-ruler");
  await ruler.evaluate((element) => {
    const original = element.getBoundingClientRect.bind(element);
    element.setAttribute("data-scroll-measurements", "0");
    element.getBoundingClientRect = () => {
      element.setAttribute(
        "data-scroll-measurements",
        String(Number(element.getAttribute("data-scroll-measurements")) + 1),
      );
      return original();
    };
  });
  await layout.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 300,
        clientY: rect.top + 150,
        deltaY: 480,
      }),
    );
  });
  await page.clock.runFor(250);
  expect(Number(await layout.getAttribute("data-column-position"))).toBeGreaterThan(0);
  await expect(ruler).toHaveAttribute("data-scroll-measurements", "0");
  const inherited = await layout
    .locator('.dual-column-paper[data-side="1"] .patent-page-zoom-frame')
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--paper-bottom"));
  expect(inherited).toBe("");
  const background = layout.locator(
    '.dual-column-paper[data-side="0"] > .dual-column-paper-background',
  );
  expect(
    await background.evaluate((element) => Number.parseFloat((element as HTMLElement).style.top)),
  ).toBeCloseTo(20 - Number(await layout.getAttribute("data-column-position")));
});
