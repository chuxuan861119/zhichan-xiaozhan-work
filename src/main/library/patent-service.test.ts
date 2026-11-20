import { mkdtemp, rm } from "node:fs/promises";
import { createPatdocFidelityPayload } from "../../../tests/fixtures/patdoc-fidelity.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { AssetStore } from "./asset-store.js";

test("persists drawing drafts across figure edits, book edits and reload", async () => {
  const { service, assetDescriptors, database } = await openService({
    value: new Date("2026-09-13T00:00:00Z"),
  });
  const opened = await service.create({
    patentType: "utility-model",
    name: "图纸保存",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = asset(1);
  assetDescriptors.set(source.assetId, source);
  database.transaction((db) =>
    db
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        source.assetId,
        source.sha256,
        "source.asset",
        source.mediaType,
        source.byteLength,
        source.widthPx,
        source.heightPx,
        "2026-09-13T00:00:00Z",
      ),
  );
  const figures = [
    { figureId: testUuid(999), assetId: source.assetId, widthMm: 90, rotationDeg: 90 as const },
  ];
  const project = drawingProjectFixture(source.assetId);
  project.nextLabel = "43";
  project.repeatLabel = true;
  const ack = await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: 0,
    figures,
    abstractDrawingFigureId: null,
    assets: [source],
    drawingProjects: [project],
  });
  expect((await service.open(opened.patentId)).patent.drawingProjects).toEqual([project]);
  const second = { ...project, projectId: "00000000-0000-4000-8000-000000000802" };
  const added = await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: ack.revision,
    figures,
    abstractDrawingFigureId: null,
    assets: [source],
    drawingProjectEdits: { projectIds: [project.projectId, second.projectId], projects: [second] },
  });
  const changed = { ...project, warnings: ["保留 CAD 导入警告"], revision: 1 };
  const patched = await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: added.revision,
    figures,
    abstractDrawingFigureId: null,
    assets: [source],
    drawingProjectEdits: { projectIds: [second.projectId, project.projectId], projects: [changed] },
  });
  const persisted = (await service.open(opened.patentId)).patent;
  expect(persisted.drawingProjects).toEqual([second, changed]);
  expect(persisted.figures).toEqual(figures);
  const recovered = await new LibraryRecoveryService({ database }).recoverPatent(opened.patentId);
  expect(recovered.patent?.drawingProjects).toEqual([second, changed]);
  await expect(
    service.applyFigureEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      figures,
      abstractDrawingFigureId: null,
      assets: [source],
      drawingProjectEdits: { projectIds: ["00000000-0000-4000-8000-000000000803"], projects: [] },
    }),
  ).rejects.toThrow();
  const next = await service.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: patched.revision,
    figures,
    abstractDrawingFigureId: null,
    assets: [source],
    drawingProjectEdits: { projectIds: [project.projectId], projects: [project] },
  });
  const book = opened.patent.books[0]!;
  await service.applyBookEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: next.revision,
    bookKind: book.kind,
    document: book.document,
    editorState: {},
    assets: [source],
  });
  expect((await service.open(opened.patentId)).patent.drawingProjects).toEqual([project]);
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssetDescriptor,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type PatentBookDocument,
} from "../../shared/document/model.js";
import { createImportedPatent } from "../../shared/patent/defaults.js";
import type { AuxiliaryDocument } from "../../shared/patent/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { decodeEnvelope, encodeEnvelope, hashJson } from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { PatentService } from "./patent-service.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";
import { LibraryRecoveryService } from "./recovery-service.js";

test("a known book save refreshes one summary but unrelated same-revision damage still invalidates the library", async () => {
  const { service, database } = await openService({ value: new Date("2026-10-04T00:00:00Z") });
  const opened: Awaited<ReturnType<PatentService["create"]>>[] = [];
  for (let i = 0; i < 40; i++)
    opened.push(
      await service.create({
        patentType: "invention",
        name: `增量列表 ${i}`,
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      }),
    );
  await service.list("active");
  const first = opened[0]!;
  const book = first.patent.books[0]!;
  await service.applyBookEdit({
    patentId: first.patentId,
    sessionId: first.sessionId,
    expectedRevision: first.revision,
    bookKind: book.kind,
    document: book.document,
    editorState: {},
  });
  const reads = vi.spyOn(database, "read");
  const summaries = await service.list("active");
  expect(summaries).toHaveLength(40);
  expect(summaries.find((item) => item.patentId === first.patentId)?.revision).toBe(1);
  expect(reads.mock.calls.length).toBeLessThan(30);
  reads.mockRestore();
  database.transaction((db) =>
    db
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ?")
      .run(Buffer.from("corrupt"), opened[1]!.patentId),
  );
  const after = await service.list("active");
  expect(after.find((item) => item.patentId === opened[1]!.patentId)?.recoveryState).toBe(
    "quarantined",
  );
});

test("reuses a complete library snapshot above the per-patent cache capacity and invalidates writes", async () => {
  const { service, database } = await openService({ value: new Date("2026-10-04T00:00:00Z") });
  for (let index = 0; index < 2050; index++) {
    await service.create({
      patentType: "invention",
      name: `缓存专利 ${index}`,
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
  }
  const inspect = vi.fn(() => ({ issues: [] }));
  const listing = new PatentService({ database, inspectPatent: inspect });
  const first = await listing.list("active");
  inspect.mockClear();
  const second = await listing.list("active");
  expect(second).toEqual(first);
  expect(inspect.mock.calls.length).toBe(0);
  second[0]!.name = "仅修改返回值";
  expect((await listing.list("active"))[0]!.name).not.toBe("仅修改返回值");
  database.transaction((db) =>
    db
      .prepare("UPDATE patents SET name = ? WHERE patent_id = ?")
      .run("数据库内新名称", first[0]!.patentId),
  );
  expect((await listing.list("active"))[0]!.name).toBe("数据库内新名称");
}, 30_000);

test("book saves reuse unchanged verified documents but detect same-revision database corruption", async () => {
  const { service, database } = await openService({ value: new Date("2026-10-04T00:00:00Z") });
  const opened = await service.create({
    patentType: "invention",
    name: "保存缓存保护",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = opened.patent.books.find((book) => book.kind === "description")!;
  const document = {
    ...description.document,
    content: [
      {
        ...description.document.content.find((block) => block.type === "paragraph")!,
        content: [{ type: "text" as const, text: "不应反复解析的说明书", marks: [] }],
      },
    ],
  };
  const ack = await service.applyBookEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: 0,
    bookKind: "description",
    document,
    editorState: {},
  });
  const claims = opened.patent.books.find((book) => book.kind === "claims")!;
  const originalParse = JSON.parse;
  const parse = vi.spyOn(JSON, "parse");
  let descriptionParses = 0;
  parse.mockImplementation((value, reviver) => {
    if (String(value).includes("不应反复解析的说明书")) descriptionParses++;
    return originalParse(value, reviver);
  });
  let saved: Awaited<ReturnType<PatentService["applyBookEdit"]>> | undefined;
  try {
    saved = await service.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: ack.revision,
      bookKind: "claims",
      document: claims.document,
      editorState: {},
    });
  } finally {
    parse.mockRestore();
  }
  expect(descriptionParses).toBe(0);
  expect(
    (await service.open(opened.patentId)).patent.books.find((book) => book.kind === "description")!
      .document.content,
  ).toEqual(document.content);
  database.transaction((db) =>
    db
      .prepare(
        "UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'description'",
      )
      .run(Buffer.from("invalid"), opened.patentId),
  );
  await expect(
    service.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: saved!.revision,
      bookKind: "claims",
      document: claims.document,
      editorState: {},
    }),
  ).rejects.toThrow();
});

const roots: string[] = [];
const databases: LibraryDatabase[] = [];

