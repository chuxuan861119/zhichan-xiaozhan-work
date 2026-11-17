import { join } from "node:path";
import { expect, test } from "./helpers/workbench.js";

test("table image insertion preserves cells, undo/redo and saved content", async ({
  workbench,
}) => {
  const application = await workbench.launchAllowMultipleInstances("--headless");
  try {
    await application.evaluate(
      ({ dialog }, path) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        });
      },
      join(process.cwd(), "tests", "fixtures", "images", "sample.png"),
    );
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("表内图片回归");
    await dialog.getByRole("radio", { name: "发明" }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const later = page.getByRole("button", { name: "稍后设置" });
    if (await later.isVisible()) await later.click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 2 行 2 列表格" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const table = editor.locator("table");
    await table.locator("td").first().click();
    await page.keyboard.type("beforeafter");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await page.getByRole("button", { name: "插入图片" }).click();
    const image = table.locator("td").first().locator(".patent-inline-figure");
    await expect(image).toHaveCount(1);
    await expect(editor.locator("table")).toHaveCount(1);
    await expect(table.locator("td")).toHaveCount(4);
    await expect(table.locator("td").first()).toContainText(/^before.*after$/u);
    await page.keyboard.press("Control+z");
    await expect(image).toHaveCount(0);
    await expect(table.locator("td")).toHaveCount(4);
    await page.keyboard.press("Control+y");
    await expect(image).toHaveCount(1);
    await page.keyboard.press("Control+s");
    await expect(page.getByText("已保存", { exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await page.getByRole("tab", { name: "表内图片回归", exact: true }).click();
    await expect(image).toHaveCount(1);
    await expect(table.locator("td")).toHaveCount(4);
  } finally {
    await application.close();
  }
});
