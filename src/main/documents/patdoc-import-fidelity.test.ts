import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatdocFidelityPayload as fixture } from "../../../tests/fixtures/patdoc-fidelity.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { FlowchartService } from "../flowcharts/flowchart-service.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { AssetStore } from "../library/asset-store.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { PatentService } from "../library/patent-service.js";
import { LibraryRecoveryService } from "../library/recovery-service.js";
import { importPatentPatdocPayload } from "../library/register-library-ipc.js";
import { SnapshotService } from "../library/snapshot-service.js";
import { FileService } from "./file-service.js";
import type { PatentPatdocPayload } from "./patdoc-format.js";
import { readPatdoc } from "./patdoc-reader.js";
import { writePatdoc } from "./patdoc-writer.js";

vi.mock("electron", () => ({ dialog: {}, ipcMain: {}, BrowserWindow: {} }));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "patdoc-fidelity-"));
  roots.push(root);
  return root;
}
async function services() {
  const root = await directory();
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("fixture database failed");
  const database = prepared.database;
  const assetStore = new AssetStore({ root, database });
  const patents = new PatentService({ database, assetStore });
  const flowcharts = new FlowchartService({
    database,
    assetStore,
    patentService: patents,
    sourceStore: new FlowchartSourceStore({ database }),
  });
  return { root, database, assetStore, patents, flowcharts };
}

test("file verification accepts multiple flowcharts regardless of project order", async () => {
  const payload = await fixture();
  const path = join(await directory(), "multi.patdoc");
  const result = await new FileService().savePatent(path, payload);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const reopened = await readPatdoc<PatentPatdocPayload>(path);
  expect(reopened.patent).toEqual({ ...payload.patent, docxImportReport: null });
  expect(reopened.flowcharts).toEqual([...payload.flowcharts!].reverse());
});

test("direct import ignores legacy snapshots and report while retaining current editable sources", async () => {
  const { database, assetStore, patents, flowcharts } = await services();
  using _database = database;
  const payload = await fixture();
  payload.snapshots = [
    { ...structuredClone(payload), createdAt: "2026-09-22T00:00:00.000Z", source: "manual-create" },
  ];
  // Deliberately unavailable historical content must not block importing current content.
  payload.snapshots[0]!.assets = [];
  const imported = await importPatentPatdocPayload(
    patents,
    assetStore,
    async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
    payload,
    flowcharts,
  );
  expect(imported.patent.docxImportReport).toBeNull();
  expect(imported.patent.books.map((book) => book.document)).toEqual(
    payload.patent.books.map((book) => book.document),
  );
  const snapshots = new SnapshotService({
    database,
    readAssetPreview: async (id) => (await assetStore.readAsset(id)).preview,
  });
  expect(
    (await snapshots.list(imported.patentId)).some((item) => item.source === "manual-create"),
  ).toBe(false);
  for (const project of imported.patent.flowchartProjects) {
    const original = payload.patent.flowchartProjects.find((item) => item.name === project.name)!;
    expect(flowcharts.exportBackup(imported.patentId, project.projectId)).toEqual(
      payload.flowcharts!.find((item) => item.projectId === original.projectId)!.source,
    );
  }
});

