import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssetDescriptor,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type ParagraphNode,
  type PatentBookDocument,
} from "../../shared/document/model.js";
import { CANONICAL_PATENT_FORMAT_VERSION, type PatentBookKind } from "../../shared/patent/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";

import { decodeEnvelope, encodeEnvelope, hashJson } from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { type OpenedPatent, PatentService } from "./patent-service.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";
import { recoverPatentFromSnapshot } from "./recovery-service.js";
import { SnapshotService } from "./snapshot-service.js";

const roots: string[] = [];
test("background preparation waits for stable data and cached validation still checks external assets", async () => {
  const { service, database } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "资源校验",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const descriptor = asset(71);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        opened.patent.createdAt,
      );
    raw
      .prepare("INSERT INTO patent_assets(patent_id, asset_id) VALUES (?, ?)")
      .run(opened.patentId, descriptor.assetId);
  });
  await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [{ figureId: testUuid(971), assetId: descriptor.assetId, widthMm: 80 }],
    abstractDrawingFigureId: null,
    assets: [descriptor],
  });
  const worker = vi.fn(SnapshotService.createSnapshotPayload);
  const validateAsset = vi.fn(async () => undefined);
  const snapshots = new SnapshotService({
    database,
    worker,
    validateAsset,
    readAssetPreview: async () => new Uint8Array(),
  });
  await snapshots.prepareClose(opened.patentId, true);
  expect(worker).not.toHaveBeenCalled();
  await snapshots.prepareClose(opened.patentId, true);
  expect(worker).toHaveBeenCalledOnce();
  await snapshots.create(opened.patentId, "application-close");
  const token = database.changeToken();
  validateAsset.mockRejectedValueOnce(new Error("External resource missing"));
  await expect(snapshots.create(opened.patentId, "application-close")).rejects.toThrow(
    "External resource missing",
  );
  expect(database.changeToken()).toBe(token);
  expect(worker).toHaveBeenCalledOnce();
});

test("prepares a closing snapshot without changing history and reuses its payload", async () => {
  const { service, database } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "提前准备",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  opened = await editBook(service, opened, "claims", "最新内容");
  const worker = vi.fn(SnapshotService.createSnapshotPayload);
  const snapshots = new SnapshotService({
    database,
    worker,
    readAssetPreview: async () => new Uint8Array(),
  });
  const before = await snapshots.list(opened.patentId);
  await snapshots.prepareClose(opened.patentId);
  expect(await snapshots.list(opened.patentId)).toEqual(before);
  await snapshots.create(opened.patentId, "application-close");
  expect(worker).toHaveBeenCalledTimes(1);
  expect((await snapshots.open(opened.patentId)).patent).toEqual(
    service.loadSavedPatent(opened.patentId),
  );
});

