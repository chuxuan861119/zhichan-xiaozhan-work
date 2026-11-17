import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { FlowchartService } from "../flowcharts/flowchart-service.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { createLibraryRuntime } from "./library-runtime.js";
import { PatentService } from "./patent-service.js";
import { LibraryRecoveryService } from "./recovery-service.js";
import { SnapshotService } from "./snapshot-service.js";

const roots: string[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(now = new Date("2026-08-01T11:01:00Z")) {
  const root = await mkdtemp(join(tmpdir(), "snapshot-audit-"));
  roots.push(root);
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("Fixture database did not open");
  const database = prepared.database;
  closers.push(() => database.close());
  const patents = new PatentService({ database, now: () => new Date("2026-08-01T09:00:00Z") });
  const created = await patents.create({
    patentType: "invention",
    name: "隔离快照故障审查",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const snapshots = new SnapshotService({
    database,
    now: () => now,
    readAssetPreview: async () => new Uint8Array(),
  });
  return { root, database, patents, created, snapshots };
}

test("existing damaged revision must not report snapshot success", async () => {
  const { database, created, snapshots } = await fixture();
  database.transaction((db) =>
    db
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ?")
      .run(Buffer.from("broken"), created.patentId),
  );
  await expect(snapshots.open(created.patentId)).rejects.toThrow();
  await expect(snapshots.create(created.patentId, "patent-close")).rejects.toThrow();
});

test("a delayed document snapshot does not capture or roll back concurrent flowchart saves", async () => {
  const { database, patents, created } = await fixture();
  const sourceStore = new FlowchartSourceStore({ database });
  const flowcharts = new FlowchartService({ database, sourceStore, patentService: patents });
  const oldSource = Buffer.from('<mxfile><diagram id="old"/></mxfile>');
  let project = await flowcharts.create({
    patentId: created.patentId,
    expectedPatentRevision: 0,
    name: "流程图",
    source: oldSource,
    pageCount: 1,
    lastPageId: "old",
  });
  const documentEdit = await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: project.patentRevision,
    name: "文档修改后的快照",
    patentType: "invention",
  });
  project = { ...project, patentRevision: documentEdit.revision };
  let resume!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const snapshots = new SnapshotService({
    database,
    readAssetPreview: async () => new Uint8Array(),
    collectUnusedFlowchartSources: async (id) => {
      sourceStore.collectUnreferenced(id);
    },
    worker: async (job) => {
      if (job.revision === documentEdit.revision) {
        started();
        await waiting;
      }
      return SnapshotService.createSnapshotPayload(job);
    },
  });
  const pending = snapshots.create(created.patentId, "manual-create");
  await ready;
  try {
    for (let index = 3; index <= 6; index += 1) {
      project = await flowcharts.save({
        patentId: created.patentId,
        projectId: project.project.projectId,
        expectedPatentRevision: project.patentRevision,
        expectedProjectRevision: project.project.revision,
        source: Buffer.from(`<mxfile><diagram id="p${index}"/></mxfile>`),
        pageCount: 1,
        lastPageId: `p${index}`,
      });
      await snapshots.create(created.patentId, "manual-create");
    }
  } finally {
    resume();
  }
  await expect(pending).resolves.toMatchObject({ revision: documentEdit.revision });
  expect(await snapshots.readFlowchartArchive(created.patentId, documentEdit.revision)).toEqual([]);
  expect(sourceStore.loadCurrent(created.patentId, project.project.projectId).source).toEqual(
    project.source,
  );
});

test("the last recovery snapshot cannot be deleted or quarantine a healthy patent on restart", async () => {
  const { database, created, snapshots } = await fixture();
  await expect(snapshots.delete(created.patentId, 0)).rejects.toMatchObject({
    code: "SNAPSHOT_RECOVERY_PROTECTED",
    message: expect.stringContaining("最后一个"),
  });
  expect(await snapshots.list(created.patentId)).toMatchObject([{ revision: 0, deletable: false }]);
  const recovery = new LibraryRecoveryService({ database });
  expect((await recovery.open()).quarantinedPatentIds).toEqual([]);
});

test.each(["lease", "worker"])(
  "failed creation releases source protection after %s failure",
  async (phase) => {
    const { database, patents, created } = await fixture();
    await patents.updateSettings({
      patentId: created.patentId,
      expectedRevision: 0,
      name: "新修订",
      patentType: "invention",
      referenceMarks: [],
      referenceMarkSettings: { synchronizedEditingEnabled: true },
    });
    const collect = vi.fn(async () => undefined);
    const snapshots = new SnapshotService({
      database,
      readAssetPreview: async () => new Uint8Array(),
      collectUnusedFlowchartSources: collect,
      leaseAssets: async () => {
        if (phase === "lease") throw new Error("lease failed");
        return () => undefined;
      },
      worker: () => {
        throw new Error("worker failed");
      },
    });
    await expect(snapshots.create(created.patentId, "manual-create")).rejects.toThrow(
      `${phase} failed`,
    );
    await snapshots.prunePatent(created.patentId);
    expect(collect).toHaveBeenCalledWith(created.patentId);
  },
);

test("resource cleanup failure after deletion reports a committed deletion with a warning", async () => {
  const { database, patents, created, snapshots } = await fixture();
  await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "新修订",
    patentType: "invention",
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });
  await snapshots.create(created.patentId, "manual-create");
  const failingCleanup = new SnapshotService({
    database,
    readAssetPreview: async () => new Uint8Array(),
    collectUnusedAssets: async () => {
      throw new Error("cleanup failed");
    },
  });
  await expect(failingCleanup.delete(created.patentId, 0)).resolves.toMatchObject({
    cleanupError: "cleanup failed",
  });
  expect(await snapshots.list(created.patentId)).toMatchObject([{ revision: 1, deletable: false }]);
  expect((await new LibraryRecoveryService({ database }).open()).quarantinedPatentIds).toEqual([]);
});

