import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("backup repairs damaged baseline and restores durable content", async ({ workbench }) => {
  const folder = join(workbench.root, "external-backup");
  let app = await workbench.launchAllowMultipleInstances();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { patentApi: PatentApi }).patentApi);
    const created = await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const result = await api.patents.create({
        name: "备份验收虚构专利",
        patentType: "invention",
      });
      if (!result.ok) throw Error(result.error.message);
      const opened = result.value;
      const book = opened.patent.books.find((b) => b.kind === "description");
      if (!book) throw Error("Missing description");
      const paragraph = book.document.content.find((b) => b.type === "paragraph");
      if (!paragraph) throw Error("Missing paragraph");
      const document = {
        ...book.document,
        content: [
          ...book.document.content,
          {
            ...paragraph,
            id: "00000000-0000-4000-8000-000000000987",
            content: [{ type: "text" as const, text: "备份正文校验-甲乙丙123", marks: [] }],
          },
        ],
      };
      const edit = await api.patents.applyBookEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        bookKind: "description",
        expectedRevision: opened.revision,
        document,
        editorState: book.editorState,
        assets: opened.patent.assets,
      });
      if (!edit.ok) throw Error(edit.error.message);
      await api.patents.flush({ patentId: opened.patentId, expectedRevision: edit.value.revision });
      await api.patents.release(opened.sessionId);
      return { patentId: opened.patentId };
    });
    const backed = await page.evaluate(async (folder) => {
      const configured = await (
        window as unknown as { patentApi: PatentApi }
      ).patentApi.backup.configure({
        enabled: true,
        waitOnExit: true,
        folder,
        intervalMinutes: 1,
      });
      if (!configured.ok) throw Error(configured.error.message);
      const result = await (
        window as unknown as { patentApi: PatentApi }
      ).patentApi.backup.finalize();
      if (!result.ok) throw Error(result.error.message);
      const list = await (window as unknown as { patentApi: PatentApi }).patentApi.backup.list();
      if (!list.ok) throw Error(list.error.message);
      return { result: result.value, entries: list.value };
    }, folder);
    expect(backed.result.successCount).toBe(1);
    const original = backed.entries.find((e) => e.documentId === created.patentId);
    if (!original) throw Error("Missing backup");
    expect(original.status).toBe("healthy");
    const restored = await page.evaluate(async (file) => {
      const result = await (window as unknown as { patentApi: PatentApi }).patentApi.backup.restore(
        file,
      );
      if (!result.ok) throw Error(result.error.message);
      const opened = await (window as unknown as { patentApi: PatentApi }).patentApi.patents.open(
        result.value.documentId,
      );
      if (!opened.ok) throw Error(opened.error.message);
      const text = JSON.stringify(opened.value.patent.books);
      await (window as unknown as { patentApi: PatentApi }).patentApi.patents.release(
        opened.value.sessionId,
      );
      return { id: result.value.documentId, text };
    }, original.fileName);
    expect(restored.id).not.toBe(created.patentId);
    expect(restored.text).toContain("备份正文校验-甲乙丙123");
    await writeFile(join(folder, original.fileName), "deliberately corrupted isolated test backup");
    const outcome = await page.evaluate(async () => {
      const listed = await (window as unknown as { patentApi: PatentApi }).patentApi.backup.list();
      const final = await (
        window as unknown as { patentApi: PatentApi }
      ).patentApi.backup.finalize();
      const status = await (
        window as unknown as { patentApi: PatentApi }
      ).patentApi.backup.status();
      return { listed, final, status };
    });
    expect(
      outcome.listed.ok &&
        outcome.listed.value.some(
          (e) => e.fileName === original.fileName && e.status === "damaged",
        ),
    ).toBe(true);
    expect(outcome.final.ok && outcome.final.value.failures).toEqual([]);
    expect(outcome.final.ok && outcome.final.value.skippedCount).toBe(0);
    expect(outcome.final.ok && outcome.final.value.successCount).toBe(2);
    const repaired = await page.evaluate(async (id) => {
      const listed = await (window as unknown as { patentApi: PatentApi }).patentApi.backup.list();
      if (!listed.ok) throw Error(listed.error.message);
      const healthy = listed.value.find((e) => e.documentId === id && e.status === "healthy");
      if (!healthy) throw Error("Missing repaired backup");
      const restored = await (
        window as unknown as { patentApi: PatentApi }
      ).patentApi.backup.restore(healthy.fileName);
      if (!restored.ok) throw Error(restored.error.message);
      const opened = await (window as unknown as { patentApi: PatentApi }).patentApi.patents.open(
        restored.value.documentId,
      );
      if (!opened.ok) throw Error(opened.error.message);
      const text = JSON.stringify(opened.value.patent.books);
      await (window as unknown as { patentApi: PatentApi }).patentApi.patents.release(
        opened.value.sessionId,
      );
      return text;
    }, created.patentId);
    expect(repaired).toContain("备份正文校验-甲乙丙123");
    expect(outcome.status.ok && outcome.status.value.lastError).toBeNull();
    // Disable only this isolated test's schedule before a restart to test durable recovery content.
    await page.evaluate(async (folder) => {
      await (window as unknown as { patentApi: PatentApi }).patentApi.backup.configure({
        enabled: false,
        folder,
        intervalMinutes: 1,
      });
    }, folder);
    await app.close();
    app = await workbench.launchAllowMultipleInstances();
    page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { patentApi: PatentApi }).patentApi);
    const text = await page.evaluate(async (id) => {
      const opened = await (window as unknown as { patentApi: PatentApi }).patentApi.patents.open(
        id,
      );
      if (!opened.ok) throw Error(opened.error.message);
      const text = JSON.stringify(opened.value.patent.books);
      await (window as unknown as { patentApi: PatentApi }).patentApi.patents.release(
        opened.value.sessionId,
      );
      return text;
    }, restored.id);
    expect(text).toContain("备份正文校验-甲乙丙123");
  } finally {
    await app.close();
  }
});
