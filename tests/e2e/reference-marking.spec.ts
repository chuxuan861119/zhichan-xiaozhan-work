import { dismissWorkbenchWelcome } from "./helpers/workbench.js";
/** Reference-mark acceptance: numbering, three-book synchronization, undo/redo and persistence. */
/// <reference lib="dom" />

import { resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

test("unifies context undo, native redo branches and drawing-panel reference history", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launch();
  const page = await application.firstWindow();
  try {
    await dismissWelcome(page);
    await createPatent(page, "撤销入口回归", "发明");
    await replaceEditorText(page, "权利要求书", "箱体");
    await selectEditorText(page, "权利要求书", "箱体");
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    const claims = bookEditor(page, "权利要求书");
    await expect(claims).toHaveText("箱体(1)");
    await claims.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^撤销/ }).click();
    await expect(claims).toHaveText("箱体");
    await expect(page.getByRole("region", { name: "附图标记" })).toContainText("暂无附图标记");
    await claims.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^重做/ }).click();
    await expect(claims).toHaveText("箱体(1)");
    await claims.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^撤销/ }).click();
    await expect(claims).toHaveText("箱体");
    await claims.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("新内容");
    await expect(claims).toHaveText("箱体新内容");
    await page.keyboard.press("Control+Z");
    await expect(claims).toHaveText("箱体");
    await page.keyboard.press("Control+Y");
    await expect(claims).toHaveText("箱体新内容");
    await selectEditorText(page, "权利要求书", "箱体");
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    await expect(claims).toContainText("箱体(1)");
    await bookTab(page, "说明书附图").click();
    await page.getByRole("button", { name: "展开附图标记" }).click();
    await page.getByRole("button", { name: "编辑箱体", exact: true }).click();
    await page.getByRole("button", { name: "取消箱体编号", exact: true }).click();
    await page.getByRole("button", { name: "确认取消编号", exact: true }).click();
    await expect(page.getByRole("button", { name: "编辑箱体", exact: true })).toHaveCount(0);
    await page.keyboard.press("Control+Z");
    await expect(page.getByRole("button", { name: "编辑箱体", exact: true })).toBeVisible();
    await page.keyboard.press("Control+Y");
    await expect(page.getByRole("button", { name: "编辑箱体", exact: true })).toHaveCount(0);
    await page.keyboard.press("Control+Z");
    await bookTab(page, "权利要求书").click();
    await expect(claims).toHaveText("箱体(1)新内容");
  } finally {
    await application.close();
  }
});

test("persists imported drawing redo and abstract selection through closing and reopening", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  const page = await application.firstWindow();
  try {
    await dismissWelcome(page);
    await createPatent(page, "附图重做持久化回归", "发明");
    await mockNativeDialogs(
      application,
      [resolve("tests/fixtures/images/sample.png"), resolve("tests/fixtures/images/sample.png")],
      [],
    );
    await bookTab(page, "说明书附图").click();
    await page.getByRole("button", { name: "插入图片", exact: true }).click();
    const figures = page.getByRole("article", { name: /^图\d+$/ });
    await expect(figures).toHaveCount(2);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(figures).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(figures).toHaveCount(2);
    await page.keyboard.press("Control+Z");
    await expect(figures).toHaveCount(0);
    // Let the real save queue commit the removal before redo.
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.keyboard.press("Control+Y");
    await expect(figures).toHaveCount(2);
    await bookTab(page, "摘要附图").click();
    const selection = page.locator("select.patent-book-tools__abstract-drawing-select");
    await selection.selectOption({ index: 1 });
    const selected = await selection.inputValue();
    await bookTab(page, "摘要附图").click();
    await page.keyboard.press("Control+Z");
    await expect(selection).toHaveValue("");
    await page.keyboard.press("Control+Y");
    await expect(selection).toHaveValue(selected);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "关闭附图重做持久化回归", exact: true }).click();
    const card = page.getByRole("article", { name: "附图重做持久化回归", exact: true });
    await card.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "继续编辑" }).click();
    await bookTab(page, "说明书附图").click();
    await expect(figures).toHaveCount(2);
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "图1", exact: true })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await bookTab(page, "摘要附图").click();
    await expect(selection).toHaveValue(selected);
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "摘要附图 图1", exact: true })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page.getByText("保存失败", { exact: true })).toHaveCount(0);
  } finally {
    await application.close();
  }
});

function bookTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function bookEditor(page: Page, name: string) {
  return page.getByRole("textbox", { name: `编辑 ${name}` });
}

async function replaceEditorText(page: Page, bookName: string, text: string): Promise<void> {
  const editor = bookEditor(page, bookName);
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}

