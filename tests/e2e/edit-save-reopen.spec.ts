import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { FileService } from "../../src/main/documents/file-service.js";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import type { BlockNode, TextMark } from "../../src/shared/document/model.js";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function insertFormula(page: Page, source: string, mode: "inline" | "block"): Promise<void> {
  await page.getByRole("button", { name: "插入公式" }).click();
  const dialog = page.getByRole("dialog", { name: "插入公式" });
  await dialog.getByRole("button", { name: "LaTeX 源码" }).click();
  if (mode === "block") await dialog.getByRole("radio", { name: "独立公式" }).check();
  await dialog.getByRole("textbox", { name: "LaTeX 源码" }).fill(source);
  await dialog.getByRole("button", { name: "确定" }).click();
}

function allMarks(content: BlockNode[]): Set<TextMark["type"]> {
  const marks = new Set<TextMark["type"]>();
  const visitParagraphs = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph" || block.type === "heading") {
        for (const inline of block.content) {
          if (inline.type === "text") for (const mark of inline.marks) marks.add(mark.type);
        }
      } else if (block.type === "bullet-list" || block.type === "ordered-list") {
        for (const item of block.items) {
          for (const paragraph of item.content) {
            for (const inline of paragraph.content) {
              if (inline.type === "text") for (const mark of inline.marks) marks.add(mark.type);
            }
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            for (const paragraph of cell.content) {
              for (const inline of paragraph.content) {
                if (inline.type === "text") for (const mark of inline.marks) marks.add(mark.type);
              }
            }
          }
        }
      }
    }
  };
  visitParagraphs(content);
  return marks;
}

