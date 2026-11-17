import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { APPLICATION_DATA_DIRECTORY } from "../../src/shared/branding.js";
import { expect, test } from "./helpers/workbench.js";

const PASSWORD = "fictional-safe-baseline-migration-password";

test("current native export restore restart edit and re-export; prepared cancel", async ({
  workbench,
}) => {
  test.setTimeout(240000);
  let running: any;
  try {
    const source = await workbench.launchProfile("baseline-source");
    running = source.application;
    const sourcePage = await source.application.firstWindow();
    const sourcePatent = await sourcePage.evaluate(async () => {
      const created = await window.patentApi.patents.create({
        patentType: "invention",
        name: "虚构安全迁移验收专利",
        customer: null,
      });
      if (!created.ok) throw new Error(created.error.code);
      const opened = created.value;
      const claims = opened.patent.books.find((book) => book.kind === "claims")!;
      const first = claims.document.content.find((block) => block.type === "paragraph")!;
      const document = {
        ...claims.document,
        content: [
          {
            ...first,
            content: [
              { type: "text" as const, text: "1. 一种虚构验收装置，包括虚构定位部。", marks: [] },
            ],
          },
        ],
      };
      const edited = await window.patentApi.patents.applyBookEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        bookKind: "claims",
        expectedRevision: opened.revision,
        document,
        editorState: { selection: { anchor: 1, head: 1 } },
        assets: opened.patent.assets,
      });
      if (!edited.ok) throw new Error(edited.error.code);
      const flushed = await window.patentApi.patents.flush({
        patentId: opened.patentId,
        expectedRevision: edited.value.revision,
      });
      if (!flushed.ok) throw new Error(flushed.error.code);
      await window.patentApi.patents.release(opened.sessionId);
      const saved = await window.patentApi.patents.open(opened.patentId);
      if (!saved.ok) throw new Error(saved.error.code);
      await window.patentApi.patents.release(saved.value.sessionId);
      return saved.value.patent;
    });
    const packagePath = join(workbench.root, "baseline.zxwbackup");
    await source.application.evaluate(({ dialog }, p) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath: p }),
      });
    }, packagePath);
    const exportResult = await sourcePage.evaluate(
      async ({ password, operationId }) => {
        const selected = await window.patentApi.dataTransfer.selectExportDestination();
        if (!selected.ok || !selected.value) throw new Error("export selection");
        return window.patentApi.dataTransfer.exportPackage({
          operationId,
          destinationSelectionId: selected.value.selectionId,
          password,
          passwordHint: null,
          passwordRecorded: true,
        });
      },
      { password: PASSWORD, operationId: randomUUID() },
    );
    expect(exportResult, JSON.stringify(exportResult)).toMatchObject({
      ok: true,
      value: { fullVerificationPassed: true },
    });
    expect(
      (await readdir(join(source.localAppData, APPLICATION_DATA_DIRECTORY))).filter((name) =>
        name.startsWith(".full-data-export-"),
      ),
    ).toEqual([]);
    await source.application.close();
    running = undefined;

    const target = await workbench.launchProfile("baseline-target");
    running = target.application;

    await workbench.removeTransientProfileMarkers(target);
    const targetPage = await target.application.firstWindow();
    const shutdownReport = join(workbench.root, "shutdown-errors.json");
    await target.application.evaluate(
      ({ app, dialog }, { p, shutdownReport }) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [p] }),
        });
        Object.defineProperty(app, "relaunch", { configurable: true, value: () => undefined });
        const errors: string[] = [];
        Object.defineProperty(dialog, "showErrorBox", {
          configurable: true,
          value: (title: string, content: string) => errors.push(`${title}: ${content}`),
        });
        app.on("will-quit", () =>
          process.getBuiltinModule!("node:fs").writeFileSync(
            shutdownReport,
            JSON.stringify(errors),
          ),
        );
      },
      { p: packagePath, shutdownReport },
    );
    const operationId = randomUUID();
    const sourceSelectionId = await targetPage.evaluate(async () => {
      const selected = await window.patentApi.dataTransfer.selectImportPackage();
      if (!selected.ok || !selected.value) throw new Error("import selection");
      return selected.value.selectionId;
    });
    const wrongPassword = await targetPage.evaluate(
      ({ operationId, sourceSelectionId }) =>
        window.patentApi.dataTransfer.prepareImport({
          operationId,
          sourceSelectionId,
          password: "fictional-wrong-password",
        }),
      { operationId: randomUUID(), sourceSelectionId },
    );
    expect(wrongPassword).toMatchObject({
      ok: false,
      error: { code: "PASSWORD_OR_PACKAGE_INVALID" },
    });
    const prepared = await targetPage.evaluate(
      ({ password, operationId, sourceSelectionId }) =>
        window.patentApi.dataTransfer.prepareImport({ operationId, sourceSelectionId, password }),
      { password: PASSWORD, operationId, sourceSelectionId },
    );
    expect(prepared).toMatchObject({
      ok: true,
      value: { packageVerified: true, targetLibraryEmpty: true },
    });
    const closed = new Promise<void>((resolve) => target.application.once("close", resolve));
    const committed = await targetPage
      .evaluate(
        (operationId) =>
          window.patentApi.dataTransfer.commitImport({
            operationId,
            acknowledgedEmptyLibraryAndRestart: true,
          }),
        operationId,
      )
      .catch((error) => {
        if (!targetPage.isClosed()) throw error;
        return null;
      });
    if (committed !== null)
      expect(committed).toEqual({ ok: true, value: { restartPending: true } });
    await closed;
    running = undefined;
    expect(JSON.parse(await readFile(shutdownReport, "utf8"))).toEqual([]);

    const restored = await workbench.launchProfile("baseline-target");
    running = restored.application;
    const restoredPage = await restored.application.firstWindow();
    const report = await restoredPage.evaluate(() => {
      const read = window.patentApi.application.getStartupRecoveryReport;
      if (!read) throw new Error("startup recovery report unavailable");
      return read();
    });
    expect(report).toMatchObject({
      ok: true,
      value: { mode: "read-write", dataImportRecovery: "recovered" },
    });
    const after = await restoredPage.evaluate(async (patentId) => {
      const opened = await window.patentApi.patents.open(patentId);
      if (!opened.ok) throw new Error(opened.error.code);
      await window.patentApi.patents.release(opened.value.sessionId);
      return opened.value.patent;
    }, sourcePatent.patentId);
    expect(after).toEqual(sourcePatent);
    const modified = await restoredPage.evaluate(async (patentId) => {
      const result = await window.patentApi.patents.open(patentId);
      if (!result.ok) throw new Error(result.error.code);
      const opened = result.value;
      const claims = opened.patent.books.find((book) => book.kind === "claims")!;
      const first = claims.document.content[0];
      if (!first || first.type !== "paragraph") throw new Error("claims paragraph fixture missing");
      const document = {
        ...claims.document,
        content: [
          {
            ...first,
            content: [
              { type: "text" as const, text: "1. 迁移后继续编辑并保存的虚构装置。", marks: [] },
            ],
          },
        ],
      };
      const saved = await window.patentApi.patents.applyBookEdit({
        patentId,
        sessionId: opened.sessionId,
        bookKind: "claims",
        expectedRevision: opened.revision,
        document,
        editorState: { selection: { anchor: 1, head: 1 } },
        assets: opened.patent.assets,
      });
      if (!saved.ok) throw new Error(saved.error.code);
      const flush = await window.patentApi.patents.flush({
        patentId,
        expectedRevision: saved.value.revision,
      });
      if (!flush.ok) throw new Error(flush.error.code);
      await window.patentApi.patents.release(opened.sessionId);
      return document;
    }, sourcePatent.patentId);
    await restored.application.close();
    running = undefined;
    const reopened = await workbench.launchProfile("baseline-target");
    running = reopened.application;
    const reopenedPage = await reopened.application.firstWindow();
    const reopenedDocument = await reopenedPage.evaluate(async (patentId) => {
      const opened = await window.patentApi.patents.open(patentId);
      if (!opened.ok) throw new Error(opened.error.code);
      const claims = opened.value.patent.books.find((book) => book.kind === "claims")!.document;
      await window.patentApi.patents.release(opened.value.sessionId);
      return claims;
    }, sourcePatent.patentId);
    expect(reopenedDocument).toEqual(modified);
    await reopened.application.evaluate(
      ({ dialog }, p) => {
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: p }),
        });
      },
      join(workbench.root, "baseline-reexport.zxwbackup"),
    );
    const reexport = await reopenedPage.evaluate(
      async ({ password, operationId }) => {
        const selected = await window.patentApi.dataTransfer.selectExportDestination();
        if (!selected.ok || !selected.value) throw new Error("reexport selection");
        return window.patentApi.dataTransfer.exportPackage({
          operationId,
          destinationSelectionId: selected.value.selectionId,
          password,
          passwordHint: null,
          passwordRecorded: true,
        });
      },
      { password: PASSWORD, operationId: randomUUID() },
    );
    expect(reexport).toMatchObject({ ok: true, value: { fullVerificationPassed: true } });
    expect(
      (await readdir(join(reopened.localAppData, APPLICATION_DATA_DIRECTORY))).filter((name) =>
        name.startsWith(".full-data-export-"),
      ),
    ).toEqual([]);
    console.log(
      "PASS: native baseline restore, restart validation, identical five-book model, continued editing persistence and verified re-export",
    );
    await reopened.application.close();
    running = undefined;

    const cancelTarget = await workbench.launchProfile("baseline-cancel-target");
    running = cancelTarget.application;
    await workbench.removeTransientProfileMarkers(cancelTarget);
    const cancelPage = await cancelTarget.application.firstWindow();
    await cancelTarget.application.evaluate(({ dialog }, p) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [p] }),
      });
    }, packagePath);
    const cancelOperation = randomUUID();
    const cancelPrepared = await cancelPage.evaluate(
      async ({ password, operationId }) => {
        const selected = await window.patentApi.dataTransfer.selectImportPackage();
        if (!selected.ok || !selected.value) throw new Error("cancel selection");
        return window.patentApi.dataTransfer.prepareImport({
          operationId,
          sourceSelectionId: selected.value.selectionId,
          password,
        });
      },
      { password: PASSWORD, operationId: cancelOperation },
    );
    expect(cancelPrepared).toMatchObject({ ok: true });
    const cancelled = await cancelPage.evaluate(
      (operationId) => window.patentApi.dataTransfer.cancel(operationId),
      cancelOperation,
    );
    expect(cancelled).toMatchObject({ ok: true });
    const blocked = await cancelPage.evaluate(() => window.patentApi.dataTransfer.inspectLibrary());
    expect(blocked).toMatchObject({ ok: true, value: { empty: true } });
    const retry = await cancelPage.evaluate(
      async ({ password, operationId }) => {
        const selected = await window.patentApi.dataTransfer.selectImportPackage();
        if (!selected.ok || !selected.value) throw new Error("retry selection");
        return window.patentApi.dataTransfer.prepareImport({
          operationId,
          sourceSelectionId: selected.value.selectionId,
          password,
        });
      },
      { password: PASSWORD, operationId: randomUUID() },
    );
    expect(retry).toMatchObject({ ok: true });
    // Simulate process exit after preview, bypassing normal shutdown cleanup.
    await cancelTarget.application.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
    running = undefined;
    const recoveredCancel = await workbench.launchProfile("baseline-cancel-target");
    running = recoveredCancel.application;
    const recoveredCancelPage = await recoveredCancel.application.firstWindow();
    expect(
      await recoveredCancelPage.evaluate(() => window.patentApi.dataTransfer.inspectLibrary()),
    ).toMatchObject({ ok: true, value: { empty: true } });
    const appFiles = await readdir(join(recoveredCancel.localAppData, APPLICATION_DATA_DIRECTORY));
    expect(
      appFiles.filter((name) => name.startsWith(".import-") || name.startsWith("data-import-")),
    ).toEqual([]);
    await recoveredCancel.application.close();
    running = undefined;
  } finally {
    await running?.close().catch(() => undefined);
  }
});
