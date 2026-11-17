import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { createFactoryPatentTemplates } from "../../shared/patent/templates.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { isolateLibraryAssets } from "./asset-isolation.js";
import { AssetStore } from "./asset-store.js";
import { encodeSnapshot, hashJson } from "./edit-journal.js";
import { createLibraryRuntime, type LibraryRuntime } from "./library-runtime.js";
import { LibrarySafetyBackupService } from "./library-safety-backup.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";
import { recoverPatentFromSnapshot } from "./recovery-service.js";

const roots: string[] = [];
const runtimes: LibraryRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function asset(): StoredAsset {
  const original = new Uint8Array([1, 2, 3]);
  const preview = new Uint8Array([4, 5]);
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex").toUpperCase();
  return {
    original,
    preview,
    descriptor: {
      assetId: randomUUID(),
      kind: "image",
      originalName: "test.png",
      mediaType: "image/png",
      extension: "png",
      widthPx: 12,
      heightPx: 8,
      byteLength: 3,
      previewByteLength: 2,
      sha256: hash(original),
      previewSha256: hash(preview),
    },
  };
}

async function legacyFixture() {
  const root = await mkdtemp(join(tmpdir(), "patent-isolation-"));
  roots.push(root);
  const options = {
    libraryRoot: root,
    readOnly: false,
    runRecovery: false,
    startBackgroundSchedulers: false,
  };
  const runtime = await createLibraryRuntime(options);
  runtimes.push(runtime);
  const patents = await Promise.all(
    ["first", "second"].map((name) =>
      runtime.patents.create({
        name,
        patentType: "invention",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      }),
    ),
  );
  const source = asset();
  const installed = await runtime.assetStore.install(
    { kind: "patent", patentId: patents[0]!.patentId },
    source,
  );
  // Model an old library, including both current content and recovery snapshots.
  runtime.database.transaction((db) => {
    for (const opened of patents) {
      const patent = structuredClone(opened.patent);
      patent.assets = [installed.descriptor];
      const book = patent.books[0]!;
      book.document.content.push({
        id: randomUUID(),
        type: "chemical-structure",
        ketSource: "(ket) (atom O)",
        previewAssetId: installed.descriptor.assetId,
        widthMm: 80,
        alignment: "center",
      });
      book.editorState = { content: [{ attrs: { assetId: installed.descriptor.assetId } }] };
      patent.drawingProjects = [drawingProjectFixture(installed.descriptor.assetId)];
      patent.drawingProjects[0]!.regions[0]!.bodyAssetId = installed.descriptor.assetId;
      patent.auxiliaryDocuments = [
        {
          auxiliaryDocumentId: randomUUID(),
          title: "附件",
          document: { ...structuredClone(book.document), documentId: randomUUID(), title: "附件" },
          editorState: structuredClone(book.editorState),
          localRevision: 0,
          persistedRevision: 0,
          sourceFileName: null,
        },
      ];
      db.prepare(
        "UPDATE patent_books SET document_json = ?, editor_state_json = ? WHERE patent_id = ? AND kind = ?",
      ).run(
        Buffer.from(encodeJson(book.document)),
        Buffer.from(encodeJson(book.editorState)),
        patent.patentId,
        book.kind,
      );
      const auxiliary = patent.auxiliaryDocuments[0]!;
      db.prepare("INSERT INTO patent_auxiliary_documents VALUES (?, ?, 0, ?, 0, ?, ?, NULL)").run(
        patent.patentId,
        auxiliary.auxiliaryDocumentId,
        auxiliary.title,
        Buffer.from(encodeJson(auxiliary.document)),
        Buffer.from(encodeJson(auxiliary.editorState)),
      );
      patent.figures = [
        {
          figureId: randomUUID(),
          assetId: installed.descriptor.assetId,
          widthMm: 80,
          rotationDeg: 0,
        },
      ];
      db.prepare("INSERT OR IGNORE INTO patent_assets VALUES (?, ?)").run(
        patent.patentId,
        installed.descriptor.assetId,
      );
      db.prepare("INSERT INTO patent_figures VALUES (?, ?, ?, 0, 80, '', NULL)").run(
        patent.patentId,
        patent.figures[0]!.figureId,
        installed.descriptor.assetId,
      );
      db.prepare("INSERT OR REPLACE INTO library_state VALUES (?, ?, ?)").run(
        `patent:${patent.patentId}:figure-state`,
        Buffer.from(
          encodeJson({
            assets: patent.assets,
            abstractDrawingFigureId: null,
            rotations: {},
            drawingProjects: patent.drawingProjects,
          }),
        ),
        patent.modifiedAt,
      );
      db.prepare("UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ?").run(
        Buffer.from(encodeJson(patent)),
        hashJson(patent),
        patent.patentId,
      );
      db.prepare("INSERT INTO snapshot_assets VALUES (?, 0, ?)").run(
        patent.patentId,
        installed.descriptor.assetId,
      );
      const edit = {
        type: "figure-edit",
        patentId: patent.patentId,
        baseRevision: 0,
        targetRevision: 1,
        figures: patent.figures,
        assets: patent.assets,
        abstractDrawingFigureId: null,
        drawingProjects: patent.drawingProjects,
      };
      db.prepare("INSERT INTO edit_log VALUES (?, ?, 0, 1, 2, ?, ?, ?)").run(
        randomUUID(),
        patent.patentId,
        Buffer.from(encodeJson(edit)),
        hashJson(edit),
        patent.modifiedAt,
      );
      db.prepare("UPDATE patents SET revision = 1 WHERE patent_id = ?").run(patent.patentId);
    }
  });
  return { root, options, runtime, patents, source, installed };
}

