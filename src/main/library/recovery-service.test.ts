import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssetDescriptor,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type ParagraphNode,
  type PatentBookDocument,
} from "../../shared/document/model.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { PatentBookKind } from "../../shared/patent/model.js";
import { createPatentTerminologyBookEdits } from "../../shared/patent/terminology.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { AssetStore } from "./asset-store.js";
import {
  decodeEnvelope,
  decodePatentRecoverySnapshot,
  encodeEnvelope,
  hashJson,
} from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { type OpenedPatent, PatentService } from "./patent-service.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";
import { LibraryRecoveryService } from "./recovery-service.js";
import { SnapshotService } from "./snapshot-service.js";

const roots: string[] = [];

test("keeps current drawing drafts and sources independently of document snapshots", async () => {
  const { service, snapshots, recovery, assetStore } = await openFixture();
  const created = await service.create({
    patentType: "utility-model",
    name: "图纸恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = await assetStore.install(
    { kind: "patent", patentId: created.patentId },
    storedAsset(),
  );
  const project = drawingProjectFixture(source.descriptor.assetId);
  project.nextLabel = "43";
  project.repeatLabel = true;
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [source.descriptor],
    drawingProjects: [project],
  });
  expect((await recovery.recoverPatent(created.patentId)).patent.drawingProjects).toEqual([
    project,
  ]);
  const snapshot = await snapshots.create(created.patentId, "manual-create");
  expect(
    (await snapshots.open(created.patentId, snapshot.revision)).patent.drawingProjects,
  ).toEqual([]);
  const edited = { ...project, revision: 1, name: "修改后的工作稿" };
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 1,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [source.descriptor],
    drawingProjects: [edited],
  });
  expect((await recovery.recoverPatent(created.patentId)).patent.drawingProjects).toEqual([edited]);
  expect((await assetStore.readAsset(source.descriptor.assetId)).original).toEqual(
    storedAsset().original,
  );
});
const databases: LibraryDatabase[] = [];

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-recovery-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture(now: { value: Date } = { value: new Date("2026-08-01T11:00:00.000Z") }) {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let uuid = 1;
  const assetStore = new AssetStore({ root, database: prepared.database });
  const service = new PatentService({
    database: prepared.database,
    assetStore,
    now: () => now.value,
    randomUUID: () => testUuid(uuid++),
  });
  const snapshots = new SnapshotService({
    database: prepared.database,
    readAssetPreview: async (assetId) => (await assetStore.readAsset(assetId)).preview,
  });
  const recovery = new LibraryRecoveryService({ database: prepared.database });
  return { root, assetStore, database: prepared.database, service, snapshots, recovery };
}