test("never commits a prepared payload after another edit and invalidates verified snapshots after database changes", async () => {
  const { service, database } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "准备后修改",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  opened = await editBook(service, opened, "claims", "旧内容");
  const worker = vi.fn(SnapshotService.createSnapshotPayload);
  const snapshots = new SnapshotService({
    database,
    worker,
    readAssetPreview: async () => new Uint8Array(),
  });
  await snapshots.prepareClose(opened.patentId);
  opened = await editBook(service, opened, "claims", "退出前最后输入");
  await snapshots.create(opened.patentId, "application-close");
  expect(worker).toHaveBeenCalledTimes(2);
  expect((await snapshots.open(opened.patentId)).patent).toEqual(
    service.loadSavedPatent(opened.patentId),
  );
  const open = vi.spyOn(snapshots, "open");
  await snapshots.create(opened.patentId, "application-close");
  expect(open).not.toHaveBeenCalled();
  database.transaction((db) =>
    db
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision = ?")
      .run(new Uint8Array([0]), opened.patentId, opened.revision),
  );
  await expect(snapshots.create(opened.patentId, "application-close")).rejects.toThrow();
});
test("does not report a damaged existing snapshot as a successful recovery point", async () => {
  const { service, snapshots, database } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "损坏快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((db) =>
    db
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision = 0")
      .run(new Uint8Array([1, 2, 3]), opened.patentId),
  );
  await expect(snapshots.create(opened.patentId, "manual-create")).rejects.toThrow();
  expect(service.loadSavedPatent(opened.patentId)).toEqual(opened.patent);
});
test("includes auxiliary document content in snapshot previews", async () => {
  const { service, snapshots } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "预览材料",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = opened.patent.books[0];
  if (!source) throw new Error("fixture");
  await service.createAuxiliaryDocument({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: 0,
    document: {
      auxiliaryDocumentId: testUuid(800),
      title: "实验材料",
      document: { ...source.document, documentId: testUuid(801), title: "实验材料" },
      localRevision: 0,
      persistedRevision: 0,
      editorState: {},
      sourceFileName: null,
    },
  });
  await snapshots.create(opened.patentId, "manual-create");
  const preview = await snapshots.preview(opened.patentId, 1);
  expect(preview.current.auxiliaryDocuments).toEqual([
    expect.objectContaining({ auxiliaryDocumentId: testUuid(800), title: "实验材料" }),
  ]);
});
const databases: LibraryDatabase[] = [];

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function asset(index: number): AssetDescriptor {
  return {
    assetId: testUuid(900 + index),
    kind: "image",
    originalName: `snapshot-figure-${index}.png`,
    mediaType: "image/png",
    extension: "png",
    byteLength: 10 + index,
    sha256: index.toString(16).toUpperCase().padStart(64, "0"),
    widthPx: 100 + index,
    heightPx: 80 + index,
    previewByteLength: 5 + index,
    previewSha256: (index + 100).toString(16).toUpperCase().padStart(64, "0"),
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-snapshot-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture(now: { value: Date } = { value: new Date("2026-08-01T10:00:00.000Z") }) {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let uuid = 1;
  const assetDescriptors = new Map<string, AssetDescriptor>();
  const service = new PatentService({
    database: prepared.database,
    now: () => now.value,
    randomUUID: () => testUuid(uuid++),
    assetStore: {
      async readAsset(assetId) {
        const descriptor = assetDescriptors.get(assetId);
        if (!descriptor) throw new Error("asset fixture missing");
        return { descriptor: structuredClone(descriptor) };
      },
    },
  });
  const snapshotOptions = {
    database: prepared.database,
    now: () => now.value,
    readAssetPreview: async () => new Uint8Array(),
  };
  const snapshots = new SnapshotService(snapshotOptions);
  return { assetDescriptors, database: prepared.database, service, snapshots };
}

function bookDocument(opened: OpenedPatent, kind: PatentBookKind): PatentBookDocument {
  const book = opened.patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error("fixture");
  return book.document;
}

function withFirstParagraphText(document: PatentBookDocument, text: string): PatentBookDocument {
  const next = structuredClone(document);
  const paragraph = next.content.find(
    (block): block is ParagraphNode => block.type === "paragraph",
  );
  if (paragraph === undefined) {
    next.content.push({
      id: testUuid(900),
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [],
    });
  }
  const target = next.content.find((block): block is ParagraphNode => block.type === "paragraph");
  if (target === undefined) throw new Error("fixture");
  target.content = [{ type: "text", text, marks: [] }];
  return next;
}

async function editBook(
  service: PatentService,
  opened: OpenedPatent,
  bookKind: PatentBookKind,
  text: string,
): Promise<OpenedPatent> {
  const current = await service.open(opened.patentId);
  await service.applyBookEdit({
    patentId: current.patentId,
    sessionId: opened.sessionId,
    bookKind,
    expectedRevision: current.revision,
    document: withFirstParagraphText(bookDocument(current, bookKind), text),
    editorState: { selection: "end" },
  });
  return service.open(opened.patentId);
}

async function createOpenedSnapshot(
  snapshots: SnapshotService,
  patentId: string,
  source: "automatic" | "manual-create" = "manual-create",
) {
  const result = await snapshots.create(patentId, source);
  return await snapshots.open(patentId, result.revision);
}

/**
 * Mirrors the replay precondition enforced by `LibraryRecoveryService`: walking the edit
 * journal down from `patents.revision` must not hit a hole before reaching a snapshot.
 */
function hasReplayableSnapshot(database: LibraryDatabase, patentId: string): boolean {
  return database.read((raw) => {
    const patent = raw
      .prepare("SELECT revision FROM patents WHERE patent_id = ?")
      .get(patentId) as {
      revision: number;
    };
    const snapshots = raw
      .prepare("SELECT revision FROM snapshots WHERE patent_id = ?")
      .all(patentId) as Array<{ revision: number }>;
    const edits = raw
      .prepare(
        `SELECT target_revision, base_revision
         FROM edit_log
         WHERE patent_id = ? AND target_revision <= ?
         ORDER BY target_revision DESC`,
      )
      .all(patentId, patent.revision) as Array<{ target_revision: number; base_revision: number }>;
    let reachable = patent.revision;
    for (const edit of edits) {
      if (edit.target_revision !== reachable || edit.base_revision !== reachable - 1) break;
      reachable = edit.base_revision;
    }
    return snapshots.some(
      (snapshot) => snapshot.revision >= reachable && snapshot.revision <= patent.revision,
    );
  });
}

function snapshotRevisions(database: LibraryDatabase, patentId: string): number[] {
  return database
    .read((raw) =>
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(patentId),
    )
    .map((row) => (row as { revision: number }).revision);
}

function editLogFloor(database: LibraryDatabase, patentId: string): number | null {
  return database.read(
    (raw) =>
      (
        raw
          .prepare("SELECT MIN(target_revision) AS floor FROM edit_log WHERE patent_id = ?")
          .get(patentId) as { floor: number | null }
      ).floor,
  );
}

test("keeps anchored snapshots when retention would strand the edit journal", async () => {
  const now = { value: new Date("2026-08-16T12:00:00.000Z") };
  const { database, service, snapshots } = await openFixture(now);
  let opened = await service.create({
    patentType: "invention",
    name: "锚点保护专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (let revision = 1; revision <= 10; revision += 1) {
    opened = await editBook(service, opened, "claims", `${revision}. 一种夹具。`);
  }
  expect(opened.revision).toBe(10);
  // All snapshots share one timestamp, so the first pass retains them all and anchors the
  // journal at revision 5 — the same shape as a burst of edits inside a single hour.
  const stamp = now.value.toISOString();
  database.transaction((raw) => {
    raw
      .prepare("UPDATE snapshots SET created_at = ? WHERE patent_id = ?")
      .run(stamp, opened.patentId);
  });
  seedSnapshotRows(
    database,
    opened.patentId,
    [1, 5, 9, 10].map((revision) => ({ revision, createdAt: stamp })),
    true,
  );
  expect(snapshotRevisions(database, opened.patentId)).toEqual([0, 1, 5, 9, 10]);

  const anchored = await snapshots.prunePatent(opened.patentId);
  expect(anchored).toEqual({ deletedCount: 0, cleanupError: null });
  expect(editLogFloor(database, opened.patentId)).toBe(6);
  expect(hasReplayableSnapshot(database, opened.patentId)).toBe(true);

  // A day later the day bucket keeps its two newest snapshots, 9 and 10, which are exactly the
  // ones recovery can reach. Snapshot 5 stays anchored too, so the journal floor at 6 keeps
  // holding and the snapshots below it can finally go.
  now.value = new Date("2026-08-17T13:00:00.000Z");
  const swept = await snapshots.prunePatent(opened.patentId);
  expect(swept).toEqual({ deletedCount: 2, cleanupError: null });
  expect(snapshotRevisions(database, opened.patentId)).toEqual([5, 9, 10]);
  expect(editLogFloor(database, opened.patentId)).toBe(6);
  expect(hasReplayableSnapshot(database, opened.patentId)).toBe(true);
});

test("keeps the whole history when no snapshot can be replayed to the live revision", async () => {
  const now = { value: new Date("2026-08-16T12:00:00.000Z") };
  const { database, service, snapshots } = await openFixture(now);
  let opened = await service.create({
    patentType: "invention",
    name: "无锚点专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (let revision = 1; revision <= 8; revision += 1) {
    opened = await editBook(service, opened, "claims", `${revision}. 一种夹具。`);
  }
  expect(opened.revision).toBe(8);
  // Only the initial snapshot at revision 0 exists, while the journal now reaches back no
  // further than revision 5: nothing left in the history can be replayed to the live revision.
  database.transaction((raw) => {
    raw
      .prepare("DELETE FROM edit_log WHERE patent_id = ? AND target_revision <= 5")
      .run(opened.patentId);
  });
  expect(snapshotRevisions(database, opened.patentId)).toEqual([0]);
  expect(hasReplayableSnapshot(database, opened.patentId)).toBe(false);

  const result = await snapshots.prunePatent(opened.patentId);

  // Deleting anything here would be irreversible on a history that can no longer be trimmed
  // safely, so the pass stands down and keeps every revision it found.
  expect(result.deletedCount).toBe(0);
  expect(result.cleanupError).toContain("无法相互印证");
  expect(snapshotRevisions(database, opened.patentId)).toEqual([0]);
  expect(editLogFloor(database, opened.patentId)).toBe(6);
});

function seedSnapshotRows(
  database: LibraryDatabase,
  patentId: string,
  rows: ReadonlyArray<{ revision: number; createdAt: string }>,
  replayHistory = false,
) {
  database.transaction((raw) => {
    const source = raw
      .prepare(
        `SELECT revision, model_version, payload, content_hash
         FROM snapshots WHERE patent_id = ? AND revision = 0`,
      )
      .get(patentId) as {
      revision: number;
      model_version: number;
      payload: Uint8Array;
      content_hash: string;
    };
    const insert = raw.prepare(
      `INSERT INTO snapshots(
         patent_id, revision, model_version, payload, content_hash, created_at, source
       ) VALUES (?, ?, ?, ?, ?, ?, 'automatic')`,
    );
    for (const row of rows) {
      // Planner-only tests intentionally seed future rows; recovery tests use real replayed content.
      const payload = replayHistory
        ? SnapshotService.createSnapshotPayload({
            patentId,
            revision: row.revision,
            modelVersion: 3,
            patent: recoverPatentFromSnapshot(raw, patentId, row.revision, source).patent,
          })
        : {
            modelVersion: source.model_version,
            payload: source.payload,
            contentHash: source.content_hash,
          };
      insert.run(
        patentId,
        row.revision,
        payload.modelVersion,
        payload.payload,
        payload.contentHash,
        row.createdAt,
      );
    }
  });
}

test("creating the same revision twice preserves its original snapshot and links", async () => {
  const now = { value: new Date("2026-08-01T10:00:00.000Z") };
  const { database, service, snapshots } = await openFixture(now);
  const created = await service.create({
    patentType: "invention",
    name: "时间戳专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const projectId = testUuid(780);
  new FlowchartSourceStore({ database, randomUUID: () => testUuid(781) }).appendRevision({
    patentId: created.patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata: { name: "不可改写", pageCount: 1, lastPageId: "p1" },
  });
  const edited = await editBook(service, created, "claims", "1. 一种不可改写的夹具。");

  const first = await snapshots.create(edited.patentId, "manual-save");
  const before = database.read((raw) => ({
    snapshot: raw
      .prepare(
        `SELECT model_version, payload, content_hash, created_at, source
         FROM snapshots WHERE patent_id = ? AND revision = ?`,
      )
      .get(edited.patentId, edited.revision),
    assets: raw
      .prepare(
        `SELECT asset_id FROM snapshot_assets
         WHERE patent_id = ? AND revision = ? ORDER BY asset_id`,
      )
      .all(edited.patentId, edited.revision),
    flowcharts: raw
      .prepare(
        `SELECT project_id, source_revision_id FROM snapshot_flowchart_revisions
         WHERE patent_id = ? AND snapshot_revision = ? ORDER BY project_id`,
      )
      .all(edited.patentId, edited.revision),
  }));

  now.value = new Date("2026-08-02T10:00:00.000Z");
  const second = await snapshots.create(edited.patentId, "patent-close");

  expect(first).toEqual({
    outcome: "created",
    revision: edited.revision,
    createdAt: "2026-08-01T10:00:00.000Z",
    source: "manual-save",
  });
  expect(second).toEqual({ ...first, outcome: "already-exists" });
  expect(
    database.read((raw) => ({
      snapshot: raw
        .prepare(
          `SELECT model_version, payload, content_hash, created_at, source
           FROM snapshots WHERE patent_id = ? AND revision = ?`,
        )
        .get(edited.patentId, edited.revision),
      assets: raw
        .prepare(
          `SELECT asset_id FROM snapshot_assets
           WHERE patent_id = ? AND revision = ? ORDER BY asset_id`,
        )
        .all(edited.patentId, edited.revision),
      flowcharts: raw
        .prepare(
          `SELECT project_id, source_revision_id FROM snapshot_flowchart_revisions
           WHERE patent_id = ? AND snapshot_revision = ? ORDER BY project_id`,
        )
        .all(edited.patentId, edited.revision),
    })),
  ).toEqual(before);
  expect(before.flowcharts).toHaveLength(0);
});

test("document snapshots neither contain nor depend on independently saved flowchart sources", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "历史流程",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  let id = 800;
  const store = new FlowchartSourceStore({ database, randomUUID: () => testUuid(id++) });
  const projects = [testUuid(780), testUuid(781)];
  const sources = projects.map((_, i) => Buffer.from(`<mxfile><diagram id="old-${i}"/></mxfile>`));
  for (const [i, projectId] of projects.entries()) {
    store.appendRevision({
      patentId: created.patentId,
      projectId,
      expectedProjectRevision: 0,
      source: sources[i]!,
      metadata: { name: `流程${i}`, pageCount: 1, lastPageId: `old-${i}` },
    });
  }
  const edited = await editBook(service, created, "claims", "1. 一种历史装置。");
  await snapshots.create(edited.patentId, "manual-create");
  for (const projectId of projects) {
    store.appendRevision({
      patentId: created.patentId,
      projectId,
      expectedProjectRevision: 0,
      source: Buffer.from('<mxfile><diagram id="new"/></mxfile>'),
      metadata: { name: "新版", pageCount: 1, lastPageId: "new" },
    });
  }
  const archive = await snapshots.readFlowchartArchive(edited.patentId, edited.revision);
  expect(archive).toHaveLength(0);
  database.transaction((raw) =>
    raw
      .prepare("UPDATE patent_flowchart_source_revisions SET source = ? WHERE project_revision = 0")
      .run(Buffer.from("damaged")),
  );
  await expect(snapshots.readFlowchartArchive(edited.patentId, edited.revision)).resolves.toEqual(
    [],
  );
  expect((await snapshots.open(edited.patentId, edited.revision)).patent.patentId).toBe(
    edited.patentId,
  );
  expect(store.loadCurrent(edited.patentId, projects[0]!).revision).toBe(1);
});

test("lists a bounded content summary for every readable snapshot", async () => {
  const { service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "摘要预览专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const edited = await editBook(service, created, "claims", "1. 一种可调夹具。");
  await snapshots.create(edited.patentId, "manual-create");

  const snapshot = (await snapshots.list(edited.patentId))[0];
  expect(snapshot).toMatchObject({
    contentSummary: {
      books: expect.arrayContaining([
        expect.objectContaining({
          kind: "claims",
          preview: expect.stringContaining("1. 一种可调夹具。"),
        }),
      ]),
      figureCount: 0,
      assetCount: 0,
      flowchartCount: 0,

      referenceMarkCount: 0,
    },
  });
  expect(snapshot?.contentSummary?.books.every((book) => book.preview.length <= 120)).toBe(true);
});

test("previews a snapshot against the nearest readable retained predecessor", async () => {
  const { database, service, snapshots } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "最近可读快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (const revision of [1, 2, 3]) {
    opened = await editBook(service, opened, "claims", `${revision}. 一种夹具。`);
    await snapshots.create(opened.patentId, "manual-create");
  }
  database.transaction((raw) => {
    raw
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision = ?")
      .run(Buffer.from("damaged"), opened.patentId, 2);
  });

  const preview = await snapshots.preview(opened.patentId, 3);

  expect(preview.current.revision).toBe(3);
  expect(preview.baseline?.revision).toBe(1);
  expect(preview.comparison).toBe("compared");
  expect(preview.skippedRevisions).toEqual([2]);
  expect(preview.current.books.map((book) => book.kind)).toEqual([
    "claims",
    "description",
    "description-drawings",
    "abstract",
    "abstract-drawing",
  ]);
});

test("labels the first retained snapshot as the initial baseline", async () => {
  const { service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "初始快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const preview = await snapshots.preview(created.patentId, 0);

  expect(preview.baseline).toBeNull();
  expect(preview.comparison).toBe("initial");
  expect(preview.skippedRevisions).toEqual([]);
});

test("reports no readable baseline when every older retained snapshot is damaged", async () => {
  const { database, service, snapshots } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "无可读基线",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (const revision of [1, 2, 3]) {
    opened = await editBook(service, opened, "claims", `${revision}. 一种夹具。`);
    await snapshots.create(opened.patentId, "manual-create");
  }
  database.transaction((raw) => {
    raw
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision < ?")
      .run(Buffer.from("damaged"), opened.patentId, 3);
  });

  const preview = await snapshots.preview(opened.patentId, 3);

  expect(preview.baseline).toBeNull();
  expect(preview.comparison).toBe("no-readable-baseline");
  expect(preview.skippedRevisions).toEqual([2, 1, 0]);
});

test("reads only an asset linked to the requested snapshot revision", async () => {
  const previewBytes = Uint8Array.from([7, 8, 9]);
  const { database, service } = await openFixture();
  const linkedAssetId = testUuid(901);
  const unrelatedAssetId = testUuid(902);
  const snapshots = new SnapshotService({
    database,
    readAssetPreview: async (assetId) => {
      expect(assetId).toBe(linkedAssetId);
      return previewBytes;
    },
  });
  const created = await service.create({
    patentType: "invention",
    name: "快照资源授权",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    const descriptor = asset(1);
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        created.patent.createdAt,
      );
    raw
      .prepare("INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, ?, ?)")
      .run(created.patentId, 0, linkedAssetId);
  });

  await expect(snapshots.previewAsset(created.patentId, 0, linkedAssetId)).resolves.toEqual(
    previewBytes,
  );
  await expect(snapshots.previewAsset(created.patentId, 0, unrelatedAssetId)).rejects.toMatchObject(
    { code: "NOT_FOUND" },
  );
  await expect(snapshots.previewAsset(created.patentId, 1, linkedAssetId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("prunes with the pure planner without protecting snapshots above the live revision", async () => {
  const now = { value: new Date("2026-08-16T12:00:00.000Z") };
  const { database, service, snapshots } = await openFixture(now);
  const created = await service.create({
    patentType: "invention",
    name: "分层保留专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare("UPDATE snapshots SET created_at = ? WHERE patent_id = ? AND revision = 0")
      .run("2024-12-31T12:00:00.000Z", created.patentId);
  });
  seedSnapshotRows(database, created.patentId, [
    { revision: 1, createdAt: "2024-05-01T12:00:00.000Z" },
    { revision: 2, createdAt: "2024-09-01T12:00:00.000Z" },
    { revision: 3, createdAt: "2024-12-30T12:00:00.000Z" },
  ]);

  const result = await snapshots.prunePatent(created.patentId);

  // Retention keeps the two newest snapshots of the year bucket, 3 and 0, so nothing protects
  // revisions 1 and 2 merely for sitting above the live revision of 0.
  expect(result).toEqual({ deletedCount: 2, cleanupError: null });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(created.patentId),
    ),
  ).toEqual([{ revision: 0 }, { revision: 3 }]);
});

test("retains every recent snapshot without a maximum count", async () => {
  const now = { value: new Date("2026-08-16T12:00:00.000Z") };
  const { database, service, snapshots } = await openFixture(now);
  const created = await service.create({
    patentType: "invention",
    name: "数量上限专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  seedSnapshotRows(
    database,
    created.patentId,
    Array.from({ length: 9 }, (_, index) => ({
      revision: index + 1,
      createdAt: new Date(now.value.getTime() - (9 - index) * 60_000).toISOString(),
    })),
  );
  const result = await snapshots.prunePatent(created.patentId);

  expect(result).toEqual({ deletedCount: 0, cleanupError: null });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(created.patentId),
    ),
  ).toEqual(Array.from({ length: 10 }, (_, revision) => ({ revision })));
});

test("compacts a full five-book patent aggregate instead of a single document", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "快照专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const editedClaims = await editBook(service, created, "claims", "1. 一种可调夹具。");
  const editedDescription = await editBook(
    service,
    editedClaims,
    "description",
    "本发明涉及夹具。",
  );
  await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: editedDescription.revision,
    name: editedDescription.patent.name,
    patentType: editedDescription.patent.patentType,
    referenceMarks: [{ referenceMarkId: testUuid(777), number: 1, keyword: "夹具" }],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });

  const snapshot = await createOpenedSnapshot(snapshots, created.patentId, "automatic");

  expect(snapshot.revision).toBe(3);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT source FROM snapshots WHERE patent_id = ? AND revision = ?")
        .get(created.patentId, snapshot.revision),
    ),
  ).toEqual({ source: "automatic" });
  expect(snapshot.patent.books).toHaveLength(5);
  expect(snapshot.patent.books.find((book) => book.kind === "claims")?.document.content).toEqual(
    bookDocument(editedDescription, "claims").content,
  );
  expect(
    snapshot.patent.books.find((book) => book.kind === "description")?.document.content,
  ).toEqual(bookDocument(editedDescription, "description").content);
  expect(snapshot.patent.referenceMarks).toEqual([
    { referenceMarkId: testUuid(777), number: 1, keyword: "夹具" },
  ]);
  expect(snapshot.patent.referenceMarkSettings).toEqual({ synchronizedEditingEnabled: true });
});

test("writes and opens a snapshot with disabled invention drawing books", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "无附图快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare("UPDATE patents SET drawing_books_enabled = 0, revision = 1 WHERE patent_id = ?")
      .run(created.patentId);
  });

  const compacted = await createOpenedSnapshot(snapshots, created.patentId);
  const reopened = await snapshots.open(created.patentId, compacted.revision);

  expect(compacted.patent.drawingBooksEnabled).toBe(false);
  expect(reopened.patent.drawingBooksEnabled).toBe(false);
});