test("migration validation preserves legacy shared resources until normal startup", async () => {
  const f = await legacyFixture();
  const before = f.patents.map((patent) => f.runtime.patents.loadSavedPatent(patent.patentId));
  await f.runtime.close();
  const validation = await createLibraryRuntime({
    ...f.options,
    preserveAssetsForMigration: true,
  });
  try {
    expect(f.patents.map((patent) => validation.patents.loadSavedPatent(patent.patentId))).toEqual(
      before,
    );
    expect(
      (await readdir(join(f.root, "assets"))).filter((name) => name.endsWith(".asset")),
    ).toHaveLength(1);
  } finally {
    await validation.close();
  }
  const normal = await createLibraryRuntime(f.options);
  try {
    expect(
      new Set(
        f.patents.map(
          (patent) => normal.patents.loadSavedPatent(patent.patentId).assets[0]!.assetId,
        ),
      ).size,
    ).toBe(2);
  } finally {
    await normal.close();
  }
});

test("splits legacy shared files and all recovery references before opening a writable library", async () => {
  const f = await legacyFixture();
  await f.runtime.close();
  const runtime = await createLibraryRuntime(f.options);
  try {
    const first = runtime.patents.loadSavedPatent(f.patents[0]!.patentId);
    const second = runtime.patents.loadSavedPatent(f.patents[1]!.patentId);
    expect(first.assets[0]!.assetId).not.toBe(second.assets[0]!.assetId);
    for (const patent of [first, second]) {
      expect(patent.figures[0]!.assetId).toBe(patent.assets[0]!.assetId);
      const ownId = patent.assets[0]!.assetId;
      expect(CanonicalPatentSchema.safeParse(patent).success).toBe(true);
      expect(patent.books[0]!.document.content.at(-1)).toMatchObject({ previewAssetId: ownId });
      expect(patent.books[0]!.editorState).toEqual({ content: [{ attrs: { assetId: ownId } }] });
      expect(patent.auxiliaryDocuments[0]!.document.content.at(-1)).toMatchObject({
        previewAssetId: ownId,
      });
      expect(patent.auxiliaryDocuments[0]!.editorState).toEqual(patent.books[0]!.editorState);
      expect(patent.drawingProjects[0]).toMatchObject({
        sourceAssetId: ownId,
        baseAssetId: ownId,
        regions: [expect.objectContaining({ bodyAssetId: ownId })],
      });
      expect((await runtime.assetStore.readAsset(patent.assets[0]!.assetId)).original).toEqual(
        f.source.original,
      );
      expect((await runtime.assetStore.readAsset(patent.assets[0]!.assetId)).preview).toEqual(
        f.source.preview,
      );
      const snapshot = runtime.database.read((db) =>
        db
          .prepare("SELECT payload, content_hash FROM snapshots WHERE patent_id = ?")
          .get(patent.patentId),
      ) as { payload: Uint8Array; content_hash: string };
      const model = decodeJson<{ assets: { assetId: string }[] }>(snapshot.payload);
      expect(model.assets[0]!.assetId).toBe(patent.assets[0]!.assetId);
      expect(snapshot.content_hash).toBe(hashJson(model));
      const recovered = runtime.database.read((db) =>
        recoverPatentFromSnapshot(db, patent.patentId, 1, {
          ...snapshot,
          model_version: 2,
          revision: 0,
        }),
      );
      expect(recovered.patent.assets[0]!.assetId).toBe(ownId);
      expect(recovered.patent.drawingProjects).toEqual(patent.drawingProjects);
    }
    expect(
      (await readdir(join(f.root, "assets"))).filter((n) => n.endsWith(".asset")),
    ).toHaveLength(2);
    expect((await readdir(join(f.root, "safety-backups"))).length).toBeGreaterThan(0);
    expect(runtime.database.foreignKeyCheck().ok).toBe(true);
  } finally {
    await runtime.close();
  }
  const reopened = await createLibraryRuntime({ ...f.options, runRecovery: true });
  try {
    expect(
      reopened.database.read((db) => db.prepare("SELECT asset_id FROM assets").all()),
    ).toHaveLength(2);
    expect(reopened.recoveryReport.quarantinedPatentIds).toEqual([]);
    expect(
      new Set(f.patents.map((p) => reopened.patents.loadSavedPatent(p.patentId).assets[0]!.assetId))
        .size,
    ).toBe(2);
  } finally {
    await reopened.close();
  }
});

