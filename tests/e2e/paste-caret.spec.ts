import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

for (const format of ["plain", "html"] as const) {
  test(`continues typing in the last pasted paragraph in all text books (${format})`, async ({
    workbench,
  }) => {
    const patent = createBlankPatent({ patentType: "invention", name: "粘贴光标验证" });
    for (const book of patent.books) {
      if (!["claims", "description", "abstract"].includes(book.kind)) continue;
      book.document.content = ["前文", "", "后文"].map((text) => {
        const paragraph = createBlankDocument("fixture").content[0];
        if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph fixture");
        paragraph.content = text ? [{ type: "text", text, marks: [] }] : [];
        return paragraph;
      });
    }
    const source = join(workbench.root, "paste.patdoc");
    await writePatdoc(source, { patent, assets: [] });
    const app = await workbench.launchAllowMultipleInstances();
    try {
      const page = await app.firstWindow();
      // A hidden window otherwise suppresses ProseMirror's native selection updates.
      // Emulate page focus only; never activate the operating-system window.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
      if (await welcome.isVisible())
        await welcome.getByRole("button", { name: "暂不创建" }).click();
      await app.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        });
      }, source);
      await page.getByRole("button", { name: "导入", exact: true }).click();
      await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();
      for (const title of ["权利要求书", "说明书", "说明书摘要"]) {
        await page.getByRole("tab", { name: title, exact: true }).click();
        const editor = page.getByRole("textbox", { name: `编辑 ${title}` });
        await editor.locator(":scope > p").nth(1).click();
        await editor.press("Control+Home");
        await editor.press("ArrowDown");
        await expect
          .poll(() =>
            editor.evaluate((element) => {
              const anchor = element.ownerDocument.getSelection()?.anchorNode;
              return (
                anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element)
              )?.closest("p")?.textContent;
            }),
          )
          .toBe("");
        // Exercise the real renderer paste event without replacing the user's system clipboard.
        await expect
          .poll(() =>
            editor.evaluate(
              (element) =>
                (element as HTMLElement & { editor: Editor }).editor.state.selection.from,
            ),
          )
          .toBe(5);
        await editor.evaluate((element, clipboardFormat) => {
          const data = new DataTransfer();
          data.setData("text/plain", "第一段\n第二段");
          if (clipboardFormat === "html") {
            data.setData("text/html", '<p style="text-align:center">第一段</p><p>第二段</p>');
          }
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, format);
        await expect
          .poll(() =>
            editor.evaluate((element) => {
              const selection = element.ownerDocument.getSelection();
              const anchor = selection?.anchorNode;
              return { text: anchor?.textContent, offset: selection?.anchorOffset };
            }),
          )
          .toEqual({ text: "第二段", offset: 3 });
        await page.keyboard.insertText("继续输入");
        await expect(editor.locator(":scope > p")).toHaveText([
          "前文",
          "第一段",
          "第二段继续输入",
          "后文",
        ]);
      }
    } finally {
      await app.close();
    }
  });
}
