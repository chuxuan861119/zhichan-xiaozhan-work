import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LibraryDirectoryMigrationError,
  migrateDefaultLibraryDirectory,
} from "./library-directory-migration.js";
import { LibraryMigrationService } from "./library-migration-service.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zhichan-library-directory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("atomically moves the legacy application directory to the renamed location", async () => {
  const localAppData = await fixture();
  const legacyLibrary = join(localAppData, "PatentWorkbench", "Library");
  await mkdir(join(legacyLibrary, "assets", "aa"), { recursive: true });
  await writeFile(join(legacyLibrary, "library.sqlite3"), "database");
  await writeFile(join(legacyLibrary, "assets", "aa", "asset.bin"), "asset");

  const result = await migrateDefaultLibraryDirectory({ localAppData });

  expect(result.status).toBe("migrated");
  if (result.libraryRoot === null) throw new Error("default migration returned an override result");
  expect(result.libraryRoot).toBe(join(localAppData, "ZhichanXiaozhanWork", "Library"));
  await expect(readFile(join(result.libraryRoot, "library.sqlite3"), "utf8")).resolves.toBe(
    "database",
  );
  await expect(
    readFile(join(result.libraryRoot, "assets", "aa", "asset.bin"), "utf8"),
  ).resolves.toBe("asset");
  await expect(readFile(join(legacyLibrary, "library.sqlite3"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("uses the renamed directory without creating or scanning the legacy directory", async () => {
  const localAppData = await fixture();

  await expect(migrateDefaultLibraryDirectory({ localAppData })).resolves.toEqual({
    status: "not-needed",
    libraryRoot: join(localAppData, "ZhichanXiaozhanWork", "Library"),
  });
});

test("blocks startup when both renamed and legacy directories contain data", async () => {
  const localAppData = await fixture();
  const legacy = join(localAppData, "PatentWorkbench");
  const current = join(localAppData, "ZhichanXiaozhanWork");
  await mkdir(legacy, { recursive: true });
  await mkdir(current, { recursive: true });
  await writeFile(join(legacy, "legacy.txt"), "legacy");
  await writeFile(join(current, "current.txt"), "current");

  await expect(migrateDefaultLibraryDirectory({ localAppData })).rejects.toMatchObject({
    code: "LIBRARY_DIRECTORY_CONFLICT",
    paths: [legacy, current],
  });
});

test("keeps the legacy directory intact when the atomic move fails", async () => {
  const localAppData = await fixture();
  const legacyLibrary = join(localAppData, "PatentWorkbench", "Library");
  await mkdir(legacyLibrary, { recursive: true });
  await writeFile(join(legacyLibrary, "library.sqlite3"), "kept");

  await expect(
    migrateDefaultLibraryDirectory({
      localAppData,
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    }),
  ).rejects.toBeInstanceOf(LibraryDirectoryMigrationError);
  await expect(readFile(join(legacyLibrary, "library.sqlite3"), "utf8")).resolves.toBe("kept");
  await expect(
    readFile(join(localAppData, "ZhichanXiaozhanWork", "Library", "library.sqlite3"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("does not migrate default directories when an explicit library override is active", async () => {
  const localAppData = await fixture();
  const legacyLibrary = join(localAppData, "PatentWorkbench", "Library");
  await mkdir(legacyLibrary, { recursive: true });
  await writeFile(join(legacyLibrary, "library.sqlite3"), "kept");

  await expect(
    migrateDefaultLibraryDirectory({ localAppData, hasExplicitOverride: true }),
  ).resolves.toEqual({ status: "overridden", libraryRoot: null });
  await expect(readFile(join(legacyLibrary, "library.sqlite3"), "utf8")).resolves.toBe("kept");
});

test("reopens the migrated SQLite library with its persisted state and asset bytes", async () => {
  const localAppData = await fixture();
  const legacyLibrary = join(localAppData, "PatentWorkbench", "Library");
  await mkdir(legacyLibrary, { recursive: true });
  const prepared = await new LibraryMigrationService(legacyLibrary).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture library did not open");
  prepared.database.transaction((database) => {
    database
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("migration-proof", Buffer.from("persisted"), "2026-08-16T00:00:00.000Z");
  });
  prepared.database.close();
  await mkdir(join(legacyLibrary, "assets"), { recursive: true });
  await writeFile(join(legacyLibrary, "assets", "proof.bin"), "asset-bytes");

  const migrated = await migrateDefaultLibraryDirectory({ localAppData });
  if (migrated.libraryRoot === null)
    throw new Error("default migration returned an override result");
  const reopened = await new LibraryMigrationService(migrated.libraryRoot).prepare();

  expect(reopened.status).toBe("ready");
  if (reopened.status !== "ready") throw new Error("migrated library did not reopen");
  try {
    const row = reopened.database.read((database) =>
      database.prepare("SELECT value FROM library_state WHERE key = ?").get("migration-proof"),
    ) as { value: Uint8Array };
    expect(Buffer.from(row.value).toString("utf8")).toBe("persisted");
  } finally {
    reopened.database.close();
  }
  await expect(readFile(join(migrated.libraryRoot, "assets", "proof.bin"), "utf8")).resolves.toBe(
    "asset-bytes",
  );
});