test.each(["gap", "corrupt"])(
  "an older snapshot with a %s journal is not a fallback",
  async (failure) => {
    const { database, created, patents, snapshots } = await fixture();
    await patents.updateSettings({
      patentId: created.patentId,
      expectedRevision: 0,
      name: "更新后",
      patentType: "invention",
      referenceMarks: [],
      referenceMarkSettings: { synchronizedEditingEnabled: true },
    });
    await snapshots.create(created.patentId, "manual-create");
    database.transaction((db) =>
      failure === "gap"
        ? db.prepare("DELETE FROM edit_log WHERE patent_id = ?").run(created.patentId)
        : db
            .prepare("UPDATE edit_log SET content_hash = 'broken' WHERE patent_id = ?")
            .run(created.patentId),
    );
    await expect(snapshots.delete(created.patentId, 1)).rejects.toMatchObject({
      code: "SNAPSHOT_RECOVERY_PROTECTED",
    });
    expect(await snapshots.list(created.patentId)).toMatchObject([
      { revision: 1, deletable: false },
      { revision: 0, deletable: true },
    ]);
    expect((await new LibraryRecoveryService({ database }).open()).quarantinedPatentIds).toEqual(
      [],
    );
  },
);

test("concurrent deletes leave one usable recovery snapshot", async () => {
  const { database, created, patents, snapshots } = await fixture();
  await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "更新后",
    patentType: "invention",
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });
  await snapshots.create(created.patentId, "manual-create");
  const results = await Promise.allSettled([
    snapshots.delete(created.patentId, 0),
    snapshots.delete(created.patentId, 1),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await snapshots.list(created.patentId)).toHaveLength(1);
  expect((await new LibraryRecoveryService({ database }).open()).quarantinedPatentIds).toEqual([]);
});

test("retention pauses when a contiguous but corrupt journal cannot prove recovery", async () => {
  const { database, patents, created, snapshots } = await fixture();
  await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "新修订",
    patentType: "invention",
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });
  database.transaction((db) =>
    db
      .prepare("UPDATE edit_log SET content_hash = 'broken' WHERE patent_id = ?")
      .run(created.patentId),
  );
  const result = await snapshots.prunePatent(created.patentId);
  expect(result.cleanupError).toContain("没有可重放到当前修订的快照");
  expect(await snapshots.list(created.patentId)).toHaveLength(1);
});

