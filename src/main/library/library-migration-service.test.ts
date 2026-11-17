import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LibraryMigrationService } from "./library-migration-service.js";
import {
  CURRENT_SCHEMA_VERSION,
  V8_MIGRATION_STATEMENTS,
  V9_MIGRATION_STATEMENTS,
  V10_MIGRATION_STATEMENTS,
  V10_UPGRADE_FROM_V9_STATEMENTS,
  V11_MIGRATION_STATEMENTS,
  V12_MIGRATION_STATEMENTS,
  V12_UPGRADE_FROM_V10_STATEMENTS,
  V13_UPGRADE_FROM_V12_STATEMENTS,
  validateCurrentSchema,
  validateSchemaV10,
  validateSchemaV12,
} from "./schema.js";

const roots: string[] = [];

test.runIf(process.platform === "win32")(
  "does not misclassify a healthy long-path migration copy as corrupt",
  async () => {
    const root = await createRoot();
    const source = join(root, "short-source");
    const initial = await new LibraryMigrationService(source).prepare();
    if (initial.status !== "ready") throw new Error("fixture preparation failed");
    initial.database.close();
    const target = join(
      root,
      ...Array.from({ length: 4 }, () => "migration-path-".repeat(5)),
      "Library",
    );
    expect(target.length).toBeGreaterThan(260);
    await cp(source, target, { recursive: true });
    const prepared = await new LibraryMigrationService(target).prepare();
    try {
      expect(prepared.status).toBe("ready");
    } finally {
      prepared.database?.close();
    }
  },
);

test("rolls back the new DOCX tables without changing the main schema", () => {
  using database = new DatabaseSync(":memory:");
  for (const sql of V12_MIGRATION_STATEMENTS) database.exec(sql);
  database.exec("UPDATE patent_template_slots SET name = '保留模板' WHERE slot_index = 5");
  database.exec("BEGIN EXCLUSIVE");
  for (const sql of V13_UPGRADE_FROM_V12_STATEMENTS) database.exec(sql);
  expect(() => database.exec("INSERT INTO missing_merge_table VALUES(1)")).toThrow();
  database.exec("ROLLBACK");
  expect(validateSchemaV12(database)).toEqual({ ok: true });
  expect(
    database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_slots WHERE name = '保留模板'")
      .get(),
  ).toEqual({ count: 2 });
});

