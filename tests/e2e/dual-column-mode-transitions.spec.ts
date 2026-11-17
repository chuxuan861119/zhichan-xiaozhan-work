import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { expect, test } from "./helpers/workbench.js";

let page: Page;

test.beforeEach(async ({ workbench }) => {
  const app = await workbench.launchAllowMultipleInstances();
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("页面模式布局回归");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 2200, height: 1000 });
});

test("quick pair clears column mode before opening a pane as single", async () => {
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
  await page.getByRole("menuitem", { name: "权／说", exact: true }).click();
  await expect(page.locator(".dual-document-pane")).toHaveCount(2);
  await page.locator(".dual-document-pane__title").last().dblclick();
  await expect(page.locator(".dual-document-pane")).toHaveCount(0);
  await expect(page.locator(".dual-column-layout")).toHaveCount(0);
});

test("leaving the right column retains its reading position", async () => {
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page
    .getByRole("textbox", { name: "编辑 说明书", exact: true })
    .fill(
      Array.from(
        { length: 80 },
        (_, i) => `第${i + 1}段：用于检查页面切换时阅读位置的测试文字。`,
      ).join("\n"),
    );
  await page.getByRole("button", { name: /缩放 .*点击重置/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await page.setViewportSize({ width: 1900, height: 1000 });
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await page.locator(".dual-column-scrollbar").evaluate((e: HTMLElement) => {
    e.scrollTop = 700;
    e.dispatchEvent(new Event("scroll"));
  });
  const right = await page.locator('.dual-column-paper[data-side="1"]').boundingBox();
  if (!right) throw new Error("Right column is missing");
  await page.mouse.move(right.x + 180, right.y + 100);
  await expect(layout).toHaveAttribute("data-active-column", "1");
  const expected = await layout.evaluate(
    (e: HTMLElement) =>
      (Number(e.dataset.columnPosition) + Number(e.dataset.columnHeight)) /
      Number(getComputedStyle(e).getPropertyValue("--column-zoom")),
  );
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveCount(0);
  await expect
    .poll(async () =>
      page.getByRole("textbox", { name: "编辑 说明书", exact: true }).evaluate((e) => {
        const workspace = e.closest<HTMLElement>(".editor-workspace");
        const frame = e.closest<HTMLElement>(".patent-page-zoom-frame");
        if (!workspace || !frame) throw new Error("Single page is missing");
        return workspace.scrollTop / Number(getComputedStyle(frame).zoom);
      }),
    )
    .toBeGreaterThan(expected - 50);
});

test("narrow columns fit their available width and retain column mode on widen", async () => {
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect
    .poll(() =>
      layout.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue("--column-paper-width")),
      ),
    )
    .toBeGreaterThanOrEqual(600);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(layout).toBeVisible();
  await expect
    .poll(() =>
      layout.evaluate((element: HTMLElement) => {
        const viewport = element.closest<HTMLElement>(".patent-editor-workspace");
        if (!viewport) throw new Error("Missing column viewport");
        return viewport.scrollWidth - viewport.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
    width: 1600,
    height: 900,
  });
  await page.setViewportSize({ width: 2200, height: 1000 });
  await expect(page.getByRole("button", { name: "双列显示", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(layout).toBeVisible();
});

test("right-column reading anchor survives resize and single scrolling replaces the old anchor", async () => {
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
  await editor.fill(
    Array.from({ length: 100 }, (_, i) => `第${i + 1}段：这是保持阅读位置的测试文字。`).join("\n"),
  );
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await page.locator(".dual-column-scrollbar").evaluate((element: HTMLElement) => {
    element.scrollTop = 1500;
    element.dispatchEvent(new Event("scroll"));
  });
  const right = await page.locator('.dual-column-paper[data-side="1"]').boundingBox();
  if (!right) throw new Error("Missing right column");
  await page.mouse.move(right.x + 150, right.y + 150);
  await expect(layout).toHaveAttribute("data-active-column", "1");
  const anchor = () =>
    layout.evaluate(
      (element: HTMLElement) =>
        (Number(element.dataset.columnPosition) + (4 / 3) * Number(element.dataset.columnHeight)) /
        Number(getComputedStyle(element).getPropertyValue("--column-zoom")),
    );
  const before = await anchor();
  await page.mouse.move(900, 60);
  await page.setViewportSize({ width: 1900, height: 800 });
  await expect.poll(async () => Math.abs((await anchor()) - before)).toBeLessThan(3);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveCount(0);
  await editor.evaluate((element) => {
    element.closest(".editor-workspace")!.scrollTop = 100;
  });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveAttribute("data-active-column", "0");
  await expect
    .poll(() => layout.evaluate((element: HTMLElement) => Number(element.dataset.columnPosition)))
    .toBeLessThan(300);
});

test("cross-column Shift selection and composition survive fitting a narrow viewport", async () => {
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  const textbox = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
  await textbox.fill(
    Array.from({ length: 100 }, (_, i) => `第${i + 1}段：跨列选择和中文输入状态测试。`).join("\n"),
  );
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await textbox.evaluate((element) => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    editor.commands.setTextSelection(5);
    editor.view.focus();
  });
  const right = await page.locator('.dual-column-paper[data-side="1"]').boundingBox();
  if (!right) throw new Error("Missing right column");
  await page.keyboard.down("Shift");
  await page.mouse.click(right.x + 220, right.y + 140);
  await page.keyboard.up("Shift");
  const selection = () =>
    textbox.evaluate((element) => {
      const { anchor, head } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
      return { anchor, head };
    });
  await expect.poll(async () => (await selection()).anchor).toBe(5);
  expect((await selection()).head).toBeGreaterThan(100);
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await selection()).anchor).toBe(5);
  await textbox.dispatchEvent("compositionstart", { data: "" });
  await page.setViewportSize({ width: 1600, height: 900 });
  // Fitting never changes the selected layout or interrupts composition.
  await page.waitForTimeout(350);
  await expect(layout).toBeVisible();
  await textbox.dispatchEvent("compositionend", { data: "" });
  await expect(layout).toBeVisible();
  expect(await textbox.textContent()).toContain("第100段");
});

test("table and image content survive column switching and cross-column drag shares one history", async () => {
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  const textbox = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
  await textbox.evaluate((element) => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    editor.commands.setContent({
      type: "doc",
      content: [
        ...Array.from({ length: 50 }, (_, i) =>
          paragraph(`第${i + 1}段：跨列拖动与图表布局测试。`),
        ),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph("参数名称")] },
                { type: "tableCell", content: [paragraph("参数数值")] },
              ],
            },
          ],
        },
        paragraph("图表后的结束段落"),
      ],
    });
  });
  await expect(textbox).toContainText("第50段");
  await textbox.evaluate(
    (element, bytes) => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.view.focus();
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "sample.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    },
    [...(await readFile("tests/fixtures/images/sample.png"))],
  );
  await expect(textbox.locator("img")).toHaveCount(1);
  const content = () =>
    textbox.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
  const before = await content();
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await columnScrollbar(page).fill("0");
  const left = await page.locator('.dual-column-paper[data-side="0"]').boundingBox();
  const right = await page.locator('.dual-column-paper[data-side="1"]').boundingBox();
  if (!left || !right) throw new Error("Missing columns");
  await page.mouse.move(left.x + 240, left.y + 200);
  const start = await textbox.evaluate(
    (element, point) =>
      (element as HTMLElement & { editor: Editor }).editor.view.posAtCoords(point)?.pos,
    { left: left.x + 240, top: left.y + 200 },
  );
  expect(start).toBeDefined();
  await page.mouse.down();
  await page.mouse.move(right.x + 240, right.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      textbox.evaluate(
        (element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.anchor,
      ),
    )
    .toBe(start);
  expect(
    await textbox.evaluate(
      (element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.empty,
    ),
  ).toBe(false);
  await page.keyboard.insertText("替换跨列选区");
  await expect(textbox).toContainText("替换跨列选区");
  await page.keyboard.press("Control+z");
  await expect.poll(content).toEqual(before);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveCount(0);
  await expect.poll(content).toEqual(before);
  await expect(textbox.locator("table")).toHaveCount(1);
  await expect(textbox.locator("img")).toHaveCount(1);
});
