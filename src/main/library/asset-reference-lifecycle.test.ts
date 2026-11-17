import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { AssetStore } from "./asset-store.js";
import { hashJson } from "./edit-journal.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { PatentService } from "./patent-service.js";
import { SnapshotService } from "./snapshot-service.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

test("superseded CAD resources leave current ownership while document snapshots and undo retain shared assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwb-resource-lifecycle-"));
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("fixture database");
  const { database } = prepared;
  let n = 1;
  const assets = new AssetStore({ root, database, randomUUID: () => uuid(n++) });
  const patents = new PatentService({
    database,
    assetStore: assets,
    randomUUID: () => uuid(n++),
    adoptAsset: (owner, id) => assets.adopt(owner, id),
    collectUnusedAssets: async (patentId) => {
      await assets.collectUnreferenced({ kind: "patent", patentId });
    },
  });
  try {
    const opened = await patents.create({
      patentType: "invention",
      name: "资源生命周期",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const png = new Uint8Array(await readFile(resolve("tests/fixtures/images/sample.png")));
    const install = async (version: number) => {
      const original = Uint8Array.from([...png, version]);
      const asset: StoredAsset = {
        original,
        preview: png,
        descriptor: {
          assetId: uuid(1000 + version),
          kind: "image",
          originalName: `${version}.png`,
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
      return (await assets.install({ kind: "patent", patentId: opened.patentId }, asset))
        .descriptor;
    };
    const first = await install(1);
    const firstProject = drawingProjectFixture(first.assetId);
    const firstAck = await patents.applyFigureEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: opened.revision,
      figures: [{ figureId: uuid(900), assetId: first.assetId, widthMm: 80 }],
      abstractDrawingFigureId: null,
      assets: [first],
      drawingProjects: [firstProject],
    });
    const snapshots = new SnapshotService({
      database,
      readAssetPreview: async (id) => (await assets.readAsset(id)).preview,
      validateAsset: async (id) => {
        await assets.readAsset(id);
      },
      leaseAssets: (ids) => assets.leaseSnapshotAssets(ids),
    });
    await snapshots.create(opened.patentId, "manual-create");
    // Simulate an existing version with surplus descriptors; preserve its raw contract and hash.
    const legacyOnly = await install(3);
    const legacy = database.read((db) =>
      db
        .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = ?")
        .get(opened.patentId, firstAck.revision),
    ) as { payload: Uint8Array };
    const value = JSON.parse(Buffer.from(legacy.payload).toString()) as {
      formatVersion: number;
      patent: CanonicalPatent;
    };
    value.formatVersion = 1;
    value.patent.drawingProjects = [firstProject];
    value.patent.assets.push(legacyOnly);
    const legacyBytes = Buffer.from(JSON.stringify(value));
    const legacyHash = hashJson(value);
    database.transaction((db) =>
      db
        .prepare(
          "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = ?",
        )
        .run(legacyBytes, legacyHash, opened.patentId, firstAck.revision),
    );
    await snapshots.reconcileAssetReferences();
    expect((await snapshots.open(opened.patentId, firstAck.revision)).patent.assets).toEqual([
      first,
    ]);
    expect(
      database.read((db) =>
        db
          .prepare(
            "SELECT asset_id FROM snapshot_assets WHERE patent_id = ? AND revision = ? ORDER BY asset_id",
          )
          .all(opened.patentId, firstAck.revision),
      ),
    ).toEqual([{ asset_id: first.assetId }, { asset_id: legacyOnly.assetId }]);
    const unchanged = database.read((db) =>
      db
        .prepare("SELECT payload, content_hash FROM snapshots WHERE patent_id = ? AND revision = ?")
        .get(opened.patentId, firstAck.revision),
    ) as { payload: Uint8Array; content_hash: string };
    expect(Buffer.from(unchanged.payload)).toEqual(legacyBytes);
    expect(unchanged.content_hash).toBe(legacyHash);
    const legacyState = database.read((db) =>
      db
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get(`patent:${opened.patentId}:figure-state`),
    ) as { value: Uint8Array };
    const state = JSON.parse(Buffer.from(legacyState.value).toString()) as {
      assets: Array<typeof first>;
    };
    state.assets.push(legacyOnly);
    database.transaction((db) =>
      db
        .prepare("UPDATE library_state SET value = ? WHERE key = ?")
        .run(Buffer.from(JSON.stringify(state)), `patent:${opened.patentId}:figure-state`),
    );
    const legacyRevision = patents.loadSavedPatent(opened.patentId).revision;
    expect(legacyRevision).toBe(firstAck.revision);
    const cleaned = await patents.applyFigureEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: legacyRevision,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [first, legacyOnly],
      drawingProjects: [firstProject],
    });
    expect(
      database.read((db) =>
        db.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(opened.patentId),
      ),
    ).toEqual([{ asset_id: first.assetId }]);
    const second = await install(2);
    const secondProject = {
      ...firstProject,
      sourceAssetId: second.assetId,
      baseAssetId: second.assetId,
    };
    const secondAck = await patents.applyFigureEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: cleaned.revision,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [first, second],
      drawingProjects: [secondProject],
    });
    expect(patents.loadSavedPatent(opened.patentId).assets.map((a) => a.assetId)).toEqual([
      second.assetId,
    ]);
    expect(
      database.read((db) =>
        db.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(opened.patentId),
      ),
    ).toEqual([{ asset_id: second.assetId }]);
    await expect(assets.readAsset(first.assetId)).resolves.toBeDefined();
    expect(
      (await snapshots.open(opened.patentId, firstAck.revision)).patent.drawingProjects,
    ).toEqual([]);
    let latestRevision = secondAck.revision;
    const history = [first, second];
    for (let version = 4; version < 34; version++) {
      const current = await install(version);
      history.push(current);
      const saved = await patents.applyFigureEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        expectedRevision: latestRevision,
        figures: [],
        abstractDrawingFigureId: null,
        assets: history,
        drawingProjects: [
          { ...firstProject, sourceAssetId: current.assetId, baseAssetId: current.assetId },
        ],
      });
      latestRevision = saved.revision;
      expect(patents.loadSavedPatent(opened.patentId).assets.map((a) => a.assetId)).toEqual([
        current.assetId,
      ]);
      expect(
        database.read((db) =>
          db
            .prepare("SELECT count(*) AS n FROM patent_assets WHERE patent_id = ?")
            .get(opened.patentId),
        ),
      ).toEqual({ n: 1 });
    }
    // Restoring an undo state may provide the old descriptor, without discarding the redo asset.
    await patents.applyFigureEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: latestRevision,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [first, second],
      drawingProjects: [firstProject],
    });
    expect(patents.loadSavedPatent(opened.patentId).assets.map((a) => a.assetId)).toEqual([
      first.assetId,
    ]);
    await expect(assets.readAsset(second.assetId)).resolves.toBeDefined();
    await patents.release(opened.sessionId);
    await expect(assets.readAsset(first.assetId)).resolves.toBeDefined();
    await expect(assets.readAsset(second.assetId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assets.readAsset(legacyOnly.assetId)).resolves.toBeDefined();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
