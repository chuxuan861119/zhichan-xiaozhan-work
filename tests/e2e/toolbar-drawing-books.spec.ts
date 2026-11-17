import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
  await expect(welcome).toBeHidden();
}

async function createPatent(page: Page, name: string): Promise<void> {
  const patentLibrary = page.getByRole("tab", { name: "专利库" });
  if (await patentLibrary.isVisible()) await patentLibrary.click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建专利" });
  await createDialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await createDialog.getByRole("radio", { name: "发明" }).check();
  await createDialog.getByRole("button", { name: "创建专利" }).click();
  await expect(createDialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function clickGreyedTool(page: Page, tool: Locator): Promise<void> {
  await tool.scrollIntoViewIfNeeded();
  const box = await tool.boundingBox();
  if (!box) throw new Error("Missing greyed tool");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("simplified paragraph styles preserve existing headings and work in a narrow toolbar", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await dismissWelcome(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await createPatent(page, "段落样式验收");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await editor.evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
        '<p style="text-align:right"><strong>保留正文格式</strong></p><h3>保留旧标题</h3>',
      );
    });
    await editor.locator("h3").click();
    const originalBody = await editor.evaluate(
      (element) => (element as HTMLElement & { editor: Editor }).editor.getJSON().content?.[0],
    );
    const style = page.getByRole("combobox", { name: "段落样式", exact: true });
    await expect(style).toHaveValue("3");
    expect(
      await style
        .locator("option:not([hidden])")
        .evaluateAll((options) => options.map((option) => option.textContent)),
    ).toEqual(["正文", "章节标题", "更多样式…"]);
    await style.selectOption("more");
    const menu = page.getByRole("menu", { name: "更多段落样式", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: "标题 3" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(editor.locator("h2")).toHaveText("保留旧标题");
    await expect(style).toHaveValue("2");
    await style.selectOption("1");
    await expect(editor.locator("h1")).toHaveText("保留旧标题");
    await expect(style).toHaveValue("1");
    await style.selectOption("paragraph");
    await expect(editor.locator("h1,h2,h3")).toHaveCount(0);
    await page.evaluate(() => {
      document.documentElement.dataset.styleViewportReady = "false";
      window.addEventListener(
        "resize",
        () => {
          document.documentElement.dataset.styleViewportReady = "true";
        },
        { once: true },
      );
    });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForFunction(
      () => document.documentElement.dataset.styleViewportReady === "true",
    );
    await style.selectOption("more");
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    if (!bounds) throw new Error("更多段落样式菜单未显示");
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(792);
    const toolbarBounds = await page.getByRole("toolbar", { name: "常用工具" }).boundingBox();
    if (!toolbarBounds) throw new Error("工具栏未显示");
    expect(Math.abs(bounds.y - toolbarBounds.y - toolbarBounds.height)).toBeLessThan(2);
    await menu.getByRole("menuitemradio", { name: "标题 3" }).click();
    await expect(editor.locator("h3")).toHaveText("保留旧标题");
    expect(
      await editor.evaluate(
        (element) => (element as HTMLElement & { editor: Editor }).editor.getJSON().content?.[0],
      ),
    ).toEqual(originalBody);
    await page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".status-bar").getByRole("status", { name: "已保存" })).toBeVisible();
    await page.getByRole("button", { name: "关闭段落样式验收" }).click();
    const patentCard = page.getByRole("article", { name: "段落样式验收", exact: true });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(editor.locator("h3")).toHaveText("保留旧标题");
    for (const book of ["权利要求书", "说明书摘要", "说明书附图", "摘要附图"]) {
      await page.getByRole("tab", { name: book, exact: true }).click();
      expect(await style.locator("option").allTextContents()).toEqual(["正文"]);
    }
  } finally {
    await application.close();
  }
});

