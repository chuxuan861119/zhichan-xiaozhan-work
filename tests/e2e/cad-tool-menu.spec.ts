import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("CAD split buttons show a running menu tool and restore their defaults on cancel and completion", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  const canvas = ws.getByRole("application", { name: "CAD标号画布" });
  for (const name of ["矩形", "圆", "圆弧", "椭圆", "修剪", "圆角", "阵列", "齿轮", "弹簧"]) {
    const arrow = panel.getByRole("button", { name: `${name}选项`, exact: true });
    const main = arrow.locator("..").locator("button").first();
    const original = await main.innerHTML(),
      description = await main.getAttribute("aria-description");
    await arrow.click();
    const menu = page.getByRole("menu", { name: `${name}选项`, exact: true });
    const choice = menu.getByRole("menuitemradio").last();
    const label = await choice.textContent();
    await choice.click();
    await expect(main).toHaveAttribute("aria-description", `${name} · ${label}`);
    await canvas.press("Escape");
    await expect(main).toHaveAttribute("aria-description", description!);
    expect(await main.innerHTML()).toBe(original);
    await main.click();
    await arrow.click();
    await expect(menu.getByRole("menuitemradio").first()).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(canvas).toBeFocused();
    await canvas.press("Escape");
  }
  await panel.getByRole("button", { name: "圆选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "两点", exact: true }).click();
  await expect(panel.getByRole("button", { name: "两点", exact: true })).toBeVisible();
  await canvas.click({ position: { x: 200, y: 200 } });
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(panel.getByRole("button", { name: "圆", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await canvas.click({ button: "right", position: { x: 400, y: 300 } });
  await expect(panel.getByRole("button", { name: "两点", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await expect(panel.getByRole("button", { name: "圆", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await canvas.press("Escape");
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