test.each(["file-copy", "reference-transaction"])(
  "migration failure at %s retains original files and all references, and can retry",
  async (failure) => {
    const f = await legacyFixture();
    try {
      const before = f.patents.map((p) => f.runtime.patents.loadSavedPatent(p.patentId));
      const assetIds = f.runtime.database.read((db) =>
        db.prepare("SELECT asset_id FROM assets ORDER BY asset_id").all(),
      );
      const snapshots = f.runtime.database.read((db) =>
        db
          .prepare("SELECT patent_id, payload, content_hash FROM snapshots ORDER BY patent_id")
          .all(),
      );
      const assets =
        failure === "file-copy"
          ? new AssetStore({
              root: f.root,
              database: f.runtime.database,
              afterTempWrite: () => {
                throw new Error("copy interrupted");
              },
            })
          : f.runtime.assetStore;
      if (failure === "reference-transaction")
        f.runtime.database.transaction((db) =>
          db.exec(
            "CREATE TEMP TRIGGER reject_isolation BEFORE UPDATE ON patent_assets BEGIN SELECT RAISE(ABORT, 'swap interrupted'); END",
          ),
        );
      await expect(
        isolateLibraryAssets({ root: f.root, database: f.runtime.database, assets }),
      ).rejects.toThrow(/interrupted/);
      expect(f.patents.map((p) => f.runtime.patents.loadSavedPatent(p.patentId))).toEqual(before);
      expect(
        f.runtime.database.read((db) =>
          db.prepare("SELECT asset_id FROM assets ORDER BY asset_id").all(),
        ),
      ).toEqual(assetIds);
      expect(
        f.runtime.database.read((db) =>
          db
            .prepare("SELECT patent_id, payload, content_hash FROM snapshots ORDER BY patent_id")
            .all(),
        ),
      ).toEqual(snapshots);
      expect(
        (await readdir(join(f.root, "assets"))).filter((n) => n.endsWith(".asset")),
      ).toHaveLength(1);
      expect((await assets.readAsset(f.installed.descriptor.assetId)).original).toEqual(
        f.source.original,
      );
      if (failure === "reference-transaction")
        f.runtime.database.transaction((db) => db.exec("DROP TRIGGER reject_isolation"));
      await isolateLibraryAssets({
        root: f.root,
        database: f.runtime.database,
        assets: f.runtime.assetStore,
      });
      expect(
        new Set(
          f.patents.map((p) => f.runtime.patents.loadSavedPatent(p.patentId).assets[0]!.assetId),
        ).size,
      ).toBe(2);
    } finally {
      await f.runtime.close();
    }
  },
);