test("protects trashed patents for 24 hours and restarts protection after restoring", async () => {
  const now = { value: new Date("2026-09-13T00:00:00Z") };
  const { service } = await openService(now);
  const patent = await service.create({
    patentType: "invention",
    name: "保护测试",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.release(patent.sessionId);
  await service.moveToTrash(patent.patentId);
  now.value = new Date("2026-09-13T23:59:59.999Z");
  await expect(service.permanentlyDelete(patent.patentId)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(await service.list("trash")).toHaveLength(1);
  await service.restore(patent.patentId);
  await service.moveToTrash(patent.patentId);
  now.value = new Date("2026-09-14T00:00:00Z");
  await expect(service.permanentlyDelete(patent.patentId)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  now.value = new Date("2026-09-14T23:59:59.999Z");
  await service.permanentlyDelete(patent.patentId);
  expect(await service.list("trash")).toHaveLength(0);
});

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

test("imports a bundle atomically and refuses an unconfirmed duplicate", async () => {
  const { service } = await openService({ value: new Date("2026-09-13T00:00:00Z") });
  const first = await service.create({
    patentType: "invention",
    name: "原专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = structuredClone(first.patent);
  second.patentId = testUuid(600);
  second.books.forEach((book, index) => {
    book.bookId = testUuid(610 + index);
  });
  const input = {
    bundleId: testUuid(700),
    patents: [{ patent: second, assets: [], flowcharts: [] }],
  };
  await service.importBundle(input);
  expect(await service.list("active")).toHaveLength(2);
  await expect(service.importBundle(input)).rejects.toThrow();
  const third = structuredClone(second);
  third.patentId = testUuid(800);
  third.books.forEach((book, index) => {
    book.bookId = testUuid(810 + index);
  });
  await expect(
    service.importBundle({
      bundleId: testUuid(701),
      patents: [
        { patent: third, assets: [], flowcharts: [] },
        { patent: second, assets: [], flowcharts: [] },
      ],
    }),
  ).rejects.toThrow();
  expect(await service.list("active")).toHaveLength(2);
});

function asset(index: number): AssetDescriptor {
  return {
    assetId: testUuid(900 + index),
    kind: "image",
    originalName: `figure-${index}.png`,
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

function withParagraph(document: PatentBookDocument, text: string): PatentBookDocument {
  return {
    ...document,
    content: [
      {
        id: testUuid(850),
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text, marks: [] }],
      },
    ],
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openService(
  now: { value: Date },
  collectUnusedAssets: (patentId: string) => Promise<void> | void = () => undefined,
  adoptAsset: (owner: unknown, assetId: string) => Promise<void> = () => {
    throw new Error("adopt not configured");
  },
  snapshots?: {
    recordEdit(patentId: string): void;
    flush(patentId: string): Promise<unknown>;
  },
  preparePermanentDelete?: (patentId: string) => Promise<() => void>,
) {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let uuid = 100;
  const assetDescriptors = new Map<string, AssetDescriptor>();
  const serviceOptions = {
    database: prepared.database,
    now: () => now.value,
    randomUUID: () => testUuid(uuid++),
    collectUnusedAssets,
    adoptAsset,
    assetStore: {
      async readAsset(assetId: string) {
        const descriptor = assetDescriptors.get(assetId);
        if (!descriptor) throw new Error("asset fixture missing");
        return {
          descriptor: structuredClone(descriptor),
          preview: Uint8Array.from([descriptor.assetId === testUuid(902) ? 2 : 1]),
        };
      },
    },
    ...(snapshots ? { snapshots } : {}),
    ...(preparePermanentDelete ? { preparePermanentDelete } : {}),
  };
  const service = new PatentService(serviceOptions);
  return { assetDescriptors, collectUnusedAssets, database: prepared.database, service };
}

test("preserves source patents if search-cache cleanup fails for permanent or scheduled deletion", async () => {
  const now = { value: new Date("2026-09-01T00:00:00Z") };
  const { service } = await openService(now, undefined, undefined, undefined, async () => {
    throw new Error("cache cleanup failed");
  });
  const created = await service.create({
    patentType: "invention",
    name: "清理失败保护",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.release(created.sessionId);
  await service.moveToTrash(created.patentId);
  now.value = new Date("2027-10-03T00:00:00Z");
  await expect(service.permanentlyDelete(created.patentId)).rejects.toThrow("cache cleanup failed");
  await expect(service.purgeExpired()).rejects.toThrow("cache cleanup failed");
  expect((await service.list("trash")).map((p) => p.patentId)).toContain(created.patentId);
});

test("holds the search pause until source deletion commits and then releases it", async () => {
  const now = { value: new Date("2026-09-01T00:00:00Z") };
  let releaseChecked = false;
  const prepared = await openService(now, undefined, undefined, undefined, async (id) => {
    expect((await prepared.service.list("trash")).map((p) => p.patentId)).toContain(id);
    return () => {
      expect(
        prepared.database.read((db) =>
          db.prepare("SELECT 1 FROM patents WHERE patent_id=?").get(id),
        ),
      ).toBeUndefined();
      releaseChecked = true;
    };
  });
  const created = await prepared.service.create({
    patentType: "invention",
    name: "删除顺序",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await prepared.service.release(created.sessionId);
  await prepared.service.moveToTrash(created.patentId);
  now.value = new Date("2026-09-03T00:00:00Z");
  await prepared.service.permanentlyDelete(created.patentId);
  expect(releaseChecked).toBe(true);
});

function auxiliaryDocument(
  source: PatentBookDocument,
  id = testUuid(801),
  title = "其他材料",
): AuxiliaryDocument {
  return {
    auxiliaryDocumentId: id,
    title,
    document: {
      ...structuredClone(source),
      documentId: testUuid(802),
      title,
      content: [],
    },
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
    sourceFileName: "其他材料.docx",
  };
}

test("persists drawing explanation drafts independently of deleting description content", async () => {
  const { service } = await openService({ value: new Date("2026-09-11T00:00:00.000Z") });
  const created = await service.create({
    patentType: "invention",
    name: "独立附图说明",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const drawingBook = created.patent.books.find((book) => book.kind === "description-drawings");
  const descriptionBook = created.patent.books.find((book) => book.kind === "description");
  if (!drawingBook || !descriptionBook) throw new Error("Missing books fixture");
  const editorState = {
    drawingExplanationDrafts: {
      [testUuid(901)]: {
        figureNumber: 1,
        value: "图1为独立保存的结构示意图。",
      },
    },
  };
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    bookKind: "description-drawings",
    document: drawingBook.document,
    editorState,
    assets: [],
  });
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 1,
    bookKind: "description",
    document: { ...descriptionBook.document, content: [] },
    editorState: descriptionBook.editorState,
    assets: [],
  });
  const saved = service.loadSavedPatent(created.patentId);
  expect(saved.books.find((book) => book.kind === "description-drawings")?.editorState).toEqual(
    editorState,
  );
  expect(saved.books.find((book) => book.kind === "description")?.document.content).toEqual([]);
});

test("appends imported documents atomically and retries without changing existing books", async () => {
  const { service, database } = await openService({ value: new Date("2026-09-04T00:00:00.000Z") });
  const created = await service.create({
    patentType: "invention",
    name: "已有专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = created.patent.books[0];
  if (!source) throw new Error("fixture");
  await service.createAuxiliaryDocument({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    document: auxiliaryDocument(source.document, testUuid(879), "原有材料"),
  });
  const before = service.loadSavedPatent(created.patentId);
  const input = {
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 1,
    operationId: testUuid(880),
    documents: [
      auxiliaryDocument(source.document, testUuid(881), "材料一"),
      auxiliaryDocument(source.document, testUuid(882), "材料二"),
    ],
    assets: [],
  };
  input.documents.forEach((document, index) => {
    document.document.documentId = testUuid(890 + index);
  });
  database.transaction((db) =>
    db.exec(
      "CREATE TEMP TRIGGER fail_append BEFORE INSERT ON library_state WHEN NEW.key LIKE 'docx-append-operation:%' BEGIN SELECT RAISE(ABORT, 'append failure'); END",
    ),
  );
  await expect(service.appendImportedDocuments(input)).rejects.toThrow("append failure");
  expect(service.loadSavedPatent(created.patentId)).toEqual(before);
  database.transaction((db) => db.exec("DROP TRIGGER fail_append"));
  const appended = await service.appendImportedDocuments(input);
  expect(appended.patent.books).toEqual(created.patent.books);
  expect(appended.patent.name).toBe("已有专利");
  expect(appended.patent.auxiliaryDocuments.map((document) => document.title)).toEqual([
    "原有材料",
    "材料一",
    "材料二",
  ]);
  expect(appended.patent.auxiliaryDocuments[0]).toEqual(before.auxiliaryDocuments[0]);
  expect(appended.revision).toBe(2);
  const retried = await service.appendImportedDocuments(input);
  expect(retried.patent).toEqual(appended.patent);
  await service.moveAuxiliaryDocument({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 2,
    auxiliaryDocumentId: testUuid(882),
    direction: "up",
  });
  expect(
    service.loadSavedPatent(created.patentId).auxiliaryDocuments.map((item) => item.title),
  ).toEqual(["原有材料", "材料二", "材料一"]);
  await expect(
    service.renameAuxiliaryDocument({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: 3,
      auxiliaryDocumentId: testUuid(881),
      title: "原有材料",
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    service.appendImportedDocuments({ ...input, operationId: testUuid(883) }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(service.loadSavedPatent(created.patentId).revision).toBe(3);
});

test("creates, edits, renames, and deletes an auxiliary document with aggregate revisions", async () => {
  const now = { value: new Date("2026-08-31T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "其他文档",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = created.patent.books[0];
  if (!source) throw new Error("fixture");
  const auxiliary = auxiliaryDocument(source.document);

  const added = await service.createAuxiliaryDocument({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    document: auxiliary,
  });
  expect(added.revision).toBe(1);
  expect(service.loadSavedPatent(created.patentId).auxiliaryDocuments).toEqual([
    expect.objectContaining({ title: "其他材料", persistedRevision: 1 }),
  ]);

  const edited = await service.applyAuxiliaryDocumentEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    auxiliaryDocumentId: auxiliary.auxiliaryDocumentId,
    expectedRevision: 1,
    document: withParagraph(auxiliary.document, "补充试验数据。"),
    editorState: { selection: { from: 1, to: 1 } },
    assets: [],
  });
  expect(edited.revision).toBe(2);

  const renamed = await service.renameAuxiliaryDocument({
    patentId: created.patentId,
    sessionId: created.sessionId,
    auxiliaryDocumentId: auxiliary.auxiliaryDocumentId,
    expectedRevision: 2,
    title: "补充试验数据",
  });
  expect(renamed.revision).toBe(3);
  const saved = service.loadSavedPatent(created.patentId).auxiliaryDocuments[0];
  expect(saved?.title).toBe("补充试验数据");
  expect(saved?.document.title).toBe("补充试验数据");

  const deleted = await service.deleteAuxiliaryDocument({
    patentId: created.patentId,
    sessionId: created.sessionId,
    auxiliaryDocumentId: auxiliary.auxiliaryDocumentId,
    expectedRevision: 3,
  });
  expect(deleted.revision).toBe(4);
  expect(service.loadSavedPatent(created.patentId).auxiliaryDocuments).toEqual([]);
});

test("persists imported drawing deletion and undo without reviving duplicate nodes", async () => {
  const now = { value: new Date("2026-10-10T00:00:00Z") };
  const { service, database, assetDescriptors } = await openService(now);
  const patent = createImportedPatent({ patentType: "invention", name: "删除导入附图" });
  const image = asset(1);
  assetDescriptors.set(image.assetId, image);
  database.transaction((db) =>
    db
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        image.assetId,
        image.sha256,
        `${image.sha256}.asset`,
        image.mediaType,
        image.byteLength,
        image.widthPx,
        image.heightPx,
        now.value.toISOString(),
      ),
  );
  patent.assets = [image];
  const figure = {
    figureId: testUuid(987),
    assetId: image.assetId,
    widthMm: 80,
    rotationDeg: 0 as const,
  };
  patent.figures = [figure];
  patent.abstractDrawingFigureId = figure.figureId;
  for (const book of patent.books.filter(
    (book) => book.kind === "description-drawings" || book.kind === "abstract-drawing",
  )) {
    book.document.content = [
      {
        id: testUuid(986),
        type: "figure",
        assetId: image.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ];
  }
  const opened = await service.createImported({ patent, operationId: testUuid(985) });
  const input = { patentId: opened.patentId, sessionId: opened.sessionId, assets: [image] };
  await service.applyFigureEdit({
    ...input,
    expectedRevision: 0,
    figures: [],
    abstractDrawingFigureId: null,
  });
  const deleted = service.loadSavedPatent(opened.patentId);
  expect(deleted.figures).toEqual([]);
  for (const book of deleted.books.filter(
    (book) => book.kind === "description-drawings" || book.kind === "abstract-drawing",
  )) {
    expect(book.document.content).toEqual([]);
    expect(book.editorState.canonicalDrawingsNormalized).toBe(true);
  }
  await service.applyFigureEdit({
    ...input,
    expectedRevision: 1,
    figures: [figure],
    abstractDrawingFigureId: figure.figureId,
  });
  const restored = service.loadSavedPatent(opened.patentId);
  expect(restored.figures).toEqual([figure]);
  expect(
    restored.books.find((book) => book.kind === "description-drawings")?.document.content,
  ).toEqual([]);
  const recovered = await new LibraryRecoveryService({ database }).recoverPatent(opened.patentId);
  expect(recovered.patent.figures).toEqual([figure]);
  expect(
    recovered.patent.books.find((book) => book.kind === "description-drawings")?.document.content,
  ).toEqual([]);
});

test("atomically creates an imported patent with its report and auxiliary documents", async () => {
  const now = { value: new Date("2026-08-31T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  let sequence = 1_000;
  const patent = createImportedPatent(
    { patentType: "invention", name: "导入专利" },
    { now: () => now.value, createId: () => testUuid(sequence++) },
  );
  const source = patent.books[0];
  if (!source) throw new Error("fixture");
  patent.auxiliaryDocuments = [auxiliaryDocument(source.document)];
  patent.docxImportReport = {
    importedAt: now.value.toISOString(),
    sourceFileNames: ["五书.docx"],
    assignments: [],
    warnings: [],
  };
  const importedAsset = asset(1);
  const figureId = testUuid(898);
  assetDescriptors.set(importedAsset.assetId, importedAsset);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        importedAsset.assetId,
        importedAsset.sha256,
        `${importedAsset.sha256}.asset`,
        importedAsset.mediaType,
        importedAsset.byteLength,
        importedAsset.widthPx,
        importedAsset.heightPx,
        now.value.toISOString(),
      );
  });
  patent.assets = [importedAsset];
  patent.figures = [{ figureId, assetId: importedAsset.assetId, widthMm: 80, rotationDeg: 90 }];
  patent.abstractDrawingFigureId = figureId;

  const opened = await service.createImported({ patent, operationId: testUuid(899) });

  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT asset_id FROM snapshot_assets WHERE patent_id = ? AND revision = 0")
        .all(opened.patentId),
    ),
  ).toEqual([{ asset_id: importedAsset.assetId }]);
  expect(opened.patent.auxiliaryDocuments).toHaveLength(1);
  expect(opened.patent.docxImportReport?.sourceFileNames).toEqual(["五书.docx"]);
  expect(service.loadSavedPatent(opened.patentId).figures).toEqual(patent.figures);
  const description = opened.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  await expect(
    service.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      bookKind: "description",
      expectedRevision: 0,
      document: withParagraph(description.document, "导入后继续编辑。"),
      editorState: {},
      assets: [importedAsset],
    }),
  ).resolves.toMatchObject({ revision: 1 });
  const counts = database.read((raw) => ({
    patents: (raw.prepare("SELECT COUNT(*) AS count FROM patents").get() as { count: number })
      .count,
    auxiliary: (
      raw.prepare("SELECT COUNT(*) AS count FROM patent_auxiliary_documents").get() as {
        count: number;
      }
    ).count,
    reports: (
      raw.prepare("SELECT COUNT(*) AS count FROM patent_import_reports").get() as { count: number }
    ).count,
    figures: (
      raw.prepare("SELECT COUNT(*) AS count FROM patent_figures").get() as { count: number }
    ).count,
  }));
  expect(counts).toEqual({ patents: 1, auxiliary: 1, reports: 1, figures: 1 });
  const recovered = await new LibraryRecoveryService({ database }).recoverPatent(opened.patentId);
  expect(recovered.patent.figures).toEqual(patent.figures);
  expect(recovered.patent.docxImportReport).toEqual(patent.docxImportReport);
  const legacy = structuredClone(recovered.patent);
  for (const figure of legacy.figures) delete figure.rotationDeg;
  database.transaction((raw) => {
    raw.prepare("DELETE FROM edit_log WHERE patent_id = ?").run(opened.patentId);
    // This fixture rewrites the recovery revision; move its resource links with it.
    raw.prepare("DELETE FROM snapshot_assets WHERE patent_id = ?").run(opened.patentId);
    raw
      .prepare(
        "UPDATE snapshots SET revision = ?, model_version = 2, payload = ?, content_hash = ? WHERE patent_id = ?",
      )
      .run(legacy.revision, encodeEnvelope(encodeJson(legacy)), hashJson(legacy), opened.patentId);
    raw
      .prepare("INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, ?, ?)")
      .run(opened.patentId, legacy.revision, importedAsset.assetId);
  });
  const legacyRecovered = await new LibraryRecoveryService({ database }).recoverPatent(
    opened.patentId,
  );
  expect(legacyRecovered.patent.figures.map((figure) => figure.rotationDeg)).toEqual([0]);
});

test("reuses an imported patent when the same DOCX operation is retried", async () => {
  const now = { value: new Date("2026-08-31T09:00:00.000Z") };
  const { database, service } = await openService(now);
  let sequence = 1_100;
  const patent = createImportedPatent(
    { patentType: "invention", name: "幂等导入" },
    { now: () => now.value, createId: () => testUuid(sequence++) },
  );
  const operationId = testUuid(899);

  const first = await service.createImported({ patent, operationId });
  const retried = await service.createImported({ patent, operationId });

  expect(retried.patentId).toBe(first.patentId);
  expect(retried.sessionId).not.toBe(first.sessionId);
  expect(retried.patent).toEqual(first.patent);
  const counts = database.read((raw) => ({
    patents: (raw.prepare("SELECT COUNT(*) AS count FROM patents").get() as { count: number })
      .count,
    operations: (
      raw
        .prepare("SELECT COUNT(*) AS count FROM library_state WHERE key = ?")
        .get(`docx-import-operation:${operationId}`) as { count: number }
    ).count,
  }));
  expect(counts).toEqual({ patents: 1, operations: 1 });
});

test("does not report a committed patent edit to the snapshot service", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const recordEdit = vi.fn();
  const { service } = await openService(now, undefined, undefined, {
    recordEdit,
    flush: vi.fn(),
  });
  const created = await service.create({
    patentType: "invention",
    name: "编辑快照通知",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: created.revision,
    document: withParagraph(claims.document, "1. 一种夹具。"),
    editorState: {},
  });

  expect(recordEdit).not.toHaveBeenCalled();
});

test("flush verifies persisted revision without calling the snapshot service", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const snapshotFlush = vi.fn();
  const { service } = await openService(now, undefined, undefined, {
    recordEdit: vi.fn(),
    flush: snapshotFlush,
  });
  const created = await service.create({
    patentType: "invention",
    name: "显式保存快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(service.flush(created.patentId, created.revision)).resolves.toMatchObject({
    patentId: created.patentId,
    revision: created.revision,
  });
  expect(snapshotFlush).not.toHaveBeenCalled();
});

test("revision conflicts do not schedule or flush a snapshot", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const recordEdit = vi.fn();
  const snapshotFlush = vi.fn();
  const { service } = await openService(now, undefined, undefined, {
    recordEdit,
    flush: snapshotFlush,
  });
  const created = await service.create({
    patentType: "invention",
    name: "冲突不写快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: created.revision,
    document: withParagraph(claims.document, "1. 一种夹具。"),
    editorState: {},
  });
  recordEdit.mockClear();

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "claims",
      expectedRevision: created.revision,
      document: withParagraph(claims.document, "1. 过期编辑。"),
      editorState: {},
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(service.flush(created.patentId, created.revision)).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
  });
  expect(recordEdit).not.toHaveBeenCalled();
  expect(snapshotFlush).not.toHaveBeenCalled();
});

test("does not report other committed patent revisions to the snapshot service", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const recordEdit = vi.fn();
  const { service } = await openService(now, undefined, undefined, {
    recordEdit,
    flush: vi.fn(),
  });
  const created = await service.create({
    patentType: "invention",
    name: "所有修订入口",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const settings = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "修改名称",
    patentType: "invention",
  });
  const drawings = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: settings.revision,
    enabled: false,
  });
  const figures = await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: drawings.patent.revision,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
  });
  const flowchart = await service.mutateFlowcharts({
    patentId: created.patentId,
    expectedRevision: figures.revision,
    mutation: () => ({ changed: true, value: "changed" }),
  });
  await service.mutateFlowcharts({
    patentId: created.patentId,
    expectedRevision: flowchart.patent.revision,
    mutation: () => ({ changed: false, value: "unchanged" }),
  });

  expect(recordEdit).not.toHaveBeenCalled();
});

test("preserves an existing customer when a partial settings update changes reference marks", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "客户保留测试",
    customer: "华东机械有限公司",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: created.revision,
    patentType: "invention",
    referenceMarks: [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009981",
        number: 1,
        keyword: "箱体",
      },
    ],
    referenceMarkSettings: { synchronizedEditingEnabled: false },
  });

  expect((await service.open(created.patentId)).patent.customer).toBe("华东机械有限公司");
});

