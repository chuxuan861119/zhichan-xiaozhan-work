import { randomUUID } from "node:crypto";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("warns without selecting another occurrence when the clicked passage was deleted", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("search-deleted-passage");
  try {
    const page = await profile.application.firstWindow();
    const ids = [randomUUID(), randomUUID()];
    const patentId = await page.evaluate(async (ids) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      await api.contentSearch!.request({ action: "configure", enabled: false });
      const created = await api.patents.create({ name: "旧搜索片段定位", patentType: "invention" });
      if (!created.ok) throw new Error(created.error.message);
      const { patent, sessionId, patentId } = created.value;
      const book = patent.books.find((b) => b.kind === "description")!;
      book.document.content = ids.map((id, index) => ({
        type: "paragraph" as const,
        id,
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 14,
        },
        content: [
          {
            type: "text" as const,
            text: index === 0 ? "原本独特的电机关键词结构" : "完全不同的材料关键词说明",
            marks: [],
          },
        ],
      }));
      const saved = await api.patents.applyBookEdit({
        patentId,
        sessionId,
        bookKind: "description",
        expectedRevision: patent.revision,
        document: book.document,
        editorState: {},
        assets: [],
      });
      if (!saved.ok) throw new Error(saved.error.message);
      await api.patents.release(sessionId);
      await api.contentSearch!.request({ action: "start" });
      return patentId;
    }, ids);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await (
            window as unknown as { patentApi: PatentApi }
          ).patentApi.contentSearch!.request({ action: "status" });
          return result.ok && !result.value.running && result.value.indexPhase === "completed";
        }),
      )
      .toBe(true);
    await page.reload();
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    const library = page.getByRole("main", { name: "专利库" });
    await library.getByRole("searchbox").fill("关键词");
    await library.getByRole("checkbox", { name: "搜索正文" }).click();
    await expect(library.getByRole("checkbox", { name: "搜索正文" })).toBeChecked();
    const clicked = library
      .getByRole("button", { name: /说明书.*原本独特的电机关键词结构/ })
      .first();
    await expect(clicked).toBeVisible();
    // Change only the source document; the intentionally old index still has
    // the clicked snippet, exactly as with editing before background maintenance.
    await page.evaluate(async (patentId) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const opened = await api.patents.open(patentId);
      if (!opened.ok) throw new Error(opened.error.message);
      const { patent, sessionId } = opened.value;
      const book = patent.books.find((b) => b.kind === "description")!;
      book.document.content = book.document.content.slice(1);
      const saved = await api.patents.applyBookEdit({
        patentId,
        sessionId,
        bookKind: "description",
        expectedRevision: patent.revision,
        document: book.document,
        editorState: {},
        assets: [],
      });
      if (!saved.ok) throw new Error(saved.error.message);
      await api.patents.release(sessionId);
    }, patentId);
    await clicked.click();
    await expect(
      page.getByText(
        "文档已打开，但无法可靠定位原搜索片段，内容可能已变化。请更新搜索索引后重试。",
        { exact: true },
      ),
    ).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("关键词");
    await expect(page.getByRole("search", { name: "查找和替换" })).toHaveCount(0);
  } finally {
    await profile.application.close();
  }
});

test("reads the final detail pages beyond 100000 through the real preload bridge", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("search-large-detail-pages");
  try {
    const page = await profile.application.firstWindow();
    const patentId = await page.evaluate(async (id) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      await api.contentSearch!.request({ action: "configure", enabled: false });
      const created = await api.patents.create({ name: "大匹配分页", patentType: "invention" });
      if (!created.ok) throw new Error(created.error.message);
      const { patent, patentId, sessionId } = created.value;
      const book = patent.books.find((b) => b.kind === "description")!;
      book.document.content = [
        {
          type: "paragraph",
          id,
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
          content: [{ type: "text", text: "◎".repeat(100080), marks: [] }],
        },
      ];
      const saved = await api.patents.applyBookEdit({
        patentId,
        sessionId,
        bookKind: "description",
        expectedRevision: patent.revision,
        document: book.document,
        editorState: {},
        assets: [],
      });
      if (!saved.ok) throw new Error(saved.error.message);
      await api.patents.release(sessionId);
      await api.contentSearch!.request({ action: "start" });
      return patentId;
    }, randomUUID());
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await (
            window as unknown as { patentApi: PatentApi }
          ).patentApi.contentSearch!.request({ action: "status" });
          return result.ok && !result.value.running && result.value.indexPhase === "completed";
        }),
      )
      .toBe(true);
    const pages = await page.evaluate(async (patentId) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const pages = [];
      let offset: number | null = 99990;
      while (offset !== null) {
        const result = await api.contentSearch!.request({
          action: "search-details",
          query: "◎",
          patentId,
          offset,
        });
        if (!result.ok) throw new Error(result.error.message);
        const book = result.value.hits?.[0]?.books.find((b) => b.kind === "description");
        pages.push({
          count: book?.count,
          occurrences: book?.locations?.map((l) => l.occurrence),
          snippets: book?.snippets.length,
        });
        offset = result.value.nextOffset ?? null;
      }
      return pages;
    }, patentId);
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.count === 100080 && p.snippets === 30)).toBe(true);
    expect(pages.flatMap((p) => p.occurrences ?? [])).toEqual(
      Array.from({ length: 90 }, (_, i) => 99990 + i),
    );
  } finally {
    await profile.application.close();
  }
});
