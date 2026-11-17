import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("preserves editing intent across search, science dialogs, font sizes and paste undo", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const patent = createBlankPatent({ patentType: "invention", name: "编辑交互回归" });
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("Missing description");
  description.document.content = ["原有文字", "查找目标甲；查找目标乙。", "字号示例"].map(
    (text, index) => {
      const paragraph = createBlankDocument("fixture").content[0];
      if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
      paragraph.content = [
        { type: "text", text, marks: index === 2 ? [{ type: "font-size", valuePt: 16 }] : [] },
      ];
      return paragraph;
    },
  );
  const source = join(workbench.root, "interactions.patdoc");
  await writePatdoc(source, { patent, assets: [] });
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await dismissWorkbenchWelcome(page);
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page.getByRole("button", { name: "继续导入", exact: true }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor.locator(":scope > p")).toHaveText([
      "原有文字",
      "查找目标甲；查找目标乙。",
      "字号示例",
    ]);
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      let from = 0;
      e.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "字号示例") from = pos;
      });
      e.commands.setTextSelection({ from, to: from + 4 });
      e.commands.focus();
    });
    await expect(page.getByRole("combobox", { name: "字号", exact: true })).toHaveValue("16");

    await editor.evaluate((element) =>
      (element as HTMLElement & { editor: Editor }).editor.commands.setTextSelection(1),
    );
    const beforeFind = await editor.locator(":scope > p").allTextContents();
    await editor.press("Control+f");
    const query = page.getByRole("textbox", { name: "查找内容", exact: true });
    await query.fill("查找目标");
    for (const [key, from] of [
      ["Enter", 7],
      ["Enter", 13],
      ["Shift+Enter", 7],
    ] as const) {
      // Do not refocus the input between Enter presses: that would hide a focus regression.
      await page.keyboard.press(key);
      await expect(query).toBeFocused();
      await expect
        .poll(() =>
          editor.evaluate(
            (element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.from,
          ),
        )
        .toBe(from);
      await expect(editor.locator(":scope > p")).toHaveText(beforeFind);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("search", { name: "查找和替换" })).toBeHidden();
    await expect(editor).toBeFocused();

    for (const name of ["插入数学公式", "插入化学方程式"]) {
      await editor.press("Control+Home");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(editor).toBeFocused();
      const caret = () =>
        editor.evaluate(
          (element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.from,
        );
      await expect.poll(caret).toBe(3);
      await page.getByRole("button", { name: "更多工具", exact: true }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeVisible();
      await expect.poll(caret).toBe(3);
      if (name === "插入数学公式") {
        const field = dialog.getByRole("textbox", { name: "可视公式编辑器" });
        await field.evaluate((element) => {
          (element as HTMLElement & { value: string }).value = String.raw`\notASupportedCommand{x}`;
          element.dispatchEvent(new Event("input", { bubbles: true }));
        });
        for (const closeMethod of ["acknowledge", "cross", "escape"]) {
          await dialog.getByRole("button", { name: "确定", exact: true }).click();
          const alert = page.getByRole("alertdialog", { name: "无法插入公式" });
          await expect(alert).toBeVisible();
          await expect(alert).toHaveCSS("pointer-events", "auto");
          if (closeMethod === "escape") await page.keyboard.press("Escape");
          else
            await alert
              .getByRole("button", {
                name: closeMethod === "cross" ? "关闭错误提示" : "知道了",
                exact: true,
              })
              .click();
          await expect(alert).toBeHidden();
          await expect(dialog).toBeVisible();
          await expect
            .poll(() =>
              field.evaluate((element) => (element as HTMLElement & { value: string }).value),
            )
            .toContain("notASupportedCommand");
        }
      }
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(editor).toBeFocused();
      await expect.poll(caret).toBe(3);
      await page.keyboard.insertText("续");
      await expect(editor.locator(":scope > p").first()).toHaveText(
        name === "插入数学公式" ? "原有续文字" : "原有续续文字",
      );
    }
    // A cached, hidden science dialog must not block focus after switching books.
    await page.getByRole("tab", { name: "说明书摘要", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书摘要", exact: true })).toBeFocused();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(editor).toBeFocused();

    // Establish a fresh baseline, then type/paste/type in one event turn (no timing gaps).
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setContent("<p>原有</p>");
      e.commands.setTextSelection(3);
    });
    await page.waitForTimeout(600);
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.insertContent("手打");
      const data = new DataTransfer();
      data.setData("text/plain", "粘贴");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      e.commands.insertContent("后打");
    });
    await expect(editor).toHaveText("原有手打粘贴后打");
    for (const text of ["原有手打粘贴", "原有手打", "原有"]) {
      await page.keyboard.press("Control+z");
      await expect(editor).toHaveText(text);
    }
    for (const text of ["原有手打", "原有手打粘贴", "原有手打粘贴后打"]) {
      await page.keyboard.press("Control+Shift+z");
      await expect(editor).toHaveText(text);
    }
  } finally {
    await app.close();
  }
});
