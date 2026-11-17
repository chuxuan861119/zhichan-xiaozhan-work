import { expect, test } from "./helpers/workbench.js";

test("opens default templates from the unified Settings screen without a renderer error", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  const rendererErrors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await expect(settings).toBeVisible();

    await settings.getByRole("button", { name: "默认模板", exact: true }).click();
    await expect(settings.getByRole("region", { name: "默认模板内容" })).toBeVisible();
    expect(rendererErrors).toEqual([]);
  } finally {
    await application.close().catch(() => undefined);
  }
});
