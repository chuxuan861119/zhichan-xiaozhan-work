import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

async function createPatent(page: Page, name: string): Promise<void> {
  const library = page.getByRole("tab", { name: "专利库" });
  if (await library.isVisible()) await library.click();
  await page.getByRole("button", { name: "新建专利" }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "发明" }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function mockDocxSaveDialog(
  application: ElectronApplication,
  outputPath: string,
): Promise<void> {
  await application.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, "showSaveDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePath: path }),
    });
  }, outputPath);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function closeOptionalDocxReport(page: Page): Promise<void> {
  const report = page.getByRole("dialog", { name: "DOCX 导出报告" });
  const success = page.getByRole("dialog", { name: "DOCX 导出成功" });
  const backdrops = page.locator(".dialog-backdrop");
  await expect
    .poll(async () => {
      if (await report.isVisible()) return "report";
      if (await success.isVisible()) return "success";
      const visibleBackdropText = await backdrops.evaluateAll((elements) =>
        elements
          .filter((element) => {
            const styles = getComputedStyle(element);
            return styles.display !== "none" && styles.visibility !== "hidden";
          })
          .map((element) => element.textContent?.replace(/\s+/gu, " ").trim() ?? "")
          .join(" | "),
      );
      return visibleBackdropText ? `waiting: ${visibleBackdropText}` : "clear";
    })
    .not.toMatch(/^waiting:/u);
  if (await report.isVisible()) await report.getByRole("button", { name: "关闭" }).click();
  if (await success.isVisible()) await success.getByRole("button", { name: "确认" }).click();
  await expect(backdrops).toHaveCount(0);
}

async function columnWidthsMm(table: ReturnType<Page["locator"]>): Promise<number[]> {
  const value = await table.getAttribute("data-column-widths-mm");
  if (!value) throw new Error("表格未提供列宽元数据");
  return value.split(",").map(Number);
}

async function selectWholeTable(editor: ReturnType<Page["locator"]>): Promise<void> {
  await editor.getByRole("button", { name: "选择整张表格" }).dispatchEvent("mousedown", {
    button: 0,
  });
}

async function expandTableTools(page: Page): Promise<void> {
  const rail = page.getByRole("region", { name: "表格功能" });
  for (const name of ["尺寸", "自动调整宽度", "单元格", "边框"]) {
    const toggle = rail.getByRole("button", { name, exact: true });
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
}

test("页面适配表格拖列宽不跳变且可取消和撤销", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "列宽拖动回归");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 2 行 2 列表格" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const table = editor.locator("table");
    await table.scrollIntoViewIfNeeded();
    const first = table.locator("td").first();
    const sizes = () =>
      table
        .locator("tr")
        .first()
        .locator("td")
        .evaluateAll((cells): [number, number] => {
          if (!cells[0] || !cells[1]) throw new Error("Missing two columns");
          return [cells[0].getBoundingClientRect().width, cells[1].getBoundingClientRect().width];
        });
    const original = await sizes();
    const bounds = await first.boundingBox();
    if (!bounds) throw new Error("Missing cell bounds");
    const x = bounds.x + bounds.width - 1;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await expect(editor).toHaveClass(/resize-cursor/u);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 5 });
    await page.mouse.up();
    await expect(table).toHaveAttribute("data-layout-mode", "fixed");
    const resized = await sizes();
    expect(resized[0] - original[0]).toBeCloseTo(30, -1);
    expect(resized[1] - original[1]).toBeCloseTo(-30, -1);
    expect(Math.abs(resized[0] + resized[1] - original[0] - original[1])).toBeLessThan(2);
    await page.keyboard.press("Control+z");
    await expect(table).toHaveAttribute("data-layout-mode", "fit-page");
    const restored = await sizes();
    expect(Math.abs(restored[0] - original[0])).toBeLessThan(2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(table).toHaveAttribute("data-layout-mode", "fit-page");
    expect(Math.abs((await sizes())[0] - original[0])).toBeLessThan(2);
  } finally {
    await application.close();
  }
});