test("persists 100 book edits and edit-log revisions without creating full snapshots", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "持续保存不生成快照",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  for (let revision = 1; revision <= 100; revision += 1) {
    await service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "claims",
      expectedRevision: revision - 1,
      document: withParagraph(claims.document, `第 ${revision} 次持续保存`),
      editorState: {},
    });
  }
  now.value = new Date(now.value.getTime() + 1_001);

  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT revision FROM snapshots WHERE patent_id = ? ORDER BY revision")
        .all(created.patentId),
    ),
  ).toEqual([{ revision: 0 }]);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT target_revision FROM edit_log WHERE patent_id = ? ORDER BY target_revision",
        )
        .all(created.patentId),
    ),
  ).toEqual(Array.from({ length: 100 }, (_, index) => ({ target_revision: index + 1 })));
});

test("creates one patent aggregate with exactly five persisted books", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);

  const created = await service.create({
    patentType: "utility-model",
    name: null,
    customer: "  持久化客户  ",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  expect(created.patent.books.map((book) => book.kind)).toEqual([
    "claims",
    "description",
    "description-drawings",
    "abstract",
    "abstract-drawing",
  ]);
  expect(created.patent.activeBookKind).toBe("description");
  expect(created.patent.drawingBooksEnabled).toBe(true);
  expect(created.patent.customer).toBe("持久化客户");
  expect(created.revision).toBe(0);
  expect(created.saveState).toBe("saved");
  expect(
    database.read((raw) =>
      raw.prepare("SELECT customer FROM patents WHERE patent_id = ?").get(created.patentId),
    ),
  ).toEqual({ customer: "持久化客户" });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT kind FROM patent_books WHERE patent_id = ? ORDER BY rowid")
        .all(created.patentId),
    ),
  ).toEqual([
    { kind: "claims" },
    { kind: "description" },
    { kind: "description-drawings" },
    { kind: "abstract" },
    { kind: "abstract-drawing" },
  ]);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT source FROM snapshots WHERE patent_id = ? AND revision = 0")
        .get(created.patentId),
    ),
  ).toEqual({ source: "initial" });
});

