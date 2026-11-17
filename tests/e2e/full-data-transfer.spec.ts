import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { APPLICATION_DATA_DIRECTORY } from "../../src/shared/branding.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import {
  COMPLETE_LIBRARY_PATENT_NAME,
  collectMachineSettings,
  collectTransferredLibrarySemantics,
  editTransferredClaim,
  seedCompleteLibrary,
} from "../fixtures/data-transfer/create-complete-library.js";
import { expect, test } from "./helpers/workbench.js";

const TRANSFER_PASSWORD = "虚构迁移密码-只用于自动化-2026";

async function closeIfRunning(application: ElectronApplication | undefined): Promise<void> {
  await application?.close().catch(() => undefined);
}

async function mainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const ready = await page
        .evaluate(
          () =>
            typeof (globalThis as unknown as { patentApi?: PatentApi }).patentApi?.settings
              ?.read === "function",
        )
        .catch(() => false);
      if (ready) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("main application window did not become ready");
}

async function fileSize(path: string): Promise<number> {
  return await stat(path).then((value) => value.size);
}

async function structuralArtifactNames(root: string): Promise<string[]> {
  return await readdir(root, { withFileTypes: true })
    .then((entries) =>
      entries.map((entry) => `${entry.isDirectory() ? "directory" : "file"}:${entry.name}`).sort(),
    )
    .catch((error: NodeJS.ErrnoException) => [`unavailable:${error.code ?? "unknown"}`]);
}

