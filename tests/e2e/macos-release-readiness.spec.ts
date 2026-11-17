import { expect, test } from "./helpers/workbench.js";

test("Mac Settings menu reaches the actual settings dialog and reserves window shortcuts", async ({
  workbench,
}) => {
  test.skip(process.platform !== "darwin", "Mac native application menu");
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  const accelerator = await app.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes("index.html"),
    );
    const item = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find(
      (item) => item.label === "设置…",
    );
    if (!window || !item) throw new Error("Settings menu missing");
    item.click(undefined as never, window, {} as never);
    return item.accelerator;
  });
  expect(accelerator).toBe("Command+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settings).toBeHidden();
  await app.close();
});
