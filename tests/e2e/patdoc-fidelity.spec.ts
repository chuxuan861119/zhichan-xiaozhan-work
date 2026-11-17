import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { createPatdocFidelityPayload } from "../fixtures/patdoc-fidelity.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test, type WorkbenchProfile } from "./helpers/workbench.js";

async function importArchive(profile: WorkbenchProfile, path: string): Promise<Page> {
  const page = await profile.application.firstWindow();
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect(welcome).toBeHidden();
  }
  await profile.application.evaluate(({ dialog }, filePath) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [filePath] }),
    });
  }, path);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
  await page
    .getByRole("dialog", { name: "PATDOC 导入须知" })
    .getByRole("button", { name: "继续导入" })
    .click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
  return page;
}

async function readImported(page: Page) {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
    const list = await api.patents.list("active");
    if (!list.ok || !list.value[0]) throw new Error("Imported patent missing");
    const opened = await api.patents.open(list.value[0].patentId);
    if (!opened.ok) throw new Error("Cannot reopen patent");
    try {
      const sources = [];
      for (const project of opened.value.patent.flowchartProjects) {
        const loaded = await api.flowcharts.load({
          patentId: opened.value.patentId,
          projectId: project.projectId,
        });
        if (!loaded.ok) throw new Error("Cannot open editable flowchart source");
        sources.push({
          name: project.name,
          source: Array.from(loaded.value.source),
          pageCount: project.pageCount,
          lastPageId: project.lastPageId,
        });
      }
      return { patent: opened.value.patent, sources };
    } finally {
      await api.patents.release(opened.value.sessionId);
    }
  });
}

test("native export and reimport retain rich content and editable sources in a fresh Electron profile", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const fixture = await createPatdocFidelityPayload();
  const input = join(workbench.root, "input.patdoc");
  const output = join(workbench.root, "exported.patdoc");
  await writePatdoc(input, fixture);
  const source = await workbench.launchProfile("fidelity-source");
  let before: Awaited<ReturnType<typeof readImported>>;
  let formulaCount = 0;
  try {
    const page = await importArchive(source, input);
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor.locator(".katex").first()).toBeVisible();
    await expect(editor.getByRole("img", { name: "化学结构式" })).toBeVisible();
    await expect(editor.locator("table")).toHaveCount(1);
    formulaCount = await editor.locator(".katex").count();
    before = await readImported(page);
    await source.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, output);
    const result = await page.evaluate(
      async (request) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        return api.patents.exportPatdoc(request);
      },
      { patentId: before.patent.patentId, expectedRevision: before.patent.revision },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await access(output);
  } finally {
    await source.application.close();
  }
  const target = await workbench.launchProfile("fidelity-target");
  try {
    const page = await importArchive(target, output);
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor.locator(".katex")).toHaveCount(formulaCount);
    await expect(editor.getByRole("img", { name: "化学结构式" })).toBeVisible();
    await expect(editor.locator("table")).toHaveCount(1);
    const after = await readImported(page);
    expect(after.patent.books.map((book) => book.document)).toEqual(
      before!.patent.books.map((book) => book.document),
    );
    expect(after.patent.auxiliaryDocuments.map((item) => item.document)).toEqual(
      before!.patent.auxiliaryDocuments.map((item) => item.document),
    );
    expect(after.patent.docxImportReport).toBeNull();
    expect(after.sources.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      before!.sources.sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(after.patent.assets).toEqual(before!.patent.assets);
  } finally {
    await target.application.close();
  }
});
