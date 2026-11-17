import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("continuous line undo can immediately redo, including repeated history clicks", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("CAD历史测试");
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
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  const count = () =>
    panel.evaluate((el) => {
      let f = (el as any)[Object.keys(el).find((k) => k.startsWith("__reactFiber"))!];
      for (; f; f = f.return) {
        for (let h = f.memoizedState; h; h = h.next) {
          const x = h.memoizedState?.current;
          if (Array.isArray(x?.entities) && Array.isArray(x?.primitives)) return x.entities.length;
        }
      }
      return -1;
    });
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  for (const [x, y] of [
    [150, 150],
    [280, 190],
    [360, 310],
  ])
    await canvas.click({ position: { x: x!, y: y! } });
  await expect.poll(count).toBe(2);
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  const undo = workspace.getByRole("button", { name: "撤销标号编辑", exact: true }),
    redo = workspace.getByRole("button", { name: "重做标号编辑", exact: true });
  await undo.click();
  await expect.poll(count).toBe(1);
  await expect(redo).toBeEnabled();
  await canvas.press("Control+y");
  await expect.poll(count).toBe(2);
  await undo.click();
  await expect.poll(count).toBe(1);
  await undo.click();
  await expect.poll(count).toBe(0);
  await redo.click();
  await expect.poll(count).toBe(1);
  await redo.click();
  await expect.poll(count).toBe(2);
  await undo.evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(count).toBe(0);
  await redo.evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(count).toBe(2);
  await undo.click();
  await expect.poll(count).toBe(1);
  await canvas.click({ position: { x: 400, y: 390 } });
  await expect.poll(count).toBe(2);
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  await expect(redo).toBeDisabled();
  const sources = workspace.locator(".drawing-project-name");
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(sources).toHaveCount(2);
  await sources.first().click();
  await expect(sources.first()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(count).toBe(2);
  await undo.evaluate((el) => (el as HTMLButtonElement).click());
  await sources.nth(1).click();
  await expect(sources.nth(1)).toHaveAttribute("aria-pressed", "true");
  await sources.first().click();
  await expect(sources.first()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(count).toBe(1);
  await redo.click();
  await expect.poll(count).toBe(2);
  await undo.evaluate((el) => (el as HTMLButtonElement).click());
  await page.getByRole("button", { name: "关闭CAD历史测试", exact: true }).click();
  await expect(page.getByRole("tab", { name: "CAD历史测试", exact: true })).toHaveCount(0);
  await page.getByText("CAD历史测试", { exact: true }).first().dblclick();
  const reopenLater = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await reopenLater.isVisible()) await reopenLater.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await expect.poll(count).toBe(1);
});