test("keeps chemical preview descriptors in a book-only snapshot", async () => {
  const { assetDescriptors, database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "结构式快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(44);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        preview.assetId,
        preview.sha256,
        `${preview.sha256}.asset`,
        preview.mediaType,
        preview.byteLength,
        preview.widthPx,
        preview.heightPx,
        "2026-08-04T00:00:00.000Z",
      );
    raw
      .prepare("INSERT INTO patent_assets (patent_id, asset_id) VALUES (?, ?)")
      .run(created.patentId, preview.assetId);
  });
  assetDescriptors.set(preview.assetId, preview);
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(944),
        type: "chemical-structure",
        ketSource: "(ket) (atom Cl)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "description",
    expectedRevision: created.revision,
    document,
    editorState: {},
    assets: [preview],
  });

  const snapshot = await createOpenedSnapshot(snapshots, created.patentId);
  expect(snapshot.patent).toMatchObject({ figures: [], assets: [preview] });
  expect(snapshot.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    document,
  );
});

test.each([
  [3, 1],
  [11, 3],
])(
  "opens a version %i patent snapshot in memory without creating a revision",
  async (patentVersion, documentVersion) => {
    const { database, service, snapshots } = await openFixture();
    const created = await service.create({
      patentType: "invention",
      name: "旧版快照",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const legacy = {
      ...created.patent,
      formatVersion: patentVersion,
      books: created.patent.books.map((book) => ({
        ...book,
        document: { ...book.document, formatVersion: documentVersion },
      })),
    };
    const payload = encodeEnvelope(encodeJson(legacy));
    database.transaction((raw) => {
      raw
        .prepare(
          "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = 0",
        )
        .run(payload, hashJson(legacy), created.patentId);
    });
    const before = database.read((raw) =>
      raw
        .prepare("SELECT payload, content_hash FROM snapshots WHERE patent_id = ? AND revision = 0")
        .get(created.patentId),
    );

    const opened = await snapshots.open(created.patentId);

    expect(opened).toMatchObject({
      revision: 0,
      patent: {
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        revision: 0,
        drawingBooksEnabled: true,
      },
    });
    expect(
      database.read((raw) =>
        raw
          .prepare(
            "SELECT payload, content_hash FROM snapshots WHERE patent_id = ? AND revision = 0",
          )
          .get(created.patentId),
      ),
    ).toEqual(before);
  },
);

test("compacts a version 1 persisted book without changing its revisions or ciphertext", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "旧版拆分书册快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const row = database.read((raw) =>
    raw
      .prepare(
        "SELECT revision, document_json FROM patent_books WHERE patent_id = ? AND kind = 'claims'",
      )
      .get(created.patentId),
  ) as { revision: number; document_json: Uint8Array };
  const _context = `book:${created.patentId}:claims:${row.revision}`;
  const current = decodeJson<PatentBookDocument>(decodeEnvelope(row.document_json));
  const expectedContent = structuredClone(current.content);
  database.transaction((raw) => {
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(encodeEnvelope(encodeJson({ ...current, formatVersion: 1 })), created.patentId);
  });
  const before = database.read((raw) =>
    raw
      .prepare(
        "SELECT revision, document_json FROM patent_books WHERE patent_id = ? AND kind = 'claims'",
      )
      .get(created.patentId),
  ) as { revision: number; document_json: Uint8Array };

  const compacted = await createOpenedSnapshot(snapshots, created.patentId);
  const claims = compacted.patent.books.find((book) => book.kind === "claims");

  expect(compacted.revision).toBe(created.revision);
  expect(claims).toMatchObject({
    localRevision: row.revision,
    persistedRevision: row.revision,
    document: { formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION, content: expectedContent },
  });
  const after = database.read((raw) =>
    raw
      .prepare(
        "SELECT revision, document_json FROM patent_books WHERE patent_id = ? AND kind = 'claims'",
      )
      .get(created.patentId),
  ) as { revision: number; document_json: Uint8Array };
  expect(after.revision).toBe(before.revision);
  expect(Uint8Array.from(after.document_json)).toEqual(Uint8Array.from(before.document_json));
});

