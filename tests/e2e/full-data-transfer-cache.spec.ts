import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("a fresh library remains importable after the search worker creates its cache", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("empty-cache");
  const page = await profile.application.firstWindow();
  await page.getByRole("button", { name: "文件", exact: true }).waitFor();
  await expect
    .poll(async () =>
      (await stat(join(profile.userData, "content-search-cache")).catch(() => null))?.isDirectory(),
    )
    .toBe(true);
  await workbench.removeTransientProfileMarkers(profile);
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        (window as unknown as { patentApi: PatentApi }).patentApi.dataTransfer.inspectLibrary(),
      );
      return result.ok ? result.value : result;
    })
    .toMatchObject({ empty: true, blockers: [] });
  // The initial welcome check may precede removal of the test debugger's profile marker.
  const closeWelcome = page.getByRole("button", { name: "关闭欢迎提示" });
  if (await closeWelcome.isVisible()) await closeWelcome.click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: "数据迁移", exact: true }).click();
  await settings.getByRole("button", { name: "导入完整数据包", exact: true }).click();
  const wizard = page.getByRole("dialog", { name: "完整数据迁移" });
  await wizard.getByRole("button", { name: "导入完整数据包", exact: true }).click();
  await expect(wizard.getByRole("heading", { name: "当前专利库为空" })).toBeVisible();
  await wizard.getByRole("button", { name: "关闭完整数据迁移" }).click();
  await profile.application.close();
});