test.each([11, 12])(
  "upgrades V%s to the combined schema without losing templates or data",
  async (version) => {
    const root = await createRoot();
    const old = new DatabaseSync(join(root, "library.sqlite3"));
    for (const sql of version === 11 ? V11_MIGRATION_STATEMENTS : V12_MIGRATION_STATEMENTS)
      old.exec(sql);
    old.exec(
      "UPDATE patent_template_slots SET name = '用户原模板', template_revision = 7 WHERE slot_index = 1",
    );
    old
      .prepare("INSERT INTO library_state VALUES (?, ?, ?)")
      .run("merge-probe", Buffer.from("已有数据"), "2026-09-09T00:00:00.000Z");
    old
      .prepare("INSERT INTO patents VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', NULL)")
      .run("merge-patent", "原有专利", null, "invention", 1, 0, "2026-09-09", "2026-09-09");
    if (version === 11) {
      old
        .prepare("INSERT INTO patent_auxiliary_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          "merge-patent",
          "legacy-aux",
          0,
          "历史文档",
          3,
          Buffer.from("正文"),
          Buffer.from("{}"),
          "历史.docx",
        );
      old
        .prepare("INSERT INTO patent_import_reports VALUES (?, ?, ?)")
        .run("merge-patent", Buffer.from("历史报告"), "2026-09-09");
    }
    old.close();
    const result = await new LibraryMigrationService(root).prepare();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("upgrade failed");
    using database = result.database;
    expect(result.backupCreated).toBe(true);
    expect(database.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(database.read(validateCurrentSchema)).toEqual({ ok: true });
    expect(database.foreignKeyCheck().ok).toBe(true);
    expect(
      database.read((raw) =>
        raw.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get(),
      ),
    ).toEqual({ count: 10 });
    expect(
      database.read((raw) =>
        raw
          .prepare("SELECT name, template_revision FROM patent_template_slots WHERE slot_index = 1")
          .all(),
      ),
    ).toEqual([
      { name: "用户原模板", template_revision: 7 },
      { name: "用户原模板", template_revision: 7 },
    ]);
    expect(
      database.read((raw) =>
        raw.prepare("SELECT name FROM patents WHERE patent_id = 'merge-patent'").get(),
      ),
    ).toEqual({ name: "原有专利" });
    const data = database.read((raw) =>
      raw.prepare("SELECT value FROM library_state WHERE key = 'merge-probe'").get(),
    );
    expect(Buffer.from(data?.value as Uint8Array).toString()).toBe("已有数据");
    if (version === 11) {
      const document = database.read((raw) =>
        raw.prepare("SELECT document_json FROM patent_auxiliary_documents").get(),
      );
      expect(Buffer.from(document?.document_json as Uint8Array).toString()).toBe("正文");
      const report = database.read((raw) =>
        raw.prepare("SELECT report_json FROM patent_import_reports").get(),
      );
      expect(Buffer.from(report?.report_json as Uint8Array).toString()).toBe("历史报告");
    }
  },
);

test("upgrades three-slot templates with backup, preserving contents and preferences", async () => {
  const libraryRoot = await createRoot();
  const old = new DatabaseSync(join(libraryRoot, "library.sqlite3"));
  for (const sql of V10_MIGRATION_STATEMENTS) old.exec(sql);
  old
    .prepare(
      "UPDATE patent_template_slots SET name = '保留模板' WHERE slot_index = 1 AND patent_type = 'invention'",
    )
    .run();
  old
    .prepare(
      "UPDATE patent_template_preferences SET selection_kind = 'custom', selected_template_id = '00000000-0000-4000-8000-000000000001' WHERE patent_type = 'invention'",
    )
    .run();
  old.close();
  const result = await new LibraryMigrationService(libraryRoot).prepare();
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("upgrade failed");
  using database = result.database;
  expect(result.backupCreated).toBe(true);
  expect(database.read(validateCurrentSchema)).toEqual({ ok: true });
  expect(database.foreignKeyCheck().ok).toBe(true);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT name FROM patent_template_slots WHERE template_id = '00000000-0000-4000-8000-000000000001'",
        )
        .get(),
    ),
  ).toEqual({ name: "保留模板" });
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT selected_template_id FROM patent_template_preferences WHERE patent_type = 'invention'",
        )
        .get(),
    ),
  ).toEqual({ selected_template_id: "00000000-0000-4000-8000-000000000001" });
});

async function createRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "plaintext-library-migration-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

