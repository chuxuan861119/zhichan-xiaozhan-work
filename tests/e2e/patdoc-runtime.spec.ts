import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect(welcome).toBeHidden();
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await readFile(path)).byteLength;
  } catch {
    return 0;
  }
}

test("exports and imports Chinese patent text through the native PATDOC boundary", async ({
  workbench,
}) => {
  const patentName = "一种往复式夹具及其控制方法";
  const claimsText = `1. ${patentName}，其特征在于，包括夹持机构和往复驱动机构。`;
  const filePath = join(workbench.root, "往复式夹具.patdoc");

  const source = await workbench.launchProfile("patdoc-source");
  try {
    await source.application.evaluate(({ dialog }, selectedPath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath: selectedPath }),
      });
    }, filePath);
    const page = await source.application.firstWindow();
    await dismissWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "新建专利" });
    await createDialog.getByRole("textbox", { name: "专利名称" }).fill(patentName);
    await createDialog.getByRole("radio", { name: "发明" }).check();
    await createDialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(claimsText);
    // Export must include pending editor changes, without a manual save first.
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 PATDOC" }).click();
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: "导出", exact: true })
      .click();
    await expect.poll(() => fileSize(filePath)).toBeGreaterThan(0);
  } finally {
    await source.application.close().catch(() => undefined);
  }

  const target = await workbench.launchProfile("patdoc-target");
  try {
    await target.application.evaluate(({ dialog }, selectedPath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selectedPath] }),
      });
    }, filePath);
    const page = await target.application.firstWindow();
    await dismissWelcome(page);
    await page.getByRole("button", { name: "导入" }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC" }).click();
    await page.getByRole("button", { name: "继续导入", exact: true }).click();
    const importedTab = page.getByRole("tab", { name: patentName });
    await expect(importedTab).toBeVisible();
    await importedTab.click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(claimsText);
  } finally {
    await target.application.close().catch(() => undefined);
  }
});

test("valid standalone PATDOC displays an unsupported-type notice without importing", async ({
  workbench,
}) => {
  const path = join(workbench.root, "单文档.patdoc");
  await writePatdoc(path, {
    document: createBlankDocument("独立文档"),
    assets: [],
    settings: {},
    editorState: {},
  });
  const profile = await workbench.launchProfile("patdoc-document-type");
  try {
    const page = await profile.application.firstWindow();
    await dismissWelcome(page);
    await profile.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [filePath] }),
      });
    }, path);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page.getByRole("button", { name: "继续导入", exact: true }).click();
    await expect(
      page.getByText("这是单文档 PATDOC，不是完整的五书专利文件；当前专利导入入口不支持此类型。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("main", { name: "专利编辑区" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "独立文档", exact: true })).toHaveCount(0);
  } finally {
    await profile.application.close();
  }
});
