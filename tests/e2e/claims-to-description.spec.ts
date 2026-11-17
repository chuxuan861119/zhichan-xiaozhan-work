/// <reference lib="dom" />
import { expect, test } from "./helpers/workbench.js";

test("claims draft copies formatted text, navigates without writing, and preserves keyword display on paste", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(150_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Keep the user's real system clipboard untouched while exercising native IPC serialization.
    await application.evaluate(({ clipboard }) => {
      let data = { text: "previous clipboard", html: "" };
      Object.defineProperty(clipboard, "write", {
        value: (value: typeof data) => {
          data = value;
        },
      });
      Object.defineProperty(clipboard, "writeText", {
        value: (text: string) => {
          data = { text, html: "" };
        },
      });
      Object.defineProperty(clipboard, "readText", { value: () => data.text });
      Object.defineProperty(clipboard, "readHTML", { value: () => data.html });
    });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("转换验收装置");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    const claims = page.getByRole("textbox", { name: "编辑 权利要求书" });
    const description = page.getByRole("textbox", { name: "编辑 说明书" });
    const tools = page.getByRole("group", { name: "权利要求书工具" });
    await claims.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("1. 一种装置，包括箱体，其特征在于：所述箱体具有通孔。");
    await page.keyboard.press("Enter");
    await page.keyboard.type("2. 根据权利要求1所述的装置，其特征在于：所述箱体厚5mm。");
    await claims.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const start = node.textContent?.indexOf("箱体") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 2);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      throw new Error("fixture keyword missing");
    });
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    await expect(claims).toContainText("箱体(1)");
    const sourceText = await claims.innerText();
    const sourceIndents = await claims
      .locator("p")
      .evaluateAll((paragraphs) =>
        paragraphs.map((paragraph) => paragraph.getAttribute("data-paragraph-indent-mm") ?? "9.88"),
      );
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const destinationBefore = await description.innerHTML();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const insertButton = await tools
      .getByRole("button", { name: "插入从权", exact: true })
      .boundingBox();
    const descriptionButton = await tools
      .getByRole("button", { name: "说明书", exact: true })
      .boundingBox();
    expect(insertButton).not.toBeNull();
    expect(descriptionButton).not.toBeNull();
    expect(descriptionButton!.y).toBeGreaterThanOrEqual(insertButton!.y);
    await expect(tools.locator(".claims-description-tool__outline")).toHaveCount(0);
    await tools.screenshot({ path: testInfo.outputPath("claims-description-collapsed.png") });
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    const dropdown = page.locator(".claims-description-tool__panel");
    await expect(dropdown).toHaveCSS("position", "fixed");
    const assistance = tools.locator(".compact-tool-actions__label--separated");
    const openY = (await assistance.boundingBox())!.y;
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    expect((await assistance.boundingBox())!.y).toBeCloseTo(openY, 0);
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    const originalWidth = await tools.evaluate((node) => node.style.width);
    await tools.evaluate((node) => {
      node.style.width = "240px";
      window.dispatchEvent(new Event("resize"));
    });
    await expect(dropdown).toBeVisible();
    const menuBounds = (await dropdown.boundingBox())!;
    const toggleBounds = (await tools.locator(".claims-description-tool__toggle").boundingBox())!;
    expect(menuBounds.x + menuBounds.width).toBeCloseTo(toggleBounds.x + toggleBounds.width, 0);
    await tools.screenshot({ path: testInfo.outputPath("claims-description-narrow.png") });
    await tools.evaluate((node, width) => {
      node.style.width = width;
      window.dispatchEvent(new Event("resize"));
    }, originalWidth);
    await expect(dropdown).toBeVisible();
    await tools.screenshot({ path: testInfo.outputPath("claims-description-panel.png") });
    await dropdown.getByRole("button", { name: "发明内容设置", exact: true }).click();
    const prefixSettings = page.getByRole("dialog", { name: "发明内容设置", exact: true });
    await expect(prefixSettings).toBeVisible();
    await prefixSettings.getByRole("radio", { name: "进一步地，", exact: true }).check();
    await expect(prefixSettings).toContainText("进一步地，所述装置包括连接件。");
    await prefixSettings.screenshot({
      path: testInfo.outputPath("invention-content-settings.png"),
    });
    await prefixSettings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(prefixSettings).not.toBeVisible();
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    await dropdown.getByRole("button", { name: "发明内容设置", exact: true }).click();
    await expect(
      prefixSettings.getByRole("radio", { name: "进一步地，", exact: true }),
    ).toBeChecked();
    await prefixSettings.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const workspaceSettings = page.getByRole("dialog", { name: "设置", exact: true });
    await workspaceSettings.getByRole("button", { name: "编辑辅助", exact: true }).click();
    await workspaceSettings.getByRole("button", { name: "发明内容设置", exact: true }).click();
    await expect(
      prefixSettings.getByRole("radio", { name: "进一步地，", exact: true }),
    ).toBeChecked();
    await prefixSettings.getByRole("button", { name: "取消", exact: true }).click();
    await workspaceSettings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    await dropdown.getByRole("button", { name: "发明内容", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "发明内容预览", exact: true });
    await expect(preview).toBeVisible();
    await expect(page.getByRole("tab", { name: "权利要求书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await preview.getByRole("button", { name: "复制并跳转", exact: true }).click();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const firstCopy = await application.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
    }));
    expect(firstCopy.text).toBe(
      "一种装置，包括箱体，所述箱体具有通孔。\n进一步地，所述箱体厚5mm。",
    );
    expect(firstCopy.html).not.toContain("color:#D92D20");
    expect(
      Array.from(firstCopy.html.matchAll(/text-indent:([\d.]+)mm/gu), (match) => match[1]),
    ).toEqual(sourceIndents);
    expect(firstCopy.html).toContain("font-size:");
    expect(firstCopy.html).not.toMatch(/reference-mark/u);
    expect(await description.innerHTML()).toBe(destinationBefore);
    await expect(description.getByText("发明内容", { exact: true })).toBeInViewport();

    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    expect(await claims.innerText()).toBe(sourceText);
    await expect(tools.getByRole("button", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    await dropdown.getByRole("button", { name: "具体实施方式", exact: true }).click();
    await page
      .getByRole("dialog", { name: "具体实施方式预览", exact: true })
      .getByRole("button", { name: "复制并跳转", exact: true })
      .click();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const secondCopy = await application.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
    }));
    expect(secondCopy.text).toBe("一种装置，包括箱体1，所述箱体1具有通孔。\n所述箱体1厚5mm。");
    expect(await description.innerHTML()).toBe(destinationBefore);
    await expect(description.getByText("具体实施方式", { exact: true })).toBeInViewport();
    // Wait for Chromium's asynchronous selectionchange before sending another editing action.
    await description
      .locator("p")
      .filter({ hasText: /^下面结合附图/u })
      .click();
    await expect
      .poll(() =>
        description.evaluate((root) => {
          const editor = (
            root as HTMLElement & {
              editor: { state: { selection: { $from: { parent: { textContent: string } } } } };
            }
          ).editor;
          return editor.state.selection.$from.parent.textContent.startsWith("下面结合附图");
        }),
      )
      .toBe(true);
    await page.keyboard.press("Control+End");
    await expect
      .poll(() =>
        description.evaluate((root) => {
          const editor = (
            root as HTMLElement & {
              editor: {
                state: { selection: { from: number }; doc: { content: { size: number } } };
              };
            }
          ).editor;
          return editor.state.selection.from === editor.state.doc.content.size - 1;
        }),
      )
      .toBe(true);
    await page.keyboard.press("Enter");
    await description.evaluate((root, data) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", data.text);
      transfer.setData("text/html", data.html);
      root.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }, secondCopy);
    await expect(description).toContainText("所述箱体1厚5mm。");
    const pastedText = await description.innerText();
    expect(pastedText.indexOf("一种装置，包括箱体1")).toBeGreaterThan(
      pastedText.indexOf("具体实施方式"),
    );
    const keyword = description
      .locator(".reference-mark-keyword-block")
      .filter({ hasText: "箱体1" })
      .first();
    await expect(keyword).toBeVisible();
    const style = await keyword.evaluate((node) => {
      const child = node.querySelector("span") ?? node;
      const paragraph = node.closest("p");
      if (!paragraph) throw new Error("Pasted keyword has no paragraph");
      return {
        color: getComputedStyle(child).color,
        paragraphColor: getComputedStyle(paragraph).color,
        size: parseFloat(getComputedStyle(node).fontSize),
        paragraphSize: parseFloat(getComputedStyle(paragraph).fontSize),
      };
    });
    expect(style.color).toBe(style.paragraphColor);
    expect(style.size).toBeLessThan(style.paragraphSize);
    for (const [index, text] of ["一种装置，包括箱体1", "所述箱体1厚5mm。"].entries()) {
      const expectedIndent = sourceIndents[index];
      if (expectedIndent === undefined) throw new Error("Missing source paragraph indent");
      await expect(description.locator("p").filter({ hasText: text })).toHaveAttribute(
        "data-paragraph-indent-mm",
        expectedIndent,
      );
    }
    await description.screenshot({ path: testInfo.outputPath("pasted-red-keywords.png") });
    await page.keyboard.press("Control+Z");
    await expect(description).not.toContainText("所述箱体1厚5mm。");
    await page.keyboard.press("Control+Y");
    await expect(description).toContainText("所述箱体1厚5mm。");

    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await claims.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("1. 一种装置，其特征在于：箱体(9)。");
    await tools.getByRole("button", { name: "说明书", exact: true }).click();
    await expect(tools.getByRole("button", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await dropdown.getByRole("button", { name: "发明内容", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "未能生成预览" })).toBeVisible();
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      secondCopy.text,
    );
    await expect(page.getByRole("tab", { name: "权利要求书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
