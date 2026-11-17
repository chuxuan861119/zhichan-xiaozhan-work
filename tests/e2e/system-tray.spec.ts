/// <reference lib="dom" />

import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("close hides, saves, restores through tray, opens settings and safely exits", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const application = await workbench.launch();
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("托盘保存验收装置");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书" });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("1. 一种托盘保存验收装置，其特征在于：包括验证部件。");
  await application.evaluate(({ BrowserWindow, webContents, Menu }) => {
    const state = globalThis as typeof globalThis & {
      trayTest?: { menu: Electron.Menu | null; hides: number; shows: number };
    };
    state.trayTest = { menu: null, hides: 0, shows: 0 };
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      if (template.some((item) => item.label === "退出软件")) state.trayTest!.menu = menu;
      return menu;
    };
    const window = webContents
      .getAllWebContents()
      .map((contents) => BrowserWindow.fromWebContents(contents))
      .find(Boolean)!;
    const hide = window.hide.bind(window);
    window.hide = () => {
      state.trayTest!.hides++;
      hide();
    };
    // The background fixture deliberately suppresses OS window activation.
    const show = window.show.bind(window);
    window.show = () => {
      state.trayTest!.shows++;
      show();
    };
    window.close();
  });
  await expect
    .poll(() =>
      application.evaluate(() => {
        const state = (
          globalThis as typeof globalThis & { trayTest: { menu: Electron.Menu; hides: number } }
        ).trayTest;
        return { hides: state.hides, labels: state.menu?.items.map((item) => item.label) };
      }),
    )
    .toEqual({ hides: 1, labels: ["打开主窗口", "后台保存：已完成", "", "设置", "", "退出软件"] });
  await application.evaluate(() => {
    const menu = (globalThis as typeof globalThis & { trayTest: { menu: Electron.Menu } }).trayTest
      .menu;
    const item = menu.items.find((item) => item.label === "打开主窗口")!;
    item.click();
  });
  await expect(editor).toContainText("包括验证部件");
  await application.evaluate(() => {
    const menu = (globalThis as typeof globalThis & { trayTest: { menu: Electron.Menu } }).trayTest
      .menu;
    menu.items.find((item) => item.label === "设置")!.click();
  });
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    settings.getByRole("checkbox", { name: "关闭窗口时最小化到系统托盘" }),
  ).toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "开机启动", exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  const closed = application.waitForEvent("close");
  await application.evaluate(() => {
    const menu = (globalThis as typeof globalThis & { trayTest: { menu: Electron.Menu } }).trayTest
      .menu;
    menu.items.find((item) => item.label === "退出软件")!.click();
  });
  await closed;
  expect(errors).toEqual([]);
  const reopened = await workbench.launch();
  const library = await reopened.firstWindow();
  await expect(library.getByText("托盘保存验收装置", { exact: true }).first()).toBeVisible();
  await library.getByText("托盘保存验收装置", { exact: true }).first().dblclick();
  await library.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await expect(library.getByRole("textbox", { name: "编辑 权利要求书" })).toContainText(
    "包括验证部件",
  );
  const result = await library.evaluate(() =>
    (window as unknown as { patentApi: PatentApi }).patentApi.settings.update({
      closeToTray: false,
    }),
  );
  expect(result.ok).toBe(true);
  const directExit = reopened.waitForEvent("close");
  await reopened.evaluate(({ BrowserWindow, webContents }) => {
    const window = webContents
      .getAllWebContents()
      .map((contents) => BrowserWindow.fromWebContents(contents))
      .find(Boolean);
    if (!window) throw new Error("Main window missing");
    window.close();
  });
  if (process.platform === "darwin") {
    await expect
      .poll(() => reopened.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    await reopened.evaluate(({ app }) => app.quit());
  }
  await directExit;
});
