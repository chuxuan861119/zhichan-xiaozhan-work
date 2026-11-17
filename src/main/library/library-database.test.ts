import { copyFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { validateCurrentSchema } from "./schema.js";

const roots: string[] = [];

test.runIf(process.platform === "win32")(
  "writable and read-only connections support long migration paths",
  async () => {
    const path = join(
      await createRoot(),
      ...Array.from({ length: 4 }, () => "migration-path-".repeat(5)),
      "library.sqlite3",
    );
    expect(path.length).toBeGreaterThan(260);
    using writable = LibraryDatabase.open(path);
    writable.read((db) =>
      db.exec(
        "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('synthetic preserved bytes')",
      ),
    );
    using readonly = LibraryDatabase.openReadOnly(path);
    expect(readonly.read((db) => db.prepare("SELECT value FROM sample").get())).toEqual({
      value: "synthetic preserved bytes",
    });
  },
);

test("change tokens detect local writes, rollback, schema changes and another connection", async () => {
  const path = join(await createRoot(), "tokens.sqlite3");
  using first = LibraryDatabase.open(path);
  if (process.env.HARMONY_PROBE_APP) {
    // Prevent a passing host-native run from being mistaken for adapter coverage.
    expect(first.read((db) => "database" in db)).toBe(true);
  }
  first.read((db) => db.exec("CREATE TABLE sample(value TEXT) STRICT"));
  using second = LibraryDatabase.open(path);
  let token = first.changeToken();
  expect(first.changeToken()).toBe(token);
  second.transaction((db) => db.prepare("INSERT INTO sample VALUES (?)").run("external"));
  expect(first.changeToken()).not.toBe(token);
  token = first.changeToken();
  first.transaction((db) => db.prepare("UPDATE sample SET value = ?").run("local"));
  expect(first.changeToken()).not.toBe(token);
  token = first.changeToken();
  expect(() =>
    first.transaction((db) => {
      db.prepare("UPDATE sample SET value = ?").run("rollback");
      throw Error("rollback");
    }),
  ).toThrow();
  expect(first.changeToken()).not.toBe(token);
  expect(first.read((db) => db.prepare("SELECT value FROM sample").get())).toEqual({
    value: "local",
  });
  token = first.changeToken();
  first.read((db) => db.exec("CREATE INDEX sample_value ON sample(value)"));
  expect(first.changeToken()).not.toBe(token);
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-library-database-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("opens a FULL synchronous WAL database without silently upgrading it", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));

  expect(library.read((db) => db.prepare("PRAGMA journal_mode").get())).toEqual({
    journal_mode: "wal",
  });
  expect(library.read((db) => db.prepare("PRAGMA synchronous").get())).toEqual({
    synchronous: 2,
  });
  expect(library.read((db) => db.prepare("PRAGMA foreign_keys").get())).toEqual({
    foreign_keys: 1,
  });
  expect(library.read((db) => db.prepare("PRAGMA busy_timeout").get())).toEqual({
    timeout: 5000,
  });
  expect(library.schemaVersion()).toBeNull();
});

test.runIf(process.platform === "win32")(
  "opens a read-only database beyond the legacy Windows path limit",
  async () => {
    const root = await createRoot();
    const sourcePath = join(root, "source.sqlite3");
    const source = LibraryDatabase.open(sourcePath);
    source.read((database) => database.exec("CREATE TABLE sample(value TEXT) STRICT"));
    source.transaction((database) =>
      database.prepare("INSERT INTO sample VALUES (?)").run("preserved"),
    );
    source.close();

    const longDirectory = join(root, "a".repeat(80), "b".repeat(80), "c".repeat(60));
    await mkdir(longDirectory, { recursive: true });
    const longPath = join(longDirectory, "library.sqlite3");
    expect(longPath.length).toBeGreaterThan(260);
    await copyFile(sourcePath, longPath);

    using reopened = LibraryDatabase.openReadOnly(longPath);
    expect(reopened.read((database) => database.prepare("SELECT value FROM sample").get())).toEqual(
      {
        value: "preserved",
      },
    );
  },
);