test("persists a design-patent image and brief state through the active session", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(
    now,
    undefined,
    async () => undefined,
  );
  const created = await service.create({
    patentType: "design",
    name: "折叠椅",
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
        now.value.toISOString(),
      );
  });
  assetDescriptors.set(descriptor.assetId, descriptor);
  const designPatent = structuredClone(created.patent.designPatent);
  if (!designPatent) throw new Error("fixture");
  const viewId = testUuid(701);
  designPatent.views = [
    {
      viewId,
      kind: "front",
      label: "主视图",
      assetId: descriptor.assetId,
      expression: "line-drawing",
      subjectBounds: { leftPx: 0, topPx: 0, widthPx: 101, heightPx: 81 },
      operations: [],
      note: null,
    },
  ];
  designPatent.representativeViewId = viewId;
  designPatent.dimensionReferenceViewId = viewId;
  designPatent.primaryExpression = "line-drawing";
  designPatent.brief.productUse = "用于折叠收纳。";
  designPatent.brief.designPoints = ["shape"];

  const saved = await service.updateDesignPatent({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    designPatent,
    assets: [descriptor],
  });

  expect(saved.revision).toBe(1);
  expect((await service.open(created.patentId)).patent.designPatent).toEqual(designPatent);
  await expect(
    service.updateDesignPatent({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: 0,
      designPatent,
      assets: [descriptor],
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});

test("reads disabled invention drawing books from the database and reports them unavailable", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "无附图发明",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare("UPDATE patents SET drawing_books_enabled = 0 WHERE patent_id = ?")
      .run(created.patentId);
  });

  const opened = await service.open(created.patentId);
  const [summary] = await service.list("active");

  expect(opened.patent.drawingBooksEnabled).toBe(false);
  expect(summary?.bookStatuses).toMatchObject({
    "description-drawings": "unavailable",
    "abstract-drawing": "unavailable",
  });
});

test("atomically disables invention drawing books and returns the persisted aggregate", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const collected: string[] = [];
  const { database, service } = await openService(now, async (patentId) => {
    collected.push(patentId);
  });
  const created = await service.create({
    patentType: "invention",
    name: "删除附图事务",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const beforeDescription = created.patent.books.find((book) => book.kind === "description");
  if (!beforeDescription) throw new Error("fixture");

  const result = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
  });

  expect(result.patent).toMatchObject({
    drawingBooksEnabled: false,
    figures: [],
    abstractDrawingFigureId: null,
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: false },
    revision: 1,
  });
  expect(result.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    beforeDescription.document,
  );
  expect(result.patent.books.find((book) => book.kind === "description-drawings")?.bookId).not.toBe(
    created.patent.books.find((book) => book.kind === "description-drawings")?.bookId,
  );
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT drawing_books_enabled, revision FROM patents WHERE patent_id = ?")
        .get(created.patentId),
    ),
  ).toEqual({ drawing_books_enabled: 0, revision: 1 });
  expect(collected).toEqual([created.patentId]);
});

test("rejects closing utility-model drawing books without changing persisted state", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "utility-model",
    name: "实用新型",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(
    service.setDrawingBooksEnabled({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await service.open(created.patentId)).patent).toEqual(created.patent);
});

test("returns the planner-selected active book after enabling and disabling drawing books", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "活动书册",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const disabled = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
  });
  const enabled = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: disabled.patent.revision,
    enabled: true,
  });

  expect(disabled.patent.activeBookKind).toBe("description");
  expect(enabled.patent.activeBookKind).toBe("description-drawings");
});

test("atomically converts a utility model to an invention while closing drawing books", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "utility-model",
    name: "转换附图",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const result = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
    settings: {
      name: created.patent.name,
      customer: created.patent.customer,
      patentType: "invention",
      terminologyReplacementRequested: false,
    },
  });

  expect(result.patent).toMatchObject({ patentType: "invention", drawingBooksEnabled: false });
});

test("atomically restores drawing books when converting a drawing-free invention to utility model", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "无附图工艺",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const disabled = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
  });

  const restored = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: disabled.patent.revision,
    enabled: true,
    settings: {
      name: created.patent.name,
      customer: created.patent.customer,
      patentType: "utility-model",
      terminologyReplacementRequested: false,
    },
  });

  expect(restored.patent).toMatchObject({
    patentType: "utility-model",
    drawingBooksEnabled: true,
  });
  expect(restored.patent.books.map((book) => book.kind)).toContain("description-drawings");
  expect(restored.patent.books.map((book) => book.kind)).toContain("abstract-drawing");

  const convertedBack = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: restored.patent.revision,
    name: created.patent.name,
    patentType: "invention",
  });
  const reopened = await service.open(created.patentId);
  expect(convertedBack.revision).toBe(restored.patent.revision + 1);
  expect(reopened.patent).toMatchObject({ patentType: "invention", drawingBooksEnabled: true });
});

test("rolls back the entire drawing-book transition when an asset association delete fails", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "原子回滚",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    const descriptor = asset(88);
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
        now.value.toISOString(),
      );
    raw
      .prepare("INSERT INTO patent_assets(patent_id, asset_id) VALUES (?, ?)")
      .run(created.patentId, descriptor.assetId);
    raw.exec(`CREATE TRIGGER fail_drawing_asset_delete
      BEFORE DELETE ON patent_assets
      WHEN OLD.patent_id = '${created.patentId}'
      BEGIN SELECT RAISE(ABORT, 'forced asset association failure'); END;`);
  });

  await expect(
    service.setDrawingBooksEnabled({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      enabled: false,
    }),
  ).rejects.toThrow("forced asset association failure");
  expect((await service.open(created.patentId)).patent).toEqual(created.patent);
});

test("rejects drawing-book transitions for an unknown patent", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);

  await expect(
    service.setDrawingBooksEnabled({
      patentId: testUuid(999),
      sessionId: testUuid(998),
      expectedRevision: 0,
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("keeps a committed drawing-book transition successful when post-commit collection fails", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now, async () => {
    throw new Error("collector unavailable");
  });
  const created = await service.create({
    patentType: "invention",
    name: "回收失败",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(
    service.setDrawingBooksEnabled({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      enabled: false,
    }),
  ).resolves.toMatchObject({ patent: { drawingBooksEnabled: false } });
  expect((await service.open(created.patentId)).patent.drawingBooksEnabled).toBe(false);
});

test("keeps committed settings, book, and figure saves successful when collection fails", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const collectUnusedAssets = vi.fn(async () => {
    throw new Error("collector unavailable");
  });
  const { service } = await openService(now, collectUnusedAssets);
  const created = await service.create({
    patentType: "invention",
    name: "保存后清理失败",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  const settings = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: created.revision,
    name: "更新后的名称",
    patentType: "invention",
  });
  const book = await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: settings.revision,
    document: withParagraph(claims.document, "1. 一种夹具。"),
    editorState: {},
  });
  const figures = await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: book.revision,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
  });

  expect([settings.revision, book.revision, figures.revision]).toEqual([1, 2, 3]);
  expect((await service.open(created.patentId)).patent).toMatchObject({
    name: "更新后的名称",
    revision: 3,
  });
  // Text-only book saves cannot orphan assets; settings and figure saves still collect.
  expect(collectUnusedAssets).toHaveBeenCalledTimes(2);
});

