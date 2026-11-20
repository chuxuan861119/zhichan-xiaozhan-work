import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SQLiteDatabase } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 16;

export const V2_SCHEMA_STATEMENTS = [
  `CREATE TABLE patents(
    patent_id TEXT PRIMARY KEY,
    name TEXT,
    patent_type TEXT NOT NULL CHECK(patent_type IN ('invention','utility-model')),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    recovery_state TEXT NOT NULL CHECK(recovery_state IN ('healthy','quarantined')),
    recovery_error_code TEXT
  ) STRICT`,
  `CREATE TABLE patent_books(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    book_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('claims','description','description-drawings','abstract','abstract-drawing')),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    document_json BLOB NOT NULL,
    editor_state_json BLOB NOT NULL,
    PRIMARY KEY(patent_id, kind)
  ) STRICT`,
  `CREATE TABLE documents(
    library_document_id TEXT PRIMARY KEY,
    canonical_document_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    title BLOB NOT NULL,
    snippet BLOB NOT NULL,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    quarantined_at TEXT
  ) STRICT`,
  `CREATE TABLE patent_figures(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    figure_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    width_mm REAL NOT NULL CHECK(width_mm BETWEEN 10 AND 165),
    explanation TEXT NOT NULL,
    PRIMARY KEY(patent_id, figure_id),
    UNIQUE(patent_id, position)
  ) STRICT`,
  `CREATE TABLE snapshots(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(patent_id, revision)
  ) STRICT`,
  `CREATE TABLE edit_log(
    operation_id TEXT PRIMARY KEY,
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL,
    target_revision INTEGER NOT NULL CHECK(target_revision = base_revision + 1),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(patent_id, target_revision)
  ) STRICT`,
  `CREATE TABLE document_snapshots(
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(library_document_id, revision)
  ) STRICT`,
  `CREATE TABLE document_edit_log(
    operation_id TEXT PRIMARY KEY,
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL,
    target_revision INTEGER NOT NULL CHECK(target_revision = base_revision + 1),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(library_document_id, target_revision)
  ) STRICT`,
  `CREATE TABLE assets(
    asset_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE patent_assets(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    PRIMARY KEY(patent_id, asset_id)
  ) STRICT`,
  `CREATE TABLE document_assets(
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    PRIMARY KEY(library_document_id, asset_id)
  ) STRICT`,
  `CREATE TABLE schema_migrations(
    version INTEGER PRIMARY KEY CHECK(version >= 1),
    applied_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE library_state(
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX patents_modified_at_idx ON patents(modified_at)",
  "CREATE INDEX patents_deleted_at_idx ON patents(deleted_at)",
  "CREATE INDEX documents_modified_at_idx ON documents(modified_at)",
  "CREATE INDEX documents_deleted_at_idx ON documents(deleted_at)",
  "CREATE INDEX edit_log_patent_revision_idx ON edit_log(patent_id, target_revision)",
  "CREATE INDEX document_edit_log_revision_idx ON document_edit_log(library_document_id, target_revision)",
  "CREATE INDEX patent_assets_asset_id_idx ON patent_assets(asset_id)",
  "CREATE INDEX document_assets_asset_id_idx ON document_assets(asset_id)",
] as const;

export const V2_MIGRATION_STATEMENTS = [
  ...V2_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V2_DOCUMENT_MIGRATION_STATEMENTS = V2_SCHEMA_STATEMENTS.filter(
  (statement) =>
    statement.startsWith("CREATE TABLE documents(") ||
    statement.startsWith("CREATE TABLE document_snapshots(") ||
    statement.startsWith("CREATE TABLE document_edit_log(") ||
    statement.startsWith("CREATE TABLE document_assets(") ||
    statement.startsWith("CREATE INDEX documents_") ||
    statement.startsWith("CREATE INDEX document_edit_log_") ||
    statement.startsWith("CREATE INDEX document_assets_"),
);

export const V2_PATENT_ONLY_SCHEMA_STATEMENTS = V2_SCHEMA_STATEMENTS.filter(
  (statement) => !V2_DOCUMENT_MIGRATION_STATEMENTS.includes(statement),
);

/** V3 patents 表在 V2 基础上新增 customer 列（所属客户，可空）。 */
const V3_PATENTS_TABLE_STATEMENT = `CREATE TABLE patents(
    patent_id TEXT PRIMARY KEY,
    name TEXT,
    customer TEXT,
    patent_type TEXT NOT NULL CHECK(patent_type IN ('invention','utility-model')),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    recovery_state TEXT NOT NULL CHECK(recovery_state IN ('healthy','quarantined')),
    recovery_error_code TEXT
  ) STRICT`;

export const V3_SCHEMA_STATEMENTS = [
  V3_PATENTS_TABLE_STATEMENT,
  ...V2_SCHEMA_STATEMENTS.slice(1),
] as const;

export const V3_MIGRATION_STATEMENTS = [
  ...V3_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

/** 从 V2 库升级：新增 customer 列并将 schema_migrations 更新为版本 3。 */
export const V3_UPGRADE_FROM_V2_STATEMENTS = [
  "ALTER TABLE patents ADD COLUMN customer TEXT",
  "UPDATE schema_migrations SET version = 3, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 2",
] as const;

export const V3_PATENT_ONLY_SCHEMA_STATEMENTS = V3_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

export const V3_DOCUMENT_MIGRATION_STATEMENTS = V2_DOCUMENT_MIGRATION_STATEMENTS;

/** V4 patents 表在 V3 基础上新增附图书启用状态。 */
const V4_PATENTS_TABLE_STATEMENT = `CREATE TABLE patents(
    patent_id TEXT PRIMARY KEY,
    name TEXT,
    customer TEXT,
    patent_type TEXT NOT NULL CHECK(patent_type IN ('invention','utility-model')),
    drawing_books_enabled INTEGER NOT NULL DEFAULT 1 CHECK(drawing_books_enabled IN (0,1)),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    recovery_state TEXT NOT NULL CHECK(recovery_state IN ('healthy','quarantined')),
    recovery_error_code TEXT
  ) STRICT`;

export const V4_SCHEMA_STATEMENTS = [
  V4_PATENTS_TABLE_STATEMENT,
  ...V2_SCHEMA_STATEMENTS.slice(1),
] as const;

export const V4_MIGRATION_STATEMENTS = [
  ...V4_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

/** 从 V3 库升级：旧专利默认保留已启用的两份附图书。 */
export const V4_UPGRADE_FROM_V3_STATEMENTS = [
  "ALTER TABLE patents ADD COLUMN drawing_books_enabled INTEGER NOT NULL DEFAULT 1 CHECK(drawing_books_enabled IN (0,1))",
  "UPDATE schema_migrations SET version = 4, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 3",
] as const;

export const V4_PATENT_ONLY_SCHEMA_STATEMENTS = V4_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

export const V4_DOCUMENT_MIGRATION_STATEMENTS = V2_DOCUMENT_MIGRATION_STATEMENTS;

/** V5 protects assets referenced by retained patent snapshots. */
export const V5_SNAPSHOT_ASSET_STATEMENTS = [
  `CREATE TABLE snapshot_assets(
    patent_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    PRIMARY KEY(patent_id, revision, asset_id),
    FOREIGN KEY(patent_id, revision) REFERENCES snapshots(patent_id, revision) ON DELETE CASCADE
  ) STRICT`,
  "CREATE INDEX snapshot_assets_asset_id_idx ON snapshot_assets(asset_id)",
] as const;

export const V5_SCHEMA_STATEMENTS = [
  ...V4_SCHEMA_STATEMENTS,
  ...V5_SNAPSHOT_ASSET_STATEMENTS,
] as const;

export const V5_MIGRATION_STATEMENTS = [
  ...V5_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V5_UPGRADE_FROM_V4_STATEMENTS = [
  ...V5_SNAPSHOT_ASSET_STATEMENTS,
  "UPDATE schema_migrations SET version = 5, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 4",
] as const;

export const V5_PATENT_ONLY_SCHEMA_STATEMENTS = V5_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

/** V6 stores scientific-chart source blobs and immutable project revisions separately. */
export const V6_SCIENTIFIC_CHART_STATEMENTS = [
  `CREATE TABLE patent_scientific_chart_projects(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    current_revision_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    descriptor BLOB NOT NULL,
    project_sha256 TEXT NOT NULL CHECK(length(project_sha256) = 64 AND project_sha256 NOT GLOB '*[^0-9A-F]*'),
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    PRIMARY KEY(patent_id, project_id),
    FOREIGN KEY(patent_id, project_id, current_revision_id)
      REFERENCES patent_scientific_chart_revisions(patent_id, project_id, revision_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE patent_scientific_chart_revisions(
    patent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    format_version INTEGER NOT NULL CHECK(format_version = 1),
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-F]*'),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(patent_id, project_id, revision_id),
    UNIQUE(patent_id, project_id, revision),
    FOREIGN KEY(patent_id, project_id) REFERENCES patent_scientific_chart_projects(patent_id, project_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE patent_scientific_chart_sources(
    patent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    raw_asset_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('csv','tsv','xlsx','clipboard','jcamp-dx')),
    format_version INTEGER NOT NULL CHECK(format_version = 1),
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-F]*'),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(patent_id, project_id, source_id),
    UNIQUE(patent_id, project_id, raw_asset_id),
    FOREIGN KEY(patent_id, project_id) REFERENCES patent_scientific_chart_projects(patent_id, project_id) ON DELETE CASCADE
  ) STRICT`,
  "CREATE INDEX patent_scientific_chart_revisions_current_idx ON patent_scientific_chart_revisions(patent_id, project_id, revision_id)",
  "CREATE INDEX patent_scientific_chart_sources_asset_idx ON patent_scientific_chart_sources(patent_id, project_id, raw_asset_id)",
] as const;

export const V6_SCHEMA_STATEMENTS = [
  ...V5_SCHEMA_STATEMENTS,
  ...V6_SCIENTIFIC_CHART_STATEMENTS,
] as const;
export const V6_MIGRATION_STATEMENTS = [
  ...V6_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;
export const V6_UPGRADE_FROM_V5_STATEMENTS = [
  ...V6_SCIENTIFIC_CHART_STATEMENTS,
  "UPDATE schema_migrations SET version = 6, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 5",
] as const;
export const V6_PATENT_ONLY_SCHEMA_STATEMENTS = V6_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

const V7_PATENT_FIGURES_STATEMENT = (
  V6_SCHEMA_STATEMENTS.find((statement) =>
    statement.startsWith("CREATE TABLE patent_figures("),
  ) as string
).replace(
  "    explanation TEXT NOT NULL,",
  "    explanation TEXT NOT NULL,\n    flowchart_link BLOB,",
);

export const V7_FLOWCHART_STATEMENTS = [
  `CREATE TABLE patent_flowchart_source_revisions(
    source_revision_id TEXT PRIMARY KEY,
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    project_revision INTEGER NOT NULL CHECK(project_revision >= 0),
    source BLOB NOT NULL,
    source_sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 33554432),
    created_at TEXT NOT NULL,
    UNIQUE(patent_id, project_id, project_revision)
  ) STRICT`,
  `CREATE TABLE patent_flowcharts(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    metadata BLOB NOT NULL,
    current_source_revision_id TEXT NOT NULL REFERENCES patent_flowchart_source_revisions(source_revision_id),
    source_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    PRIMARY KEY(patent_id, project_id)
  ) STRICT`,
  `CREATE TABLE snapshot_flowchart_revisions(
    patent_id TEXT NOT NULL,
    snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision >= 0),
    project_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL REFERENCES patent_flowchart_source_revisions(source_revision_id),
    PRIMARY KEY(patent_id, snapshot_revision, project_id),
    FOREIGN KEY(patent_id, snapshot_revision) REFERENCES snapshots(patent_id, revision) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE edit_log_flowchart_revisions(
    operation_id TEXT NOT NULL REFERENCES edit_log(operation_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL REFERENCES patent_flowchart_source_revisions(source_revision_id),
    PRIMARY KEY(operation_id, project_id)
  ) STRICT`,
] as const;

export const V7_SCHEMA_STATEMENTS = [
  ...V6_SCHEMA_STATEMENTS.map((statement) =>
    statement.startsWith("CREATE TABLE patent_figures(") ? V7_PATENT_FIGURES_STATEMENT : statement,
  ),
  ...V7_FLOWCHART_STATEMENTS,
] as const;
export const V7_MIGRATION_STATEMENTS = [
  ...V7_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;
export const V7_UPGRADE_FROM_V6_STATEMENTS = [
  "ALTER TABLE patent_figures ADD COLUMN flowchart_link BLOB",
  ...V7_FLOWCHART_STATEMENTS,
  "UPDATE schema_migrations SET version = 7, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 6",
] as const;
export const V7_PATENT_ONLY_SCHEMA_STATEMENTS = V7_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

const V8_SNAPSHOT_TABLE_STATEMENT = `CREATE TABLE snapshots(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('initial','automatic','manual-save','manual-create','patent-close','application-close','historical')),
    PRIMARY KEY(patent_id, revision)
  ) STRICT`;

const V8_SNAPSHOT_FLOWCHART_REVISIONS_STATEMENT = V7_FLOWCHART_STATEMENTS.find((statement) =>
  statement.startsWith("CREATE TABLE snapshot_flowchart_revisions("),
) as string;

export const V8_SCHEMA_STATEMENTS = V7_SCHEMA_STATEMENTS.map((statement) =>
  statement.startsWith("CREATE TABLE snapshots(") ? V8_SNAPSHOT_TABLE_STATEMENT : statement,
) as readonly string[];

export const V8_MIGRATION_STATEMENTS = [
  ...V8_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

/** V7 → V8：为专利快照增加不可变来源元数据，并保留所有外键引用。 */
export const V8_UPGRADE_FROM_V7_STATEMENTS = [
  "ALTER TABLE snapshots RENAME TO snapshots_v7",
  V8_SNAPSHOT_TABLE_STATEMENT,
  "INSERT INTO snapshots(patent_id, revision, model_version, payload, content_hash, created_at, source) SELECT patent_id, revision, model_version, payload, content_hash, created_at, 'historical' FROM snapshots_v7",
  "DROP INDEX snapshot_assets_asset_id_idx",
  "ALTER TABLE snapshot_assets RENAME TO snapshot_assets_v7",
  ...V5_SNAPSHOT_ASSET_STATEMENTS.filter((statement) =>
    statement.startsWith("CREATE TABLE snapshot_assets("),
  ),
  "INSERT INTO snapshot_assets(patent_id, revision, asset_id) SELECT patent_id, revision, asset_id FROM snapshot_assets_v7",
  "CREATE INDEX snapshot_assets_asset_id_idx ON snapshot_assets(asset_id)",
  "DROP TABLE snapshot_assets_v7",
  "ALTER TABLE snapshot_flowchart_revisions RENAME TO snapshot_flowchart_revisions_v7",
  V8_SNAPSHOT_FLOWCHART_REVISIONS_STATEMENT,
  "INSERT INTO snapshot_flowchart_revisions(patent_id, snapshot_revision, project_id, source_revision_id) SELECT patent_id, snapshot_revision, project_id, source_revision_id FROM snapshot_flowchart_revisions_v7",
  "DROP TABLE snapshot_flowchart_revisions_v7",
  "DROP TABLE snapshots_v7",
  "UPDATE schema_migrations SET version = 8, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 7",
] as const;

export const V8_PATENT_ONLY_SCHEMA_STATEMENTS = V8_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

/** V9 is an intentional clean break: local storage is ordinary SQLite and ordinary files. */
export const V9_SCHEMA_STATEMENTS = V8_SCHEMA_STATEMENTS;

export const V9_MIGRATION_STATEMENTS = [
  ...V9_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V9_PATENT_ONLY_SCHEMA_STATEMENTS = V9_SCHEMA_STATEMENTS.filter(
  (statement) => !(V2_DOCUMENT_MIGRATION_STATEMENTS as readonly string[]).includes(statement),
);

export const V10_PATENT_TEMPLATE_STATEMENTS = [
  `CREATE TABLE patent_template_slots(
    template_id TEXT PRIMARY KEY,
    patent_type TEXT NOT NULL CHECK(patent_type IN ('invention','utility-model')),
    slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 1 AND 3),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 30),
    claims_json BLOB,
    description_json BLOB,
    abstract_json BLOB,
    template_revision INTEGER NOT NULL DEFAULT 0 CHECK(template_revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(patent_type, slot_index),
    CHECK(
      (claims_json IS NULL AND description_json IS NULL AND abstract_json IS NULL)
      OR
      (claims_json IS NOT NULL AND description_json IS NOT NULL AND abstract_json IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE patent_template_preferences(
    patent_type TEXT PRIMARY KEY CHECK(patent_type IN ('invention','utility-model')),
    selection_kind TEXT NOT NULL CHECK(selection_kind IN ('blank','system','custom')),
    selected_template_id TEXT REFERENCES patent_template_slots(template_id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    CHECK(
      (selection_kind = 'custom' AND selected_template_id IS NOT NULL)
      OR
      (selection_kind IN ('blank','system') AND selected_template_id IS NULL)
    )
  ) STRICT`,
  `CREATE TABLE patent_template_auxiliary(
    patent_type TEXT PRIMARY KEY CHECK(patent_type IN ('invention','utility-model')),
    figure_explanation_json BLOB NOT NULL,
    drawing_legend_json BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE template_assets(
    template_id TEXT NOT NULL REFERENCES patent_template_slots(template_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose = 'chemical-preview'),
    PRIMARY KEY(template_id, asset_id)
  ) STRICT`,
  "CREATE INDEX template_assets_asset_id_idx ON template_assets(asset_id)",
] as const;

const TEMPLATE_CREATED_AT_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const INVENTION_FIGURE_EXPLANATION =
  '{"id":"10000000-0000-4000-8000-000000000001","type":"paragraph","attrs":{"alignment":"left","paragraphIndentMm":0,"lineSpacing":1.5,"defaultFontFamily":"SimSun","defaultFontSizePt":12},"content":[{"type":"text","text":"图{{figureNumber}}为本发明的______示意图。","marks":[]}]}';
const UTILITY_FIGURE_EXPLANATION =
  '{"id":"10000000-0000-4000-8000-000000000002","type":"paragraph","attrs":{"alignment":"left","paragraphIndentMm":0,"lineSpacing":1.5,"defaultFontFamily":"SimSun","defaultFontSizePt":12},"content":[{"type":"text","text":"图{{figureNumber}}为本实用新型的______示意图。","marks":[]}]}';
const INVENTION_DRAWING_LEGEND =
  '{"id":"10000000-0000-4000-8000-000000000003","type":"paragraph","attrs":{"alignment":"left","paragraphIndentMm":0,"lineSpacing":1.5,"defaultFontFamily":"SimSun","defaultFontSizePt":12},"content":[{"type":"text","text":"其中，______。","marks":[]}]}';
const UTILITY_DRAWING_LEGEND =
  '{"id":"10000000-0000-4000-8000-000000000004","type":"paragraph","attrs":{"alignment":"left","paragraphIndentMm":0,"lineSpacing":1.5,"defaultFontFamily":"SimSun","defaultFontSizePt":12},"content":[{"type":"text","text":"其中，______。","marks":[]}]}';

export const V10_PATENT_TEMPLATE_AUXILIARY_SEEDS = {
  invention: [INVENTION_FIGURE_EXPLANATION, INVENTION_DRAWING_LEGEND],
  "utility-model": [UTILITY_FIGURE_EXPLANATION, UTILITY_DRAWING_LEGEND],
} as const;

export const V10_PATENT_TEMPLATE_SEED_STATEMENTS = [
  `INSERT INTO patent_template_slots(template_id, patent_type, slot_index, name, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-000000000001','invention',1,'自定义模板 1',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL}),
    ('00000000-0000-4000-8000-000000000002','invention',2,'自定义模板 2',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL}),
    ('00000000-0000-4000-8000-000000000003','invention',3,'自定义模板 3',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL}),
    ('00000000-0000-4000-8000-000000000101','utility-model',1,'自定义模板 1',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL}),
    ('00000000-0000-4000-8000-000000000102','utility-model',2,'自定义模板 2',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL}),
    ('00000000-0000-4000-8000-000000000103','utility-model',3,'自定义模板 3',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL})`,
  `INSERT INTO patent_template_preferences(patent_type, selection_kind, selected_template_id, updated_at) VALUES
    ('invention','system',NULL,${TEMPLATE_CREATED_AT_SQL}),
    ('utility-model','system',NULL,${TEMPLATE_CREATED_AT_SQL})`,
  `INSERT INTO patent_template_auxiliary(patent_type, figure_explanation_json, drawing_legend_json, updated_at) VALUES
    ('invention',CAST('${INVENTION_FIGURE_EXPLANATION}' AS BLOB),CAST('${INVENTION_DRAWING_LEGEND}' AS BLOB),${TEMPLATE_CREATED_AT_SQL}),
    ('utility-model',CAST('${UTILITY_FIGURE_EXPLANATION}' AS BLOB),CAST('${UTILITY_DRAWING_LEGEND}' AS BLOB),${TEMPLATE_CREATED_AT_SQL})`,
] as const;

export const V10_SCHEMA_STATEMENTS = [
  ...V9_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_STATEMENTS,
] as const;

export const V10_MIGRATION_STATEMENTS = [
  ...V10_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V10_UPGRADE_FROM_V9_STATEMENTS = [
  ...V10_PATENT_TEMPLATE_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  "UPDATE schema_migrations SET version = 10, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 9",
] as const;

// Version 11 is reserved for the separate auxiliary-document development branch.
const V12_TEMPLATE_STATEMENTS = V10_PATENT_TEMPLATE_STATEMENTS.map((sql) =>
  sql.replace("slot_index BETWEEN 1 AND 3", "slot_index BETWEEN 1 AND 5"),
);
const V12_EXTRA_TEMPLATE_SEEDS = ["invention", "utility-model"].flatMap((type, typeIndex) =>
  [4, 5].map(
    (
      index,
    ) => `INSERT INTO patent_template_slots(template_id, patent_type, slot_index, name, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-${String(typeIndex * 100 + index).padStart(12, "0")}','${type}',${index},'自定义模板 ${index}',${TEMPLATE_CREATED_AT_SQL},${TEMPLATE_CREATED_AT_SQL})`,
  ),
);
export const V12_SCHEMA_STATEMENTS = [...V9_SCHEMA_STATEMENTS, ...V12_TEMPLATE_STATEMENTS];
export const V12_MIGRATION_STATEMENTS = [
  ...V12_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
];
export const V12_UPGRADE_FROM_V10_STATEMENTS = [
  "CREATE TEMP TABLE saved_template_slots AS SELECT * FROM patent_template_slots",
  "CREATE TEMP TABLE saved_template_preferences AS SELECT * FROM patent_template_preferences",
  "CREATE TEMP TABLE saved_template_assets AS SELECT * FROM template_assets",
  "DROP TABLE template_assets",
  "DROP TABLE patent_template_preferences",
  "DROP TABLE patent_template_slots",
  ...V12_TEMPLATE_STATEMENTS.filter(
    (sql) => !sql.startsWith("CREATE TABLE patent_template_auxiliary"),
  ),
  "INSERT INTO patent_template_slots SELECT * FROM saved_template_slots",
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO patent_template_preferences SELECT * FROM saved_template_preferences",
  "INSERT INTO template_assets SELECT * FROM saved_template_assets",
  "DROP TABLE saved_template_slots",
  "DROP TABLE saved_template_preferences",
  "DROP TABLE saved_template_assets",
  "UPDATE schema_migrations SET version = 12, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 10",
];
export const V11_AUXILIARY_DOCUMENT_STATEMENTS = [
  `CREATE TABLE patent_auxiliary_documents(
    patent_id TEXT NOT NULL REFERENCES patents(patent_id) ON DELETE CASCADE,
    auxiliary_document_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    document_json BLOB NOT NULL,
    editor_state_json BLOB NOT NULL,
    source_file_name TEXT CHECK(
      source_file_name IS NULL OR (
        length(trim(source_file_name)) BETWEEN 1 AND 260
        AND instr(source_file_name, '/') = 0
        AND instr(source_file_name, char(92)) = 0
      )
    ),
    PRIMARY KEY(patent_id, auxiliary_document_id),
    UNIQUE(patent_id, position)
  ) STRICT`,
  `CREATE TABLE patent_import_reports(
    patent_id TEXT PRIMARY KEY REFERENCES patents(patent_id) ON DELETE CASCADE,
    report_json BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
] as const;

export const V11_SCHEMA_STATEMENTS = [
  ...V10_SCHEMA_STATEMENTS,
  ...V11_AUXILIARY_DOCUMENT_STATEMENTS,
] as const;

export const V11_MIGRATION_STATEMENTS = [
  ...V11_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V11_UPGRADE_FROM_V10_STATEMENTS = [
  ...V11_AUXILIARY_DOCUMENT_STATEMENTS,
  "UPDATE schema_migrations SET version = 11, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 10",
] as const;

export const V13_SCHEMA_STATEMENTS = [
  ...V12_SCHEMA_STATEMENTS,
  ...V11_AUXILIARY_DOCUMENT_STATEMENTS,
] as const;

export const V13_MIGRATION_STATEMENTS = [
  ...V13_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

export const V13_UPGRADE_FROM_V12_STATEMENTS = [
  ...V11_AUXILIARY_DOCUMENT_STATEMENTS,
  "UPDATE schema_migrations SET version = 13, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 12",
] as const;

export const V13_UPGRADE_FROM_V11_STATEMENTS = [
  ...V12_UPGRADE_FROM_V10_STATEMENTS.map((sql) =>
    sql.replace("WHERE version = 10", "WHERE version = 11"),
  ),
  "UPDATE schema_migrations SET version = 13, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 12",
] as const;

export const V14_SCHEMA_STATEMENTS = V13_SCHEMA_STATEMENTS.filter(
  (sql) => !/patent_scientific_chart_/.test(sql),
);
export const V14_MIGRATION_STATEMENTS = [
  ...V14_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (14, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
];
export const V14_UPGRADE_FROM_V13_STATEMENTS = [
  "DELETE FROM patent_scientific_chart_projects",
  "DROP TABLE patent_scientific_chart_sources",
  "DROP TABLE patent_scientific_chart_projects",
  "DROP TABLE patent_scientific_chart_revisions",
  "UPDATE schema_migrations SET version = 14, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 13",
];

export const V15_AUTOMATION_STATEMENTS = [
  `CREATE TABLE automation_operations(
    client_id TEXT NOT NULL,
    command TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('accepted','running','committed','failed','cancelled','recovery_required')),
    target_json TEXT NOT NULL,
    result_json TEXT,
    evidence_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(client_id, command, request_id)
  ) STRICT`,
] as const;
export const V15_SCHEMA_STATEMENTS = [...V14_SCHEMA_STATEMENTS, ...V15_AUTOMATION_STATEMENTS];
export const V15_MIGRATION_STATEMENTS = [
  ...V15_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
];
export const V15_UPGRADE_FROM_V14_STATEMENTS = [
  ...V15_AUTOMATION_STATEMENTS,
  "UPDATE schema_migrations SET version = 15, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 14",
];

const V16_PATENTS_TABLE = V4_PATENTS_TABLE_STATEMENT.replace(
  "('invention','utility-model')",
  "('invention','utility-model','design')",
);
const V16_PATENT_INDEXES = V15_SCHEMA_STATEMENTS.filter((sql) =>
  /^CREATE INDEX patents_/.test(sql),
);
export const V16_SCHEMA_STATEMENTS = V15_SCHEMA_STATEMENTS.map((sql) =>
  /^CREATE TABLE patents\(/.test(sql) ? V16_PATENTS_TABLE : sql,
);
export const V16_MIGRATION_STATEMENTS = [
  ...V16_SCHEMA_STATEMENTS,
  ...V10_PATENT_TEMPLATE_SEED_STATEMENTS,
  ...V12_EXTRA_TEMPLATE_SEEDS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (16, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
];
/** Run with foreign keys disabled on the exclusive migration connection, then verify them before committing. */
export const V16_UPGRADE_FROM_V15_STATEMENTS = [
  "PRAGMA legacy_alter_table = ON",
  "ALTER TABLE patents RENAME TO patents_v15",
  V16_PATENTS_TABLE,
  `INSERT INTO patents(patent_id, name, customer, patent_type, drawing_books_enabled, revision,
      created_at, modified_at, deleted_at, recovery_state, recovery_error_code)
    SELECT patent_id, name, customer, patent_type, drawing_books_enabled, revision,
      created_at, modified_at, deleted_at, recovery_state, recovery_error_code FROM patents_v15`,
  "DROP TABLE patents_v15",
  ...V16_PATENT_INDEXES,
  "PRAGMA legacy_alter_table = OFF",
  "UPDATE schema_migrations SET version = 16, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = 15",
];

export const V1_SCHEMA_STATEMENTS = [
  `CREATE TABLE documents(
    library_document_id TEXT PRIMARY KEY,
    canonical_document_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    title BLOB NOT NULL,
    snippet BLOB NOT NULL,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    quarantined_at TEXT
  ) STRICT`,
  `CREATE TABLE snapshots(
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(library_document_id, revision)
  ) STRICT`,
  `CREATE TABLE edit_log(
    operation_id TEXT PRIMARY KEY,
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL,
    target_revision INTEGER NOT NULL CHECK(target_revision = base_revision + 1),
    model_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(library_document_id, target_revision)
  ) STRICT`,
  `CREATE TABLE assets(
    asset_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE document_assets(
    library_document_id TEXT NOT NULL REFERENCES documents(library_document_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    PRIMARY KEY(library_document_id, asset_id)
  ) STRICT`,
  `CREATE TABLE schema_migrations(
    version INTEGER PRIMARY KEY CHECK(version >= 1),
    applied_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE library_state(
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX documents_modified_at_idx ON documents(modified_at)",
  "CREATE INDEX documents_deleted_at_idx ON documents(deleted_at)",
  "CREATE INDEX edit_log_document_revision_idx ON edit_log(library_document_id, target_revision)",
  "CREATE INDEX document_assets_asset_id_idx ON document_assets(asset_id)",
] as const;

export const V1_MIGRATION_STATEMENTS = [
  ...V1_SCHEMA_STATEMENTS,
  "INSERT INTO schema_migrations(version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
] as const;

type Column = { name: string; type: "BLOB" | "INTEGER" | "TEXT"; notnull: 0 | 1; pk: number };

type ForeignKey = { from: string; table: string; to: string; onDelete: "CASCADE" };

type TableFingerprint = {
  columns: readonly Column[];
  foreignKeys: readonly ForeignKey[];
  uniqueConstraints: readonly (readonly string[])[];
};

const EXPECTED_V1_FINGERPRINT: {
  tables: Record<string, TableFingerprint>;
  indexes: Record<string, { table: string; columns: readonly string[] }>;
} = {
  tables: {
    documents: {
      columns: [
        { name: "library_document_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "canonical_document_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "title", type: "BLOB", notnull: 1, pk: 0 },
        { name: "snippet", type: "BLOB", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "modified_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "deleted_at", type: "TEXT", notnull: 0, pk: 0 },
        { name: "quarantined_at", type: "TEXT", notnull: 0, pk: 0 },
      ],
      foreignKeys: [],
      uniqueConstraints: [],
    },
    snapshots: {
      columns: [
        { name: "library_document_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "revision", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "model_version", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "payload", type: "BLOB", notnull: 1, pk: 0 },
        { name: "content_hash", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
      foreignKeys: [
        {
          from: "library_document_id",
          table: "documents",
          to: "library_document_id",
          onDelete: "CASCADE",
        },
      ],
      uniqueConstraints: [],
    },
    edit_log: {
      columns: [
        { name: "operation_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "library_document_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "base_revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "target_revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "model_version", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "payload", type: "BLOB", notnull: 1, pk: 0 },
        { name: "content_hash", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
      foreignKeys: [
        {
          from: "library_document_id",
          table: "documents",
          to: "library_document_id",
          onDelete: "CASCADE",
        },
      ],
      uniqueConstraints: [["library_document_id", "target_revision"]],
    },
    assets: {
      columns: [
        { name: "asset_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "content_hash", type: "TEXT", notnull: 1, pk: 0 },
        { name: "relative_path", type: "TEXT", notnull: 1, pk: 0 },
        { name: "mime_type", type: "TEXT", notnull: 1, pk: 0 },
        { name: "byte_length", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "width", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "height", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
      foreignKeys: [],
      uniqueConstraints: [["relative_path"]],
    },
    document_assets: {
      columns: [
        { name: "library_document_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "asset_id", type: "TEXT", notnull: 1, pk: 2 },
      ],
      foreignKeys: [
        {
          from: "library_document_id",
          table: "documents",
          to: "library_document_id",
          onDelete: "CASCADE",
        },
        { from: "asset_id", table: "assets", to: "asset_id", onDelete: "CASCADE" },
      ],
      uniqueConstraints: [],
    },
    schema_migrations: {
      columns: [
        { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
      foreignKeys: [],
      uniqueConstraints: [],
    },
    library_state: {
      columns: [
        { name: "key", type: "TEXT", notnull: 1, pk: 1 },
        { name: "value", type: "BLOB", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
      foreignKeys: [],
      uniqueConstraints: [],
    },
  },
  indexes: {
    documents_modified_at_idx: { table: "documents", columns: ["modified_at"] },
    documents_deleted_at_idx: { table: "documents", columns: ["deleted_at"] },
    edit_log_document_revision_idx: {
      table: "edit_log",
      columns: ["library_document_id", "target_revision"],
    },
    document_assets_asset_id_idx: { table: "document_assets", columns: ["asset_id"] },
  },
};

type SchemaObjectType = "index" | "table" | "trigger" | "view";
type SqlFingerprint = ReadonlyMap<string, string>;

let expectedSqlFingerprint: SqlFingerprint | undefined;
let expectedV2SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV2SqlFingerprint: SqlFingerprint | undefined;

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function indexColumns(database: DatabaseSync, indexName: string): string[] {
  return database
    .prepare(`PRAGMA index_info(${quotedIdentifier(indexName)})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function uniqueConstraints(database: DatabaseSync, table: string): string[][] {
  return database
    .prepare(`PRAGMA index_list(${quotedIdentifier(table)})`)
    .all()
    .flatMap((row) => {
      const index = row as { name: string; origin: string; partial: number; unique: number };
      if (index.unique !== 1 || index.partial !== 0 || index.origin !== "u") return [];
      return [indexColumns(database, index.name)];
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function isSqlWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Z0-9_$]/iu.test(character);
}

function needsSqlTokenSeparator(previous: string | undefined, next: string): boolean {
  if (isSqlWordCharacter(previous) && isSqlWordCharacter(next)) return true;
  const operatorCharacters = "<>!=|&+-*/%";
  return (
    previous !== undefined &&
    operatorCharacters.includes(previous) &&
    operatorCharacters.includes(next)
  );
}

function normalizedSqliteMasterSql(sql: string): string {
  let source = sql.trim();
  if (source.endsWith(";")) source = source.slice(0, -1).trimEnd();

  let normalized = "";
  let pendingWhitespace = false;
  let quote: "'" | '"' | "`" | "]" | null = null;
  let comment: "block" | "line" | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    const next = source[index + 1];

    if (comment === "block") {
      normalized += character;
      if (character === "*" && next === "/") {
        normalized += next;
        index += 1;
        comment = null;
      }
      continue;
    }
    if (comment === "line") {
      normalized += character;
      if (character === "\n" || character === "\r") comment = null;
      continue;
    }
    if (quote !== null) {
      normalized += character;
      const quoteEnd = quote === "]" ? "]" : quote;
      if (character === quoteEnd) {
        if (quote !== "]" && next === quoteEnd) {
          normalized += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (/\s/u.test(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (pendingWhitespace && needsSqlTokenSeparator(normalized.at(-1), character)) {
      normalized += " ";
    }
    pendingWhitespace = false;

    if (character === "/" && next === "*") {
      normalized += "/*";
      index += 1;
      comment = "block";
      continue;
    }
    if (character === "-" && next === "-") {
      normalized += "--";
      index += 1;
      comment = "line";
      continue;
    }
    normalized += character;
    if (character === "'" || character === '"' || character === "`") quote = character;
    if (character === "[") quote = "]";
  }
  return normalized;
}

function schemaObjectKey(type: SchemaObjectType, name: string): string {
  return `${type}:${name}`;
}

function collectSqlFingerprint(database: DatabaseSync): Map<string, string> | null {
  const fingerprint = new Map<string, string>();
  for (const [type, names] of [
    ["table", Object.keys(EXPECTED_V1_FINGERPRINT.tables)],
    ["index", Object.keys(EXPECTED_V1_FINGERPRINT.indexes)],
  ] as const) {
    for (const name of names) {
      const row = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(type, name) as { sql?: unknown } | undefined;
      if (row === undefined || typeof row.sql !== "string") return null;
      fingerprint.set(schemaObjectKey(type, name), normalizedSqliteMasterSql(row.sql));
    }
  }
  return fingerprint;
}

function getExpectedSqlFingerprint(): SqlFingerprint {
  if (expectedSqlFingerprint !== undefined) return expectedSqlFingerprint;
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of V1_SCHEMA_STATEMENTS) reference.exec(statement);
    const fingerprint = collectSqlFingerprint(reference);
    if (fingerprint === null) throw new Error("Could not build V1 schema fingerprint");
    expectedSqlFingerprint = fingerprint;
    return fingerprint;
  } finally {
    reference.close();
  }
}

function hasExpectedSqlFingerprint(database: DatabaseSync): boolean {
  const actual = collectSqlFingerprint(database);
  if (actual === null) return false;
  const expected = getExpectedSqlFingerprint();
  if (actual.size !== expected.size) return false;
  for (const [key, expectedSql] of expected) {
    if (actual.get(key) !== expectedSql) return false;
  }
  return true;
}

function collectAllSchemaSqlFingerprint(database: DatabaseSync): SqlFingerprint {
  const fingerprint = new Map<string, string>();
  const rows = database
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: SchemaObjectType; name: string; sql: string | null }>;
  for (const row of rows) {
    if (row.sql === null) continue;
    fingerprint.set(schemaObjectKey(row.type, row.name), normalizedSqliteMasterSql(row.sql));
  }
  return fingerprint;
}

function expectedSchemaSqlFingerprint(statements: readonly string[]): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of statements) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function hasSchemaSqlFingerprint(database: DatabaseSync, expected: SqlFingerprint): boolean {
  for (const [key, expectedSql] of expected) {
    const separator = key.indexOf(":");
    const type = key.slice(0, separator) as SchemaObjectType;
    const name = key.slice(separator + 1);
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string" || normalizedSqliteMasterSql(row.sql) !== expectedSql) {
      return false;
    }
  }
  return true;
}

function hasExactSchemaSqlFingerprint(database: DatabaseSync, expected: SqlFingerprint): boolean {
  const actual = collectAllSchemaSqlFingerprint(database);
  if (actual.size !== expected.size) return false;
  for (const [key, expectedSql] of expected) {
    if (actual.get(key) !== expectedSql) return false;
  }
  return true;
}

function hasExpectedV2SqlFingerprint(database: DatabaseSync): boolean {
  expectedV2SqlFingerprint ??= expectedSchemaSqlFingerprint(V2_SCHEMA_STATEMENTS);
  return hasSchemaSqlFingerprint(database, expectedV2SqlFingerprint);
}

function hasExpectedPatentOnlyV2SqlFingerprint(database: DatabaseSync): boolean {
  expectedPatentOnlyV2SqlFingerprint ??= expectedSchemaSqlFingerprint(
    V2_PATENT_ONLY_SCHEMA_STATEMENTS,
  );
  return hasSchemaSqlFingerprint(database, expectedPatentOnlyV2SqlFingerprint);
}

/** V2 完整库（含文档表）结构指纹是否匹配（不检查版本号，供升级识别）。 */
export function matchesV2FullSchema(database: DatabaseSync): boolean {
  return hasExpectedV2SqlFingerprint(database);
}

/** V2 专利专用库（无文档表）结构指纹是否匹配（不检查版本号，供升级识别）。 */
export function matchesV2PatentOnlySchema(database: DatabaseSync): boolean {
  if (!hasExpectedPatentOnlyV2SqlFingerprint(database)) return false;
  const tables = database
    .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
    .all() as Array<{ name: string; strict: number }>;
  if (
    tables.some((candidate) =>
      ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
        candidate.name,
      ),
    )
  ) {
    return false;
  }
  return true;
}

let expectedV3SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV3SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedV3SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedPatentOnlyV3SqlFingerprint: SqlFingerprint | undefined;

function expectedAdditivelyUpgradedV3SqlFingerprint(
  v2Statements: readonly string[],
): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of v2Statements) reference.exec(statement);
    for (const statement of V3_UPGRADE_FROM_V2_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function hasExpectedV3SqlFingerprint(database: DatabaseSync): boolean {
  expectedV3SqlFingerprint ??= expectedSchemaSqlFingerprint(V3_SCHEMA_STATEMENTS);
  if (hasSchemaSqlFingerprint(database, expectedV3SqlFingerprint)) return true;
  expectedUpgradedV3SqlFingerprint ??= expectedAdditivelyUpgradedV3SqlFingerprint([
    ...V2_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
  ]);
  return hasSchemaSqlFingerprint(database, expectedUpgradedV3SqlFingerprint);
}

function hasExpectedPatentOnlyV3SqlFingerprint(database: DatabaseSync): boolean {
  expectedPatentOnlyV3SqlFingerprint ??= expectedSchemaSqlFingerprint(
    V3_PATENT_ONLY_SCHEMA_STATEMENTS,
  );
  if (hasSchemaSqlFingerprint(database, expectedPatentOnlyV3SqlFingerprint)) return true;
  expectedUpgradedPatentOnlyV3SqlFingerprint ??= expectedAdditivelyUpgradedV3SqlFingerprint([
    ...V2_PATENT_ONLY_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
  ]);
  return hasSchemaSqlFingerprint(database, expectedUpgradedPatentOnlyV3SqlFingerprint);
}

export function validateSchemaV3(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedV3SqlFingerprint(database)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    if (version?.version !== 3) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV3(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV3(database);
}

export function validatePatentOnlySchemaV3(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedPatentOnlyV3SqlFingerprint(database)) return { ok: false };
    const tables = database
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string; strict: number }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 3 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV4SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV4SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedV4SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedPatentOnlyV4SqlFingerprint: SqlFingerprint | undefined;
let expectedV2ToV4SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV2ToV4SqlFingerprint: SqlFingerprint | undefined;

function expectedAdditivelyUpgradedV4SqlFingerprint(
  v3Statements: readonly string[],
): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of v3Statements) reference.exec(statement);
    for (const statement of V4_UPGRADE_FROM_V3_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function hasExpectedV4SqlFingerprint(database: DatabaseSync): boolean {
  expectedV4SqlFingerprint ??= expectedSchemaSqlFingerprint(V4_SCHEMA_STATEMENTS);
  if (hasSchemaSqlFingerprint(database, expectedV4SqlFingerprint)) return true;
  expectedUpgradedV4SqlFingerprint ??= expectedAdditivelyUpgradedV4SqlFingerprint([
    ...V3_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
  ]);
  if (hasSchemaSqlFingerprint(database, expectedUpgradedV4SqlFingerprint)) return true;
  expectedV2ToV4SqlFingerprint ??= expectedAdditivelyUpgradedV4SqlFingerprint([
    ...V2_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
    ...V3_UPGRADE_FROM_V2_STATEMENTS,
  ]);
  return hasSchemaSqlFingerprint(database, expectedV2ToV4SqlFingerprint);
}

function hasExpectedPatentOnlyV4SqlFingerprint(database: DatabaseSync): boolean {
  expectedPatentOnlyV4SqlFingerprint ??= expectedSchemaSqlFingerprint(
    V4_PATENT_ONLY_SCHEMA_STATEMENTS,
  );
  if (hasSchemaSqlFingerprint(database, expectedPatentOnlyV4SqlFingerprint)) return true;
  expectedUpgradedPatentOnlyV4SqlFingerprint ??= expectedAdditivelyUpgradedV4SqlFingerprint([
    ...V3_PATENT_ONLY_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
  ]);
  if (hasSchemaSqlFingerprint(database, expectedUpgradedPatentOnlyV4SqlFingerprint)) return true;
  expectedPatentOnlyV2ToV4SqlFingerprint ??= expectedAdditivelyUpgradedV4SqlFingerprint([
    ...V2_PATENT_ONLY_SCHEMA_STATEMENTS,
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
    ...V3_UPGRADE_FROM_V2_STATEMENTS,
  ]);
  return hasSchemaSqlFingerprint(database, expectedPatentOnlyV2ToV4SqlFingerprint);
}

export function validateSchemaV4(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedV4SqlFingerprint(database)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 4 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV4(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV4(database);
}

export function validatePatentOnlySchemaV4(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedPatentOnlyV4SqlFingerprint(database)) return { ok: false };
    const tables = database
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string; strict: number }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 4 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV5SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV5SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedV5SqlFingerprint: SqlFingerprint | undefined;
let expectedV2ToV5SqlFingerprint: SqlFingerprint | undefined;
let expectedUpgradedPatentOnlyV5SqlFingerprint: SqlFingerprint | undefined;
let expectedPatentOnlyV2ToV5SqlFingerprint: SqlFingerprint | undefined;

function expectedAdditivelyUpgradedV5SqlFingerprint(statements: readonly string[]): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of statements) reference.exec(statement);
    for (const statement of V5_UPGRADE_FROM_V4_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

export function validateSchemaV5(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV5SqlFingerprint ??= expectedSchemaSqlFingerprint(V5_SCHEMA_STATEMENTS);
    const matchesFresh = hasSchemaSqlFingerprint(database, expectedV5SqlFingerprint);
    expectedUpgradedV5SqlFingerprint ??= expectedAdditivelyUpgradedV5SqlFingerprint([
      ...V3_SCHEMA_STATEMENTS,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
    ]);
    const matchesV3 = hasSchemaSqlFingerprint(database, expectedUpgradedV5SqlFingerprint);
    expectedV2ToV5SqlFingerprint ??= expectedAdditivelyUpgradedV5SqlFingerprint([
      ...V2_SCHEMA_STATEMENTS,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
      ...V3_UPGRADE_FROM_V2_STATEMENTS,
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
    ]);
    const matchesV2 = hasSchemaSqlFingerprint(database, expectedV2ToV5SqlFingerprint);
    if (!matchesFresh && !matchesV3 && !matchesV2) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 5 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV5(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV5(database);
}

export function validatePatentOnlySchemaV5(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedPatentOnlyV5SqlFingerprint ??= expectedSchemaSqlFingerprint(
      V5_PATENT_ONLY_SCHEMA_STATEMENTS,
    );
    const matchesFresh = hasSchemaSqlFingerprint(database, expectedPatentOnlyV5SqlFingerprint);
    expectedUpgradedPatentOnlyV5SqlFingerprint ??= expectedAdditivelyUpgradedV5SqlFingerprint([
      ...V3_PATENT_ONLY_SCHEMA_STATEMENTS,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
    ]);
    const matchesV3 = hasSchemaSqlFingerprint(database, expectedUpgradedPatentOnlyV5SqlFingerprint);
    expectedPatentOnlyV2ToV5SqlFingerprint ??= expectedAdditivelyUpgradedV5SqlFingerprint([
      ...V2_PATENT_ONLY_SCHEMA_STATEMENTS,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
      ...V3_UPGRADE_FROM_V2_STATEMENTS,
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
    ]);
    const matchesV2 = hasSchemaSqlFingerprint(database, expectedPatentOnlyV2ToV5SqlFingerprint);
    if (!matchesFresh && !matchesV3 && !matchesV2) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 5 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV6SqlFingerprints: readonly SqlFingerprint[] | undefined;
let expectedPatentOnlyV6SqlFingerprints: readonly SqlFingerprint[] | undefined;

function expectedV6UpgradeFingerprint(base: readonly string[]): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of base) reference.exec(statement);
    for (const statement of V6_UPGRADE_FROM_V5_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function v6Fingerprints(patentOnly: boolean): readonly SqlFingerprint[] {
  const v2 = patentOnly ? V2_PATENT_ONLY_SCHEMA_STATEMENTS : V2_SCHEMA_STATEMENTS;
  const v3 = patentOnly ? V3_PATENT_ONLY_SCHEMA_STATEMENTS : V3_SCHEMA_STATEMENTS;
  const fresh = patentOnly ? V6_PATENT_ONLY_SCHEMA_STATEMENTS : V6_SCHEMA_STATEMENTS;
  return [
    expectedSchemaSqlFingerprint(fresh),
    expectedV6UpgradeFingerprint([
      ...v3,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
    ]),
    expectedV6UpgradeFingerprint([
      ...v2,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
      ...V3_UPGRADE_FROM_V2_STATEMENTS,
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
    ]),
  ];
}

export function validateSchemaV6(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV6SqlFingerprints ??= v6Fingerprints(false);
    if (!expectedV6SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 6 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV6(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV6(database);
}

export function validatePatentOnlySchemaV6(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedPatentOnlyV6SqlFingerprints ??= v6Fingerprints(true);
    if (
      !expectedPatentOnlyV6SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))
    ) {
      return { ok: false };
    }
    const tables = database
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 6 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV7SqlFingerprints: readonly SqlFingerprint[] | undefined;
let expectedPatentOnlyV7SqlFingerprints: readonly SqlFingerprint[] | undefined;

function expectedV7UpgradeFingerprint(base: readonly string[]): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of base) reference.exec(statement);
    for (const statement of V7_UPGRADE_FROM_V6_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function v7Fingerprints(patentOnly: boolean): readonly SqlFingerprint[] {
  const v2 = patentOnly ? V2_PATENT_ONLY_SCHEMA_STATEMENTS : V2_SCHEMA_STATEMENTS;
  const v3 = patentOnly ? V3_PATENT_ONLY_SCHEMA_STATEMENTS : V3_SCHEMA_STATEMENTS;
  const fresh = patentOnly ? V7_PATENT_ONLY_SCHEMA_STATEMENTS : V7_SCHEMA_STATEMENTS;
  const v6 = patentOnly ? V6_PATENT_ONLY_SCHEMA_STATEMENTS : V6_SCHEMA_STATEMENTS;
  return [
    expectedSchemaSqlFingerprint(fresh),
    expectedV7UpgradeFingerprint([
      ...v6,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (6, 'reference')",
    ]),
    expectedV7UpgradeFingerprint([
      ...v3,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'reference')",
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
      ...V6_UPGRADE_FROM_V5_STATEMENTS,
    ]),
    expectedV7UpgradeFingerprint([
      ...v2,
      "INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'reference')",
      ...V3_UPGRADE_FROM_V2_STATEMENTS,
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
      ...V6_UPGRADE_FROM_V5_STATEMENTS,
    ]),
  ];
}

export function validateSchemaV7(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV7SqlFingerprints ??= v7Fingerprints(false);
    if (!expectedV7SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 7 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV7(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV7(database);
}

export function validatePatentOnlySchemaV7(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedPatentOnlyV7SqlFingerprints ??= v7Fingerprints(true);
    if (
      !expectedPatentOnlyV7SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))
    ) {
      return { ok: false };
    }
    const tables = database
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 7 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV8SqlFingerprints: readonly SqlFingerprint[] | undefined;
let expectedPatentOnlyV8SqlFingerprints: readonly SqlFingerprint[] | undefined;

function expectedV8UpgradeFingerprint(
  base: readonly string[],
  previousUpgrades: readonly string[] = [],
): SqlFingerprint {
  const reference = new SQLiteDatabase(":memory:");
  try {
    for (const statement of base) reference.exec(statement);
    for (const statement of previousUpgrades) reference.exec(statement);
    for (const statement of V8_UPGRADE_FROM_V7_STATEMENTS) reference.exec(statement);
    return collectAllSchemaSqlFingerprint(reference);
  } finally {
    reference.close();
  }
}

function v8Fingerprints(patentOnly: boolean): readonly SqlFingerprint[] {
  const v2 = patentOnly ? V2_PATENT_ONLY_SCHEMA_STATEMENTS : V2_SCHEMA_STATEMENTS;
  const v3 = patentOnly ? V3_PATENT_ONLY_SCHEMA_STATEMENTS : V3_SCHEMA_STATEMENTS;
  const fresh = patentOnly ? V8_PATENT_ONLY_SCHEMA_STATEMENTS : V8_SCHEMA_STATEMENTS;
  const v6 = patentOnly ? V6_PATENT_ONLY_SCHEMA_STATEMENTS : V6_SCHEMA_STATEMENTS;
  const v7 = patentOnly ? V7_PATENT_ONLY_SCHEMA_STATEMENTS : V7_SCHEMA_STATEMENTS;
  return [
    expectedSchemaSqlFingerprint(fresh),
    expectedV8UpgradeFingerprint(v7),
    expectedV8UpgradeFingerprint(v6, V7_UPGRADE_FROM_V6_STATEMENTS),
    expectedV8UpgradeFingerprint(v3, [
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
      ...V6_UPGRADE_FROM_V5_STATEMENTS,
      ...V7_UPGRADE_FROM_V6_STATEMENTS,
    ]),
    expectedV8UpgradeFingerprint(v2, [
      ...V3_UPGRADE_FROM_V2_STATEMENTS,
      ...V4_UPGRADE_FROM_V3_STATEMENTS,
      ...V5_UPGRADE_FROM_V4_STATEMENTS,
      ...V6_UPGRADE_FROM_V5_STATEMENTS,
      ...V7_UPGRADE_FROM_V6_STATEMENTS,
    ]),
  ];
}

export function validateSchemaV8(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV8SqlFingerprints ??= v8Fingerprints(false);
    if (!expectedV8SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 8 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV8(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV8(database);
}

export function validatePatentOnlySchemaV8(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedPatentOnlyV8SqlFingerprints ??= v8Fingerprints(true);
    if (
      !expectedPatentOnlyV8SqlFingerprints.some((item) => hasSchemaSqlFingerprint(database, item))
    ) {
      return { ok: false };
    }
    const tables = database
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 8 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV9SqlFingerprint: SqlFingerprint | undefined;

export function validateSchemaV9(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV9SqlFingerprint ??= expectedSchemaSqlFingerprint(V9_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV9SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 9 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV9(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV9(database);
}

let expectedV10SqlFingerprint: SqlFingerprint | undefined;

export function validateSchemaV10(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV10SqlFingerprint ??= expectedSchemaSqlFingerprint(V10_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV10SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    if (version?.version !== 10) return { ok: false };
    const slotCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_slots")
      .get() as { count?: unknown };
    const preferenceCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get() as { count?: unknown };
    const auxiliaryCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary")
      .get() as { count?: unknown };
    return slotCount.count === 6 && preferenceCount.count === 2 && auxiliaryCount.count === 2
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV10(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV10(database);
}

let expectedV12SqlFingerprint: SqlFingerprint | undefined;
export function validateSchemaV12(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV12SqlFingerprint ??= expectedSchemaSqlFingerprint(V12_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV12SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get();
    const slots = database.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get();
    const prefs = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get();
    const aux = database.prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary").get();
    return version?.version === 12 && slots?.count === 10 && prefs?.count === 2 && aux?.count === 2
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

let expectedV11SqlFingerprint: SqlFingerprint | undefined;

export function validateSchemaV11(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV11SqlFingerprint ??= expectedSchemaSqlFingerprint(V11_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV11SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    if (version?.version !== 11) return { ok: false };
    const slotCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_slots")
      .get() as { count?: unknown };
    const preferenceCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get() as { count?: unknown };
    const auxiliaryCount = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary")
      .get() as { count?: unknown };
    return slotCount.count === 6 && preferenceCount.count === 2 && auxiliaryCount.count === 2
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV11(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV11(database);
}

let expectedV13SqlFingerprint: SqlFingerprint | undefined;
export function validateSchemaV13(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV13SqlFingerprint ??= expectedSchemaSqlFingerprint(V13_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV13SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get();
    const slots = database.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get();
    const prefs = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get();
    const aux = database.prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary").get();
    return version?.version === 13 && slots?.count === 10 && prefs?.count === 2 && aux?.count === 2
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
let expectedV14SqlFingerprint: SqlFingerprint | undefined;
export function validateSchemaV14(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    expectedV14SqlFingerprint ??= expectedSchemaSqlFingerprint(V14_SCHEMA_STATEMENTS);
    if (!hasExactSchemaSqlFingerprint(database, expectedV14SqlFingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get();
    const slots = database.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get();
    const prefs = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get();
    const aux = database.prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary").get();
    return {
      ok: version?.version === 14 && slots?.count === 10 && prefs?.count === 2 && aux?.count === 2,
    };
  } catch {
    return { ok: false };
  }
}

let expectedV15SqlFingerprint: SqlFingerprint | undefined;
let expectedV16SqlFingerprint: SqlFingerprint | undefined;
export function validateSchemaV15(database: DatabaseSync): { ok: true } | { ok: false } {
  expectedV15SqlFingerprint ??= expectedSchemaSqlFingerprint(V15_SCHEMA_STATEMENTS);
  return validateFinalLibrarySchema(database, expectedV15SqlFingerprint, 15);
}
export function validateCurrentSchema(database: DatabaseSync): { ok: true } | { ok: false } {
  expectedV16SqlFingerprint ??= expectedSchemaSqlFingerprint(V16_SCHEMA_STATEMENTS);
  return validateFinalLibrarySchema(database, expectedV16SqlFingerprint, CURRENT_SCHEMA_VERSION);
}
function validateFinalLibrarySchema(
  database: DatabaseSync,
  fingerprint: SqlFingerprint,
  expectedVersion: number,
): { ok: true } | { ok: false } {
  try {
    if (!hasExactSchemaSqlFingerprint(database, fingerprint)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get();
    const slots = database.prepare("SELECT COUNT(*) AS count FROM patent_template_slots").get();
    const prefs = database
      .prepare("SELECT COUNT(*) AS count FROM patent_template_preferences")
      .get();
    const aux = database.prepare("SELECT COUNT(*) AS count FROM patent_template_auxiliary").get();
    return {
      ok:
        version?.version === expectedVersion &&
        slots?.count === 10 &&
        prefs?.count === 2 &&
        aux?.count === 2,
    };
  } catch {
    return { ok: false };
  }
}

function isCheckConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    error.errcode === 275 &&
    /^CHECK constraint failed(?::|$)/iu.test(error.message)
  );
}

function rejectsWithCheckConstraint(operation: () => void): boolean {
  try {
    operation();
    return false;
  } catch (error) {
    return isCheckConstraintFailure(error);
  }
}

function validateCheckConstraintsBehaviorally(database: DatabaseSync): boolean {
  const token = randomUUID();
  const savepoint = quotedIdentifier(`validate_schema_v1_${token}`);
  const documentId = `schema-probe-document-${token}`;
  let valid = false;
  let savepointOpen = false;
  try {
    database.exec(`SAVEPOINT ${savepoint}`);
    savepointOpen = true;

    const documentInsert = database.prepare(
      "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
    );
    const documentsRejectInvalidRevision = rejectsWithCheckConstraint(() => {
      documentInsert.run(
        `schema-probe-invalid-document-${token}`,
        `schema-probe-canonical-${token}`,
        -1,
        Buffer.alloc(1),
        Buffer.alloc(1),
        "probe-created",
        "probe-modified",
      );
    });
    documentInsert.run(
      documentId,
      `schema-probe-canonical-${token}`,
      0,
      Buffer.alloc(1),
      Buffer.alloc(1),
      "probe-created",
      "probe-modified",
    );

    const snapshotInsert = database.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?)");
    const snapshotsRejectInvalidRevision = rejectsWithCheckConstraint(() => {
      snapshotInsert.run(
        documentId,
        -1,
        1,
        Buffer.alloc(1),
        `schema-probe-invalid-snapshot-hash-${token}`,
        "probe-created",
      );
    });
    snapshotInsert.run(
      documentId,
      0,
      1,
      Buffer.alloc(1),
      `schema-probe-valid-snapshot-hash-${token}`,
      "probe-created",
    );

    const editLogInsert = database.prepare("INSERT INTO edit_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const editLogRejectsUnchangedRevision = rejectsWithCheckConstraint(() => {
      editLogInsert.run(
        `schema-probe-operation-unchanged-${token}`,
        documentId,
        0,
        0,
        1,
        Buffer.alloc(1),
        `schema-probe-edit-unchanged-hash-${token}`,
        "probe-created",
      );
    });
    const editLogRejectsSkippedRevision = rejectsWithCheckConstraint(() => {
      editLogInsert.run(
        `schema-probe-operation-skipped-${token}`,
        documentId,
        0,
        2,
        1,
        Buffer.alloc(1),
        `schema-probe-edit-skipped-hash-${token}`,
        "probe-created",
      );
    });
    editLogInsert.run(
      `schema-probe-operation-valid-${token}`,
      documentId,
      0,
      1,
      1,
      Buffer.alloc(1),
      `schema-probe-edit-valid-hash-${token}`,
      "probe-created",
    );

    const assetInsert = database.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const assetsRejectInvalidByteLength = rejectsWithCheckConstraint(() => {
      assetInsert.run(
        `schema-probe-byte-length-${token}`,
        `schema-probe-byte-hash-${token}`,
        `schema-probe-byte-${token}.bin`,
        "image/png",
        -1,
        1,
        1,
        "probe-created",
      );
    });
    const assetsRejectInvalidWidth = rejectsWithCheckConstraint(() => {
      assetInsert.run(
        `schema-probe-width-${token}`,
        `schema-probe-width-hash-${token}`,
        `schema-probe-width-${token}.bin`,
        "image/png",
        1,
        0,
        1,
        "probe-created",
      );
    });
    const assetsRejectNegativeWidth = rejectsWithCheckConstraint(() => {
      assetInsert.run(
        `schema-probe-negative-width-${token}`,
        `schema-probe-negative-width-hash-${token}`,
        `schema-probe-negative-width-${token}.bin`,
        "image/png",
        1,
        -1,
        1,
        "probe-created",
      );
    });
    const assetsRejectInvalidHeight = rejectsWithCheckConstraint(() => {
      assetInsert.run(
        `schema-probe-height-${token}`,
        `schema-probe-height-hash-${token}`,
        `schema-probe-height-${token}.bin`,
        "image/png",
        1,
        1,
        0,
        "probe-created",
      );
    });
    const assetsRejectNegativeHeight = rejectsWithCheckConstraint(() => {
      assetInsert.run(
        `schema-probe-negative-height-${token}`,
        `schema-probe-negative-height-hash-${token}`,
        `schema-probe-negative-height-${token}.bin`,
        "image/png",
        1,
        1,
        -1,
        "probe-created",
      );
    });
    assetInsert.run(
      `schema-probe-valid-asset-${token}`,
      `schema-probe-valid-asset-hash-${token}`,
      `schema-probe-valid-asset-${token}.bin`,
      "image/png",
      0,
      1,
      1,
      "probe-created",
    );

    const schemaMigrationInsert = database.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    const schemaMigrationsRejectZeroVersion = rejectsWithCheckConstraint(() => {
      schemaMigrationInsert.run(0, "probe-created-zero");
    });
    const schemaMigrationsRejectNegativeVersion = rejectsWithCheckConstraint(() => {
      schemaMigrationInsert.run(-1, "probe-created-negative");
    });
    schemaMigrationInsert.run(2, "probe-created-valid");

    valid =
      documentsRejectInvalidRevision &&
      snapshotsRejectInvalidRevision &&
      editLogRejectsUnchangedRevision &&
      editLogRejectsSkippedRevision &&
      assetsRejectInvalidByteLength &&
      assetsRejectInvalidWidth &&
      assetsRejectNegativeWidth &&
      assetsRejectInvalidHeight &&
      assetsRejectNegativeHeight &&
      schemaMigrationsRejectZeroVersion &&
      schemaMigrationsRejectNegativeVersion;
  } catch {
    valid = false;
  } finally {
    if (savepointOpen) {
      try {
        database.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        valid = false;
      }
      try {
        database.exec(`RELEASE ${savepoint}`);
      } catch {
        valid = false;
      }
    }
  }
  return valid;
}

function validateCheckConstraintsInIsolation(tableStatements: readonly string[]): boolean {
  const probeDatabase = new SQLiteDatabase(":memory:");
  try {
    probeDatabase.exec("PRAGMA foreign_keys=ON");
    for (const statement of tableStatements) probeDatabase.exec(statement);
    return validateCheckConstraintsBehaviorally(probeDatabase);
  } catch {
    return false;
  } finally {
    probeDatabase.close();
  }
}

export function validateSchemaV1(
  database: DatabaseSync,
  options: { isolateCheckConstraintProbes?: boolean } = {},
): { ok: true } | { ok: false } {
  try {
    const tableStatements: string[] = [];
    const tables = database
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string; strict: number }>;
    for (const [table, expected] of Object.entries(EXPECTED_V1_FINGERPRINT.tables)) {
      if (!tables.some((candidate) => candidate.name === table && candidate.strict === 1)) {
        return { ok: false };
      }
      const actualColumns = database
        .prepare(`PRAGMA table_info(${quotedIdentifier(table)})`)
        .all()
        .map((row) => {
          const column = row as Column;
          return {
            name: column.name,
            type: column.type,
            notnull: column.notnull,
            pk: column.pk,
          };
        });
      if (JSON.stringify(actualColumns) !== JSON.stringify(expected.columns)) return { ok: false };

      const sql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string } | undefined;
      if (sql === undefined) return { ok: false };
      tableStatements.push(sql.sql);

      const actualForeignKeys = (
        database.prepare(`PRAGMA foreign_key_list(${quotedIdentifier(table)})`).all() as Array<{
          from: string;
          table: string;
          to: string;
          on_delete: string;
        }>
      )
        .map((key) => ({
          from: key.from,
          table: key.table,
          to: key.to,
          onDelete: key.on_delete,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const expectedForeignKeys = [...expected.foreignKeys].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
      if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys)) {
        return { ok: false };
      }

      const expectedUniqueConstraints = expected.uniqueConstraints
        .map((columns) => [...columns])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      if (
        JSON.stringify(uniqueConstraints(database, table)) !==
        JSON.stringify(expectedUniqueConstraints)
      ) {
        return { ok: false };
      }
    }

    for (const [indexName, expected] of Object.entries(EXPECTED_V1_FINGERPRINT.indexes)) {
      const index = database
        .prepare(`PRAGMA index_list(${quotedIdentifier(expected.table)})`)
        .all()
        .find((row) => (row as { name: string }).name === indexName) as
        | { origin: string; partial: number; unique: number }
        | undefined;
      if (
        index === undefined ||
        index.unique !== 0 ||
        index.partial !== 0 ||
        index.origin !== "c"
      ) {
        return { ok: false };
      }
      if (JSON.stringify(indexColumns(database, indexName)) !== JSON.stringify(expected.columns)) {
        return { ok: false };
      }
    }
    if (!hasExpectedSqlFingerprint(database)) return { ok: false };
    const checksAreValid = options.isolateCheckConstraintProbes
      ? validateCheckConstraintsInIsolation(tableStatements)
      : validateCheckConstraintsBehaviorally(database);
    if (!checksAreValid) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV1(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    const rows = database.prepare("SELECT version FROM schema_migrations").all();
    if (rows.length !== 1) return { ok: false };
    const version = (rows[0] as { version?: unknown }).version;
    return Number.isSafeInteger(version) && version === 1 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaV2(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedV2SqlFingerprint(database)) return { ok: false };
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    if (version?.version !== 2) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function validatePatentOnlySchemaV2(database: DatabaseSync): { ok: true } | { ok: false } {
  try {
    if (!hasExpectedPatentOnlyV2SqlFingerprint(database)) return { ok: false };
    const tables = database
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as Array<{ name: string; strict: number }>;
    if (
      tables.some((candidate) =>
        ["documents", "document_snapshots", "document_edit_log", "document_assets"].includes(
          candidate.name,
        ),
      )
    ) {
      return { ok: false };
    }
    const version = database.prepare("SELECT version FROM schema_migrations").get() as
      | { version?: unknown }
      | undefined;
    return version?.version === 2 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function validateSchemaVersionV2(database: DatabaseSync): { ok: true } | { ok: false } {
  return validateSchemaV2(database);
}