test("commits successful transactions and rolls back callback failures", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));
  library.read((db) => db.exec("CREATE TABLE values_table(value TEXT) STRICT"));

  library.transaction((db) => db.prepare("INSERT INTO values_table VALUES (?)").run("kept"));
  expect(() =>
    library.transaction((db) => {
      db.prepare("INSERT INTO values_table VALUES (?)").run("discarded");
      throw new Error("stop");
    }),
  ).toThrow("stop");

  expect(library.read((db) => db.prepare("SELECT value FROM values_table").all())).toEqual([
    { value: "kept" },
  ]);
});

test("surfaces commit and rollback failures without leaking a transaction", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));

  expect(() =>
    library.transaction((db) => {
      db.exec("ROLLBACK");
    }),
  ).toThrow(AggregateError);
  expect(library.read((db) => db.prepare("PRAGMA transaction_state").get())).toBeUndefined();
  expect(() => library.transaction(() => undefined)).not.toThrow();
});

test("creates strict schema, constraints, cascading foreign keys and required indexes", async () => {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") return;
  using library = prepared.database;

  const strictTables = library.read((db) =>
    db
      .prepare(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('patents','patent_books','patent_auxiliary_documents','patent_import_reports','patent_figures','patent_flowcharts','patent_flowchart_source_revisions','snapshot_flowchart_revisions','edit_log_flowchart_revisions','snapshots','edit_log','assets','patent_assets','schema_migrations','library_state') ORDER BY name",
      )
      .all(),
  );
  expect(strictTables).toEqual([
    { name: "assets", strict: 1 },
    { name: "edit_log", strict: 1 },
    { name: "edit_log_flowchart_revisions", strict: 1 },
    { name: "library_state", strict: 1 },
    { name: "patent_assets", strict: 1 },
    { name: "patent_auxiliary_documents", strict: 1 },
    { name: "patent_books", strict: 1 },
    { name: "patent_figures", strict: 1 },
    { name: "patent_flowchart_source_revisions", strict: 1 },
    { name: "patent_flowcharts", strict: 1 },
    { name: "patent_import_reports", strict: 1 },
    { name: "patents", strict: 1 },
    { name: "schema_migrations", strict: 1 },
    { name: "snapshot_flowchart_revisions", strict: 1 },
    { name: "snapshots", strict: 1 },
  ]);

  const indexes = library.read((db) =>
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name),
  );
  expect(indexes).toEqual(
    expect.arrayContaining([
      "patent_assets_asset_id_idx",
      "patents_deleted_at_idx",
      "patents_modified_at_idx",
      "edit_log_patent_revision_idx",
    ]),
  );

  const insertPatent = library.read((db) =>
    db.prepare("INSERT INTO patents VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', NULL)"),
  );
  expect(() =>
    insertPatent.run("patent-negative", null, null, "invention", 1, -1, "c", "m"),
  ).toThrow();
  expect(() => insertPatent.run("patent-type", null, null, "design", 1, 0, "c", "m")).toThrow();
  expect(() =>
    insertPatent.run("patent-drawings", null, null, "invention", 2, 0, "c", "m"),
  ).toThrow();
  insertPatent.run("patent-1", null, null, "invention", 1, 0, "c", "m");
  expect(() =>
    library.read((db) =>
      db
        .prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("missing", 0, 1, Buffer.alloc(1), "hash", "now", "initial"),
    ),
  ).toThrow();

  expect(() =>
    library.read((db) =>
      db
        .prepare(
          "INSERT INTO snapshots(patent_id, revision, model_version, payload, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("patent-1", 0, 1, Buffer.alloc(1), "hash-missing-source", "now"),
    ),
  ).toThrow();

  library.transaction((db) => {
    db.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "patent-1",
      0,
      2,
      Buffer.alloc(1),
      "hash",
      "now",
      "initial",
    );
    db.prepare("DELETE FROM patents WHERE patent_id = ?").run("patent-1");
  });
  expect(library.read((db) => db.prepare("SELECT * FROM snapshots").all())).toEqual([]);
});

