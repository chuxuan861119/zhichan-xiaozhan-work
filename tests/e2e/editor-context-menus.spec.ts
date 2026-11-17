import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { choosePaneBook, enterDualView, expect, swapDualPanes, test } from "./helpers/workbench.js";

async function expectSelectionToolbarAnchor(
  editor: import("@playwright/test").Locator,
  bubble: import("@playwright/test").Locator,
) {
  await expect
    .poll(async () => {
      const anchor = await editor.evaluate((element) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        const a = e.view.coordsAtPos(e.state.selection.from);
        const b = e.view.coordsAtPos(e.state.selection.to, -1);
        const scope =
          element.closest("[data-function-rail-scope], .standard-workspace-pane") ?? document.body;
        const bounds = scope.getBoundingClientRect();
        return {
          center: (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
          left: Math.max(8, bounds.left + 8),
          right: Math.min(innerWidth - 8, bounds.right - 8),
          top: Math.max(8, bounds.top + 8),
          bottom: Math.min(innerHeight - 8, bounds.bottom - 8),
        };
      });
      const rect = await bubble.boundingBox();
      if (!rect) return Infinity;
      const expected = Math.max(
        anchor.left,
        Math.min(anchor.center - rect.width / 2, anchor.right - rect.width),
      );
      return Math.max(
        Math.abs(rect.x - expected),
        anchor.top - rect.y,
        rect.y + rect.height - anchor.bottom,
      );
    })
    .toBeLessThan(2);
}

test("selection toolbar follows retained editors through dual view and back to single view", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    for (const name of ["暂不创建", "稍后设置"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible()) await button.click();
    }
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("浮窗布局切换验收");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const single = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await single.evaluate((element) => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
        `<p>${"选区定位测试".repeat(30)}</p>`,
      );
    });
    const original = await single.evaluateHandle(
      (element) => (element as HTMLElement & { editor: Editor }).editor,
    );
    const before = await single.evaluate((element) =>
      (element as HTMLElement & { editor: Editor }).editor.getJSON(),
    );
    const bubble = page.locator(".editor-selection-menu:not([data-spatial-paint]):visible");
    const select = async (editor: import("@playwright/test").Locator) => {
      await editor.evaluate((element) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        e.view.focus();
        e.commands.setTextSelection({ from: 3, to: 7 });
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
      await expect(bubble).toHaveCount(1);
      await expectSelectionToolbarAnchor(editor, bubble);
    };
    await select(single);
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.emulateMedia({ reducedMotion: cycle === 0 ? "reduce" : "no-preference" });
      await enterDualView(page);
      const left = page.getByRole("region", { name: "左侧文档" });
      const editor = left.getByRole("textbox", { name: "编辑 说明书", exact: true });
      expect(
        await editor.evaluate(
          (element, first) => (element as HTMLElement & { editor: Editor }).editor === first,
          original,
        ),
      ).toBe(true);
      await select(editor);
      await editor.press("Escape");
      await choosePaneBook(page, "right", "浮窗布局切换验收", "权利要求书");
      const right = page.getByRole("region", { name: "右侧文档" }).getByRole("textbox").first();
      await right.evaluate((element) => {
        (element as HTMLElement & { editor: Editor }).editor.commands.setContent(
          `<p>${"右侧选区定位".repeat(20)}</p>`,
        );
      });
      await select(right);
      await right.press("Escape");
      await select(editor);
      await editor.press("Escape");
      let returnPane = left;
      if (cycle === 1) {
        await swapDualPanes(page);
        returnPane = page.getByRole("region", { name: "右侧文档" });
        const moved = returnPane.getByRole("textbox", { name: "编辑 说明书", exact: true });
        await select(moved);
        await moved.press("Escape");
      }
      // Header double-click restores this retained editor to a single-page layout.
      await returnPane.locator(".dual-document-pane__title").dblclick();
      await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toBeHidden();
      await select(single);
      expect(
        await single.evaluate((element) =>
          (element as HTMLElement & { editor: Editor }).editor.getJSON(),
        ),
      ).toEqual(before);
    }
  } finally {
    await app.close();
  }
});

