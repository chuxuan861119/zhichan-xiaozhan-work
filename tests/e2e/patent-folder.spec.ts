import { expect, test, dismissWorkbenchWelcome } from "./helpers/workbench.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDrawingEntry } from "./helpers/drawing-entry.js";

test("patent folder provides selection, responsive layout, and direct book navigation", async ({
  workbench,
}, testInfo) => {
  const application = await workbench.launchAllowMultipleInstances("--headless");
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("文件夹回归专利");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const backup = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await backup.isVisible()) await backup.click();
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    const card = page.getByRole("article", { name: "文件夹回归专利", exact: true });
    await card.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "打开文件夹" }).click();
    const folder = page.getByRole("dialog", { name: "文件夹回归专利", exact: true });
    await expect(folder).toBeVisible();
    expect(
      await folder
        .locator(".standard-dialog__header")
        .evaluate((e) => e.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(46);
    await expect(folder.getByText(/拖动框选/u)).toHaveCount(0);
    await expect(folder.getByRole("option")).toHaveCount(5);
    const rows = await folder.getByRole("option").evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    expect(rows[1]!.y).toBeGreaterThan(rows[0]!.y);
    expect(rows.every((r) => r.x === rows[0]!.x && r.height <= 52)).toBe(true);
    await folder.getByRole("button", { name: "关闭", exact: true }).focus();
    await page.keyboard.press("Control+a");
    await expect(folder.locator('[role="option"][aria-selected="true"]')).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(folder).toBeVisible();
    const list = folder.getByRole("listbox", { name: "专利文件" });
    const listBounds = await list.boundingBox();
    if (!listBounds) throw new Error("文件列表不可见。");
    await page.mouse.move(listBounds.x + 2, rows[0]!.y - 2);
    await page.mouse.down();
    await page.mouse.move(listBounds.x + 180, rows[1]!.y + rows[1]!.height - 2, { steps: 8 });
    await expect(folder.getByTestId("folder-selection-rectangle")).toBeVisible();
    await page.mouse.up();
    await expect(folder.getByTestId("folder-selection-rectangle")).toHaveCount(0);
    await expect(folder.locator('[role="option"][aria-selected="true"]')).toHaveCount(2);
    await folder.getByRole("option", { name: /权利要求书/u }).click();
    await expect(folder.getByLabel("导出格式")).toHaveValue("docx");
    await folder.getByRole("option", { name: /说明书摘要/u }).click({ modifiers: ["Control"] });
    await expect(folder.locator('[role="option"][aria-selected="true"]')).toHaveCount(2);
    await folder.getByRole("checkbox", { name: "全选文件" }).check();
    await expect(folder.locator('[role="option"][aria-selected="true"]')).toHaveCount(5);
    const outputPath = join(workbench.root, "folder-batch.zip");
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, outputPath);
    await folder.getByRole("button", { name: "导出所选" }).click();
    await expect(page.getByText("所选文件已成功导出", { exact: true })).toBeVisible();
    await expect(folder.getByRole("status")).toContainText("已成功导出 5 个文件");
    const zip = await readFile(outputPath);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    for (const name of ["权利要求书", "说明书", "说明书附图", "说明书摘要", "摘要附图"])
      expect(zip.includes(Buffer.from(`${name}.docx`))).toBe(true);
    const pdfPath = join(workbench.root, "claims.pdf");
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, pdfPath);
    await folder.getByRole("button", { name: "导出权利要求书", exact: true }).click();
    const formatDialog = page.getByRole("dialog", { name: "导出文件", exact: true });
    await expect(formatDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(formatDialog).toBeVisible();
    await formatDialog.getByLabel("文件格式").selectOption("pdf");
    await formatDialog.getByRole("button", { name: "导出", exact: true }).click();
    await expect
      .poll(async () =>
        (await readFile(pdfPath).catch(() => Buffer.alloc(0))).subarray(0, 5).toString(),
      )
      .toBe("%PDF-");
    await expect(folder.getByRole("button", { name: "导出所选" })).toBeEnabled();
    await expect(folder.getByRole("status")).toContainText("文件已成功导出");
    await expect(folder.locator('[role="option"][aria-selected="true"]')).toHaveCount(5);
    await folder.screenshot({ path: testInfo.outputPath("patent-folder-wide.png") });
    await page.setViewportSize({ width: 600, height: 760 });
    await expect(folder).toBeVisible();
    expect(await folder.evaluate((e) => e.getBoundingClientRect().right <= window.innerWidth)).toBe(
      true,
    );
    await folder.screenshot({ path: testInfo.outputPath("patent-folder-narrow.png") });
    await folder.getByRole("option", { name: /说明书摘要/u }).dblclick();
    await expect(folder).toBeHidden();
    await expect(page.getByRole("tab", { name: "说明书摘要", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    await application.close();
  }
});

test("folder exports current editable CAD as DXF, DWG and mixed ZIP and opens its workspace", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances("--headless");
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("CAD文件夹回归");
    await create.getByRole("radio", { name: "实用新型", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
    const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
    const line = panel.getByRole("button", { name: "直线", exact: true });
    await expect(line).toBeEnabled({ timeout: 60_000 });
    await line.click();
    const canvas = workspace.getByRole("application", { name: "CAD标号画布", exact: true });
    await canvas.click({ position: { x: 150, y: 200 } });
    await canvas.click({ position: { x: 320, y: 220 } });
    await canvas.press("Enter");
    await expect(workspace).toHaveAttribute("data-cad-pending", "false");
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await page
      .getByRole("article", { name: "CAD文件夹回归", exact: true })
      .getByRole("button", { name: "更多操作" })
      .click();
    await page.getByRole("menuitem", { name: "打开文件夹" }).click();
    const folder = page.getByRole("dialog", { name: "CAD文件夹回归", exact: true });
    const drawing = folder.getByRole("option", { name: /新图纸/u });
    await expect(drawing).toBeVisible();
    for (const format of ["dxf", "dwg"] as const) {
      await drawing.click();
      await folder.getByLabel("导出格式").selectOption(format);
      const path = join(workbench.root, `current.${format}`);
      await app.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      }, path);
      await folder.getByRole("button", { name: "导出所选" }).click();
      await expect
        .poll(async () => (await readFile(path).catch(() => Buffer.alloc(0))).length)
        .toBeGreaterThan(100);
      const bytes = await readFile(path);
      if (format === "dwg") expect(bytes.subarray(0, 4).toString()).toBe("AC10");
      else expect(bytes.toString()).toContain("LINE");
      await expect(folder.getByRole("button", { name: "导出所选" })).toBeEnabled();
    }
    await folder.getByRole("option", { name: /权利要求书/u }).click({ modifiers: ["Control"] });
    const zipPath = join(workbench.root, "mixed.zip");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, zipPath);
    await folder.getByRole("button", { name: "导出所选" }).click();
    await expect
      .poll(async () => (await readFile(zipPath).catch(() => Buffer.alloc(0))).length)
      .toBeGreaterThan(100);
    const zip = await readFile(zipPath);
    expect(zip.includes(Buffer.from("新图纸.dwg"))).toBe(true);
    expect(zip.includes(Buffer.from("权利要求书.docx"))).toBe(true);
    await expect(folder.getByRole("button", { name: "导出所选" })).toBeEnabled();
    await drawing.dblclick();
    await expect(folder).toBeHidden();
    await expect(workspace).toBeVisible();
  } finally {
    await app.close();
  }
});

