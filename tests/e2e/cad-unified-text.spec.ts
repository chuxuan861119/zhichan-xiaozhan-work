import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD in-place multiline text, width placement, editing and persisted grips", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  let page = await app.firstWindow();
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
  await workspace
    .getByRole("button", { name: "新建图纸", exact: true })
    .click();
  const opener = page
    .getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ })
    .first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(
    panel.getByRole("button", { name: "文字", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await panel.getByRole("button", { name: "文字", exact: true }).click();
  await canvas.click({ position: { x: 220, y: 220 } });
  const editor = page.getByRole("textbox", { name: "画布文字" });
  await expect(editor).toHaveAttribute("contenteditable", "plaintext-only");
  await editor.fill("中文文字测试");
  await editor.press("Enter");
  await page.keyboard.insertText("第二行");
  await expect(editor).toBeVisible();
  await page.screenshot({ path: "test-results/cad-text-edit.png" });
  await editor.press("ControlOrMeta+Enter");
  await expect(editor).toBeHidden();
  await expect(canvas.locator("[data-cad-pending-text]")).toHaveCount(0, {
    timeout: 60000,
  });
  await expect(
    workspace.getByRole("button", { name: "撤销标号编辑", exact: true }),
  ).toBeEnabled();
  await canvas.click({ position: { x: 225, y: 225 } });
  await expect(canvas.locator(".cad-selection-overlay circle")).toHaveCount(3);
  const widthGrip = canvas.locator(".cad-selection-overlay circle").nth(1);
  const gripBox = (await widthGrip.boundingBox())!;
  await page.mouse.move(
    gripBox.x + gripBox.width / 2,
    gripBox.y + gripBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    gripBox.x + gripBox.width / 2 + 80,
    gripBox.y + gripBox.height / 2,
    { steps: 10 },
  );
  await expect(canvas.locator(".cad-grip-shape foreignObject")).toBeVisible();
  await page.mouse.up();
  await expect(canvas.locator(".cad-grip-shape")).toHaveCount(0, {
    timeout: 60000,
  });
  await canvas.dblclick({ position: { x: 225, y: 225 } });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("中文文字测试\n第二行");
  await editor.fill("修改内容");
  await canvas.click({ position: { x: 600, y: 400 }, button: "right" });
  await expect(editor).toBeHidden();
  await expect(canvas.locator("[data-cad-pending-text]")).toHaveCount(0, {
    timeout: 60000,
  });
  await canvas.dblclick({ position: { x: 225, y: 225 } });
  await expect(editor).toHaveText("修改内容");
  await editor.press("Escape");
  await panel.getByRole("button", { name: "文字", exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 450, bounds.y + 300);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 650, bounds.y + 350, { steps: 10 });
  await page.mouse.up();
  await expect(editor).toBeVisible();
  const width = await editor.evaluate((e) => e.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(190);
  expect(width).toBeLessThan(210);
  await editor.fill(
    "连续中文自动换行测试文字连续中文自动换行测试文字连续中文自动换行测试文字",
  );
  await page.screenshot({ path: "test-results/cad-text-wrapped.png" });
  await editor.press("ControlOrMeta+Enter");
  await expect(canvas.locator("[data-cad-pending-text]")).toHaveCount(0, {
    timeout: 60000,
  });
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/cad-text-completed.png" });
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
  const savedText = () =>
    page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok || !list.value[0]) throw new Error("Test patent missing");
      const opened = await window.patentApi.patents.open(
        list.value[0].patentId,
      );
      if (!opened.ok) throw new Error(opened.error.message);
      const cad = opened.value.patent.drawingProjects[0]?.cad;
      if (!cad) throw new Error("CAD checkpoint missing");
      const source = await window.patentApi.assets.readDrawingSource(
        opened.value.sessionId,
        cad.assetId,
      );
      if (!source.ok) throw new Error(source.error.message);
      return new TextDecoder()
        .decode(source.value)
        .replace(/\\U\+([0-9a-f]{4})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
    });
  expect(await savedText()).toContain("修改内容");
  await app.close();
  const reopened = await workbench.launch();
  page = await reopened.firstWindow();
  await dismissWorkbenchWelcome(page);
  expect(await savedText()).toContain("修改内容");
});
