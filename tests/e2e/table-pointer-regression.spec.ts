import { expect, test } from "./helpers/workbench.js";

test("mouse clicks place text in the requested table cell", async ({ workbench }) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  const welcome = page.getByRole("dialog", {
    name: "欢迎使用知产小栈专利工作台",
  });
  await welcome.waitFor({ state: "visible", timeout: 2000 }).catch(() => undefined);
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("表格鼠标定位回归");
  await dialog.getByRole("radio", { name: "发明" }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.getByRole("button", { name: "插入表格" }).click();
  await page
    .getByRole("region", { name: "插入表格设置" })
    .getByRole("button", { name: "插入 3 行 3 列表格" })
    .click();
  const editor = page.getByRole("textbox", { name: "编辑 说明书" });
  const cells = editor.locator("td");
  await expect(cells).toHaveCount(9);
  for (let index = 0; index < 9; index += 1) {
    await cells.nth(index).click();
    await page.keyboard.type(String(index + 1));
    await expect(cells.nth(index)).toHaveText(String(index + 1));
  }
  await app.close();
});
