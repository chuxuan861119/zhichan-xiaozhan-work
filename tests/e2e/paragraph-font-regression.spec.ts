import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

test("paragraph title and legal font sizes survive actual editor operations", async ({
  workbench,
}) => {
  const patent = createBlankPatent({ patentType: "invention", name: "段落字体验收" });
  const claims = patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("Missing claims");
  const title = createBlankDocument("title").content[0];
  const body = createBlankDocument("body").content[0];
  if (title?.type !== "paragraph" || body?.type !== "paragraph")
    throw new Error("Missing paragraphs");
  title.attrs = {
    ...title.attrs,
    alignment: "center",
    paragraphIndentMm: 0,
    defaultFontFamily: "SimSun",
    defaultFontSizePt: 18,
  };
  title.content = [{ type: "text", text: "专利题目", marks: [] }];
  body.content = [
    { type: "text", text: "小字", marks: [{ type: "font-size", valuePt: 6 }] },
    { type: "text", text: "大字", marks: [{ type: "font-size", valuePt: 96 }] },
  ];
  claims.document.content = [title, body];
  const source = join(workbench.root, "paragraph-font.patdoc");
  await writePatdoc(source, { patent, assets: [] });
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1200 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    for (const name of ["暂不创建", "稍后设置"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible()) await button.click();
    }
    await application.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await expect(editor.locator('[data-font-size-pt="6"]')).toHaveCSS("font-size", "8px");
    await expect(editor.locator('[data-font-size-pt="96"]')).toHaveCSS("font-size", "128px");
    await editor.locator(":scope > p").first().click();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await expect(page.getByRole("combobox", { name: "字体", exact: true })).toHaveValue(
      process.platform === "darwin" ? "PingFang SC" : "SimSun",
    );
    await expect(page.getByRole("combobox", { name: "字号", exact: true })).toHaveValue("18");
    await editor.press("Enter");
    await expect(editor.locator(":scope > p")).toHaveCount(3);
    await expect(editor.locator(":scope > p").nth(1)).toHaveText("专利题目");
    await expect(editor.locator(":scope > p").nth(1)).toHaveCSS("text-align", "center");
    await expect(editor.locator(":scope > p").nth(1)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "0",
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(editor.locator(":scope > p")).toHaveCount(2);
    await editor.locator(":scope > p").first().click();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        editor.evaluate(
          (element) =>
            (element as HTMLElement & { editor: Editor }).editor.state.selection.$from.parentOffset,
        ),
      )
      .toBe(4);
    await editor.press("Enter");
    await expect(editor.locator(":scope > p").nth(1)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "9.88",
    );
    await expect(editor.locator(":scope > p").nth(1)).toHaveCSS("text-align", "justify");
    // Removing an indent affects only the current paragraph, not the next one.
    await editor.press("Backspace");
    await expect(editor.locator(":scope > p").nth(1)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "0",
    );
    await editor.press("Enter");
    await expect(editor.locator(":scope > p").nth(2)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "9.88",
    );
    await expect(editor.locator(":scope > p").nth(1)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "0",
    );
    await editor.press("Enter");
    await expect(editor.locator(":scope > p").nth(3)).toHaveAttribute(
      "data-paragraph-indent-mm",
      "9.88",
    );
  } finally {
    await application.close();
  }
});
