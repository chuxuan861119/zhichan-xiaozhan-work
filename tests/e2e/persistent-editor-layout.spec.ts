import type { Page } from "@playwright/test";
import { choosePaneBook, dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function createPatent(page: Page, name: string) {
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}

for (const width of [1100, 1800]) {
  test(`retained patent editors fill the workspace across library and view switches at ${width}px`, async ({
    workbench,
  }) => {
    test.setTimeout(90_000);
    const app = await workbench.launch();
    const page = await app.firstWindow();
    await page.setViewportSize({ width, height: 900 });
    await dismissWorkbenchWelcome(page);
    await createPatent(page, "编辑布局回归");
    const workspace = page.locator(".standard-workspace-pane");
    const expectFullWidth = async (selector: string) => {
      await expect
        .poll(async () =>
          workspace.evaluate((outer, selector) => {
            const inner = outer.querySelector(selector);
            if (!inner) return 0;
            return inner.getBoundingClientRect().width / outer.getBoundingClientRect().width;
          }, selector),
        )
        .toBeGreaterThan(0.98);
    };
    const single = '.patent-function-rail-scope[data-function-rail-scope="single"]';
    await expectFullWidth(single);
    const editor = page.locator(".tiptap:visible").last();
    const originalEditor = await editor.elementHandle();
    await editor.press("Control+End");
    await page.keyboard.insertText("布局草稿不丢失");
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    await expect(editor).toHaveCount(0);
    await page.getByRole("tab", { name: "编辑布局回归", exact: true }).click();
    await expectFullWidth(single);
    expect(
      await originalEditor?.evaluate(
        (node) => node.isConnected && node.getBoundingClientRect().width > 100,
      ),
    ).toBe(true);
    await expect(editor).toContainText("布局草稿不丢失");
    await editor.press("Control+z");
    await expect(editor).not.toContainText("布局草稿不丢失");
    await editor.press("Control+y");
    await expect(editor).toContainText("布局草稿不丢失");
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await createPatent(page, "第二份布局专利");
    await expectFullWidth(single);
    await expect(editor).not.toContainText("布局草稿不丢失");
    await page.getByRole("tab", { name: "编辑布局回归", exact: true }).click();
    await expectFullWidth(single);
    expect(
      await originalEditor?.evaluate(
        (node) => node.isConnected && node.getBoundingClientRect().width > 100,
      ),
    ).toBe(true);
    await expect(editor).toContainText("布局草稿不丢失");

    await page.getByRole("button", { name: "双列显示", exact: true }).click();
    await expect(page.locator(".dual-column-layout")).toBeVisible();
    await expectFullWidth(single);
    await page.getByRole("button", { name: "双列显示", exact: true }).click();
    await expect(page.locator(".dual-column-layout")).toHaveCount(0);
    await expectFullWidth(single);

    await page.getByRole("button", { name: "同屏双显", exact: true }).click();
    await choosePaneBook(page, "right", "编辑布局回归", "说明书");
    await expectFullWidth(".dual-document-workspace");
    for (const side of ["left", "right"]) {
      await expect
        .poll(async () =>
          page
            .locator(`.dual-document-pane[data-pane="${side}"]`)
            .evaluate((el) => el.getBoundingClientRect().width / window.innerWidth),
        )
        .toBeGreaterThan(0.25);
    }
    await page.getByRole("button", { name: "同屏双显", exact: true }).click();
    await expect(page.locator(".dual-document-workspace")).toHaveCount(0);
    await expectFullWidth(single);
  });
}
