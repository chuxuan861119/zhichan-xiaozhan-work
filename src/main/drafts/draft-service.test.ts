import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { AppOperationError } from "../app-operation-error.js";
import type { FileService } from "../documents/file-service.js";
import type { PatdocPayload } from "../documents/patdoc-format.js";
import { DraftService } from "./draft-service.js";

const payload = (title: string): PatdocPayload => ({
  document: createBlankDocument(title),
  settings: {},
  editorState: {},
  assets: [],
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function legacyDraftFileService() {
  const saved = new Map<string, PatdocPayload>();
  return {
    saveDocument: vi.fn(async (path: string, input: PatdocPayload) => {
      saved.set(path, structuredClone(input));
      await writeFile(path, "legacy draft fixture");
      return {
        ok: true as const,
        value: {
          path,
          displayName: path.split(/[\\/]/u).at(-1) ?? path,
          savedAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
          previousVersionRetained: false,
        },
      };
    }),
    openDocument: vi.fn(async (path: string) => {
      const value = saved.get(path);
      if (!value) throw new Error("missing draft fixture");
      return { ok: true as const, value: structuredClone(value) };
    }),
  } as unknown as FileService;
}

describe("automatic draft storage", () => {
  let directory = "";
  let time = new Date("2026-07-31T14:05:06.000Z");
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patent-drafts-"));
    time = new Date("2026-07-31T14:05:06.000Z");
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  test("materializes an empty draft root before a destructive data import", async () => {
    const root = join(directory, "drafts");
    const service = new DraftService(root);

    await expect(service.ensureRoot()).resolves.toBeUndefined();
    await expect(readdir(root)).resolves.toEqual([]);
  });

  test("keeps only the newest verified generation and retains the original path", async () => {
    const service = new DraftService(directory, () => time, legacyDraftFileService());
    const first = payload("夹具");
    await service.save({
      documentId: first.document.documentId,
      displayName: "夹具.patdoc",
      originalPath: "D:\\案件\\夹具.patdoc",
      payload: first,
    });
    time = new Date("2026-07-31T14:06:07.000Z");
    const second = {
      ...payload("夹具第二版"),
      document: { ...payload("夹具第二版").document, documentId: first.document.documentId },
    };
    const summary = await service.save({
      documentId: first.document.documentId,
      displayName: "夹具.patdoc",
      originalPath: "D:\\案件\\夹具.patdoc",
      payload: second,
    });

    expect(summary.originalPath).toBe("D:\\案件\\夹具.patdoc");
    const files = await readdir(join(directory, first.document.documentId));
    expect(files.filter((name) => name.endsWith(".patdoc"))).toHaveLength(1);
    expect((await service.open(summary.draftId)).document.title).toBe("夹具第二版");
  });

  test("names an unnamed draft by time and deletes it only on explicit cleanup", async () => {
    const service = new DraftService(directory, () => time, legacyDraftFileService());
    const draft = payload("文档 1");
    const summary = await service.save({
      documentId: draft.document.documentId,
      displayName: "文档 1",
      originalPath: null,
      payload: draft,
    });
    expect(summary.displayName).toBe("未命名-20260731-220506");
    expect(await service.list()).toHaveLength(1);
    await service.delete(summary.draftId);
    expect(await service.list()).toEqual([]);
  });

  test("preserves actionable file failure codes from a failed draft save", async () => {
    const fileService = {
      saveDocument: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "DISK_FULL" as const,
          message: "磁盘空间不足。原文件没有被修改。",
          nextAction: "请释放空间后重试。",
        },
      })),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService);
    const draft = payload("空间不足");

    const operation = service.save({
      documentId: draft.document.documentId,
      displayName: "空间不足",
      originalPath: null,
      payload: draft,
    });

    await expect(operation).rejects.toBeInstanceOf(AppOperationError);
    await expect(operation).rejects.toMatchObject({ code: "DISK_FULL" });
  });

  test("waits through saves that start while the draft queue is draining", async () => {
    const firstPending = deferred();
    const secondPending = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let calls = 0;
    const fileService = {
      saveDocument: vi.fn(async (path: string) => {
        calls += 1;
        if (calls === 1) {
          firstStarted.resolve();
          await firstPending.promise;
        } else {
          secondStarted.resolve();
          await secondPending.promise;
        }
        return {
          ok: true as const,
          value: {
            path,
            displayName: "draft.patdoc",
            savedAt: time.toISOString(),
            previousVersionRetained: false,
          },
        };
      }),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService);
    const first = payload("第一份草稿");
    const second = payload("第二份草稿");
    const firstSave = service.save({
      documentId: first.document.documentId,
      displayName: "第一份草稿",
      originalPath: null,
      payload: first,
    });
    await firstStarted.promise;

    let idle = false;
    const drain = service.waitForIdle().then(() => {
      idle = true;
    });
    const secondSave = service.save({
      documentId: second.document.documentId,
      displayName: "第二份草稿",
      originalPath: null,
      payload: second,
    });
    await secondStarted.promise;

    firstPending.resolve();
    await firstSave;
    await Promise.resolve();
    expect(idle).toBe(false);

    secondPending.resolve();
    await secondSave;
    await drain;
    expect(idle).toBe(true);
  });

  test("remembers a handled save rejection until that document saves successfully", async () => {
    let fail = true;
    const secretPath = "D:\\客户\\绝密专利.patdoc";
    const fileService = {
      saveDocument: vi.fn(async (path: string) =>
        fail
          ? {
              ok: false as const,
              error: {
                code: "DISK_FULL" as const,
                message: `${secretPath} 无法保存`,
                nextAction: "释放空间",
              },
            }
          : {
              ok: true as const,
              value: {
                path,
                displayName: "draft.patdoc",
                savedAt: time.toISOString(),
                previousVersionRetained: false,
              },
            },
      ),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService);
    const draft = payload("保存失败");
    const input = {
      documentId: draft.document.documentId,
      displayName: "保存失败",
      originalPath: secretPath,
      payload: draft,
    };

    await service.save(input).catch(() => undefined);
    const firstFailure = await service.waitForIdle().catch((error: unknown) => error);
    expect(firstFailure).toMatchObject({ code: "SOURCE_SAVE_FAILED" });
    expect(String(firstFailure)).not.toContain(secretPath);
    expect(JSON.stringify(firstFailure)).not.toContain(draft.document.documentId);
    await expect(service.waitForIdle()).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });

    fail = false;
    await service.save(input);
    await expect(service.waitForIdle()).resolves.toBeUndefined();
  });

  test("clears a recorded save failure only after the draft directory is deleted", async () => {
    const fileService = {
      saveDocument: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "DISK_FULL" as const,
          message: "draft save failed",
          nextAction: "retry",
        },
      })),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService);
    const draft = payload("删除失败草稿");

    await service
      .save({
        documentId: draft.document.documentId,
        displayName: "删除失败草稿",
        originalPath: null,
        payload: draft,
      })
      .catch(() => undefined);
    await expect(service.waitForIdle()).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });

    await service.delete(draft.document.documentId);
    await expect(service.waitForIdle()).resolves.toBeUndefined();
  });

  test("keeps a recorded save failure when deleting its directory fails", async () => {
    const removeDraft = vi.fn(async () => Promise.reject(new Error("delete failed")));
    const fileService = {
      saveDocument: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "DISK_FULL" as const,
          message: "draft save failed",
          nextAction: "retry",
        },
      })),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService, removeDraft);
    const draft = payload("不可删除草稿");

    await service
      .save({
        documentId: draft.document.documentId,
        displayName: "不可删除草稿",
        originalPath: null,
        payload: draft,
      })
      .catch(() => undefined);

    await expect(service.delete(draft.document.documentId)).rejects.toThrow("delete failed");
    await expect(service.waitForIdle()).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  });

  test("does not clear a newer save failure that races with successful deletion", async () => {
    const deletionStarted = deferred();
    const finishDeletion = deferred();
    const removeDraft = vi.fn(async () => {
      deletionStarted.resolve();
      await finishDeletion.promise;
    });
    const fileService = {
      saveDocument: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "DISK_FULL" as const,
          message: "draft save failed",
          nextAction: "retry",
        },
      })),
    } as unknown as FileService;
    const service = new DraftService(directory, () => time, fileService, removeDraft);
    const draft = payload("竞态草稿");
    const input = {
      documentId: draft.document.documentId,
      displayName: "竞态草稿",
      originalPath: null,
      payload: draft,
    };
    await service.save(input).catch(() => undefined);

    const deletion = service.delete(draft.document.documentId);
    await vi.waitFor(() => expect(removeDraft).toHaveBeenCalledOnce());
    await deletionStarted.promise;
    await service.save(input).catch(() => undefined);
    finishDeletion.resolve();
    await deletion;

    await expect(service.waitForIdle()).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  });
});
