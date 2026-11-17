import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { AssetStore } from "./asset-store.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { PatentService } from "./patent-service.js";
import { SnapshotService } from "./snapshot-service.js";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function storedAsset(): StoredAsset {
  const original = new Uint8Array([1, 2, 3, 4]);
  const preview = new Uint8Array([9, 8, 7]);
  const descriptor: AssetDescriptor = {
    assetId: testUuid(900),
    kind: "image",
    originalName: "race.png",
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

test("a snapshot in flight pins assets before live cleanup can delete them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwb-snapshot-race-"));
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  const database = prepared.database;
  const _key = Buffer.alloc(32, 13);
  const assets = new AssetStore({
    root,
    database,
    randomUUID: () => testUuid(10_000),
  });
  let collectionStartedResolve: () => void = () => undefined;
  const collectionStarted = new Promise<void>((resolve) => {
    collectionStartedResolve = resolve;
  });
  let uuid = 1;
  const patents = new PatentService({
    database,
    randomUUID: () => testUuid(uuid++),
    assetStore: assets,
    collectUnusedAssets: async (patentId) => {
      collectionStartedResolve();
      await assets.collectUnreferenced({ kind: "patent", patentId });
    },
  });

  try {
    const created = await patents.create({
      patentType: "invention",
      name: "快照资源竞态审查",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const installed = await assets.install(
      { kind: "patent", patentId: created.patentId },
      storedAsset(),
    );
    const withFigure = await patents.applyFigureEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      figures: [{ figureId: testUuid(970), assetId: installed.descriptor.assetId, widthMm: 80 }],
      abstractDrawingFigureId: null,
      assets: [installed.descriptor],
    });
    let workerStartedResolve: () => void = () => undefined;
    let resumeWorkerResolve: () => void = () => undefined;
    const workerStarted = new Promise<void>((resolve) => {
      workerStartedResolve = resolve;
    });
    const resumeWorker = new Promise<void>((resolve) => {
      resumeWorkerResolve = resolve;
    });
    const snapshots = new SnapshotService({
      database,
      readAssetPreview: async (assetId) => (await assets.readAsset(assetId)).preview,
      leaseAssets: (assetIds) => assets.leaseSnapshotAssets(assetIds),
      validateAsset: async (assetId) => {
        await assets.readAsset(assetId);
      },
      worker: async (job) => {
        workerStartedResolve();
        await resumeWorker;
        return SnapshotService.createSnapshotPayload(job);
      },
    });

    const snapshotPromise = snapshots.create(created.patentId, "manual-create");
    await workerStarted;
    const removePromise = patents.applyFigureEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: withFigure.revision,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [],
    });
    await collectionStarted;
    await removePromise;
    resumeWorkerResolve();
    await snapshotPromise;

    await expect(assets.readAsset(installed.descriptor.assetId)).resolves.toMatchObject({
      descriptor: installed.descriptor,
    });
    const retainedSnapshots = await snapshots.list(created.patentId);
    expect(retainedSnapshots).toContainEqual(
      expect.objectContaining({ revision: withFigure.revision, status: "healthy" }),
    );
    expect(retainedSnapshots.every((snapshot) => snapshot.status === "healthy")).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
