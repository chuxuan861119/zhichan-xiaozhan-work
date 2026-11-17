import type { Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expect, test } from "./helpers/workbench.js";

async function openPatent(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: /^欢迎使用知产小栈/ });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("响应式页面规则验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.mouse.move(5, 5);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) =>
      !e.closest("[hidden]") && e.checkVisibility({ visibilityProperty: true });
    const layout = [...document.querySelectorAll<HTMLElement>(".patent-page-with-rail")].find(
      visible,
    )!;
    const frame = layout.querySelector<HTMLElement>(
      ":scope > .patent-page-zoom-frame, :scope > .drawing-page, :scope > .drawings-editor",
    )!;
    const ruler = layout.querySelector<HTMLElement>(".document-structure-ruler");
    const viewport = layout.closest<HTMLElement>(".editor-workspace")!;
    const rail = [
      ...layout
        .closest(".patent-function-rail-scope")!
        .querySelectorAll<HTMLElement>(".patent-global-function-rail-slot"),
    ].find(visible)!;
    const columns = getComputedStyle(layout).gridTemplateColumns.split(" ").map(parseFloat);
    return {
      zoom: (frame.getBoundingClientRect().width / frame.offsetWidth) * 100,
      width: frame.getBoundingClientRect().width,
      ruler: ruler?.dataset.mode,
      rulerSlot: columns[0],
      railSlot: columns[2],
      expanded: rail.dataset.expanded,
      placement: rail.dataset.layout,
      overflow: viewport.scrollWidth - viewport.clientWidth,
      target: layout.dataset.pageZoomTarget,
    };
  });
}

test("single page releases controls before shrinking, and restores its reading preference", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await openPatent(page);
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  for (const [width, ruler, expanded] of [
    [1400, "wide", "true"],
    [1000, "wide", "false"],
    [940, "compact", "false"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await metrics(page)).ruler).toBe(ruler);
    await expect.poll(async () => (await metrics(page)).expanded).toBe(expanded);
    await expect.poll(async () => Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
    await expect.poll(async () => (await metrics(page)).overflow).toBeLessThanOrEqual(1);
  }
  expect((await metrics(page)).rulerSlot).toBe(28);
  expect((await metrics(page)).railSlot).toBe(48);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(async () => (await metrics(page)).zoom).toBeLessThan(90);
  await expect.poll(async () => (await metrics(page)).overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(async () => Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await expect.poll(async () => Math.abs((await metrics(page)).zoom - 110)).toBeLessThan(0.08);
  await page.setViewportSize({ width: 940, height: 900 });
  await expect.poll(async () => (await metrics(page)).zoom).toBeLessThan(110);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(async () => Math.abs((await metrics(page)).zoom - 110)).toBeLessThan(0.08);
});

test("hovered, pinned and manually collapsed rails do not squeeze the page", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await openPatent(page);
  await page.setViewportSize({ width: 1000, height: 900 });
  const open = page.getByRole("button", { name: "展开功能栏", exact: true });
  await expect(open).toBeVisible();
  const before = (await metrics(page)).width;
  await open.hover();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  await expect(pin).toBeVisible();
  expect(Math.abs((await metrics(page)).width - before)).toBeLessThan(1);
  await pin.click();
  await page.mouse.move(5, 5);
  await page.setViewportSize({ width: 940, height: 900 });
  await expect.poll(async () => (await metrics(page)).placement).toBe("overlay");
  expect((await metrics(page)).expanded).toBe("true");
  expect(Math.abs((await metrics(page)).width - before)).toBeLessThan(1);
  await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await metrics(page)).expanded).toBe("false");
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(async () => (await metrics(page)).ruler).toBe("wide");
  await expect.poll(async () => (await metrics(page)).expanded).toBe("true");
  expect((await metrics(page)).railSlot).toBe(292);
  expect(Math.abs((await metrics(page)).width - before)).toBeLessThan(1);
});

test("all five books follow the active page and resize without stale hidden-book budgets", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await openPatent(page);
  for (const book of ["说明书", "权利要求书", "说明书摘要", "说明书附图", "摘要附图", "说明书"]) {
    await page.getByRole("tab", { name: book, exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
    await expect.poll(async () => (await metrics(page)).expanded).toBe("false");
    await expect.poll(async () => (await metrics(page)).overflow).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(async () => (await metrics(page)).expanded).toBe("true");
  }
});

test("animated window fitting preserves content, selection and the reading anchor", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await openPatent(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  const textbox = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
  await textbox.fill(
    Array.from(
      { length: 80 },
      (_, i) => `第${i + 1}段：缩放与窗口变化不应改动正文或阅读位置。`,
    ).join("\n"),
  );
  await expect.poll(async () => Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
  await textbox.evaluate((element) => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    editor.commands.setTextSelection({ from: 10, to: 18 });
    const viewport = element.closest<HTMLElement>(".editor-workspace")!;
    viewport.scrollTop = 1200;
    viewport.dispatchEvent(new Event("scroll"));
  });
  const read = () =>
    textbox.evaluate((element) => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      const viewport = element.closest<HTMLElement>(".editor-workspace")!;
      const frame = element.closest<HTMLElement>(".patent-page-zoom-frame")!;
      const scale = frame.getBoundingClientRect().width / frame.offsetWidth;
      return {
        content: editor.getJSON(),
        selection: editor.state.selection.toJSON(),
        anchor:
          (viewport.getBoundingClientRect().top +
            viewport.clientHeight / 3 -
            frame.getBoundingClientRect().top) /
          scale,
        scroll: viewport.scrollTop,
      };
    });
  const before = await read();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [1000, 940, 800, 1400]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await metrics(page)).overflow).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs((await read()).anchor - before.anchor)).toBeLessThan(4);
    const after = await read();
    expect(after.content).toEqual(before.content);
    expect(after.selection).toEqual(before.selection);
    expect(after.scroll).toBeGreaterThan(500);
  }
  await expect.poll(async () => Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
  await page.setViewportSize({ width: 1400, height: 700 });
  expect(Math.abs((await metrics(page)).zoom - 100)).toBeLessThan(0.08);
  expect((await metrics(page)).ruler).toBe("wide");
});
