import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

test("reloads the workbench after the renderer process crashes", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const browserWindow = await application.browserWindow(page);
    const crashObserved = page.waitForEvent("crash");

    await browserWindow.evaluate((window) => {
      setTimeout(() => window.webContents.forcefullyCrashRenderer(), 0);
    });
    await crashObserved;

    await expect
      .poll(
        () =>
          browserWindow.evaluate(async (window) => {
            if (window.isDestroyed() || window.webContents.isCrashed()) return false;
            return window.webContents.executeJavaScript(
              "Boolean(document.querySelector('[data-testid=app-shell]'))",
              true,
            ) as Promise<boolean>;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await application.close().catch(() => undefined);
  }
});
