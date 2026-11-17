import { expect, test } from "./helpers/workbench.js";

test("creates and edits a blank custom template from the library without an open patent", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).waitFor();
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => {
      window.unmaximize();
      window.setSize(1100, 720);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1100);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "默认模板", exact: true }).click();
    const open = settings.getByRole("button", { name: "打开默认模板设置" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "默认模板设置", exact: true });
    await expect(dialog.getByText("自定义模板 1", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "新建自定义模板" }).click();
    const card = dialog.locator("article.template-catalog-card.is-selected");
    const more = card.getByRole("button", { name: "自定义模板 1更多操作" });
    const heading = await card.locator("strong").boundingBox();
    const moreBox = await more.boundingBox();
    if (!heading || !moreBox) throw new Error("Missing card heading");
    expect(Math.abs(heading.y + heading.height / 2 - moreBox.y - moreBox.height / 2)).toBeLessThan(
      8,
    );
    expect(moreBox.x).toBeGreaterThan(heading.x + heading.width);
    const activateBox = await card
      .getByRole("button", { name: "设为当前模板", exact: true })
      .boundingBox();
    const blankActivateBox = await dialog
      .locator(".template-catalog-card--simple")
      .first()
      .getByRole("button", { name: "设为当前模板", exact: true })
      .boundingBox();
    if (!activateBox || !blankActivateBox) throw new Error("Missing activation buttons");
    expect(
      Math.abs(activateBox.x + activateBox.width - blankActivateBox.x - blankActivateBox.width),
    ).toBeLessThan(2);
    const addButton = dialog.getByRole("button", { name: "新建自定义模板" });
    const plusBox = await addButton.locator("svg").boundingBox();
    const labelBox = await addButton.locator("span").boundingBox();
    if (!plusBox || !labelBox) throw new Error("Missing add icon/label");
    expect(
      Math.abs(plusBox.y + plusBox.height / 2 - labelBox.y - labelBox.height / 2),
    ).toBeLessThan(1);
    await more.click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    const renameInput = card.getByRole("textbox", { name: "重命名自定义模板 1" });
    await renameInput.fill("不应保留");
    await card.getByRole("button", { name: "取消", exact: true }).click();
    await expect(card.locator("strong")).toHaveText("自定义模板 1");
    await more.click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await renameInput.fill("");
    await expect(card.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
    await renameInput.fill("常用模板");
    await card.getByRole("button", { name: "确认", exact: true }).click();
    await expect(card.locator("strong")).toHaveText("常用模板");
    const dialogBox = await dialog.boundingBox();
    const editorBox = await dialog.locator(".template-catalog__editor-viewport").boundingBox();
    if (!dialogBox || !editorBox) throw new Error("Missing template editor bounds");
    expect(dialogBox.y).toBeGreaterThanOrEqual(38);
    for (const hint of [
      "三书内容可以继续编辑",
      "两种专利分别选择和编辑模板。",
      "普通图片不会保存",
      "已保存三书内容",
      "新建三书时不预填正文",
    ]) {
      await expect(dialog.getByText(hint, { exact: true })).toHaveCount(0);
    }
    expect(editorBox.height / dialogBox.height).toBeGreaterThan(0.65);
    const sharingBox = await dialog
      .getByRole("switch", { name: "发明与实用新型分别设置" })
      .boundingBox();
    if (!sharingBox) throw new Error("Missing sharing switch bounds");
    expect(sharingBox.x + sharingBox.width).toBeLessThan(editorBox.x);
    await dialog.screenshot({ path: "out-template-layout-preview.png" });
    for (const name of ["权利要求书", "说明书", "说明书摘要"]) {
      await dialog.getByRole("tab", { name, exact: true }).click();
      const editor = dialog.getByRole("textbox", { name: `编辑 ${name}`, exact: true });
      await expect(editor).toBeEditable();
      await expect(editor).toHaveText("");
      await editor.fill(`${name}自定义内容`);
    }
    await dialog
      .locator("article.template-catalog-card.is-selected")
      .getByRole("button", { name: "设为当前模板", exact: true })
      .click();
    await expect(card.locator(".template-catalog-card__current")).toHaveCSS(
      "color",
      "rgb(21, 128, 61)",
    );
    for (let index = 2; index <= 5; index++) {
      await dialog.getByRole("button", { name: "新建自定义模板" }).click();
      await expect(card.locator("strong")).toHaveText(`自定义模板 ${index}`);
    }
    await expect(dialog.getByRole("button", { name: "新建自定义模板" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open.click();
    await expect(dialog.locator("article.template-catalog-card")).toHaveCount(7);
    for (const name of ["权利要求书", "说明书", "说明书摘要"]) {
      await dialog.getByRole("tab", { name, exact: true }).click();
      await expect(dialog.getByRole("textbox", { name: `编辑 ${name}`, exact: true })).toHaveText(
        `${name}自定义内容`,
      );
    }
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    // Isolated disposable test data; avoid an unsaved-settings prompt blocking failure teardown.
    await application.evaluate(({ app }) => app.exit()).catch(() => undefined);
    await application.close().catch(() => undefined);
  }
});

test("shared default templates can be switched, saved and reopened without compressing the editor", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "默认模板", exact: true }).click();
    const open = settings.getByRole("button", { name: "打开默认模板设置" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "默认模板设置", exact: true });
    const toggle = dialog.getByRole("switch", { name: "发明与实用新型分别设置" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("tablist", { name: "专利类型" })).toHaveCount(0);
    await toggle.click();
    await expect(dialog.getByRole("tab", { name: "实用新型", exact: true })).toBeVisible();
    const workspace = await dialog.locator(".template-catalog-dialog__workspace").boundingBox();
    expect(workspace?.height).toBeGreaterThan(200);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    const confirm = page.getByRole("dialog", { name: "请确认", exact: true });
    await expect(confirm).toContainText("实用新型模板会保留");
    await confirm.getByRole("button", { name: "确定", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("tablist", { name: "专利类型" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    await application.close().catch(() => undefined);
  }
});