function storedAsset(): StoredAsset {
  const original = Uint8Array.from([5, 6, 7, 8]);
  const preview = Uint8Array.from([1, 2, 3]);
  const descriptor: AssetDescriptor = {
    assetId: testUuid(900),
    kind: "image",
    originalName: "drawing.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: sha256(original),
    widthPx: 12,
    heightPx: 8,
    previewByteLength: preview.byteLength,
    previewSha256: sha256(preview),
  };
  return { descriptor, original, preview };
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
      id: testUuid(901),
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

test("reports only patents that required journal replay", async () => {
  const { database, service, recovery } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "恢复统计",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(recovery.open()).resolves.toMatchObject({
    recoveredPatentIds: [],
    replayedEditCount: 0,
  });

  await editBook(service, created, "claims", "需要重放的权利要求");
  await expect(recovery.open()).resolves.toMatchObject({
    recoveredPatentIds: [],
    replayedEditCount: 0,
  });

  database.transaction((raw) => {
    raw
      .prepare("DELETE FROM patent_books WHERE patent_id = ? AND kind = 'claims'")
      .run(created.patentId);
  });
  await expect(recovery.open()).resolves.toMatchObject({
    recoveredPatentIds: [created.patentId],
    replayedEditCount: 1,
  });
});

test("falls back from a corrupt newest patent snapshot and replays later edit logs", async () => {
  const { database, service, snapshots, recovery } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "恢复专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  opened = await editBook(service, opened, "claims", "恢复1");
  await snapshots.create(opened.patentId, "manual-create");
  opened = await editBook(service, opened, "description", "恢复2");
  await snapshots.create(opened.patentId, "manual-create");
  opened = await editBook(service, opened, "abstract", "恢复3");
  await snapshots.create(opened.patentId, "manual-create");
  const expectedAt3 = opened.patent;

  database.read((raw) =>
    raw
      .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision = 3")
      .run(Buffer.from("corrupt"), opened.patentId),
  );

  const recovered = await recovery.recoverPatent(opened.patentId);

  expect(recovered.baseSnapshotRevision).toBe(2);
  expect(recovered.patent).toEqual(expectedAt3);
});

test("bundle import records multiple flowcharts in persisted order", async () => {
  const { database, service, recovery } = await openFixture();
  const patent = createBlankPatent({ name: "流程图顺序", patentType: "invention" });
  const source = Buffer.from('<mxfile><diagram id="p1"/></mxfile>');
  patent.flowchartProjects = [testUuid(881), testUuid(880)].map((projectId) => ({
    projectId,
    name: projectId,
    revision: 1,
    sourceSha256: createHash("sha256").update(source).digest("hex").toUpperCase(),
    pageCount: 1,
    lastPageId: "p1",
    createdAt: patent.createdAt,
    modifiedAt: patent.modifiedAt,
  }));
  await service.importBundle({
    bundleId: testUuid(910),
    patents: [
      {
        patent,
        assets: [],
        flowcharts: patent.flowchartProjects.map((project) => ({
          projectId: project.projectId,
          source,
        })),
      },
    ],
  });
  const opened = await service.open(patent.patentId);
  await service.release(opened.sessionId);
  const row = database.read((db) =>
    db
      .prepare(
        "SELECT revision, model_version, payload, content_hash FROM snapshots WHERE patent_id = ? AND revision = 0",
      )
      .get(patent.patentId),
  ) as { revision: number; model_version: number; payload: Uint8Array; content_hash: string };
  const snapshot = decodePatentRecoverySnapshot(row).patent;
  expect(snapshot.flowchartProjects).toEqual([]);
  expect(opened.patent.flowchartProjects).toHaveLength(2);
  await expect(recovery.recoverPatent(patent.patentId)).resolves.toMatchObject({
    repairedPersistedState: false,
  });
});

test("recovers legacy flowchart ordering without quarantining intact sources", async () => {
  const { database, service, recovery, snapshots } = await openFixture();
  const created = await service.create({
    name: "旧流程图顺序",
    patentType: "invention",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const store = new FlowchartSourceStore({ database, now: () => new Date("2026-08-01T12:00:00Z") });
  const source = Buffer.from('<mxfile><diagram id="p1"/></mxfile>');
  for (const projectId of [testUuid(880), testUuid(881)])
    store.appendRevision({
      patentId: created.patentId,
      projectId,
      expectedProjectRevision: 0,
      source,
      metadata: { name: projectId, pageCount: 1, lastPageId: "p1" },
    });
  database.transaction((db) =>
    db.prepare("UPDATE patents SET revision = 1 WHERE patent_id = ?").run(created.patentId),
  );
  await snapshots.create(created.patentId, "manual-create");
  database.transaction((db) => {
    const row = db
      .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = 1")
      .get(created.patentId) as { payload: Uint8Array };
    const old = decodeJson<{ formatVersion: 1; patent: typeof created.patent }>(
      decodeEnvelope(row.payload),
    );
    old.formatVersion = 1;
    old.patent.flowchartProjects = service.loadSavedPatent(created.patentId).flowchartProjects;
    old.patent.flowchartProjects.reverse();
    db.prepare(
      "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = 1",
    ).run(encodeEnvelope(encodeJson(old)), hashJson(old), created.patentId);
    db.prepare(
      "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
    ).run(created.patentId);
  });
  await expect(recovery.recoverPatent(created.patentId)).resolves.toMatchObject({
    clearedQuarantine: true,
  });
  expect((await service.list("active"))[0]?.recoveryState).toBe("healthy");
  for (const projectId of [testUuid(880), testUuid(881)])
    expect(store.loadCurrent(created.patentId, projectId).source).toEqual(Uint8Array.from(source));
});

test("restoring document history keeps the latest independent flowchart descriptor and source", async () => {
  const { database, recovery, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "恢复流程图",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const projectId = testUuid(880);
  const store = new FlowchartSourceStore({ database });
  store.appendRevision({
    patentId: created.patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata: { name: "快照版本", pageCount: 1, lastPageId: "p1" },
  });
  database.transaction((raw) => {
    raw.prepare("UPDATE patents SET revision = 1 WHERE patent_id = ?").run(created.patentId);
  });
  await snapshots.create(created.patentId, "manual-create");
  const latest = store.appendRevision({
    patentId: created.patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1">later</diagram></mxfile>'),
    metadata: { name: "后续版本", pageCount: 1, lastPageId: "p1" },
  });

  const recovered = await recovery.recoverPatent(created.patentId);

  expect(recovered.patent.flowchartProjects).toEqual([
    expect.objectContaining({
      projectId,
      revision: latest.revision,
      sourceSha256: latest.sourceSha256,
      name: "后续版本",
    }),
  ]);
  expect(store.loadCurrent(created.patentId, projectId)).toEqual(latest);
});

test("recovers a published static drawing even after its independent flowchart is removed", async () => {
  const { assetStore, database, service, snapshots } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "缺失源文件",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const projectId = testUuid(881);
  const store = new FlowchartSourceStore({ database });
  const source = store.appendRevision({
    patentId: created.patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata: { name: "关联工程", pageCount: 1, lastPageId: "p1" },
  });
  const installed = await assetStore.install(
    { kind: "patent", patentId: created.patentId },
    storedAsset(),
  );
  const figureId = testUuid(882);
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    figures: [
      {
        figureId,
        assetId: installed.descriptor.assetId,
        widthMm: 100,
        flowchartLink: {
          projectId,
          pageId: "p1",
          exportScope: "page",
          selectedCellIds: [],
          borderMm: 0,
          exportedProjectRevision: source.revision,
          exportedSourceSha256: source.sourceSha256,
          renderProfileVersion: 1,
        },
      },
    ],
    abstractDrawingFigureId: null,
    assets: [installed.descriptor],
  });
  const creation = await snapshots.create(created.patentId, "manual-create");
  const snapshot = await snapshots.open(created.patentId, creation.revision);
  database.transaction((raw) => {
    raw
      .prepare("DELETE FROM snapshot_flowchart_revisions WHERE patent_id = ?")
      .run(created.patentId);
    raw.prepare("DELETE FROM patent_flowcharts WHERE patent_id = ?").run(created.patentId);
    raw
      .prepare("DELETE FROM patent_flowchart_source_revisions WHERE patent_id = ?")
      .run(created.patentId);
  });
  const recovery = new LibraryRecoveryService({
    database,
    safetyBackup: { create: async () => ({ directory: "backup" }) },
  });

  await expect(recovery.retryPatent(created.patentId)).resolves.toMatchObject({
    patentId: created.patentId,
  });
  expect(
    database.read(
      (raw) =>
        (
          raw
            .prepare("SELECT recovery_state FROM patents WHERE patent_id = ?")
            .get(created.patentId) as { recovery_state: string }
        ).recovery_state,
    ),
  ).toBe("healthy");
  expect(snapshot.patent.figures[0]).toMatchObject({
    figureId,
  });
  expect(snapshot.patent.figures[0]?.flowchartLink).toBeUndefined();
  expect(snapshot.patent.flowchartProjects).toHaveLength(0);
});

test("recovers a snapshot whose invention drawing books are disabled", async () => {
  const { database, service, recovery } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "无附图恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const snapshot = { ...created.patent, drawingBooksEnabled: false };
  const payload = encodeEnvelope(encodeJson(snapshot));
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = 0",
      )
      .run(payload, hashJson(snapshot), created.patentId);
  });

  const recovered = await recovery.recoverPatent(created.patentId);

  expect(recovered.patent.drawingBooksEnabled).toBe(false);
});

