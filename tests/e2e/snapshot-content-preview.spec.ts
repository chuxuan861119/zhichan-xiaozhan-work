import type { Page } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    await expect(welcome).toBeHidden();
  }
}

test("previews a real five-book snapshot diff without mutating data and restores clean content", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  let application = await workbench.launch();
  let page = await application.firstWindow();
  await dismissWelcome(page);

  const setup = await page.evaluate(async () => {
    const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
    const created = await api.patents.create({
      patentType: "invention",
      name: "快照全文预览验证",
    });
    if (!created.ok) throw new Error(created.error.message);
    const opened = created.value;
    const description = opened.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("新建专利缺少说明书");
    const paragraphAttrs = {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "宋体",
      defaultFontSizePt: 12,
    };
    const stableTextId = "00000000-0000-4000-8000-000000000101";
    const changedTextId = "00000000-0000-4000-8000-000000000102";
    const formulaId = "00000000-0000-4000-8000-000000000103";
    const deletedSentenceId = "00000000-0000-4000-8000-000000000104";
    const stableText = `保持文字仅改变颜色和高亮。${"长文快照内容用于核验后台差异计算。".repeat(500)}`;
    const baselineDocument = {
      ...description.document,
      content: [
        ...description.document.content,
        {
          id: stableTextId,
          type: "paragraph" as const,
          attrs: paragraphAttrs,
          content: [{ type: "text" as const, text: stableText, marks: [] }],
        },
        {
          id: changedTextId,
          type: "paragraph" as const,
          attrs: paragraphAttrs,
          content: [
            {
              type: "text" as const,
              text: "这是说明书靠后位置的旧部件文字。",
              marks: [],
            },
          ],
        },
        {
          id: deletedSentenceId,
          type: "paragraph" as const,
          attrs: paragraphAttrs,
          content: [
            {
              type: "text" as const,
              text: "这是一条将在下一版中被完整删除的独立句子。",
              marks: [],
            },
          ],
        },
        {
          id: formulaId,
          type: "block-formula" as const,
          source: "x+1",
          formulaKind: "math" as const,
        },
      ],
    };
    const baselineEdit = await api.patents.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      bookKind: "description",
      expectedRevision: opened.revision,
      document: baselineDocument,
      editorState: description.editorState,
      assets: opened.patent.assets,
    });
    if (!baselineEdit.ok) throw new Error(baselineEdit.error.message);
    const baselineSnapshot = await api.snapshot.create({
      documentType: "patent",
      documentId: opened.patentId,
      source: "manual-create",
    });
    if (!baselineSnapshot.ok) throw new Error(baselineSnapshot.error.message);

    const currentDocument = structuredClone(baselineDocument);
    const stableParagraph = currentDocument.content.find((block) => block.id === stableTextId);
    const changedParagraph = currentDocument.content.find((block) => block.id === changedTextId);
    const formula = currentDocument.content.find((block) => block.id === formulaId);
    if (stableParagraph?.type !== "paragraph" || changedParagraph?.type !== "paragraph")
      throw new Error("测试段落不存在");
    if (formula?.type !== "block-formula") throw new Error("测试公式不存在");
    stableParagraph.content = [
      {
        type: "text",
        text: stableText,
        marks: [
          { type: "color", value: "#C00000" },
          { type: "background-color", value: "#FFFF00" },
        ],
      },
    ];
    changedParagraph.content = [
      {
        type: "text",
        text: "这是说明书靠后位置的新增绝缘部件文字。",
        marks: [],
      },
    ];
    formula.source = "y+2";
    currentDocument.content = currentDocument.content.filter(
      (block) => block.id !== deletedSentenceId,
    );
    const currentEdit = await api.patents.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      bookKind: "description",
      expectedRevision: baselineEdit.value.revision,
      document: currentDocument,
      editorState: description.editorState,
      assets: opened.patent.assets,
    });
    if (!currentEdit.ok) throw new Error(currentEdit.error.message);
    const currentSnapshot = await api.snapshot.create({
      documentType: "patent",
      documentId: opened.patentId,
      source: "manual-create",
    });
    if (!currentSnapshot.ok) throw new Error(currentSnapshot.error.message);
    const entries = await api.snapshot.list("patent");
    if (!entries.ok) throw new Error(entries.error.message);
    const revisions = entries.value.entries
      .filter((entry) => entry.documentId === opened.patentId)
      .map((entry) => entry.revision)
      .sort((left, right) => left - right);
    await api.patents.release(opened.sessionId);
    const beforePreview = await api.patents.open(opened.patentId);
    if (!beforePreview.ok) throw new Error(beforePreview.error.message);
    await api.patents.release(beforePreview.value.sessionId);
    return {
      patentId: opened.patentId,
      baselineRevision: baselineEdit.value.revision,
      currentRevision: currentEdit.value.revision,
      currentPatent: JSON.stringify(beforePreview.value.patent),
      revisions,
    };
  });

  expect(setup.revisions).toEqual(
    expect.arrayContaining([setup.baselineRevision, setup.currentRevision]),
  );
  await application.close();
  application = await workbench.launch();
  page = await application.firstWindow();
  await dismissWelcome(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: "存储与备份" }).click();
  await settings.getByRole("button", { name: "快照版本" }).click();
  await settings.getByRole("button", { name: "打开“快照全文预览验证”的快照历史" }).click();
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    Object.assign(window, { snapshotPreviewWorkers: 0 });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("snapshot-preview")) {
          const state = window as typeof window & { snapshotPreviewWorkers: number };
          state.snapshotPreviewWorkers += 1;
        }
      }
    };
  });
  await page.getByRole("button", { name: `查看 v${setup.currentRevision} 内容预览` }).click();

  const dialog = page.getByRole("dialog", { name: `v${setup.currentRevision} 内容预览` });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(new RegExp(`与 v${setup.baselineRevision}（.+）相比`)),
  ).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveCount(5);
  expect(
    await page.evaluate(
      () => (window as typeof window & { snapshotPreviewWorkers: number }).snapshotPreviewWorkers,
    ),
  ).toBe(1);
  const descriptionTab = dialog.getByRole("tab", { name: /说明书 \d+ 项变化/ });
  await expect(descriptionTab).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("变化位置").getByRole("button")).toHaveCount(6);

  const previewDocument = dialog.getByRole("document", { name: "说明书快照内容" });
  const insertion = previewDocument.locator('[data-snapshot-mark="snapshotInsertion"]');
  const deletion = previewDocument.locator('[data-snapshot-mark="snapshotDeletion"]');
  const format = previewDocument.locator('[data-snapshot-mark="snapshotFormatChange"]');
  await expect(insertion).toContainText("新增绝缘");
  await expect(deletion).toContainText("旧");
  await dialog
    .getByLabel("变化位置")
    .getByRole("button", { name: /删除段落/ })
    .click();
  await expect(
    previewDocument
      .locator('[data-snapshot-change-kind="delete"]')
      .filter({ hasText: "这是一条将在下一版中被完整删除的独立句子。" }),
  ).toContainText("这是一条将在下一版中被完整删除的独立句子。");
  await expect(format).toContainText("保持文字仅改变颜色和高亮");
  await expect(
    previewDocument.locator('[data-snapshot-change-kind="delete"][data-latex="x+1"]'),
  ).toBeAttached();
  await expect(
    previewDocument.locator('[data-snapshot-change-kind="insert"][data-latex="y+2"]'),
  ).toBeAttached();
  await dialog.getByLabel("变化位置").getByRole("button").filter({ hasText: "格式变化" }).click();
  await expect(dialog.getByLabel("变化详情")).toContainText("字体颜色");
  await dialog.getByRole("button", { name: "下一个变化" }).click();
  await expect(dialog.getByLabel("变化详情")).not.toContainText("请选择");
  await dialog.getByRole("tab", { name: /权利要求书 0 项变化/ }).click();
  await expect(dialog.getByText("该文档没有可标记的内容变化。")).toBeVisible();
  await descriptionTab.click();

  await format.evaluate((element) => {
    element.setAttribute("tabindex", "-1");
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const copied = await page.evaluate(() => {
    let text = "";
    const handleCopy = (event: ClipboardEvent) => {
      text = event.clipboardData?.getData("text/plain") ?? "";
    };
    document.addEventListener("copy", handleCopy, { once: true });
    if (!document.execCommand("copy")) throw new Error("浏览器拒绝复制快照内容");
    return text;
  });
  expect(copied).toContain("保持文字仅改变颜色和高亮");

  await dialog.getByRole("button", { name: "关闭内容预览" }).click();
  await expect(dialog).not.toBeVisible();

  const afterPreview = await page.evaluate(async (patentId) => {
    const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
    const opened = await api.patents.open(patentId);
    if (!opened.ok) throw new Error(opened.error.message);
    const result = {
      revision: opened.value.revision,
      serialized: JSON.stringify(opened.value.patent),
    };
    await api.patents.release(opened.value.sessionId);
    return result;
  }, setup.patentId);
  expect(afterPreview.revision).toBe(setup.currentRevision);
  expect(afterPreview.serialized).toBe(setup.currentPatent);
  expect(afterPreview.serialized).not.toContain("snapshotChange");
  await page.getByRole("button", { name: `恢复 v${setup.currentRevision}` }).click();
  await page.getByRole("button", { name: "确认恢复" }).click();
  const library = page.getByRole("main", { name: "专利库" });
  await expect(
    library.getByRole("article", {
      name: new RegExp(`快照全文预览验证（快照恢复 v${setup.currentRevision}`),
    }),
  ).toBeVisible();

  const restored = await page.evaluate(async (originalId) => {
    const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
    const listed = await api.patents.list("active");
    if (!listed.ok) throw new Error(listed.error.message);
    const clone = listed.value.find((patent) => patent.patentId !== originalId);
    if (!clone) throw new Error("恢复副本不存在");
    const opened = await api.patents.open(clone.patentId);
    if (!opened.ok) throw new Error(opened.error.message);
    const description = opened.value.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("恢复副本缺少说明书");
    const serialized = JSON.stringify(description.document);
    await api.patents.release(opened.value.sessionId);
    return serialized;
  }, setup.patentId);
  expect(restored).toContain("新增绝缘部件文字");
  expect(restored).toContain('"value":"#C00000"');
  expect(restored).toContain('"value":"#FFFF00"');
  expect(restored).toContain('"source":"y+2"');
  expect(restored).not.toContain("snapshotChange");

  const deletionAttempt = await page.evaluate(async ({ patentId, currentRevision }) => {
    const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
    const listed = await api.snapshot.list("patent");
    if (!listed.ok) throw new Error(listed.error.message);
    for (const entry of listed.value.entries) {
      if (entry.documentId !== patentId || entry.revision === currentRevision) continue;
      const result = await api.snapshot.delete({
        documentType: "patent",
        documentId: patentId,
        revision: entry.revision,
      });
      if (!result.ok) throw new Error(result.error.message);
    }
    return await api.snapshot.delete({
      documentType: "patent",
      documentId: patentId,
      revision: currentRevision,
    });
  }, setup);
  expect(deletionAttempt).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("最后一个") },
  });
  await application.close();
  application = await workbench.launch();
  page = await application.firstWindow();
  const afterDeletionRestart = await page.evaluate(async (patentId) => {
    const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
    const opened = await api.patents.open(patentId);
    if (!opened.ok) throw new Error(opened.error.message);
    await api.patents.release(opened.value.sessionId);
    return JSON.stringify(opened.value.patent);
  }, setup.patentId);
  expect(afterDeletionRestart).toBe(setup.currentPatent);
  await application.close();
});
