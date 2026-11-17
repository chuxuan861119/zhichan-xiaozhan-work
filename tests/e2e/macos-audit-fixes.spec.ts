import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { expect, test } from "./helpers/workbench.js";

test("Mac flowchart native history and fine document pinch stay within their active editors", async ({
  workbench,
}) => {
  test.skip(process.platform !== "darwin", "Mac native menu");
  test.setTimeout(90_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setSize(1800, 1000);
  });
  await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("Mac审查修复验证");
  await dialog.getByRole("radio", { name: "实用新型" }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.press("Meta+0");
  const zoom = page.locator(".status-zoom-value");
  const beforePinch = Number((await zoom.getAttribute("aria-label"))?.match(/\d+/)?.[0]);
  // Zoom now belongs to the active workspace; global settings retain only defaults.
  await editor.evaluate(async (el) => {
    for (let i = 0; i < 4; i++) {
      el.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -0.1, ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  });
  await expect(zoom).toHaveAttribute("aria-label", `缩放 ${beforePinch}%，点击重置`);
  await editor.press("Meta+-");
  const smallerZoom = Math.max(50, beforePinch - 10);
  await expect
    .poll(async () => Number((await zoom.getAttribute("aria-label"))?.match(/\d+/)?.[0]))
    .toBe(smallerZoom);
  await editor.press("Meta+Alt+0");
  await page.waitForTimeout(350);
  await expect(zoom).toHaveAttribute("aria-label", `缩放 ${smallerZoom}%，点击重置`);
  await openDrawingEntry(page, "插入流程图");
  await expect
    .poll(() => page.frames().some((frame) => frame.url().endsWith("/embed.html")))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().endsWith("/embed.html"))!;
  await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  const template = frame.getByRole("button", { name: "基础流程", exact: true });
  if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
    await template.evaluate((element) => (element as HTMLButtonElement).click());
  else await template.click();
  const label = frame.getByText("处理步骤", { exact: true });
  await expect(label).toBeVisible();
  await template.focus();
  const native = (name: string) =>
    app.evaluate(({ Menu, BrowserWindow }, value) => {
      const main = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("index.html"),
      )!;
      Menu.getApplicationMenu()!
        .items.find((i) => i.label === "编辑")!
        .submenu!.items.find((i) => i.label === value)!
        .click(undefined as never, main, {} as never);
    }, name);
  await native("撤销");
  await expect(label).toHaveCount(0);
  await native("重做");
  await expect(label).toBeVisible();
  await app.close();
  const marker = JSON.parse(
    await readFile(join(workbench.root, "library", "last-run-state.json"), "utf8"),
  );
  expect(marker.cleanShutdown).toBe(true);
});

test("forced exit keeps the run unclean and verifies recovery after restart", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 150);
  });
  await page
    .evaluate(() =>
      (window as unknown as { patentApi: PatentApi }).patentApi.application.forceClose(),
    )
    .catch(() => undefined);
  await closed;
  const marker = JSON.parse(
    await readFile(join(workbench.root, "library", "last-run-state.json"), "utf8"),
  );
  expect(marker.cleanShutdown).toBe(false);
  const reopened = await workbench.launch();
  const nextPage = await reopened.firstWindow();
  const recovery = await nextPage.evaluate(() =>
    window.patentApi.application.getStartupRecoveryReport?.(),
  );
  expect(recovery).toMatchObject({
    ok: true,
    value: { previousShutdown: "unclean", mode: "read-write", quarantinedPatentCount: 0 },
  });
  // Healthy integrity checks intentionally stay silent; only actionable recovery is shown.
  await expect(nextPage.getByLabel("启动恢复状态")).toHaveCount(0);
  await reopened.close();
});
