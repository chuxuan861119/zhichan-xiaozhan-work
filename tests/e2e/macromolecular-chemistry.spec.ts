import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import {
  createMacromolecularPatentPayload,
  PROTEIN_KET,
  SRU_POLYMER_KET,
} from "./fixtures/macromolecular-patent.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

const OUTBOUND_PROTOCOL = /^(?:https?|wss?):/iu;

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

function bookTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function bookEditor(page: Page, name: string) {
  return page.getByRole("textbox", { name: `编辑 ${name}` });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await readFile(path)).byteLength;
  } catch {
    return 0;
  }
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

async function mockOpenDialog(application: ElectronApplication, path: string): Promise<void> {
  await application.evaluate(({ dialog }, selected) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [selected] }),
    });
  }, path);
}

async function openPatentThroughImport(
  application: ElectronApplication,
  page: Page,
  patdocPath: string,
  patentName: string,
): Promise<void> {
  await mockOpenDialog(application, patdocPath);
  await page.getByRole("tab", { name: "专利库", exact: true }).click();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
  await page
    .getByRole("dialog", { name: "PATDOC 导入须知" })
    .getByRole("button", { name: "继续导入" })
    .click();
  await expect(page.getByRole("tab", { name: patentName, exact: true })).toBeVisible();
}

async function expectStructureInBook(page: Page, bookName: string): Promise<void> {
  await bookTab(page, bookName).click();
  const editor = bookEditor(page, bookName);
  await expect(editor).toBeVisible();
  await expect(editor.locator(".chemical-structure img[alt='化学结构式']")).toBeVisible();
}

type PersistedStructure = {
  bookKind: string;
  ketSource: string;
  editorMode: string | undefined;
  previewAssetId: string;
  widthMm: number;
  alignment: string;
};

async function persistedStructures(page: Page, patentName: string): Promise<PersistedStructure[]> {
  return page.evaluate(async (name) => {
    const patentApi = (globalThis as typeof globalThis & { patentApi: PatentApi }).patentApi;
    const listed = await patentApi.patents.list("active");
    if (!listed.ok) throw new Error("无法读取专利库。");
    const summary = listed.value.find((item) => item.name === name);
    if (!summary) throw new Error(`专利未出现在库中：${name}`);
    const opened = await patentApi.patents.open(summary.patentId);
    if (!opened.ok) throw new Error(`无法打开专利：${name}`);
    try {
      const structures: PersistedStructure[] = [];
      for (const book of opened.value.patent.books) {
        for (const block of book.document.content) {
          if (block.type === "chemical-structure") {
            structures.push({
              bookKind: book.kind,
              ketSource: block.ketSource,
              editorMode: block.editorMode,
              previewAssetId: block.previewAssetId,
              widthMm: block.widthMm,
              alignment: block.alignment,
            });
          }
        }
      }
      return structures;
    } finally {
      await patentApi.patents.release(opened.value.sessionId);
    }
  }, patentName);
}

