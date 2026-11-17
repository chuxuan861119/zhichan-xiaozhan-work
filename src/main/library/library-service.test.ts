import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { LibraryService } from "./library-service.js";

const roots: string[] = [];
const databases: LibraryDatabase[] = [];

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-library-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openService(now: { value: Date }) {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let uuid = 100;
  const service = new LibraryService({
    database: prepared.database,
    now: () => now.value,
    randomUUID: () => testUuid(uuid++),
  });
  return { database: prepared.database, service };
}

async function addVisibleText(
  service: LibraryService,
  opened: Awaited<ReturnType<LibraryService["create"]>>,
  text = "正文",
  operationId = testUuid(800),
) {
  const paragraph = opened.document.content[0];
  expect(paragraph?.type).toBe("paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("fixture");
  return await service.applyEdit({
    libraryDocumentId: opened.libraryDocumentId,
    sessionId: opened.sessionId,
    operationId,
    baseRevision: 0,
    targetRevision: 1,
    modelVersion: 1,
    operations: [
      {
        type: "put-block",
        index: 0,
        block: {
          ...paragraph,
          content: [{ type: "text", text, marks: [] }],
        },
      },
    ],
    editorState: {},
  });
}

test.skip("hides blank active documents until they contain visible content", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create("空白文档");

  expect(await service.list("active")).toEqual([]);

  await addVisibleText(service, created);
  expect(await service.list("active")).toMatchObject([
    { libraryDocumentId: created.libraryDocumentId, title: "空白文档", revision: 1 },
  ]);
});

test.skip("permanently removes a blank document after its last lease is released", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create("关闭即丢弃");

  await service.release(created.sessionId);

  expect(await service.list("active")).toEqual([]);
  expect(await service.list("trash")).toEqual([]);
  await expect(service.open(created.libraryDocumentId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test.skip("keeps a blank document until every lease is released", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create("双会话空白");
  const second = await service.open(created.libraryDocumentId);

  await service.release(created.sessionId);
  const stillOpen = await service.open(created.libraryDocumentId);
  await service.release(stillOpen.sessionId);

  await service.release(second.sessionId);
  await expect(service.open(created.libraryDocumentId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test.skip("keeps a nonblank document after its last lease is released", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create("保留正文");
  await addVisibleText(service, created);

  await service.release(created.sessionId);

  expect(await service.list("active")).toMatchObject([
    { libraryDocumentId: created.libraryDocumentId, revision: 1 },
  ]);
});

test.skip("creates, lists, opens and renames documents with main-generated leases", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);

  const created = await service.create("未命名文档 2026-08-01 09-00-00");
  expect(created.revision).toBe(0);
  expect(created.saveState).toBe("saved");
  expect(created.sessionId).not.toBe(created.libraryDocumentId);
  expect(created.document.documentId).not.toBe(created.libraryDocumentId);
  await addVisibleText(service, created);

  expect(await service.list("active")).toMatchObject([
    {
      libraryDocumentId: created.libraryDocumentId,
      title: "未命名文档 2026-08-01 09-00-00",
      revision: 1,
      saveState: "saved",
      deletedAt: null,
      recoveryState: "healthy",
    },
  ]);

  const opened = await service.open(created.libraryDocumentId);
  expect(opened.sessionId).not.toBe(created.sessionId);
  expect(opened.document.title).toBe(created.document.title);

  const ack = await service.rename({
    libraryDocumentId: created.libraryDocumentId,
    operationId: testUuid(500),
    expectedRevision: 1,
    title: "改名后的文档",
  });

  expect(ack.revision).toBe(2);
  expect((await service.open(created.libraryDocumentId)).document.title).toBe("改名后的文档");
  expect((await service.list("active"))[0]).toMatchObject({
    title: "改名后的文档",
    revision: 2,
  });
});

test.skip("rejects created titles that cannot be represented in library summaries", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);

  await expect(service.create("题".repeat(256))).rejects.toThrow();
  expect(await service.list("active")).toEqual([]);
});

test.skip("serializes concurrent writes across documents", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const first = await service.create("第一件");
  const second = await service.create("第二件");

  await Promise.all([
    service.rename({
      libraryDocumentId: first.libraryDocumentId,
      operationId: testUuid(501),
      expectedRevision: 0,
      title: "第一件-改",
    }),
    service.rename({
      libraryDocumentId: second.libraryDocumentId,
      operationId: testUuid(502),
      expectedRevision: 0,
      title: "第二件-改",
    }),
  ]);

  expect(
    database.read((raw) =>
      raw.prepare("SELECT library_document_id, target_revision FROM edit_log ORDER BY rowid").all(),
    ),
  ).toEqual([
    { library_document_id: first.libraryDocumentId, target_revision: 1 },
    { library_document_id: second.libraryDocumentId, target_revision: 1 },
  ]);
});

test.skip("moves to trash, restores and permanently deletes only released trashed documents", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create("回收站文档");
  await service.moveToTrash(created.libraryDocumentId);

  expect(await service.list("active")).toEqual([]);
  expect(await service.list("trash")).toMatchObject([
    { libraryDocumentId: created.libraryDocumentId, deletedAt: now.value.toISOString() },
  ]);
  await expect(
    service.rename({
      libraryDocumentId: created.libraryDocumentId,
      operationId: testUuid(503),
      expectedRevision: 0,
      title: "不应改名",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  await expect(service.permanentlyDelete(created.libraryDocumentId)).rejects.toMatchObject({
    code: "LIBRARY_LOCKED",
  });

  await service.release(created.sessionId);
  await service.restore(created.libraryDocumentId);
  expect(await service.list("trash")).toEqual([]);

  await service.moveToTrash(created.libraryDocumentId);
  await service.permanentlyDelete(created.libraryDocumentId);
  expect(await service.list("trash")).toEqual([]);
  await expect(service.open(created.libraryDocumentId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("purges at the exact one-year boundary while skipping leased documents", async () => {
  const now = { value: new Date("2026-08-01T00:00:00.000Z") };
  const { service } = await openService(now);
  const released = await service.create("可清理");
  const leased = await service.create("仍打开");
  await addVisibleText(service, released, "可清理正文");
  await addVisibleText(service, leased, "仍打开正文", testUuid(801));
  await service.release(released.sessionId);
  await service.moveToTrash(released.libraryDocumentId);
  await service.moveToTrash(leased.libraryDocumentId);

  now.value = new Date("2027-07-31T23:59:59.999Z");
  expect(await service.purgeExpired()).toEqual({ purgedDocumentIds: [] });
  expect(await service.list("trash")).toHaveLength(2);

  now.value = new Date("2027-08-01T00:00:00.000Z");
  expect(await service.purgeExpired()).toEqual({
    purgedDocumentIds: [released.libraryDocumentId],
  });
  expect(await service.list("trash")).toMatchObject([
    { libraryDocumentId: leased.libraryDocumentId },
  ]);
});