test("replays an atomic drawing-book transition from the edit journal", async () => {
  const { service, recovery } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "重放附图启停",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
  });

  const recovered = await recovery.recoverPatent(created.patentId);
  expect(recovered.patent).toMatchObject({ revision: 1, drawingBooksEnabled: false });
  expect(
    recovered.patent.books.find((book) => book.kind === "description-drawings")?.document.content,
  ).toEqual([]);
});

test("replays a version 1 book document from a legacy patent edit log", async () => {
  const { database, service, recovery } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "旧版编辑日志",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await editBook(service, created, "claims", "旧版编辑内容");
  const row = database.read((raw) =>
    raw
      .prepare(
        "SELECT operation_id, payload FROM edit_log WHERE patent_id = ? AND target_revision = 1",
      )
      .get(created.patentId),
  ) as { operation_id: string; payload: Uint8Array };
  const _context = `patent-edit:${created.patentId}:0:1:${row.operation_id}`;
  const payload = decodeJson<Record<string, unknown>>(decodeEnvelope(row.payload));
  const legacy = {
    ...payload,
    document: { ...(payload.document as Record<string, unknown>), formatVersion: 1 },
  };
  database.transaction((raw) => {
    raw
      .prepare("UPDATE edit_log SET payload = ?, content_hash = ? WHERE operation_id = ?")
      .run(encodeEnvelope(encodeJson(legacy)), hashJson(legacy), row.operation_id);
  });

  const recovered = await recovery.recoverPatent(created.patentId);

  expect(recovered.patent.revision).toBe(1);
  expect(recovered.patent.books.find((book) => book.kind === "claims")).toMatchObject({
    document: { formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION },
  });
});

