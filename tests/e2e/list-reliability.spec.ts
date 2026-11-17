import type { Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expect, test } from "./helpers/workbench.js";

async function selectText(editor: Locator, text: string) {
  await editor.evaluate((element, selected) => {
    const instance = (element as HTMLElement & { editor: Editor }).editor;
    let pos = -1;
    instance.state.doc.descendants((node, position) => {
      if (node.text === selected) pos = position;
    });
    if (pos < 0) throw new Error(`Missing text ${selected}`);
    instance.commands.focus();
    instance.commands.setTextSelection({ from: pos, to: pos + selected.length });
  }, text);
}

for (const tag of ["ul", "ol"] as const) {
  test(`${tag} toolbar changes only selected items, can remove the middle item, and saves valid documents`, async ({
    workbench,
  }) => {
    const app = await workbench.launchAllowMultipleInstances();
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1920, height: 1080 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
      if (await welcome.isVisible()) await welcome.click();
      const name = `${tag}列表可靠性测试`;
      await page.getByRole("button", { name: "新建专利（加号）", exact: true }).click();
      const create = page.getByRole("dialog", { name: "新建专利" });
      await create.getByRole("textbox", { name: "专利名称" }).fill(name);
      await create.getByRole("radio", { name: "发明", exact: true }).check();
      await create.getByRole("button", { name: "创建专利", exact: true }).click();
      await expect(create).toBeHidden();
      const later = page.getByRole("button", { name: "稍后设置", exact: true });
      if (await later.isVisible()) await later.click();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
      let editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
      await editor.evaluate((element, listTag) => {
        (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
          `<${listTag}><li><p>甲</p></li><li><p><strong>乙</strong></p></li><li><p>丙</p></li></${listTag}>`,
        );
      }, tag);
      await selectText(editor, "乙");
      const other = tag === "ul" ? "ol" : "ul";
      await page
        .getByRole("button", { name: tag === "ul" ? "编号" : "项目符号", exact: true })
        .click();
      await expect(editor.locator(`:scope > ${tag}`)).toHaveCount(2);
      await expect(editor.locator(`:scope > ${other}`)).toHaveCount(1);
      await expect(editor.locator(`:scope > ${other} strong`)).toHaveText("乙");
      await expect(editor.locator(`:scope > ${tag}`).first()).toHaveText("甲");
      await expect(editor.locator(`:scope > ${tag}`).last()).toHaveText("丙");
      if (tag === "ol")
        await expect(editor.locator(":scope > ol").last()).toHaveAttribute("start", "3");
      await selectText(editor, "乙");
      await page
        .getByRole("button", { name: tag === "ul" ? "编号" : "项目符号", exact: true })
        .click();
      await expect(editor.locator(":scope > p").filter({ hasText: "乙" })).toHaveCount(1);
      await expect(page.locator(".operation-feedback-backdrop")).toHaveCount(0);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
      await page
        .getByRole("article", { name, exact: true })
        .getByRole("button", { name: "更多操作" })
        .click();
      await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
      editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
      await expect(editor.locator(`:scope > ${tag}`)).toHaveCount(2);
      await expect(editor.locator(":scope > p strong")).toHaveText("乙");
      if (tag === "ol")
        await expect(editor.locator(":scope > ol").last()).toHaveAttribute("start", "3");
      await expect(page.locator(".operation-feedback-backdrop")).toHaveCount(0);

      await editor.evaluate((element) => {
        (element as HTMLElement & { editor: Editor }).editor.commands.insertTable({
          rows: 1,
          cols: 1,
          withHeaderRow: false,
        });
      });
      await editor.locator("td p").click();
      for (const label of ["项目符号", "编号"]) {
        await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
      }
      const before = await editor.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.getJSON(),
      );
      await editor.press(process.platform === "darwin" ? "Meta+Shift+7" : "Control+Shift+7");
      expect(
        await editor.evaluate((element) =>
          (element as HTMLElement & { editor: Editor }).editor.getJSON(),
        ),
      ).toEqual(before);
      expect(
        await app.evaluate(({ BaseWindow }) =>
          BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
}

test("list boundaries, reconnecting numbering and paste survive save and reopen", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    const name = "列表边界回归";
    await page.getByRole("button", { name: "新建专利（加号）", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill(name);
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    let editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await editor.evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
        "<p>甲</p><p>乙</p><p>丙</p>",
      );
    });
    for (const text of ["甲", "乙", "丙"]) {
      await selectText(editor, text);
      await page.getByRole("button", { name: "编号", exact: true }).click();
    }
    await expect(editor.locator(":scope > ol")).toHaveCount(1);
    await expect(editor.locator("ol > li")).toHaveCount(3);
    await selectText(editor, "乙");
    await page.getByRole("button", { name: "编号", exact: true }).click();
    await expect(editor.locator(":scope > ol")).toHaveCount(2);
    await page.getByRole("button", { name: "编号", exact: true }).click();
    await expect(editor.locator(":scope > ol")).toHaveCount(1);
    await expect(editor.locator("ol > li")).toHaveCount(3);

    await editor.evaluate((element) => {
      const instance = (element as HTMLElement & { editor: Editor }).editor;
      const positions: Record<string, number> = {};
      instance.state.doc.descendants((node, pos) => {
        if (node.isText && node.text) positions[node.text] = pos;
      });
      const from = positions.甲;
      const to = positions.乙;
      if (from === undefined || to === undefined) throw new Error("Missing boundary fixture text");
      instance.commands.setTextSelection({ from, to });
    });
    await page.getByRole("button", { name: "项目符号", exact: true }).click();
    await expect(editor.locator(":scope > ul")).toHaveText("甲");
    await expect(editor.locator(":scope > ol")).toHaveText("乙丙");
    await expect(editor.locator(":scope > ol")).toHaveAttribute("start", "2");
    await editor.evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.selectAll();
    });
    await page.getByRole("button", { name: "项目符号", exact: true }).click();
    await expect(editor.locator(":scope > ul > li")).toHaveCount(3);
    await page.getByRole("button", { name: "编号", exact: true }).click();
    await expect(editor.locator(":scope > ol > li")).toHaveCount(3);

    await editor.evaluate((element) => {
      const instance = (element as HTMLElement & { editor: Editor }).editor;
      const positions: Record<string, number> = {};
      instance.state.doc.descendants((node, pos) => {
        if (node.isText && node.text) positions[node.text] = pos;
      });
      const from = positions.乙;
      const last = positions.丙;
      if (from === undefined || last === undefined) throw new Error("Missing paste fixture text");
      instance.commands.setTextSelection({ from, to: last + 1 });
      const copied = instance.view.serializeForClipboard(instance.state.selection.content());
      const html = copied.dom.innerHTML;
      const text = copied.text;
      instance.commands.setContent("<p>正文</p>");
      instance.commands.setTextSelection(3);
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    await expect(editor.locator(":scope > ol")).toHaveAttribute("start", "2");
    await expect(editor.locator(":scope > ol > li")).toHaveCount(2);
    await expect(editor.locator(":scope > ol")).toHaveText("乙丙");
    await expect(editor.locator(":scope > p").filter({ hasText: "正文" })).toHaveCount(1);
    await expect(page.locator(".operation-feedback-backdrop")).toHaveCount(0);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    await page
      .getByRole("article", { name, exact: true })
      .getByRole("button", { name: "更多操作" })
      .click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor.locator(":scope > ol")).toHaveAttribute("start", "2");
    await expect(editor.locator(":scope > ol > li")).toHaveCount(2);
    await expect(editor.locator(":scope > ol")).toHaveText("乙丙");
    expect(
      await app.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