test("fresh v10 schema includes snapshot sources and immutable flowchart revisions", async () => {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") return;
  using library = prepared.database;

  expect(library.read((database) => validateCurrentSchema(database))).toEqual({ ok: true });
  expect(
    library.read((database) => database.prepare("PRAGMA table_info(snapshots)").all()),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "source", type: "TEXT", notnull: 1 })]),
  );
  expect(() =>
    library.read((database) =>
      database
        .prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("missing-source", 0, 1, Buffer.alloc(1), "hash-source", "now", "unknown"),
    ),
  ).toThrow();
  expect(
    library.read((database) => database.prepare("PRAGMA table_info(patent_figures)").all()),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "flowchart_link", type: "BLOB" })]),
  );
  expect(
    library.read((database) =>
      database
        .prepare(`SELECT
          (SELECT count(*) FROM patents) AS patents,
          (SELECT count(*) FROM snapshots) AS snapshots,
          (SELECT count(*) FROM edit_log) AS edit_log,
          (SELECT count(*) FROM assets) AS assets,
          (SELECT count(*) FROM patent_assets) AS patent_assets,
          (SELECT count(*) FROM schema_migrations) AS schema_migrations`)
        .get(),
    ),
  ).toEqual({
    patents: 0,
    snapshots: 0,
    edit_log: 0,
    assets: 0,
    patent_assets: 0,
    schema_migrations: 1,
  });
});

test.each([
  ["COMMIT", 1],
  ["ROLLBACK", 0],
] as const)(
  "behavioral schema validation preserves an outer EXCLUSIVE transaction through %s",
  async (outcome, expectedRows) => {
    const root = await createRoot();
    const prepared = await new LibraryMigrationService(root).prepare();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    using library = prepared.database;

    library.read((database) => {
      database.exec("BEGIN EXCLUSIVE");
      database
        .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
        .run(`outer-${outcome}`, Buffer.alloc(1), "now");
      expect(validateCurrentSchema(database)).toEqual({ ok: true });
      expect(database.prepare("SELECT count(*) AS count FROM patents").get()).toEqual({
        count: 0,
      });
      expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 0 });
      database.exec(outcome);
    });

    expect(
      library.read((database) =>
        database.prepare("SELECT count(*) AS count FROM library_state").get(),
      ),
    ).toEqual({ count: expectedRows });
  },
);

test("fails closed for malformed or ambiguous schema migration versions", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));
  library.read((db) => {
    db.exec("CREATE TABLE schema_migrations(version INTEGER)");
    db.exec("INSERT INTO schema_migrations VALUES (1), (2)");
  });

  expect(() => library.schemaVersion()).toThrow(/schema version/iu);
});

test("reports a healthy integrity check with a bounded result API", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));
  library.read((db) => db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY) STRICT"));

  expect(library.integrityCheck()).toEqual({ ok: true });
});

test("reports every foreign key violation without exposing row values", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));
  library.read((db) => {
    db.exec(`
      CREATE TABLE parents(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE children(
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parents(id)
      ) STRICT;
      PRAGMA foreign_keys=OFF;
      INSERT INTO children VALUES
        ('secret-child-one', 'secret-parent-one'),
        ('secret-child-two', 'secret-parent-two');
      PRAGMA foreign_keys=ON;
    `);
  });

  const result = library.foreignKeyCheck();

  expect(result).toEqual({
    ok: false,
    violations: [
      { childTable: "children", parentTable: "parents", foreignKeyIndex: 0 },
      { childTable: "children", parentTable: "parents", foreignKeyIndex: 0 },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/secret/iu);
});

