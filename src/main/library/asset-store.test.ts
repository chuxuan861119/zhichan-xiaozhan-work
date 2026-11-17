import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { AssetStore } from "./asset-store.js";
import { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { LibraryService } from "./library-service.js";
import { PatentService } from "./patent-service.js";
import { V1_SCHEMA_STATEMENTS } from "./schema.js";

const roots: string[] = [];
const databases: LibraryDatabase[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-assets-"));
  roots.push(root);
  return root;
}

async function assetFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, "assets")).catch(() => []))
    .filter((name) => name.endsWith(".asset"))
    .sort((left, right) => left.localeCompare(right));
}

async function tempFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, "assets")).catch(() => []))
    .filter((name) => name.includes(".tmp-"))
    .sort((left, right) => left.localeCompare(right));
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture(options: Partial<ConstructorParameters<typeof AssetStore>[0]> = {}) {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let patentUuid = 1;
  let assetUuid = 10_000;
  const _key = Buffer.alloc(32, 13);
  const service = new PatentService({
    database: prepared.database,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    randomUUID: () => testUuid(patentUuid++),
  });
  const assets = new AssetStore({
    root,
    database: prepared.database,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    randomUUID: () => testUuid(assetUuid++),
    ...options,
  });
  return { root, database: prepared.database, service, assets };
}

