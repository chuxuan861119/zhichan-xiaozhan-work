import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { AssetCleanupScheduler } from "./asset-cleanup-scheduler.js";
import { AssetStore } from "./asset-store.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { PatentService } from "./patent-service.js";

async function fixture(remove: typeof unlink) {
  const root = await mkdtemp(join(tmpdir(), "snapshot-cleanup-"));
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("fixture");
  const database = prepared.database;
  const patents = new PatentService({ database });
  const opened = await patents.create({
    patentType: "invention",
    name: "清理验证",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const owner = { kind: "patent" as const, patentId: opened.patentId };
  const assets = new AssetStore({ root, database, fileSystem: { unlink: remove } });
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const installed = await assets.install(owner, {
    descriptor: {
      assetId: randomUUID(),
      kind: "image",
      originalName: "test.png",
      mediaType: "image/png",
      extension: "png",
      widthPx: 1,
      heightPx: 1,
      byteLength: bytes.length,
      sha256: hash,
      previewByteLength: bytes.length,
      previewSha256: hash,
    },
    original: bytes,
    preview: bytes,
  });
  await assets.release(owner);
  const cleanup = new AssetCleanupScheduler(assets, { retryDelaysMs: [0, 0], retryIntervalMs: 10 });
  const rows = () => database.read((raw) => raw.prepare("SELECT asset_id FROM assets").all());
  return {
    assets,
    owner,
    installed,
    cleanup,
    rows,
    async close() {
      await cleanup.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("finishes short-lived file locks within the original cleanup operation", async () => {
  let attempts = 0;
  const f = await fixture(async (path) => {
    if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await unlink(path);
  });
  try {
    await expect(f.cleanup.collect()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(f.rows()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("automatically clears a persistent lock after it is released without user action", async () => {
  let locked = true;
  const f = await fixture(async (path) => {
    if (locked) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await unlink(path);
  });
  try {
    f.cleanup.start();
    await expect(f.cleanup.collect()).resolves.toBeUndefined();
    expect(f.rows()).toHaveLength(1);
    locked = false;
    await vi.waitFor(() => expect(f.rows()).toEqual([]), { timeout: 1000, interval: 10 });
  } finally {
    await f.close();
  }
});

test("pauses cleanup during transfers and resumes pending work afterwards", async () => {
  let locked = true;
  const f = await fixture(async (path) => {
    if (locked) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await unlink(path);
  });
  try {
    f.cleanup.start();
    await f.cleanup.collect();
    const resume = await f.cleanup.suspend();
    locked = false;
    await f.cleanup.collect();
    expect(f.rows()).toHaveLength(1);
    await resume();
    await vi.waitFor(() => expect(f.rows()).toEqual([]), { timeout: 1000, interval: 10 });
  } finally {
    await f.close();
  }
});

test("keeps newly adopted resources when a deferred cleanup is retried", async () => {
  let locked = true;
  const f = await fixture(async (path) => {
    if (locked) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await unlink(path);
  });
  try {
    await f.cleanup.collect();
    await f.assets.adopt(f.owner, f.installed.descriptor.assetId);
    locked = false;
    await f.cleanup.collect();
    expect(f.rows()).toHaveLength(1);
    expect((await f.assets.readAsset(f.installed.descriptor.assetId)).original).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  } finally {
    await f.close();
  }
});
