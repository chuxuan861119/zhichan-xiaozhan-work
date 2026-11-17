import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLegacyFactoryPatentTemplatesV1 } from "../../shared/patent/templates.js";
import { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { LibrarySafetyBackupService } from "./library-safety-backup.js";
import { PatentTemplateService } from "./patent-template-service.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-library-safety-backup-"));
  roots.push(root);
  return root;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function createLibraryWithAssets(root: string): Promise<void> {
  const database = new DatabaseSync(join(root, "library.sqlite3"));
  database.exec("CREATE TABLE legacy(value TEXT) STRICT; INSERT INTO legacy VALUES ('preserve')");
  database.close();
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  await writeFile(join(root, "assets", "z.asset"), "z-content");
  await writeFile(join(root, "assets", "nested", "a.asset"), "a-content");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("creates a verified database, WAL/SHM and asset-manifest safety backup", async () => {
  const root = await createRoot();
  await createLibraryWithAssets(root);
  const keeper = new DatabaseSync(join(root, "library.sqlite3"));
  keeper.exec("PRAGMA journal_mode=WAL; INSERT INTO legacy VALUES ('from-wal')");
  const events: string[] = [];

  const backup = await new LibrarySafetyBackupService(root, {
    now: () => new Date("2026-08-01T12:34:56.789Z"),
    onEvent: (event) => events.push(event),
  }).create();
  keeper.close();

  expect(events).toEqual(["backup-database", "backup-wal", "backup-shm", "asset-manifest"]);
  expect(backup.directory.endsWith(join("safety-backups", "20260801T123456789Z"))).toBe(true);
  for (const name of ["library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm"]) {
    expect((await stat(join(backup.directory, name))).isFile()).toBe(true);
  }
  expect(JSON.parse(await readFile(join(backup.directory, "asset-manifest.json"), "utf8"))).toEqual(
    {
      version: 1,
      assets: [
        {
          relativePath: "nested/a.asset",
          size: 9,
          sha256: await sha256(join(root, "assets", "nested", "a.asset")),
        },
        {
          relativePath: "z.asset",
          size: 9,
          sha256: await sha256(join(root, "assets", "z.asset")),
        },
      ],
    },
  );

  using backupDatabase = LibraryDatabase.open(join(backup.directory, "library.sqlite3"));
  expect(backupDatabase.schemaVersion()).toBeNull();
  expect(
    backupDatabase.read((database) =>
      database.prepare("SELECT value FROM legacy ORDER BY rowid").all(),
    ),
  ).toEqual([{ value: "preserve" }, { value: "from-wal" }]);
});

test("removes an incomplete safety backup when copy verification fails", async () => {
  const root = await createRoot();
  await createLibraryWithAssets(root);

  await expect(
    new LibrarySafetyBackupService(root, {
      copyFile: async () => {
        throw new Error("copy failed");
      },
    }).create(),
  ).rejects.toThrow("copy failed");

  expect(await readdir(join(root, "safety-backups"))).toEqual([]);
  expect(await readFile(join(root, "library.sqlite3"))).toBeInstanceOf(Buffer);
});

test("preserves the V10 custom template catalog in the SQLite safety copy", async () => {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("library fixture was not prepared");
  const service = new PatentTemplateService({ database: prepared.database });
  const editor = service.openEditor({ patentType: "invention" });
  const slot = editor.catalog.invention.slots[0];
  if (!slot) throw new Error("template slot fixture missing");
  const factory = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID()).invention;
  slot.name = "安全备份模板";
  slot.claims = structuredClone(factory.claims);
  slot.description = structuredClone(factory.description);
  slot.abstract = structuredClone(factory.abstract);
  editor.catalog.invention.selection = { kind: "custom", templateId: slot.templateId };
  await service.saveEditor({
    sessionId: editor.sessionId,
    expectedRevision: editor.catalog.revision,
    catalog: editor.catalog,
    auxiliary: editor.auxiliary,
  });
  service.closeEditor({ sessionId: editor.sessionId });
  prepared.database.checkpoint();

  const backup = await new LibrarySafetyBackupService(root).create();
  prepared.database.close();

  using backupDatabase = LibraryDatabase.open(join(backup.directory, "library.sqlite3"));
  expect(backupDatabase.schemaVersion()).toBe(15);
  expect(
    backupDatabase.read((database) =>
      database
        .prepare(
          `SELECT s.name, p.selection_kind, s.claims_json IS NOT NULL AS has_claims
             FROM patent_template_slots s
             JOIN patent_template_preferences p ON p.selected_template_id = s.template_id
             WHERE s.patent_type = 'invention' AND s.slot_index = 1`,
        )
        .get(),
    ),
  ).toEqual({ name: "安全备份模板", selection_kind: "custom", has_claims: 1 });
});
