import { randomUUID } from "node:crypto";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("guides first body search through stoppable indexing in one dialog", async ({ workbench }) => {
  const profile = await workbench.launchProfile("content-search-first-index");
  try {
    const page = await profile.application.firstWindow();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { patentApi: PatentApi }).patentApi),
    );
    await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const created = await api.patents.create({
        name: "首次正文索引验收",
        patentType: "invention",
      });
      if (!created.ok) throw new Error(created.error.message);
      await api.patents.release(created.value.sessionId);
    });
    const reloaded = page.waitForEvent("domcontentloaded");
    const reloadResult = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.application.reloadRenderer?.(),
    );
    expect(reloadResult?.ok).toBe(true);
    await reloaded;
    await expect(page.getByRole("main", { name: "专利库" })).toBeVisible();
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    const library = page.getByRole("main", { name: "专利库" });
    const bodySearch = library.getByRole("checkbox", { name: "搜索正文" });
    await bodySearch.click();
    const dialog = page.getByRole("dialog", { name: "建立正文索引" });
    await expect(dialog).toBeVisible();
    await expect(bodySearch).not.toBeChecked();
    await dialog.getByRole("button", { name: "先建立索引" }).click();
    await expect(dialog.getByRole("button", { name: "停止索引" })).toBeVisible();
    await expect(dialog.getByRole("progressbar", { name: "正文索引进度" })).toBeVisible();
    await expect(bodySearch).toBeChecked();
    await expect(dialog).toHaveCount(0);
    const result = await page.evaluate(async () =>
      (window as unknown as { patentApi: PatentApi }).patentApi.contentSearch?.request({
        action: "status",
      }),
    );
    expect(result?.ok && result.value.indexPhase).toBe("completed");
    expect(result?.ok && result.value.indexedCount).toBe(1);
  } finally {
    await profile.application.close();
  }
});

test("enables background indexing by default without selecting body search", async ({
  workbench,
}) => {
  let profile = await workbench.launchProfile("content-search-restart");
  try {
    let page = await profile.application.firstWindow();
    expect(
      await page.evaluate(async () => {
        const result = await (
          window as unknown as { patentApi: PatentApi }
        ).patentApi.contentSearch?.request({ action: "status" });
        return result?.ok && result.value.enabled;
      }),
    ).toBe(true);
    profile = await workbench.relaunchProfile(profile);
    page = await profile.application.firstWindow();
    await page.locator(".patent-library-search").waitFor();
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    expect(
      await page.evaluate(async () => {
        const result = await (
          window as unknown as { patentApi: PatentApi }
        ).patentApi.contentSearch?.request({ action: "status" });
        return result?.ok && result.value.enabled;
      }),
    ).toBe(true);
    await expect(page.getByRole("checkbox", { name: "搜索正文" })).not.toBeChecked();
  } finally {
    await profile.application.close();
  }
});

