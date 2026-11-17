import { execFile } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await page.getByTestId("app-shell").waitFor({ state: "visible" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  const visible = await welcome
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (visible) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function createPatent(page: Page, name: string, type: "发明" | "实用新型"): Promise<void> {
  const patentLibrary = page.getByRole("tab", { name: "专利库" });
  if (await patentLibrary.isVisible()) await patentLibrary.click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建专利" });
  await createDialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await createDialog.getByRole("radio", { name: type }).check();
  await createDialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function terminateProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (error) => {
      error ? reject(error) : resolve();
    });
  });
}

async function closeWindowGracefully(application: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => application.once("close", () => resolve()));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("正常关闭窗口后 Electron 未及时退出。")), 15_000),
    ),
  ]);
}

/**
 * Regression test for the v0.1.0-rc.1 data-loss defect:
 * editing then immediately closing the window lost unsaved changes
 * because no close handshake intercepted the BrowserWindow close event.
 *
 * This test verifies the fix: the close handshake flushes all pending
 * save queues before the window is destroyed, so one character typed
 * immediately before closing survives a relaunch.
 */
test("persists one character when the window closes immediately after editing", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const patentName = "关闭回归测试";

  // --- First launch: create patent, type one character, immediately close ---
  const first = await workbench.launch();
  try {
    const page = await first.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, patentName, "发明");

    // Default title-bar close now hides to tray; explicitly exercise full exit.
    const settingsResult = await page.evaluate(() =>
      (window as unknown as { patentApi: PatentApi }).patentApi.settings.update({
        closeToTray: false,
      }),
    );
    expect(settingsResult.ok).toBe(true);

    // Navigate to the claims book and replace content with a single character
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("中");

    // Simulate a title-bar window close — triggers the close handshake.
    // Register the exit listener before calling evaluate to avoid races.
    const exited = new Promise<void>((resolve) => {
      first.once("close", () => resolve());
    });
    await first
      .evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      })
      .catch(() => undefined);
    // Wait for the process to exit via the close handshake.
    // If the handshake is broken, this will timeout and fail the test.
    await exited;
  } finally {
    await first.close().catch(() => undefined);
  }

  // --- Second launch: reopen the patent and verify data survived ---
  const reopened = await workbench.launch();
  try {
    const page = await reopened.firstWindow();
    await dismissWelcome(page);

    // Open the patent from the library
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await patentCard.getByRole("menuitem", { name: "继续编辑" }).click();

    // Navigate to the claims book
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();

    // Verify the character persisted through the close handshake
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await expect(editor).toContainText("中");
  } finally {
    await reopened.close().catch(() => undefined);
  }
});

test("reports an abnormal exit once and keeps the saved patent available", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const patentName = "异常退出恢复测试";
  const warmup = await workbench.launchAllowMultipleInstances();
  await dismissWelcome(await warmup.firstWindow());
  await closeWindowGracefully(warmup);

  const first = await workbench.launchAllowMultipleInstances();
  const firstPage = await first.firstWindow();
  await dismissWelcome(firstPage);
  await createPatent(firstPage, patentName, "发明");
  await firstPage.getByRole("tab", { name: "权利要求书", exact: true }).click();
  const editor = firstPage.getByRole("textbox", { name: "编辑 权利要求书" });
  await editor.click();
  await firstPage.keyboard.press("Control+A");
  await firstPage.keyboard.type("异常退出前已保存的内容");
  await expect(
    firstPage.getByRole("tab", { name: patentName }).getByRole("status", { name: "已保存" }),
  ).toBeVisible();

  const exited = new Promise<void>((resolve) => first.once("close", () => resolve()));
  await terminateProcessTree(first.process().pid ?? 0);
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("异常终止后 Electron 未及时退出。")), 10_000),
    ),
  ]);
  await first.close().catch(() => undefined);

  const recovered = await workbench.launchAllowMultipleInstances();
  try {
    const page = await recovered.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByRole("status", { name: "启动恢复状态" })).toContainText(
      "上次未正常退出",
    );
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await patentCard.getByRole("menuitem", { name: "继续编辑" }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
      "异常退出前已保存的内容",
    );
  } finally {
    await closeWindowGracefully(recovered).catch(() => undefined);
  }

  const normalRestart = await workbench.launchAllowMultipleInstances();
  try {
    const page = await normalRestart.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByRole("status", { name: "启动恢复状态" })).toHaveCount(0);
  } finally {
    await closeWindowGracefully(normalRestart).catch(() => undefined);
  }
});