test("edits and persists SRU, protein and nucleic acid structures across five books, export, trash and restore", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const patentName = "大分子化学验收";
  const sourcePath = join(workbench.root, `${patentName}.patdoc`);
  const docxPath = join(workbench.root, `${patentName}.docx`);
  const pdfPath = join(workbench.root, `${patentName}.pdf`);
  await writePatdoc(sourcePath, await createMacromolecularPatentPayload(patentName));

  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await openPatentThroughImport(application, page, sourcePath, patentName);

    // Each core book renders its own macromolecular structure class.
    await expectStructureInBook(page, "权利要求书");
    await expectStructureInBook(page, "说明书");
    await expectStructureInBook(page, "说明书摘要");

    // Adjust width and alignment on the description structure, then undo/redo.
    await bookTab(page, "说明书").click();
    const structure = bookEditor(page, "说明书").locator(".chemical-structure").first();
    await structure.click();
    const width = page.getByRole("slider", { name: "结构式宽度" });
    await expect(width).toBeVisible();
    await width.fill("112");
    await page.getByRole("button", { name: "左对齐" }).last().click();
    await expect(structure.locator("img")).toHaveAttribute("style", /112mm/u);
    await expect(page.locator(".chemical-structure.align-left")).toHaveCount(1);
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.locator(".chemical-structure.align-left")).toHaveCount(0);
    await page.getByRole("button", { name: "重做" }).click();
    await expect(page.locator(".chemical-structure.align-left")).toHaveCount(1);

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.locator(".status-save-state").getByRole("status", { name: "已保存" }),
    ).toBeVisible();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();

    // Reopen from the library and verify the three structures survived with their mode.
    const reopened = await persistedStructures(page, patentName);
    expect(reopened).toEqual([
      expect.objectContaining({
        bookKind: "claims",
        ketSource: SRU_POLYMER_KET,
        editorMode: "macromolecule",
        alignment: "center",
      }),
      expect.objectContaining({
        bookKind: "description",
        ketSource: PROTEIN_KET,
        editorMode: "macromolecule",
        widthMm: 112,
        alignment: "left",
      }),
      expect.objectContaining({
        bookKind: "abstract",
        editorMode: "macromolecule",
        alignment: "center",
      }),
    ]);
    // Identical rendered previews are content-deduplicated while all three structures retain them.
    expect(new Set(reopened.map((item) => item.previewAssetId)).size).toBe(1);

    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await expectStructureInBook(page, "说明书摘要");

    // Export DOCX and PDF with the structures embedded.
    await chooseExportPaths(application, [docxPath, pdfPath]);
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    const docxExport = page.getByRole("dialog", { name: "导出专利文档" });
    await expect(docxExport).toBeVisible();
    await docxExport.getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u }).click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);
    const docxReport = page.getByRole("dialog", {
      name: /DOCX 导出(?:成功|报告|失败)/u,
    });
    await expect(docxReport).toBeVisible();
    await docxReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 PDF" }).click();
    const pdfExport = page.getByRole("dialog", { name: "导出专利文档" });
    await expect(pdfExport).toBeVisible();
    await pdfExport.getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u }).click();
    await expect.poll(() => fileSize(pdfPath)).toBeGreaterThan(0);
    const pdfReport = page.getByRole("dialog", { name: /PDF 导出(?:成功|报告|失败)/u });
    await expect(pdfReport).toBeVisible();
    await pdfReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
    expect((await readFile(pdfPath)).subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Trash and restore the patent, then verify the structures survive the round trip.
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    await expect(page.getByRole("article", { name: patentName })).toBeVisible();
    await page.evaluate(async (name) => {
      const patentApi = (globalThis as typeof globalThis & { patentApi: PatentApi }).patentApi;
      const listed = await patentApi.patents.list("active");
      if (!listed.ok) throw new Error("无法读取专利库。");
      const summary = listed.value.find((item) => item.name === name);
      if (!summary) throw new Error(`专利未出现在库中：${name}`);
      const moved = await patentApi.patents.moveToTrash(summary.patentId);
      if (!moved.ok) throw new Error("专利删除失败。");
      const restored = await patentApi.patents.restore(summary.patentId);
      if (!restored.ok) throw new Error("专利恢复失败。");
    }, patentName);
    const afterRestore = await persistedStructures(page, patentName);
    expect(afterRestore).toHaveLength(3);
    expect(new Set(afterRestore.map((item) => item.previewAssetId)).size).toBe(1);
  } finally {
    await application.close().catch(() => undefined);
  }

  const requestUrls = await workbench.readObservedRequestUrls();
  expect(requestUrls.filter((url) => OUTBOUND_PROTOCOL.test(url))).toEqual([]);
  const outboundConnections = await workbench.readObservedConnections();
  expect(outboundConnections).toEqual([]);
});

test("accepts ordinary images in claims and description while preserving chemical structures", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const patentName = "普通图片插入验收";
  const importedPatentName = "大分子结构导入验收";
  const pngPath = join(process.cwd(), "tests", "fixtures", "images", "sample.png");
  const structurePath = join(workbench.root, `${importedPatentName}.patdoc`);
  await writePatdoc(structurePath, await createMacromolecularPatentPayload(importedPatentName));

  const application = await workbench.launch();
  try {
    await mockOpenDialog(application, pngPath);
    const page = await application.firstWindow();
    await dismissWelcome(page);

    // Create a fresh patent and verify the image entry points for each supported book.
    const patentLibrary = page.getByRole("tab", { name: "专利库" });
    if (await patentLibrary.isVisible()) await patentLibrary.click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建专利" });
    await createDialog.getByRole("textbox", { name: "专利名称" }).fill(patentName);
    await createDialog.getByRole("radio", { name: "发明" }).check();
    await createDialog.getByRole("button", { name: "创建专利" }).click();
    await expect(page.getByRole("tab", { name: patentName, exact: true })).toBeVisible();

    for (const [bookName, expectsImageButton] of [
      ["权利要求书", true],
      ["说明书", true],
      ["说明书摘要", false],
    ] as const) {
      await bookTab(page, bookName).click();
      await expect(bookEditor(page, bookName)).toBeVisible();
      const toolbarButtons = await page
        .getByRole("toolbar", { name: "常用工具" })
        .locator("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      expect(toolbarButtons.includes("插入图片")).toBe(expectsImageButton);
    }

    // Pasting an ordinary PNG into a supported patent book creates a normal image figure.
    await bookTab(page, "说明书").click();
    const editor = bookEditor(page, "说明书");
    await editor.click();
    await editor.evaluate((target) => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const data = canvas.toDataURL("image/png");
      const bytes = atob(data.split(",")[1] ?? "");
      const file = new File(
        [Uint8Array.from(bytes, (character) => character.charCodeAt(0))],
        "pasted.png",
        { type: "image/png" },
      );
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const event = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    });
    await expect(editor.locator(".patent-figure")).toHaveCount(1);
    await expect(editor.locator(".chemical-structure")).toHaveCount(0);

    // Importing a patent with chemical structures must succeed in the same books.
    await openPatentThroughImport(application, page, structurePath, importedPatentName);
    await expectStructureInBook(page, "权利要求书");
    await expectStructureInBook(page, "说明书摘要");
  } finally {
    await application.close().catch(() => undefined);
  }

  const outboundConnections = await workbench.readObservedConnections();
  expect(outboundConnections).toEqual([]);
});
