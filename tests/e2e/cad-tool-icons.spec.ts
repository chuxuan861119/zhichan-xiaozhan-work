import { writeFile } from "node:fs/promises";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD diagrams distinguish methods at normal and enlarged UI sizes", async ({ workbench }) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const capture = async (path: string) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing background test window");
      return (await window.webContents.capturePage()).toPNG().toString("base64");
    });
    await writeFile(path, Buffer.from(png, "base64"));
  };
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
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
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.webContents.setZoomFactor(factor);
    }, zoom);
    for (const name of ["圆弧", "圆", "椭圆", "矩形", "阵列", "修剪", "圆角"]) {
      await panel.getByRole("button", { name: name + "选项", exact: true }).click();
      const menu = page.getByRole("menu", { name: name + "选项" });
      await expect(menu).toBeVisible();
      const diagrams = await menu
        .locator("button svg")
        .evaluateAll((els) => els.map((el) => el.innerHTML));
      expect(new Set(diagrams).size).toBe(diagrams.length);
      const dimensions = await menu.locator("button svg").first().boundingBox();
      expect(dimensions?.width).toBeGreaterThanOrEqual(20);
      const bounds = await menu.boundingBox();
      const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.w + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.h + 1);
      if (name === "圆弧") await capture(`test-results/cad-icons-arcs-${zoom}.png`);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
  );
  await panel.getByRole("button", { name: "圆弧选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "起点、终点、半径", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "起点、终点、半径", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await capture("test-results/cad-icons-selected-disabled.png");
  await expect(panel.getByRole("button", { name: "编组", exact: true })).toBeDisabled();
  await expect(canvas).toBeFocused();
});
