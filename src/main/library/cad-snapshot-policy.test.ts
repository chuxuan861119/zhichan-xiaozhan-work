import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { patentSnapshotContent } from "../../shared/patent/snapshot-scope.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { FileService } from "../documents/file-service.js";
import { AssetStore } from "./asset-store.js";
import { decodePatentRecoverySnapshot, encodePatentRecoverySnapshot } from "./edit-journal.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { installPatdocHistory } from "./patdoc-history-install.js";
import { PatentService } from "./patent-service.js";
import { LibraryRecoveryService } from "./recovery-service.js";
import { importPatentPatdocPayload } from "./register-library-ipc.js";
import { SnapshotService } from "./snapshot-service.js";
import { createSnapshotPayload, createSnapshotPayloadInWorker } from "./snapshot-worker.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pwb-cad-snapshot-policy-"));
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("fixture");
  const database = prepared.database;
  const assets = new AssetStore({ root, database });
  const patents = new PatentService({
    database,
    assetStore: assets,
    adoptAsset: (owner, id) => assets.adopt(owner, id),
    collectUnusedAssets: async (patentId) => {
      await assets.collectUnreferenced({ kind: "patent", patentId });
    },
  });
  const opened = await patents.create({
    patentType: "invention",
    name: "CAD 与文档快照分离",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const snapshots = new SnapshotService({
    database,
    validateAsset: async (id) => {
      await assets.readAsset(id);
    },
    readAssetPreview: (id) => assets.preview(id),
    leaseAssets: (ids) => assets.leaseSnapshotAssets(ids),
  });
  const png = new Uint8Array(await readFile(resolve("tests/fixtures/images/sample.png")));
  const install = async (n: number) => {
    const original = Uint8Array.from([...png, n]);
    const stored: StoredAsset = {
      original,
      preview: png,
      descriptor: {
        assetId: uuid(1000 + n),
        originalName: `cad-${n}.png`,
        kind: "image",
        mediaType: "image/png",
        extension: "png",
        byteLength: original.length,
        sha256: hash(original),
        previewByteLength: png.length,
        previewSha256: hash(png),
        widthPx: 12,
        heightPx: 8,
      },
    };
    return (await assets.install({ kind: "patent", patentId: opened.patentId }, stored)).descriptor;
  };
  return {
    root,
    database,
    assets,
    patents,
    opened,
    snapshots,
    install,
    async close() {
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("CAD-only changes remain saved but do not create patent snapshots", async () => {
  const f = await fixture();
  try {
    const asset = await f.install(1);
    const project = {
      ...drawingProjectFixture(asset.assetId),
      cad: {
        version: 1 as const,
        engine: "cadcraft" as const,
        engineVersion: "0".repeat(40),
        assetId: asset.assetId,
        mapping: { originX: 0, originY: 800, scale: 1 },
        unified: 1 as const,
      },
    };
    const saved = await f.patents.applyFigureEdit({
      patentId: f.opened.patentId,
      sessionId: f.opened.sessionId,
      expectedRevision: 0,
      assets: [asset],
      figures: [],
      abstractDrawingFigureId: null,
      drawingProjects: [project],
    });
    expect(patentSnapshotContent(f.patents.loadSavedPatent(f.opened.patentId))).toEqual(
      patentSnapshotContent((await f.snapshots.open(f.opened.patentId, 0)).patent),
    );
    const automatic = await f.snapshots.create(f.opened.patentId, "automatic");
    expect(automatic.outcome).toBe("already-exists");
    expect(await f.snapshots.list(f.opened.patentId)).toHaveLength(1);
    expect(f.patents.loadSavedPatent(f.opened.patentId).drawingProjects).toEqual([project]);
    expect(saved.revision).toBe(1);
    await f.patents.release(f.opened.sessionId);
    const reopened = await f.patents.open(f.opened.patentId);
    expect(reopened.patent.drawingProjects).toEqual([project]);
    expect((await f.snapshots.create(f.opened.patentId, "patent-close")).outcome).toBe(
      "already-exists",
    );
    const candidate = f.patents.loadSavedPatent(f.opened.patentId);
    const currentProject = candidate.drawingProjects[0];
    if (!currentProject) throw new Error("Missing CAD fixture");
    currentProject.nextLabel = "88";
    await f.patents.applyAutomationChange({
      patentId: candidate.patentId,
      expectedRevision: candidate.revision,
      patent: candidate,
      allowDrawingChanges: true,
    });
    expect((await f.snapshots.create(candidate.patentId, "manual-create")).outcome).toBe(
      "already-exists",
    );
    expect(await f.snapshots.list(candidate.patentId)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("document snapshots keep published figures but exclude CAD-only sources and imported initial snapshots", async () => {
  const f = await fixture();
  try {
    const source = await f.install(1),
      output = await f.install(2);
    const project = drawingProjectFixture(source.assetId);
    const saved = await f.patents.applyFigureEdit({
      patentId: f.opened.patentId,
      sessionId: f.opened.sessionId,
      expectedRevision: 0,
      assets: [source, output],
      figures: [{ figureId: uuid(900), assetId: output.assetId, widthMm: 80 }],
      abstractDrawingFigureId: null,
      drawingProjects: [project],
    });
    const created = await f.snapshots.create(f.opened.patentId, "manual-create");
    expect(created.outcome).toBe("created");
    const snapshot = await f.snapshots.open(f.opened.patentId, saved.revision);
    expect(snapshot.patent.drawingProjects).toHaveLength(0);
    expect(snapshot.patent.assets.map((a) => a.assetId)).toEqual([output.assetId]);
    expect(
      f.database.read((db) =>
        db
          .prepare("SELECT asset_id FROM snapshot_assets WHERE patent_id = ? AND revision = ?")
          .all(f.opened.patentId, saved.revision),
      ),
    ).toEqual([{ asset_id: output.assetId }]);
    const live = f.patents.loadSavedPatent(f.opened.patentId);
    const job = {
      patentId: live.patentId,
      revision: live.revision,
      modelVersion: 3 as const,
      scope: "documents" as const,
      patent: live,
    };
    const direct = createSnapshotPayload(job),
      worker = await createSnapshotPayloadInWorker(job);
    expect(worker.payload).toEqual(direct.payload);
    expect(worker.contentHash).toBe(direct.contentHash);
    expect(JSON.parse(worker.payload.toString()).formatVersion).toBe(3);
    // Complete external files still contain the current editable CAD work.
    const file = join(f.root, "complete.patdoc");
    const files = new FileService();
    expect(
      (
        await files.savePatent(file, {
          patent: live,
          assets: await Promise.all(live.assets.map((a) => f.assets.readAsset(a.assetId))),
        })
      ).ok,
    ).toBe(true);
    const read = await files.openPatent(file);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("fixture export");
    expect(read.value.patent.drawingProjects).toEqual([project]);
    const imported = await importPatentPatdocPayload(
      f.patents,
      f.assets,
      async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      read.value,
    );
    expect(imported.patent.drawingProjects).toHaveLength(1);
    expect((await f.snapshots.open(imported.patentId, 0)).patent.drawingProjects).toEqual([]);
  } finally {
    await f.close();
  }
});

test("legacy snapshot reads and imported snapshot history exclude CAD without rewriting existing payloads", async () => {
  const f = await fixture();
  try {
    const source = await f.install(1),
      output = await f.install(2);
    await f.patents.applyFigureEdit({
      patentId: f.opened.patentId,
      sessionId: f.opened.sessionId,
      expectedRevision: 0,
      assets: [source, output],
      figures: [{ figureId: uuid(900), assetId: output.assetId, widthMm: 80 }],
      abstractDrawingFigureId: null,
      drawingProjects: [drawingProjectFixture(source.assetId)],
    });
    await f.snapshots.create(f.opened.patentId, "manual-create");
    const live = f.patents.loadSavedPatent(f.opened.patentId);
    const legacy = encodePatentRecoverySnapshot(live);
    f.database.transaction((db) =>
      db
        .prepare(
          "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = ?",
        )
        .run(legacy.payload, legacy.contentHash, live.patentId, live.revision),
    );
    expect(
      (await f.snapshots.open(live.patentId, live.revision)).patent.drawingProjects,
    ).toHaveLength(0);
    const row = f.database.read((db) =>
      db
        .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = ?")
        .get(live.patentId, live.revision),
    ) as { payload: Uint8Array };
    expect(Buffer.from(row.payload)).toEqual(legacy.payload);
    const next = f.database.transaction((db) =>
      installPatdocHistory(f.database, db, live, [
        {
          patent: structuredClone(live),
          source: "historical",
          createdAt: live.modifiedAt,
          assets: [],
          flowcharts: [],
        },
      ]),
    );
    expect(next.drawingProjects).toHaveLength(1);
    const rows = f.database.read((db) =>
      db
        .prepare(
          "SELECT revision, model_version, payload, content_hash FROM snapshots WHERE patent_id = ?",
        )
        .all(live.patentId),
    ) as Array<{
      revision: number;
      model_version: number;
      payload: Uint8Array;
      content_hash: string;
    }>;
    for (const entry of rows) {
      const snapshot = decodePatentRecoverySnapshot(entry).patent;
      expect(snapshot.drawingProjects).toHaveLength(0);
      expect(snapshot.assets.map((a) => a.assetId)).toEqual([output.assetId]);
    }
    expect(f.patents.loadSavedPatent(live.patentId).drawingProjects).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("history restore and startup recovery never roll back the current CAD project", async () => {
  const f = await fixture();
  try {
    const source = await f.install(1),
      output = await f.install(2);
    const project = drawingProjectFixture(source.assetId);
    const saved = await f.patents.applyFigureEdit({
      patentId: f.opened.patentId,
      sessionId: f.opened.sessionId,
      expectedRevision: 0,
      assets: [source, output],
      figures: [{ figureId: uuid(900), assetId: output.assetId, widthMm: 80 }],
      abstractDrawingFigureId: null,
      drawingProjects: [project],
    });
    await f.snapshots.create(f.opened.patentId, "manual-create");
    const snapshot = await f.snapshots.open(f.opened.patentId, saved.revision);
    const newer = { ...project, nextLabel: "99", revision: project.revision + 1 };
    const changed = await f.patents.applyFigureEdit({
      patentId: f.opened.patentId,
      sessionId: f.opened.sessionId,
      expectedRevision: saved.revision,
      assets: [source, output],
      figures: snapshot.patent.figures,
      abstractDrawingFigureId: null,
      drawingProjects: [newer],
    });
    const restored = await f.patents.applyAutomationChange({
      patentId: f.opened.patentId,
      expectedRevision: changed.revision,
      patent: snapshot.patent,
      restoreSnapshot: true,
    });
    expect(restored.drawingProjects).toEqual([newer]);
    // Live CAD storage is authoritative, even if a replay journal still describes an earlier checkpoint.
    const stateKey = `patent:${f.opened.patentId}:figure-state`;
    const row = f.database.read((db) =>
      db.prepare("SELECT value FROM library_state WHERE key = ?").get(stateKey),
    ) as { value: Uint8Array };
    const live = JSON.parse(Buffer.from(row.value).toString());
    const latest = { ...newer, nextLabel: "123", revision: newer.revision + 1 };
    live.drawingProjects = [latest];
    f.database.transaction((db) =>
      db
        .prepare("UPDATE library_state SET value = ? WHERE key = ?")
        .run(Buffer.from(JSON.stringify(live)), stateKey),
    );
    const recovered = await new LibraryRecoveryService({ database: f.database }).recoverPatent(
      f.opened.patentId,
    );
    expect(recovered.patent.drawingProjects).toEqual([latest]);
    expect(f.patents.loadSavedPatent(f.opened.patentId).drawingProjects).toEqual([latest]);
  } finally {
    await f.close();
  }
});
