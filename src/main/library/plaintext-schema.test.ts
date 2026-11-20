import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  V8_MIGRATION_STATEMENTS,
  V9_MIGRATION_STATEMENTS,
  V10_MIGRATION_STATEMENTS,
  V11_MIGRATION_STATEMENTS,
  validateSchemaV9,
  validateSchemaV10,
  validateSchemaV11,
} from "./schema.js";

describe("plaintext library schema", () => {
  test("creates a clean V11 schema with auxiliary documents and import reports", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V11_MIGRATION_STATEMENTS) database.exec(statement);

    expect(CURRENT_SCHEMA_VERSION).toBe(16);
    expect(validateSchemaV11(database)).toEqual({ ok: true });
    const tables = database
      .prepare(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('patent_auxiliary_documents','patent_import_reports') ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: "patent_auxiliary_documents", strict: 1 },
      { name: "patent_import_reports", strict: 1 },
    ]);
  });

  test("rejects unsafe source paths in auxiliary document rows", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V11_MIGRATION_STATEMENTS) database.exec(statement);
    database
      .prepare("INSERT INTO patents VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', NULL)")
      .run(
        "00000000-0000-4000-8000-000000000801",
        "测试",
        null,
        "invention",
        1,
        0,
        "2026-08-31T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z",
      );

    expect(() =>
      database
        .prepare(
          `INSERT INTO patent_auxiliary_documents(
             patent_id, auxiliary_document_id, position, title, revision,
             document_json, editor_state_json, source_file_name
           ) VALUES (?, ?, 0, ?, 0, ?, ?, ?)`,
        )
        .run(
          "00000000-0000-4000-8000-000000000801",
          "00000000-0000-4000-8000-000000000802",
          "其他材料",
          Buffer.from("{}"),
          Buffer.from("{}"),
          "C:\\private\\source.docx",
        ),
    ).toThrow();
  });

  test("keeps the V10 schema validator for safe upgrades", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V10_MIGRATION_STATEMENTS) database.exec(statement);

    expect(CURRENT_SCHEMA_VERSION).toBe(16);
    expect(validateSchemaV10(database)).toEqual({ ok: true });
    const sql = database
      .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
      .all()
      .map((row) => String((row as { sql: unknown }).sql))
      .join("\n");
    expect(sql).not.toMatch(/encrypted_/u);
    expect(sql).toContain("payload BLOB NOT NULL");
    expect(sql).toContain("relative_path TEXT NOT NULL UNIQUE");
    expect(sql).toContain("flowchart_link BLOB");
    expect(sql).toContain("CREATE TABLE patent_template_slots");
    expect(sql).toContain("CREATE TABLE patent_template_preferences");
    expect(sql).toContain("CREATE TABLE patent_template_auxiliary");
    expect(sql).toContain("CREATE TABLE template_assets");
    expect(database.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get()).toEqual({
      count: 6,
    });
  });

  test("enforces complete three-book slots and selection shape", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V10_MIGRATION_STATEMENTS) database.exec(statement);
    const slot = database
      .prepare(
        "SELECT template_id FROM patent_template_slots WHERE patent_type = 'invention' AND slot_index = 1",
      )
      .get() as { template_id: string };

    expect(() =>
      database
        .prepare(
          "UPDATE patent_template_slots SET claims_json = ?, description_json = NULL, abstract_json = ? WHERE template_id = ?",
        )
        .run(Buffer.from("{}"), Buffer.from("{}"), slot.template_id),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          "UPDATE patent_template_preferences SET selection_kind = 'custom', selected_template_id = NULL WHERE patent_type = 'invention'",
        )
        .run(),
    ).toThrow();
  });

  test("does not recognize the encrypted V8 schema as V9", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V8_MIGRATION_STATEMENTS) database.exec(statement);
    expect(validateSchemaV9(database)).toEqual({ ok: false });
  });

  test("rejects a V9 database with an unexpected trigger", () => {
    using database = new DatabaseSync(":memory:");
    for (const statement of V9_MIGRATION_STATEMENTS) database.exec(statement);
    database.exec(
      `CREATE TRIGGER unexpected_patent_write
       BEFORE INSERT ON patents
       BEGIN
         SELECT 1;
       END`,
    );

    expect(validateSchemaV9(database)).toEqual({ ok: false });
  });
});
