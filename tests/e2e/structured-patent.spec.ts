import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

function bookTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function bookEditor(page: Page, name: string) {
  return page.getByRole("textbox", { name: `编辑 ${name}` });
}

async function replaceEditorText(page: Page, bookName: string, text: string): Promise<void> {
  const editor = bookEditor(page, bookName);
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function mockNativeDialogs(
  application: ElectronApplication,
  imagePaths: string[],
  exportPaths: string[],
): Promise<void> {
  await application.evaluate(
    ({ dialog }, paths) => {
      let exportIndex = 0;
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: paths.images }),
      });
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({
          canceled: false,
          filePath: paths.exports[exportIndex++],
        }),
      });
    },
    { images: imagePaths, exports: exportPaths },
  );
}

async function createPatent(page: Page, name: string, type: "发明" | "实用新型"): Promise<void> {
  const patentLibrary = page.getByRole("tab", { name: "专利库" });
  if (await patentLibrary.isVisible()) await patentLibrary.click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建专利" });
  await createDialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await createDialog.getByRole("radio", { name: type }).check();
  await createDialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

test("edits a free-text five-book patent, synchronizes drawing explanations, and exports", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const patentName = "结构化五书验收夹具";
  const pngPath = join(process.cwd(), "tests", "fixtures", "images", "sample.png");
  const jpegPath = join(process.cwd(), "tests", "fixtures", "images", "sample.jpg");
  const patdocPath = join(workbench.root, "五书整件验收.patdoc");
  const docxPath = join(workbench.root, "五书合并验收.docx");
  const pdfPath = join(workbench.root, "五书合并验收.pdf");
  const application = await workbench.launch();
  try {
    await mockNativeDialogs(application, [pngPath, jpegPath], [patdocPath, docxPath, pdfPath]);
    const page = await application.firstWindow();
    await dismissWelcome(page);

    await createPatent(page, patentName, "发明");

    await bookTab(page, "权利要求书").click();
    await expect(bookEditor(page, "权利要求书")).toContainText(`1. ${patentName}，其特征在于：`);
    await replaceEditorText(
      page,
      "权利要求书",
      `1. 一种${patentName}，其特征在于，包括回收箱和分拣机构。`,
    );

    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("技术领域");

    await bookTab(page, "说明书附图").click();
    await page.getByRole("button", { name: "导入图片" }).click();
    await expect(page.getByRole("article", { name: "图1" })).toBeVisible();
    await expect(page.getByRole("article", { name: "图2" })).toBeVisible();
    await page.getByRole("textbox", { name: "图1附图说明" }).fill("图1为本发明的整体结构示意图。");
    await page.getByRole("textbox", { name: "图2附图说明" }).fill("图2为本发明的局部结构示意图。");

    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("图1为本发明的整体结构示意图。");
    await expect(bookEditor(page, "说明书")).toContainText("图2为本发明的局部结构示意图。");

    await bookTab(page, "说明书摘要").click();
    await replaceEditorText(page, "说明书摘要", "本发明公开一种环保回收装置。");

    await bookTab(page, "摘要附图").click();
    await page.getByRole("combobox", { name: "摘要附图" }).selectOption({ label: "图2" });
    await expect(page.getByRole("article", { name: "摘要附图 图2" })).toBeVisible();

    await page.getByRole("button", { name: "保存" }).click();
    await expect(
      page.getByRole("tab", { name: patentName }).getByRole("status", { name: "已保存" }),
    ).toBeVisible();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await patentCard.getByRole("menuitem", { name: "继续编辑" }).click();
    await bookTab(page, "权利要求书").click();
    await expect(bookEditor(page, "权利要求书")).toContainText("包括回收箱和分拣机构");
    await bookTab(page, "说明书附图").click();
    await expect(page.getByRole("img", { name: "图1" })).toBeVisible();

    await page.getByRole("button", { name: "文件" }).click();
    await page.getByRole("menuitem", { name: "导出 PATDOC" }).click();
    await expect.poll(() => fileSize(patdocPath)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);
    const docxReport = page.getByRole("dialog", {
      name: /DOCX 导出(?:成功|报告|失败)/u,
    });
    await expect(docxReport).toBeVisible();
    await docxReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();

    await page.getByRole("button", { name: "文件" }).click();
    await page.getByRole("menuitem", { name: "导出 PDF" }).click();
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    await expect.poll(() => fileSize(pdfPath)).toBeGreaterThan(0);
    const pdfReport = page.getByRole("dialog", { name: /PDF 导出(?:成功|报告|失败)/u });
    await expect(pdfReport).toBeVisible();
    await pdfReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("uses saved default templates only for newly created patents", async ({ workbench }) => {
  test.setTimeout(90_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("button", { name: "默认模板" }).click();
    const templateDialog = settings.getByRole("region", { name: "默认模板内容" });
    await templateDialog.getByRole("tab", { name: "实用新型" }).click();
    await templateDialog.getByRole("tab", { name: "权利要求书" }).click();
    await templateDialog
      .getByLabel("模板正文")
      .fill("1. 一种{{patentName}}，其特征在于，包括测试模板部件。");
    await templateDialog.getByRole("button", { name: "保存模板" }).click();
    await settings.getByRole("button", { name: "关闭设置" }).last().click();

    await createPatent(page, "模板验收夹具", "实用新型");
    await bookTab(page, "权利要求书").click();
    await expect(bookEditor(page, "权利要求书")).toContainText("包括测试模板部件");

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "默认模板" }).click();
    const restoreDialog = settings.getByRole("region", { name: "默认模板内容" });
    await restoreDialog.getByRole("tab", { name: "实用新型" }).click();
    await restoreDialog.getByRole("tab", { name: "权利要求书" }).click();
    await restoreDialog.getByRole("button", { name: "恢复本项" }).click();
    await restoreDialog.getByRole("button", { name: "保存模板" }).click();
    await settings.getByRole("button", { name: "关闭设置" }).last().click();

    await createPatent(page, "恢复模板夹具", "实用新型");
    await bookTab(page, "权利要求书").click();
    await expect(bookEditor(page, "权利要求书")).toContainText("1. 恢复模板夹具，其特征在于：");
    await expect(bookEditor(page, "权利要求书")).not.toContainText("包括测试模板部件");
  } finally {
    await application.close().catch(() => undefined);
  }
});