test("persists a current patent book chemical preview asset atomically without creating a figure", async () => {
  const now = { value: new Date("2026-08-04T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "结构式原子保存",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(99);
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
        now.value.toISOString(),
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
        id: testUuid(899),
        type: "chemical-structure",
        ketSource: "(ket) (atom C)",
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

  const reopened = await service.open(created.patentId);
  expect(reopened.patent.assets).toEqual([preview]);
  expect(reopened.patent.figures).toEqual([]);
  expect(reopened.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    document,
  );
});

test("rejects a book asset owned by another patent without changing either aggregate", async () => {
  const now = { value: new Date("2026-08-04T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  const owner = await service.create({
    patentType: "invention",
    name: "资源所有者",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const target = await service.create({
    patentType: "invention",
    name: "错误引用者",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = target.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(101);
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
        now.value.toISOString(),
      );
    raw
      .prepare("INSERT INTO patent_assets (patent_id, asset_id) VALUES (?, ?)")
      .run(owner.patentId, preview.assetId);
  });
  assetDescriptors.set(preview.assetId, preview);
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(897),
        type: "chemical-structure",
        ketSource: "(ket) (atom O)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  await expect(
    service.applyBookEdit({
      patentId: target.patentId,
      sessionId: target.sessionId,
      bookKind: "description",
      expectedRevision: target.revision,
      document,
      editorState: {},
      assets: [preview],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect((await service.open(target.patentId)).patent).toEqual(target.patent);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT patent_id FROM patent_assets WHERE asset_id = ? ORDER BY patent_id")
        .all(preview.assetId),
    ),
  ).toEqual([{ patent_id: owner.patentId }]);
});

test("adopts a staged chemical preview resource on the first book edit", async () => {
  const now = { value: new Date("2026-08-04T10:00:00.000Z") };
  const adopted: Array<{ owner: unknown; assetId: string }> = [];
  let database: LibraryDatabase;
  const opened = await openService(now, undefined, async (owner, assetId) => {
    adopted.push({ owner, assetId });
    const patentId = (owner as { kind: string; patentId: string }).patentId;
    database.transaction((raw) => {
      raw
        .prepare("INSERT INTO patent_assets (patent_id, asset_id) VALUES (?, ?)")
        .run(patentId, assetId);
    });
  });
  database = opened.database;
  const { assetDescriptors, service } = opened;
  const created = await service.create({
    patentType: "invention",
    name: "暂存结构式",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(103);
  // The resource exists in the store (staged by the renderer) but is NOT owned by the patent yet.
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
        now.value.toISOString(),
      );
  });
  assetDescriptors.set(preview.assetId, preview);
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(896),
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
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

  expect(adopted).toEqual([
    { owner: { kind: "patent", patentId: created.patentId }, assetId: preview.assetId },
  ]);
  const reopened = await service.open(created.patentId);
  expect(reopened.patent.assets).toEqual([preview]);
  expect(reopened.patent.figures).toEqual([]);
  expect(reopened.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    document,
  );
  expect(
    database.read((raw) =>
      raw.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(created.patentId),
    ),
  ).toEqual([{ asset_id: preview.assetId }]);
});

test("rejects a book edit when the staged resource cannot be adopted", async () => {
  const now = { value: new Date("2026-08-04T10:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now, undefined, async () => {
    throw new Error("asset missing");
  });
  const created = await service.create({
    patentType: "invention",
    name: "缺失暂存资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(104);
  assetDescriptors.set(preview.assetId, preview);
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(895),
        type: "chemical-structure",
        ketSource: "(ket) (atom P)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "description",
      expectedRevision: created.revision,
      document,
      editorState: {},
      assets: [preview],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect((await service.open(created.patentId)).patent).toEqual(created.patent);
  expect(
    database.read((raw) =>
      raw.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(created.patentId),
    ),
  ).toEqual([]);
});

test("rejects a tampered book asset descriptor and keeps the authoritative descriptor", async () => {
  const now = { value: new Date("2026-08-04T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "描述符校验",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(102);
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
        now.value.toISOString(),
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
        id: testUuid(896),
        type: "chemical-structure",
        ketSource: "(ket) (atom S)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "description",
      expectedRevision: created.revision,
      document,
      editorState: {},
      assets: [{ ...preview, originalName: "forged.png" }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect((await service.open(created.patentId)).patent).toEqual(created.patent);
});

test("rolls back a book edit when its preview descriptor has no stored asset", async () => {
  const now = { value: new Date("2026-08-04T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "结构式回滚",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(100);
  const document: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(898),
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "description",
      expectedRevision: created.revision,
      document,
      editorState: {},
      assets: [preview],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect(await service.open(created.patentId)).toMatchObject({
    revision: created.revision,
    patent: { assets: [], figures: [] },
  });
  expect(
    database.read((raw) =>
      raw.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(created.patentId),
    ),
  ).toEqual([]);
});

test("opens a version 1 persisted book in memory without changing revisions or ciphertext", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "旧版拆分书册",
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

  const opened = await service.open(created.patentId);
  const claims = opened.patent.books.find((book) => book.kind === "claims");

  expect(opened.revision).toBe(created.revision);
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

test("creates patents from the supplied templates without retaining later template changes", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const templates = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  const claim = templates.invention.claims.content[0];
  if (claim?.type !== "paragraph" || claim.content[0]?.type !== "text") throw new Error("fixture");
  claim.content[0].text = "模板权利要求：{{patentName}}";
  claim.content[0].marks = [{ type: "bold" }];

  const first = await service.create({
    patentType: "invention",
    name: "环保回收装置",
    templates,
  });
  claim.content[0].text = "更新后的模板：{{patentName}}";
  claim.content[0].marks = [];
  const second = await service.create({
    patentType: "invention",
    name: "再生设备",
    templates,
  });
  const firstClaim = first.patent.books.find((book) => book.kind === "claims");
  const secondClaim = second.patent.books.find((book) => book.kind === "claims");
  const reopenedFirst = await service.open(first.patentId);
  const reopenedFirstClaim = reopenedFirst.patent.books.find((book) => book.kind === "claims");
  const firstParagraph = firstClaim?.document.content[0];
  const secondParagraph = secondClaim?.document.content[0];
  const reopenedFirstParagraph = reopenedFirstClaim?.document.content[0];
  if (
    firstParagraph?.type !== "paragraph" ||
    secondParagraph?.type !== "paragraph" ||
    reopenedFirstParagraph?.type !== "paragraph"
  ) {
    throw new Error("created claim fixture");
  }

  expect(firstParagraph.content.slice(0, 2)).toEqual([
    { type: "text", text: "模板权利要求：", marks: [{ type: "bold" }] },
    { type: "text", text: "环保回收装置", marks: [{ type: "bold" }] },
  ]);
  expect(secondParagraph.content.slice(0, 2)).toEqual([
    { type: "text", text: "更新后的模板：", marks: [] },
    { type: "text", text: "再生设备", marks: [] },
  ]);
  expect(reopenedFirstParagraph.content.slice(0, 2)).toEqual([
    { type: "text", text: "模板权利要求：", marks: [{ type: "bold" }] },
    { type: "text", text: "环保回收装置", marks: [{ type: "bold" }] },
  ]);
});

test("creates a patent with the rich template's referenced chemical preview assets", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("fixture");
  const database = prepared.database;
  databases.push(database);
  const assets = new AssetStore({ root, database });
  const service = new PatentService({ database, assetStore: assets, now: () => now.value });
  const source = await service.create({
    patentType: "invention",
    name: "来源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const resource = (await createPatdocFidelityPayload()).assets[0]!;
  const { descriptor: preview } = await assets.install(
    { kind: "patent", patentId: source.patentId },
    resource,
  );
  const templates = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  templates.invention.claims.content.push({
    id: testUuid(777),
    type: "chemical-structure",
    ketSource: "(ket) (atom O)",
    previewAssetId: preview.assetId,
    widthMm: 80,
    alignment: "center",
  });
  const created = await service.create({
    patentType: "invention",
    name: "含结构式模板",
    templates,
    templateAssetIds: [preview.assetId],
  });

  const copy = created.patent.assets[0]!;
  expect(copy.assetId).not.toBe(preview.assetId);
  expect(copy).toEqual({ ...preview, assetId: copy.assetId });
  expect((await assets.readAsset(copy.assetId)).preview).toEqual(resource.preview);
  expect(created.patent.books[0]!.document.content.at(-1)).toMatchObject({
    previewAssetId: copy.assetId,
  });
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT patent_id, asset_id FROM patent_assets WHERE patent_id = ?")
        .get(created.patentId),
    ),
  ).toEqual({ patent_id: created.patentId, asset_id: copy.assetId });
});

test("lists patent summaries rather than individual books", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "往复式夹具",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  expect(await service.list("active")).toMatchObject([
    {
      patentId: created.patentId,
      name: "往复式夹具",
      patentType: "invention",
      revision: 0,
      bookStatuses: {
        claims: "draft",
        description: "draft",
        "description-drawings": "empty",
        abstract: "draft",
        "abstract-drawing": "empty",
      },
      issueCount: expect.any(Number),
      abstractText: expect.stringContaining("本发明"),
      drawingPreviewAssetId: null,
      deletedAt: null,
      recoveryState: "healthy",
    },
  ]);
});

test("keeps a readable patent healthy when inspection fails", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "检查降级专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const failingInspector = vi.fn(() => {
    throw new Error("inspection failure");
  });
  const listingService = new PatentService({
    database,
    inspectPatent: failingInspector,
  });

  const summaries = await listingService.list("active");

  expect(failingInspector).toHaveBeenCalledTimes(1);
  expect(summaries).toEqual([
    expect.objectContaining({
      patentId: created.patentId,
      issueCount: 0,
      recoveryState: "healthy",
      recoveryErrorCode: null,
    }),
  ]);
});

test("reuses inspection results for an unchanged patent revision", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  await service.create({
    patentType: "invention",
    name: "检查缓存专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const inspector = vi.fn(() => ({ issues: [] }));
  const listingService = new PatentService({ database, inspectPatent: inspector });

  await listingService.list("active");
  await listingService.list("active");

  expect(inspector).toHaveBeenCalledTimes(1);
});

test("reuses summaries beyond 64 patents but revalidates changed stored bytes without revision changes", async () => {
  const { database, service } = await openService({ value: new Date("2026-09-05T00:00:00.000Z") });
  for (let i = 0; i < 70; i++)
    await service.create({
      patentType: "invention",
      name: `容量${i}`,
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
  const inspector = vi.fn(() => ({ issues: [] }));
  const listing = new PatentService({ database, inspectPatent: inspector });
  const first = await listing.list("active");
  await listing.list("active");
  expect(inspector).toHaveBeenCalledTimes(70);
  const target = first[0]!;
  database.transaction((raw) =>
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(Buffer.from("damaged"), target.patentId),
  );
  expect(
    (await listing.list("active")).find((item) => item.patentId === target.patentId)?.recoveryState,
  ).toBe("quarantined");
  expect(inspector).toHaveBeenCalledTimes(70);
  database.transaction((raw) =>
    raw
      .prepare("UPDATE patents SET name = ? WHERE patent_id = ?")
      .run("名称变更", first[1]!.patentId),
  );
  expect(
    (await listing.list("active")).find((item) => item.patentId === first[1]!.patentId)?.name,
  ).toBe("名称变更");
  expect(inspector).toHaveBeenCalledTimes(71);
});

test("lists healthy patents when another patent is quarantined and unreadable", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const healthy = await service.create({
    patentType: "invention",
    name: "健康专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const quarantined = await service.create({
    patentType: "utility-model",
    name: "待恢复专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare(
        "UPDATE patents SET recovery_state = 'quarantined', recovery_error_code = 'CORRUPT_FILE' WHERE patent_id = ?",
      )
      .run(quarantined.patentId);
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(Buffer.from("not-a-valid-payload"), quarantined.patentId);
  });

  const summaries = await service.list("active");

  expect(summaries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ patentId: healthy.patentId, recoveryState: "healthy" }),
      expect.objectContaining({
        patentId: quarantined.patentId,
        recoveryState: "quarantined",
        recoveryErrorCode: "CORRUPT_FILE",
        issueCount: 1,
        bookStatuses: {
          claims: "unavailable",
          description: "unavailable",
          "description-drawings": "unavailable",
          abstract: "unavailable",
          "abstract-drawing": "unavailable",
        },
      }),
    ]),
  );
});

test("isolates an unexpectedly unreadable healthy patent without changing its stored recovery state", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const healthy = await service.create({
    patentType: "invention",
    name: "仍可读取",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const unreadable = await service.create({
    patentType: "invention",
    name: "读取异常",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  database.transaction((raw) => {
    raw
      .prepare("UPDATE patent_books SET document_json = ? WHERE patent_id = ? AND kind = 'claims'")
      .run(Buffer.from("not-a-valid-payload"), unreadable.patentId);
  });

  const summaries = await service.list("active");
  const stored = database.read((raw) =>
    raw
      .prepare("SELECT recovery_state, recovery_error_code FROM patents WHERE patent_id = ?")
      .get(unreadable.patentId),
  );

  expect(summaries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ patentId: healthy.patentId, recoveryState: "healthy" }),
      expect.objectContaining({
        patentId: unreadable.patentId,
        recoveryState: "quarantined",
        recoveryErrorCode: "CORRUPT_FILE",
      }),
    ]),
  );
  expect(stored).toEqual({ recovery_state: "healthy", recovery_error_code: null });
});