test("actual PATDOC import preserves formatted books, auxiliary documents, resources and editable multi-page flowcharts", async () => {
  const { root, database, assetStore, patents, flowcharts } = await services();
  using _database = database;
  const payload = await fixture();
  const path = join(root, "source.patdoc");
  await writePatdoc(path, payload);
  const archived = await readPatdoc<PatentPatdocPayload>(path);
  const imported = await importPatentPatdocPayload(
    patents,
    assetStore,
    async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
    archived,
    flowcharts,
  );
  await patents.release(imported.sessionId);
  const reopened = await patents.open(imported.patentId);
  expect(reopened.patent.books.map((book) => book.document)).toEqual(
    payload.patent.books.map((book) => book.document),
  );
  expect(reopened.patent.auxiliaryDocuments.map((item) => item.document)).toEqual(
    payload.patent.auxiliaryDocuments.map((item) => item.document),
  );
  expect(reopened.patent.docxImportReport).toBeNull();
  expect(reopened.patent.customer).toBe(payload.patent.customer);
  expect(reopened.patent.figures[0]).toMatchObject({
    widthMm: 90,
    rotationDeg: 90,
    flowchartLink: { pageId: "p2" },
  });
  expect(reopened.patent.abstractDrawingFigureId).toBe(reopened.patent.figures[0]!.figureId);
  for (const project of reopened.patent.flowchartProjects) {
    const sourceProject = payload.patent.flowchartProjects.find(
      (item) => item.name === project.name,
    )!;
    expect(project).toMatchObject({
      pageCount: 2,
      lastPageId: "p2",
      sourceSha256: sourceProject.sourceSha256,
    });
    expect(flowcharts.exportBackup(imported.patentId, project.projectId)).toEqual(
      payload.flowcharts!.find((item) => item.projectId === sourceProject.projectId)!.source,
    );
  }
  expect((await assetStore.readAsset(reopened.patent.assets[0]!.assetId)).original).toEqual(
    payload.assets[0]!.original,
  );
  const recovery = new LibraryRecoveryService({ database });
  // Replay the real import journal instead of trusting only the current database rows.
  database.transaction((db) => {
    db.prepare("DELETE FROM patent_auxiliary_documents WHERE patent_id = ?").run(imported.patentId);
    db.prepare("DELETE FROM patent_import_reports WHERE patent_id = ?").run(imported.patentId);
  });
  const recovered = await recovery.recoverPatent(imported.patentId);
  expect(recovered.repairedPersistedState).toBe(true);
  expect(recovered.patent.auxiliaryDocuments).toEqual(reopened.patent.auxiliaryDocuments);
  expect(recovered.patent.docxImportReport).toBeNull();

  const project = reopened.patent.flowchartProjects[0]!;
  const editedSource = Uint8Array.from(
    Buffer.from(
      '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0" value="继续编辑"/></root></mxGraphModel></diagram></mxfile>',
    ),
  );
  const saved = await flowcharts.save({
    patentId: imported.patentId,
    projectId: project.projectId,
    expectedPatentRevision: reopened.revision,
    expectedProjectRevision: project.revision,
    source: editedSource,
    pageCount: 1,
    lastPageId: "p1",
  });
  expect(flowcharts.load(imported.patentId, project.projectId).source).toEqual(editedSource);
  const auxiliary = reopened.patent.auxiliaryDocuments[0]!;
  const editedDocument = structuredClone(auxiliary.document);
  const paragraph = editedDocument.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("missing paragraph");
  paragraph.content.push({ type: "text", text: "继续编辑附加文档", marks: [] });
  await patents.applyAuxiliaryDocumentEdit({
    patentId: imported.patentId,
    sessionId: reopened.sessionId,
    auxiliaryDocumentId: auxiliary.auxiliaryDocumentId,
    expectedRevision: saved.patentRevision,
    document: editedDocument,
    editorState: auxiliary.editorState,
    assets: reopened.patent.assets,
  });
  const updated = await patents.open(imported.patentId);
  expect(updated.patent.auxiliaryDocuments[0]!.document).toEqual(editedDocument);
  const exportAgain = join(root, "again.patdoc");
  expect(
    (
      await new FileService().savePatent(exportAgain, {
        patent: updated.patent,
        assets: await Promise.all(
          updated.patent.assets.map((asset) => assetStore.readAsset(asset.assetId)),
        ),
        flowcharts: updated.patent.flowchartProjects.map((item) => ({
          projectId: item.projectId,
          source: flowcharts.exportBackup(imported.patentId, item.projectId),
        })),
      })
    ).ok,
  ).toBe(true);
  expect((await readPatdoc<PatentPatdocPayload>(exportAgain)).patent).toEqual(updated.patent);
});

test("import keeps a stale flowchart preview stale instead of relabeling it as current", async () => {
  const { database, assetStore, patents, flowcharts } = await services();
  using _database = database;
  const payload = await fixture();
  payload.patent.figures[0]!.flowchartLink!.exportedSourceSha256 = "A".repeat(64);
  const imported = await importPatentPatdocPayload(
    patents,
    assetStore,
    async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
    payload,
    flowcharts,
  );
  expect(imported.patent.figures[0]!.flowchartLink!.exportedSourceSha256).toBe("A".repeat(64));
});