test("keeps figures, asset descriptors and abstract drawing selection in compacted snapshots", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "附图快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const descriptor = asset(1);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        created.patent.createdAt,
      );
  });
  const figureId = testUuid(801);
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    figures: [
      {
        figureId,
        assetId: descriptor.assetId,
        widthMm: 88,
        rotationDeg: 270,
      },
    ],
    abstractDrawingFigureId: figureId,
    assets: [descriptor],
  });

  const snapshot = await createOpenedSnapshot(snapshots, created.patentId);

  expect(snapshot.patent.figures).toEqual([
    {
      figureId,
      assetId: descriptor.assetId,
      widthMm: 88,
      rotationDeg: 270,
    },
  ]);
  expect(snapshot.patent.assets).toEqual([descriptor]);
  expect(snapshot.patent.abstractDrawingFigureId).toBe(figureId);

  // 快照内容预览必须包含附图（图片、宽度、顺序），供预览界面展示。
  const preview = await snapshots.preview(created.patentId, snapshot.revision);
  expect(preview.current.abstractDrawingFigureId).toBe(figureId);
  expect(preview.current.figures).toEqual([
    {
      figureId,
      assetId: descriptor.assetId,
      widthMm: 88,
      rotationDeg: 270,
    },
  ]);
});

test("prunes edit logs through an actual readable retained recovery anchor", async () => {
  const { database, service, snapshots } = await openFixture();
  let opened = await service.create({
    patentType: "utility-model",
    name: "保留三份",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  for (let revision = 1; revision <= 4; revision += 1) {
    opened = await editBook(service, opened, "claims", `第${revision}版权利要求`);
    await snapshots.create(opened.patentId, "manual-create");
  }

  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(opened.patentId),
    ),
  ).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }, { revision: 3 }, { revision: 4 }]);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT target_revision FROM edit_log WHERE patent_id = ? ORDER BY target_revision",
        )
        .all(opened.patentId),
    ),
  ).toEqual([{ target_revision: 3 }, { target_revision: 4 }]);
});