test("opens a patent as a full five-book aggregate and manages patent-level leases", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: null,
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const opened = await service.open(created.patentId);

  expect(opened.sessionId).not.toBe(created.sessionId);
  expect(opened.patent.books).toHaveLength(5);
  await expect(service.permanentlyDelete(created.patentId)).rejects.toMatchObject({
    code: "LIBRARY_LOCKED",
  });
  await service.release(created.sessionId);
  await service.release(opened.sessionId);
  await service.moveToTrash(created.patentId);
  now.value = new Date(now.value.getTime() + 24 * 60 * 60 * 1000);
  await service.permanentlyDelete(created.patentId);
  expect(await service.list("trash")).toEqual([]);
});

test("reads an authoritative patent only through its active session", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "AI 只读会话",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const patent = service.requireActiveReadSession(created.sessionId, created.patentId);
  expect(patent.patentId).toBe(created.patentId);
  patent.name = "只修改克隆";
  expect(service.requireActiveReadSession(created.sessionId, created.patentId).name).toBe(
    "AI 只读会话",
  );
  expect(() => service.requireActiveReadSession(testUuid(999), created.patentId)).toThrowError(
    expect.objectContaining({ code: "LIBRARY_LOCKED" }),
  );
});

test("refuses to move a patent to trash while any session still leases it", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "打开中的专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(service.moveToTrash(created.patentId)).rejects.toMatchObject({
    code: "LIBRARY_LOCKED",
  });
  expect(await service.list("active")).toMatchObject([
    { patentId: created.patentId, deletedAt: null },
  ]);
  expect(await service.list("trash")).toEqual([]);
});

test("updates settings and applies one book edit with aggregate revisions", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: null,
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  const settingsAck = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "可调夹具",
    patentType: "utility-model",
  });
  expect(settingsAck.revision).toBe(1);

  const editedDocument = {
    ...claims.document,
    content: [
      {
        id: "00000000-0000-4000-8000-000000000301",
        type: "paragraph" as const,
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text" as const, text: "1. 一种可调夹具。", marks: [] }],
      },
    ],
  };
  const editAck = await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: 1,
    document: editedDocument,
    editorState: { selection: "end" },
  });

  const opened = await service.open(created.patentId);
  expect(editAck.revision).toBe(2);
  expect(opened.patent.name).toBe("可调夹具");
  expect(opened.patent.patentType).toBe("utility-model");
  expect(opened.patent.books.find((book) => book.kind === "claims")?.document.content).toEqual(
    editedDocument.content,
  );
});

test("changes patent type metadata without rewriting the existing description", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "类型切换",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const originalDescription = created.patent.books.find(
    (book) => book.kind === "description",
  )?.document;
  expect(originalDescription).toBeDefined();

  await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: created.patent.name,
    patentType: "utility-model",
  });

  const reopened = await service.open(created.patentId);
  expect(reopened.patent.patentType).toBe("utility-model");
  expect(reopened.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    originalDescription,
  );
});

test("restores blank drawing books when legacy settings switch a drawing-free invention to utility model", async () => {
  const now = { value: new Date("2026-08-08T10:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "无附图工艺",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const disabled = await service.setDrawingBooksEnabled({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: created.revision,
    enabled: false,
  });
  const disabledDrawingBookIds = new Map(
    disabled.patent.books
      .filter((book) => book.kind === "description-drawings" || book.kind === "abstract-drawing")
      .map((book) => [book.kind, book.bookId]),
  );

  const acknowledgement = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: disabled.patent.revision,
    name: created.patent.name,
    patentType: "utility-model",
  });

  const reopened = await service.open(created.patentId);
  expect(acknowledgement.revision).toBe(disabled.patent.revision + 1);
  expect(reopened.patent).toMatchObject({
    patentType: "utility-model",
    drawingBooksEnabled: true,
    figures: [],
    abstractDrawingFigureId: null,
  });
  for (const kind of ["description-drawings", "abstract-drawing"] as const) {
    expect(reopened.patent.books.find((book) => book.kind === kind)?.bookId).not.toBe(
      disabledDrawingBookIds.get(kind),
    );
  }
});

test("updates settings and selected terminology books in one aggregate revision", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "术语事务",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const abstract = created.patent.books.find((book) => book.kind === "abstract");
  if (!abstract) throw new Error("fixture");
  const changedAbstract = {
    ...abstract.document,
    content: [
      {
        id: testUuid(711),
        type: "paragraph" as const,
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text" as const, text: "本实用新型涉及夹具。", marks: [] }],
      },
    ],
  };

  const ack = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "术语事务（已切换）",
    patentType: "utility-model",
    bookEdits: [
      {
        bookKind: "abstract",
        document: changedAbstract,
        editorState: { terminology: "replaced" },
      },
    ],
  });

  const reopened = await service.open(created.patentId);
  const reopenedAbstract = reopened.patent.books.find((book) => book.kind === "abstract");
  expect(ack.revision).toBe(1);
  expect(reopened.patent).toMatchObject({
    revision: 1,
    name: "术语事务（已切换）",
    patentType: "utility-model",
  });
  expect(reopenedAbstract).toMatchObject({
    localRevision: 1,
    persistedRevision: 1,
    document: changedAbstract,
    editorState: { terminology: "replaced" },
  });
});

test("updates settings with an owned chemical preview before validating imported books", async () => {
  const now = { value: new Date("2026-08-04T11:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "结构式导入设置",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(103);
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
        now.value.toISOString(),
      );
    raw
      .prepare("INSERT INTO patent_assets (patent_id, asset_id) VALUES (?, ?)")
      .run(created.patentId, preview.assetId);
  });
  assetDescriptors.set(preview.assetId, preview);
  const chemicalDocument: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(895),
        type: "chemical-structure",
        ketSource: "(ket) (atom C)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  const ack = await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: created.revision,
    name: created.patent.name,
    patentType: created.patent.patentType,
    bookEdits: [
      {
        bookKind: "description",
        document: chemicalDocument,
        editorState: {},
      },
    ],
    assets: [preview],
  });

  const reopened = await service.open(created.patentId);
  expect(ack.revision).toBe(1);
  expect(reopened.patent).toMatchObject({ assets: [preview], figures: [] });
  expect(reopened.patent.books.find((book) => book.kind === "description")?.document).toEqual(
    chemicalDocument,
  );
});