test("replays figure edits with assets and the selected abstract drawing during startup recovery", async () => {
  const { root, database, service } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "附图恢复专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const assets = new AssetStore({ root, database });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const figureId = testUuid(902);

  await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [
      {
        figureId,
        assetId: installed.descriptor.assetId,
        widthMm: 88,
        rotationDeg: 90,
      },
    ],
    abstractDrawingFigureId: figureId,
    assets: [installed.descriptor],
  });

  const restartedRecovery = new LibraryRecoveryService({ database });
  const report = await restartedRecovery.open();
  const recovered = await restartedRecovery.recoverPatent(opened.patentId);

  expect(report.quarantinedPatentIds).toEqual([]);
  expect(report.recoveredPatentIds).toEqual([]);
  expect(report.replayedEditCount).toBe(0);
  expect(recovered.patent).toMatchObject({
    revision: 1,
    figures: [
      {
        figureId,
        assetId: installed.descriptor.assetId,
        widthMm: 88,
        rotationDeg: 90,
      },
    ],
    abstractDrawingFigureId: figureId,
    assets: [installed.descriptor],
  });
});

test("does not quarantine an automation figure with an omitted zero rotation on restart", async () => {
  const { service, recovery, assetStore } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "CLI 默认旋转",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const asset = await assetStore.install(
    { kind: "patent", patentId: created.patentId },
    storedAsset(),
  );
  const patent = await service.captureAutomation(created.patentId);
  patent.assets = [asset.descriptor];
  patent.figures = [{ figureId: testUuid(903), assetId: asset.descriptor.assetId, widthMm: 80 }];
  await service.applyAutomationChange({ patentId: patent.patentId, expectedRevision: 0, patent });
  const report = await recovery.open();
  expect(report.quarantinedPatentIds).toEqual([]);
  expect((await service.captureAutomation(patent.patentId)).figures[0]).toMatchObject({
    rotationDeg: 0,
    widthMm: 80,
  });
});

test("replays book chemical previews without creating figures during recovery", async () => {
  const { root, database, service } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "结构式书册恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const assets = new AssetStore({ root, database });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const description = opened.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(906),
        type: "chemical-structure",
        ketSource: "(ket) (atom O)",
        previewAssetId: installed.descriptor.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };
  await service.applyBookEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    bookKind: "description",
    expectedRevision: opened.revision,
    document,
    editorState: {},
    assets: [installed.descriptor],
  });

  const restartedRecovery = new LibraryRecoveryService({ database });
  expect((await restartedRecovery.open()).quarantinedPatentIds).toEqual([]);
  const recovered = await restartedRecovery.recoverPatent(opened.patentId);
  expect(recovered.patent).toMatchObject({
    revision: 1,
    figures: [],
    assets: [installed.descriptor],
  });
  expect(recovered.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    document,
  );
});

