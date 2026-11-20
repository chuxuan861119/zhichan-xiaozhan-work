import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { LibraryMigrationService } from "./library-migration-service.js";
import {
  CURRENT_SCHEMA_VERSION,
  V13_MIGRATION_STATEMENTS,
  V14_MIGRATION_STATEMENTS,
  V16_MIGRATION_STATEMENTS,
  validateCurrentSchema,
  validateSchemaV14,
} from "./schema.js";

test("fresh ledger is strict, indexed by client/command/request, and survives patent deletion", () => {
  using db = new DatabaseSync(":memory:");
  for (const sql of V16_MIGRATION_STATEMENTS) db.exec(sql);
  expect(validateCurrentSchema(db)).toEqual({ ok: true });
  expect(
    db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'automation_operations'").get(),
  ).toEqual({ strict: 1 });
  const insert = db.prepare(
    "INSERT INTO automation_operations VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
  );
  insert.run(
    "client",
    "apply",
    "request",
    "operation",
    "hash",
    "committed",
    '{"patentId":"deleted"}',
    "today",
  );
  expect(() =>
    insert.run("client", "apply", "request", "other", "hash", "failed", "{}", "today"),
  ).toThrow();
  expect(() =>
    insert.run("other", "apply", "request", "other", "hash", "unknown", "{}", "today"),
  ).toThrow();
  db.exec("DELETE FROM patents");
  expect(db.prepare("SELECT status FROM automation_operations").get()).toEqual({
    status: "committed",
  });
  db.exec("CREATE TABLE unexpected(value TEXT)");
  expect(validateCurrentSchema(db).ok).toBe(false);
});

test.each([13, 14])(
  "upgrades V%s to the current schema with backup and recognizable old schema",
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), "automation-schema-"));
    try {
      const raw = new DatabaseSync(join(root, "library.sqlite3"));
      for (const sql of version === 13 ? V13_MIGRATION_STATEMENTS : V14_MIGRATION_STATEMENTS)
        raw.exec(sql);
      if (version === 14) expect(validateSchemaV14(raw).ok).toBe(true);
      raw
        .prepare("INSERT INTO library_state VALUES (?, ?, ?)")
        .run("retained", Buffer.from('"data"'), "now");
      raw.close();
      const preparation = await new LibraryMigrationService(root).prepare();
      expect(preparation.status).toBe("ready");
      if (preparation.status !== "ready") throw new Error("migration failed");
      try {
        expect(preparation.backupCreated).toBe(true);
        expect(preparation.database.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
        expect(preparation.database.read(validateCurrentSchema).ok).toBe(true);
        expect(
          preparation.database.read((db) =>
            db.prepare("SELECT key FROM library_state WHERE key = 'retained'").get(),
          ),
        ).toEqual({ key: "retained" });
      } finally {
        preparation.database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