test("reports drawings that refer to a missing asset", async () => {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") return;
  using library = prepared.database;
  library.transaction((database) => {
    database
      .prepare(
        `INSERT INTO patents(
           patent_id, name, customer, patent_type, drawing_books_enabled, revision,
           created_at, modified_at, deleted_at, recovery_state, recovery_error_code
         ) VALUES (?, NULL, NULL, 'invention', 1, 0, ?, ?, NULL, 'healthy', NULL)`,
      )
      .run(
        "00000000-0000-4000-8000-000000000001",
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO patent_figures(
           patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
         ) VALUES (?, ?, ?, 0, 80, '', NULL)`,
      )
      .run(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
      );
  });

  expect(library.foreignKeyCheck()).toEqual({
    ok: false,
    violations: [{ childTable: "patent_figures", parentTable: "assets", foreignKeyIndex: 0 }],
  });
});

test("returns an explicit empty foreign key report for a healthy database", async () => {
  const root = await createRoot();
  using library = LibraryDatabase.open(join(root, "library.sqlite3"));
  library.read((db) =>
    db.exec(
      "CREATE TABLE parents(id TEXT PRIMARY KEY) STRICT; CREATE TABLE children(parent_id TEXT REFERENCES parents(id)) STRICT",
    ),
  );

  expect(library.foreignKeyCheck()).toEqual({ ok: true, violations: [] });
});

test("opens an existing database for independent read-only verification", async () => {
  const root = await createRoot();
  const path = join(root, "library.sqlite3");
  const writable = LibraryDatabase.open(path);
  writable.read((database) =>
    database.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT) STRICT"),
  );
  writable.transaction((database) =>
    database.prepare("INSERT INTO sample(value) VALUES (?)").run("kept"),
  );
  writable.checkpoint();
  writable.close();

  using readonly = LibraryDatabase.openReadOnly(path);

  expect(readonly.read((database) => database.prepare("SELECT value FROM sample").all())).toEqual([
    { value: "kept" },
  ]);
  expect(() =>
    readonly.transaction((database) =>
      database.prepare("INSERT INTO sample(value) VALUES (?)").run("forbidden"),
    ),
  ).toThrow();
  expect(readonly.integrityCheck()).toEqual({ ok: true });
  expect(readonly.foreignKeyCheck()).toEqual({ ok: true, violations: [] });
});

test("returns bounded integrity messages when SQLite detects a damaged page", async () => {
  const root = await createRoot();
  const path = join(root, "library.sqlite3");
  const original = LibraryDatabase.open(path);
  original.read((db) => {
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sample(value BLOB) STRICT");
    const insert = db.prepare("INSERT INTO sample VALUES (?)");
    for (let index = 0; index < 100; index += 1) insert.run(Buffer.alloc(1_000, index));
  });
  original.close();
  const file = await open(path, "r+");
  try {
    await file.write(Buffer.alloc(50, 0xff), 0, 50, 4_096);
    await file.sync();
  } finally {
    await file.close();
  }

  using damaged = LibraryDatabase.open(path);
  const result = damaged.integrityCheck();

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.messages.length).toBeGreaterThan(0);
  expect(result.messages.length).toBeLessThanOrEqual(100);
});

test("checkpoint and close are idempotent while closed operations fail safely", async () => {
  const root = await createRoot();
  const library = LibraryDatabase.open(join(root, "library.sqlite3"));

  expect(() => library.checkpoint()).not.toThrow();
  expect(() => library.checkpoint()).not.toThrow();
  library.close();
  library.close();

  expect(() => library.read(() => undefined)).toThrow(/closed/iu);
  expect(() => library.transaction(() => undefined)).toThrow(/closed/iu);
  expect(() => library.integrityCheck()).toThrow(/closed/iu);
  expect(() => library.foreignKeyCheck()).toThrow(/closed/iu);
  expect(() => library.checkpoint()).toThrow(/closed/iu);
  expect(() => library.schemaVersion()).toThrow(/closed/iu);
});
