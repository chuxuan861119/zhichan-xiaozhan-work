import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { createLibraryRuntime, type LibraryRuntimePreparationError } from "./library-runtime.js";
import { PatentHistoryDeletion } from "./patent-history-deletion.js";
import { V8_MIGRATION_STATEMENTS } from "./schema.js";
import { TrashPurgeScheduler } from "./trash-purge-scheduler.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createLibraryRuntime", () => {
  test("close snapshots reuse verified resources and still reject corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-snapshot-verification-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    try {
      const opened = await runtime.patents.create({
        patentType: "invention",
        name: "按需资源",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      });
      const bytes = new Uint8Array([1, 2, 3]);
      const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
      const installed = await runtime.assetStore.install(
        { kind: "patent", patentId: opened.patentId },
        {
          descriptor: {
            assetId: randomUUID(),
            kind: "image",
            originalName: "test.png",
            mediaType: "image/png",
            extension: "png",
            widthPx: 1,
            heightPx: 1,
            byteLength: bytes.length,
            sha256: hash,
            previewByteLength: bytes.length,
            previewSha256: hash,
          },
          original: bytes,
          preview: bytes,
        },
      );
      await runtime.patents.applyBookEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        expectedRevision: 0,
        bookKind: "description",
        document: {
          ...opened.patent.books.find((b) => b.kind === "description")!.document,
          content: [{
            id: randomUUID(),
            type: "chemical-structure",
            ketSource: "(ket) (atom C)",
            previewAssetId: installed.descriptor.assetId,
            widthMm: 80,
            alignment: "center",
          }],
        },
        editorState: {},
        assets: [installed.descriptor],
      });
      const reads = vi.spyOn(runtime.assetStore, "readAsset");
      await runtime.snapshots.create(opened.patentId, "patent-close");
      expect((await runtime.snapshots.create(opened.patentId, "patent-close")).outcome).toBe(
        "already-exists",
      );
      expect(reads).not.toHaveBeenCalled();
      const path = join(root, "assets", `${hash}.asset`);
      const corrupted = readFileSync(path);
      corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
      writeFileSync(path, corrupted);
      await expect(runtime.snapshots.create(opened.patentId, "patent-close")).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });
  test("clears interrupted orphan cleanup on reopening, but never mutates assets in read-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-orphan-reopen-"));
    roots.push(root);
    const options = {
      libraryRoot: join(root, "library"),
      userDataRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    };
    let runtime = await createLibraryRuntime(options);
    try {
      const patent = await runtime.patents.create({
        patentType: "invention",
        name: "资源清理",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      });
      const bytes = new Uint8Array([1, 2, 3]);
      const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
      const installed = await runtime.assetStore.install(
        { kind: "patent", patentId: patent.patentId },
        {
          descriptor: {
            assetId: randomUUID(),
            kind: "image",
            originalName: "test.png",
            mediaType: "image/png",
            extension: "png",
            widthPx: 1,
            heightPx: 1,
            byteLength: bytes.length,
            sha256: hash,
            previewByteLength: bytes.length,
            previewSha256: hash,
          },
          original: bytes,
          preview: bytes,
        },
      );
      const file = join(options.libraryRoot, "assets", `${hash}.asset`);
      // Simulate shutdown after owner deletion but before the resource cleanup can run.
      runtime.database.transaction((raw) =>
        raw.prepare("DELETE FROM patents WHERE patent_id = ?").run(patent.patentId),
      );
      await runtime.close();
      runtime = await createLibraryRuntime({ ...options, readOnly: true });
      expect(existsSync(file)).toBe(true);
      expect((await runtime.assetStore.readAsset(installed.descriptor.assetId)).original).toEqual(
        bytes,
      );
      await runtime.close();
      runtime = await createLibraryRuntime(options);
      expect(existsSync(file)).toBe(false);
      expect(
        runtime.database.read((raw) => raw.prepare("SELECT asset_id FROM assets").all()),
      ).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
  test("opens writable library and reports pending history cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-history-warning-"));
    roots.push(root);
    const id = "11111111-1111-4111-8111-111111111111";
    const reconcile = vi.spyOn(PatentHistoryDeletion.prototype, "reconcile").mockReturnValue([id]);
    try {
      const runtime = await createLibraryRuntime({
        libraryRoot: root,
        userDataRoot: root,
        readOnly: false,
        runRecovery: false,
        startBackgroundSchedulers: false,
      });
      try {
        expect(runtime.readOnly).toBe(false);
        expect(runtime.recoveryReport.historyCleanupPendingPatentIds).toEqual([id]);
        expect(await runtime.patents.list("active")).toEqual([]);
      } finally {
        await runtime.close();
      }
    } finally {
      reconcile.mockRestore();
    }
  });
  test("reconciles interrupted history deletion when reopening the writable runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-history-reopen-"));
    roots.push(root);
    const options = {
      libraryRoot: join(root, "library"),
      userDataRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    };
    let runtime = await createLibraryRuntime(options);
    try {
      const patent = await runtime.patents.create({
        patentType: "invention",
        name: "reopen",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      });
      const historyRoot = join(root, "text-polish-history");
      const history = join(historyRoot, patent.patentId);
      const pending = join(historyRoot, `.pending-delete-${patent.patentId}`);
      mkdirSync(history, { recursive: true });
      writeFileSync(join(history, "draft-new.json"), "draft");
      await runtime.patents.release(patent.sessionId);
      await runtime.patents.moveToTrash(patent.patentId);
      await runtime.close();
      renameSync(history, pending);
      runtime = await createLibraryRuntime(options);
      expect(existsSync(join(history, "draft-new.json"))).toBe(true);
      runtime.database.transaction((raw) =>
        raw.prepare("DELETE FROM patents WHERE patent_id = ?").run(patent.patentId),
      );
      await runtime.close();
      renameSync(history, pending);
      runtime = await createLibraryRuntime(options);
      expect(existsSync(pending)).toBe(false);
      expect(existsSync(history)).toBe(false);
    } finally {
      await runtime.close();
    }
  });
  test("retains polish history for trash and leases, then removes it for permanent and expired deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-history-lifecycle-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: join(root, "library"),
      userDataRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    try {
      for (const mode of ["permanent", "expired"]) {
        const patent = await runtime.patents.create({
          patentType: "invention",
          name: mode,
          templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
        });
        const history = join(root, "text-polish-history", patent.patentId);
        mkdirSync(history, { recursive: true });
        writeFileSync(join(history, "draft-new.json"), "draft");
        if (mode === "permanent")
          await expect(runtime.patents.permanentlyDelete(patent.patentId)).rejects.toMatchObject({
            code: "LIBRARY_LOCKED",
          });
        else
          expect(await runtime.patents.purgeExpired(new Date("2100-01-01"))).toEqual({
            purgedPatentIds: [],
          });
        expect(existsSync(history)).toBe(true);
        await runtime.patents.release(patent.sessionId);
        await runtime.patents.moveToTrash(patent.patentId);
        expect(existsSync(history)).toBe(true);
        runtime.database.transaction((raw) =>
          raw
            .prepare("UPDATE patents SET deleted_at = ? WHERE patent_id = ?")
            .run(new Date(Date.now() - 86400000).toISOString(), patent.patentId),
        );
        if (mode === "permanent") await runtime.patents.permanentlyDelete(patent.patentId);
        else await runtime.patents.purgeExpired(new Date("2100-01-01"));
        expect(existsSync(history)).toBe(false);
      }
    } finally {
      await runtime.close();
    }
  });
  test("rolls history back with failed SQL deletion and retries without losing trash recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-history-rollback-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: join(root, "library"),
      userDataRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    try {
      const patent = await runtime.patents.create({
        patentType: "invention",
        name: "rollback",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      });
      const history = join(root, "text-polish-history", patent.patentId);
      mkdirSync(history, { recursive: true });
      writeFileSync(join(history, "draft-new.json"), "draft");
      await runtime.patents.release(patent.sessionId);
      await runtime.patents.moveToTrash(patent.patentId);
      runtime.database.transaction((raw) =>
        raw
          .prepare("UPDATE patents SET deleted_at = ? WHERE patent_id = ?")
          .run(new Date(Date.now() - 86400000).toISOString(), patent.patentId),
      );
      runtime.database.transaction((raw) =>
        raw.exec(
          "CREATE TRIGGER fail_history_delete BEFORE DELETE ON patents BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
        ),
      );
      await expect(runtime.patents.permanentlyDelete(patent.patentId)).rejects.toThrow(
        "injected failure",
      );
      expect(existsSync(join(history, "draft-new.json"))).toBe(true);
      expect(await runtime.patents.list("trash")).toHaveLength(1);
      runtime.database.transaction((raw) => raw.exec("DROP TRIGGER fail_history_delete"));
      await runtime.patents.permanentlyDelete(patent.patentId);
      expect(existsSync(history)).toBe(false);
    } finally {
      await runtime.close();
    }
  });
  test("creates the complete reusable plaintext service graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      readOnly: false,
      runRecovery: true,
      startBackgroundSchedulers: true,
    });

    expect(runtime.database.schemaVersion()).toBe(15);
    expect(runtime.recoveryReport.mode).toBe("read-write");
    expect(runtime.library).toBeDefined();
    expect(runtime.patents).toBeDefined();
    expect(runtime.snapshots).toBeDefined();
    expect(runtime.flowcharts).toBeDefined();

    await runtime.close();
    await runtime.close();
    expect(() => runtime.flowcharts.list("11111111-1111-4111-8111-111111111111")).toThrow(
      /disposed|closed/iu,
    );
    expect(() => runtime.flowchartSourceStore.list("11111111-1111-4111-8111-111111111111")).toThrow(
      /disposed|closed/iu,
    );
  });

  test("does not run recovery or start background mutation in read-only validation mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-readonly-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      readOnly: true,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    expect(runtime.readOnly).toBe(true);
    expect(runtime.recoveryReport.recoveredPatentIds).toEqual([]);
    await runtime.close();
  });

  test("search shutdown failure still drains the scheduler before closing the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-close-failure-"));
    roots.push(root);
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      userDataRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: true,
    });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSchedulerClose = runtime.backgroundScheduler.close.bind(runtime.backgroundScheduler);
    const schedulerClose = vi
      .spyOn(runtime.backgroundScheduler, "close")
      .mockImplementation(async () => {
        await pending;
        await realSchedulerClose();
      });
    if (!runtime.contentSearch) throw new Error("missing search service");
    const realSearchClose = runtime.contentSearch.close.bind(runtime.contentSearch);
    const searchClose = vi.spyOn(runtime.contentSearch, "close").mockImplementation(async () => {
      await realSearchClose();
      throw new Error("synthetic search shutdown failure");
    });
    const closeDatabase = vi.spyOn(runtime.database, "close");
    const closing = runtime.close();
    const assertion = expect(closing).rejects.toThrow("应用退出清理未完整完成。");
    await vi.waitFor(() => expect(schedulerClose).toHaveBeenCalledOnce());
    expect(closeDatabase).not.toHaveBeenCalled();
    release?.();
    await assertion;
    expect(closeDatabase).toHaveBeenCalledOnce();
    searchClose.mockRestore();
    schedulerClose.mockRestore();
  });

  test("does not start background schedulers when an explicit writable validation runtime disables them", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-no-background-"));
    roots.push(root);
    const start = vi.spyOn(TrashPurgeScheduler.prototype, "start");
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });

    expect(start).not.toHaveBeenCalled();
    await runtime.close();
    start.mockRestore();
  });

  test("preserves the missing database reason without creating or replacing library files", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-incomplete-"));
    roots.push(root);
    mkdirSync(join(root, "assets"));
    await expect(
      createLibraryRuntime({
        libraryRoot: root,
        readOnly: false,
        runRecovery: true,
        startBackgroundSchedulers: false,
      }),
    ).rejects.toMatchObject({
      name: "LibraryRuntimePreparationError",
      code: "LIBRARY_INITIALIZATION_FAILED",
      reason: "incomplete-library",
    });
    expect(existsSync(join(root, "library.sqlite3"))).toBe(false);
    expect(existsSync(join(root, "assets"))).toBe(true);
  });
  test("reports validation failure without replacing an unreadable database", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-validation-"));
    roots.push(root);
    const file = join(root, "library.sqlite3");
    const original = Buffer.from("not a sqlite database");
    writeFileSync(file, original);
    await expect(
      createLibraryRuntime({
        libraryRoot: root,
        readOnly: false,
        runRecovery: true,
        startBackgroundSchedulers: false,
      }),
    ).rejects.toMatchObject({
      name: "LibraryRuntimePreparationError",
      reason: "validation-failed",
    });
    expect(readFileSync(file)).toEqual(original);
  });

  test("refuses an old encrypted-schema library without replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-runtime-legacy-"));
    roots.push(root);
    const databasePath = join(root, "library.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    for (const statement of V8_MIGRATION_STATEMENTS) legacy.exec(statement);
    legacy
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("legacy-state", Buffer.from("legacy", "utf8"), "2026-08-20T00:00:00.000Z");
    legacy.close();

    await expect(
      createLibraryRuntime({
        libraryRoot: root,
        readOnly: false,
        runRecovery: true,
        startBackgroundSchedulers: false,
      }),
    ).rejects.toMatchObject({
      name: "LibraryRuntimePreparationError",
      code: "UNSUPPORTED_LIBRARY_SCHEMA",
      reason: "unsupported-schema",
    } satisfies Partial<LibraryRuntimePreparationError>);

    using probe = new DatabaseSync(databasePath, { readOnly: true });
    const row = probe
      .prepare("SELECT value FROM library_state WHERE key = ?")
      .get("legacy-state") as { value: Uint8Array };
    expect(Buffer.from(row.value).toString("utf8")).toBe("legacy");
  });
});

import { createHash, randomUUID } from "node:crypto";
