import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ADDITIONAL_LEGISLATION } from "../../src/shared/legislation-extra.js";
import { expect, test } from "./helpers/workbench.js";

test("additional official documents are selected from a compact menu and saved offline", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await page.context().setOffline(true);
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "专利法律法规" }).click();
    const reader = page.getByRole("dialog", { name: "专利法律法规", exact: true });
    const more = reader.getByRole("button", { name: "更多法规" });
    await expect(reader.getByRole("menu")).toHaveCount(0);
    for (const item of ADDITIONAL_LEGISLATION) {
      await more.click();
      await expect(reader.getByRole("menuitemradio")).toHaveCount(14);
      await reader.getByRole("menuitemradio", { name: item.title, exact: true }).click();
      await expect(reader.getByRole("menu")).toHaveCount(0);
      await expect(reader.locator(".legislation-reader__metadata strong")).toHaveText(item.title);
      await expect(reader.getByLabel("法规正文")).toContainText("第一条");
      await reader.getByRole("searchbox").fill("专利");
      await expect(reader.locator("mark").first()).toBeAttached();
    }
    await expect(reader.locator(".legislation-reader__note")).toContainText("15日");
    const saved = join(workbench.root, "electronic-application.txt");
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, saved);
    await reader.getByRole("button", { name: "保存副本" }).click();
    await expect.poll(async () => readFile(saved, "utf8").catch(() => "")).toContain("第十二条");
    expect(await readFile(saved, "utf8")).toContain("阅读提示（非原文）");
    await more.click();
    await page.screenshot({ path: test.info().outputPath("more-menu.png") });
    const menu = reader.getByRole("menu");
    const bounds = await menu.boundingBox();
    const dialogBounds = await reader.boundingBox();
    expect(
      bounds && dialogBounds && bounds.y + bounds.height <= dialogBounds.y + dialogBounds.height,
    ).toBeTruthy();
    await page.keyboard.press("Home");
    await expect(reader.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(reader.getByRole("menuitemradio").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(reader).toBeVisible();
    await expect(more).toBeFocused();
    await more.click();
    await reader.getByRole("heading", { name: "专利法律法规", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await reader.getByRole("button", { name: "专利法", exact: true }).click();
    await expect(reader.getByLabel("法规正文")).toContainText("第八十二条");
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  } finally {
    await app.close();
  }
});
