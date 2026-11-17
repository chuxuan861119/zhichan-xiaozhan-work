import type { Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function readSaved(page: Page, patentId: string) {
  return page.evaluate(async (id) => {
    const opened = await window.patentApi.patents.open(id);
    if (!opened.ok) throw Error(opened.error.message);
    try {
      const cad = opened.value.patent.drawingProjects[0]?.cad;
      const source = cad
        ? await window.patentApi.assets.readDrawingSource(opened.value.sessionId, cad.assetId)
        : null;
      if (source && !source.ok) throw Error(source.error.message);
      return {
        patent: opened.value.patent,
        lines: source?.ok
          ? new TextDecoder()
              .decode(source.value)
              .split(/\r?\n/u)
              .filter((s) => s === "LINE").length
          : 0,
      };
    } finally {
      await window.patentApi.patents.release(opened.value.sessionId);
    }
  }, patentId);
}

test("CAD survives drawing, undo, document snapshot restoration and application restart without entering snapshots", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  let app = await workbench.launchAllowMultipleInstances();
  try {
    let page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    const patentId = await page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok || !list.value[0]) throw Error("Missing test patent");
      return list.value[0].patentId;
    });
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const line = page
      .getByRole("region", { name: "CAD实体编辑" })
      .getByRole("button", { name: "直线", exact: true });
    await expect(line).toBeEnabled({ timeout: 60_000 });
    await expect(workspace).toHaveAttribute("data-cad-pending", "false");
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    await line.click();
    await canvas.click({ position: { x: 200, y: 200 } });
    await canvas.click({ position: { x: 350, y: 300 } });
    await canvas.press("Escape");
    await expect.poll(async () => (await readSaved(page, patentId)).lines).toBe(1);
    await canvas.press("Control+z");
    await expect.poll(async () => (await readSaved(page, patentId)).lines).toBe(0);
    await canvas.press("Control+Shift+z");
    await expect.poll(async () => (await readSaved(page, patentId)).lines).toBe(1);
    await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
    await expect(workspace).toBeHidden();
    // Release the GUI editor before exercising a separate IPC writer session.
    await page.getByRole("button", { name: /^关闭未命名专利/u }).click();
    await expect(page.getByRole("heading", { name: "专利库", exact: true })).toBeVisible();
    const created = await page.evaluate(async (id) => {
      const noChange = await window.patentApi.snapshot.create({
        documentType: "patent",
        documentId: id,
        source: "manual-create",
      });
      if (!noChange.ok) throw Error(noChange.error.message);
      const opened = await window.patentApi.patents.open(id);
      if (!opened.ok) throw Error(opened.error.message);
      try {
        const book = opened.value.patent.books.find((b) => b.kind === "description");
        if (!book) throw Error("Missing description");
        const document = structuredClone(book.document);
        const paragraph = document.content.find((b) => b.type === "paragraph");
        if (paragraph?.type !== "paragraph") throw Error("Missing paragraph");
        paragraph.content = [{ type: "text", text: "文档快照验证正文", marks: [] }];
        const saved = await window.patentApi.patents.applyBookEdit({
          patentId: id,
          sessionId: opened.value.sessionId,
          expectedRevision: opened.value.revision,
          bookKind: "description",
          document,
          editorState: book.editorState,
          assets: opened.value.patent.assets,
        });
        if (!saved.ok) throw Error(saved.error.message);
        const snapshot = await window.patentApi.snapshot.create({
          documentType: "patent",
          documentId: id,
          source: "manual-create",
        });
        if (!snapshot.ok) throw Error(snapshot.error.message);
        const restored = await window.patentApi.snapshot.restore({
          documentType: "patent",
          documentId: id,
          revision: snapshot.value.revision,
        });
        if (!restored.ok) throw Error(restored.error.message);
        return {
          noChange: noChange.value,
          snapshot: snapshot.value,
          copy: restored.value.documentId,
        };
      } finally {
        await window.patentApi.patents.release(opened.value.sessionId);
      }
    }, patentId);
    expect(created.noChange.outcome).toBe("already-exists");
    expect(created.snapshot.outcome).toBe("created");
    const copy = await readSaved(page, created.copy);
    expect(copy.patent.drawingProjects).toHaveLength(0);
    expect(JSON.stringify(copy.patent.books)).toContain("文档快照验证正文");
    expect((await readSaved(page, patentId)).lines).toBe(1);
    await app.close();
    app = await workbench.launchAllowMultipleInstances();
    page = await app.firstWindow();
    expect((await readSaved(page, patentId)).lines).toBe(1);
    expect(JSON.stringify((await readSaved(page, patentId)).patent.books)).toContain(
      "文档快照验证正文",
    );
    expect((await readSaved(page, created.copy)).patent.drawingProjects).toHaveLength(0);
  } finally {
    await app.close();
  }
});