test("indexes saved body only on request and opens a matching book from library results", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("content-search");
  try {
    const page = await profile.application.firstWindow();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { patentApi: PatentApi }).patentApi),
    );
    await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const created = await api.patents.create({
        name: "内容检索验收专利",
        patentType: "invention",
      });
      if (!created.ok) throw new Error(created.error.message);
      const opened = created.value;
      const book = opened.patent.books.find((b) => b.kind === "description");
      if (!book || !api.contentSearch) throw new Error("Missing book or search API");
      book.document.content.push(
        ...Array.from({ length: 60 }, (_, index) => ({
          type: "paragraph" as const,
          id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
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
              text:
                (index + 1) % 10 === 0
                  ? `第${(index + 1) / 10}处螺旋输送机构用于输送物料。`
                  : `普通说明段落${index + 1}，用于检验搜索结果定位。`,
              marks: [],
            },
          ],
        })),
      );
      const saved = await api.patents.applyBookEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        bookKind: "description",
        expectedRevision: opened.patent.revision,
        document: book.document,
        editorState: {},
        assets: [],
      });
      if (!saved.ok) throw new Error(saved.error.message);
      await api.patents.release(opened.sessionId);
      const before = await api.contentSearch.request({ action: "search", query: "螺旋输送" });
      if (!before.ok) throw new Error(`Search failed: ${before.error.code}`);
      if (before.value.hits?.length) throw new Error("Search unexpectedly indexed content");
      const start = await api.contentSearch.request({ action: "start" });
      if (!start.ok) throw new Error(start.error.message);
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const result = await (
            window as unknown as { patentApi: PatentApi }
          ).patentApi.contentSearch?.request({ action: "status" });
          return result?.ok && !result.value.running && !result.value.error;
        }),
      )
      .toBe(true);
    await page.reload();
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library).toBeVisible();
    const bodySearch = library.getByRole("checkbox", { name: "搜索正文" });
    await expect(bodySearch).not.toBeChecked();
    await library.getByRole("searchbox").fill("内容检索验收");
    await expect(library.locator(".library-card .library-search-result-number")).toHaveText("1.");
    await library.getByRole("searchbox").fill("螺旋输送");
    await expect(library.getByText("没有符合条件的专利。")).toBeVisible();
    await bodySearch.click();
    await expect(bodySearch).toBeChecked();
    expect(
      await library.locator(".patent-library-search").evaluate((element) => element.scrollLeft),
    ).toBe(0);
    const results = library.getByRole("region", { name: "正文搜索结果" });
    await expect(
      results.locator(".content-search-result-heading .library-search-result-number"),
    ).toHaveText("1.");
    await expect(results.getByRole("button", { name: "内容检索验收专利" })).toBeVisible();
    await expect(results.locator(".content-search-snippet")).toHaveCount(3);
    await results.getByRole("button", { name: "展开全部 6 处" }).click();
    await expect(results.locator(".content-search-snippet")).toHaveCount(6);
    await page.evaluate(() => {
      const samples: { top: number; time: number }[] = [];
      (window as unknown as { searchScrollSamples: typeof samples }).searchScrollSamples = samples;
      document.addEventListener(
        "scroll",
        (event) => {
          const element = event.target;
          if (element instanceof HTMLElement && element.matches(".patent-editor-workspace"))
            samples.push({ top: element.scrollTop, time: performance.now() });
        },
        true,
      );
      const behaviors: string[] = [];
      (window as unknown as { searchScrollBehaviors: string[] }).searchScrollBehaviors = behaviors;
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options) {
        if (typeof options === "object" && options?.behavior) behaviors.push(options.behavior);
        return original.call(this, options);
      };
    });
    await results.locator(".content-search-snippet").last().dblclick();
    await expect(library).not.toBeVisible();
    await expect(
      page.locator(".ProseMirror").filter({ hasText: "螺旋输送机构" }).first(),
    ).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toContain(
      "第1处螺旋输送机构用于输送物料。",
    );
    await expect(page.getByRole("group", { name: "正文搜索导航" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return selection?.anchorNode?.parentElement?.closest("p")?.textContent ?? "";
        }),
      )
      .toContain("第6处螺旋输送机构");
    await expect
      .poll(() => page.locator(".patent-editor-workspace").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    // Hidden Windows windows suppress native intermediate compositor frames. Verify the
    // real smooth-scroll request and final destination there; keep pixel-motion checks for visible runs.
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      expect(
        await page.evaluate(
          () => (window as unknown as { searchScrollBehaviors: string[] }).searchScrollBehaviors,
        ),
      ).toContain("smooth");
    } else {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const samples = (
              window as unknown as { searchScrollSamples: { top: number; time: number }[] }
            ).searchScrollSamples.filter((item) => item.top > 0);
            return (
              samples.length > 5 && (samples.at(-1)?.time ?? 0) - (samples[0]?.time ?? 0) > 250
            );
          }),
        )
        .toBe(true);
    }
    await page.getByRole("button", { name: "返回搜索结果" }).click();
    const restoredLibrary = page.getByRole("main", { name: "专利库" });
    await expect(restoredLibrary.getByRole("searchbox")).toHaveValue("螺旋输送");
    await expect(restoredLibrary.getByRole("checkbox", { name: "搜索正文" })).toBeChecked();
    await expect(
      restoredLibrary
        .getByRole("region", { name: "正文搜索结果" })
        .getByRole("button", { name: "内容检索验收专利" }),
    ).toBeVisible();
    const restoredResults = restoredLibrary.getByRole("region", { name: "正文搜索结果" });
    await expect(restoredResults.getByRole("button", { name: "收起全部匹配" })).toBeVisible();
    await expect(restoredResults.locator(".content-search-snippet")).toHaveCount(6);
    await expect(restoredResults.locator(".content-search-snippet.is-selected")).toHaveCount(1);
    await restoredResults.getByRole("button", { name: "内容检索验收专利" }).click();
    await expect(page.getByRole("group", { name: "正文搜索导航" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.getSelection()?.anchorNode?.parentElement?.closest("p")?.textContent ?? "",
        ),
      )
      .toContain("第1处螺旋输送机构");
    await page.getByRole("button", { name: "返回搜索结果" }).click();
    await expect(page.locator(".content-search-result-title.is-selected")).toHaveCount(1);
    await page.locator(".content-search-snippet").last().click();
    await page.getByRole("button", { name: "关闭搜索并取消高亮" }).click();
    await expect(page.getByRole("group", { name: "正文搜索导航" })).toHaveCount(0);
    await expect(page.getByRole("search", { name: "查找和替换" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    await page.getByRole("tab", { name: "专利库", exact: true }).click();
    await expect(page.getByRole("main", { name: "专利库" }).getByRole("searchbox")).toHaveValue("");
  } finally {
    await profile.application.close();
  }
});

test("locates repeated passages and table annotations, then refreshes changed results in place", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("content-search-regressions");
  try {
    const page = await profile.application.firstWindow();
    const patentId = await page.evaluate(
      async (ids) => {
        const api = (window as unknown as { patentApi: PatentApi }).patentApi;
        await api.contentSearch!.request({ action: "configure", enabled: false });
        const created = await api.patents.create({ name: "搜索定位回归", patentType: "invention" });
        if (!created.ok) throw new Error(created.error.message);
        const { patent, patentId, sessionId } = created.value;
        const book = patent.books.find((b) => b.kind === "description")!;
        const attrs = {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 14,
        };
        const paragraph = (id: string, text: string) => ({
          type: "paragraph" as const,
          id,
          attrs,
          content: [{ type: "text" as const, text, marks: [] }],
        });
        book.document.content = [
          {
            type: "table",
            id: ids[0]!,
            columnWidthsMm: [60],
            tableNameEnabled: true,
            tableName: "耐高温循环测试结果",
            tableNoteEnabled: true,
            tableNote: "环境温度为三十五摄氏度",
            rows: [
              {
                id: ids[1]!,
                cells: [
                  {
                    id: ids[2]!,
                    rowSpan: 1,
                    colSpan: 1,
                    horizontalAlignment: "left",
                    verticalAlignment: "top",
                    borderStyle: "single",
                    content: [paragraph(ids[3]!, "单元格数据")],
                  },
                ],
              },
            ],
          },
          ...ids.slice(4).map((id) => paragraph(id, "关键词")),
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
      },
      Array.from({ length: 44 }, () => randomUUID()),
    );
    const finishIndex = async () => {
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const result = await (
              window as unknown as { patentApi: PatentApi }
            ).patentApi.contentSearch!.request({ action: "status" });
            return result.ok && !result.value.running && !result.value.error;
          }),
        )
        .toBe(true);
    };
    await finishIndex();
    await page.reload();
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library).toBeVisible();
    await library.getByRole("checkbox", { name: "搜索正文" }).click();
    for (const [query, label] of [
      ["耐高温循环", "编辑表名"],
      ["三十五摄氏度", "编辑补充说明"],
    ]) {
      await library.getByRole("searchbox").fill(query!);
      await page.locator(".content-search-snippet").click();
      await page.locator(".ProseMirror").waitFor();
      const input = page.getByRole("textbox", { name: label! });
      await expect(input).toBeFocused();
      expect(
        await input.evaluate((el: HTMLTextAreaElement) =>
          el.value.slice(el.selectionStart, el.selectionEnd),
        ),
      ).toBe(query);
      await page.getByRole("button", { name: "返回搜索结果" }).click();
    }
    await library.getByRole("searchbox").fill("关键词");
    await page.getByRole("button", { name: "展开全部 40 处" }).click();
    await page.getByRole("button", { name: /^继续加载/ }).click();
    await expect(page.locator(".content-search-snippet")).toHaveCount(40);
    await page.locator(".content-search-snippet").last().click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const p = window.getSelection()?.anchorNode?.parentElement?.closest("p");
          return p ? Array.from(document.querySelectorAll(".ProseMirror p")).indexOf(p) + 1 : 0;
        }),
      )
      .toBe(41);
    await page.getByRole("button", { name: "返回搜索结果" }).click();
    // Close the renderer-owned session before an independent API edit; never release its live session.
    const closePatent = page.getByRole("button", { name: "关闭搜索定位回归", exact: true });
    await closePatent.click();
    await expect(closePatent).toHaveCount(0);
    await expect(page.locator(".content-search-snippet")).toHaveCount(40);
    await page.locator(".content-search-results").evaluate((el) => {
      (el as HTMLElement).dataset.auditMounted = "yes";
    });
    await page.evaluate(async (patentId) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const opened = await api.patents.open(patentId);
      if (!opened.ok) throw new Error(opened.error.message);
      const { patent, sessionId } = opened.value;
      const book = patent.books.find((b) => b.kind === "description")!;
      book.document.content = [
        {
          type: "paragraph",
          id: book.document.content.find((n) => n.type === "paragraph")!.id,
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 14,
          },
          content: [{ type: "text", text: "更新后没有原检索内容", marks: [] }],
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
    }, patentId);
    await finishIndex();
    await expect(page.locator(".content-search-snippet")).toHaveCount(0);
    await expect(page.locator(".content-search-results")).toHaveAttribute(
      "data-audit-mounted",
      "yes",
    );
    await expect(page.locator(".content-search-results").getByRole("status")).toContainText(
      "已找到 0 项专利",
    );
  } finally {
    await profile.application.close();
  }
});