test("rolls back imported book settings when an asset is not owned by the patent", async () => {
  const now = { value: new Date("2026-08-04T11:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "结构式导入回滚",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const preview = asset(104);
  const chemicalDocument: PatentBookDocument = {
    ...description.document,
    content: [
      {
        id: testUuid(894),
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: preview.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ],
  };

  await expect(
    service.updateSettings({
      patentId: created.patentId,
      expectedRevision: created.revision,
      name: created.patent.name,
      patentType: created.patent.patentType,
      bookEdits: [
        {
          bookKind: "description",
          document: chemicalDocument,
          editorState: {},
        },
      ],
      assets: [preview],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect(await service.open(created.patentId)).toMatchObject({
    revision: created.revision,
    patent: created.patent,
  });
});

test("rejects an invalid book edit before changing persisted content or revision", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "写前校验",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "claims",
      expectedRevision: 0,
      document: { ...claims.document, title: "可被错误持久化的非法标题" },
      editorState: { selection: "end" },
    }),
  ).rejects.toThrow("五书文档标题必须匹配固定书册标签");

  expect(
    database.read((raw) =>
      raw.prepare("SELECT revision FROM patents WHERE patent_id = ?").get(created.patentId),
    ),
  ).toEqual({ revision: 0 });
  expect((await service.open(created.patentId)).patent).toEqual(created.patent);
});

test("persists patent figures and abstract drawing selection across reopen", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { assetDescriptors, database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "附图夹具",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const firstAsset = asset(1);
  const secondAsset = asset(2);
  assetDescriptors.set(firstAsset.assetId, firstAsset);
  assetDescriptors.set(secondAsset.assetId, secondAsset);

  database.transaction((raw) => {
    const insertAsset = raw.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const descriptor of [firstAsset, secondAsset]) {
      insertAsset.run(
        descriptor.assetId,
        descriptor.sha256,
        `${descriptor.sha256}.asset`,
        descriptor.mediaType,
        descriptor.byteLength,
        descriptor.widthPx,
        descriptor.heightPx,
        now.value.toISOString(),
      );
    }
  });

  const firstFigureId = testUuid(801);
  const secondFigureId = testUuid(802);
  const ack = await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    figures: [
      {
        figureId: firstFigureId,
        assetId: firstAsset.assetId,
        widthMm: 80,
        rotationDeg: 90,
      },
      {
        figureId: secondFigureId,
        assetId: secondAsset.assetId,
        widthMm: 90,
      },
    ],
    abstractDrawingFigureId: secondFigureId,
    assets: [firstAsset, secondAsset],
  });

  const opened = await service.open(created.patentId);
  expect(ack.revision).toBe(1);
  expect(opened.patent.figures).toEqual([
    { figureId: firstFigureId, assetId: firstAsset.assetId, widthMm: 80, rotationDeg: 90 },
    { figureId: secondFigureId, assetId: secondAsset.assetId, widthMm: 90, rotationDeg: 0 },
  ]);
  expect(opened.patent.abstractDrawingFigureId).toBe(secondFigureId);
  expect(await service.list("active")).toEqual([
    expect.objectContaining({ drawingPreviewAssetId: secondAsset.assetId }),
  ]);
  expect(await service.getLibraryPreview(created.patentId)).toEqual(Uint8Array.from([2]));
  expect(opened.patent.assets.map((descriptor) => descriptor.assetId)).toEqual([
    firstAsset.assetId,
    secondAsset.assetId,
  ]);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT figure_id, position, width_mm FROM patent_figures WHERE patent_id = ? ORDER BY position",
        )
        .all(created.patentId),
    ),
  ).toEqual([
    { figure_id: firstFigureId, position: 0, width_mm: 80 },
    { figure_id: secondFigureId, position: 1, width_mm: 90 },
  ]);
});

test("persists figures without accepting a linked description mutation", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "附图说明事务",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const descriptor = asset(3);
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
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
        now.value.toISOString(),
      );
  });
  const figureId = testUuid(803);
  const attemptedDescription = {
    ...description.document,
    content: [
      {
        id: testUuid(804),
        type: "paragraph" as const,
        semanticRole: "description-drawing-explanation" as const,
        figureId,
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text" as const, text: "图1为整体结构示意图。", marks: [] }],
      },
    ],
  };

  const ack = await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
    figures: [{ figureId, assetId: descriptor.assetId, widthMm: 88 }],
    abstractDrawingFigureId: figureId,
    assets: [descriptor],
    descriptionEdit: {
      document: attemptedDescription,
      editorState: { unlinkedFigureExplanations: [] },
    },
  } as unknown as Parameters<typeof service.applyFigureEdit>[0]);

  const reopened = await service.open(created.patentId);
  const reopenedDescription = reopened.patent.books.find((book) => book.kind === "description");
  expect(ack.revision).toBe(1);
  expect(reopened.patent.figures).toEqual([
    { figureId, assetId: descriptor.assetId, widthMm: 88, rotationDeg: 0 },
  ]);
  expect(reopenedDescription).toEqual(description);
});

test("saves a description without silently rewriting hidden drawing metadata", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "历史附图说明",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const description = created.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const orphanedParagraphId = testUuid(981);
  const document = {
    ...description.document,
    content: [
      ...description.document.content,
      {
        id: orphanedParagraphId,
        type: "paragraph" as const,
        semanticRole: "description-drawing-explanation" as const,
        figureId: testUuid(982),
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text" as const, text: "图99为历史保留说明。", marks: [] }],
      },
    ],
  };

  const acknowledgement = await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "description",
    expectedRevision: created.revision,
    document,
    editorState: {},
  });

  const reopened = await service.open(created.patentId);
  const savedParagraph = reopened.patent.books
    .find((book) => book.kind === "description")
    ?.document.content.find((block) => block.id === orphanedParagraphId);
  expect(acknowledgement.revision).toBe(1);
  expect(savedParagraph).toMatchObject({
    type: "paragraph",
    content: [{ type: "text", text: "图99为历史保留说明。" }],
  });
  expect(savedParagraph).toHaveProperty("semanticRole", "description-drawing-explanation");
  expect(savedParagraph).toHaveProperty("figureId", testUuid(982));
});

test("loads only the exact active revision for export", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "导出版本夹具",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const loaded = await service.loadForExport({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
  });

  expect(loaded).toMatchObject({
    patentId: created.patentId,
    revision: 0,
    name: "导出版本夹具",
  });
  loaded.name = "本地修改不会反写";
  const reloaded = await service.loadForExport({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 0,
  });
  expect(reloaded.name).toBe("导出版本夹具");
});

test("rejects stale and future export revisions", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "冲突版本夹具",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: 0,
    document: withParagraph(claims.document, "1. 一种冲突版本夹具，其特征在于："),
    editorState: {},
  });

  await expect(
    service.loadForExport({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(
    service.loadForExport({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: 2,
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});

test("restores trashed patents and purges expired released patents after one year", async () => {
  const now = { value: new Date("2026-08-01T00:00:00.000Z") };
  const { service } = await openService(now);
  const patent = await service.create({
    patentType: "invention",
    name: "待清理",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.release(patent.sessionId);
  await service.moveToTrash(patent.patentId);
  await service.restore(patent.patentId);
  expect(await service.list("trash")).toEqual([]);

  await service.moveToTrash(patent.patentId);
  now.value = new Date("2026-09-30T00:00:00.000Z");
  expect(await service.purgeExpired()).toEqual({ purgedPatentIds: [] });
  now.value = new Date("2027-07-31T23:59:59.999Z");
  expect(await service.purgeExpired()).toEqual({ purgedPatentIds: [] });

  now.value = new Date("2027-08-01T00:00:00.000Z");
  expect(await service.purgeExpired()).toEqual({ purgedPatentIds: [patent.patentId] });
  expect(await service.list("trash")).toEqual([]);
});

test("retains flowchart sources in trash and deletes only the permanently removed patent scope", async () => {
  const now = { value: new Date("2026-08-01T00:00:00.000Z") };
  const { database, service } = await openService(now);
  const firstPatent = await service.create({
    patentType: "invention",
    name: "第一件流程图专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const secondPatent = await service.create({
    patentType: "invention",
    name: "第二件流程图专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const store = new FlowchartSourceStore({ database });
  const sharedBytes = Buffer.from('<mxfile><diagram id="p1"/></mxfile>');
  store.appendRevision({
    patentId: firstPatent.patentId,
    projectId: testUuid(880),
    expectedProjectRevision: 0,
    source: sharedBytes,
    metadata: { name: "相同内容一", pageCount: 1, lastPageId: "p1" },
  });
  store.appendRevision({
    patentId: secondPatent.patentId,
    projectId: testUuid(881),
    expectedProjectRevision: 0,
    source: sharedBytes,
    metadata: { name: "相同内容二", pageCount: 1, lastPageId: "p1" },
  });
  await service.release(firstPatent.sessionId);
  await service.release(secondPatent.sessionId);

  await service.moveToTrash(firstPatent.patentId);
  expect(
    database.read(
      (raw) =>
        (
          raw
            .prepare(
              "SELECT count(*) AS count FROM patent_flowchart_source_revisions WHERE patent_id = ?",
            )
            .get(firstPatent.patentId) as { count: number }
        ).count,
    ),
  ).toBe(1);

  now.value = new Date(now.value.getTime() + 24 * 60 * 60 * 1000);
  await service.permanentlyDelete(firstPatent.patentId);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT patent_id, source_sha256 FROM patent_flowchart_source_revisions ORDER BY patent_id",
        )
        .all(),
    ),
  ).toEqual([
    expect.objectContaining({
      patent_id: secondPatent.patentId,
    }),
  ]);

  await service.moveToTrash(secondPatent.patentId);
  now.value = new Date("2027-10-01T00:00:00.000Z");
  await service.purgeExpired();
  expect(
    database.read(
      (raw) =>
        (
          raw.prepare("SELECT count(*) AS count FROM patent_flowchart_source_revisions").get() as {
            count: number;
          }
        ).count,
    ),
  ).toBe(0);
});

test("collects removed assets but skips book saves with unchanged asset membership", async () => {
  const now = { value: new Date("2026-08-01T00:00:00.000Z") };
  const observedAssetReferenceCounts: number[] = [];
  let database: LibraryDatabase | undefined;
  const collectUnusedAssets = vi.fn(async () => undefined);
  collectUnusedAssets.mockImplementation(async () => {
    observedAssetReferenceCounts.push(
      database === undefined
        ? -1
        : database.read(
            (raw) =>
              (
                raw.prepare("SELECT count(*) AS count FROM patent_assets").get() as {
                  count: number;
                }
              ).count,
          ),
    );
  });
  const opened = await openService(now, collectUnusedAssets);
  database = opened.database;
  const { service } = opened;
  const created = await service.create({
    patentType: "invention",
    name: "资源替换",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const replaced = asset(40);
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        replaced.assetId,
        replaced.sha256,
        `${replaced.sha256}.asset`,
        replaced.mediaType,
        replaced.byteLength,
        replaced.widthPx,
        replaced.heightPx,
        now.value.toISOString(),
      );
    raw
      .prepare("INSERT INTO patent_assets (patent_id, asset_id) VALUES (?, ?)")
      .run(created.patentId, replaced.assetId);
  });
  const claims = created.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");

  await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "资源替换",
    patentType: "invention",
    assets: [],
  });
  await service.applyBookEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    bookKind: "claims",
    expectedRevision: 1,
    document: withParagraph(claims.document, "1. 一种资源替换装置，其特征在于："),
    editorState: {},
    assets: [],
  });
  await service.applyFigureEdit({
    patentId: created.patentId,
    sessionId: created.sessionId,
    expectedRevision: 2,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
  });

  expect(collectUnusedAssets).toHaveBeenNthCalledWith(1, created.patentId);
  expect(collectUnusedAssets).toHaveBeenNthCalledWith(2, created.patentId);
  expect(collectUnusedAssets).toHaveBeenCalledTimes(2);
  expect(observedAssetReferenceCounts).toEqual([0, 0]);
});

