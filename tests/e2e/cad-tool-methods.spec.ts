import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD grouped menus create native draw variants and return focus", async ({ workbench }) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
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
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 60_000 },
  );
  const reset = async () => {
    await canvas.press("Escape");
    await expect(workspace.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
  };
  // Real native previews and commits for the added draw methods.
  for (const [menu, method, positions] of [
    [
      "圆选项",
      "两点",
      [
        [150, 150],
        [280, 220],
      ],
    ],
    [
      "圆选项",
      "三点",
      [
        [150, 150],
        [280, 150],
        [210, 230],
      ],
    ],
    [
      "圆弧选项",
      "起点、圆心、终点",
      [
        [280, 150],
        [200, 150],
        [200, 230],
      ],
    ],
    [
      "椭圆选项",
      "轴、端点",
      [
        [150, 150],
        [250, 150],
        [200, 250],
      ],
    ],
    [
      "椭圆选项",
      "椭圆弧",
      [
        [150, 150],
        [250, 150],
        [200, 250],
        [280, 150],
        [200, 250],
      ],
    ],
    [
      "正多边形选项",
      "正多边形 · 指定一条边",
      [
        [150, 150],
        [230, 200],
      ],
    ],
  ] as const) {
    await panel.getByRole("button", { name: menu, exact: true }).click();
    await expect(page.getByRole("menu", { name: menu })).toBeVisible();
    await page.getByRole("menuitemradio", { name: method, exact: true }).click();
    for (const [x, y] of positions) {
      await canvas.click({ position: { x, y } });
      await page.waitForTimeout(150);
    }
    await expect(workspace.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
    await expect(
      workspace.getByRole("button", { name: "撤销标号编辑", exact: true }),
    ).toBeEnabled();
    await reset();
  }
  await panel.getByRole("button", { name: "圆选项", exact: true }).click();
  await expect(page.getByRole("menu", { name: "圆选项" })).toBeVisible();
  await page.getByRole("menu", { name: "圆选项" }).evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await page.screenshot({ path: "test-results/cad-tool-methods-menu.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 600, y: 300 } });
  await canvas.click({ position: { x: 800, y: 300 } });
  await reset();
  await canvas.click({ position: { x: 150, y: 150 } });
  await expect(panel.getByText(/\d+ 个对象已选中/)).toBeVisible();
  await panel.getByRole("button", { name: "阵列选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "路径阵列", exact: true }).click();
  await canvas.click({ position: { x: 700, y: 300 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(workspace.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
  await page.screenshot({ path: "test-results/cad-tool-methods.png" });
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