test("selection toolbar and contextual actions preserve editing target", async ({ workbench }) => {
  const patent = createBlankPatent({ patentType: "invention", name: "菜单验收" });
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw Error("description missing");
  const paragraph = createBlankDocument("fixture").content[0];
  if (paragraph?.type !== "paragraph") throw Error("paragraph missing");
  paragraph.content = [{ type: "text", text: "选择菜单测试文字", marks: [] }];
  description.document.content = [paragraph];
  const source = join(workbench.root, "menus.patdoc");
  await writePatdoc(source, { patent, assets: [] });
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    for (const name of ["暂不创建", "稍后设置"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible()) await button.click();
    }
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    const notice = page.getByRole("dialog", { name: "PATDOC 导入须知" });
    if (await notice.isVisible())
      await notice.getByRole("button", { name: "继续导入", exact: true }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor).toContainText("选择菜单测试文字");
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.focus();
      e.commands.setTextSelection({ from: 1, to: 5 });
    });
    const bubble = page.locator(".editor-selection-menu:not([data-spatial-paint]):visible");
    await expect(bubble).toBeVisible();
    await expectSelectionToolbarAnchor(editor, bubble);
    await editor.press("Escape");
    const firstFrames = await editor.evaluate(async (element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.view.focus();
      e.commands.setTextSelection({ from: 5, to: 9 });
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const errors: number[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          const toolbar = document.querySelector<HTMLElement>(
            ".editor-selection-menu:not([data-spatial-paint])",
          );
          if (
            toolbar &&
            getComputedStyle(toolbar).visibility === "visible" &&
            Number(getComputedStyle(toolbar).opacity) > 0
          ) {
            const rect = toolbar.getBoundingClientRect();
            const a = e.view.coordsAtPos(e.state.selection.from);
            const b = e.view.coordsAtPos(e.state.selection.to, -1);
            errors.push(
              Math.abs(
                rect.x +
                  rect.width / 2 -
                  (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
              ),
            );
          }
          if (performance.now() - start < 450) setTimeout(sample, 16);
          else resolve();
        };
        sample();
      });
      return errors;
    });
    expect(firstFrames.length).toBeGreaterThan(0);
    expect(Math.max(...firstFrames)).toBeLessThan(2);
    await editor.press("Escape");
    await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.view.focus();
      e.commands.setTextSelection({ from: 1, to: 5 });
    });
    await expect(bubble).toBeVisible();
    await expectSelectionToolbarAnchor(editor, bubble);
    await bubble.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const initialToolbar = await bubble.boundingBox();
    await bubble.getByRole("button", { name: "居中", exact: true }).click();
    await expect(editor.locator("p").first()).toHaveCSS("text-align", "center");
    // Wait for the menu's 150ms positioning debounce, not just the command transaction.
    await page.waitForTimeout(300);
    const centeredToolbar = await bubble.boundingBox();
    expect(centeredToolbar?.x).toBeCloseTo(initialToolbar!.x, 0);
    expect(centeredToolbar?.y).toBeCloseTo(initialToolbar!.y, 0);
    await bubble.getByRole("button", { name: "加粗", exact: true }).click();
    await expect(editor.locator("strong")).toHaveText("选择菜单");
    await expect(bubble.getByRole("button", { name: "加粗", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await bubble.getByRole("button", { name: "下划线", exact: true }).click();
    await expect(editor.locator("u")).toHaveText("选择菜单");
    await editor.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "文档右键菜单", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "复制", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("选择菜单");
    // Native Chromium can report success even when an app copy handler refuses data.
    await editor.evaluate((element) => {
      element.addEventListener(
        "copy",
        (event) => {
          (event as ClipboardEvent).clipboardData?.clearData();
          event.preventDefault();
        },
        { once: true },
      );
    });
    await editor.press("Shift+F10");
    await menu.getByRole("menuitem", { name: "剪切", exact: true }).click();
    await expect(editor).toContainText("选择菜单测试文字");
    await page.getByRole("button", { name: "知道了", exact: true }).click();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await expect
      .poll(() =>
        editor.evaluate(
          (element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.empty,
        ),
      )
      .toBe(true);
    await editor.press("Shift+F10");
    await expect(menu.getByRole("menuitem", { name: "剪切", exact: true })).toBeDisabled();
    await app.evaluate(({ clipboard }) => clipboard.writeText("选择菜单"));
    await menu.getByRole("menuitem", { name: "粘贴", exact: true }).click();
    await expect(editor).toContainText("选择菜单测试文字选择菜单");
    await editor.press("Shift+F10");
    const collapsedMenu = await menu.boundingBox();
    await menu.getByRole("menuitem", { name: "插入", exact: true }).click();
    const expandedMenu = await menu.boundingBox();
    const insertMenu = await menu.getByRole("menu", { name: "插入", exact: true }).boundingBox();
    if (!expandedMenu || !insertMenu) throw new Error("菜单未显示");
    expect(expandedMenu?.height).toBe(collapsedMenu?.height);
    expect(insertMenu.x).toBeGreaterThanOrEqual(expandedMenu.x + expandedMenu.width);
    await menu.getByRole("menuitem", { name: "插入表格", exact: true }).click();
    await expect(editor.locator("table")).toBeVisible();
    await editor.locator("td").first().click({ button: "right" });
    await menu.getByRole("menuitem", { name: "表格", exact: true }).click();
    await menu.getByRole("menuitem", { name: "下方插入行", exact: true }).click();
    await expect(editor.locator("tr")).toHaveCount(3);
    await editor.press("Shift+F10");
    await page.screenshot({ path: test.info().outputPath("context-menu.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await enterDualView(page);
    await choosePaneBook(page, "right", "菜单验收", "权利要求书");
    const rightEditor = page
      .getByRole("region", { name: "右侧文档" })
      .getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    const leftEditor = page
      .getByRole("region", { name: "左侧文档" })
      .getByRole("textbox", { name: "编辑 说明书", exact: true });
    const leftDocument = () =>
      leftEditor.evaluate((element) =>
        (element as HTMLElement & { editor: Editor }).editor.getJSON(),
      );
    const leftBefore = await leftDocument();
    await rightEditor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.view.focus();
      e.commands.setTextSelection({ from: 1, to: 3 });
    });
    await expect(bubble).toHaveCount(1);
    await expectSelectionToolbarAnchor(rightEditor, bubble);
    await bubble.getByRole("button", { name: "斜体", exact: true }).click();
    await expect(rightEditor.locator("em")).toHaveCount(1);
    expect(await leftDocument()).toEqual(leftBefore);
    await page.screenshot({ path: test.info().outputPath("dual-selection-menu.png") });
    await rightEditor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      e.commands.setTextSelection(3);
      e.commands.insertContent({
        type: "inlineMath",
        attrs: { latex: "x^2", formulaKind: "math" },
      });
    });
    await rightEditor.locator('[data-type="inline-math"] .katex-html').click({ button: "right" });
    await menu.getByRole("menuitem", { name: "重新编辑", exact: true }).click();
    const formula = page.getByRole("dialog", { name: "编辑数学公式", exact: true });
    await expect(formula).toBeVisible();
    await formula.getByRole("button", { name: "取消", exact: true }).click();
    expect(await leftDocument()).toEqual(leftBefore);
  } finally {
    await app.close();
  }
});