test("collects unused patent assets after permanent deletion and expiration purge", async () => {
  const now = { value: new Date("2026-08-01T00:00:00.000Z") };
  const collectUnusedAssets = vi.fn(async () => undefined);
  const { service } = await openService(now, collectUnusedAssets);
  const deleted = await service.create({
    patentType: "invention",
    name: "手动删除",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const expired = await service.create({
    patentType: "invention",
    name: "到期清理",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.release(deleted.sessionId);
  await service.release(expired.sessionId);
  await service.moveToTrash(deleted.patentId);
  now.value = new Date(now.value.getTime() + 24 * 60 * 60 * 1000);
  await service.permanentlyDelete(deleted.patentId);
  await service.moveToTrash(expired.patentId);
  now.value = new Date("2027-10-01T00:00:00.000Z");
  await service.purgeExpired();

  expect(collectUnusedAssets).toHaveBeenNthCalledWith(1, deleted.patentId);
  expect(collectUnusedAssets).toHaveBeenNthCalledWith(2, expired.patentId);
});

test("derives reference marks from a legal legend when the state row is absent", async () => {
  const now = { value: new Date("2026-08-01T09:00:00.000Z") };
  const { database, service } = await openService(now);
  const created = await service.create({
    patentType: "invention",
    name: "旧库派生",
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
        content: [{ type: "text", text: "其中：1、箱体；2、箱盖。", marks: [] }],
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

  const reopened = await service.open(created.patentId);

  expect(reopened.patent.referenceMarks).toHaveLength(2);
  expect(reopened.patent.referenceMarks[0]).toMatchObject({ number: 1, keyword: "箱体" });
  expect(reopened.patent.referenceMarks[1]).toMatchObject({ number: 2, keyword: "箱盖" });
  expect(reopened.patent.referenceMarks[0]?.referenceMarkId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(reopened.patent.referenceMarkSettings).toEqual({ synchronizedEditingEnabled: false });
  // 派生只读，不写回库。
  const row = database.read((raw) =>
    raw
      .prepare("SELECT value FROM library_state WHERE key = ?")
      .get(`patent:${created.patentId}:reference-mark-state`),
  );
  expect(row).toBeUndefined();
});

test("automation commits two books and ledger receipt in one revision, surviving recovery", async () => {
  const { service, database } = await openService({ value: new Date("2026-09-13T00:00:00Z") });
  const opened = await service.create({
    patentType: "invention",
    name: "自动化",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const candidate = await service.captureAutomation(opened.patentId);
  candidate.books[0]!.document = withParagraph(candidate.books[0]!.document, "权利要求新内容");
  candidate.books[1]!.document = withParagraph(candidate.books[1]!.document, "说明书新内容");
  const next = await service.applyAutomationChange({
    patentId: opened.patentId,
    expectedRevision: 0,
    patent: candidate,
    inTransaction(db, patent) {
      db.prepare("INSERT INTO automation_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "client",
        "apply",
        "request",
        testUuid(9900),
        "hash",
        "committed",
        "{}",
        JSON.stringify({ revision: patent.revision }),
        null,
        patent.modifiedAt,
      );
    },
  });
  expect(next.revision).toBe(1);
  expect(next.books[0]!.editorState.type).toBe("doc");
  expect(database.read((db) => db.prepare("SELECT count(*) AS count FROM edit_log").get())).toEqual(
    { count: 1 },
  );
  expect(
    database.read((db) => db.prepare("SELECT status FROM automation_operations").get()),
  ).toEqual({ status: "committed" });
  expect(await service.captureAutomation(opened.patentId)).toEqual(next);
  const recovery = new LibraryRecoveryService({ database });
  const recovered = await recovery.recoverPatent(opened.patentId);
  expect(recovered.patent.books[0]!.document.content).toEqual(next.books[0]!.document.content);
  expect(recovered.patent.books[1]!.document.content).toEqual(next.books[1]!.document.content);
  expect((await service.captureAutomation(opened.patentId)).revision).toBe(1);
});

test.each(["authorization", "ledger"])(
  "automation %s failure rolls back both books and revision",
  async (failure) => {
    const { service, database } = await openService({ value: new Date("2026-09-13T00:00:00Z") });
    const opened = await service.create({
      patentType: "invention",
      name: "回滚",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const candidate = structuredClone(opened.patent);
    candidate.books[0]!.document = withParagraph(candidate.books[0]!.document, "变更一");
    candidate.books[1]!.document = withParagraph(candidate.books[1]!.document, "变更二");
    await expect(
      service.applyAutomationChange({
        patentId: opened.patentId,
        expectedRevision: 0,
        patent: candidate,
        beforeCommit:
          failure === "authorization"
            ? () => {
                throw new Error("revoked");
              }
            : undefined,
        inTransaction:
          failure === "ledger"
            ? (db) => {
                db.prepare("INSERT INTO library_state VALUES (?, ?, ?)").run(
                  "rollback-probe",
                  Buffer.from("{}"),
                  "now",
                );
                throw new Error("receipt failure");
              }
            : undefined,
      }),
    ).rejects.toThrow();
    expect(await service.captureAutomation(opened.patentId)).toEqual(opened.patent);
    expect(
      database.read((db) => db.prepare("SELECT count(*) AS count FROM edit_log").get()),
    ).toEqual({ count: 0 });
    expect(
      database.read((db) =>
        db.prepare("SELECT key FROM library_state WHERE key = 'rollback-probe'").get(),
      ),
    ).toBeUndefined();
  },
);

test("automation refuses stale revision, invalid second book and immutable fields", async () => {
  const { service } = await openService({ value: new Date("2026-09-13T00:00:00Z") });
  const opened = await service.create({
    patentType: "invention",
    name: "检查",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await expect(
    service.applyAutomationChange({
      patentId: opened.patentId,
      expectedRevision: 1,
      patent: opened.patent,
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  const invalid = structuredClone(opened.patent);
  invalid.books[0]!.document = withParagraph(invalid.books[0]!.document, "有效书");
  invalid.books[1]!.document.content = [
    {
      id: testUuid(9950),
      type: "figure",
      assetId: testUuid(9951),
      widthMm: 80,
      alignment: "center",
    },
  ];
  await expect(
    service.applyAutomationChange({
      patentId: opened.patentId,
      expectedRevision: 0,
      patent: invalid,
    }),
  ).rejects.toThrow();
  expect(await service.captureAutomation(opened.patentId)).toEqual(opened.patent);
  const changed = structuredClone(opened.patent);
  changed.books[0]!.bookId = testUuid(9970);
  await expect(
    service.applyAutomationChange({
      patentId: opened.patentId,
      expectedRevision: 0,
      patent: changed,
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("automation create hooks prevent incomplete patents and receipts", async () => {
  const { service, database } = await openService({ value: new Date("2026-09-13T00:00:00Z") });
  await expect(
    service.create({
      patentType: "invention",
      name: "禁止",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      beforeCommit() {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  await expect(
    service.create({
      patentType: "invention",
      name: "失败",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      inTransaction() {
        throw new Error("ledger failed");
      },
    }),
  ).rejects.toThrow("ledger failed");
  expect(await service.list("active")).toEqual([]);
  expect(
    database.read((db) => db.prepare("SELECT count(*) AS count FROM snapshots").get()),
  ).toEqual({ count: 0 });
});

test("automation staged asset ownership is rolled back with a failed receipt", async () => {
  const { service, database, assetDescriptors } = await openService({
    value: new Date("2026-09-13T00:00:00Z"),
  });
  const opened = await service.create({
    patentType: "invention",
    name: "资源回滚",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const staged = asset(70);
  assetDescriptors.set(staged.assetId, staged);
  database.transaction((db) =>
    db
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        staged.assetId,
        staged.sha256,
        "staged.asset",
        staged.mediaType,
        staged.byteLength,
        staged.widthPx,
        staged.heightPx,
        "now",
      ),
  );
  const candidate = structuredClone(opened.patent);
  candidate.assets.push(staged);
  candidate.figures.push({ figureId: testUuid(9980), assetId: staged.assetId, widthMm: 80 });
  await expect(
    service.applyAutomationChange({
      patentId: opened.patentId,
      expectedRevision: 0,
      patent: candidate,
      inTransaction() {
        throw new Error("receipt failed");
      },
    }),
  ).rejects.toThrow("receipt failed");
  expect(
    database.read((db) =>
      db
        .prepare("SELECT count(*) AS count FROM patent_assets WHERE patent_id = ?")
        .get(opened.patentId),
    ),
  ).toEqual({ count: 0 });
  expect(await service.captureAutomation(opened.patentId)).toEqual(opened.patent);
  const committed = await service.applyAutomationChange({
    patentId: opened.patentId,
    expectedRevision: 0,
    patent: candidate,
  });
  expect(committed.assets).toEqual([staged]);
  expect(committed.figures).toEqual(candidate.figures);
});