async function selectEditorText(page: Page, bookName: string, text: string): Promise<void> {
  const editor = bookEditor(page, bookName);
  await editor.click();
  await editor.evaluate((root, keyword) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const offset = node.textContent?.indexOf(keyword) ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + keyword.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return;
    }
    throw new Error(`keyword not found: ${keyword}`);
  }, text);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
}

async function createPatent(page: Page, name: string, type: "发明" | "实用新型"): Promise<void> {
  const patentLibrary = page.getByRole("tab", { name: "专利库" });
  if (await patentLibrary.isVisible()) await patentLibrary.click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建专利" });
  await createDialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await createDialog.getByRole("radio", { name: type }).check();
  await createDialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function mockNativeDialogs(
  application: ElectronApplication,
  imagePaths: string[],
  exportPaths: string[],
): Promise<void> {
  await application.evaluate(
    ({ dialog }, paths) => {
      let exportIndex = 0;
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: paths.images }),
      });
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({
          canceled: false,
          filePath: paths.exports[exportIndex++],
        }),
      });
    },
    { images: imagePaths, exports: exportPaths },
  );
}

test("supplements embodiment numbers with feedback and upper-viewport positioning", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "增补编号验收", "发明");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "快捷键", exact: true }).click();
    const shortcut = settings.getByRole("button", {
      name: "设置增补编号快捷键",
    });
    await shortcut.click();
    await shortcut.press("F9");
    await expect(shortcut).toContainText("F9");
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await replaceEditorText(page, "权利要求书", "箱体");
    await selectEditorText(page, "权利要求书", "箱体");
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    await expect(bookEditor(page, "权利要求书")).toContainText("箱体(1)");
    await bookTab(page, "说明书").click();
    const editor = bookEditor(page, "说明书");
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("具体实施方式");
    for (let index = 0; index < 45; index++) {
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(
        index === 20 ? "此处为新增箱体。" : "用于验证滚动位置的普通段落。",
      );
    }
    await page.keyboard.press("F9");
    await expect(
      page.getByRole("status").filter({ hasText: "增补成功，共补充 1 处编号。" }),
    ).toBeVisible();
    const supplemented = editor
      .locator('span[style*="color"]')
      .filter({ hasText: "箱体1" })
      .first();
    await expect(supplemented).toHaveCSS("color", "rgb(124, 58, 237)");
    const ratio = () =>
      supplemented.evaluate((node) => {
        const workspace = node.closest(".editor-workspace");
        if (!workspace) return -1;
        const viewport = workspace.getBoundingClientRect();
        return (node.getBoundingClientRect().top - viewport.top) / viewport.height;
      });
    await expect.poll(ratio).toBeGreaterThan(0.1);
    await expect.poll(ratio).toBeLessThan(0.5);
    await page.getByRole("button", { name: "增补编号", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "无需增补编号。" })).toBeVisible();
    await expect(editor).not.toContainText("箱体11");
    await editor.click();
    await page.keyboard.press("Control+Z");
    await expect(editor).toContainText("此处为新增箱体。");
    await expect(editor).not.toContainText("箱体1");
    await page.keyboard.press("Control+Y");
    await expect(editor).toContainText("此处为新增箱体1。");
  } finally {
    await application.close();
  }
});

