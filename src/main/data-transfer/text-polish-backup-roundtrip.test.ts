import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { TextPolishHistoryStore } from "../ai-correction/text-polish-history-store.js";
import { FileService } from "../documents/file-service.js";
import { DraftService } from "../drafts/draft-service.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { DataImportJournal } from "./data-import-journal.js";
import { DataImportRecoveryService } from "./data-import-recovery-service.js";
import { FullDataExportService } from "./full-data-export-service.js";
import { FullDataImportService } from "./full-data-import-service.js";
import { ImportStagingValidator } from "./import-staging-validator.js";
import { LibraryImportSwapCoordinator } from "./library-import-swap-coordinator.js";
import { TransferSourceHandle } from "./package-reader.js";

const roots: string[] = [];
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const password = "synthetic backup password 123456";
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "full encrypted backup restores polish state and replaces stale target history (has history: %s)",
  async (withHistory) => {
    const root = await mkdtemp(join(tmpdir(), "polish-backup-roundtrip-"));
    roots.push(root);
    const sourceLibrary = join(root, "source-library");
    const sourceUser = join(root, "source-user");
    const work = join(root, "work");
    const destination = join(root, "backup");
    await mkdir(work);
    await mkdir(destination);
    const source = await new LibraryMigrationService(sourceLibrary).prepare();
    if (source.status !== "ready") throw new Error("fixture source unavailable");
    const sourceHistory = new TextPolishHistoryStore(join(sourceUser, "text-polish-history"));
    if (withHistory) {
      sourceHistory.saveDraft(id, null, { text: "未发送的新草稿", presets: [] });
      sourceHistory.saveDraft(id, id, {
        text: "历史对话未发送草稿",
        presets: ["专业严谨"],
        referenceText: "待发送参考材料",
      });
      sourceHistory.activate(id, id);
      sourceHistory.save({
        conversationId: id,
        patentId: id,
        sessionId: id,
        bookKind: "description",
        conversationRevision: 0,
        source: { kind: "generation", requirement: "合成历史内容" },
        model: {
          profileId: id,
          providerId: "custom",
          displayName: "Synthetic",
          baseUrl: "https://example.com/v1",
          model: "synthetic",
        },
        messages: [
          {
            role: "user",
            messageId: randomUUID(),
            turnId: randomUUID(),
            text: "分析材料",
            referenceText: "已发送参考材料",
          },
        ],
        latestValidDraft: "已保存的修改稿",
        summary: null,
        activeTurn: null,
        lastTurnOutcome: null,
      });
      sourceHistory.rename(id, id, "需保留的会话名称");
      await writeFile(
        join(sourceUser, "text-polish-history", id, `active.json.unreadable-${id}`),
        "unreadable original",
      );
    }
    const finalPath = join(destination, "state.zxwbackup");
    try {
      await new FullDataExportService({
        applicationVersion: "0.1.0",
        database: source.database,
        libraryRoot: sourceLibrary,
        userDataRoot: sourceUser,
        workRoot: work,
        draftService: new DraftService(join(sourceUser, "drafts")),
        fileService: new FileService(),
        settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
        quiescence: { acquire: async () => ({ release: async () => {} }) },
      }).export({ operationId, finalPath, password, passwordHint: null, passwordRecorded: true });
    } finally {
      source.database.close();
    }

    const libraryRoot = join(root, "target-library");
    const userDataRoot = join(root, "target-user");
    const applicationDataRoot = join(root, "target-app");
    const target = await new LibraryMigrationService(libraryRoot).prepare();
    if (target.status !== "ready") throw new Error("fixture target unavailable");
    await mkdir(applicationDataRoot);
    await mkdir(join(userDataRoot, "drafts"), { recursive: true });
    await writeFile(join(userDataRoot, "settings.json"), JSON.stringify(DEFAULT_APP_SETTINGS));
    const targetHistoryRoot = join(userDataRoot, "text-polish-history");
    new TextPolishHistoryStore(targetHistoryRoot).saveDraft(id, null, {
      text: "旧库残留，不得混入",
      presets: [],
    });
    const importer = new FullDataImportService({
      libraryRoot,
      userDataRoot,
      applicationDataRoot,
      inspector: { inspect: async () => ({ empty: true, blockers: [] }) },
      resolveSourceSelection: async (selectionId) => ({
        selectionId,
        sourceHandle: await TransferSourceHandle.open(finalPath),
      }),
      readCurrentSettings: async () => structuredClone(DEFAULT_APP_SETTINGS),
    });
    try {
      await importer.prepareImport({ operationId, sourceSelectionId: "synthetic", password });
      const lease = await importer.takePreparedImportLease(operationId);
      if (!lease) throw new Error("prepared lease missing");
      const journal = new DataImportJournal({ applicationDataRoot, libraryRoot, userDataRoot });
      const result = await new LibraryImportSwapCoordinator({
        libraryRoot,
        userDataRoot,
        applicationDataRoot,
        prepared: lease.prepared,
        lease,
        journal,
        ensureCurrentState: async () => {},
        inspectEmptyLibrary: async () => ({ empty: true, blockers: [] }),
        closeRuntime: async () => {
          target.database.close();
        },
        validateStaging: async (prepared) =>
          new ImportStagingValidator().validate(
            {
              installed: true,
              libraryRoot: prepared.stagingLibraryPath,
              userDataRoot: dirname(prepared.stagingDraftsPath),
              packageRoot: join(
                prepared.libraryStagingCapability.root,
                (await readdir(prepared.libraryStagingCapability.root)).find((name) =>
                  name.startsWith(".package-extract-"),
                ) ?? "missing-extraction",
              ),
              portableSettingsRoot: join(
                prepared.userDataStagingCapability.root,
                (await readdir(prepared.userDataStagingCapability.root)).find((name) =>
                  name.startsWith(".package-extract-"),
                ) ?? "missing-extraction",
              ),
              legacyDraftsRoot: prepared.stagingDraftsPath,
              ...(prepared.stagingPolishHistoryPath
                ? { polishHistoryRoot: prepared.stagingPolishHistoryPath }
                : {}),
              installedDatabaseIntegrity: {
                byteLength: Number(prepared.stagingDatabaseIntegrity.size),
                sha256: prepared.stagingDatabaseIntegrity.sha256,
              },
            },
            prepared.manifest,
          ),
      }).commit();
      expect(
        (
          await new DataImportRecoveryService({
            journal,
            libraryRoot,
            userDataRoot,
            applicationDataRoot,
          }).recover()
        ).status,
      ).toBe("recovered");
      await result.releaseHandoff.release();
      const restored = new TextPolishHistoryStore(targetHistoryRoot);
      if (withHistory) {
        expect(restored.draft(id, null).text).toBe("未发送的新草稿");
        expect(restored.draft(id, id).text).toBe("历史对话未发送草稿");
        expect(restored.draft(id, id).referenceText).toBe("待发送参考材料");
        expect(restored.snapshot(id, id)?.messages[0]).toMatchObject({
          referenceText: "已发送参考材料",
        });
        expect(restored.active(id)).toBe(id);
        expect(restored.snapshot(id, id)?.latestValidDraft).toBe("已保存的修改稿");
        expect((await restored.list(id))[0]?.title).toBe("需保留的会话名称");
        expect(
          await readFile(join(targetHistoryRoot, id, `active.json.unreadable-${id}`), "utf8"),
        ).toBe("unreadable original");
      } else expect(await readdir(targetHistoryRoot)).toEqual([]);
    } finally {
      target.database.close();
    }
  },
  30_000, // Native Windows ownership checks are part of this encrypted roundtrip.
);
