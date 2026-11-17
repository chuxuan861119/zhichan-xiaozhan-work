import { expect, test } from "./helpers/workbench.js";

test("shows the Xiaozhan identity in the welcome, title bar, workspace, and About dialog", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle("知产小栈Work");

    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible().catch(() => false)) {
      await expect(welcome.getByRole("img", { name: "知产小栈专利工作台 Logo" })).toBeVisible();
      await welcome.getByRole("button", { name: "暂不创建" }).click();
    }

    const libraryTab = page.getByRole("tab", { name: "专利库" });
    await expect(libraryTab.locator(".patent-tabs__brand-logo")).toBeVisible();

    await page.getByRole("button", { name: "帮助" }).click();
    await page.getByRole("menuitem", { name: "关于知产小栈Work" }).click();
    const about = page.getByRole("dialog", { name: "关于知产小栈Work" });
    await expect(about).toContainText("知产小栈Work");
    await expect(about).toContainText("版本 0.1.0");
    await expect(about.getByRole("img", { name: "知产小栈Work Logo" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});