test("a patent in trash does not abort maintenance for active patents", async () => {
  const { patents, created, snapshots } = await fixture();
  await patents.release(created.sessionId);
  await patents.moveToTrash(created.patentId);
  const active = await patents.create({
    patentType: "invention",
    name: "正常专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const prune = vi.spyOn(snapshots, "prunePatent");
  await expect(snapshots.pruneAll()).resolves.toMatchObject({ cleanupError: null });
  expect(prune).toHaveBeenCalledWith(active.patentId);
  await patents.restore(created.patentId);
  expect(await snapshots.list(created.patentId)).toHaveLength(1);
});

test("maintenance reports one patent failure and continues with other patents", async () => {
  const { patents, snapshots } = await fixture();
  await patents.create({
    patentType: "invention",
    name: "另一个专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const prune = vi.spyOn(snapshots, "prunePatent").mockRejectedValueOnce(new Error("维护读取失败"));
  const result = await snapshots.pruneAll();
  expect(prune).toHaveBeenCalledTimes(2);
  expect(result.cleanupError).toContain("维护读取失败");
});

test("retention must not discard the only readable snapshot for corrupt bucket winners", async () => {
  const { database, created, snapshots } = await fixture();
  await expect(snapshots.open(created.patentId, 0)).resolves.toBeDefined();
  database.transaction((db) => {
    const put = db.prepare(
      "INSERT INTO snapshots(patent_id,revision,model_version,payload,content_hash,created_at,source) VALUES (?, ?, 3, ?, 'invalid', ?, 'automatic')",
    );
    put.run(created.patentId, 1, Buffer.from("broken"), "2026-08-01T09:20:00Z");
    put.run(created.patentId, 2, Buffer.from("broken"), "2026-08-01T09:40:00Z");
  });
  const result = await snapshots.prunePatent(created.patentId);
  expect(result.deletedCount).toBe(0);
  expect(result.cleanupError).toContain("暂停");
  await expect(snapshots.open(created.patentId, 0)).resolves.toBeDefined();
});

test("a damaged concurrent winner must not bypass validation", async () => {
  const { database, created, patents } = await fixture();
  await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: created.revision,
    name: "并发快照",
    patentType: "invention",
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });
  const snapshots = new SnapshotService({
    database,
    readAssetPreview: async () => new Uint8Array(),
    worker: (job) => {
      database.transaction((db) =>
        db
          .prepare(
            "INSERT INTO snapshots(patent_id,revision,model_version,payload,content_hash,created_at,source) VALUES (?, ?, 3, ?, 'invalid', ?, 'automatic')",
          )
          .run(created.patentId, job.revision, Buffer.from("broken"), "2026-08-01T11:00:00Z"),
      );
      return SnapshotService.createSnapshotPayload(job);
    },
  });
  await expect(snapshots.create(created.patentId, "manual-create")).rejects.toThrow();
  await expect(snapshots.open(created.patentId, 0)).resolves.toBeDefined();
});

test("retention leaves concurrent new history untouched", async () => {
  const { database, created } = await fixture();
  const snapshots = new SnapshotService({
    database,
    now: () => new Date("2026-08-01T11:01:00Z"),
    readAssetPreview: async () => new Uint8Array(),
    enqueueWrite: async (operation) => {
      database.transaction((db) =>
        db
          .prepare(
            "INSERT INTO snapshots(patent_id,revision,model_version,payload,content_hash,created_at,source) VALUES (?, 1, 3, ?, 'invalid', ?, 'automatic')",
          )
          .run(created.patentId, Buffer.from("broken"), "2026-08-01T09:20:00Z"),
      );
      return await operation();
    },
  });
  expect(await snapshots.prunePatent(created.patentId)).toMatchObject({
    deletedCount: 0,
    cleanupError: expect.stringContaining("发生变化"),
  });
  await expect(snapshots.open(created.patentId, 0)).resolves.toBeDefined();
});

test("damaged independent flowchart source is rejected without marking the document snapshot damaged", async () => {
  const { database, created, patents, snapshots } = await fixture();
  const projectId = "11111111-1111-4111-8111-111111111111";
  const store = new FlowchartSourceStore({ database });
  store.appendRevision({
    patentId: created.patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata: { name: "测试流程", pageCount: 1, lastPageId: "p1" },
  });
  await patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: created.revision,
    name: "测试流程快照",
    patentType: "invention",
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });
  const result = await snapshots.create(created.patentId, "manual-create");
  database.transaction((db) =>
    db
      .prepare("UPDATE patent_flowchart_source_revisions SET source = ?")
      .run(Buffer.from("broken")),
  );
  await expect(snapshots.readFlowchartArchive(created.patentId, result.revision)).resolves.toEqual(
    [],
  );
  expect(() => store.loadCurrent(created.patentId, projectId)).toThrow();
  expect(
    (await snapshots.list(created.patentId)).find((row) => row.revision === result.revision)
      ?.status,
  ).toBe("healthy");
});

test("snapshot reconciliation must not mutate after recovery switches to read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-readonly-audit-"));
  roots.push(root);
  const originalOpen = LibraryRecoveryService.prototype.open;
  vi.spyOn(LibraryRecoveryService.prototype, "open").mockImplementation(function (
    this: LibraryRecoveryService,
  ) {
    this.integrityCheck = () => ({ ok: false, messages: ["injected integrity failure"] });
    return originalOpen.call(this);
  });
  const reconcile = vi.spyOn(SnapshotService.prototype, "reconcileAssetReferences");
  const runtime = await createLibraryRuntime({
    libraryRoot: root,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: false,
  });
  closers.push(() => runtime.close());
  expect(runtime.readOnly).toBe(true);
  expect(reconcile).not.toHaveBeenCalled();
});
