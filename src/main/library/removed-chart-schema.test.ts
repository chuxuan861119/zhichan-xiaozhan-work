import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_SCHEMA_VERSION,
  V13_MIGRATION_STATEMENTS,
  V14_UPGRADE_FROM_V13_STATEMENTS,
  validateSchemaV14,
} from "./schema.js";

test("the active schema no longer requires chart tables", () => {
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(13);
});

test("upgrading a populated old library removes only chart tables and preserves patent data", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const sql of V13_MIGRATION_STATEMENTS) database.exec(sql);
  database
    .prepare("INSERT INTO patents VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', NULL)")
    .run("patent", "保留专利", null, "invention", 1, 0, "2026-09-13", "2026-09-13");
  database.exec("BEGIN");
  database
    .prepare("INSERT INTO patent_scientific_chart_projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "patent",
      "project",
      "revision",
      1,
      Buffer.from("invalid chart"),
      "A".repeat(64),
      "2026-09-13",
      "2026-09-13",
    );
  database
    .prepare("INSERT INTO patent_scientific_chart_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "patent",
      "project",
      "revision",
      1,
      1,
      Buffer.from("invalid chart"),
      "A".repeat(64),
      13,
      "2026-09-13",
    );
  database
    .prepare("INSERT INTO patent_scientific_chart_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "patent",
      "project",
      "source",
      "raw",
      "csv",
      1,
      Buffer.from("invalid chart"),
      "A".repeat(64),
      13,
      "2026-09-13",
    );
  database.exec("COMMIT");
  database.exec("BEGIN EXCLUSIVE");
  for (const sql of V14_UPGRADE_FROM_V13_STATEMENTS) database.exec(sql);
  database.exec("COMMIT");
  expect(validateSchemaV14(database)).toEqual({ ok: true });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("SELECT name FROM patents").get()).toEqual({ name: "保留专利" });
  expect(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'patent_scientific_chart_%'")
      .all(),
  ).toEqual([]);
});

test("the former schema remains recognizable as an old library, not the current schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const sql of V13_MIGRATION_STATEMENTS) database.exec(sql);
    expect(validateSchemaV14(database).ok).toBe(false);
  } finally {
    database.close();
  }
});
