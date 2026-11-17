import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("library relocation saves, restarts, and opens the same patent at the new location", async ({
  workbench,
}) => {
  let profile = await workbench.launchProfile("relocation");
  let application = profile.application;
  try {
    const page = await application.firstWindow();
    const id = await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const result = await api.patents.create({ name: "迁移验收专利", patentType: "invention" });
      if (!result.ok) throw new Error(result.error.message);
      const book = result.value.patent.books.find((book) => book.kind === "description");
      const paragraph = book?.document.content.find((node) => node.type === "paragraph");
      if (!book || !paragraph) throw new Error("missing description");
      const edit = await api.patents.applyBookEdit({
        patentId: result.value.patentId,
        sessionId: result.value.sessionId,
        bookKind: "description",
        expectedRevision: result.value.revision,
        document: {
          ...book.document,
          content: [
            ...book.document.content,
            {
              ...paragraph,
              id: "00000000-0000-4000-8000-000000000982",
              content: [{ type: "text", text: "迁移后的正文必须完整保留", marks: [] }],
            },
          ],
        },
        editorState: book.editorState,
        assets: result.value.patent.assets,
      });
      if (!edit.ok) throw new Error(edit.error.message);
      await api.patents.flush({
        patentId: result.value.patentId,
        expectedRevision: edit.value.revision,
      });
      await api.patents.release(result.value.sessionId);
      return result.value.patentId;
    });
    const parent = join(workbench.root, "relocated-drive");
    await mkdir(parent);
    await application.evaluate(({ dialog }, parent) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
    }, parent);
    const closed = application.waitForEvent("close");
    const result = await page.evaluate(() =>
      (window as unknown as { patentApi: PatentApi }).patentApi.application.relocateLibrary(),
    );
    expect(result).toEqual({ ok: true, value: true });
    await closed;
    const beforeRestart = JSON.parse(
      await readFile(join(profile.userData, "library-location.json"), "utf8"),
    );
    expect(beforeRestart.pending.approved).toBe(true);
    expect(
      JSON.parse(await readFile(join(profile.libraryRoot, "last-run-state.json"), "utf8"))
        .cleanShutdown,
    ).toBe(true);
    profile = await workbench.relaunchProfile(profile);
    application = profile.application;
    const restarted = await application.firstWindow();
    const info = await restarted.evaluate(async (id) => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const storage = await api.application.storageOverview();
      const patent = await api.patents.open(id);
      if (!storage.ok || !patent.ok) throw new Error("migrated library unavailable");
      await api.patents.release(patent.value.sessionId);
      return {
        root: storage.value.library.path,
        name: patent.value.patent.name,
        text: JSON.stringify(patent.value.patent.books),
      };
    }, id);
    expect(info.root).toBe(beforeRestart.pending.target);
    expect(info.name).toBe("迁移验收专利");
    expect(info.text).toContain("迁移后的正文必须完整保留");
    expect((await stat(join(profile.libraryRoot, "library.sqlite3"))).size).toBeGreaterThan(0);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await application.close().catch(() => undefined);
  }
});