test("keeps all five book toolbars identical and disables unsupported image insertion even in overflow", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await createPatent(page, "五书工具栏一致性验收");
    const toolbar = page.getByRole("toolbar", { name: "常用工具" });
    const controls = () =>
      toolbar.locator("button[aria-label],select[aria-label]").evaluateAll((elements) =>
        elements
          .filter((element) => element.getAttribute("aria-label") !== "更多工具")
          .map((element) => ({
            label: element.getAttribute("aria-label"),
            x: element.getBoundingClientRect().x,
            visible: element.getBoundingClientRect().width > 0,
          })),
      );
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const expected = await controls();
    expect(expected.every((control) => control.visible)).toBe(true);
    for (const name of ["权利要求书", "说明书", "说明书摘要", "说明书附图", "摘要附图"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect.poll(controls).toEqual(expected);
      const image = toolbar.getByRole("button", { name: "插入图片", exact: true });
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute(
        "aria-disabled",
        name === "说明书摘要" || name === "摘要附图" ? "true" : "false",
      );
    }

    await page.getByRole("tab", { name: "说明书摘要", exact: true }).click();
    await clickGreyedTool(page, toolbar.getByRole("button", { name: "插入图片", exact: true }));
    const notice = page.getByRole("dialog").filter({ hasText: "当前书册不支持插入图片。" });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "知道了" }).click();

    await page.setViewportSize({ width: 800, height: 900 });
    for (const name of ["权利要求书", "说明书", "说明书摘要", "说明书附图", "摘要附图"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await toolbar.getByRole("button", { name: "更多工具", exact: true }).click();
      const image = page
        .getByRole("menu", { name: "更多编辑工具" })
        .getByRole("menuitem", { name: "插入图片", exact: true });
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute(
        "aria-disabled",
        name === "说明书摘要" || name === "摘要附图" ? "true" : "false",
      );
      if (name === "说明书摘要") {
        await clickGreyedTool(page, image);
        await expect(notice).toBeVisible();
        await notice.getByRole("button", { name: "知道了" }).click();
      }
      await page.keyboard.press("Escape");
    }
  } finally {
    await application.close();
  }
});

// 附图书册没有正文排版：文字工具要留在原位、置灰、点不动，而不是整组消失。
test("keeps the unavailable text tools visible but greyed out on the patent drawing books", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    // 宽窗口下工具栏不会溢出收起，所有图标都应当在场。
    await page.setViewportSize({ width: 1920, height: 900 });
    await createPatent(page, "附图工具栏置灰验收");

    const toolbar = page.getByRole("toolbar", { name: "常用工具" });
    const expectGreyed = async (label: string) => {
      const button = toolbar.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("aria-disabled", "true");
    };

    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();

    for (const name of ["段落样式", "字体", "字号"]) {
      const select = toolbar.getByRole("combobox", { name, exact: true });
      await expect(select).toBeVisible();
      await expect(select).toHaveAttribute("aria-disabled", "true");
    }
    for (const label of [
      "粗体",
      "斜体",
      "下划线",
      "下标",
      "上标",
      "项目符号",
      "编号",
      "插入表格",
      "查找",
      "替换",
      "本地检查",
      "AI 纠错",
      "小栈AI助手",
    ]) {
      await expectGreyed(label);
    }
    // 「更多工具」本身是可用的容器（窄窗口里那些置灰工具会收进去），不能跟着置灰。
    const moreTools = toolbar.getByRole("button", { name: "更多工具", exact: true });
    if (await moreTools.count()) await expect(moreTools).toBeEnabled();

    // 真实鼠标点击置灰按钮不会打开对应工具。
    const disabledCheck = await toolbar
      .getByRole("button", { name: "本地检查", exact: true })
      .boundingBox();
    if (!disabledCheck) throw new Error("Missing disabled inspection button");
    await page.mouse.click(
      disabledCheck.x + disabledCheck.width / 2,
      disabledCheck.y + disabledCheck.height / 2,
    );
    const notice = page
      .getByRole("dialog")
      .filter({ hasText: "当前页面不是文本编辑页面，无法使用此功能。" });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "知道了" }).click();
    await expect(page.getByRole("complementary", { name: "本地检查" })).toHaveCount(0);

    // 附图自己的动作不受影响，且不会出现「置灰版 + 可用版」两份同名按钮。
    for (const label of ["CAD标号", "插入图片", "插入流程图", "电路图"]) {
      const button = toolbar.getByRole("button", { name: label, exact: true });
      await expect(button).toHaveCount(1);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("aria-disabled", "false");
    }
    for (const label of ["插入数学公式", "插入物理公式", "插入化学方程式", "插入化学结构式"]) {
      const button = toolbar.getByRole("button", { name: label, exact: true });
      await expect(button).toHaveCount(1);
      await expect(button).toHaveAttribute("aria-disabled", "false");
    }

    // 摘要附图同样置灰留守。
    await page.getByRole("tab", { name: "摘要附图", exact: true }).click();
    await expectGreyed("粗体");
    await expectGreyed("插入表格");
    await expect(toolbar.getByRole("combobox", { name: "段落样式", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // 回到文本书册，工具恢复可用。
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(toolbar.getByRole("button", { name: "粗体", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await expect(toolbar.getByRole("combobox", { name: "段落样式", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  } finally {
    await application.close();
  }
});
