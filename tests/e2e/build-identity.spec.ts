import { readFile } from "node:fs/promises";
import { expect, test } from "./helpers/workbench.js";

test("about and diagnostics identify the same production build", async ({ workbench }) => {
  test.skip(process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1", "Use hidden isolated windows");
  const info = JSON.parse(await readFile("out/main/build-info.json", "utf8"));
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "关于知产小栈Work", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "关于知产小栈Work", exact: true });
    await expect(dialog).toContainText(`版本 ${info.version}`);
    await expect(dialog).toContainText(`构建标识：${info.buildId}`);
    await expect(dialog).toContainText("构建时间：");
    await expect(dialog).not.toContainText("热更新开发实例");
    await expect(dialog).toContainText("可离线使用");
    await expect(dialog).toContainText("所配置的模型服务");
    await page.screenshot({ path: test.info().outputPath("about-build.png") });
    const logDirectory = await app.evaluate(({ app }) => `${app.getPath("userData")}/logs`);
    const log = await readFile(`${logDirectory}/app.log`, "utf8");
    expect(log).toContain(`${info.version} (${info.buildId})`);
  } finally {
    await app.close();
  }
});