function stableJsonSha256(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function splitMachineSettings<T extends { welcomeCompleted: boolean }>(value: T) {
  const { welcomeCompleted, ...invariants } = value;
  return { welcomeCompleted, invariants };
}

test("moves a complete library to a fresh isolated profile", async ({ workbench }) => {
  test.setTimeout(240_000);
  const exchangeRoot = join(workbench.root, "exchange");
  await mkdir(exchangeRoot, { recursive: true });
  const scientificCsv = join(workbench.root, "虚构科学原始数据.csv");
  const packagePath = join(exchangeRoot, "虚构完整资料迁移.zxwbackup");
  const legacyDraftPatdocPath = join(workbench.root, "虚构健康历史草稿.patdoc");
  const patdocPath = join(exchangeRoot, "迁移后虚构专利.patdoc");
  const docxPath = join(exchangeRoot, "迁移后虚构专利.docx");
  const pdfPath = join(exchangeRoot, "迁移后虚构专利.pdf");
  await writeFile(scientificCsv, "时间,温度\n0,20\n1,23\n2,27\n", "utf8");

  let running: ElectronApplication | undefined;
  try {
    const source = await workbench.launchProfile("computer-a");
    running = source.application;
    await source.application.evaluate(
      ({ dialog }, paths) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [paths.csv] }),
        });
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: paths.legacyDraft }),
        });
      },
      { csv: scientificCsv, legacyDraft: legacyDraftPatdocPath },
    );
    const sourcePage = await mainWindow(source.application);
    await seedCompleteLibrary(sourcePage, {
      legacyDraftPatdocPath,
      legacyDraftRoot: join(source.userData, "drafts"),
    });
    const sourceTemplates = await sourcePage.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const settings = await api.settings.read();
      const opened = await api.patentTemplates.openEditor({ patentType: "invention" });
      if (!settings.ok || !opened.ok) throw new Error("template fixture unavailable");
      try {
        const slot = opened.value.catalog.invention.slots[0];
        if (!slot) throw new Error("template slot unavailable");
        slot.name = "虚构迁移自定义模板";
        slot.claims = settings.value.patentTemplates.invention.claims;
        slot.description = settings.value.patentTemplates.invention.description;
        slot.abstract = settings.value.patentTemplates.invention.abstract;
        opened.value.catalog.invention.selection = { kind: "custom", templateId: slot.templateId };
        opened.value.auxiliary.invention.drawingLegend.content = [
          { type: "text", text: "虚构辅助模板内容", marks: [] },
        ];
        const saved = await api.patentTemplates.saveEditor({
          sessionId: opened.value.sessionId,
          expectedRevision: opened.value.catalog.revision,
          catalog: opened.value.catalog,
          auxiliary: opened.value.auxiliary,
        });
        if (!saved.ok) throw new Error(`template save failed: ${saved.error.code}`);
        return { catalog: saved.value.catalog, auxiliary: saved.value.auxiliary };
      } finally {
        await api.patentTemplates.closeEditor({ sessionId: opened.value.sessionId });
      }
    });
    const sourceSemantics = await collectTransferredLibrarySemantics(sourcePage);
    expect(sourceSemantics.library.drafts).toHaveLength(1);
    expect(sourceSemantics.library.drafts[0]).toMatchObject({
      summary: { documentId: expect.any(String) },
      document: {
        documentId: sourceSemantics.library.drafts[0]?.summary.documentId,
        title: COMPLETE_LIBRARY_PATENT_NAME,
      },
    });
    const sourceMachineSettings = splitMachineSettings(sourceSemantics.machineSettings);
    const sourceDigests = {
      library: stableJsonSha256(sourceSemantics.library),
      portableSettings: stableJsonSha256(sourceSemantics.portableSettings),
      machineSettings: stableJsonSha256(sourceMachineSettings.invariants),
    };
    await source.application.evaluate(({ dialog }, outputPath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath: outputPath }),
      });
    }, packagePath);
    const exported = await sourcePage.evaluate(
      async ({ operationId, password }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const phases: string[] = [];
        const unsubscribe = api.dataTransfer.onProgress((progress) => phases.push(progress.phase));
        const selected = await api.dataTransfer.selectExportDestination();
        if (!selected.ok || !selected.value) {
          throw new Error(
            `select export failed: ${selected.ok ? "cancelled" : selected.error.code}`,
          );
        }
        try {
          const result = await api.dataTransfer.exportPackage({
            operationId,
            destinationSelectionId: selected.value.selectionId,
            password,
            passwordHint: "虚构自动化密码提示",
            passwordRecorded: true,
          });
          if (!result.ok) {
            throw new Error(
              `export package failed: ${result.error.code}; phases=${phases.join(",")}`,
            );
          }
          return result;
        } finally {
          unsubscribe();
        }
      },
      { operationId: randomUUID(), password: TRANSFER_PASSWORD },
    );
    expect(exported).toMatchObject({
      ok: true,
      value: { fullVerificationPassed: true, packageFormatVersion: 2 },
    });
    expect(await fileSize(packagePath)).toBeGreaterThan(0);
    expect((await readdir(exchangeRoot)).filter((name) => name.endsWith(".partial"))).toEqual([]);
    await source.application.close();
    running = undefined;

    const targetBeforeImport = await workbench.launchProfile("computer-b");
    running = targetBeforeImport.application;
    const targetPage = await mainWindow(targetBeforeImport.application);
    targetPage.setDefaultTimeout(10_000);
    // Preload API availability precedes createMainWindow/loadURL completion.
    // Wait for the rendered shell before refreshing its one-shot welcome check.
    await targetPage.getByRole("button", { name: "文件", exact: true }).waitFor();
    await targetPage.waitForLoadState("load");
    await workbench.removeTransientProfileMarkers(targetBeforeImport);
    // Re-run welcome inspection after removing only the harness's own debug markers.
    await test.step("welcome offers recovery and confirms an empty library", async () => {
      await targetBeforeImport.application.evaluate(({ BaseWindow }) => {
        const window = BaseWindow.getAllWindows()[0] as import("electron").BrowserWindow;
        if (!window) throw new Error("main window unavailable");
        window.webContents.reload();
      });
      await targetPage.getByRole("button", { name: "已有完整数据包？从旧电脑恢复" }).click();
      const welcomeImport = targetPage.getByRole("dialog", { name: "完整数据迁移" });
      await welcomeImport.getByRole("button", { name: "导入完整数据包", exact: true }).click();
      await expect(welcomeImport.getByRole("heading", { name: "当前专利库为空" })).toBeVisible();
      await welcomeImport.getByRole("button", { name: "关闭完整数据迁移" }).click();
    });
    const targetInspection = await targetPage.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      return await api.dataTransfer.inspectLibrary();
    });
    if (!targetInspection.ok || !targetInspection.value.empty) {
      const artifacts = {
        library: await structuralArtifactNames(targetBeforeImport.libraryRoot),
        userData: await structuralArtifactNames(targetBeforeImport.userData),
        applicationData: await structuralArtifactNames(
          join(targetBeforeImport.localAppData, APPLICATION_DATA_DIRECTORY),
        ),
      };
      throw new Error(
        `target empty-library inspection failed: blockers=${JSON.stringify(
          targetInspection.ok ? targetInspection.value.blockers : [targetInspection.error.code],
        )}; structuralArtifacts=${JSON.stringify(artifacts)}`,
      );
    }
    expect(targetInspection.value.blockers).toEqual([]);
    const targetMachineSettingsBeforeImport = await collectMachineSettings(targetPage);
    const targetMachineSettingsBeforeImportSplit = splitMachineSettings(
      targetMachineSettingsBeforeImport,
    );
    const targetMachineSettingsBeforeImportDigest = stableJsonSha256(
      targetMachineSettingsBeforeImportSplit.invariants,
    );
    await targetBeforeImport.application.evaluate(({ app, dialog }, inputPath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [inputPath] }),
      });
      Object.defineProperty(dialog, "showErrorBox", {
        configurable: true,
        value: (title: string, content: string) => {
          console.error("Import recovery error", title, content);
        },
      });
      // The product still requests a relaunch. The harness suppresses only Electron's
      // untracked child launch, then starts the same isolated profile explicitly below.
      Object.defineProperty(app, "relaunch", {
        configurable: true,
        value: () => undefined,
      });
    }, packagePath);
    const closedAfterCommit = new Promise<void>((resolve) => {
      targetBeforeImport.application.once("close", () => resolve());
    });
    const prepared = await targetPage.evaluate(
      async ({ operationId, password }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const phases: string[] = [];
        const unsubscribe = api.dataTransfer.onProgress((progress) => phases.push(progress.phase));
        const selected = await api.dataTransfer.selectImportPackage();
        if (!selected.ok || !selected.value) {
          throw new Error(
            `select import failed: ${selected.ok ? "cancelled" : selected.error.code}`,
          );
        }
        try {
          const preview = await api.dataTransfer.prepareImport({
            operationId,
            sourceSelectionId: selected.value.selectionId,
            password,
          });
          if (!preview.ok) {
            throw new Error(
              `prepare import failed: ${preview.error.code}; phases=${phases.join(",")}`,
            );
          }
          if (!preview.value.packageVerified || !preview.value.targetLibraryEmpty) {
            throw new Error("import preview did not verify an empty target");
          }
          return { preview: preview.value, operationId };
        } finally {
          unsubscribe();
        }
      },
      { operationId: randomUUID(), password: TRANSFER_PASSWORD },
    );
    expect(prepared.preview.settingsRequiringSetup).toEqual([
      "backup-folder",
      "ai-credentials",
      "printer",
    ]);
    const commit = await targetPage
      .evaluate(async (operationId) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        return await api.dataTransfer.commitImport({
          operationId,
          acknowledgedEmptyLibraryAndRestart: true,
        });
      }, prepared.operationId)
      .catch((error: unknown) => {
        // A successful committed swap can close the renderer before its IPC reply is delivered.
        // The durable journal and full restarted-library assertions below remain mandatory.
        if (!targetPage.isClosed()) throw error;
        return null;
      });
    if (commit !== null) expect(commit).toEqual({ ok: true, value: { restartPending: true } });
    await closedAfterCommit;
    running = undefined;

    const importJournalPath = join(
      targetBeforeImport.localAppData,
      APPLICATION_DATA_DIRECTORY,
      "pending-data-import.json",
    );
    await expect
      .poll(
        async () => {
          try {
            const journal = JSON.parse(await readFile(importJournalPath, "utf8")) as {
              phase?: unknown;
            };
            return journal.phase;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code ?? "unreadable";
          }
        },
        {
          message: "closed import process must leave restart validation pending",
          timeout: 5_000,
        },
      )
      .toBe("restart-validation-pending");

    const targetAfterImport = await workbench.launchProfile("computer-b");
    running = targetAfterImport.application;
    const importedPage = await mainWindow(targetAfterImport.application);
    const startupRecovery = await importedPage.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const result = await api.application.getStartupRecoveryReport?.();
      return result ?? null;
    });
    expect(startupRecovery).toMatchObject({
      ok: true,
      value: { mode: "read-write", dataImportRecovery: "recovered" },
    });
    const recoveryStatus = importedPage.getByRole("status", { name: "完整数据迁移完成" });
    await expect(recoveryStatus).toContainText("启动后的二次完整性验证通过");
    await recoveryStatus.getByRole("button", { name: "稍后设置" }).click();

    // This E2E isolates two complete app profiles and library roots.
    expect(source.userData).not.toBe(targetAfterImport.userData);
    expect(source.localAppData).not.toBe(targetAfterImport.localAppData);
    expect(source.libraryRoot).not.toBe(targetAfterImport.libraryRoot);
    expect(targetBeforeImport.userData).toBe(targetAfterImport.userData);
    expect(targetBeforeImport.localAppData).toBe(targetAfterImport.localAppData);
    expect(targetBeforeImport.libraryRoot).toBe(targetAfterImport.libraryRoot);

    const targetSemantics = await collectTransferredLibrarySemantics(importedPage);
    expect(targetSemantics.library.drafts).toHaveLength(1);
    expect(targetSemantics.library.drafts[0]?.document.documentId).toBe(
      targetSemantics.library.drafts[0]?.summary.documentId,
    );
    const targetMachineSettingsAfterImport = splitMachineSettings(targetSemantics.machineSettings);
    expect(stableJsonSha256(targetSemantics.library)).toBe(sourceDigests.library);
    expect(stableJsonSha256(targetSemantics.portableSettings)).toBe(sourceDigests.portableSettings);
    expect(stableJsonSha256(targetMachineSettingsAfterImport.invariants)).toBe(
      targetMachineSettingsBeforeImportDigest,
    );
    expect(targetMachineSettingsBeforeImportDigest).not.toBe(sourceDigests.machineSettings);
    expect(sourceMachineSettings.welcomeCompleted).toBe(true);
    expect(targetMachineSettingsBeforeImportSplit.welcomeCompleted).toBe(false);
    // Successful recovery completes the target's first-run onboarding locally; this
    // true value is a product transition, not the source setting being transferred.
    expect(targetMachineSettingsAfterImport.welcomeCompleted).toBe(true);
    const importedTemplates = await importedPage.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const opened = await api.patentTemplates.openEditor({ patentType: "invention" });
      if (!opened.ok) throw new Error(`imported templates unavailable: ${opened.error.code}`);
      try {
        return { catalog: opened.value.catalog, auxiliary: opened.value.auxiliary };
      } finally {
        await api.patentTemplates.closeEditor({ sessionId: opened.value.sessionId });
      }
    });
    expect(importedTemplates).toEqual(sourceTemplates);

    const edited = await editTransferredClaim(importedPage);
    await targetAfterImport.application.close();
    running = undefined;

    const reopenedTarget = await workbench.launchProfile("computer-b");
    running = reopenedTarget.application;
    const reopenedPage = await mainWindow(reopenedTarget.application);
    const reopenedClaimContainsEdit = await reopenedPage.evaluate(
      async ({ patentId }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const opened = await api.patents.open(patentId);
        if (!opened.ok) throw new Error(`patents.open reopened failed: ${opened.error.code}`);
        try {
          const claims = opened.value.patent.books.find((book) => book.kind === "claims");
          return (
            claims?.document.content
              .flatMap((block) => (block.type === "paragraph" ? block.content : []))
              .map((node) => (node.type === "text" ? node.text : ""))
              .join("")
              .includes("保存后追加虚构校验特征") ?? false
          );
        } finally {
          await api.patents.release(opened.value.sessionId);
        }
      },
      { patentId: edited.patentId },
    );
    expect(reopenedClaimContainsEdit).toBe(true);

    await reopenedTarget.application.evaluate(
      ({ dialog }, outputPaths) => {
        const pending = [...outputPaths];
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => {
            const filePath = pending.shift();
            if (!filePath) throw new Error("unexpected extra export dialog");
            return { canceled: false, filePath };
          },
        });
      },
      [patdocPath, docxPath, pdfPath],
    );
    const postMigrationExports = await reopenedPage.evaluate(
      async ({ patentId, patentName }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const opened = await api.patents.open(patentId);
        if (!opened.ok) throw new Error(`patents.open export failed: ${opened.error.code}`);
        try {
          const request = {
            sessionId: opened.value.sessionId,
            patentId,
            expectedRevision: opened.value.revision,
            mode: "combined" as const,
            suggestedName: patentName,
          };
          return {
            patdoc: await api.patents.exportPatdoc({
              patentId,
              expectedRevision: opened.value.revision,
            }),
            docx: await api.exports.patentDocx(request),
            pdf: await api.exports.patentPdf(request),
          };
        } finally {
          await api.patents.release(opened.value.sessionId);
        }
      },
      { patentId: edited.patentId, patentName: COMPLETE_LIBRARY_PATENT_NAME },
    );
    expect(postMigrationExports.patdoc).toMatchObject({ ok: true });
    expect(postMigrationExports.docx).toMatchObject({ ok: true });
    expect(postMigrationExports.pdf).toMatchObject({ ok: true });
    expect(await fileSize(patdocPath)).toBeGreaterThan(0);
    expect((await readFile(docxPath)).subarray(0, 2).toString("ascii")).toBe("PK");
    expect((await readFile(pdfPath)).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const secondPackagePath = join(exchangeRoot, "迁移后再次完整导出.zxwbackup");
    await reopenedTarget.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, secondPackagePath);
    const reexported = await reopenedPage.evaluate(
      async ({ operationId, password }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const selected = await api.dataTransfer.selectExportDestination();
        if (!selected.ok || !selected.value) throw new Error("reexport selection failed");
        return await api.dataTransfer.exportPackage({
          operationId,
          destinationSelectionId: selected.value.selectionId,
          password,
          passwordHint: null,
          passwordRecorded: true,
        });
      },
      { operationId: randomUUID(), password: TRANSFER_PASSWORD },
    );
    expect(reexported).toMatchObject({ ok: true, value: { fullVerificationPassed: true } });
    expect(await fileSize(secondPackagePath)).toBeGreaterThan(0);
  } finally {
    await closeIfRunning(running);
  }
});
