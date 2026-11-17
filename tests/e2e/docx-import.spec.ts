import { cp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { AlignmentType, Document, Header, ImageRun, Packer, Paragraph, TextRun } from "docx";
import sharp from "sharp";
import yauzl from "yauzl";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect(welcome).toBeHidden();
  }
}

async function writeDocx(path: string, paragraphs: readonly string[]): Promise<void> {
  const document = new Document({
    sections: [{ children: paragraphs.map((text) => new Paragraph({ text })) }],
  });
  await writeFile(path, await Packer.toBuffer(document));
}

async function writeRichDescriptionDocx(path: string): Promise<void> {
  const document = new Document({
    sections: [
      {
        headers: {
          default: new Header({
            children: [new Paragraph({ text: "页眉-说明书-不应进入正文" })],
          }),
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "一种测试装置", bold: true, size: 28 })],
          }),
          new Paragraph({ children: [new TextRun({ text: "技术领域", bold: true })] }),
          new Paragraph({ text: "本实用新型涉及测试装置技术领域。" }),
          new Paragraph({ children: [new TextRun({ text: "背景技术", bold: true })] }),
          new Paragraph({ text: "现有测试装置在连续运行时稳定性不足。" }),
          new Paragraph({ children: [new TextRun({ text: "实用新型内容", bold: true })] }),
          new Paragraph({ text: "本实用新型提供一种能够稳定运行的测试装置。" }),
        ],
      },
    ],
  });
  await writeFile(path, await Packer.toBuffer(document));
}

async function writeDrawingDocx(path: string): Promise<void> {
  const image = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "#2563EB" },
  })
    .png()
    .toBuffer();
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "图1" }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: "png",
                data: image,
                transformation: { width: 120, height: 120 },
              }),
            ],
          }),
        ],
      },
    ],
  });
  await writeFile(path, await Packer.toBuffer(document));
}

async function _fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function mockImportAndExportDialogs(
  application: ElectronApplication,
  importPaths: readonly string[],
  exportPaths: readonly string[] = [],
): Promise<void> {
  await application.evaluate(
    ({ dialog }, paths) => {
      let exportIndex = 0;
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: paths.imports }),
      });
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({
          canceled: false,
          filePath: paths.exports[exportIndex++],
        }),
      });
    },
    { imports: [...importPaths], exports: [...exportPaths] },
  );
}

async function openDocxImport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 DOCX", exact: true }).click();
  const notice = page.getByRole("dialog", { name: "DOCX 导入须知" });
  if (await notice.isVisible()) await notice.getByRole("button", { name: "继续导入" }).click();
  await expect(page.getByRole("dialog", { name: "导入docx" })).toBeVisible();
}

async function openPatentFromLibrary(page: Page, name: string): Promise<void> {
  const card = page.getByRole("article", { name });
  await card.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "继续编辑" }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
}

async function _docxDocumentXml(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(openError ?? new Error("无法读取 DOCX。"));
        return;
      }
      archive.once("error", reject);
      archive.on("entry", (entry) => {
        if (entry.fileName !== "word/document.xml") {
          archive.readEntry();
          return;
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error("无法读取 DOCX 正文。"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => {
            archive.close();
            resolvePromise(Buffer.concat(chunks).toString("utf8"));
          });
        });
      });
      archive.once("end", () => reject(new Error("DOCX 缺少 word/document.xml。")));
      archive.readEntry();
    });
  });
}