test("pins assets referenced by a retained snapshot after the live patent removes them", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "快照资源保护",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const descriptor = asset(71);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        created.patent.createdAt,
      );
    raw
      .prepare("INSERT INTO patent_assets(patent_id, asset_id) VALUES (?, ?)")
      .run(created.patentId, descriptor.assetId);
  });
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    figures: [{ figureId: testUuid(971), assetId: descriptor.assetId, widthMm: 80 }],
    abstractDrawingFigureId: null,
    assets: [descriptor],
  });

  await snapshots.create(created.patentId, "manual-create");
  database.transaction((raw) => {
    raw.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(created.patentId);
  });

  expect(
    database.read((raw) =>
      raw.prepare("SELECT asset_id FROM snapshot_assets WHERE patent_id = ?").all(created.patentId),
    ),
  ).toEqual([{ asset_id: descriptor.assetId }]);
});

test("rebuilds legacy snapshot asset references before garbage collection", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "旧快照资源回填",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const descriptor = asset(72);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        created.patent.createdAt,
      );
  });
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    figures: [{ figureId: testUuid(972), assetId: descriptor.assetId, widthMm: 80 }],
    abstractDrawingFigureId: null,
    assets: [descriptor],
  });
  await snapshots.create(created.patentId, "manual-create");
  database.transaction((raw) => raw.prepare("DELETE FROM snapshot_assets").run());

  await snapshots.reconcileAssetReferences();

  expect(database.read((raw) => raw.prepare("SELECT asset_id FROM snapshot_assets").all())).toEqual(
    [{ asset_id: descriptor.assetId }],
  );
});