test("编号权利要求并同步共享附图标记（reference marking e2e）", async ({ workbench }) => {
  test.setTimeout(180_000);
  const patentName = "附图标记验收夹具";
  const pngPath = "tests/fixtures/images/sample.png";
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) =>
      rendererErrors.push(error.stack || error.message || String(error)),
    );
    await page.evaluate(() => {
      const stats = { completed: 0, failed: 0 };
      Object.assign(window, { referenceMarkWorkerStats: stats });
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("reference-mark-status.worker")) {
            this.addEventListener("message", () => {
              stats.completed += 1;
            });
            this.addEventListener("error", () => {
              stats.failed += 1;
            });
          }
        }
      };
    });
    await dismissWelcome(page);
    await mockNativeDialogs(application, [pngPath], []);
    // Verify the preload/IPC copy path without overwriting the user's clipboard.
    await application.evaluate(({ clipboard }) => {
      let copied = "";
      Object.defineProperty(clipboard, "writeText", {
        value: (text: string) => {
          copied = text;
        },
      });
      Object.defineProperty(clipboard, "readText", { value: () => copied });
    });
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
        ),
      ).toBe(true);
    }

    // 步骤 1-2：新建发明专利并录入未编号的权利要求文本。
    await createPatent(page, patentName, "发明");
    await bookTab(page, "权利要求书").click();
    await replaceEditorText(
      page,
      "权利要求书",
      "1. 一种环保回收装置，其特征在于，包括箱体和分拣机构。",
    );

    const panel = page.getByRole("region", { name: "附图标记" });
    const numberButton = panel.getByRole("button", { name: "顺序编号" });

    // 步骤 3：全新专利没有 legend 段落时，编号按钮仍可用。
    await expect(numberButton).toBeEnabled();

    // 步骤 4：连续编号后逐次撤销，权利要求和共享面板必须逐层一起回退。
    const claimsEditor = bookEditor(page, "权利要求书");
    await selectEditorText(page, "权利要求书", "箱体");
    await numberButton.click();
    expect(rendererErrors).toEqual([]);
    await expect(claimsEditor).toContainText("箱体(1)");
    await expect(panel).toContainText("1箱体");
    await selectEditorText(page, "权利要求书", "分拣机构");
    await numberButton.click();
    await expect(claimsEditor).toContainText("分拣机构(2)");
    await expect(panel).toContainText("2分拣机构");
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).not.toContainText("其中：");

    await bookTab(page, "权利要求书").click();
    await claimsEditor.click();
    await page.keyboard.press("Control+Z");
    await expect(claimsEditor).not.toContainText("分拣机构(2)");
    await expect(claimsEditor).toContainText("箱体(1)");
    await expect(panel).not.toContainText("2分拣机构");
    await expect(panel).toContainText("1箱体");
    await page.keyboard.press("Control+Z");
    await expect(claimsEditor).not.toContainText("箱体(1)");
    await expect(panel).not.toContainText("1箱体");

    // 撤销后可再次编号，并继续给第二个关键词编号。
    await bookTab(page, "权利要求书").click();
    await selectEditorText(page, "权利要求书", "箱体");
    await numberButton.click();
    await expect(claimsEditor).toContainText("箱体(1)");
    await selectEditorText(page, "权利要求书", "分拣机构");
    await numberButton.click();
    await expect(claimsEditor).toContainText("分拣机构(2)");
    // 面板（只读视图）列出两个附图标记。
    await expect(panel).toContainText("1箱体");
    await expect(panel).toContainText("2分拣机构");

    // 步骤 5：共享附图标记不自动写入说明书；用户主动填入后才建立投影。
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).not.toContainText("其中：");
    await bookTab(page, "权利要求书").click();
    await panel.getByRole("button", { name: "填入说明书" }).click();
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("其中：1、箱体；2、分拣机构。");

    // Current panel edits synchronize all three books without a legacy toggle.
    await bookTab(page, "说明书").click();
    await bookEditor(page, "说明书").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("箱体和箱体1，分拣机构2。");
    await bookTab(page, "说明书摘要").click();
    await replaceEditorText(page, "说明书摘要", "箱体和箱体1，分拣机构2。");
    await bookTab(page, "权利要求书").click();
    await panel.getByRole("button", { name: "编辑箱体", exact: true }).click();
    const keywordInput = panel.getByRole("textbox", { name: "箱体关键词" });
    await keywordInput.fill("机箱");
    await panel.getByRole("button", { name: "保存箱体" }).click();
    await expect(claimsEditor).toContainText("机箱(1)");

    // 步骤 7：把 机箱 由 1 改为 3（空闲号；占用号会被 DUPLICATE 规则拒绝）。
    await panel.getByRole("button", { name: "编辑机箱", exact: true }).click();
    const numberInput = panel.getByRole("textbox", { name: "机箱序号" });
    await numberInput.fill("3");
    await panel.getByRole("button", { name: "保存机箱" }).click();
    await expect(claimsEditor).toContainText("机箱(3)");
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("其中：3、机箱；2、分拣机构。");

    for (const name of ["说明书", "说明书摘要"]) {
      await bookTab(page, name).click();
      await expect(bookEditor(page, name)).toContainText("机箱和机箱3，分拣机构2。");
    }

    // 步骤 8：序号修改后立即组合撤销，权利要求与共享面板必须原子回退。
    await bookTab(page, "权利要求书").click();
    await claimsEditor.click();
    await page.keyboard.press("Control+Z");
    await expect(claimsEditor).toContainText("机箱(1)");
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("其中：1、机箱；2、分拣机构。");

    await bookTab(page, "说明书摘要").click();
    await expect(bookEditor(page, "说明书摘要")).toContainText("机箱和机箱1，分拣机构2。");

    // Composite redo must restore all documents together.
    await bookTab(page, "权利要求书").click();
    await claimsEditor.click();
    await page.keyboard.press("Control+Y");
    await expect(claimsEditor).toContainText("机箱(3)");
    await bookTab(page, "说明书摘要").click();
    await expect(bookEditor(page, "说明书摘要")).toContainText("机箱和机箱3，分拣机构2。");
    await bookTab(page, "权利要求书").click();
    await claimsEditor.click();
    await page.keyboard.press("Control+Z");
    await expect(claimsEditor).toContainText("机箱(1)");

    // 撤销后仍可再次将 机箱 改为 3。
    await bookTab(page, "权利要求书").click();
    await panel.getByRole("button", { name: "编辑机箱", exact: true }).click();
    await panel.getByRole("textbox", { name: "机箱序号" }).fill("3");
    await panel.getByRole("button", { name: "保存机箱" }).click();
    await expect(claimsEditor).toContainText("机箱(3)");

    // 步骤 9：删除 机箱（3） 文本 → 面板该行出现缺词警告（is-missing）。
    await bookTab(page, "权利要求书").click();
    await replaceEditorText(page, "权利要求书", "1. 一种环保回收装置，其特征在于，包括分拣机构。");
    const machineRow = panel
      .locator(".reference-mark-panel__rows > div")
      .filter({ hasText: "机箱" });
    await expect(machineRow).toHaveClass(/is-missing/);
    await expect(machineRow).toContainText("未找到关键词：权利要求书");
    // 共享面板仍包含机箱（参考标记条目未删除）。
    await expect(machineRow.locator(".reference-mark-panel__row-number")).toHaveText("3");
    await expect(machineRow.locator(".reference-mark-panel__row-keyword")).toHaveText("机箱");
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("其中：3、机箱；2、分拣机构。");

    // 再次输入关键词后，缺词状态自动恢复。
    await bookTab(page, "权利要求书").click();
    await replaceEditorText(
      page,
      "权利要求书",
      "1. 一种环保回收装置，其特征在于，包括机箱(3)和分拣机构(2)。",
    );
    await expect(claimsEditor).toContainText("机箱(3)");
    await expect(machineRow).not.toHaveClass(/is-missing/);
    await expect(machineRow).not.toContainText("未找到关键词：权利要求书");

    // Abstract bare-number errors should be found and removed after correction.
    await bookTab(page, "说明书摘要").click();
    await replaceEditorText(page, "说明书摘要", "机箱9，分拣机构2。");
    await bookTab(page, "权利要求书").click();
    await expect(machineRow).toHaveClass(/is-issue/);
    await machineRow.getByRole("button", { name: "定位问题", exact: true }).click();
    await expect(bookTab(page, "说明书摘要")).toHaveAttribute("aria-selected", "true");
    await expect(bookEditor(page, "说明书摘要").locator(".reference-mark-issue-match")).toHaveText(
      "机箱9",
    );
    await replaceEditorText(page, "说明书摘要", "机箱和机箱3，分拣机构2。");
    await bookTab(page, "权利要求书").click();
    await expect(machineRow).not.toHaveClass(/is-issue/);
    await expect(machineRow).not.toContainText("共定位 1 处");

    // 步骤 10：面板“复制”按钮可用并点击。
    await expect(panel.getByRole("button", { name: "复制" })).toBeEnabled();
    await panel.getByRole("button", { name: "复制" }).click();
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain("3、机箱");

    // 步骤 11：保存 → 关闭 → 继续编辑 → 重新打开，断言持久化。
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: `关闭${patentName}` }).click();
    const patentCard = page.getByRole("article", { name: patentName });
    await patentCard.getByRole("button", { name: "更多操作" }).click();
    await page
      .getByRole("menu", { name: "专利操作" })
      .getByRole("menuitem", { name: "继续编辑" })
      .click();
    await bookTab(page, "权利要求书").click();
    await expect(bookEditor(page, "权利要求书")).toContainText("机箱(3)");
    await bookTab(page, "说明书").click();
    await expect(bookEditor(page, "说明书")).toContainText("其中：3、机箱；2、分拣机构。");
    await bookTab(page, "说明书摘要").click();
    await expect(bookEditor(page, "说明书摘要")).toContainText("机箱和机箱3，分拣机构2。");
    expect(rendererErrors).toEqual([]);
    const workerStats = await page.evaluate(
      () =>
        (
          window as unknown as {
            referenceMarkWorkerStats: { completed: number; failed: number };
          }
        ).referenceMarkWorkerStats,
    );
    expect(workerStats.completed).toBeGreaterThan(0);
    expect(workerStats.failed).toBe(0);
  } finally {
    await application.close().catch(() => undefined);
  }
});
