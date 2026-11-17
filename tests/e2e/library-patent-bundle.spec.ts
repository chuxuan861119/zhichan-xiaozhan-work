import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("library exports combined files and bundles, restores patents without leaving the library", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await workbench.launchProfile("library-bundle");
  try {
    const page = await profile.application.firstWindow();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { patentApi: PatentApi }).patentApi),
    );
    const requests = await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const entries = [];
      for (const patentType of ["invention", "utility-model"] as const) {
        const result = await api.patents.create({
          name: "批量测试",
          customer: "测试客户",
          patentType,
        });
        if (!result.ok) throw new Error(result.error.message);
        entries.push({ patentId: result.value.patentId, expectedRevision: result.value.revision });
        await api.patents.release(result.value.sessionId);
      }
      return entries;
    });
    await page.reload();
    const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
    if (await welcome.isVisible()) {
      await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
      await expect(welcome).toBeHidden();
    }
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library.getByRole("article", { name: "批量测试" })).toHaveCount(2);
    await expect(library.getByRole("article").getByRole("checkbox")).toHaveCount(0);
    await library.getByRole("button", { name: "导出", exact: true }).click();
    await expect(library.getByRole("article").getByRole("checkbox")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("library-selection.png") });
    for (const format of ["patdoc", "docx", "pdf"] as const) {
      const path = join(workbench.root, `${format}-bundle.zip`);
      await profile.application.evaluate(({ dialog }, filePath) => {
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath }),
        });
        Object.defineProperty(dialog, "showMessageBox", {
          configurable: true,
          value: async () => ({ response: 1 }),
        });
      }, path);
      const selectAll = library.getByRole("button", { name: "全选当前筛选专利" });
      if ((await selectAll.getAttribute("aria-pressed")) !== "true") await selectAll.click();
      await library.getByRole("button", { name: "导出所选（2）" }).click();
      const modal = page.getByRole("dialog", { name: "导出专利" });
      await modal.getByRole("radio", { name: format.toUpperCase(), exact: true }).check();
      await modal.getByRole("button", { name: "导出", exact: true }).click();
      const success = page.getByRole("dialog", { name: `${format.toUpperCase()} 导出成功` });
      await expect(success).toBeVisible();
      await success.getByRole("button", { name: "确认" }).click();
      expect((await readFile(path)).subarray(0, 2).toString()).toBe("PK");
    }
    const pdf = join(workbench.root, "single.pdf");
    await profile.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, pdf);
    const single = await page.evaluate(
      async (patents) =>
        (window as unknown as { patentApi: PatentApi }).patentApi.patents.exportBundle!({
          format: "pdf",
          patents,
        }),
      requests.slice(0, 1),
    );
    expect(single.ok, JSON.stringify(single)).toBe(true);
    expect((await readFile(pdf)).subarray(0, 4).toString()).toBe("%PDF");
    await profile.application.evaluate(
      ({ dialog }, filePath) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [filePath] }),
        });
      },
      join(workbench.root, "docx-bundle.zip"),
    );
    await library.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入专利压缩包" }).click();
    const notice = page.getByRole("dialog", { name: "压缩包导入须知" });
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("import-notice.png"),
      animations: "disabled",
    });
    await notice.getByRole("button", { name: "继续导入" }).click();
    await expect(page.getByText("已成功导入 2 项专利。", { exact: true })).toBeVisible();
    await expect(library.getByRole("article", { name: "批量测试" })).toHaveCount(4);
    await expect(page.getByRole("main", { name: "专利编辑区" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /DOCX.*导入/ })).toHaveCount(0);
    const restored = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.patents.list("active"),
    );
    expect(restored.ok && restored.value.every((patent) => patent.customer === "测试客户")).toBe(
      true,
    );
  } finally {
    await profile.application.close();
  }
});
