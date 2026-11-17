import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";
import { expect, expectActivePane, test } from "./helpers/workbench.js";

test("dual-view rail shortcuts clean only the active book and remain undoable", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  await mkdir(workbench.userData, { recursive: true });
  await writeFile(
    join(workbench.userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      welcomeCompleted: true,
      shortcuts: {
        ...DEFAULT_APP_SETTINGS.shortcuts,
        "clear-extra-formatting": "F9",
        "assign-custom-reference-number": "F10",
      },
    }),
  );
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    expect(
      await page.evaluate(() =>
        (window as unknown as { patentApi: PatentApi }).patentApi.settings.read(),
      ),
    ).toMatchObject({
      ok: true,
      value: { shortcuts: { "clear-extra-formatting": "F9" } },
    });
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("双显快捷键隔离回归");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书" })).toBeVisible();
    expect(errors).toEqual([]);
    await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
    await page.getByRole("menuitem", { name: "权／说", exact: true }).click();
    const claims = page
      .getByRole("region", { name: "左侧文档" })
      .getByRole("textbox", { name: "编辑 权利要求书" });
    const description = page
      .getByRole("region", { name: "右侧文档" })
      .getByRole("textbox", { name: "编辑 说明书" });
    await claims.fill("1. 左侧　　装置。");
    await description.fill("右侧　　说明。");
    await claims.click();
    await expectActivePane(page, "left");
    await claims.press("F9");
    await expect(claims).toHaveText("1.左侧装置。");
    await claims.press("F10");
    const numberInput = page.getByRole("textbox", { name: "自定义编号数字" });
    await expect(numberInput).toBeVisible();
    await expect(numberInput).toBeFocused();
    await page.getByRole("button", { name: "取消自定义编号" }).click();
    await expect(description).toHaveText("右侧　　说明。");
    await claims.press("Control+z");
    await expect(claims).toHaveText("1. 左侧　　装置。");
    await claims.press("Control+y");
    await expect(claims).toHaveText("1.左侧装置。");
    await description.click();
    await expectActivePane(page, "right");
    await description.press("F9");
    await expect(description).toHaveText("右侧说明。");
    await expect(claims).toHaveText("1.左侧装置。");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
