import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import sharp from "sharp";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import {
  CHEMICAL_EQUATION_SOURCE,
  CHEMICAL_STRUCTURE_KET,
  createChemicalPatentPayload,
} from "../fixtures/chemical-content.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

const OUTBOUND_PROTOCOL = /^(?:https?|wss?):/iu;

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await readFile(path)).byteLength;
  } catch {
    return 0;
  }
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX ZIP 无法打开。"));
      else resolve(zip);
    });
  });
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
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
      void readZipEntry(zip, entry)
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

type PersistedChemistry = {
  equations: Array<{ source: string; formulaKind: string }>;
  structure: {
    ketSource: string;
    previewAssetId: string;
    widthMm: number;
    alignment: string;
  };
  assetIds: string[];
};

async function reopenPersistedChemistry(page: Page): Promise<PersistedChemistry> {
  return page.evaluate(async () => {
    const patentApi = (globalThis as typeof globalThis & { patentApi: PatentApi }).patentApi;
    const listed = await patentApi.patents.list("active");
    if (!listed.ok) throw new Error("无法读取专利库。");
    const summary = listed.value.find((item) => item.name === "化学编辑验收");
    if (!summary) throw new Error("化学验收专利未出现在专利库中。");
    const opened = await patentApi.patents.open(summary.patentId);
    if (!opened.ok) throw new Error("无法从持久化库重新打开化学验收专利。");
    try {
      const description = opened.value.patent.books.find((book) => book.kind === "description");
      if (!description) throw new Error("重新打开的专利缺少说明书。");
      const equations: Array<{ source: string; formulaKind: string }> = [];
      let structure: {
        ketSource: string;
        previewAssetId: string;
        widthMm: number;
        alignment: string;
      } | null = null;
      for (const block of description.document.content) {
        if (block.type === "paragraph") {
          for (const inline of block.content) {
            if (inline.type === "inline-formula" && inline.formulaKind === "chemistry") {
              equations.push({ source: inline.source, formulaKind: inline.formulaKind });
            }
          }
        } else if (block.type === "block-formula" && block.formulaKind === "chemistry") {
          equations.push({ source: block.source, formulaKind: block.formulaKind });
        } else if (block.type === "chemical-structure") {
          structure = {
            ketSource: block.ketSource,
            previewAssetId: block.previewAssetId,
            widthMm: block.widthMm,
            alignment: block.alignment,
          };
        }
      }
      if (!structure) throw new Error("重新打开的专利缺少化学结构式。");
      return {
        equations,
        structure,
        assetIds: opened.value.patent.assets.map((asset) => asset.assetId),
      };
    } finally {
      await patentApi.patents.release(opened.value.sessionId);
    }
  });
}

async function chooseExportPaths(
  application: ElectronApplication,
  paths: readonly string[],
): Promise<void> {
  await application.evaluate(
    ({ dialog }, selectedPaths) => {
      let index = 0;
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath: selectedPaths[index++] }),
      });
    },
    [...paths],
  );
}

async function setChemicalEquation(page: Page, source: string): Promise<void> {
  await page.locator('math-field[aria-label="化学方程式编辑器"]').evaluate((field, nextSource) => {
    (field as unknown as { value: string }).value = nextSource;
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }, source);
}

function chemistryFormulaCount(page: Page) {
  return page.locator("[data-type='inline-math'], [data-type='block-math']");
}

async function chemistryFormulaWithSource(page: Page, source: string): Promise<Locator> {
  const formulas = chemistryFormulaCount(page);
  await expect
    .poll(() => formulas.evaluateAll((nodes) => nodes.map((node) => node.dataset.latex)))
    .toContain(source);
  const sources = await formulas.evaluateAll((nodes) => nodes.map((node) => node.dataset.latex));
  const index = sources.lastIndexOf(source);
  if (index < 0) throw new Error(`未找到化学方程式：${source}`);
  return formulas.nth(index);
}

