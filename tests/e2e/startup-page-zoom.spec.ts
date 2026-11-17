import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function expectActualZoom(page: Page, percent: number) {
  await expect(page.getByRole("button", { name: `缩放 ${percent}%，点击重置` })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".patent-editor-workspace:visible .patent-page-zoom-frame")
        .evaluate(
          (paper, percent) =>
            Math.abs(
              (paper.getBoundingClientRect().width / (paper as HTMLElement).offsetWidth) * 100 -
                percent,
            ),
          percent,
        ),
    )
    .toBeLessThan(0.08);
}

test("each software launch starts pages at 100 percent despite legacy settings and the previous session", async ({
  workbench,
}) => {
  let profile = await workbench.launchProfile("startup-page-zoom");
  let page = await profile.application.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("启动比例验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expectActualZoom(page, 100);
  for (const savedZoom of [50, 125, 200]) {
    await page.keyboard.press("Control+-");
    await expectActualZoom(page, 90);
    expect(
      await page.evaluate(
        (zoomPercent) => window.patentApi.settings.update({ zoomPercent }),
        savedZoom,
      ),
    ).toMatchObject({ ok: true });
    await profile.application.close();
    profile = await workbench.relaunchProfile(profile);
    page = await profile.application.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const settings = await page.evaluate(() => window.patentApi.settings.read());
    expect(settings).toMatchObject({ ok: true, value: { zoomPercent: savedZoom } });
    const card = page.getByRole("article", { name: "启动比例验收", exact: true });
    await card.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
    await expectActualZoom(page, 100);
  }
});

test("explicit document workspace zooms survive restoring dual view and remain bounded to their panes", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1746, height: 998 });
  await page.evaluate(async () => {
    const api = window.patentApi;
    const created = await api.patents.create({ name: "文档视图恢复验收", patentType: "invention" });
    if (!created.ok) throw new Error(created.error.message);
    const opened = created.value;
    const book = opened.patent.books.find((book) => book.kind === "description")!;
    const edited = await api.patents.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: opened.revision,
      bookKind: "description",
      document: book.document,
      assets: opened.patent.assets,
      editorState: {
        ...book.editorState,
        patdocWorkspace: {
          version: 1,
          activeBookKind: "description",
          zoomPercent: 110,
          columns: false,
          columnZoomPercent: 100,
          dual: {
            left: { bookKind: "claims", zoomPercent: 65 },
            right: { bookKind: "description", zoomPercent: 75 },
            activePane: "right",
          },
          books: [],
          aiCorrectionOpen: false,
          assistantOpen: false,
        },
      },
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const flushed = await api.patents.flush({
      patentId: opened.patentId,
      expectedRevision: edited.value.revision,
    });
    if (!flushed.ok) throw new Error(flushed.error.message);
    const released = await api.patents.release(opened.sessionId);
    if (!released.ok) throw new Error(released.error.message);
    await api.settings.update({ welcomeCompleted: true });
  });
  await page.reload();
  await page
    .getByRole("article", { name: "文档视图恢复验收", exact: true })
    .getByRole("button", { name: "更多操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
  for (const [side, zoom] of [
    ["left", 65],
    ["right", 75],
  ] as const) {
    const pane = page.locator(`.dual-document-pane[data-pane="${side}"]`);
    await expect(pane).toHaveAttribute("data-dual-zoom", String(zoom));
    await expect
      .poll(() =>
        pane
          .locator(".patent-page-zoom-frame")
          .evaluate(
            (paper, zoom) =>
              Math.abs(
                (paper.getBoundingClientRect().width / (paper as HTMLElement).offsetWidth) * 100 -
                  zoom,
              ),
            zoom,
          ),
      )
      .toBeLessThan(0.08);
  }
  await page.setViewportSize({ width: 1400, height: 998 });
  const right = page.locator('.dual-document-pane[data-pane="right"]');
  await expect
    .poll(async () => Number(await right.getAttribute("data-dual-zoom")))
    .toBeLessThan(75);
  const boundedZoom = await right.getAttribute("data-dual-zoom");
  await page.setViewportSize({ width: 2560, height: 998 });
  await expect(right).toHaveAttribute("data-dual-zoom", boundedZoom!);
});
