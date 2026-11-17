import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

function bookTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

async function mockNativeDialogs(
  application: ElectronApplication,
  imagePaths: string[],
): Promise<void> {
  await application.evaluate(({ dialog }, paths) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: paths }),
    });
  }, imagePaths);
}

async function createPatent(page: Page, name: string): Promise<void> {
  const patentLibrary = page.getByRole("tab", { name: "专利库" });
  if (await patentLibrary.isVisible()) await patentLibrary.click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建专利" });
  await createDialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await createDialog.getByRole("radio", { name: "发明" }).check();
  await createDialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function figureIds(page: Page): Promise<string[]> {
  return page
    .locator(".drawing-pair-row")
    .evaluateAll((rows) =>
      rows
        .map((row) => row.getAttribute("data-figure-id"))
        .filter((id): id is string => id !== null),
    );
}

test("removes an imported drawing through its top-right remove control", async ({ workbench }) => {
  test.setTimeout(120_000);
  const pngPath = join(process.cwd(), "tests", "fixtures", "images", "sample.png");
  const application = await workbench.launch();
  try {
    await mockNativeDialogs(application, [pngPath, pngPath]);
    const page = await application.firstWindow();
    await dismissWelcome(page);

    await createPatent(page, "删除附图验收");

    await bookTab(page, "说明书附图").click();
    await page.getByRole("button", { name: "导入图片" }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    const [firstFigureId, secondFigureId] = await figureIds(page);

    // 选中第一张图后，点击其右上角删除叉号。
    await page.getByRole("button", { name: "选择图1" }).click();
    await expect(page.getByRole("button", { name: "删除图1" })).toBeVisible();
    await page.getByRole("button", { name: "删除图1" }).click();

    // 剩余附图按数组位置重编号，因此用稳定 figureId 判断删除结果。
    await expect(page.getByRole("article")).toHaveCount(1);
    expect(await figureIds(page)).toEqual([secondFigureId]);
    expect(firstFigureId).not.toBe(secondFigureId);
  } finally {
    await application.close();
  }
});

test("removes a drawing from the sort-mode remove control", async ({ workbench }) => {
  test.setTimeout(120_000);
  const pngPath = join(process.cwd(), "tests", "fixtures", "images", "sample.png");
  const application = await workbench.launch();
  try {
    await mockNativeDialogs(application, [pngPath, pngPath]);
    const page = await application.firstWindow();
    await dismissWelcome(page);

    await createPatent(page, "排序删除验收");

    await bookTab(page, "说明书附图").click();
    await page.getByRole("button", { name: "导入图片" }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    const [firstFigureId, secondFigureId] = await figureIds(page);

    await page.getByRole("button", { name: "附图排序" }).click();
    await page.getByRole("button", { name: "删除图2" }).click();

    await expect(page.getByRole("article")).toHaveCount(1);
    expect(await figureIds(page)).toEqual([firstFigureId]);
    expect(firstFigureId).not.toBe(secondFigureId);
  } finally {
    await application.close();
  }
});
