import { expect, test } from "./helpers/workbench.js";

test("minimal rail keeps controls usable in docked and overlay layouts", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("功能栏样式验收");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    const rail = page.locator('.patent-global-function-rail:not([aria-hidden="true"]):visible');
    await expect(rail).toHaveCount(1);
    await expect(rail.locator(".reference-mark-panel")).toHaveCSS("border-radius", "12px");
    await expect(rail.locator(".reference-mark-panel")).toHaveCSS(
      "background-color",
      "rgb(253, 253, 254)",
    );
    const numbering = rail.getByRole("button", { name: "顺序编号", exact: true });
    await expect(numbering).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // Chromium rounds a CSS hairline to device pixels at the user's display scale.
    const borderWidth = await numbering.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).borderBottomWidth),
    );
    expect(borderWidth).toBeGreaterThan(0);
    expect(borderWidth).toBeLessThanOrEqual(1);
    const custom = rail.getByRole("button", { name: "自定义编号", exact: true });
    const autoWidth = await numbering.evaluate((el) => el.getBoundingClientRect().width);
    const customWidth = await custom.evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(autoWidth - customWidth)).toBeLessThan(1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await page.addStyleTag({
      content: ".patent-global-function-rail button { transition: none !important; }",
    });
    for (const button of [numbering, custom]) {
      const before = await button.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundColor,
      );
      await button.evaluate((el) => el.setAttribute("data-rail-hover-test", "true"));
      const document = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector: '[data-rail-hover-test="true"]',
      });
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      expect(
        await button.evaluate((el) => getComputedStyle(el, "::before").backgroundColor),
      ).not.toBe(before);
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      await button.evaluate((el) => el.removeAttribute("data-rail-hover-test"));
    }
    await cdp.detach();
    await custom.click();
    await expect(custom).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator(".reference-mark-panel__custom-number")).toBeVisible();
    await rail
      .locator(".reference-mark-panel__custom-number")
      .getByRole("button", { name: "取消自定义编号", exact: true })
      .click();
    await rail.locator(".claims-description-tool__toggle").click();
    // The menu is portalled outside the scrollable rail to avoid clipping.
    await expect(page.getByRole("button", { name: "发明内容", exact: true })).toBeVisible();
    await expect(page.locator(".claims-description-tool__panel")).toHaveCSS("position", "fixed");
    await rail.locator(".claims-description-tool__toggle").click();
    await expect(page.locator(".claims-description-tool__panel")).toHaveCount(0);
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await editor.fill("1. 一种升降装置，包括底座、导向立柱、丝杆、升降托架和手轮。");
    for (const keyword of ["底座", "导向立柱", "丝杆", "升降托架", "手轮"]) {
      await editor.click();
      await editor.evaluate((root, text) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const start = node.textContent?.indexOf(text) ?? -1;
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + text.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
          return;
        }
        throw new Error(`Missing fixture keyword: ${text}`);
      }, keyword);
      await numbering.click();
      await expect(
        rail.locator(".reference-mark-panel__row-keyword").filter({ hasText: keyword }),
      ).toBeVisible();
    }
    const row = rail.locator(".reference-mark-panel__rows > div").filter({ hasText: "丝杆" });
    await row.locator(".reference-mark-panel__row-keyword").click();
    await expect(row).toHaveCSS("background-color", "rgb(255, 237, 213)");
    await expect(row.locator(".reference-mark-panel__row-activation-area")).toHaveCSS(
      "user-select",
      "text",
    );
    await row.locator(".reference-mark-panel__row-keyword").dblclick();
    await expect(rail.getByRole("textbox", { name: "丝杆关键词", exact: true })).toBeVisible();
    await rail.getByRole("button", { name: "取消丝杆修改", exact: true }).click();
    const remindLater = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await remindLater.isVisible()) await remindLater.click();
    await page.screenshot({ path: testInfo.outputPath("claims-rail.png") });

    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    const marks = rail.getByRole("button", { name: "展开附图标记", exact: true });
    if (await marks.isVisible()) await marks.click();
    const foldMarks = rail.getByRole("button", { name: "折叠附图标记", exact: true });
    if (await foldMarks.isVisible()) await foldMarks.click({ position: { x: 8, y: 8 } });
    await expect(rail.getByRole("button", { name: "展开附图标记", exact: true })).toBeVisible();
    await rail
      .getByRole("button", { name: "展开附图标记", exact: true })
      .click({ position: { x: 8, y: 8 } });
    await expect(rail.getByRole("button", { name: "折叠附图标记", exact: true })).toBeVisible();
    const caption = rail.locator(".drawing-explanation-rail__toggle");
    if ((await caption.getAttribute("aria-expanded")) === "true") await caption.click();
    await caption.click({ position: { x: 8, y: 8 } });
    await expect(caption).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator(".drawing-explanation-rail")).toHaveCSS(
      "background-color",
      "rgb(253, 253, 254)",
    );
    await page.screenshot({ path: testInfo.outputPath("drawing-rail.png") });

    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格", exact: true }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 3 行 3 列表格" })
      .click();
    await page.getByRole("textbox", { name: "编辑 说明书" }).locator("td").first().click();
    await expect(rail.locator(".table-rail-panel")).toBeVisible();
    await expect(rail.locator(".table-rail-panel")).toHaveCSS(
      "border-top-color",
      "rgb(236, 157, 86)",
    );
    await page.screenshot({ path: testInfo.outputPath("table-rail.png") });
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate((window) => {
      window.unmaximize();
      window.setSize(1050, 850);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(1200);
    await page.screenshot();
    await page.waitForTimeout(200);
    const expand = page.getByRole("button", { name: "展开功能栏", exact: true });
    if (await expand.isVisible()) await expand.click();
    await expect(rail).toBeVisible();
    await expect(page.locator(".patent-global-function-rail-slot:visible").last()).toHaveAttribute(
      "data-layout",
      "overlay",
    );
    const fits = await rail.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("narrow-rail.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