test("creates a fresh current plaintext library without a key envelope", async () => {
  const libraryRoot = await createRoot();
  const prepared = await new LibraryMigrationService(libraryRoot).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") return;
  using database = prepared.database;

  expect(database.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  expect(database.read(validateCurrentSchema)).toEqual({ ok: true });
  await expect(access(join(libraryRoot, "key-envelope.bin"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("rolls back a failed template-table rebuild without losing existing slots", () => {
  using database = new DatabaseSync(":memory:");
  for (const sql of V10_MIGRATION_STATEMENTS) database.exec(sql);
  database.exec("UPDATE patent_template_slots SET name = '原模板' WHERE slot_index = 1");
  database.exec("BEGIN EXCLUSIVE");
  for (const sql of V12_UPGRADE_FROM_V10_STATEMENTS.slice(0, 6)) database.exec(sql);
  expect(() => database.exec("INSERT INTO missing_table VALUES(1)")).toThrow();
  database.exec("ROLLBACK");
  expect(validateSchemaV10(database)).toEqual({ ok: true });
  expect(
    database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_slots WHERE name = '原模板'")
      .get(),
  ).toEqual({ count: 2 });
});

test("upgrades an existing V10 library to current without changing existing rows", async () => {
  const libraryRoot = await createRoot();
  const databasePath = join(libraryRoot, "library.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  for (const statement of V10_MIGRATION_STATEMENTS) legacy.exec(statement);
  legacy
    .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
    .run("v10-probe", Buffer.from("保留", "utf8"), "2026-08-31T00:00:00.000Z");
  legacy.close();

  const prepared = await new LibraryMigrationService(libraryRoot).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") return;
  using database = prepared.database;

  expect(database.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  expect(database.read(validateCurrentSchema)).toEqual({ ok: true });
  const row = database.read((raw) =>
    raw.prepare("SELECT value FROM library_state WHERE key = ?").get("v10-probe"),
  ) as { value: Uint8Array };
  expect(Buffer.from(row.value).toString("utf8")).toBe("保留");
});

test("upgrades an existing V9 library with a verified backup", async () => {
  const libraryRoot = await createRoot();
  const databasePath = join(libraryRoot, "library.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  for (const statement of V9_MIGRATION_STATEMENTS) legacy.exec(statement);
  legacy
    .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
    .run("plain-probe", Buffer.from("可直接读取", "utf8"), "2026-08-20T00:00:00.000Z");
  legacy.close();

  const reopened = await new LibraryMigrationService(libraryRoot).prepare();
  expect(reopened.status).toBe("ready");
  if (reopened.status !== "ready") return;
  using database = reopened.database;
  expect(reopened.backupCreated).toBe(true);
  expect(database.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  expect(database.read(validateCurrentSchema)).toEqual({ ok: true });
  const row = database.read((raw) =>
    raw.prepare("SELECT value FROM library_state WHERE key = ?").get("plain-probe"),
  ) as { value: Uint8Array };
  expect(Buffer.from(row.value).toString("utf8")).toBe("可直接读取");
});

test("rolls back every V9 upgrade statement when migration fails", async () => {
  const libraryRoot = await createRoot();
  const databasePath = join(libraryRoot, "library.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  for (const statement of V9_MIGRATION_STATEMENTS) legacy.exec(statement);
  legacy
    .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
    .run("rollback-probe", Buffer.from("保留", "utf8"), "2026-08-20T00:00:00.000Z");
  legacy.close();

  const prepared = await new LibraryMigrationService(libraryRoot, {
    upgradeFromV9Statements: [
      ...V10_UPGRADE_FROM_V9_STATEMENTS.slice(0, 1),
      "INSERT INTO missing_upgrade_table(value) VALUES (1)",
    ],
  }).prepare();

  expect(prepared).toMatchObject({ status: "upgrade-failed", reason: "migration-failed" });
  if (prepared.status === "upgrade-failed") prepared.database?.close();
  using database = new DatabaseSync(databasePath, { readOnly: true });
  expect(database.prepare("SELECT version FROM schema_migrations").get()).toEqual({ version: 9 });
  expect(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("patent_template_slots"),
  ).toBeUndefined();
  const row = database
    .prepare("SELECT value FROM library_state WHERE key = ?")
    .get("rollback-probe") as { value: Uint8Array };
  expect(Buffer.from(row.value).toString("utf8")).toBe("保留");
});

test("reopens an existing current-version library without backup or mutation", async () => {
  const libraryRoot = await createRoot();
  const first = await new LibraryMigrationService(libraryRoot).prepare();
  if (first.status !== "ready") throw new Error("fixture");
  first.database.transaction((database) =>
    database
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("plain-probe", Buffer.from("可直接读取", "utf8"), "2026-08-20T00:00:00.000Z"),
  );
  first.database.close();

  const reopened = await new LibraryMigrationService(libraryRoot).prepare();
  expect(reopened.status).toBe("ready");
  if (reopened.status !== "ready") return;
  using database = reopened.database;
  expect(reopened.backupCreated).toBe(false);
  const row = database.read((raw) =>
    raw.prepare("SELECT value FROM library_state WHERE key = ?").get("plain-probe"),
  ) as { value: Uint8Array };
  expect(Buffer.from(row.value).toString("utf8")).toBe("可直接读取");
});

test("rejects an old V8 library without modifying or replacing it", async () => {
  const libraryRoot = await createRoot();
  const databasePath = join(libraryRoot, "library.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  for (const statement of V8_MIGRATION_STATEMENTS) legacy.exec(statement);
  legacy.close();
  const before = await readFile(databasePath);

  const prepared = await new LibraryMigrationService(libraryRoot).prepare();
  expect(prepared).toMatchObject({ status: "upgrade-failed", reason: "unsupported-schema" });
  expect(await readFile(databasePath)).toEqual(before);
});

test("fails closed when assets exist without a database", async () => {
  const libraryRoot = await createRoot();
  await mkdir(join(libraryRoot, "assets"));
  await expect(new LibraryMigrationService(libraryRoot).prepare()).resolves.toMatchObject({
    status: "upgrade-failed",
    reason: "incomplete-library",
  });
});
