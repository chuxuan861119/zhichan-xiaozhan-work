import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD rail tools align consistently and offer compact drawing menus", async ({ workbench }) => {
  const app = await workbench.launch();
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
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const detail = panel.getByRole("button", { name: "局部放大", exact: true });
  const line = panel.getByRole("button", { name: "直线", exact: true });
  await expect(detail).toBeEnabled({ timeout: 60_000 });
  const modify = panel.getByRole("group", {name:"修改",exact:true});
  const copy = modify.getByRole("button", {name:"复制",exact:true});
  expect(await copy.evaluate(element => element.nextElementSibling?.getAttribute("data-drawing-tool"))).toBe("detail");
  expect((await detail.boundingBox())!.x).toBeGreaterThan((await copy.boundingBox())!.x);
  expect((await detail.boundingBox())!.y).toBeCloseTo((await copy.boundingBox())!.y,0);
  await expect(line).toBeEnabled({ timeout: 60_000 });
  const appearance = (button: typeof detail) => button.evaluate(element => {
    const css = getComputedStyle(element);
    const svg = getComputedStyle(element.querySelector("svg")!);
    return {
      font: css.fontSize, color: css.color, gap: css.gap, padding: css.padding,
      height: css.minHeight, radius: css.borderRadius, opacity: css.opacity,
      iconWidth: svg.width, iconHeight: svg.height,
    };
  });
  await page.mouse.move(0, 0);
  await expect(line).toHaveCSS("opacity", "1");
  expect(await appearance(detail)).toEqual(await appearance(line));
  const offCenter = await panel.locator(".cad-split-tool").evaluateAll(items => items.flatMap(item => {
    const outer = item.getBoundingClientRect();
    const center = outer.left + outer.width / 2;
    return [...item.querySelectorAll("button:first-child > svg, button:first-child > span")].filter(child => {
      const bounds = child.getBoundingClientRect();
      return Math.abs(bounds.left + bounds.width / 2 - center) > 0.75;
    }).map(child => ({ tool: item.textContent, child: child.tagName }));
  }));
  expect(offCenter).toEqual([]);
  expect(await panel.locator(".cad-split-tool__arrow").evaluateAll(arrows => arrows.every(arrow => {
    const bounds = arrow.getBoundingClientRect();
    const tool = arrow.parentElement!.getBoundingClientRect();
    return Math.abs(bounds.top - tool.top) < 0.75 && Math.abs(bounds.bottom - tool.bottom) < 0.75;
  }))).toBe(true);
  for (const name of ["圆", "圆弧", "椭圆", "阵列"]) {
    const arrow = panel.getByRole("button", { name: `${name}选项`, exact: true });
    await arrow.click();
    const menu = page.getByRole("menu", { name: `${name}选项`, exact: true });
    await expect(menu).toBeVisible();
    const layout = await menu.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width, viewport: innerWidth };
    });
    expect(layout.width).toBeLessThanOrEqual(188);
    expect(layout.left).toBeGreaterThanOrEqual(8);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport - 8);
    for (const item of await menu.getByRole("menuitemradio").all()) {
      await expect(item).toHaveCSS("font-size", "12px");
      await expect(item.locator("svg")).toHaveCSS("width", "20px");
      expect((await item.boundingBox())!.height).toBeLessThanOrEqual(30);
      expect(await item.locator("span").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    if (name === "圆弧") await menu.screenshot({ path: "test-results/cad-compact-arc-menu.png" });
    if (name === "阵列") await menu.screenshot({ path: "test-results/cad-compact-array-menu.png" });
    await menu.press("Escape");
    await expect(menu).toBeHidden();
    await expect(workspace.getByRole("application", { name: "CAD标号画布" })).toBeFocused();
  }
  await panel.screenshot({ path: "test-results/cad-detail-tool-style.png" });
  await line.click();
  await page.mouse.move(0, 0);
  await expect(line).toHaveAttribute("aria-pressed", "true");
  const active = await appearance(line);
  await detail.click();
  await page.mouse.move(0, 0);
  await expect(detail).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => appearance(detail)).toEqual(active);
  await workspace.getByRole("application", { name: "CAD标号画布" }).press("Escape");
  // Only in this isolated test: compare the shared disabled appearance as well.
  await detail.evaluate(element => { (element as HTMLButtonElement).disabled = true; });
  await line.evaluate(element => { (element as HTMLButtonElement).disabled = true; });
  const disabled = await appearance(line);
  await expect.poll(() => appearance(detail)).toEqual(disabled);
});