test("replays figure edits with synced description content during recovery", async () => {
  const { root, database, service } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "附图说明恢复专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const assets = new AssetStore({ root, database });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const figureId = testUuid(904);
  const description = opened.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const changedDescription: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(905),
        type: "paragraph",
        semanticRole: "description-drawing-explanation",
        figureId,
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "图1为本发明的整体结构示意图。", marks: [] }],
      },
    ],
  };
  const changedEditorState = { unlinkedFigureExplanations: [], selection: { anchor: 1 } };

  await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [
      {
        figureId,
        assetId: installed.descriptor.assetId,
        widthMm: 88,
      },
    ],
    abstractDrawingFigureId: figureId,
    assets: [installed.descriptor],
  });

  // Preserve recovery support for figure-edit journals written by older releases,
  // even though new figure edits no longer own or mutate the description book.
  const row = database.read((raw) =>
    raw
      .prepare(
        "SELECT operation_id, payload FROM edit_log WHERE patent_id = ? AND target_revision = 1",
      )
      .get(opened.patentId),
  ) as { operation_id: string; payload: Uint8Array };
  const payload = decodeJson<Record<string, unknown>>(decodeEnvelope(row.payload));
  const legacyPayload = {
    ...payload,
    descriptionEdit: {
      document: changedDescription,
      editorState: changedEditorState,
    },
  };
  database.transaction((raw) => {
    raw
      .prepare("UPDATE edit_log SET payload = ?, content_hash = ? WHERE operation_id = ?")
      .run(encodeEnvelope(encodeJson(legacyPayload)), hashJson(legacyPayload), row.operation_id);
  });

  const restartedRecovery = new LibraryRecoveryService({ database });
  const recovered = await restartedRecovery.recoverPatent(opened.patentId);
  const recoveredDescription = recovered.patent.books.find((book) => book.kind === "description");

  expect(recovered.patent.revision).toBe(1);
  expect(recovered.patent.figures).toEqual([
    {
      figureId,
      assetId: installed.descriptor.assetId,
      widthMm: 88,
      rotationDeg: 0,
    },
  ]);
  expect(recovered.patent.assets).toEqual([installed.descriptor]);
  expect(recoveredDescription).toMatchObject({
    document: changedDescription,
    editorState: changedEditorState,
    localRevision: 1,
    persistedRevision: 1,
  });
});

test("replays type settings and accepted terminology replacements as one revision", async () => {
  const { service, recovery } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "术语恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const bookEdits = createPatentTerminologyBookEdits(opened.patent, "utility-model");

  await service.updateSettings({
    patentId: opened.patentId,
    expectedRevision: 0,
    name: "术语恢复（新类型）",
    patentType: "utility-model",
    bookEdits,
  });

  const recovered = await recovery.recoverPatent(opened.patentId);
  expect(recovered.patent).toMatchObject({
    revision: 1,
    name: "术语恢复（新类型）",
    patentType: "utility-model",
  });
  expect(
    JSON.stringify(recovered.patent.books.find((book) => book.kind === "description")?.document),
  ).toContain("实用新型内容");
});

test("replays reference marks and synchronized editing settings", async () => {
  const { service, recovery } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "附图标记恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const referenceMarkId = "00000000-0000-4000-8000-000000000777";

  await service.updateSettings({
    patentId: opened.patentId,
    expectedRevision: 0,
    name: opened.patent.name,
    patentType: opened.patent.patentType,
    referenceMarks: [{ referenceMarkId, number: 1, keyword: "夹具" }],
    referenceMarkSettings: { synchronizedEditingEnabled: true },
  });

  const recovered = await recovery.recoverPatent(opened.patentId);
  expect(recovered.patent.referenceMarks).toEqual([
    { referenceMarkId, number: 1, keyword: "夹具" },
  ]);
  expect(recovered.patent.referenceMarkSettings).toEqual({ synchronizedEditingEnabled: true });
});