test("整表来源排版、行距留白及自动行高可调整并保存重开", async ({ workbench }, testInfo) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    const name = "整表排版回归";
    await createPatent(page, name);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/html",
        '<table style="width:130mm"><colgroup><col style="width:40mm"><col style="width:90mm"></colgroup><tr style="height:18mm"><td style="padding:1mm 3mm"><p class="MsoNormal" style="line-height:1.15;margin-bottom:6pt">来源第一格</p><p>第二段</p></td><td>另一格</td></tr></table>',
      );
      clipboardData.setData("text/plain", "来源第一格\t另一格");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const table = editor.locator("table");
    await expect(table).toHaveCount(1);
    await expect(table).not.toContainText(name);
    await expect(table.locator("td").first()).toHaveAttribute("data-padding-right-mm", "3");
    await expect(table.locator("p").first()).toHaveAttribute("data-line-height", "1.15");
    expect((await columnWidthsMm(table))[0]).toBeCloseTo(40, 0);
    const metrics = await table.evaluate((el) => ({
      table: el.getBoundingClientRect().width,
      cells: [...el.querySelectorAll("td")].map((cell) => cell.getBoundingClientRect().width),
    }));
    expect(metrics.cells[1]! / metrics.cells[0]!).toBeCloseTo(90 / 40, 1);
    await table.locator("td").first().click();
    await selectWholeTable(editor);
    const rail = page.getByRole("region", { name: "表格功能" });
    await rail.getByRole("combobox", { name: "表格行距", exact: true }).selectOption("1.5");
    await page.screenshot({ path: testInfo.outputPath("table-formatting-controls.png") });
    await expect(table.locator("p[data-line-height='1.5']")).toHaveCount(3);
    await rail.getByRole("spinbutton", { name: "单元格上下留白" }).fill("0.5");
    await rail.getByRole("button", { name: "应用留白" }).click();
    await expect(table.locator("td[data-padding-top-mm='0.5']")).toHaveCount(2);
    await expect(editor).toBeFocused();
    await page.keyboard.press("Control+z");
    await expect(table.locator("td").first()).toHaveAttribute("data-padding-top-mm", "1");
    await rail.getByRole("button", { name: "紧凑排版" }).click();
    await expect(table.locator("p[data-line-height='1']")).toHaveCount(3);
    await expect(table.locator("tr")).toHaveAttribute("data-row-height-mm", "18");
    await expandTableTools(page);
    await rail.getByRole("button", { name: "自动行高", exact: true }).click();
    await expect(table.locator("tr")).not.toHaveAttribute("data-row-height-mm");
    await page.screenshot({
      path: testInfo.outputPath("table-formatting.png"),
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${name}` }).click();
    await page.getByRole("article", { name }).getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(table.locator("td").first()).toHaveAttribute("data-padding-right-mm", "2");
    await expect(table.locator("p").first()).toHaveAttribute("data-line-height", "1");
  } finally {
    await application.close();
  }
});

test("固定列宽保持页面实际尺寸且标题行合并后可拆分", async ({ workbench }) => {
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "标题行合并拆分回归");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    const insertion = page.getByRole("region", { name: "插入表格设置" });
    await insertion.getByRole("spinbutton", { name: "行数" }).fill("2");
    await insertion.getByRole("spinbutton", { name: "列数" }).fill("3");
    await insertion.getByRole("checkbox", { name: "将首行设为标题行" }).check();
    await insertion.getByRole("button", { name: "插入自定义表格" }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.locator("th").first().click();
    await editor.getByRole("button", { name: "选择本行" }).first().click();
    await expandTableTools(page);
    const rail = page.getByRole("region", { name: "表格功能" });
    const table = editor.locator("table");
    const widthBefore = await table.evaluate((element) => element.getBoundingClientRect().width);
    await rail.getByRole("button", { name: "固定列宽", exact: true }).click();
    await expect(table).toHaveAttribute("data-layout-mode", "fixed");
    const widthAfter = await table.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(2);
    await rail.getByRole("button", { name: "合并单元格" }).click();
    await expect(editor.locator("th")).toHaveCount(1);
    await rail.getByRole("button", { name: "还原合并" }).click();
    await expect(editor.locator("th")).toHaveCount(3);
  } finally {
    await app.close();
  }
});

test("表格内粘贴后可合并并拖动逻辑行且取消恢复行高", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "表格粘贴与跨行拖动回归");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 1 行 1 列表格" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.locator("td").click();
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/html",
        "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
      );
      clipboardData.setData("text/plain", "甲\t乙\n丙\t丁");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor.locator("table")).toHaveCount(1);
    await expect(editor.locator("td")).toHaveCount(4);
    await expect(editor.locator("table")).toContainText("丁");
    await editor.getByRole("button", { name: "选择本列" }).nth(1).click();
    await expandTableTools(page);
    await page
      .getByRole("region", { name: "表格功能" })
      .getByRole("button", { name: "合并单元格" })
      .click();
    await expect(editor.locator("td[rowspan='2']")).toHaveCount(1);
    // Exit the multi-row selection so dragging a boundary targets only that logical row.
    await editor.locator("td").first().click();
    const handle = editor.getByRole("button", { name: "调整第 2 行行高" }).first();
    await handle.hover();
    const bounds = await handle.boundingBox();
    if (!bounds) throw new Error("Missing resize handle bounds");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 35, {
      steps: 5,
    });
    await page.mouse.up();
    const rows = editor.locator("tr");
    await expect(rows.nth(1)).toHaveAttribute("data-row-height-mm", /\d/u);
    await expect(rows.first()).not.toHaveAttribute("data-row-height-mm");
    const savedHeight = await rows.nth(1).getAttribute("data-row-height-mm");
    const nextBounds = await handle.boundingBox();
    if (!nextBounds) throw new Error("Missing updated resize handle bounds");
    await page.mouse.move(
      nextBounds.x + nextBounds.width / 2,
      nextBounds.y + nextBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      nextBounds.x + nextBounds.width / 2,
      nextBounds.y + nextBounds.height / 2 + 20,
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(rows.nth(1)).toHaveAttribute("data-row-height-mm", savedHeight ?? "");
    expect(
      await rows
        .nth(1)
        .evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue("--patent-row-height"),
        ),
    ).toBe(`${savedHeight}mm`);
  } finally {
    await application.close();
  }
});

test("指定行列拆分与平均行高可撤销并保存重开", async ({ workbench }) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    const name = "表格拆分和平均行高";
    await createPatent(page, name);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 2 行 2 列表格" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const table = editor.locator("table");
    const width = await table.evaluate((el) => el.getBoundingClientRect().width);
    await table.locator("td").first().click();
    await page.keyboard.insertText("保留原内容");
    await expandTableTools(page);
    const rail = page.getByRole("region", { name: "表格功能" });
    await rail.getByRole("button", { name: "拆分单元格", exact: true }).click();
    await rail.getByRole("spinbutton", { name: "拆分行数" }).fill("2");
    await rail.getByRole("spinbutton", { name: "拆分列数" }).fill("30");
    await rail.getByRole("button", { name: "应用拆分" }).click();
    await expect(rail.getByRole("alert")).toContainText("空间不足");
    await expect(table.locator("td")).toHaveCount(4);
    await rail.getByRole("spinbutton", { name: "拆分列数" }).fill("2");
    await rail.getByRole("button", { name: "应用拆分" }).click();
    await expect(table.locator("td")).toHaveCount(7);
    await expect(table.locator("td").first()).toContainText("保留原内容");
    expect(
      Math.abs((await table.evaluate((el) => el.getBoundingClientRect().width)) - width),
    ).toBeLessThan(2);
    await page.keyboard.press("Control+z");
    await expect(table.locator("td")).toHaveCount(4);
    await expect(table).toContainText("保留原内容");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(table.locator("td")).toHaveCount(7);
    await selectWholeTable(editor);
    await rail.getByRole("button", { name: "平均分布行高" }).click();
    await expect(table.locator("tr[data-row-height-rule='at-least']")).toHaveCount(3);
    const heights = await table
      .locator("tr")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${name}` }).click();
    await page.getByRole("article", { name }).getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(table.locator("td")).toHaveCount(7);
    await expect(table).toContainText("保留原内容");
    await expect(table.locator("tr[data-row-height-rule='at-least']")).toHaveCount(3);
  } finally {
    await application.close();
  }
});