test("reuses verified preview bytes, isolates returned buffers, and rejects changed files", async () => {
  const fileRead = vi.fn(readFile);
  const { root, service, assets } = await openFixture({
    fileSystem: { readFile: fileRead as typeof readFile },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "预览缓存",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const source = storedAsset();
  const installed = await assets.install({ kind: "patent", patentId: opened.patentId }, source);
  fileRead.mockClear();
  const first = await assets.preview(installed.descriptor.assetId);
  first[0] = 0;
  expect(await assets.preview(installed.descriptor.assetId)).toEqual(source.preview);
  expect(fileRead).toHaveBeenCalledTimes(1);
  const [file] = await assetFiles(root);
  await writeFile(join(root, "assets", file!), new Uint8Array([0, 1, 2]));
  await expect(assets.preview(installed.descriptor.assetId)).rejects.toThrow();
});

function storedAsset(
  original: Uint8Array = new Uint8Array([1, 2, 3, 4]),
  preview: Uint8Array = new Uint8Array([9, 8, 7]),
  assetId = testUuid(900),
): StoredAsset {
  const descriptor: AssetDescriptor = {
    assetId,
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

test("reuses verified descriptors but detects changed bytes before acknowledging a save", async () => {
  const reads = vi.fn(readFile);
  const { root, service, assets } = await openFixture({
    fileSystem: { readFile: reads as typeof readFile },
  });
  const patent = await service.create({
    patentType: "invention",
    name: "校验缓存",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const imported = await assets.install(
    { kind: "patent", patentId: patent.patentId },
    storedAsset(),
  );
  reads.mockClear();
  const descriptor = await assets.readVerifiedDescriptor(imported.descriptor.assetId);
  descriptor.originalName = "不能污染缓存";
  expect(await assets.readVerifiedDescriptor(imported.descriptor.assetId)).toEqual(
    imported.descriptor,
  );
  expect(reads).toHaveBeenCalledTimes(1);
  const path = join(root, "assets", `${imported.descriptor.sha256}.asset`);
  const bytes = await readFile(path);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await writeFile(path, bytes);
  await expect(assets.readVerifiedDescriptor(imported.descriptor.assetId)).rejects.toThrow();
});

test("retains verification metadata across a large CAD history without rereading bodies", async () => {
  const reads = vi.fn(readFile);
  const { service, assets } = await openFixture({
    fileSystem: { readFile: reads as typeof readFile },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "大量历史",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) {
    const imported = await assets.install(
      { kind: "patent", patentId: opened.patentId },
      storedAsset(new Uint8Array([i & 255, i >> 8]), undefined, testUuid(2000 + i)),
    );
    ids.push(imported.descriptor.assetId);
  }
  for (const id of ids) await assets.readVerifiedDescriptor(id);
  reads.mockClear();
  for (const id of ids) await assets.readVerifiedDescriptor(id);
  expect(reads).not.toHaveBeenCalled();
});

test("book saves collect removed assets and still reject forged cached descriptors", async () => {
  const { database, assets } = await openFixture();
  const collect = vi.fn(async (patentId: string) => {
    await assets.collectUnreferenced({ kind: "patent", patentId });
  });
  const service = new PatentService({ database, assetStore: assets, collectUnusedAssets: collect });
  const opened = await service.create({
    patentType: "invention",
    name: "删除资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const book = opened.patent.books.find((candidate) => candidate.kind === "description");
  if (!book) throw new Error("fixture");
  const edit = {
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    bookKind: "description" as const,
    document: {
      ...book.document,
      content: [
        ...book.document.content,
        {
          id: testUuid(999),
          type: "figure" as const,
          assetId: installed.descriptor.assetId,
          widthMm: 60,
          alignment: "center" as const,
        },
      ],
    },
    editorState: {},
    assets: [installed.descriptor],
  };
  await service.applyBookEdit({ ...edit, expectedRevision: 0 });
  await expect(
    service.applyBookEdit({
      ...edit,
      expectedRevision: 1,
      assets: [{ ...installed.descriptor, sha256: "F".repeat(64) }],
    }),
  ).rejects.toThrow(/does not match/);
  await service.applyBookEdit({
    ...edit,
    document: book.document,
    expectedRevision: 1,
    assets: [],
  });
  expect(collect).toHaveBeenCalledTimes(1);
  expect((await service.open(opened.patentId)).patent.assets).toEqual([]);
});

test("stores independent files for identical images in different patents", async () => {
  const { root, database, service, assets } = await openFixture();
  const first = await service.create({
    patentType: "invention",
    name: "第一件",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "第二件",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const imported = storedAsset();

  const firstInstall = await assets.install({ kind: "patent", patentId: first.patentId }, imported);
  const duplicateInstall = await assets.install(
    { kind: "patent", patentId: second.patentId },
    storedAsset(imported.original, imported.preview, testUuid(901)),
  );

  expect(duplicateInstall.descriptor.assetId).not.toBe(firstInstall.descriptor.assetId);
  expect(await assetFiles(root)).toHaveLength(2);
  expect(await assets.read(firstInstall.descriptor.assetId)).toEqual(imported.original);
  expect(await assets.preview(firstInstall.descriptor.assetId)).toEqual(imported.preview);
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM patent_assets").get()),
  ).toEqual({ count: 2 });
});

test("preserves the incoming preview and metadata when the original image is identical", async () => {
  const { root, service, assets } = await openFixture();
  const first = await service.create({
    patentType: "invention",
    name: "旧图",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "新图",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const old = storedAsset();
  const incoming = storedAsset(old.original, new Uint8Array([6, 5, 4, 3]), old.descriptor.assetId);
  incoming.descriptor.originalName = "new-preview.png";
  const a = await assets.install({ kind: "patent", patentId: first.patentId }, old);
  const b = await assets.install({ kind: "patent", patentId: second.patentId }, incoming);
  expect(b.descriptor.assetId).not.toBe(a.descriptor.assetId);
  expect(b.descriptor).toEqual({ ...incoming.descriptor, assetId: b.descriptor.assetId });
  expect((await assets.readAsset(b.descriptor.assetId)).preview).toEqual(incoming.preview);
  expect((await assets.readAsset(a.descriptor.assetId)).preview).toEqual(old.preview);
  expect(await assetFiles(root)).toHaveLength(2);
});

test("does not reuse stored resources in a different staging session", async () => {
  const { root, assets } = await openFixture();
  const source = storedAsset();
  const [a] = await assets.stageMany(testUuid(501), [source]);
  const [b] = await assets.stageMany(testUuid(502), [source]);
  expect(b!.descriptor.assetId).not.toBe(a!.descriptor.assetId);
  expect(await assetFiles(root)).toHaveLength(2);
  await assets.discardStaged(testUuid(501), [a!.descriptor.assetId]);
  await expect(assets.readAsset(a!.descriptor.assetId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await assets.readAsset(b!.descriptor.assetId)).original).toEqual(source.original);
});

test("rejects adopting another patent's resource without copying it", async () => {
  const { service, assets } = await openFixture();
  const first = await service.create({
    patentType: "invention",
    name: "一",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "二",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const imported = await assets.install(
    { kind: "patent", patentId: first.patentId },
    storedAsset(),
  );
  await expect(
    assets.adopt({ kind: "patent", patentId: second.patentId }, imported.descriptor.assetId),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(assets.references({ kind: "patent" }, [imported.descriptor.assetId])).toEqual([
    first.patentId,
  ]);
});

test("keeps drawing undo assets until the last patent session closes", async () => {
  const { database, assets } = await openFixture();
  const service = new PatentService({
    database,
    assetStore: assets,
    collectUnusedAssets: (patentId) =>
      assets.collectUnreferenced({ kind: "patent", patentId }).then(() => undefined),
  });
  const created = await service.create({
    patentType: "invention",
    name: "撤销资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const owner = { kind: "patent" as const, patentId: created.patentId };
  const installed = await assets.install(owner, storedAsset());
  const second = await service.open(created.patentId);
  await assets.release(owner);
  await assets.collectUnreferenced(owner);
  expect(await assets.read(installed.descriptor.assetId)).toEqual(storedAsset().original);
  await assets.adopt(owner, installed.descriptor.assetId);
  await assets.release(owner);
  await service.release(created.sessionId);
  expect(await assets.read(installed.descriptor.assetId)).toEqual(storedAsset().original);
  await service.release(second.sessionId);
  await expect(assets.read(installed.descriptor.assetId)).rejects.toThrow();
});

test("keeps template preview assets while a custom template owns them", async () => {
  const { root, database, assets } = await openFixture();
  const template = database.read((raw) =>
    raw
      .prepare(
        "SELECT template_id FROM patent_template_slots WHERE patent_type = 'invention' AND slot_index = 1",
      )
      .get(),
  ) as { template_id: string };
  const imported = storedAsset();

  await assets.install({ kind: "patent-template", templateId: template.template_id }, imported);

  expect(
    database.read((raw) =>
      raw.prepare("SELECT template_id, asset_id, purpose FROM template_assets").get(),
    ),
  ).toEqual({
    template_id: template.template_id,
    asset_id: imported.descriptor.assetId,
    purpose: "chemical-preview",
  });
  expect(
    await assets.collectUnreferenced({ kind: "patent-template", templateId: template.template_id }),
  ).toEqual({
    deletedAssetIds: [],
    failedAssetIds: [],
  });

  await assets.release({ kind: "patent-template", templateId: template.template_id });
  expect(
    await assets.collectUnreferenced({ kind: "patent-template", templateId: template.template_id }),
  ).toEqual({
    deletedAssetIds: [imported.descriptor.assetId],
    failedAssetIds: [],
  });
  expect(await assetFiles(root)).toEqual([]);
});

test("collects one patent's independent copy without touching another patent", async () => {
  const { root, database, service, assets } = await openFixture();
  const first = await service.create({
    patentType: "invention",
    name: "第一件",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "第二件",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const installed = await assets.install(
    { kind: "patent", patentId: first.patentId },
    storedAsset(),
  );
  const secondInstalled = await assets.install(
    { kind: "patent", patentId: second.patentId },
    storedAsset(),
  );

  await assets.release({ kind: "patent", patentId: first.patentId });
  expect(await assets.collectUnreferenced({ kind: "patent", patentId: first.patentId })).toEqual({
    deletedAssetIds: [installed.descriptor.assetId],
    failedAssetIds: [],
  });
  expect(await assetFiles(root)).toHaveLength(1);

  await assets.release({ kind: "patent", patentId: second.patentId });
  expect(await assets.collectUnreferenced({ kind: "patent", patentId: second.patentId })).toEqual({
    deletedAssetIds: [secondInstalled.descriptor.assetId],
    failedAssetIds: [],
  });
  expect(await assetFiles(root)).toEqual([]);
  expect(database.read((raw) => raw.prepare("SELECT count(*) AS count FROM assets").get())).toEqual(
    { count: 0 },
  );
});

test("recreates a staged asset after cleanup deletes it before a queued adoption", async () => {
  let resumeCleanup: () => void = () => undefined;
  let signalCleanupPause: () => void = () => undefined;
  const cleanupPaused = new Promise<void>((resolve) => {
    signalCleanupPause = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    resumeCleanup = resolve;
  });
  const { database, service, assets } = await openFixture({
    beforeUnreferencedFileDelete: async () => {
      signalCleanupPause();
      await resume;
    },
  });
  const first = await service.create({
    patentType: "invention",
    name: "清理竞争一",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "清理竞争二",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const shared = storedAsset();
  const installed = await assets.install({ kind: "patent", patentId: first.patentId }, shared);
  await assets.release({ kind: "patent", patentId: first.patentId });

  const cleanup = assets.collectUnreferenced({ kind: "patent", patentId: first.patentId });
  await cleanupPaused;
  const sessionId = testUuid(940);
  const staged = assets.stageMany(sessionId, [shared]);
  const adopted = assets
    .adopt({ kind: "patent", patentId: second.patentId }, installed.descriptor.assetId)
    .catch((error) => error);
  resumeCleanup();

  await expect(cleanup).resolves.toEqual({
    deletedAssetIds: [installed.descriptor.assetId],
    failedAssetIds: [],
  });
  await expect(staged).resolves.toMatchObject([
    { descriptor: { assetId: installed.descriptor.assetId } },
  ]);
  // A queued adoption must not silently take over a different copy. Adopt the
  // actual returned staged resource only after it has been created.
  expect(await adopted).toMatchObject({ code: "NOT_FOUND" });
  await assets.adopt(
    { kind: "patent", patentId: second.patentId },
    (await staged)[0]!.descriptor.assetId,
  );
  await assets.discardStaged(sessionId, [installed.descriptor.assetId]);
  await expect(assets.read(installed.descriptor.assetId)).resolves.toEqual(shared.original);
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM patent_assets").get()),
  ).toEqual({ count: 1 });

  await assets.release({ kind: "patent", patentId: second.patentId });
  await expect(
    assets.collectUnreferenced({ kind: "patent", patentId: second.patentId }),
  ).resolves.toEqual({
    deletedAssetIds: [installed.descriptor.assetId],
    failedAssetIds: [],
  });
});

test("releases the asset mutation lock after a staged write fails", async () => {
  let writes = 0;
  const { assets } = await openFixture({
    afterTempWrite: async () => {
      writes += 1;
      if (writes === 1) throw new Error("first staged write failed");
    },
  });
  const shared = storedAsset();

  await expect(assets.stageMany(testUuid(941), [shared])).rejects.toThrow(
    "first staged write failed",
  );
  await expect(assets.stageMany(testUuid(942), [shared])).resolves.toMatchObject([
    { descriptor: { assetId: shared.descriptor.assetId } },
  ]);
});

test("rejects imported assets whose declared hash does not match the original bytes", async () => {
  const { root, service, assets } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "坏资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const imported = storedAsset();
  imported.descriptor.sha256 = "F".repeat(64);

  await expect(
    assets.install({ kind: "patent", patentId: opened.patentId }, imported),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(await assetFiles(root)).toEqual([]);
});

test("keeps database rows when an unreferenced asset file cannot be removed", async () => {
  const { database, service, assets } = await openFixture({
    fileSystem: {
      unlink: async () => {
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
    },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "文件占用",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );

  await assets.release({ kind: "patent", patentId: opened.patentId });
  expect(await assets.collectUnreferenced({ kind: "patent", patentId: opened.patentId })).toEqual({
    deletedAssetIds: [],
    failedAssetIds: [installed.descriptor.assetId],
  });
  expect(database.read((raw) => raw.prepare("SELECT asset_id FROM assets").all())).toEqual([
    { asset_id: installed.descriptor.assetId },
  ]);
});

test("collects orphan assets even when no owning patents remain", async () => {
  const { database, service, assets, root } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "孤立资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await assets.install({ kind: "patent", patentId: opened.patentId }, storedAsset());
  database.transaction((raw) =>
    raw.prepare("DELETE FROM patents WHERE patent_id = ?").run(opened.patentId),
  );
  expect((await assets.collectUnreferenced()).failedAssetIds).toEqual([]);
  expect(await assetFiles(root)).toEqual([]);
  expect(database.read((raw) => raw.prepare("SELECT asset_id FROM assets").all())).toEqual([]);
});

test("startup cleanup removes only well-formed orphan temp files", async () => {
  const { root, assets } = await openFixture();
  await mkdir(join(root, "assets"), { recursive: true });
  const goodTemp = `${"A".repeat(64)}.tmp-${testUuid(777)}`;
  await writeFile(join(root, "assets", goodTemp), "interrupted");
  await writeFile(join(root, "assets", "notes.tmp-keep"), "not ours");

  await assets.cleanupOrphanTemps();

  expect(await tempFiles(root)).toEqual(["notes.tmp-keep"]);
});

test("an interrupted temp write leaves no database row and is cleaned up on startup", async () => {
  const { root, database, service, assets } = await openFixture({
    afterTempWrite: async () => {
      throw new Error("simulated interruption");
    },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "写入中断",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(
    assets.install({ kind: "patent", patentId: opened.patentId }, storedAsset()),
  ).rejects.toThrow("simulated interruption");
  expect(database.read((raw) => raw.prepare("SELECT count(*) AS count FROM assets").get())).toEqual(
    { count: 0 },
  );
  expect(await tempFiles(root)).toHaveLength(1);

  await assets.cleanupOrphanTemps();
  expect(await tempFiles(root)).toEqual([]);
});

test("startup reconciliation quarantines a referenced tampered asset instead of deleting it", async () => {
  const { root, database, service, assets } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "篡改资源",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const installed = await assets.install(
    { kind: "patent", patentId: opened.patentId },
    storedAsset(),
  );
  const fileName = `${installed.descriptor.sha256}.asset`;
  await writeFile(join(root, "assets", fileName), "tampered ciphertext");

  expect(await assets.reconcile()).toMatchObject({
    quarantinedAssetIds: [installed.descriptor.assetId],
  });
  expect(await assetFiles(root)).toEqual([fileName]);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT key FROM library_state WHERE key = ?")
        .get(`asset:${installed.descriptor.assetId}:quarantine`),
    ),
  ).toEqual({ key: `asset:${installed.descriptor.assetId}:quarantine` });
});

test("stages a whole image batch without exposing patent references until commit", async () => {
  const { root, database, service, assets } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "批次暂存",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const first = storedAsset(new Uint8Array([1, 2, 3]), new Uint8Array([4]), testUuid(910));
  const second = storedAsset(new Uint8Array([5, 6, 7]), new Uint8Array([8]), testUuid(911));

  const staged = await assets.stageMany(opened.sessionId, [first, second]);

  expect(staged.map((asset) => asset.descriptor.assetId)).toEqual([
    first.descriptor.assetId,
    second.descriptor.assetId,
  ]);
  expect(await assetFiles(root)).toHaveLength(2);
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM patent_assets").get()),
  ).toEqual({ count: 0 });

  await assets.commitStaged(
    opened.sessionId,
    staged.map((asset) => asset.descriptor.assetId),
  );
  expect(await assetFiles(root)).toHaveLength(2);
});

test("waits through concurrent file-write epochs and snapshots staged session ids", async () => {
  const firstWrite = deferred();
  const secondWrite = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  let writes = 0;
  const { assets } = await openFixture({
    afterTempWrite: async () => {
      writes += 1;
      if (writes === 1) {
        firstStarted.resolve();
        await firstWrite.promise;
      } else {
        secondStarted.resolve();
        await secondWrite.promise;
      }
    },
  });
  const firstSessionId = testUuid(950);
  const secondSessionId = testUuid(951);
  const firstStage = assets.stageMany(firstSessionId, [storedAsset()]);
  await firstStarted.promise;

  let idle = false;
  const drain = assets.waitForIdle().then((report) => {
    idle = true;
    return report;
  });
  const secondStage = assets.stageMany(secondSessionId, [
    storedAsset(new Uint8Array([5, 6, 7]), new Uint8Array([8]), testUuid(952)),
  ]);
  await secondStarted.promise;

  firstWrite.resolve();
  await firstStage;
  await Promise.resolve();
  expect(idle).toBe(false);

  secondWrite.resolve();
  await secondStage;
  await expect(drain).resolves.toEqual({ stagedSessionIds: [firstSessionId, secondSessionId] });
});

test("propagates a pending file-write failure only after the mutation lock settles", async () => {
  const writeStarted = deferred();
  const writePending = deferred();
  const { assets } = await openFixture({
    afterTempWrite: async () => {
      writeStarted.resolve();
      await writePending.promise;
    },
  });
  const failure = new Error("asset write failed");
  const stageFailure = assets.stageMany(testUuid(953), [storedAsset()]).catch((error) => error);
  await writeStarted.promise;
  const drain = assets.waitForIdle();

  writePending.reject(failure);
  await expect(drain).rejects.toBe(failure);
  await expect(stageFailure).resolves.toBe(failure);
});

test("rolls back every staged row and stored file when a later image in the batch fails", async () => {
  let writes = 0;
  const { root, database, service, assets } = await openFixture({
    afterTempWrite: async () => {
      writes += 1;
      if (writes === 2) throw new Error("second image failed");
    },
  });
  const opened = await service.create({
    patentType: "invention",
    name: "失败批次",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const first = storedAsset(new Uint8Array([1, 2, 3]), new Uint8Array([4]), testUuid(920));
  const second = storedAsset(new Uint8Array([5, 6, 7]), new Uint8Array([8]), testUuid(921));

  await expect(assets.stageMany(opened.sessionId, [first, second])).rejects.toThrow(
    "second image failed",
  );

  expect(await assetFiles(root)).toEqual([]);
  expect(await tempFiles(root)).toEqual([]);
  expect(database.read((raw) => raw.prepare("SELECT count(*) AS count FROM assets").get())).toEqual(
    { count: 0 },
  );
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM patent_assets").get()),
  ).toEqual({ count: 0 });
});

test("releases independent staged files separately for each importing session", async () => {
  const { root, assets } = await openFixture();
  const shared = storedAsset(new Uint8Array([2, 4, 6]), new Uint8Array([8]), testUuid(930));
  const firstSession = testUuid(931);
  const secondSession = testUuid(932);
  const first = await assets.stageMany(firstSession, [shared]);
  const second = await assets.stageMany(secondSession, [
    storedAsset(shared.original, shared.preview, testUuid(933)),
  ]);
  expect(second[0]?.descriptor.assetId).not.toBe(first[0]?.descriptor.assetId);

  await assets.discardStaged(firstSession, [shared.descriptor.assetId]);
  expect(await assetFiles(root)).toHaveLength(1);

  await assets.discardStaged(secondSession, [second[0]!.descriptor.assetId]);
  expect(await assetFiles(root)).toEqual([]);
});

test("releases independent staged files separately for each operation", async () => {
  const { root, assets } = await openFixture();
  const shared = storedAsset(new Uint8Array([2, 4, 6]), new Uint8Array([8]), testUuid(934));
  const sessionId = testUuid(935);
  const first = await assets.stageMany(sessionId, [shared], testUuid(936));
  const second = await assets.stageMany(
    sessionId,
    [storedAsset(shared.original, shared.preview, testUuid(937))],
    testUuid(938),
  );
  expect(second[0]?.descriptor.assetId).not.toBe(first[0]?.descriptor.assetId);

  await assets.discardStaged(sessionId, [shared.descriptor.assetId], testUuid(936));
  expect(await assetFiles(root)).toHaveLength(1);

  await assets.discardStaged(sessionId, [second[0]!.descriptor.assetId], testUuid(938));
  expect(await assetFiles(root)).toEqual([]);
});

test("imports the same asset concurrently without colliding temporary file names", async () => {
  const { root, database, service, assets } = await openFixture();
  const first = await service.create({
    patentType: "invention",
    name: "并发一",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const second = await service.create({
    patentType: "invention",
    name: "并发二",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const shared = storedAsset();

  const [firstImport, secondImport] = await Promise.all([
    assets.install({ kind: "patent", patentId: first.patentId }, shared),
    assets.install({ kind: "patent", patentId: second.patentId }, shared),
  ]);

  expect(secondImport.descriptor.assetId).not.toBe(firstImport.descriptor.assetId);
  expect(await assetFiles(root)).toHaveLength(2);
  expect(await tempFiles(root)).toEqual([]);
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM patent_assets").get()),
  ).toEqual({ count: 2 });
});

test("retains document-owned bytes when a patent replacement collects unused assets", async () => {
  const { database, assets } = await openFixture();
  const _key = Buffer.alloc(32, 13);
  const library = new LibraryService({ database });
  const document = await library.create("普通文档引用");
  const collectUnusedAssets = vi.fn(async (patentId: string) => {
    await assets.collectUnreferenced({ kind: "patent", patentId });
  });
  const patents = new PatentService({
    database,
    assetStore: assets,
    collectUnusedAssets,
  });
  const patent = await patents.create({
    patentType: "invention",
    name: "专利引用",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const installed = await assets.install(
    { kind: "library-document", libraryDocumentId: document.libraryDocumentId },
    storedAsset(),
  );
  await assets.install({ kind: "patent", patentId: patent.patentId }, storedAsset());

  await patents.updateSettings({
    patentId: patent.patentId,
    expectedRevision: 0,
    name: "专利引用",
    patentType: "invention",
    assets: [],
  });

  expect(collectUnusedAssets).toHaveBeenCalledWith(patent.patentId);
  await expect(assets.readAsset(installed.descriptor.assetId)).resolves.toMatchObject({
    descriptor: installed.descriptor,
  });
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM document_assets").get()),
  ).toEqual({ count: 1 });
});

test("rejects a mismatched explicit owner without leaving database rows or final files", async () => {
  const { root, database, service, assets } = await openFixture();
  const opened = await service.create({
    patentType: "invention",
    name: "归属边界",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(
    assets.install({ kind: "library-document", libraryDocumentId: opened.patentId }, storedAsset()),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  expect(database.read((raw) => raw.prepare("SELECT count(*) AS count FROM assets").get())).toEqual(
    { count: 0 },
  );
  expect(await assetFiles(root)).toEqual([]);
});

test("keeps explicit library-document ownership compatible with a legacy V1 schema", async () => {
  const root = await createRoot();
  const database = LibraryDatabase.open(join(root, "legacy-library.sqlite3"));
  databases.push(database);
  database.transaction((raw) => {
    for (const statement of V1_SCHEMA_STATEMENTS) raw.exec(statement);
  });
  const _key = Buffer.alloc(32, 13);
  const library = new LibraryService({ database });
  const opened = await library.create("旧普通文档");
  const assets = new AssetStore({ root, database });

  const installed = await assets.install(
    { kind: "library-document", libraryDocumentId: opened.libraryDocumentId },
    storedAsset(),
  );

  expect(
    database.read((raw) =>
      raw.prepare("SELECT library_document_id, asset_id FROM document_assets").get(),
    ),
  ).toEqual({
    library_document_id: opened.libraryDocumentId,
    asset_id: installed.descriptor.assetId,
  });
  await expect(library.open(opened.libraryDocumentId)).resolves.toMatchObject({
    libraryDocumentId: opened.libraryDocumentId,
  });
});

test("removes a newly finalized file when the owner foreign key disappears", async () => {
  let removeOwner = () => undefined;
  const { root, database, service, assets } = await openFixture({
    afterTempWrite: () => removeOwner(),
  });
  const opened = await service.create({
    patentType: "invention",
    name: "并发删除",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  removeOwner = () => {
    database.transaction((raw) => {
      raw.prepare("DELETE FROM patents WHERE patent_id = ?").run(opened.patentId);
    });
  };

  await expect(
    assets.install({ kind: "patent", patentId: opened.patentId }, storedAsset()),
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);

  expect(database.read((raw) => raw.prepare("SELECT count(*) AS count FROM assets").get())).toEqual(
    { count: 0 },
  );
  expect(await assetFiles(root)).toEqual([]);
});

test("patent inspection verifies actual files without changing saved content and rejects stale or foreign sessions", async () => {
  const { root, database, service, assets } = await openFixture();
  const created = await service.create({
    patentType: "invention",
    name: "资源健康检查",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const first = await assets.install({ kind: "patent", patentId: created.patentId }, storedAsset());
  const second = await assets.install(
    { kind: "patent", patentId: created.patentId },
    storedAsset(new Uint8Array([5, 6, 7, 8]), undefined, testUuid(901)),
  );
  const checked = new PatentService({ database, assetStore: assets });
  const opened = await checked.open(created.patentId);
  const ack = await checked.applyFigureEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [
      { figureId: testUuid(801), assetId: first.descriptor.assetId, widthMm: 80 },
      { figureId: testUuid(802), assetId: second.descriptor.assetId, widthMm: 80 },
    ],
    abstractDrawingFigureId: null,
    assets: [first.descriptor, second.descriptor],
  });
  const request = {
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    expectedRevision: ack.revision,
    operationId: testUuid(803),
  };
  const before = checked.loadSavedPatent(opened.patentId);
  expect((await checked.inspectResources(request)).assets.every((a) => a.status === "ok")).toBe(
    true,
  );
  const row = database.read((db) =>
    db.prepare("SELECT relative_path FROM assets WHERE asset_id=?").get(first.descriptor.assetId),
  ) as { relative_path: string };
  await writeFile(join(root, "assets", row.relative_path), new Uint8Array([0, 1, 2]));
  const damaged = await checked.inspectResources({ ...request, operationId: testUuid(804) });
  expect(damaged.assets).toContainEqual({ assetId: first.descriptor.assetId, status: "damaged" });
  expect(damaged.assets).toContainEqual({ assetId: second.descriptor.assetId, status: "ok" });
  expect(checked.loadSavedPatent(opened.patentId)).toEqual(before);
  await expect(checked.inspectResources({ ...request, expectedRevision: 0 })).rejects.toMatchObject(
    { code: "REVISION_CONFLICT" },
  );
  await expect(
    checked.inspectResources({ ...request, sessionId: testUuid(888) }),
  ).rejects.toMatchObject({ code: "LIBRARY_LOCKED" });
  await checked.release(opened.sessionId);
  await expect(checked.inspectResources(request)).rejects.toMatchObject({ code: "LIBRARY_LOCKED" });
});
