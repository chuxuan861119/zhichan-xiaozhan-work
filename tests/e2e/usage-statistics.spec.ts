import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { APPLICATION_VERSION } from "../../src/shared/branding.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("silent startup, inline notice, opt-out and local work through the hidden Electron bridge", async ({
  workbench,
}) => {
  let application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    const statisticsDialog = page.getByRole("dialog", { name: "用户协议：使用统计", exact: true });
    const initial = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.usageStatistics?.read(),
    );
    expect(initial?.ok && initial.value.enabled).toBe(true);
    expect(initial?.ok && initial.value.accepted).toBe(false);
    await expect(statisticsDialog).toHaveCount(0);
    await dismissWorkbenchWelcome(page);
    const runtime = await application.evaluate(({ powerMonitor }) => ({
      platform: process.platform,
      lockState: powerMonitor.getSystemIdleState(60),
    }));
    const agreementVersion = await page.evaluate(() => window.patentApi.agreements?.read());
    expect(agreementVersion?.ok && agreementVersion.value.appVersion).toBe(APPLICATION_VERSION);
    expect(runtime.platform).toBe("win32");
    expect(["active", "idle", "locked"]).toContain(runtime.lockState);
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "软件使用协议", exact: true }).click();
    const agreement = page.getByRole("dialog", { name: "软件使用协议", exact: true });
    await agreement.getByRole("button", { name: "查看统计告知并选择" }).click();
    const notice = agreement.getByRole("region", { name: "使用统计告知", exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "同意并参与统计" })).toBeDisabled();
    await expect(statisticsDialog).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("usage-inline-notice.png") });
    await notice.getByRole("button", { name: "关闭统计", exact: true }).click();
    await expect(notice).toBeHidden();
    await agreement.getByRole("button", { name: "关闭软件使用协议", exact: true }).click();
    const disabled = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.usageStatistics?.read(),
    );
    expect(disabled?.ok && disabled.value.status).toBe("disabled");
    const library = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.patents.list("active"),
    );
    expect(library.ok).toBe(true);
    const exportPath = join(workbench.root, "usage-offline.patdoc");
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, exportPath);
    const saved = await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const created = await api.patents.create({
        patentType: "invention",
        name: "统计关闭后的本地保存测试",
      });
      if (!created.ok) return { created: false, flushed: false, exported: false };
      const request = {
        patentId: created.value.patentId,
        expectedRevision: created.value.revision,
      };
      const flushed = await api.patents.flush(request);
      const exported = await api.patents.exportPatdoc(request);
      return {
        created: true,
        flushed: flushed.ok,
        exported: exported.ok && exported.value !== null,
      };
    });
    expect(saved).toEqual({ created: true, flushed: true, exported: true });
    expect((await stat(exportPath)).size).toBeGreaterThan(0);
    await application.close();
    application = await workbench.launchAllowMultipleInstances();
    const reopened = await application.firstWindow();
    const persisted = await reopened.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.usageStatistics?.read(),
    );
    expect(persisted?.ok && persisted.value.enabled).toBe(false);
    await expect(
      reopened.getByRole("dialog", { name: "用户协议：使用统计", exact: true }),
    ).toHaveCount(0);
    const statePath = join(workbench.userData, "usage-statistics.json");
    const before = await readFile(statePath, "utf8");
    const modified = (await stat(statePath)).mtimeMs;
    // Observe past the former 30-second checkpoint boundary, without activating any window.
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    expect((await stat(statePath)).mtimeMs).toBe(modified);
    expect(await readFile(statePath, "utf8")).toBe(before);
    const windows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
  } finally {
    await application.close();
  }
});