test("各列横边可拖动且缩小行高不产生单元格滚动", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "行高内容保护回归");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 1 行 3 列表格" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const row = editor.locator("tr");
    const cells = row.locator("td");
    await cells.first().click();
    await page.keyboard.insertText("多行内容应当保持完整显示。".repeat(8));
    const text = await row.innerText();
    for (let column = 0; column < 3; column += 1) {
      const handle = cells.nth(column).getByRole("button", { name: "调整第 1 行行高" });
      const bounds = await handle.boundingBox();
      if (!bounds) throw new Error("Missing row edge");
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 20);
      await expect(row).toHaveAttribute("data-table-row-resize-preview", "true");
      await page.mouse.up();
      await expect(row).toHaveAttribute("data-row-height-rule", "at-least");
    }
    const handle = cells.first().getByRole("button", { name: "调整第 1 行行高" });
    const bounds = await handle.boundingBox();
    if (!bounds) throw new Error("Missing shrink edge");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 400);
    await page.mouse.up();
    const content = cells.first().locator(".patent-table-cell-content");
    expect(await content.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await row.innerText()).toBe(text);
    await cells.first().click();
    await expandTableTools(page);
    const rail = page.getByRole("region", { name: "表格功能" });
    await rail.getByRole("spinbutton", { name: "行高（毫米）" }).fill("8");
    await rail.getByRole("combobox", { name: "行高规则" }).selectOption("exact");
    await rail.getByRole("button", { name: "应用行高" }).click();
    await expect(cells.first()).toHaveAttribute("data-content-overflow", "true");
    expect(
      await content.evaluate((el) => {
        el.scrollTop = 100;
        return el.scrollTop;
      }),
    ).toBe(0);
    expect(await row.innerText()).toBe(text);
  } finally {
    await application.close();
  }
});

