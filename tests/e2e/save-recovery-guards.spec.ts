import { createRequire } from "node:module";
import type { ElectronApplication, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

type Faults = { arm: boolean; blocked: boolean; release: (() => void) | null };
const previousEntry = process.env.PATENT_WORKBENCH_E2E_APP_ENTRY;
test.beforeAll(async () => {
  if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND !== "1") throw Error("Background mode required");
  process.env.PATENT_WORKBENCH_E2E_APP_ENTRY = await createRequire(import.meta.url)(
    "./fixtures/save-recovery-faults.cjs",
  )();
});
test.afterAll(() => {
  if (previousEntry === undefined) delete process.env.PATENT_WORKBENCH_E2E_APP_ENTRY;
  else process.env.PATENT_WORKBENCH_E2E_APP_ENTRY = previousEntry;
});

async function welcome(page: Page) {
  await page.getByTestId("app-shell").waitFor();
  await dismissWorkbenchWelcome(page);
}
async function create(page: Page, name: string) {
  await page.getByRole("tab", { name: "专利库", exact: true }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await page.getByRole("textbox", { name: "编辑 权利要求书", exact: true }).waitFor();
}
async function replaceText(page: Page, text: string) {
  await page
    .getByRole("textbox", { name: "编辑 权利要求书", exact: true })
    .evaluate((element, text) => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      editor.commands.selectAll();
      editor.commands.insertContent(text);
    }, text);
}
async function arm(app: ElectronApplication) {
  await app.evaluate(() => {
    (globalThis as unknown as { __saveRecoveryFaults: Faults }).__saveRecoveryFaults.arm = true;
  });
}
async function blocked(app: ElectronApplication) {
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { __saveRecoveryFaults: Faults }).__saveRecoveryFaults.blocked,
      ),
    )
    .toBe(true);
}
async function release(app: ElectronApplication) {
  await app.evaluate(() => {
    (globalThis as unknown as { __saveRecoveryFaults: Faults }).__saveRecoveryFaults.release?.();
  });
}
async function reopen(page: Page, name: string, text: string) {
  await welcome(page);
  const card = page.getByRole("article", { name });
  await card.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "编辑 权利要求书", exact: true })).toContainText(
    text,
  );
}

test("system end request waits for the queued latest text even with close-to-tray enabled", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await welcome(page);
    await create(page, "结束会话防丢");
    await arm(app);
    await replaceText(page, "第一版");
    await blocked(app);
    await replaceText(page, "第一版加结束会话前最新修改");
    const prevented = await app.evaluate(({ BrowserWindow }) => {
      let prevented = false;
      BrowserWindow.getAllWindows()[0]?.emit("query-session-end", {
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    });
    expect(prevented).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const windowClosed = page.waitForEvent("close");
    const exited = new Promise<void>((resolve) => app.once("close", resolve));
    await release(app);
    await windowClosed;
    // macOS retains the application after its last window closes. Persistence
    // has completed at this point; finish the isolated test process explicitly.
    if (process.platform === "darwin") await app.close();
    else await exited;
  } finally {
    await app.close().catch(() => undefined);
  }
  const reopened = await workbench.launchAllowMultipleInstances();
  try {
    await reopen(await reopened.firstWindow(), "结束会话防丢", "第一版加结束会话前最新修改");
  } finally {
    await reopened.close();
  }
});

test("a live renderer reload request waits for slow queued edits before navigating", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await welcome(page);
    await create(page, "重载防丢");
    await arm(app);
    await replaceText(page, "第一版");
    await blocked(app);
    await replaceText(page, "第一版加重载前最新修改");
    await page.evaluate(() => {
      const reload = (window as unknown as { patentApi: PatentApi }).patentApi.application
        .reloadRenderer;
      if (!reload) throw Error("Missing native recovery API");
      return reload();
    });
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书", exact: true })).toContainText(
      "重载前最新修改",
    );
    const navigation = page.waitForEvent("domcontentloaded");
    await release(app);
    await navigation;
    await reopen(page, "重载防丢", "第一版加重载前最新修改");
  } finally {
    await app.close();
  }
});

test("React crash recovery retains queued text until save completes then reloads", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await welcome(page);
    await create(page, "已保存的对照专利");
    await replaceText(page, "对照正文");
    await expect(page.locator(".status-bar").getByRole("status", { name: "已保存" })).toBeVisible();
    await create(page, "错误页防丢");
    await arm(app);
    await replaceText(page, "第一版");
    await blocked(app);
    await replaceText(page, "第一版加界面报错前最新修改");
    // Switching to the saved control patent renders its timestamp in StatusBar.
    // Throw during that render, after the latest edit has entered the real queue.
    await page.evaluate(() => {
      Date.prototype.toLocaleString = () => {
        throw Error("Injected saved badge rendering failure");
      };
    });
    await page.getByRole("tab", { name: "已保存的对照专利", exact: true }).click();
    await expect(page.getByRole("heading", { name: "编辑界面发生错误" })).toBeVisible();
    await page.getByRole("button", { name: "重新加载界面" }).click();
    await expect(page.getByRole("status")).toContainText("正在保存最近修改");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const navigation = page.waitForEvent("domcontentloaded");
    await release(app);
    await navigation;
    await reopen(page, "错误页防丢", "第一版加界面报错前最新修改");
  } finally {
    await app.close();
  }
});