test("edits persisted chemical content locally through save, reopen, export, and print", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const sourcePath = join(workbench.root, "化学编辑验收.patdoc");
  const docxPath = join(workbench.root, "化学编辑验收.docx");
  const pdfPath = join(workbench.root, "化学编辑验收.pdf");
  await writePatdoc(sourcePath, await createChemicalPatentPayload("化学编辑验收"));

  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await application.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, sourcePath);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await expect(editor).toBeVisible();

    const chemistryFormula = {
      click: async () => {
        const button = page.getByRole("button", { name: "插入化学方程式", exact: true });
        if (await button.isVisible()) await button.click();
        else {
          await page.getByRole("button", { name: "更多工具", exact: true }).click();
          await page.getByRole("menuitem", { name: "插入化学方程式", exact: true }).click();
        }
      },
    };
    const toolbarLabels = await page
      .getByRole("toolbar", { name: "常用工具" })
      .locator("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(toolbarLabels.indexOf("插入数学公式")).toBeGreaterThanOrEqual(0);
    expect(toolbarLabels.indexOf("插入数学公式")).toBeLessThan(
      toolbarLabels.indexOf("插入化学方程式"),
    );
    expect(toolbarLabels.indexOf("插入化学方程式")).toBeLessThan(
      toolbarLabels.indexOf("插入化学结构式"),
    );

    const formulasBeforeInsert = await chemistryFormulaCount(page).count();
    expect(formulasBeforeInsert).toBe(2);
    await expect(chemistryFormulaCount(page).first()).toHaveAttribute(
      "data-latex",
      CHEMICAL_EQUATION_SOURCE,
    );
    await chemistryFormula.click();
    const insertDialog = page.getByRole("dialog", { name: "插入化学方程式" });
    await expect(insertDialog.getByLabel("化学方程式编辑器")).toBeVisible();
    await setChemicalEquation(page, "H2 + Cl2 -> 2HCl");
    await insertDialog.getByRole("button", { name: "插入", exact: true }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert + 1);

    const insertedSource = String.raw`\ce{H2 + Cl2 -> 2HCl}`;
    const editedSource = String.raw`\ce{3H2 + N2 -> 2NH3}`;
    const insertedFormula = await chemistryFormulaWithSource(page, insertedSource);
    await expect(insertedFormula).toHaveAttribute("data-latex", insertedSource);
    // Tiptap's undo history starts a new group after 500 ms. Keep insertion and editing as
    // distinct user operations so each undo/redo assertion exercises exactly one operation.
    await page.waitForTimeout(600);
    await insertedFormula.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    const editDialog = page.getByRole("dialog", { name: "编辑化学方程式" });
    await expect(editDialog).toBeVisible();
    await setChemicalEquation(page, "3H2 + N2 -> 2NH3");
    await editDialog.getByRole("button", { name: "保存" }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert + 1);
    await expect(await chemistryFormulaWithSource(page, editedSource)).toHaveAttribute(
      "data-latex",
      editedSource,
    );
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(await chemistryFormulaWithSource(page, insertedSource)).toHaveAttribute(
      "data-latex",
      insertedSource,
    );
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert);
    await page.getByRole("button", { name: "重做" }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert + 1);
    await expect(await chemistryFormulaWithSource(page, insertedSource)).toHaveAttribute(
      "data-latex",
      insertedSource,
    );
    await page.getByRole("button", { name: "重做" }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert + 1);
    await expect(await chemistryFormulaWithSource(page, editedSource)).toHaveAttribute(
      "data-latex",
      editedSource,
    );

    const structureNode = page.locator(".chemical-structure").first();
    const structure = structureNode.getByRole("img", { name: "化学结构式" });
    await expect(structure).toBeVisible();
    await structureNode.click();
    await expect(page.getByRole("spinbutton", { name: "结构式宽度（毫米）" })).toBeVisible();

    // The outer Ketcher shell is rendered before its public onInit callback. Require the
    // dialog action to become usable so this test detects a stuck runtime initialization.
    await structure.dblclick();
    const structureDialog = page.getByRole("dialog", { name: "编辑化学结构式" });
    await expect(structureDialog).toBeVisible();
    await expect(page.getByLabel("化学结构编辑器")).toBeVisible();
    await expect(structureDialog.getByRole("button", { name: "保存" })).toBeEnabled({
      timeout: 15_000,
    });
    await structureDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(structure).toBeVisible();

    const countBeforeCancel = await chemistryFormulaCount(page).count();
    await chemistryFormula.click();
    const invalidDialog = page.getByRole("dialog", { name: "插入化学方程式" });
    await expect(invalidDialog).toBeVisible();
    await setChemicalEquation(page, String.raw`\ce{`);
    await expect(invalidDialog.getByRole("button", { name: "插入", exact: true })).toBeDisabled();
    await invalidDialog.getByRole("button", { name: "取消" }).click();
    await expect(chemistryFormulaCount(page)).toHaveCount(countBeforeCancel);

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭化学编辑验收" }).click();
    const persisted = await reopenPersistedChemistry(page);
    expect(persisted.equations).toContainEqual({ source: editedSource, formulaKind: "chemistry" });
    expect(persisted.structure).toEqual({
      ketSource: CHEMICAL_STRUCTURE_KET,
      previewAssetId: expect.any(String),
      widthMm: 80,
      alignment: "center",
    });
    expect(persisted.assetIds).toContain(persisted.structure.previewAssetId);
    const patentCard = page.getByRole("article", { name: "化学编辑验收" });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await expect(page.getByRole("img", { name: "化学结构式" })).toBeVisible();
    await expect(chemistryFormulaCount(page)).toHaveCount(formulasBeforeInsert + 1);
    await expect(await chemistryFormulaWithSource(page, editedSource)).toHaveAttribute(
      "data-latex",
      editedSource,
    );

    await chooseExportPaths(application, [docxPath, pdfPath]);
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    const docxExport = page.getByRole("dialog", { name: "导出专利文档" });
    await expect(docxExport).toBeVisible();
    await docxExport.getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u }).click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);
    const docxReport = page.getByRole("dialog", { name: "DOCX 导出报告" });
    await expect(docxReport).toBeVisible();
    await docxReport.getByRole("button", { name: "关闭", exact: true }).click();
    const docxEntries = await readZipEntries(await readFile(docxPath));
    const documentXml = docxEntries.get("word/document.xml")?.toString("utf8") ?? "";
    expect(documentXml).toContain("化学内容：");
    expect(documentXml.match(/<w:drawing>/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const media = [...docxEntries.entries()].filter(([name]) =>
      /^word\/media\/.*\.(?:png|jpe?g)$/u.test(name),
    );
    expect(media.length).toBeGreaterThanOrEqual(2);
    for (const [, bytes] of media) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width).toBeGreaterThan(0);
      expect(metadata.height).toBeGreaterThan(0);
    }
    const structureJpeg = media.find(([name]) => /\.jpe?g$/u.test(name));
    expect(structureJpeg).toBeDefined();
    if (!structureJpeg) throw new Error("Missing DOCX structure JPEG");
    expect((await sharp(structureJpeg[1]).metadata()).density).toBe(300);

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 PDF" }).click();
    const pdfExport = page.getByRole("dialog", { name: "导出专利文档" });
    await expect(pdfExport).toBeVisible();
    await pdfExport.getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u }).click();
    await expect.poll(() => fileSize(pdfPath)).toBeGreaterThan(0);
    await expect(page.getByRole("dialog", { name: "导出专利文档" })).toBeHidden();
    const pdfReport = page.getByRole("dialog", { name: /PDF 导出(?:成功|报告|失败)/u });
    await expect(pdfReport).toBeVisible();
    await pdfReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
    expect((await readFile(pdfPath)).subarray(0, 5).toString("ascii")).toBe("%PDF-");

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…", exact: true }).click();
    const printCenter = page.getByRole("dialog", { name: "打印中心" });
    await expect(printCenter).toBeVisible();
    await expect(printCenter.getByLabel("打印预览画布")).toBeVisible();
    await printCenter.getByRole("button", { name: "关闭打印中心" }).click();
  } finally {
    await application.close().catch(() => undefined);
  }

  const requestUrls = await workbench.readObservedRequestUrls();
  expect(requestUrls.filter((url) => OUTBOUND_PROTOCOL.test(url))).toEqual([]);
  const outboundConnections = await workbench.readObservedConnections();
  expect(outboundConnections).toEqual([]);
});
