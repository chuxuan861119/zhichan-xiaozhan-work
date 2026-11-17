import { expect, test } from "./helpers/workbench.js";

test("rail keywords support real drag selection and bidirectional highlight/scroll", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("关键词联动隔离验证");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("1. 一种装置，其特征在于，包括电池包主体。");
    await editor.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const start = node.textContent?.indexOf("电池包主体") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 5);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      throw new Error("Keyword missing");
    });
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    const keyword = page
      .locator(".reference-mark-panel__row-keyword")
      .filter({ hasText: "电池包主体" });
    await expect(keyword).toBeVisible();
    await keyword.scrollIntoViewIfNeeded();
    const bounds = await keyword.boundingBox();
    if (!bounds) throw new Error("Keyword bounds missing");
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
      .toBe("电池包主体");
    // Verify Ctrl+C's selected text without changing the user's system clipboard.
    await page.evaluate(() => {
      document.addEventListener(
        "copy",
        (event) => {
          document.body.dataset.selectedCopy = window.getSelection()?.toString().trim();
          event.preventDefault();
        },
        { once: true, capture: true },
      );
    });
    await page.keyboard.press("Control+C");
    await expect(page.locator("body")).toHaveAttribute("data-selected-copy", "电池包主体");
    const cancelHighlight = page.getByRole("button", { name: "取消高亮", exact: true });
    if (await cancelHighlight.isVisible()) await cancelHighlight.click();
    // The rail uses a single click to locate; double click opens keyword editing.
    await keyword.click();
    await expect(page.locator(".reference-mark-panel__rows > .is-keyword-active")).toContainText(
      "电池包主体",
    );
    await expect(editor.locator(".reference-mark-keyword-block.is-active")).toContainText(
      "电池包主体",
    );
    // Newly numbered text briefly has a recent state; wait for the active cyan palette.
    await expect(editor.locator(".reference-mark-keyword-block.is-active").first()).toHaveCSS(
      "background-color",
      "rgb(178, 235, 242)",
    );
    // The document uses cyan while the linked list row uses its orange selection palette.
    await expect(page.locator(".reference-mark-panel__rows > .is-keyword-active")).toHaveCSS(
      "background-color",
      "rgb(255, 237, 213)",
    );
    await expect(page.locator(".reference-mark-panel__row-activation-area")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await page.getByRole("button", { name: "取消高亮", exact: true }).click();
    await expect(page.locator(".reference-mark-panel__rows > .is-keyword-active")).toHaveCount(0);
    // A short rail reproduces a keyword below the fold without moving the document.
    await page.addStyleTag({
      content: ".patent-global-function-rail { max-height: 220px !important; }",
    });
    const rail = page.locator(".patent-global-function-rail:visible").first();
    await rail.evaluate((el) => {
      el.scrollTop = 0;
    });
    await editor.locator(".reference-mark-keyword-block").first().dblclick();
    const row = page.locator(".reference-mark-panel__rows > .is-keyword-active");
    await expect(row).toContainText("电池包主体");
    await expect
      .poll(() =>
        row.evaluate((el) => {
          const parent = el.closest(".patent-global-function-rail");
          if (!parent) return false;
          const item = el.getBoundingClientRect();
          const viewport = parent.getBoundingClientRect();
          return item.top >= viewport.top && item.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
    await expect.poll(() => rail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await rail.screenshot({ path: testInfo.outputPath("linked-keyword.png") });
  } finally {
    await app.close();
  }
});