test("根据内容会让只有单个数字的三列表格明显收窄", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "表格根据内容收窄验收夹具");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });

    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 3 行 3 列表格" })
      .click();

    const table = editor.locator("table");
    const cells = table.locator("td");
    await expect(cells).toHaveCount(9);
    for (let index = 0; index < 9; index += 1) {
      await cells.nth(index).click();
      await page.keyboard.type("1");
    }
    const widthBefore = await table.evaluate((element) => element.getBoundingClientRect().width);
    await cells.first().click();
    await selectWholeTable(editor);
    await expandTableTools(page);
    await page
      .getByRole("region", { name: "表格功能" })
      .getByRole("button", { name: "根据内容" })
      .click();

    await expect(table).toHaveAttribute("data-layout-mode", "fixed");
    const widthAfter = await table.evaluate((element) => element.getBoundingClientRect().width);
    expect(widthAfter).toBeLessThan(widthBefore / 2);
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("根据内容会忽略空单元格并按已有内容收窄", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "表格空单元格收窄验收夹具");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });

    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 3 行 3 列表格" })
      .click();

    const table = editor.locator("table");
    const cells = table.locator("td");
    await expect(cells).toHaveCount(9);
    for (const index of [0, 1, 2]) {
      await cells.nth(index).click();
      await page.keyboard.type("1");
    }
    const widthBefore = await table.evaluate((element) => element.getBoundingClientRect().width);
    await cells.first().click();
    await selectWholeTable(editor);
    await expandTableTools(page);
    await page
      .getByRole("region", { name: "表格功能" })
      .getByRole("button", { name: "根据内容" })
      .click();

    await expect(table).toHaveAttribute("data-layout-mode", "fixed");
    const widthAfter = await table.evaluate((element) => element.getBoundingClientRect().width);
    expect(widthAfter).toBeLessThan(widthBefore / 2);
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("表格保存后关闭重开仍保留结构和格式且不改变页面宽度", async ({ workbench }) => {
  test.setTimeout(180_000);
  const patentName = "表格保存重开验收夹具";
  const docxPath = join(workbench.root, "表格保存重开验收.docx");
  const application = await workbench.launch();
  try {
    await mockDocxSaveDialog(application, docxPath);
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, patentName);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const pageBody = page.locator('[data-book-kind="description"].patent-book-rich-text');
    const widthBefore = await pageBody.evaluate((element) => element.getBoundingClientRect().width);

    await page.getByRole("button", { name: "插入表格" }).click();
    let insertion = page.getByRole("region", { name: "插入表格设置" });
    await insertion.getByRole("button", { name: "插入 3 行 3 列表格" }).click();
    let table = editor.locator("table");
    await expect(table.locator("tr")).toHaveCount(3);
    await table.locator("td").first().click();
    await selectWholeTable(editor);
    let rail = page.getByRole("region", { name: "表格功能" });
    await expandTableTools(page);
    await expect(rail).toContainText("已选择整张表格，共 3 行 3 列");
    await rail.getByRole("button", { name: "删除表格" }).click();
    await expect(table).toHaveCount(0);

    await page.getByRole("button", { name: "插入表格" }).click();
    insertion = page.getByRole("region", { name: "插入表格设置" });
    await insertion.getByRole("spinbutton", { name: "行数" }).fill("2");
    await insertion.getByRole("spinbutton", { name: "列数" }).fill("3");
    await insertion.getByRole("checkbox", { name: "将首行设为标题行" }).check();
    await insertion.getByRole("button", { name: "插入自定义表格" }).click();

    table = editor.locator("table");
    await expect(table.locator("tr")).toHaveCount(2);
    await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
    const firstCell = table.locator("tr").first().locator("th").first();
    await firstCell.click();
    await page.keyboard.type("标题单元格");
    const firstCellWidthBeforeResize = await firstCell.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    const firstCellBox = await firstCell.boundingBox();
    expect(firstCellBox).not.toBeNull();
    if (!firstCellBox) throw new Error("无法读取首个单元格位置");
    await page.mouse.move(
      firstCellBox.x + firstCellBox.width - 1,
      firstCellBox.y + firstCellBox.height / 2,
    );
    const resizeHandle = editor.locator(".column-resize-handle").first();
    await expect(resizeHandle).toBeVisible();
    const resizeHandleBox = await resizeHandle.boundingBox();
    expect(resizeHandleBox).not.toBeNull();
    if (!resizeHandleBox) throw new Error("无法读取列宽拖动柄位置");
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(resizeHandleBox.x + 24, resizeHandleBox.y + resizeHandleBox.height / 2);
    await page.mouse.up();
    await expect
      .poll(() => firstCell.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(firstCellWidthBeforeResize);

    rail = page.getByRole("region", { name: "表格功能" });
    await expandTableTools(page);
    await expect(rail).toBeVisible();
    const widthWithRail = await pageBody.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(Math.abs(widthWithRail - widthBefore)).toBeLessThanOrEqual(1);
    await expect(page.locator(".table-tools")).toHaveCount(0);

    await rail.getByRole("button", { name: "居中", exact: true }).click();
    await rail.getByRole("button", { name: "垂直居中" }).click();
    await expect(firstCell).toHaveAttribute("data-horizontal-alignment", "center");
    await expect(firstCell).toHaveAttribute("data-vertical-alignment", "middle");

    await editor.getByRole("button", { name: "选择单元格" }).first().click();
    await expect(rail).toContainText("当前单元格");
    await editor.getByRole("button", { name: "选择本行" }).first().click();
    await expect(rail).toContainText("已选择 1 行，共 3 列");
    await rail.getByRole("button", { name: "合并单元格" }).click();
    await rail.getByRole("button", { name: "还原合并" }).click();
    await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
    await editor.getByRole("button", { name: "选择本列" }).first().click();
    await expect(rail).toContainText("已选择 1 列，共 2 行");
    await selectWholeTable(editor);
    await expect(rail).toContainText("已选择整张表格，共 2 行 3 列");
    await rail.getByRole("button", { name: "平均分布列宽" }).click();
    await rail.getByRole("button", { name: "根据页面" }).click();

    await firstCell.dblclick();
    await expect
      .poll(() => page.evaluate<string>("window.getSelection()?.toString() ?? ''"))
      .not.toBe("");
    const selectedText = await page.evaluate<string>("window.getSelection()?.toString() ?? ''");
    expect("标题单元格").toContain(selectedText);

    await editor.locator(":scope > p").last().click();
    await expect(rail).toBeHidden();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();

    const reopenedEditor = page.getByRole("textbox", { name: "编辑 说明书" });
    const reopenedTable = reopenedEditor.locator("table");
    await expect(reopenedTable.locator("tr")).toHaveCount(2);
    await expect(reopenedTable.locator("tr").first().locator("th")).toHaveCount(3);
    await expect(reopenedTable).toContainText("标题单元格");
    await expect(reopenedTable.locator("tr").first().locator("th").first()).toHaveAttribute(
      "data-horizontal-alignment",
      "center",
    );

    await page.getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);
    await closeOptionalDocxReport(page);

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "打印中心" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("表格尺寸保存后关闭重开", async ({ workbench }) => {
  test.setTimeout(180_000);
  const patentName = "表格尺寸持久化验收夹具";
  const docxPath = join(workbench.root, "表格尺寸持久化验收.docx");
  const application = await workbench.launch();
  try {
    await mockDocxSaveDialog(application, docxPath);
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, patentName);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();

    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const documentPage = page.locator('[data-book-kind="description"].patent-book-rich-text');
    const widthBefore = await documentPage.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await page.getByRole("button", { name: "插入表格" }).click();
    await page
      .getByRole("region", { name: "插入表格设置" })
      .getByRole("button", { name: "插入 2 行 2 列表格" })
      .click();

    const table = editor.locator("table");
    await expect(table.locator("tr")).toHaveCount(2);
    await table.locator("td").first().click();
    await selectWholeTable(editor);
    const rail = page.getByRole("region", { name: "表格功能" });
    await expandTableTools(page);

    await rail.getByRole("spinbutton", { name: "行高（毫米）" }).fill("18");
    await rail.getByRole("combobox", { name: "行高规则" }).selectOption("exact");
    await rail.getByRole("button", { name: "应用行高" }).click();
    for (const row of [table.locator("tr").first(), table.locator("tr").last()]) {
      await expect(row).toHaveAttribute("data-row-height-mm", "18");
      await expect(row).toHaveAttribute("data-row-height-rule", "exact");
    }

    await table.locator("td").first().click();
    await selectWholeTable(editor);
    await expect(rail).toContainText("已选择整张表格，共 2 行 2 列");
    await rail.getByRole("spinbutton", { name: "列宽（毫米）" }).fill("42");
    await expect(rail.getByRole("spinbutton", { name: "列宽（毫米）" })).toHaveValue("42");
    await rail.getByRole("button", { name: "应用列宽" }).click();
    const widthsAfterNumericSet = await columnWidthsMm(table);
    expect(widthsAfterNumericSet).toHaveLength(2);
    for (const width of widthsAfterNumericSet)
      expect(Math.abs(width - 42.069)).toBeLessThanOrEqual(0.1);

    await table.locator("td").first().click();
    const rowHandle = editor.getByRole("button", { name: "调整第 1 行行高" }).first();
    await expect(rowHandle).toBeVisible();
    await rowHandle.hover();
    const rowHandleBox = await rowHandle.boundingBox();
    expect(rowHandleBox).not.toBeNull();
    if (!rowHandleBox) throw new Error("无法读取行高拖动柄位置");
    await page.mouse.move(
      rowHandleBox.x + rowHandleBox.width / 2,
      rowHandleBox.y + rowHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + 16);
    await page.mouse.up();
    await expect(table.locator("tr").first()).not.toHaveAttribute("data-row-height-mm", "18");

    await table.locator("td").first().click();
    const firstCellBox = await table.locator("td").first().boundingBox();
    expect(firstCellBox).not.toBeNull();
    if (!firstCellBox) throw new Error("无法读取首个单元格位置");
    await page.mouse.move(
      firstCellBox.x + firstCellBox.width - 1,
      firstCellBox.y + firstCellBox.height / 2,
    );
    const columnHandle = editor.locator(".column-resize-handle").first();
    await expect(columnHandle).toBeVisible();
    const columnHandleBox = await columnHandle.boundingBox();
    expect(columnHandleBox).not.toBeNull();
    if (!columnHandleBox) throw new Error("无法读取列宽拖动柄位置");
    await page.mouse.move(
      columnHandleBox.x + columnHandleBox.width / 2,
      columnHandleBox.y + columnHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(columnHandleBox.x + 16, columnHandleBox.y + columnHandleBox.height / 2);
    await page.mouse.up();
    await expect.poll(() => columnWidthsMm(table)).not.toEqual(widthsAfterNumericSet);

    await table.locator("td").first().click();
    await selectWholeTable(editor);
    await rail.getByRole("button", { name: "根据内容" }).click();
    await rail.getByRole("button", { name: "根据页面" }).click();
    await rail.getByRole("button", { name: "固定列宽" }).click();
    await expect(table).toHaveAttribute("data-layout-mode", "fixed");

    await table.locator("td").first().click();
    await page.keyboard.type("用于验证固定列宽下可继续输入的超长表格文字".repeat(8));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();

    const reopenedEditor = page.getByRole("textbox", { name: "编辑 说明书" });
    const reopenedTable = reopenedEditor.locator("table");
    await expect(reopenedTable.locator("tr")).toHaveCount(2);
    for (const row of [reopenedTable.locator("tr").first(), reopenedTable.locator("tr").last()]) {
      await expect(row).toHaveAttribute("data-row-height-mm", /\d+(?:\.\d+)?/u);
    }
    await expect(reopenedTable.locator("tr").first()).toHaveAttribute(
      "data-row-height-rule",
      "at-least",
    );
    await expect(reopenedTable.locator("tr").last()).toHaveAttribute(
      "data-row-height-rule",
      "exact",
    );
    await expect(reopenedTable).toHaveAttribute(
      "data-column-widths-mm",
      /\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)+/u,
    );
    await expect(reopenedTable).toHaveAttribute("data-layout-mode", "fixed");
    const widthAfter = await documentPage.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    await page
      .getByRole("dialog", { name: "导出专利文档" })
      .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
      .click();
    await expect.poll(() => fileSize(docxPath)).toBeGreaterThan(0);
    await closeOptionalDocxReport(page);
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "打印中心" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("默认页面宽度、标题行约束和边框预览在保存重开后保持正确", async ({ workbench }) => {
  test.setTimeout(120_000);
  const patentName = "表格核心回归验收夹具";
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, patentName);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();

    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await page.getByRole("button", { name: "插入表格" }).click();
    const insertion = page.getByRole("region", { name: "插入表格设置" });
    await insertion.getByRole("spinbutton", { name: "行数" }).fill("2");
    await insertion.getByRole("spinbutton", { name: "列数" }).fill("2");
    await insertion.getByRole("checkbox", { name: "将首行设为标题行" }).check();
    await insertion.getByRole("button", { name: "插入自定义表格" }).click();

    const table = editor.locator("table");
    const firstHeader = table.locator("th").first();
    await expect(table).toHaveAttribute("data-layout-mode", "fit-page");
    await expect(firstHeader).toBeVisible();
    const widthBeforeSave = await table.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await firstHeader.click();
    const rail = page.getByRole("region", { name: "表格功能" });
    await expandTableTools(page);
    await expect(rail.getByRole("button", { name: "上方插入行" })).toHaveAttribute(
      "data-unavailable",
      "true",
    );

    await selectWholeTable(editor);
    await rail.getByRole("button", { name: "无边框" }).click();
    await expect
      .poll(() => firstHeader.evaluate((element) => getComputedStyle(element).borderTopStyle))
      .toBe("none");
    await rail.getByRole("combobox", { name: "边框线型" }).selectOption("double");
    await rail.getByRole("button", { name: "全部边框" }).click();
    await expect
      .poll(() => firstHeader.evaluate((element) => getComputedStyle(element).borderTopStyle))
      .toBe("double");
    await expect(rail.getByRole("combobox", { name: "边框线型" })).toHaveValue("double");

    await editor.locator(":scope > p").last().click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();

    const reopenedTable = page.getByRole("textbox", { name: "编辑 说明书" }).locator("table");
    await expect(reopenedTable.locator("tr")).toHaveCount(2);
    await expect(reopenedTable.locator("tr").first().locator("th")).toHaveCount(2);
    const widthAfterReopen = await reopenedTable.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(Math.abs(widthAfterReopen - widthBeforeSave)).toBeLessThanOrEqual(1);
    const widths = await columnWidthsMm(reopenedTable);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(165, 3);
  } finally {
    await application.close().catch(() => undefined);
  }
});