test("deletes the requested snapshot and rejects a repeated deletion", async () => {
  const { database, service, snapshots } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "删除快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (let revision = 1; revision <= 3; revision += 1) {
    opened = await editBook(service, opened, "claims", `删除快照 ${revision}`);
    await snapshots.create(opened.patentId, "manual-create");
  }

  await snapshots.delete(opened.patentId, 0);

  expect(
    database.read((raw) =>
      raw.prepare("SELECT revision FROM snapshots WHERE patent_id = ?").all(opened.patentId),
    ),
  ).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
  await expect(snapshots.delete(opened.patentId, 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(snapshots.delete(opened.patentId, 3)).resolves.toEqual({ cleanupError: null });
});

test("a delayed patent snapshot worker does not delay the next book edit acknowledgement", async () => {
  const { database, service } = await openFixture();
  let releaseWorker: (() => void) | undefined;
  const snapshots = new SnapshotService({
    database,
    readAssetPreview: async () => new Uint8Array(),
    worker: async (job) => {
      await new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      return SnapshotService.createSnapshotPayload(job);
    },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "慢快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const compacting = snapshots.create(opened.patentId, "manual-create");

  const edited = await editBook(service, opened, "claims", "1. 一种慢快照夹具。");
  expect(edited.revision).toBe(1);

  releaseWorker?.();
  await compacting;
});

test("derives reference marks from a legal legend when the state row is absent", async () => {
  const { database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "旧库快照派生",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const withLegend: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(860),
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "其中：1、夹具。", marks: [] }],
      },
    ],
  };
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "description",
    expectedRevision: created.revision,
    document: withLegend,
    editorState: {},
  });
  database.transaction((raw) => {
    raw
      .prepare("DELETE FROM library_state WHERE key = ?")
      .run(`patent:${created.patentId}:reference-mark-state`);
  });

  const snapshot = await createOpenedSnapshot(snapshots, created.patentId);

  expect(snapshot.patent.referenceMarks).toEqual([
    expect.objectContaining({ number: 1, keyword: "夹具" }),
  ]);
  expect(snapshot.patent.referenceMarkSettings).toEqual({ synchronizedEditingEnabled: false });
  // 派生只读，不写回库。
  const row = database.read((raw) =>
    raw
      .prepare("SELECT value FROM library_state WHERE key = ?")
      .get(`patent:${created.patentId}:reference-mark-state`),
  );
  expect(row).toBeUndefined();
});
