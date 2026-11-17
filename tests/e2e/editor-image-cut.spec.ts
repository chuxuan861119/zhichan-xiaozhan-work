import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("patent editor image cut and paste preserves content", async ({ workbench }) => {
  test.setTimeout(90000);
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("剪切图片审计样本");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    const reminder = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await reminder.isVisible()) await reminder.click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    const bytes = [...(await readFile(join(process.cwd(), "tests/fixtures/images/sample.png")))];
    await editor.evaluate((element, bytes) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "图片前文" }] },
          { type: "paragraph", content: [{ type: "text", text: "图片后文" }] },
        ],
      });
      e.commands.setTextSelection(6);
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "sample.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    }, bytes);
    const imageCount = () =>
      editor.evaluate((element) => {
        let count = 0;
        (element as HTMLElement & { editor: Editor }).editor.state.doc.descendants((n) => {
          if (n.type.name === "figure" || n.type.name === "inlineFigure") count++;
        });
        return count;
      });
    await expect.poll(imageCount).toBe(1);
    const results = [];
    for (const operation of ["cut"] as const) {
      const result = await editor.evaluate((element, operation) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        e.commands.selectAll();
        const clipboardData = new DataTransfer();
        element.dispatchEvent(
          new ClipboardEvent(operation, { bubbles: true, cancelable: true, clipboardData }),
        );
        const types = [...clipboardData.types];
        e.commands.setTextSelection(Math.max(1, e.state.doc.content.size - 1));
        element.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
        );
        let images = 0;
        e.state.doc.descendants((n) => {
          if (n.type.name === "figure" || n.type.name === "inlineFigure") images++;
        });
        return { operation, types, images, text: e.getText() };
      }, operation);
      results.push(result);
    }
    expect(results[0]?.images).toBe(1);
    expect(results[0]?.text).toContain("图片前文");
    expect(results[0]?.text).toContain("图片后文");
  } finally {
    await app.close();
  }
});