test("clears stale patent quarantine metadata after its edit log is repaired", async () => {
  const { root, database, service } = await openFixture();
  const opened = await service.create({
    patentType: "utility-model",
    name: "隔离后修复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const assets = new AssetStore({ root, database });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const figureId = testUuid(903);
  await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [
      {
        figureId,
        assetId: installed.descriptor.assetId,
        widthMm: 72,
      },
    ],
    abstractDrawingFigureId: figureId,
    assets: [installed.descriptor],
  });
  const originalEdit = database.read((raw) =>
    raw
      .prepare("SELECT payload FROM edit_log WHERE patent_id = ? AND target_revision = 1")
      .get(opened.patentId),
  ) as { payload: Uint8Array };
  const originalPayload = Buffer.from(originalEdit.payload);
  database.read((raw) =>
    raw
      .prepare("UPDATE edit_log SET payload = ? WHERE patent_id = ? AND target_revision = 1")
      .run(Buffer.from("corrupt"), opened.patentId),
  );

  const failedRecovery = new LibraryRecoveryService({ database });
  expect((await failedRecovery.open()).quarantinedPatentIds).toEqual([opened.patentId]);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toMatchObject({ recovery_state: "quarantined", recovery_error_code: "CORRUPT_FILE" });

  database.read((raw) =>
    raw
      .prepare("UPDATE edit_log SET payload = ? WHERE patent_id = ? AND target_revision = 1")
      .run(originalPayload, opened.patentId),
  );
  const repairedRecovery = new LibraryRecoveryService({
    database,
    safetyBackup: {
      create: async () => ({ directory: "C:\\safety-backups\\repaired" }),
    },
  });

  expect(await repairedRecovery.open()).toMatchObject({
    backupPath: "C:\\safety-backups\\repaired",
    recoveredPatentIds: [opened.patentId],
    quarantinedPatentIds: [],
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toEqual({ recovery_state: "healthy", recovery_error_code: null });
  expect(
    database.read((raw) =>
      raw.prepare("SELECT key FROM library_state WHERE key = ?").get(`recovery:${opened.patentId}`),
    ),
  ).toBeUndefined();
});

test("creates one safety backup before retrying patents that were already quarantined", async () => {
  const { database, service } = await openFixture();
  const opened = await service.create({
    patentType: "utility-model",
    name: "启动恢复备份",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(opened.patentId);
  });
  const events: string[] = [];
  const recovery = new LibraryRecoveryService({
    database,
    safetyBackup: {
      create: async () => {
        events.push("backup");
        return { directory: "C:\\safety-backups\\one" };
      },
    },
  });

  const report = await recovery.open();

  expect(events).toEqual(["backup"]);
  expect(report).toMatchObject({
    backupPath: "C:\\safety-backups\\one",
    recoveredPatentIds: [opened.patentId],
    quarantinedPatentIds: [],
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toEqual({ recovery_state: "healthy", recovery_error_code: null });
});

test("does not retry already quarantined patents when their safety backup fails", async () => {
  const { database, service } = await openFixture();
  const opened = await service.create({
    patentType: "utility-model",
    name: "备份失败保持隔离",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(opened.patentId);
  });
  const recovery = new LibraryRecoveryService({
    database,
    safetyBackup: {
      create: async () => {
        throw new Error("backup failed");
      },
    },
  });

  await expect(recovery.open()).resolves.toMatchObject({
    mode: "read-only",
    recoveredPatentIds: [],
    quarantinedPatentIds: [opened.patentId],
    backupPath: null,
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toEqual({ recovery_state: "quarantined", recovery_error_code: "CORRUPT_FILE" });
});

test("retryPatent creates a safety backup and clears quarantine only after recovery succeeds", async () => {
  const { database, service } = await openFixture();
  const opened = await service.create({
    patentType: "utility-model",
    name: "主动恢复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(opened.patentId);
  });
  const recovery = new LibraryRecoveryService({
    database,
    safetyBackup: {
      create: async () => ({ directory: "C:\\safety-backups\\manual" }),
    },
  });

  await expect(recovery.retryPatent(opened.patentId)).resolves.toEqual({
    patentId: opened.patentId,
    backupCreated: true,
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toEqual({ recovery_state: "healthy", recovery_error_code: null });
});

test("recoverPatent persists reconstructed snapshot data before clearing quarantine", async () => {
  const { database, service } = await openFixture();
  const opened = await service.create({
    patentType: "utility-model",
    name: "恢复持久化审查",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(Buffer.from("corrupt-live-row"), opened.patentId);
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(opened.patentId);
  });
  const recovery = new LibraryRecoveryService({ database });

  await expect(recovery.recoverPatent(opened.patentId)).resolves.toMatchObject({
    patent: { patentId: opened.patentId },
  });
  await expect(service.open(opened.patentId)).resolves.toMatchObject({
    patent: { patentId: opened.patentId },
  });
});

test("retryPatent keeps a patent quarantined when recovery still fails", async () => {
  const { database, service } = await openFixture();
  const opened = await editBook(
    service,
    await service.create({
      patentType: "utility-model",
      name: "主动恢复失败",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    }),
    "claims",
    "主动恢复失败正文",
  );
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(opened.patentId);
    raw
      .prepare("UPDATE edit_log SET payload = ? WHERE patent_id = ?")
      .run(Buffer.from("corrupt"), opened.patentId);
  });
  const recovery = new LibraryRecoveryService({
    database,
    safetyBackup: {
      create: async () => ({ directory: "C:\\safety-backups\\manual-failed" }),
    },
  });

  await expect(recovery.retryPatent(opened.patentId)).rejects.toMatchObject({
    code: "CORRUPT_FILE",
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toMatchObject({ recovery_state: "quarantined", recovery_error_code: "CORRUPT_FILE" });
});

/**
 * The repair path as wired in the running app: a snapshot service that can rebuild the anchor.
 * Tests that construct `LibraryRecoveryService` without it pin the behaviour of a build where
 * no anchor can be written.
 */
function repairableRecovery(database: LibraryDatabase, snapshots: SnapshotService) {
  return new LibraryRecoveryService({
    database,
    safetyBackup: { create: async () => ({ directory: "C:\\safety-backups\\repair" }) },
    rebuildRecoveryAnchor: (patentId) => snapshots.rebuildRecoveryAnchor(patentId),
  });
}

function quarantineState(database: LibraryDatabase, patentId: string) {
  return database.read((raw) =>
    raw
      .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
      .get(patentId),
  );
}

function liveBookJson(
  database: LibraryDatabase,
  patentId: string,
  kind: PatentBookKind,
): Uint8Array {
  return database.read(
    (raw) =>
      (
        raw
          .prepare("SELECT document_json FROM patent_books WHERE patent_id = ? AND kind = ?")
          .get(patentId, kind) as { document_json: Uint8Array }
      ).document_json,
  );
}

function snapshotRevisions(database: LibraryDatabase, patentId: string): number[] {
  return database.read((raw) =>
    (
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(patentId) as Array<{ revision: number }>
    ).map((row) => row.revision),
  );
}

test("repairs a patent whose journal was trimmed out of reach by rebuilding the anchor", async () => {
  const { database, service, snapshots } = await openFixture();
  let opened = await service.create({
    patentType: "invention",
    name: "断链修复",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  for (const text of ["权利要求第一段", "权利要求第二段", "权利要求第三段"]) {
    opened = await editBook(service, opened, "claims", text);
  }
  const liveRevision = opened.revision;
  expect(liveRevision).toBeGreaterThan(2);
  // Exactly the shape the retention policy used to leave behind: the journal no longer
  // reaches back to the surviving snapshot, and no snapshot sits at the live revision.
  database.transaction((raw) => {
    raw
      .prepare("DELETE FROM edit_log WHERE patent_id = ? AND target_revision <= ?")
      .run(opened.patentId, liveRevision - 2);
    raw.prepare("DELETE FROM snapshots WHERE patent_id = ? AND revision > 0").run(opened.patentId);
  });
  const recovery = repairableRecovery(database, snapshots);
  expect((await recovery.open()).quarantinedPatentIds).toEqual([opened.patentId]);
  expect(quarantineState(database, opened.patentId)).toEqual({
    recovery_state: "quarantined",
    recovery_error_code: "RECOVERY_CHAIN_BROKEN",
  });
  const contentBefore = liveBookJson(database, opened.patentId, "claims");

  await expect(recovery.retryPatent(opened.patentId)).resolves.toEqual({
    patentId: opened.patentId,
    backupCreated: true,
  });

  expect(quarantineState(database, opened.patentId)).toEqual({
    recovery_state: "healthy",
    recovery_error_code: null,
  });
  // The anchor is rebuilt from the live content, so nothing is replayed and nothing is
  // rewritten: the stored document stays byte-identical.
  expect(liveBookJson(database, opened.patentId, "claims")).toEqual(contentBefore);
  expect(snapshotRevisions(database, opened.patentId)).toContain(liveRevision);
  await expect(service.open(opened.patentId)).resolves.toMatchObject({
    patent: { patentId: opened.patentId },
  });

  // A retention pass and the next startup must both leave the repaired patent alone.
  await snapshots.prunePatent(opened.patentId);
  expect((await recovery.open()).quarantinedPatentIds).toEqual([]);
});

test("reports a failed repair instead of rebuilding over unreadable live content", async () => {
  const { database, service, snapshots } = await openFixture();
  const opened = await editBook(
    service,
    await service.create({
      patentType: "utility-model",
      name: "修复失败",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    }),
    "claims",
    "修复失败正文",
  );
  database.transaction((raw) => {
    // No usable snapshot and a damaged live row: no trustworthy source is left, so the
    // repair must refuse rather than bless the damaged content.
    raw.prepare("DELETE FROM snapshots WHERE patent_id = ?").run(opened.patentId);
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(Buffer.from("corrupt-live-row"), opened.patentId);
  });
  const recovery = repairableRecovery(database, snapshots);

  await expect(recovery.retryPatent(opened.patentId)).rejects.toMatchObject({
    code: "RECOVERY_REPAIR_FAILED",
  });
  expect(quarantineState(database, opened.patentId)).toEqual({
    recovery_state: "quarantined",
    recovery_error_code: "RECOVERY_REPAIR_FAILED",
  });
  expect(snapshotRevisions(database, opened.patentId)).toEqual([]);
});

test("quarantines a patent with a corrupt edit log", async () => {
  const { database, service, recovery } = await openFixture();
  const opened = await editBook(
    service,
    await service.create({
      patentType: "utility-model",
      name: "坏日志",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    }),
    "claims",
    "坏日志1",
  );
  database.read((raw) =>
    raw
      .prepare("UPDATE edit_log SET payload = ? WHERE patent_id = ?")
      .run(Buffer.from("corrupt"), opened.patentId),
  );

  const report = await recovery.open();

  expect(report).toMatchObject({
    mode: "read-write",
    quarantinedPatentIds: [opened.patentId],
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toMatchObject({ recovery_state: "quarantined", recovery_error_code: "CORRUPT_FILE" });
});

test("returns read-only mode on whole-database integrity failure", async () => {
  const { recovery } = await openFixture();
  recovery.integrityCheck = () => ({ ok: false, messages: ["damaged"] });

  await expect(recovery.open()).resolves.toMatchObject({
    mode: "read-only",
    recoveredPatentIds: [],
    quarantinedPatentIds: [],
  });
});

test("quarantines a patent that references a corrupt stored asset", async () => {
  const { root, database, service } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "坏资源专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const assets = new AssetStore({ root, database });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  await writeFile(join(root, "assets", `${installed.descriptor.sha256}.asset`), "corrupt");

  const recovery = new LibraryRecoveryService({ database, assetStore: assets });
  const report = await recovery.open();

  expect(report.quarantinedPatentIds).toEqual([opened.patentId]);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toMatchObject({ recovery_state: "quarantined", recovery_error_code: "CORRUPT_FILE" });
});
