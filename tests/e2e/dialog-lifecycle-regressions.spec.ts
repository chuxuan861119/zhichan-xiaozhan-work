import { expect, test } from "./helpers/workbench.js";

test("IPC retains dragged location after maximize and restore", async ({ workbench }, info) => {
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "IPC数据中心", exact: true });
    await expect(dialog).toBeVisible();
    await page.frameLocator("iframe").locator("#classificationInput").waitFor();
    const header = await dialog.locator("header").boundingBox();
    if (!header) throw Error("missing header");
    await page.mouse.move(header.x + 100, header.y + 20);
    await page.mouse.down();
    await page.mouse.move(header.x + 200, header.y + 120, { steps: 8 });
    await page.mouse.up();
    const before = await dialog.boundingBox();
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    await expect(dialog).toHaveAttribute("data-maximized", "true");
    await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(1440);
    await dialog.getByRole("button", { name: "还原IPC数据中心" }).click();
    await expect(dialog).toHaveAttribute("data-maximized", "false");
    await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(before?.width);
    const after = await dialog.boundingBox();
    await info.attach("geometry", {
      body: JSON.stringify({ before, after }),
      contentType: "application/json",
    });
    const expectRestored = async () => {
      if (!before) throw new Error("Missing original dialog bounds");
      await expect
        .poll(async () => {
          const current = await dialog.boundingBox();
          return current
            ? Math.max(
                ...(["x", "y", "width", "height"] as const).map((key) =>
                  Math.abs(current[key] - before[key]),
                ),
              )
            : Infinity;
        })
        .toBeLessThan(1);
    };
    await expectRestored();
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    await dialog.getByRole("button", { name: "还原IPC数据中心" }).click();
    await expectRestored();
    await dialog.getByRole("button", { name: "返回编辑器" }).click();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    await expectRestored();
    await dialog.getByRole("button", { name: "返回编辑器" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "显示偏好", exact: true }).click();
    const reducedMotion = settings.getByRole("checkbox", { name: "减少界面动画", exact: true });
    await reducedMotion.click();
    await expect(reducedMotion).toBeChecked();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    await dialog.getByRole("button", { name: "还原IPC数据中心" }).click();
    await expectRestored();
  } finally {
    await app.close();
  }
});

test("shared default templates can be switched, saved and reopened without compressing the editor", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "默认模板", exact: true }).click();
    const open = settings.getByRole("button", { name: "打开默认模板设置" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "默认模板设置", exact: true });
    const toggle = dialog.getByRole("switch", { name: "发明与实用新型分别设置" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("tablist", { name: "专利类型" })).toHaveCount(0);
    await toggle.click();
    await expect(dialog.getByRole("tab", { name: "实用新型", exact: true })).toBeVisible();
    const workspace = await dialog.locator(".template-catalog-dialog__workspace").boundingBox();
    expect(workspace?.height).toBeGreaterThan(200);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog)
      .toHaveCount(0)
      .catch(async (error) => {
        console.log(
          "template-save-diagnostic",
          await page.locator('[role="alert"], .template-catalog-error').allTextContents(),
          await dialog.innerText(),
        );
        await page.screenshot({ path: test.info().outputPath("save-failure.png") });
        throw error;
      });
    await open.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    const confirm = page.getByRole("dialog", { name: "请确认", exact: true });
    await expect(confirm).toContainText("实用新型的模板和当前选择会保留");
    await confirm.getByRole("button", { name: "确定", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog)
      .toHaveCount(0)
      .catch(async (error) => {
        console.log(
          "template-save-diagnostic",
          await page.locator('[role="alert"], .template-catalog-error').allTextContents(),
          await dialog.innerText(),
        );
        await page.screenshot({ path: test.info().outputPath("save-failure.png") });
        throw error;
      });
    await open.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("tablist", { name: "专利类型" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    await application.close();
  }
});