test.skip("creates two tabs and round-trips rich patent content through a patdoc association", async ({
  workbench,
}) => {
  const filePath = join(workbench.root, "核心编辑往复.patdoc");
  const blank = createBlankDocument("核心编辑往复");
  const saved = await new FileService().saveDocument(filePath, {
    document: blank,
    settings: {},
    editorState: {},
    assets: [],
  });
  expect(saved.ok).toBe(true);

  let application = await workbench.launch(filePath);
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByRole("tab")).toHaveCount(2);
    const editor = page.getByRole("textbox", { name: "编辑 核心编辑往复" });
    await editor.fill("中文 Latin ");

    for (const [label, text] of [
      ["粗体", "粗体"],
      ["斜体", "斜体"],
      ["下划线", "下划线"],
    ] as const) {
      await page.getByRole("button", { name: label }).click();
      await editor.type(text);
      await page.getByRole("button", { name: label }).click();
    }
    await page.getByRole("combobox", { name: "字体" }).selectOption("Microsoft YaHei");
    await editor.type("微软雅黑");
    await page.getByRole("combobox", { name: "字体" }).selectOption("SimSun");
    await page.getByRole("combobox", { name: "字号" }).selectOption("14");
    await editor.type("四号");
    await page.getByRole("combobox", { name: "字号" }).selectOption("12");
    await page.getByLabel("文字颜色").fill("#123456");
    await editor.type("彩色");
    await page.getByLabel("文字颜色").fill("#111827");
    await page.getByRole("button", { name: "下标" }).click();
    await editor.type("2");
    await page.getByRole("button", { name: "下标" }).click();
    await page.getByRole("button", { name: "上标" }).click();
    await editor.type("2");
    await page.getByRole("button", { name: "上标" }).click();
    await expect(editor.locator("strong")).toHaveText("粗体");
    await expect(editor.locator("em")).toHaveText("斜体");
    await expect(editor.locator("u")).toHaveText("下划线");
    await expect(editor.locator("sub")).toHaveText("2");
    await expect(editor.locator("sup")).toHaveText("2");

    const imageBytes = await readFile(
      join(process.cwd(), "tests", "fixtures", "images", "sample.png"),
    );
    await editor.evaluate((element, bytes) => {
      type BrowserFile = new (
        parts: Uint8Array[],
        name: string,
        options: { type: string },
      ) => unknown;
      type BrowserTransfer = {
        items: { add(file: unknown): void };
      };
      const browser = globalThis as unknown as {
        DataTransfer: new () => BrowserTransfer;
        File: BrowserFile;
        ClipboardEvent: new (
          name: string,
          options: { bubbles: boolean; cancelable: boolean; clipboardData: BrowserTransfer },
        ) => Event;
      };
      const transfer = new browser.DataTransfer();
      transfer.items.add(
        new browser.File([Uint8Array.from(bytes)], "sample.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new browser.ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    }, Array.from(imageBytes));
    const figure = page.locator(".patent-figure");
    await expect(figure).toHaveCount(1);
    await figure.click();
    await editor.press("ArrowRight");

    await insertFormula(page, "E=mc^2", "inline");
    await insertFormula(page, String.raw`\frac{a}{b}`, "block");
    await editor.press("ArrowRight");
    await page.getByRole("button", { name: "插入分页符" }).click();
    await editor.press("ArrowRight");
    await page.getByRole("button", { name: "插入表格" }).click();
    await expect(editor.locator("table tr")).toHaveCount(3);
    await expect(editor.locator("table tr").first().locator("td")).toHaveCount(3);

    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("tab", { name: "核心编辑往复" })).not.toContainText("未保存");

    const opened = await new FileService().openDocument(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const content = opened.value.document.content;
    expect(allMarks(content)).toEqual(
      new Set([
        "bold",
        "italic",
        "underline",
        "subscript",
        "superscript",
        "font-family",
        "font-size",
        "color",
      ]),
    );
    expect(content.find((block) => block.type === "figure")).toMatchObject({
      type: "figure",
      rotationDeg: 0,
    });
    expect(content.find((block) => block.type === "table")).toMatchObject({
      type: "table",
      rows: [
        { cells: expect.any(Array) },
        { cells: expect.any(Array) },
        { cells: expect.any(Array) },
      ],
    });
    expect(content.some((block) => block.type === "page-break")).toBe(true);
    expect(content.find((block) => block.type === "block-formula")).toMatchObject({
      source: String.raw`\frac{a}{b}`,
    });
    expect(
      content.some(
        (block) =>
          (block.type === "paragraph" || block.type === "heading") &&
          block.content.some(
            (inline) => inline.type === "inline-formula" && inline.source === "E=mc^2",
          ),
      ),
    ).toBe(true);

    await application.close();
    application = await workbench.launch(filePath);
    const reopenedPage = await application.firstWindow();
    await expect(reopenedPage.getByRole("tab", { name: "核心编辑往复" })).toBeVisible();
    const reopenedEditor = reopenedPage.getByRole("textbox", { name: "编辑 核心编辑往复" });
    const reopenedPlainText = await reopenedEditor
      .locator("p")
      .first()
      .evaluate((paragraph) => {
        const clone = paragraph.cloneNode(true) as typeof paragraph;
        for (const formula of clone.querySelectorAll(
          '[data-type="inline-math"], [data-type="block-math"]',
        )) {
          formula.remove();
        }
        return (clone.textContent ?? "").replaceAll("\u200B", "");
      });
    expect(reopenedPlainText).toContain("中文 Latin");
    await expect(reopenedEditor.locator("strong")).toHaveText("粗体");
    await expect(reopenedEditor.locator("em")).toHaveText("斜体");
    await expect(reopenedEditor.locator("u")).toHaveText("下划线");
    await expect(reopenedEditor.locator("sub")).toHaveText("2");
    await expect(reopenedEditor.locator("sup")).toHaveText("2");
    const reopenedStyles = await reopenedEditor.evaluate((root) => {
      const styleFor = (text: string) => {
        const ownerDocument = root.ownerDocument;
        const walker = ownerDocument.createTreeWalker(root, 4);
        let node = walker.nextNode();
        while (node && node.textContent !== text) node = walker.nextNode();
        const element = node?.parentElement;
        if (!element) throw new Error(`找不到样式文本：${text}`);
        const style = ownerDocument.defaultView?.getComputedStyle(element);
        if (!style) throw new Error(`无法读取样式文本：${text}`);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          color: style.color,
          fontSizePt: element.getAttribute("data-font-size-pt"),
        };
      };
      return {
        font: styleFor("微软雅黑"),
        size: styleFor("四号"),
        color: styleFor("彩色"),
      };
    });
    expect(reopenedStyles.font.fontFamily).toContain("Microsoft YaHei");
    expect(reopenedStyles.size.fontSizePt).toBe("14");
    expect(reopenedStyles.color.color).toBe("rgb(18, 52, 86)");
    await expect(reopenedEditor.locator('[data-type="inline-math"]')).toHaveAttribute(
      "data-latex",
      "E=mc^2",
    );
    await expect(reopenedEditor.locator('[data-type="block-math"]')).toHaveAttribute(
      "data-latex",
      String.raw`\frac{a}{b}`,
    );
    await expect(reopenedEditor.locator(".patent-figure")).toHaveCount(1);
    await expect(reopenedEditor.locator(".patent-figure figcaption")).toHaveCount(0);
    await expect(reopenedEditor.locator("table tr")).toHaveCount(3);
    await expect(reopenedEditor.locator("table tr").first().locator("td")).toHaveCount(3);
    await expect(reopenedEditor.locator("table tr").nth(1).locator("td")).toHaveCount(3);
    await expect(reopenedEditor.locator("table tr").nth(2).locator("td")).toHaveCount(3);
    await expect(reopenedEditor.locator('[data-type="page-break"]')).toHaveCount(1);
  } finally {
    await application.close().catch(() => undefined);
  }
});