test("folder exports editable flowchart source and opens the same project", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const app = await workbench.launchAllowMultipleInstances("--headless");
  try {
    const page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("流程文件夹回归");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    await openDrawingEntry(page, "插入流程图");
    await expect
      .poll(() => page.frames().some((frame) => frame.url().endsWith("/embed.html")))
      .toBe(true);
    const frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
    if (!frame) throw new Error("流程图未加载。");
    await frame.getByRole("button", { name: "基础流程", exact: true }).click();
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await page
      .getByRole("article", { name: "流程文件夹回归", exact: true })
      .getByRole("button", { name: "更多操作" })
      .click();
    await page.getByRole("menuitem", { name: "打开文件夹" }).click();
    const folder = page.getByRole("dialog", { name: "流程文件夹回归", exact: true });
    const source = folder.getByRole("option", { name: /流程图工作稿/u });
    await source.click();
    const path = join(workbench.root, "flowchart.drawio");
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, path);
    await folder.getByRole("button", { name: "导出所选" }).click();
    await expect
      .poll(async () => (await readFile(path).catch(() => Buffer.alloc(0))).length)
      .toBeGreaterThan(100);
    expect((await readFile(path)).toString()).toContain("mxfile");
    await expect(folder.getByRole("button", { name: "导出所选" })).toBeEnabled();
    await source.dblclick();
    await expect(folder).toBeHidden();
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
