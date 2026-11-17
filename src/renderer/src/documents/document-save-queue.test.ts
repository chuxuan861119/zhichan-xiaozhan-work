import { createBlankDocument } from "../../../shared/document/defaults";
import type { CanonicalDocument } from "../../../shared/document/model";
import type { AppResult } from "../../../shared/ipc/result";
import type { LibraryEditBatch } from "../../../shared/library/edit-operations";
import type { LibraryEditAck } from "../../../shared/library/model";
import { DocumentSaveQueue } from "./document-save-queue";

const libraryDocumentId = "00000000-0000-4000-8000-000000000101";
const sessionId = "00000000-0000-4000-8000-000000000201";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function titled(document: CanonicalDocument, title: string): CanonicalDocument {
  return { ...document, title };
}

type ApplyEdit = (batch: LibraryEditBatch) => Promise<AppResult<LibraryEditAck>>;
type FlushRevision = (
  libraryDocumentId: string,
  revision: number,
) => Promise<AppResult<{ revision: number; flushedAt: string }>>;

function createQueue(
  options: {
    initialDocument?: CanonicalDocument;
    applyEdit?: ApplyEdit;
    flushRevision?: FlushRevision;
    onQueued?: (snapshot: ReturnType<DocumentSaveQueue["snapshot"]>) => void;
    onConfirmed?: (snapshot: ReturnType<DocumentSaveQueue["snapshot"]>) => void;
    onFailed?: (snapshot: ReturnType<DocumentSaveQueue["snapshot"]>) => void;
  } = {},
) {
  let uuid = 1;
  const applyEdit =
    options.applyEdit ??
    vi.fn(
      async (batch: LibraryEditBatch): Promise<AppResult<LibraryEditAck>> => ({
        ok: true as const,
        value: {
          libraryDocumentId: batch.libraryDocumentId,
          operationId: batch.operationId,
          revision: batch.targetRevision,
          savedAt: `2026-08-01T00:00:${String(batch.targetRevision).padStart(2, "0")}.000Z`,
        },
      }),
    );
  const flushRevision =
    options.flushRevision ??
    vi.fn(async (_libraryDocumentId: string, revision: number) => ({
      ok: true as const,
      value: {
        libraryDocumentId,
        revision,
        flushedAt: "2026-08-01T00:10:00.000Z",
      },
    }));
  const queue = new DocumentSaveQueue({
    libraryDocumentId,
    sessionId,
    initialDocument: options.initialDocument ?? createBlankDocument("文档 1"),
    initialRevision: 0,
    applyEdit,
    flushRevision,
    randomUUID: () => testUuid(uuid++),
    ...(options.onQueued ? { onQueued: options.onQueued } : {}),
    ...(options.onConfirmed ? { onConfirmed: options.onConfirmed } : {}),
    ...(options.onFailed ? { onFailed: options.onFailed } : {}),
  });
  return { queue, applyEdit, flushRevision };
}

describe("document save queue", () => {
  test("sends a burst of edits in revision order and reports saved only after acknowledgements", async () => {
    const confirmedRevisions: number[] = [];
    const { queue, applyEdit } = createQueue({
      onConfirmed: (snapshot) => confirmedRevisions.push(snapshot.persistedRevision),
    });

    let current = queue.snapshot().model;
    for (let index = 1; index <= 100; index += 1) {
      current = titled(current, `标题 ${index}`);
      queue.enqueue(current, { scrollTop: index });
    }

    expect(queue.snapshot()).toMatchObject({
      localRevision: 100,
      persistedRevision: 0,
      saveState: "saving",
    });

    await queue.flush();

    expect(applyEdit).toHaveBeenCalledTimes(100);
    for (const [index, call] of vi.mocked(applyEdit).mock.calls.entries()) {
      const batch = call[0];
      expect(batch.baseRevision).toBe(index);
      expect(batch.targetRevision).toBe(index + 1);
      expect(batch.operationId).toBe(testUuid(index + 1));
      expect(batch.operations).toEqual([{ type: "set-title", title: `标题 ${index + 1}` }]);
    }
    expect(confirmedRevisions).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(queue.snapshot()).toMatchObject({
      localRevision: 100,
      persistedRevision: 100,
      saveState: "saved",
      lastSavedAt: "2026-08-01T00:00:100.000Z",
    });
  });

  test("keeps the failed operation and retries the same operation id before later edits", async () => {
    const initialDocument = createBlankDocument("文档 1");
    const failedSnapshots: Array<ReturnType<DocumentSaveQueue["snapshot"]>> = [];
    const applyEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(async (batch: LibraryEditBatch) => ({
        ok: true as const,
        value: {
          libraryDocumentId,
          operationId: batch.operationId,
          revision: batch.targetRevision,
          savedAt: `2026-08-01T00:00:0${batch.targetRevision}.000Z`,
        },
      }));
    const { queue } = createQueue({
      initialDocument,
      applyEdit,
      onFailed: (snapshot) => failedSnapshots.push(snapshot),
    });

    const firstEdit = titled(initialDocument, "第一次");
    queue.enqueue(firstEdit);
    await expect(queue.flush()).rejects.toMatchObject({ code: "DISK_FULL" });

    const secondEdit = titled(firstEdit, "第二次");
    queue.enqueue(secondEdit);
    expect(queue.snapshot()).toMatchObject({
      model: secondEdit,
      localRevision: 2,
      persistedRevision: 0,
      saveState: "failed",
    });

    await queue.retry();
    await queue.flush();

    const calls = applyEdit.mock.calls.map(([batch]) => batch);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.operationId).toBe(calls[0]?.operationId);
    expect(calls[1]?.targetRevision).toBe(1);
    expect(calls[2]?.targetRevision).toBe(2);
    expect(queue.snapshot()).toMatchObject({
      localRevision: 2,
      persistedRevision: 2,
      saveState: "saved",
      model: secondEdit,
    });
    expect(failedSnapshots[0]).toMatchObject({ saveState: "failed", persistedRevision: 0 });
  });

  test("snapshot flush waits for queued edits and uses the persisted revision", async () => {
    const { queue, flushRevision } = createQueue();

    queue.enqueue(titled(queue.snapshot().model, "待刷盘"));
    await queue.flush({ snapshot: true });

    expect(flushRevision).toHaveBeenCalledWith(libraryDocumentId, 1);
    expect(queue.snapshot()).toMatchObject({ saveState: "saved", persistedRevision: 1 });
  });

  test("suppresses callbacks after disposal even when an in-flight save resolves", async () => {
    let finishSave: (() => void) | undefined;
    const onConfirmed = vi.fn();
    const applyEdit = vi.fn(
      (batch: LibraryEditBatch) =>
        new Promise<AppResult<LibraryEditAck>>((resolve) => {
          finishSave = () =>
            resolve({
              ok: true,
              value: {
                libraryDocumentId,
                operationId: batch.operationId,
                revision: batch.targetRevision,
                savedAt: "2026-08-01T00:00:01.000Z",
              },
            });
        }),
    );
    const { queue } = createQueue({ applyEdit, onConfirmed });

    queue.enqueue(titled(queue.snapshot().model, "关闭中的编辑"));
    queue.dispose();
    finishSave?.();
    await Promise.resolve();

    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
