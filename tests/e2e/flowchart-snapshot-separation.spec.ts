import type { Page } from "@playwright/test";
import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function readSaved(page: Page, patentId: string) {
  return page.evaluate(async (id) => {
    const opened = await window.patentApi.patents.open(id);
    if (!opened.ok) throw Error(opened.error.message);
    try {
      const project = opened.value.patent.flowchartProjects[0];
      const loaded = project
        ? await window.patentApi.flowcharts.load({ patentId: id, projectId: project.projectId })
        : null;
      if (loaded && !loaded.ok) throw Error(loaded.error.message);
      return {
        patent: opened.value.patent,
        source: loaded?.ok ? Array.from(loaded.value.source) : [],
      };
    } finally {
      await window.patentApi.patents.release(opened.value.sessionId);
    }
  }, patentId);
}

test("real flowchart edits, undo, publish, reopen and restart stay independent of document snapshot copies", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  let app = await workbench.launchAllowMultipleInstances();
  try {
    let page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("流程图快照隔离验证");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openDrawingEntry(page, "插入流程图");
    await expect.poll(() => page.frames().some((f) => f.url().endsWith("/embed.html"))).toBe(true);
    let frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
    if (!frame) throw Error("Missing real flowchart editor");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    const click = async (label: string) => {
      if (!frame) throw Error("Missing frame");
      const button = frame.getByRole("button", { name: label, exact: true });
      await expect(button).toBeEnabled();
      // Invoke real listeners in the hidden custom-protocol iframe without OS focus.
      await button.evaluate((element) => (element as HTMLButtonElement).click());
    };
    await click("基础流程");
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    await click("步骤编号");
    await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
    await click("撤销");
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    await click("重做");
    await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
    await frame.locator("body").press("Control+s");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    const patentId = await page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok || !list.value[0]) throw Error("Missing test patent");
      return list.value[0].patentId;
    });
    const unchanged = await page.evaluate(
      (id) =>
        window.patentApi.snapshot.create({
          documentType: "patent",
          documentId: id,
          source: "manual-create",
        }),
      patentId,
    );
    expect(unchanged.ok && unchanged.value.outcome).toBe("already-exists");
    await click("插入附图");
    const insertion = page.getByRole("dialog", { name: "插入到说明书附图" });
    await expect(insertion.getByAltText("最终黑白专利附图预览")).toBeVisible();
    await insertion.getByRole("button", { name: "添加为图 1", exact: true }).click();
    await expect(insertion).toBeHidden();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await expect(page.getByTitle("流程图编辑器")).toHaveCount(0);
    await openDrawingEntry(page, "插入流程图");
    await expect.poll(() => page.frames().some((f) => f.url().endsWith("/embed.html"))).toBe(true);
    frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
    if (!frame) throw Error("Missing reopened flowchart editor");
    await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await page.getByRole("button", { name: "关闭流程图快照隔离验证", exact: true }).click();
    await expect(page.getByRole("heading", { name: "专利库", exact: true })).toBeVisible();
    const before = await readSaved(page, patentId);
    expect(before.patent.flowchartProjects).toHaveLength(1);
    expect(before.patent.figures[0]?.flowchartLink).toBeDefined();
    const restoredId = await page.evaluate(async (id) => {
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
      return restored.value.documentId;
    }, patentId);
    const copy = await readSaved(page, restoredId);
    expect(copy.patent.flowchartProjects).toHaveLength(0);
    expect(copy.patent.figures).toHaveLength(1);
    expect(copy.patent.figures[0]?.flowchartLink).toBeUndefined();
    expect((await readSaved(page, patentId)).source).toEqual(before.source);
    await app.close();
    app = await workbench.launchAllowMultipleInstances();
    page = await app.firstWindow();
    expect((await readSaved(page, patentId)).source).toEqual(before.source);
    expect((await readSaved(page, patentId)).patent.figures).toHaveLength(1);
    expect((await readSaved(page, restoredId)).patent.flowchartProjects).toHaveLength(0);
  } finally {
    await app.close();
  }
});