test("failed attachment restoration retains the incomplete import in trash and leaves existing data intact", async () => {
  const { root, database, assetStore, patents, flowcharts } = await services();
  using _database = database;
  const existing = await patents.create({
    patentType: "invention",
    name: "不能受影响",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const payload = await fixture();
  const path = join(root, "original.patdoc");
  await writePatdoc(path, payload);
  const before = await readFile(path);
  database.transaction((db) =>
    db.exec(
      "CREATE TEMP TRIGGER reject_attachment BEFORE INSERT ON patent_auxiliary_documents BEGIN SELECT RAISE(ABORT, 'attachment write failed'); END",
    ),
  );
  await expect(
    importPatentPatdocPayload(
      patents,
      assetStore,
      async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      payload,
      flowcharts,
    ),
  ).rejects.toThrow("attachment write failed");
  expect((await patents.list("active")).map((item) => item.patentId)).toEqual([existing.patentId]);
  const trash = await patents.list("trash");
  expect(trash).toHaveLength(1);
  expect(trash[0]!.patentId).not.toBe(existing.patentId);
  await expect(patents.permanentlyDelete(trash[0]!.patentId)).rejects.toThrow();
  expect((await patents.open(existing.patentId)).patent).toEqual(existing.patent);
  expect(await readFile(path)).toEqual(before);
});

test.each(["report-only", "documents-only"] as const)(
  "restores %s archives without requiring the other field",
  async (mode) => {
    const { database, assetStore, patents } = await services();
    using _database = database;
    const payload = await fixture();
    payload.patent.flowchartProjects = [];
    payload.flowcharts = [];
    payload.patent.figures = [];
    payload.patent.abstractDrawingFigureId = null;
    if (mode === "report-only") payload.patent.auxiliaryDocuments = [];
    else payload.patent.docxImportReport = null;
    const imported = await importPatentPatdocPayload(
      patents,
      assetStore,
      async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      payload,
    );
    expect(imported.patent.docxImportReport).toBeNull();
    expect(imported.patent.auxiliaryDocuments.map((item) => item.document)).toEqual(
      payload.patent.auxiliaryDocuments.map((item) => item.document),
    );
  },
);

test("import keeps independent chemical preview and CAD references in auxiliary documents too", async () => {
  const { database, assetStore, patents, flowcharts } = await services();
  using _database = database;
  const payload = await fixture();
  payload.patent.drawingProjects = [drawingProjectFixture(payload.assets[0]!.descriptor.assetId)];
  payload.patent.drawingProjects[0]!.regions[0]!.bodyAssetId =
    payload.assets[0]!.descriptor.assetId;
  const existing = await patents.create({
    patentType: "invention",
    name: "已有资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const replacementId = randomUUID();
  await assetStore.install(
    { kind: "patent", patentId: existing.patentId },
    {
      ...payload.assets[0]!,
      descriptor: { ...payload.assets[0]!.descriptor, assetId: replacementId },
    },
  );
  const imported = await importPatentPatdocPayload(
    patents,
    assetStore,
    async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
    payload,
    flowcharts,
  );
  const chemical = imported.patent.auxiliaryDocuments[0]!.document.content.find(
    (node) => node.type === "chemical-structure",
  );
  const ownId = payload.assets[0]!.descriptor.assetId;
  expect(ownId).not.toBe(replacementId);
  expect(chemical).toMatchObject({ previewAssetId: ownId });
  expect(imported.patent.assets.map((asset) => asset.assetId)).toEqual([ownId]);
  expect(imported.patent.drawingProjects).toHaveLength(1);
  expect(imported.patent.drawingProjects[0]).toMatchObject({
    sourceAssetId: ownId,
    baseAssetId: ownId,
    regions: [expect.objectContaining({ bodyAssetId: ownId })],
  });
  expect((await patents.open(imported.patentId)).patent.drawingProjects).toEqual(
    imported.patent.drawingProjects,
  );
  expect((await assetStore.readAsset(replacementId)).original).toEqual(payload.assets[0]!.original);
  expect((await assetStore.readAsset(ownId)).preview).toEqual(payload.assets[0]!.preview);
});

test("rejects damaged flowchart source bytes without overwriting the existing PATDOC", async () => {
  const path = join(await directory(), "safe.patdoc");
  const payload = await fixture();
  const service = new FileService();
  expect((await service.savePatent(path, payload)).ok).toBe(true);
  const before = await readFile(path);
  payload.flowcharts![0]!.source[0] = 0;
  expect((await service.savePatent(path, payload)).ok).toBe(false);
  expect(await readFile(path)).toEqual(before);
});
