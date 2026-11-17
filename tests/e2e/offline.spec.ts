import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { stableUuid, writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

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

test("observes networking before launch and completes local workflows with zero external attempts", async ({
  workbench,
}) => {
  const sourcePath = join(workbench.root, "完全离线源文档.patdoc");
  const docxPath = join(workbench.root, "完全离线.docx");
  const pdfPath = join(workbench.root, "完全离线.pdf");
  let nextId = 930_000;
  const patent = createBlankPatent(
    { patentType: "invention", name: "完全离线源文档" },
    {
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      createId: () => stableUuid(nextId++),
    },
  );
  await writePatdoc(sourcePath, { patent, assets: [] });

  // This scenario deliberately leaves the test-only request blocker disabled. The
  // production-equivalent policy is covered separately by security tests; here a
  // zero result proves that product code did not even attempt an outbound request.
  const application = await workbench.launchWithoutTestPolicy();
  try {
    await application.evaluate(
      ({ dialog }, paths) => {
        let index = 0;
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [paths.source] }),
        });
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: paths.exports[index++] }),
        });
      },
      { source: sourcePath, exports: [docxPath, pdfPath] },
    );
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    await expect(page.getByRole("tab", { name: "完全离线源文档" })).toBeVisible();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.press("Control+End");
    await editor.type(" 离线编辑保存验证");

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("tab", { name: "完全离线源文档" })).toBeVisible();

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    const docxConfirmation = page.getByRole("dialog", { name: "导出专利文档" });
    if (await docxConfirmation.isVisible()) {
      await docxConfirmation
        .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
        .click();
    }
    await page
      .getByRole("dialog", { name: /DOCX 导出(?:成功|报告)/u })
      .getByRole("button", { name: /^(?:确认|关闭)$/u })
      .click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 PDF" }).click();
    const pdfConfirmation = page.getByRole("dialog", { name: "导出专利文档" });
    if (await pdfConfirmation.isVisible()) {
      await pdfConfirmation
        .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
        .click();
    }
    await page
      .getByRole("dialog", { name: /PDF 导出(?:成功|报告)/u })
      .getByRole("button", { name: /^(?:确认|关闭)$/u })
      .click();
    await expect.poll(() => fileSize(pdfPath)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…" }).click();
    const printCenter = page.getByRole("dialog", { name: "打印中心" });
    await expect(printCenter).toBeVisible();
    await expect(printCenter.getByLabel("打印预览画布")).toBeVisible();
    await printCenter.getByRole("button", { name: "关闭打印中心" }).click();
  } finally {
    await application.close().catch(() => undefined);
  }

  const connections = await workbench.readObservedConnections();
  expect(connections.filter((connection) => connection.netError === 0)).toEqual([]);
  expect(connections).toEqual([]);
});