test("does not split or rewrite old data when opened read-only", async () => {
  const f = await legacyFixture();
  await f.runtime.close();
  const runtime = await createLibraryRuntime({ ...f.options, readOnly: true });
  try {
    const ids = f.patents.map(
      (p) => runtime.patents.loadSavedPatent(p.patentId).assets[0]!.assetId,
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      (await readdir(join(f.root, "assets"))).filter((n) => n.endsWith(".asset")),
    ).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});

test.each(["shared-file", "old-snapshot", "backup"] as const)(
  "opens healthy patents in read-only protection when resource isolation fails at %s and retries after repair",
  async (failure) => {
    const f = await legacyFixture();
    const healthy = await f.runtime.patents.create({
      name: "健康专利",
      patentType: "invention",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const copiedOwner = f.patents.map((patent) => patent.patentId).sort()[1]!;
    // Recovery has a valid latest version even if a dormant old snapshot is damaged.
    const latest = f.runtime.patents.loadSavedPatent(copiedOwner);
    f.runtime.database.transaction((db) => {
      db.prepare(
        "INSERT INTO snapshots(patent_id, revision, model_version, payload, content_hash, created_at, source) VALUES (?, 1, 2, ?, ?, ?, 'manual-create')",
      ).run(copiedOwner, Buffer.from(encodeJson(latest)), hashJson(latest), latest.modifiedAt);
      db.prepare("INSERT INTO snapshot_assets VALUES (?, 1, ?)").run(
        copiedOwner,
        f.installed.descriptor.assetId,
      );
      if (failure === "old-snapshot")
        db.prepare(
          "UPDATE snapshots SET content_hash = 'damaged' WHERE patent_id = ? AND revision = 0",
        ).run(copiedOwner);
    });
    const path = f.runtime.database.read((db) =>
      db
        .prepare("SELECT relative_path FROM assets WHERE asset_id = ?")
        .get(f.installed.descriptor.assetId),
    ) as { relative_path: string };
    const file = join(f.root, "assets", path.relative_path);
    const originalFile = await readFile(file);
    // This unreferenced file must not be collected while startup is in protection mode.
    const orphanSession = randomUUID();
    const [orphan] = await f.runtime.assetStore.stageMany(orphanSession, [asset()]);
    if (!orphan) throw new Error("fixture");
    await f.runtime.assetStore.commitStaged(orphanSession, [orphan.descriptor.assetId]);
    await f.runtime.close();
    if (failure === "shared-file") await writeFile(file, new Uint8Array([0]));
    const backup =
      failure === "backup"
        ? vi
            .spyOn(LibrarySafetyBackupService.prototype, "create")
            .mockRejectedValueOnce(new Error("backup unavailable"))
        : undefined;
    const protectedRuntime = await createLibraryRuntime({ ...f.options, runRecovery: true });
    runtimes.push(protectedRuntime);
    expect(protectedRuntime.readOnly).toBe(true);
    expect(protectedRuntime.recoveryReport).toMatchObject({
      mode: "read-only",
      assetIsolationPending: true,
    });
    expect((await protectedRuntime.patents.open(healthy.patentId)).patent.name).toBe("健康专利");
    expect(await readFile(file)).toEqual(
      failure === "shared-file" ? Buffer.from([0]) : originalFile,
    );
    expect(
      (await protectedRuntime.assetStore.readAsset(orphan.descriptor.assetId)).original,
    ).toEqual(asset().original);
    for (const patent of f.patents) {
      expect(
        protectedRuntime.database.read((db) =>
          db.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").get(patent.patentId),
        ),
      ).toEqual({ asset_id: f.installed.descriptor.assetId });
    }
    if (failure === "old-snapshot")
      protectedRuntime.database.transaction((db) =>
        db
          .prepare("UPDATE snapshots SET content_hash = ? WHERE patent_id = ? AND revision = 0")
          .run(
            hashJson(
              decodeJson(
                (
                  db
                    .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = 0")
                    .get(copiedOwner) as { payload: Uint8Array }
                ).payload,
              ),
            ),
            copiedOwner,
          ),
      );
    await protectedRuntime.close();
    backup?.mockRestore();
    if (failure === "shared-file") await writeFile(file, originalFile);
    const retried = await createLibraryRuntime({ ...f.options, runRecovery: true });
    runtimes.push(retried);
    expect(retried.readOnly).toBe(false);
    expect(retried.recoveryReport.assetIsolationPending).toBeUndefined();
    expect(
      new Set(
        f.patents.map(
          (patent) => retried.patents.loadSavedPatent(patent.patentId).assets[0]!.assetId,
        ),
      ).size,
    ).toBe(2);
    await expect(retried.assetStore.readAsset(orphan.descriptor.assetId)).rejects.toThrow(
      "Asset not found",
    );
  },
);

test("splits legacy document and template ownership as well as patents without losing editor or journal references", async () => {
  const f = await legacyFixture();
  const document = await f.runtime.library.create("旧独立文档");
  const editor = f.runtime.patentTemplates.openEditor({ patentType: "invention" });
  const slot = editor.catalog.invention.slots[0]!;
  const templates = createFactoryPatentTemplates(() => randomUUID()).invention;
  templates.claims.content.push({
    id: randomUUID(),
    type: "chemical-structure",
    ketSource: "(ket) (atom O)",
    previewAssetId: f.installed.descriptor.assetId,
    widthMm: 80,
    alignment: "center",
  });
  const model = structuredClone(document.document);
  model.assets = [f.installed.descriptor];
  const figure = {
    id: randomUUID(),
    type: "figure" as const,
    assetId: f.installed.descriptor.assetId,
    widthMm: 80,
    alignment: "center" as const,
  };
  model.content = [figure];
  const documentSnapshot = encodeSnapshot(model);
  f.runtime.database.transaction((db) => {
    db.prepare("INSERT INTO document_assets VALUES (?, ?)").run(
      document.libraryDocumentId,
      f.installed.descriptor.assetId,
    );
    db.prepare(
      "UPDATE document_snapshots SET payload = ?, content_hash = ? WHERE library_document_id = ?",
    ).run(documentSnapshot.payload, documentSnapshot.contentHash, document.libraryDocumentId);
    db.prepare(
      "UPDATE patent_template_slots SET claims_json = ?, description_json = ?, abstract_json = ? WHERE template_id = ?",
    ).run(
      Buffer.from(encodeJson(templates.claims)),
      Buffer.from(encodeJson(templates.description)),
      Buffer.from(encodeJson(templates.abstract)),
      slot.templateId,
    );
    db.prepare("INSERT INTO template_assets VALUES (?, ?, 'chemical-preview')").run(
      slot.templateId,
      f.installed.descriptor.assetId,
    );
  });
  await f.runtime.library.applyEdit({
    libraryDocumentId: document.libraryDocumentId,
    sessionId: document.sessionId,
    operationId: randomUUID(),
    baseRevision: 0,
    targetRevision: 1,
    modelVersion: 1,
    operations: [{ type: "put-block", index: 0, block: figure }],
    editorState: { content: [{ attrs: { assetId: figure.assetId } }] },
  });
  await f.runtime.close();
  const runtime = await createLibraryRuntime({ ...f.options, runRecovery: true });
  try {
    const opened = await runtime.library.open(document.libraryDocumentId);
    const copiedSlot = runtime.patentTemplates.readSummary().invention.slots[0]!;
    const templateReference = copiedSlot.claims!.content.at(-1);
    expect(templateReference?.type).toBe("chemical-structure");
    if (templateReference?.type !== "chemical-structure") throw new Error("fixture");
    const ownId = opened.document.assets[0]!.assetId;
    const ids = [
      ownId,
      templateReference.previewAssetId,
      ...f.patents.map((p) => runtime.patents.loadSavedPatent(p.patentId).assets[0]!.assetId),
    ];
    expect(new Set(ids).size).toBe(4);
    expect(opened.document.content[0]).toMatchObject({ assetId: ownId });
    expect(opened.editorState).toEqual({ content: [{ attrs: { assetId: ownId } }] });
    const rows = runtime.database.read((db) =>
      db
        .prepare(
          "SELECT payload, content_hash FROM document_edit_log WHERE library_document_id = ?",
        )
        .all(document.libraryDocumentId),
    ) as { payload: Uint8Array; content_hash: string }[];
    expect(rows).toHaveLength(1);
    const journal = decodeJson(rows[0]!.payload);
    expect(rows[0]!.content_hash).toBe(hashJson(journal));
    expect(journal).toMatchObject({ operations: [{ block: { assetId: ownId } }] });
    for (const id of ids)
      expect((await runtime.assetStore.readAsset(id)).preview).toEqual(f.source.preview);
    expect(
      (await readdir(join(f.root, "assets"))).filter((n) => n.endsWith(".asset")),
    ).toHaveLength(4);
    expect(runtime.recoveryReport.quarantinedPatentIds).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test("copies patent resources into templates and copies template resources into each new patent", async () => {
  const root = await mkdtemp(join(tmpdir(), "template-isolation-"));
  roots.push(root);
  const runtime = await createLibraryRuntime({
    libraryRoot: root,
    readOnly: false,
    runRecovery: false,
    startBackgroundSchedulers: false,
  });
  try {
    const sourcePatent = await runtime.patents.create({
      name: "来源",
      patentType: "invention",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const source = await runtime.assetStore.install(
      { kind: "patent", patentId: sourcePatent.patentId },
      asset(),
    );
    const editor = runtime.patentTemplates.openEditor({ patentType: "invention" });
    const slot = editor.catalog.invention.slots[0]!;
    const factory = createFactoryPatentTemplates(() => randomUUID()).invention;
    Object.assign(slot, {
      claims: factory.claims,
      description: factory.description,
      abstract: factory.abstract,
    });
    slot.claims!.content.push({
      id: randomUUID(),
      type: "chemical-structure",
      ketSource: "(ket) (atom O)",
      previewAssetId: source.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    });
    editor.catalog.invention.selection = { kind: "custom", templateId: slot.templateId };
    const saved = await runtime.patentTemplates.saveEditor({
      ...editor,
      expectedRevision: editor.catalog.revision,
    });
    const sourceTemplate = runtime.patentTemplates.resolveCreationSource("invention");
    expect(sourceTemplate.assetIds[0]).not.toBe(source.descriptor.assetId);
    expect(saved.catalog.invention.slots[0]!.claims!.content.at(-1)).toMatchObject({
      previewAssetId: sourceTemplate.assetIds[0],
    });
    const templates = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
    templates.invention = sourceTemplate.templates;
    const first = await runtime.patents.create({
      name: "模板一",
      patentType: "invention",
      templates,
      templateAssetIds: sourceTemplate.assetIds,
    });
    const second = await runtime.patents.create({
      name: "模板二",
      patentType: "invention",
      templates,
      templateAssetIds: sourceTemplate.assetIds,
    });
    expect(
      new Set([
        source.descriptor.assetId,
        sourceTemplate.assetIds[0],
        first.patent.assets[0]!.assetId,
        second.patent.assets[0]!.assetId,
      ]).size,
    ).toBe(4);
    for (const opened of [first, second]) {
      expect(
        opened.patent.books.find((book) => book.kind === "claims")!.document.content.at(-1),
      ).toMatchObject({ previewAssetId: opened.patent.assets[0]!.assetId });
      expect(
        (await runtime.assetStore.readAsset(opened.patent.assets[0]!.assetId)).preview,
      ).toEqual(asset().preview);
    }
    const removedAssetId = first.patent.assets[0]!.assetId;
    const claims = structuredClone(
      first.patent.books.find((book) => book.kind === "claims")!.document,
    );
    claims.content = claims.content.filter((block) => block.type !== "chemical-structure");
    await runtime.patents.applyBookEdit({
      patentId: first.patentId,
      sessionId: first.sessionId,
      expectedRevision: first.revision,
      bookKind: "claims",
      document: claims,
      editorState: {},
      assets: [],
    });
    await runtime.patents.release(first.sessionId);
    expect(
      (await runtime.snapshots.list(first.patentId)).find((snapshot) => snapshot.revision === 0)
        ?.status,
    ).toBe("healthy");
    const initial = await runtime.snapshots.open(first.patentId, 0);
    expect(
      initial.patent.books.find((book) => book.kind === "claims")!.document.content.at(-1),
    ).toMatchObject({ type: "chemical-structure", previewAssetId: removedAssetId });
    expect(await runtime.snapshots.previewAsset(first.patentId, 0, removedAssetId)).toEqual(
      asset().preview,
    );
    expect((await runtime.assetStore.readAsset(removedAssetId)).preview).toEqual(asset().preview);
  } finally {
    await runtime.close();
  }
});
