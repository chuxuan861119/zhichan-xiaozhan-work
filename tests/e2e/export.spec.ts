import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { createReferencePayload, writePatdoc } from "./helpers/documents.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX ZIP 无法打开。"));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("DOCX ZIP 条目无法读取。"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readZipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await openZip(buffer);
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      void readEntry(zip, entry)
        .then((bytes) => {
          entries.set(entry.fileName, bytes);
          zip.readEntry();
        })
        .catch(reject);
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await readFile(path)).byteLength;
  } catch {
    return 0;
  }
}

test("exports DOCX and PDF with native formula, one fallback warning, and an unchanged source", async ({
  workbench,
}) => {
  const sourcePath = join(workbench.root, "导出源文档.patdoc");
  const docxPath = join(workbench.root, "导出验证.docx");
  const pdfPath = join(workbench.root, "导出验证.pdf");
  const payload = await createReferencePayload("导出源文档");
  const paragraph = payload.document.content.find((block) => block.type === "paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("导出夹具缺少段落。");
  paragraph.content.push({
    type: "inline-formula",
    // Supported raster fallback; external-link TeX is intentionally rejected.
    source: String.raw`\color{red}{x}`,
    formulaKind: "math",
  });
  const patent = createBlankPatent({ patentType: "invention", name: "导出源文档" });
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("导出夹具缺少说明书。");
  description.document = {
    ...description.document,
    content: payload.document.content.filter(
      (block) => block.type === "paragraph" || block.type === "block-formula",
    ),
  };
  await writePatdoc(sourcePath, { patent, assets: [] });
  const sourceBefore = await readFile(sourcePath);

  const application = await workbench.launch(sourcePath);
  try {
    await application.evaluate(
      ({ dialog }, paths) => {
        let index = 0;
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: paths.exports[index++] }),
        });
      },
      { exports: [docxPath, pdfPath] },
    );
    const page = await application.firstWindow();
    await dismissWelcome(page);
    const importError = page.getByRole("alertdialog", { name: "操作未完成" });
    const importedTab = page.getByRole("tab", { name: "导出源文档" });
    await importedTab.or(importError).waitFor({ state: "visible" });
    if (await importError.isVisible()) throw new Error(await importError.innerText());
    await importedTab.click();
    const descriptionTab = page.getByRole("tab", { name: "说明书", exact: true });
    if (!(await descriptionTab.isVisible())) {
      throw new Error("导入后未进入专利工作区");
    }
    await descriptionTab.click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();

    const exportFromMenu = async (format: "DOCX" | "PDF") => {
      if (process.platform === "darwin") {
        await application.evaluate(({ Menu, BrowserWindow }, label) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes("index.html"),
          )!;
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === "文件")!
            .submenu!.items.find((item) => item.label === label)!
            .click(undefined as never, window, {} as never);
        }, `导出 ${format}…`);
      } else {
        await page.getByRole("button", { name: "文件", exact: true }).click();
        await page.getByRole("menuitem", { name: `导出 ${format}` }).click();
      }
    };
    await exportFromMenu("DOCX");
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    const docxReport = page.getByRole("dialog", { name: "DOCX 导出报告" });
    await expect(docxReport).toBeVisible();
    await expect(docxReport.getByRole("listitem")).toHaveCount(1);
    await expect(docxReport).toContainText("公式已转换为图片，无法在 Word 公式编辑器中编辑。");
    await docxReport.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);

    await exportFromMenu("PDF");
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    const pdfReport = page.getByRole("dialog", { name: /PDF 导出(?:成功|报告|失败)/u });
    await expect(pdfReport).toBeVisible();
    await pdfReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
    await expect.poll(() => fileSize(pdfPath)).toBeGreaterThan(0);

    const docxBytes = await readFile(docxPath);
    const entries = await readZipEntries(docxBytes);
    expect(entries.has("[Content_Types].xml")).toBe(true);
    expect(entries.has("word/document.xml")).toBe(true);
    const documentXml = entries.get("word/document.xml")?.toString("utf8") ?? "";
    expect(documentXml.match(/<m:oMath>/gu)).toHaveLength(2);
    expect(documentXml).toContain(String.raw`复杂公式（LaTeX）：\color{red}{x}`);
    expect(documentXml.match(/<w:drawing>/gu)).toHaveLength(1);
    expect([...entries.keys()].filter((name) => /^word\/media\/.*\.png$/u.test(name))).toHaveLength(
      1,
    );

    expect((await readFile(pdfPath)).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
  } finally {
    await application.close().catch(() => undefined);
  }
});