test("imports rich Word formatting and pictures without leaking headers into the patent", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const descriptionPath = join(workbench.root, "说明书.docx");
  const drawingsPath = join(workbench.root, "说明书附图.docx");
  const abstractDrawingPath = join(workbench.root, "摘要附图.docx");
  await writeRichDescriptionDocx(descriptionPath);
  await writeDrawingDocx(drawingsPath);
  await writeDrawingDocx(abstractDrawingPath);

  const application = await workbench.launch();
  try {
    await mockImportAndExportDialogs(application, [
      descriptionPath,
      drawingsPath,
      abstractDrawingPath,
    ]);
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await openDocxImport(page);
    const dialog = page.getByRole("dialog", { name: "导入docx" });
    await dialog.getByRole("button", { name: /说明书附图/u }).click();
    await expect(dialog.getByRole("img", { name: "导入图片预览" })).toBeVisible();
    await dialog.getByLabel("专利名称").fill("富文本DOCX导入验收");
    await dialog.getByRole("button", { name: "创建并导入" }).click();

    await expect(page.getByRole("tab", { name: "富文本DOCX导入验收" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.waitForTimeout(1_000);
    const errorDialog = page.getByRole("alertdialog");
    await expect(errorDialog).toHaveCount(0);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await expect(editor).toContainText("一种测试装置");
    await expect(editor).toContainText("技术领域");
    await expect(editor).not.toContainText("页眉-说明书-不应进入正文");
    await expect(editor.locator("p", { hasText: "一种测试装置" })).toHaveCSS(
      "text-align",
      "center",
    );
    await expect(editor.getByText("技术领域", { exact: true })).toHaveCSS("text-indent", "0px");

    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await expect(page.getByRole("img", { name: "图1" })).toBeVisible();
    await page.getByRole("tab", { name: "摘要附图", exact: true }).click();
    await expect(page.getByRole("article", { name: "摘要附图 图1" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("cancels DOCX preview without creating a patent", async ({ workbench }) => {
  const sourcePath = join(workbench.root, "待取消.docx");
  await writeDocx(sourcePath, ["权利要求书", "1. 一种取消导入的装置。"]);
  const application = await workbench.launch();
  try {
    await mockImportAndExportDialogs(application, [sourcePath]);
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await openDocxImport(page);
    const dialog = page.getByRole("dialog", { name: "导入docx" });
    await dialog.getByLabel("专利名称").fill("不应创建的专利");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("article", { name: "不应创建的专利" })).toHaveCount(0);
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("imports shared-header five books with repeated images and preserves them after restart", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const path = join(workbench.root, "统一页眉含重复图片.docx");
  const images = await Promise.all(
    ["#2563EB", "#DC2626"].map((background) =>
      sharp({ create: { width: 32, height: 32, channels: 4, background } })
        .png()
        .toBuffer(),
    ),
  );
  const picture = (index: number) => {
    const data = images[index];
    if (!data) throw new Error("Missing test image");
    return new Paragraph({
      children: [
        new ImageRun({
          type: "png",
          data,
          transformation: { width: 120, height: 120 },
        }),
      ],
    });
  };
  await writeFile(
    path,
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            headers: { default: new Header({ children: [new Paragraph("说明书")] }) },
            children: [
              new Paragraph("说明书附图"),
              picture(0),
              picture(1),
              picture(0),
              new Paragraph("说明书摘要"),
              new Paragraph("统一页眉摘要正文"),
              new Paragraph("摘要附图"),
              picture(1),
              new Paragraph("权利要求书"),
              new Paragraph("1. 一种统一页眉导入装置。"),
              new Paragraph("说明书"),
              new Paragraph("一种统一页眉导入装置"),
              new Paragraph("技术领域"),
              new Paragraph("统一页眉说明书正文"),
            ],
          },
        ],
      }),
    ),
  );
  let profile = await workbench.launchProfile("shared-header-repeated-images");
  try {
    let page = await profile.application.firstWindow();
    await dismissWelcome(page);
    await mockImportAndExportDialogs(profile.application, [path]);
    await openDocxImport(page);
    const preview = page.getByRole("dialog", { name: "导入docx", exact: true });
    await expect(preview.getByLabel("来源文件与内容").getByRole("button")).toHaveCount(5);
    await preview.getByRole("button", { name: /说明书附图/u }).click();
    await expect(preview.getByRole("img", { name: "导入图片预览" })).toHaveCount(3);
    await preview.getByLabel("专利名称").fill("统一页眉重复图验收");
    await preview.getByRole("button", { name: "创建并导入" }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
      "一种统一页眉导入装置",
    );
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toContainText(
      "统一页眉说明书正文",
    );
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).not.toContainText(
      "统一页眉摘要正文",
    );
    await profile.application.close();
    profile = await workbench.relaunchProfile(profile);
    page = await profile.application.firstWindow();
    await dismissWelcome(page);
    await openPatentFromLibrary(page, "统一页眉重复图验收");
    await page.getByRole("tab", { name: "说明书摘要", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书摘要" })).toContainText(
      "统一页眉摘要正文",
    );
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    for (const name of ["图1", "图2", "图3"]) {
      await expect(page.getByRole("img", { name, exact: true })).toBeVisible();
    }
    const [first, second, third] = await Promise.all(
      ["图1", "图2", "图3"].map((name) =>
        page.getByRole("img", { name, exact: true }).evaluate(async (image: HTMLImageElement) => {
          const response = await fetch(image.src);
          return Array.from(new Uint8Array(await response.arrayBuffer()));
        }),
      ),
    );
    expect(first?.length).toBeGreaterThan(0);
    expect(first).toEqual(third);
    expect(first).not.toEqual(second);
    await page.getByRole("tab", { name: "摘要附图", exact: true }).click();
    await expect(page.getByRole("article", { name: "摘要附图 图2" })).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  } catch (error) {
    await profile.application.close().catch(() => undefined);
    await cp(profile.libraryRoot, test.info().outputPath("diagnostic-library"), {
      recursive: true,
    });
    throw error;
  } finally {
    await profile.application.close();
  }
});

test("rejects a mixed selection and allows a corrected recognized import", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const known = join(workbench.root, "权利要求书.docx");
  const unknown = join(workbench.root, "实验记录.docx");
  await writeDocx(known, ["权利要求书", "1. 一种识别测试装置。"]);
  await writeDocx(unknown, ["实验记录", "温度25度"]);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await mockImportAndExportDialogs(application, [known, unknown]);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 DOCX", exact: true }).click();
    const error = page.getByRole("alertdialog");
    await expect(error).toContainText("无法识别的内容，不能导入");
    await expect(page.getByRole("dialog", { name: "导入docx", exact: true })).toHaveCount(0);
    await error.getByRole("button", { name: "知道了" }).click();
    await mockImportAndExportDialogs(application, [known]);
    await openDocxImport(page);
    const preview = page.getByRole("dialog", { name: "导入docx", exact: true });
    await expect(preview.getByLabel("导入到")).toHaveCount(0);
    await preview.getByLabel("专利名称").fill("严格识别验收");
    await preview.getByRole("button", { name: "创建并导入" }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
      "一种识别测试装置",
    );
    await expect(page.getByRole("button", { name: "新建其他文档" })).toHaveCount(0);
  } finally {
    await application.close();
  }
});

test("imports a reordered combined Word document and preserves books after restart", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const path = join(workbench.root, "乱序五书.docx");
  await writeDocx(path, [
    "说明书摘要",
    "摘要内容",
    "说明书",
    "技术领域",
    "说明书正文",
    "摘要附图",
    "说明书附图",
    "权利要求书",
    "1. 一种乱序识别装置。",
  ]);
  let profile = await workbench.launchProfile("recognized-five-books");
  try {
    let page = await profile.application.firstWindow();
    await dismissWelcome(page);
    await mockImportAndExportDialogs(profile.application, [path]);
    await openDocxImport(page);
    const preview = page.getByRole("dialog", { name: "导入docx", exact: true });
    await preview.getByLabel("专利名称").fill("乱序五书验收");
    await preview.getByRole("button", { name: "创建并导入" }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
      "一种乱序识别装置",
    );
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toContainText("说明书正文");
    await profile.application.close();
    profile = await workbench.relaunchProfile(profile);
    page = await profile.application.firstWindow();
    await dismissWelcome(page);
    await openPatentFromLibrary(page, "乱序五书验收");
    await page.getByRole("tab", { name: "说明书摘要", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书摘要" })).toContainText("摘要内容");
    await expect(page.getByRole("button", { name: "新建其他文档" })).toHaveCount(0);
  } finally {
    await profile.application.close();
  }
});
