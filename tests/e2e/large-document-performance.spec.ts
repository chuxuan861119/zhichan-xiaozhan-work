import type { Editor, JSONContent } from "@tiptap/core";
import { tiptapToDocumentBlocks } from "../../src/shared/document/model-adapter.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

type EditorElement = HTMLElement & { editor: Editor };

const scenarios = [
  { name: "纯文档1000段", paragraphs: 1_000, tables: 0 },
  { name: "纯文档2000段", paragraphs: 2_000, tables: 0 },
  { name: "混排20表格", paragraphs: 1_000, tables: 20 },
];

for (const scenario of scenarios) {
  test(`@performance 100k ${scenario.name}: typing, history, search and persisted reopen`, async ({
    workbench,
  }, testInfo) => {
    test.setTimeout(120_000);
    const application = await workbench.launchAllowMultipleInstances();
    try {
      const page = await application.firstWindow();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await dismissWorkbenchWelcome(page);
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
      await dialog.getByRole("textbox", { name: "专利名称" }).fill(scenario.name);
      await dialog.getByRole("radio", { name: "发明", exact: true }).check();
      await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
      const backup = page.getByRole("button", { name: "稍后设置", exact: true });
      if (await backup.isVisible()) await backup.click();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
      await editor.evaluate((element, config) => {
        const instance = (element as EditorElement).editor;
        const text = "本发明涉及连接件和控制器。";
        const length = 100_000 / config.paragraphs;
        const content: JSONContent[] = Array.from({ length: config.paragraphs }, () => ({
          type: "paragraph",
          attrs: { nodeId: crypto.randomUUID() },
          content: [
            { type: "text", text: text.repeat(Math.ceil(length / text.length)).slice(0, length) },
          ],
        }));
        for (let i = 0; i < config.tables; i++)
          content.splice(i * 45, 0, {
            type: "table",
            content: Array.from({ length: 5 }, () => ({
              type: "tableRow",
              content: Array.from({ length: 4 }, () => ({
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "数据" }] }],
              })),
            })),
          });
        instance
          .chain()
          .setContent({ type: "doc", content })
          .command(({ tr }) => {
            tr.setMeta("addToHistory", false);
            return true;
          })
          .run();
      }, scenario);
      await expect(page.getByRole("status", { name: "已保存", exact: true }).last()).toBeVisible();

      // No rAF latency gate: hidden windows can throttle painting independently
      // of synchronous input. Measure the real command and keyboard input paths.
      const samples = await editor.evaluate(async (element) => {
        const instance = (element as EditorElement).editor;
        instance.commands.setTextSelection(instance.state.doc.content.size - 1);
        const durations: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          instance.commands.insertContent("测");
          durations.push(performance.now() - start);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return durations;
      });
      await editor.press("Control+End");
      const keyboard: number[] = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        await page.keyboard.insertText("验");
        keyboard.push(performance.now() - start);
      }
      const history = await editor.evaluate(async (element) => {
        const instance = (element as EditorElement).editor;
        // Begin a separate native history group without altering history policy.
        await new Promise((resolve) => setTimeout(resolve, 550));
        const before = instance.state.doc.textContent;
        instance.commands.insertContent("撤销重做验证");
        instance.commands.undo();
        const undone = instance.state.doc.textContent === before;
        instance.commands.redo();
        const redone = instance.state.doc.textContent === `${before}撤销重做验证`;
        return { undone, redone };
      });
      expect(history).toEqual({ undone: true, redone: true });

      await editor.press("Control+f");
      const query = page.getByRole("textbox", { name: "查找内容", exact: true });
      await query.fill("本发明");
      const expectedMatches = await editor.evaluate(
        (element) =>
          ((element as EditorElement).editor.state.doc.textContent.match(/本发明/g) ?? []).length,
      );
      await expect(page.locator(".find-replace-panel__count")).toHaveText(`0/${expectedMatches}`);
      await query.press("Escape");

      const before = await editor.evaluate((element) =>
        (element as EditorElement).editor.getJSON(),
      );
      const saveStart = performance.now();
      await page
        .getByRole("button", { name: "保存", exact: true })
        .evaluate((button: HTMLElement) => button.click());
      await expect(
        page.getByText(/已保存，(?:并成功创建快照|当前版本已有快照)/).last(),
      ).toBeVisible();
      const saveMs = performance.now() - saveStart;
      await page
        .getByRole("button", { name: `关闭${scenario.name}`, exact: true })
        .evaluate((button: HTMLElement) => button.click());
      await expect(page.getByRole("tab", { name: scenario.name, exact: true })).toHaveCount(0);
      await page
        .locator(".patent-list-title-button")
        .filter({ hasText: scenario.name })
        .evaluate((button: HTMLElement) => button.click());
      await page
        .getByRole("tab", { name: "说明书", exact: true })
        .evaluate((button: HTMLElement) => button.click());
      await expect(editor).toBeVisible();
      const restored = await editor.evaluate((element) =>
        (element as EditorElement).editor.getJSON(),
      );
      // Editor defaults such as textAlign:null normalize to alignment:left on
      // persistence. Compare the full canonical blocks, not just visible text.
      const expectedBlocks = tiptapToDocumentBlocks(before);
      const restoredBlocks = tiptapToDocumentBlocks(restored);
      expect(expectedBlocks.ok).toBe(true);
      expect(restoredBlocks).toEqual(expectedBlocks);
      const sorted = [...samples].sort((a, b) => a - b);
      const inputP95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      await testInfo.attach("large-document-performance.json", {
        body: JSON.stringify(
          { scenario, samples, keyboard, saveMs, inputP95, history, expectedMatches },
          null,
          2,
        ),
        contentType: "application/json",
      });
      // Generous enough for CI, but rejects the original ~800 ms table regression.
      expect(inputP95).toBeLessThan(150);
    } finally {
      await application.close();
    }
  });
}
