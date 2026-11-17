import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ParagraphNodeSchema } from "../../shared/document/model.js";
import { AgreementRecordSchema } from "../../shared/legal/model.js";
import { createLegacyFactoryPatentTemplatesV1 } from "../../shared/patent/templates.js";
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { TransferHandoffReceiptSchema } from "../automation/transfer-handoff.js";
import type { LibraryDatabase } from "../library/library-database.js";
import {
  LEGACY_MIGRATION_KEY,
  UNDERLINED_SPACE_MIGRATION_KEY,
} from "../library/patent-template-service.js";
import { decodeJson } from "../library/plaintext-codec.js";
import {
  CURRENT_SCHEMA_VERSION,
  V10_PATENT_TEMPLATE_AUXILIARY_SEEDS,
  validateCurrentSchema,
} from "../library/schema.js";
import { isOwnedExportArtifact } from "./export-task-recovery.js";
import {
  IMPORT_STAGING_OWNERSHIP_FILE,
  ImportStagingOwnershipSchema,
} from "./import-staging-ownership.js";

export type EmptyLibraryBlockerKind =
  | "patents"
  | "documents"
  | "legacy-drafts"
  | "snapshots"
  | "edit-logs"
  | "assets"
  | "projects"
  | "library-state"
  | "pending-operation"
  | "unknown-files"
  | "unreadable-library";

export type EmptyLibraryBlocker = Readonly<{
  kind: EmptyLibraryBlockerKind;
  count: number;
}>;

export type EmptyLibraryInspection = Readonly<{
  empty: boolean;
  blockers: readonly EmptyLibraryBlocker[];
}>;

export type OwnedImportStagingCapability = Readonly<{
  root: string;
  identity: Readonly<{
    device: string;
    inode: string;
    birthtimeNs: string;
  }>;
}>;

export type EmptyLibraryInspectOptions = Readonly<{
  ownedImportStaging?: OwnedImportStagingCapability | undefined;
}>;

type InspectorFileSystem = {
  lstat(path: string): Promise<Stats>;
  lstatIdentity(path: string): Promise<OwnedImportStagingCapability["identity"]>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<Dirent[]>;
  realpath(path: string): Promise<string>;
};

type ReparsePointProbe = {
  assertSafe(path: string): Promise<void>;
  close(): Promise<void>;
};

export type EmptyLibraryInspectorOptions = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
  applicationDataRoot: string;
  database: LibraryDatabase;
  fileSystem?: Partial<InspectorFileSystem> | undefined;
  createReparsePointProbe?: (() => ReparsePointProbe) | undefined;
}>;

type BlockerCounts = Map<EmptyLibraryBlockerKind, number>;

type FileSystemSnapshot = Readonly<{
  assets: number;
  legacyDrafts: number;
  polishHistory: number;
  pendingOperations: number;
  signature: string;
}>;

type DatabaseSnapshot = Readonly<{
  blockers: ReadonlyMap<EmptyLibraryBlockerKind, number>;
  signature: string;
}>;

type NormalizedOwnedImportStaging = Readonly<{
  root: string;
  device: string;
  inode: string;
  birthtimeNs: string;
}>;

const DATABASE_FILE_NAME = "library.sqlite3";
const ASSETS_DIRECTORY_NAME = "assets";
const LEGACY_DRAFTS_DIRECTORY_NAME = "drafts";
const LEGACY_DRAFT_MIGRATION_STATE_NAME = "legacy-draft-migration.json";
const PENDING_DATA_IMPORT_STATE_NAME = "pending-data-import.json";
const MAX_RUN_STATE_BYTES = 32 * 1024;
const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const REPARSE_PROBE_TIMEOUT_MS = 2_000;
const IMPORT_STAGING_PREFIX = ".import-staging-";
const IMPORT_STAGING_NAME_PATTERN =
  /^\.import-staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const PersistedRunStateSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    appVersion: z.string().trim().min(1).max(100),
    startedAt: z.string().datetime(),
    cleanShutdown: z.boolean(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();

const ALLOWED_LIBRARY_FILES = new Set([
  DATABASE_FILE_NAME,
  `${DATABASE_FILE_NAME}-wal`,
  `${DATABASE_FILE_NAME}-shm`,
  "last-run-state.json",
]);

const APPLICATION_USER_DATA_DIRECTORIES = new Set(["drafts", "logs"]);
const REBUILDABLE_CACHE_DIRECTORIES = new Set(["content-search-cache"]);
const APPLICATION_USER_DATA_FILES = new Set([
  "agreement-consent.json",
  "ai-credentials.json",
  LEGACY_DRAFT_MIGRATION_STATE_NAME,
  "settings.json",
  "settings.json.last-good",
  "library-location.json",
  "usage-statistics.json",
]);
const ELECTRON_USER_DATA_DIRECTORIES = new Set([
  "blob_storage",
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Dictionaries",
  "GPUCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "IndexedDB",
  "Local Storage",
  "Network",
  "Partitions",
  "Service Worker",
  "Session Storage",
  "ShaderCache",
  "Shared Dictionary",
  "shared_proto_db",
  "Storage",
  "VideoDecodeStats",
  "WebStorage",
]);
const ELECTRON_USER_DATA_FILES = new Set([
  "DevToolsActivePort",
  "Cookies",
  "Cookies-journal",
  "DIPS",
  "DIPS-journal",
  "DIPS-shm",
  "DIPS-wal",
  "History",
  "History-journal",
  "Local State",
  "lockfile",
  "Network Persistent State",
  "Preferences",
  "QuotaManager",
  "QuotaManager-journal",
  "Reporting and NEL",
  "Reporting and NEL-journal",
  "SharedStorage",
  "SharedStorage-wal",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "Visited Links",
  "Web Data",
  "Web Data-journal",
]);

export const EMPTY_LIBRARY_V10_TABLE_POLICIES = Object.freeze({
  assets: "assets",
  automation_operations: null,
  document_assets: "assets",
  document_edit_log: "edit-logs",
  document_snapshots: "snapshots",
  documents: "documents",
  edit_log: "edit-logs",
  edit_log_flowchart_revisions: "edit-logs",
  library_state: "library-state",
  patent_assets: "assets",
  patent_auxiliary_documents: "patents",
  patent_books: "patents",
  patent_figures: "assets",
  patent_import_reports: "patents",
  patent_flowchart_source_revisions: "projects",
  patent_flowcharts: "projects",

  patent_template_auxiliary: null,
  patent_template_preferences: null,
  patent_template_slots: null,
  patents: "patents",
  schema_migrations: null,
  snapshot_assets: "snapshots",
  snapshot_flowchart_revisions: "snapshots",
  snapshots: "snapshots",
  template_assets: "assets",
} as const satisfies Record<string, EmptyLibraryBlockerKind | null>);

const EXPECTED_INDEXES = new Set([
  "document_assets_asset_id_idx",
  "document_edit_log_revision_idx",
  "documents_deleted_at_idx",
  "documents_modified_at_idx",
  "edit_log_patent_revision_idx",
  "patent_assets_asset_id_idx",

  "patents_deleted_at_idx",
  "patents_modified_at_idx",
  "snapshot_assets_asset_id_idx",
  "template_assets_asset_id_idx",
]);

const REVISION_COLUMNS = [
  ["documents", "revision"],
  ["document_edit_log", "target_revision"],
  ["document_snapshots", "revision"],
  ["edit_log", "target_revision"],
  ["patent_books", "revision"],
  ["patent_auxiliary_documents", "revision"],
  ["patent_flowchart_source_revisions", "project_revision"],
  ["patent_flowcharts", "revision"],

  ["patents", "revision"],
  ["snapshot_flowchart_revisions", "snapshot_revision"],
  ["snapshots", "revision"],
] as const;

const BLOCKER_ORDER: readonly EmptyLibraryBlockerKind[] = [
  "patents",
  "documents",
  "legacy-drafts",
  "snapshots",
  "edit-logs",
  "assets",
  "projects",
  "library-state",
  "pending-operation",
  "unknown-files",
  "unreadable-library",
];

const defaultFileSystem: InspectorFileSystem = {
  lstat,
  lstatIdentity: async (path) => {
    const info = await lstat(path, { bigint: true });
    return Object.freeze({
      device: info.dev.toString(),
      inode: info.ino.toString(),
      birthtimeNs: info.birthtimeNs.toString(),
    });
  },
  readFile,
  readdir: async (path) => await readdir(path, { withFileTypes: true }),
  realpath,
};

const noReparsePointProbe: ReparsePointProbe = {
  assertSafe: async () => {},
  close: async () => {},
};

class WindowsReparsePointProbe implements ReparsePointProbe {
  readonly #child;
  readonly #lines;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  constructor() {
    const script = [
      "$ErrorActionPreference='Stop'",
      "while (($line = [Console]::ReadLine()) -ne $null) {",
      "try {",
      "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))",
      "$attributes=[int][IO.File]::GetAttributes($path)",
      "[Console]::WriteLine($attributes)",
      "} catch { [Console]::WriteLine('ERR') }",
      "}",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    this.#child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
  }

  async assertSafe(path: string): Promise<void> {
    if (this.#closed) throw new Error("Reparse probe is closed");
    const operation = this.#pending.then(async () => {
      const line = Buffer.from(path, "utf8").toString("base64");
      if (!this.#child.stdin.write(`${line}\n`, "utf8")) {
        await new Promise<void>((resolvePromise, reject) => {
          this.#child.stdin.once("drain", resolvePromise);
          this.#child.stdin.once("error", reject);
        });
      }
      const response = await Promise.race([
        this.#lines.next(),
        new Promise<never>((_resolvePromise, reject) => {
          setTimeout(() => reject(new Error("Reparse probe timed out")), REPARSE_PROBE_TIMEOUT_MS);
        }),
      ]);
      if (response.done || response.value === "ERR") throw new Error("Reparse probe failed");
      const attributes = Number(response.value);
      if (!Number.isSafeInteger(attributes)) throw new Error("Invalid reparse attributes");
      if ((attributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0) {
        throw new Error("Reparse points are not inspectable");
      }
    });
    this.#pending = operation.catch(() => {});
    await operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    this.#child.stdin.end();
    this.#child.kill();
  }
}

function createDefaultReparsePointProbe(): ReparsePointProbe {
  return process.platform === "win32" ? new WindowsReparsePointProbe() : noReparsePointProbe;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeFileSystemPath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileSystemPath(left: string, right: string): boolean {
  return normalizeFileSystemPath(left) === normalizeFileSystemPath(right);
}

function isLexicallyResolvedAbsolutePath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const withoutNamespace = path.replace(/^\\\\\?\\/u, "");
  const resolved = resolve(withoutNamespace);
  return process.platform === "win32"
    ? withoutNamespace.toLowerCase() === resolved.toLowerCase()
    : withoutNamespace === resolved;
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Unsafe inspection count");
  }
  return value as number;
}

function addCount(counts: BlockerCounts, kind: EmptyLibraryBlockerKind, amount: number): void {
  const next = (counts.get(kind) ?? 0) + safeCount(amount);
  if (!Number.isSafeInteger(next)) throw new Error("Inspection count overflow");
  if (next > 0) counts.set(kind, next);
}

function freezeResult(
  counts: ReadonlyMap<EmptyLibraryBlockerKind, number>,
): EmptyLibraryInspection {
  const blockers = BLOCKER_ORDER.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count === 0 ? [] : [Object.freeze({ kind, count })];
  });
  return Object.freeze({
    empty: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function unreadableResult(): EmptyLibraryInspection {
  return freezeResult(new Map([["unreadable-library", 1]]));
}

function statsKind(info: Stats): "directory" | "file" {
  if (info.isSymbolicLink()) throw new Error("Reparse points are not inspectable");
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  throw new Error("Unsupported filesystem object");
}

function statsSignature(relativePath: string, info: Stats, kind: "directory" | "file"): string {
  return [
    relativePath,
    kind,
    String(info.dev),
    String(info.ino),
    String(info.mode),
    String(info.size),
    String(info.mtimeMs),
    String(info.ctimeMs),
  ].join("\u0000");
}

function stableArtifactIdentitySignature(
  relativePath: string,
  info: Stats,
  kind: "directory" | "file",
): string {
  return [relativePath, kind, String(info.dev), String(info.ino), String(info.mode)].join("\u0000");
}

function isPendingLibraryState(key: string): boolean {
  return (
    key === "snapshot-asset-index-incomplete" ||
    key.startsWith("recovery:") ||
    key.startsWith("import:") ||
    key.startsWith("migration:") ||
    key.startsWith("pending:")
  );
}

export class EmptyLibraryInspector {
  readonly #libraryRoot: string;
  readonly #userDataRoot: string;
  readonly #applicationDataRoot: string;
  readonly #database: LibraryDatabase;
  readonly #fileSystem: InspectorFileSystem;
  readonly #createReparsePointProbe: () => ReparsePointProbe;

  constructor(options: EmptyLibraryInspectorOptions) {
    this.#libraryRoot = resolve(options.libraryRoot);
    this.#userDataRoot = resolve(options.userDataRoot);
    this.#applicationDataRoot = resolve(options.applicationDataRoot);
    this.#database = options.database;
    this.#fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.#createReparsePointProbe =
      options.createReparsePointProbe ?? createDefaultReparsePointProbe;
  }

  /** Recovery checks database content separately from its journal/staging filesystem. */
  inspectDatabaseContent(): EmptyLibraryInspection {
    try {
      this.#validateDatabaseHealth(this.#database);
      const first = this.#snapshotDatabase(this.#database);
      const second = this.#snapshotDatabase(this.#database);
      if (first.signature !== second.signature) return unreadableResult();
      return freezeResult(first.blockers);
    } catch {
      return unreadableResult();
    }
  }

  async inspect(options: EmptyLibraryInspectOptions = {}): Promise<EmptyLibraryInspection> {
    let result = unreadableResult();
    let probe: ReparsePointProbe | undefined;
    try {
      const database = this.#database;
      if (database === undefined) throw new Error("Library database is unavailable");
      const ownedImportStaging = this.#normalizeOwnedImportStaging(options.ownedImportStaging);
      probe = this.#createReparsePointProbe();
      const firstFiles = await this.#snapshotFileSystem(probe, ownedImportStaging);
      this.#validateDatabaseHealth(database);
      const firstDatabase = this.#snapshotDatabase(database);
      const secondFiles = await this.#snapshotFileSystem(probe, ownedImportStaging);
      const secondDatabase = this.#snapshotDatabase(database);
      if (
        firstFiles.signature !== secondFiles.signature ||
        firstDatabase.signature !== secondDatabase.signature
      ) {
        throw new Error("Library changed during inspection");
      }

      const counts: BlockerCounts = new Map(firstDatabase.blockers);
      addCount(counts, "assets", firstFiles.assets);
      addCount(counts, "legacy-drafts", firstFiles.legacyDrafts);
      addCount(counts, "library-state", firstFiles.polishHistory);
      addCount(counts, "pending-operation", firstFiles.pendingOperations);
      result = freezeResult(counts);
    } catch {
      result = unreadableResult();
    } finally {
      try {
        await probe?.close();
      } catch {
        result = unreadableResult();
      }
    }
    return result;
  }

  #normalizeOwnedImportStaging(
    capability: OwnedImportStagingCapability | undefined,
  ): NormalizedOwnedImportStaging | undefined {
    if (capability === undefined) return undefined;
    if (!isLexicallyResolvedAbsolutePath(capability.root)) {
      throw new Error("Owned staging path is not normalized");
    }
    const root = resolve(capability.root);
    if (
      !sameFileSystemPath(dirname(root), dirname(this.#libraryRoot)) ||
      !IMPORT_STAGING_NAME_PATTERN.test(basename(root))
    ) {
      throw new Error("Owned staging path is outside the library-parent boundary");
    }
    const { device, inode, birthtimeNs } = capability.identity;
    if (!/^\d+$/u.test(device) || !/^\d+$/u.test(inode) || !/^\d+$/u.test(birthtimeNs)) {
      throw new Error("Owned staging identity is invalid");
    }
    return Object.freeze({ root, device, inode, birthtimeNs });
  }

  #validateDatabaseHealth(database: LibraryDatabase): void {
    const databasePath = database.read((raw) => {
      const rows = raw.prepare("PRAGMA database_list").all() as Array<{
        name?: unknown;
        file?: unknown;
      }>;
      const main = rows.find((row) => row.name === "main");
      if (typeof main?.file !== "string" || main.file.length === 0) {
        throw new Error("Database identity is unavailable");
      }
      return main.file;
    });
    if (!sameFileSystemPath(databasePath, join(this.#libraryRoot, DATABASE_FILE_NAME))) {
      throw new Error("Database identity does not match the library");
    }
    const journalMode = database.read((raw) => {
      const row = raw.prepare("PRAGMA journal_mode").get() as
        | { journal_mode?: unknown }
        | undefined;
      return row?.journal_mode;
    });
    if (journalMode !== "wal") throw new Error("Database is not using WAL mode");
    if (database.schemaVersion() !== CURRENT_SCHEMA_VERSION) {
      throw new Error("Database schema version is not current");
    }
    if (!database.integrityCheck().ok) throw new Error("Database integrity check failed");
    if (!database.foreignKeyCheck().ok) throw new Error("Database foreign key check failed");
    if (!database.read((raw) => validateCurrentSchema(raw).ok)) {
      throw new Error("Database schema fingerprint is invalid");
    }
  }

  #snapshotDatabase(database: LibraryDatabase): DatabaseSnapshot {
    return database.read((raw) => {
      const schemaObjects = this.#validateAndListSchemaObjects(raw);
      const counts: BlockerCounts = new Map();
      const tableCounts: string[] = [];
      for (const [table, policy] of Object.entries(EMPTY_LIBRARY_V10_TABLE_POLICIES)) {
        const row = raw.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as
          | { count?: unknown }
          | undefined;
        const count = safeCount(row?.count);
        tableCounts.push(`${table}:${count}`);
        if (policy !== null && table !== "library_state") addCount(counts, policy, count);
      }

      const customizedTemplateRows = safeCount(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS count FROM patent_template_slots
               WHERE template_revision > 0
                  OR claims_json IS NOT NULL
                  OR description_json IS NOT NULL
                  OR abstract_json IS NOT NULL`,
            )
            .get() as { count?: unknown } | undefined
        )?.count,
      );
      const customizedPreferences = safeCount(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS count FROM patent_template_preferences
               WHERE selection_kind <> 'system' OR selected_template_id IS NOT NULL`,
            )
            .get() as { count?: unknown } | undefined
        )?.count,
      );
      addCount(counts, "library-state", customizedTemplateRows + customizedPreferences);

      const legacyFactory = createLegacyFactoryPatentTemplatesV1(randomUUID);
      const auxiliaryRows = raw.prepare("SELECT * FROM patent_template_auxiliary").all() as Array<{
        patent_type: "invention" | "utility-model";
        figure_explanation_json: Uint8Array;
        drawing_legend_json: Uint8Array;
      }>;
      for (const row of auxiliaryRows) {
        const actual = [
          ParagraphNodeSchema.parse(decodeJson(row.figure_explanation_json)),
          ParagraphNodeSchema.parse(decodeJson(row.drawing_legend_json)),
        ];
        const factory = DEFAULT_APP_SETTINGS.patentTemplates[row.patent_type];
        const legacy = legacyFactory[row.patent_type];
        const seeded = V10_PATENT_TEMPLATE_AUXILIARY_SEEDS[row.patent_type].map((json) =>
          ParagraphNodeSchema.parse(JSON.parse(json)),
        );
        const current = [factory.figureExplanation, factory.drawingLegend];
        const candidates = [
          current,
          [legacy.figureExplanation, legacy.drawingLegend],
          seeded,
          seeded.map((paragraph, index) => ({ ...paragraph, content: current[index]?.content })),
        ];
        const systemOnly = candidates.some((expected) => {
          return (
            JSON.stringify(this.#normalizeGeneratedIds(actual)) ===
            JSON.stringify(
              this.#normalizeGeneratedIds(
                expected.map((paragraph) => ParagraphNodeSchema.parse(paragraph)),
              ),
            )
          );
        });
        if (!systemOnly) addCount(counts, "library-state", 1);
      }

      const stateKeys = raw
        .prepare("SELECT key, value FROM library_state ORDER BY key")
        .all() as Array<{
        key?: unknown;
        value: Uint8Array;
      }>;
      for (const row of stateKeys) {
        if (typeof row.key !== "string") throw new Error("Invalid library state key");
        if (
          row.key === "automation:library-id" ||
          row.key.startsWith("automation:baseline:") ||
          row.key.startsWith("automation:task:")
        )
          continue;
        if (
          (row.key === LEGACY_MIGRATION_KEY || row.key === UNDERLINED_SPACE_MIGRATION_KEY) &&
          decodeJson(row.value) === "1"
        )
          continue;
        addCount(counts, isPendingLibraryState(row.key) ? "pending-operation" : "library-state", 1);
      }

      const dataVersion = this.#pragmaInteger(raw, "data_version");
      const totalChanges = safeCount(
        (raw.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined)
          ?.count,
      );
      const revisions = REVISION_COLUMNS.map(([table, column]) => {
        const row = raw
          .prepare(
            `SELECT count(*) AS count,
                    COALESCE(min("${column}"), -1) AS minimum,
                    COALESCE(max("${column}"), -1) AS maximum,
                    COALESCE(sum("${column}"), 0) AS total
             FROM "${table}"`,
          )
          .get() as
          | { count?: unknown; minimum?: unknown; maximum?: unknown; total?: unknown }
          | undefined;
        return [
          table,
          safeCount(row?.count),
          this.#safeSignedInteger(row?.minimum),
          this.#safeSignedInteger(row?.maximum),
          this.#safeSignedInteger(row?.total),
        ].join(":");
      });
      return Object.freeze({
        blockers: counts,
        signature: JSON.stringify({
          dataVersion,
          totalChanges,
          schemaObjects,
          tableCounts,
          revisions,
        }),
      });
    });
  }

  #validateAndListSchemaObjects(database: DatabaseSync): string[] {
    const rows = database
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'index', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type?: unknown; name?: unknown }>;
    const expectedTables = new Set(Object.keys(EMPTY_LIBRARY_V10_TABLE_POLICIES));
    const actualTables = new Set<string>();
    const actualIndexes = new Set<string>();
    const objects: string[] = [];
    for (const row of rows) {
      if (typeof row.type !== "string" || typeof row.name !== "string") {
        throw new Error("Invalid schema object");
      }
      objects.push(`${row.type}:${row.name}`);
      if (row.type === "table") actualTables.add(row.name);
      else if (row.type === "index") actualIndexes.add(row.name);
      else throw new Error("Unexpected schema object");
    }
    if (
      !this.#sameSet(actualTables, expectedTables) ||
      !this.#sameSet(actualIndexes, EXPECTED_INDEXES)
    ) {
      throw new Error("Unclassified schema object");
    }
    return objects;
  }

  #sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
  }

  #pragmaInteger(database: DatabaseSync, pragma: string): number {
    const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
    return safeCount(row?.[pragma]);
  }

  #safeSignedInteger(value: unknown): number {
    if (!Number.isSafeInteger(value)) throw new Error("Unsafe revision value");
    return value as number;
  }

  async #snapshotFileSystem(
    probe: ReparsePointProbe,
    ownedImportStaging: NormalizedOwnedImportStaging | undefined,
  ): Promise<FileSystemSnapshot> {
    const library = await this.#snapshotLibraryRoot(probe);
    const userData = await this.#snapshotUserDataArtifacts(probe, ownedImportStaging);
    const applicationOwnedStaging =
      ownedImportStaging !== undefined &&
      sameFileSystemPath(dirname(ownedImportStaging.root), this.#applicationDataRoot)
        ? ownedImportStaging
        : undefined;
    const applicationData = await this.#snapshotApplicationDataArtifacts(
      probe,
      applicationOwnedStaging,
      ownedImportStaging,
    );
    const libraryParentStaging = await this.#snapshotLibraryParentStagingNamespace(
      probe,
      ownedImportStaging,
    );
    return Object.freeze({
      assets: library.assets,
      legacyDrafts: userData.legacyDrafts,
      polishHistory: userData.polishHistory,
      pendingOperations: userData.pendingOperations + applicationData.pendingOperations,
      signature: `${library.signature}\n${userData.signature}\n${applicationData.signature}\n${libraryParentStaging}`,
    });
  }

  async #snapshotLibraryRoot(probe: ReparsePointProbe): Promise<{
    assets: number;
    signature: string;
  }> {
    const rootInfo = await this.#requiredPathInfo(this.#libraryRoot, probe);
    await this.#assertCanonicalPlainPath(this.#libraryRoot, rootInfo, "directory");
    const signatures = [statsSignature(".", rootInfo, "directory")];
    let assets = 0;
    let databasePresent = false;
    const entries = (await this.#fileSystem.readdir(this.#libraryRoot)).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(this.#libraryRoot, entry.name);
      const info = await this.#requiredPathInfo(path, probe);
      const kind = statsKind(info);
      signatures.push(
        entry.name === `${DATABASE_FILE_NAME}-wal` || entry.name === `${DATABASE_FILE_NAME}-shm`
          ? stableArtifactIdentitySignature(entry.name, info, kind)
          : statsSignature(entry.name, info, kind),
      );
      if (entry.name === DATABASE_FILE_NAME) databasePresent = true;
      if (entry.name === ASSETS_DIRECTORY_NAME) {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        const contents = await this.#snapshotDirectoryContents(path, ASSETS_DIRECTORY_NAME, probe);
        assets = contents.count;
        signatures.push(...contents.signatures);
        continue;
      }
      if (ALLOWED_LIBRARY_FILES.has(entry.name)) {
        await this.#assertCanonicalPlainPath(path, info, "file");
        if (entry.name === "last-run-state.json") await this.#validateRunState(path, info);
        continue;
      }
      throw new Error("Unknown library artifact");
    }
    if (!databasePresent) throw new Error("Library database is missing");
    return { assets, signature: signatures.join("\n") };
  }

  async #snapshotUserDataArtifacts(
    probe: ReparsePointProbe,
    ownedImportStaging: NormalizedOwnedImportStaging | undefined,
  ): Promise<{
    legacyDrafts: number;
    polishHistory: number;
    pendingOperations: number;
    signature: string;
  }> {
    const userDataInfo = await this.#pathInfo(this.#userDataRoot, probe);
    if (userDataInfo === null) {
      return {
        legacyDrafts: 0,
        polishHistory: 0,
        pendingOperations: 0,
        signature: "user-data:absent",
      };
    }
    await this.#assertCanonicalPlainPath(this.#userDataRoot, userDataInfo, "directory");
    let polishHistory = 0;
    const signatures = [stableArtifactIdentitySignature("user-data", userDataInfo, "directory")];
    const rootEntries = (await this.#fileSystem.readdir(this.#userDataRoot)).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of rootEntries) {
      const path = join(this.#userDataRoot, entry.name);
      const info = await this.#requiredPathInfo(path, probe);
      const kind = statsKind(info);
      const isVolatileRuntimeArtifact =
        ELECTRON_USER_DATA_DIRECTORIES.has(entry.name) ||
        ELECTRON_USER_DATA_FILES.has(entry.name) ||
        REBUILDABLE_CACHE_DIRECTORIES.has(entry.name) ||
        entry.name === "logs" ||
        entry.name === "usage-statistics.json";
      signatures.push(
        isVolatileRuntimeArtifact
          ? stableArtifactIdentitySignature(`user-data/${entry.name}`, info, kind)
          : statsSignature(`user-data/${entry.name}`, info, kind),
      );
      if (ownedImportStaging !== undefined && sameFileSystemPath(path, ownedImportStaging.root)) {
        await this.#assertOwnedStagingIdentity(path, info, ownedImportStaging);
        continue;
      }
      // These configured roots are inspected separately, including their contents.
      // Harmony and desktop defaults can place them inside userData.
      if (
        sameFileSystemPath(path, this.#applicationDataRoot) ||
        sameFileSystemPath(path, this.#libraryRoot)
      ) {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        continue;
      }
      if (entry.name === "text-polish-history") {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        const contents = await this.#snapshotDirectoryContents(path, entry.name, probe);
        polishHistory = contents.count;
        signatures.push(...contents.signatures);
        continue;
      }
      if (
        APPLICATION_USER_DATA_DIRECTORIES.has(entry.name) ||
        REBUILDABLE_CACHE_DIRECTORIES.has(entry.name) ||
        ELECTRON_USER_DATA_DIRECTORIES.has(entry.name)
      ) {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        continue;
      }
      if (APPLICATION_USER_DATA_FILES.has(entry.name) || ELECTRON_USER_DATA_FILES.has(entry.name)) {
        await this.#assertCanonicalPlainPath(path, info, "file");
        if (entry.name === "agreement-consent.json") {
          const bytes = await this.#readBounded(path, info, 4096, false);
          AgreementRecordSchema.parse(JSON.parse(bytes.toString("utf8")));
        }
        continue;
      }
      throw new Error("Unknown user-data artifact");
    }

    const draftsPath = join(this.#userDataRoot, LEGACY_DRAFTS_DIRECTORY_NAME);
    const draftsInfo = await this.#pathInfo(draftsPath, probe);
    let legacyDrafts = 0;
    if (draftsInfo === null) {
      signatures.push("drafts:absent");
    } else {
      await this.#assertCanonicalPlainPath(draftsPath, draftsInfo, "directory");
      signatures.push(statsSignature("drafts", draftsInfo, "directory"));
      const contents = await this.#snapshotDirectoryContents(draftsPath, "drafts", probe);
      legacyDrafts = contents.count;
      signatures.push(...contents.signatures);
    }

    let pendingOperations = 0;
    const migrationStatePath = join(this.#userDataRoot, LEGACY_DRAFT_MIGRATION_STATE_NAME);
    const migrationStateInfo = await this.#pathInfo(migrationStatePath, probe);
    if (migrationStateInfo === null) {
      signatures.push(`${LEGACY_DRAFT_MIGRATION_STATE_NAME}:absent`);
    } else {
      await this.#assertCanonicalPlainPath(migrationStatePath, migrationStateInfo, "file");
      signatures.push(
        statsSignature(LEGACY_DRAFT_MIGRATION_STATE_NAME, migrationStateInfo, "file"),
      );
      pendingOperations = 1;
    }

    for (const fileName of ["settings.json", "settings.json.last-good"] as const) {
      const path = join(this.#userDataRoot, fileName);
      const info = await this.#pathInfo(path, probe);
      if (info === null) {
        signatures.push(`${fileName}:absent`);
        continue;
      }
      await this.#assertCanonicalPlainPath(path, info, "file");
      await this.#validateDefaultSettings(path, info);
      signatures.push(statsSignature(fileName, info, "file"));
    }

    const logsPath = join(this.#userDataRoot, "logs");
    const logsInfo = await this.#pathInfo(logsPath, probe);
    if (logsInfo === null) {
      signatures.push("logs:absent");
    } else {
      await this.#assertCanonicalPlainPath(logsPath, logsInfo, "directory");
      signatures.push(stableArtifactIdentitySignature("logs", logsInfo, "directory"));
      const contents = await this.#snapshotLogDirectory(logsPath, probe);
      signatures.push(...contents.signatures);
    }
    return { legacyDrafts, polishHistory, pendingOperations, signature: signatures.join("\n") };
  }

  async #snapshotApplicationDataArtifacts(
    probe: ReparsePointProbe,
    ownedImportStaging: NormalizedOwnedImportStaging | undefined,
    receiptOwner: NormalizedOwnedImportStaging | undefined,
  ): Promise<{
    pendingOperations: number;
    signature: string;
  }> {
    const rootInfo = await this.#pathInfo(this.#applicationDataRoot, probe);
    if (rootInfo === null) {
      if (ownedImportStaging !== undefined) throw new Error("Owned staging root disappeared");
      return { pendingOperations: 0, signature: "application-data:absent" };
    }
    await this.#assertCanonicalPlainPath(this.#applicationDataRoot, rootInfo, "directory");
    const signatures = [statsSignature("application-data", rootInfo, "directory")];
    let pendingOperations = 0;
    let ownedStagingMatched = false;
    const entries = (await this.#fileSystem.readdir(this.#applicationDataRoot)).sort(
      (left, right) => compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(this.#applicationDataRoot, entry.name);
      const info = await this.#requiredPathInfo(path, probe);
      const kind = statsKind(info);
      signatures.push(statsSignature(`application-data/${entry.name}`, info, kind));
      if (entry.name === IMPORT_STAGING_OWNERSHIP_FILE) {
        await this.#assertCanonicalPlainPath(path, info, "file");
        const receipt = ImportStagingOwnershipSchema.parse(
          JSON.parse((await this.#readBounded(path, info, 8192, false)).toString("utf8")),
        );
        const first = receipt.roots[0];
        const second = receipt.roots[1];
        if (
          !receiptOwner ||
          !first?.identity ||
          !second?.identity ||
          !sameFileSystemPath(receipt.libraryRoot, this.#libraryRoot) ||
          !sameFileSystemPath(receipt.userDataRoot, this.#userDataRoot) ||
          !sameFileSystemPath(first.path, receiptOwner.root) ||
          !sameFileSystemPath(
            first.path,
            join(dirname(this.#libraryRoot), `.import-staging-${receipt.operationId}`),
          ) ||
          !sameFileSystemPath(
            second.path,
            join(dirname(this.#userDataRoot), `.import-user-data-${receipt.operationId}`),
          ) ||
          first.identity.device !== receiptOwner.device ||
          first.identity.inode !== receiptOwner.inode ||
          first.identity.birthtimeNs !== receiptOwner.birthtimeNs
        )
          throw new Error("Unowned preparation receipt");
        continue;
      }
      if (ownedImportStaging !== undefined && sameFileSystemPath(path, ownedImportStaging.root)) {
        await this.#assertOwnedStagingIdentity(path, info, ownedImportStaging);
        ownedStagingMatched = true;
        continue;
      }
      // Explicitly retired CLI staging is outside the installed library and is never removed by import.
      if (
        /^\.discarded-data-import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          entry.name,
        )
      ) {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        continue;
      }
      if (entry.name === "automation-transfer") {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        const files = await this.#fileSystem.readdir(path);
        if (files.length !== 1 || files[0]?.name !== "handoff.json")
          throw new Error("Unknown automation handoff artifact");
        const receiptPath = join(path, "handoff.json");
        const receiptInfo = await this.#requiredPathInfo(receiptPath, probe);
        await this.#assertCanonicalPlainPath(receiptPath, receiptInfo, "file");
        if (receiptInfo.size > 4096) throw new Error("Oversized handoff receipt");
        TransferHandoffReceiptSchema.parse(
          JSON.parse((await this.#fileSystem.readFile(receiptPath)).toString("utf8")),
        );
        signatures.push(statsSignature("automation-transfer/handoff.json", receiptInfo, "file"));
        continue;
      }
      if (entry.name === PENDING_DATA_IMPORT_STATE_NAME) {
        await this.#assertCanonicalPlainPath(path, info, "file");
        pendingOperations = 1;
        continue;
      }
      const isDefaultLibrary = entry.name === "Library";
      // A verified owned export task is a disposable copy, never installed user data.
      // Antivirus/file locks may postpone its cleanup without making an empty library non-empty.
      if (await isOwnedExportArtifact(this.#applicationDataRoot, entry.name)) continue;
      const isExplicitLibraryChild =
        sameFileSystemPath(dirname(this.#libraryRoot), this.#applicationDataRoot) &&
        sameFileSystemPath(path, this.#libraryRoot);
      if (isDefaultLibrary || isExplicitLibraryChild) {
        await this.#assertCanonicalPlainPath(path, info, "directory");
        continue;
      }
      throw new Error("Unknown application-data artifact");
    }
    if (ownedImportStaging !== undefined && !ownedStagingMatched) {
      throw new Error("Owned staging root disappeared");
    }
    return { pendingOperations, signature: signatures.join("\n") };
  }

  async #snapshotLibraryParentStagingNamespace(
    probe: ReparsePointProbe,
    ownedImportStaging: NormalizedOwnedImportStaging | undefined,
  ): Promise<string> {
    const parent = dirname(this.#libraryRoot);
    const parentInfo = await this.#requiredPathInfo(parent, probe);
    await this.#assertCanonicalPlainPath(parent, parentInfo, "directory");
    const signatures = [statsSignature("library-parent", parentInfo, "directory")];
    let ownedStagingMatched = false;
    const entries = (await this.#fileSystem.readdir(parent)).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      if (!entry.name.startsWith(IMPORT_STAGING_PREFIX)) continue;
      if (!IMPORT_STAGING_NAME_PATTERN.test(entry.name)) {
        throw new Error("Malformed import staging artifact exists");
      }
      const path = join(parent, entry.name);
      if (ownedImportStaging === undefined || !sameFileSystemPath(path, ownedImportStaging.root)) {
        throw new Error("Unowned import staging directory exists");
      }
      const info = await this.#requiredPathInfo(path, probe);
      await this.#assertOwnedStagingIdentity(path, info, ownedImportStaging);
      signatures.push(statsSignature(`library-parent/${entry.name}`, info, "directory"));
      ownedStagingMatched = true;
    }
    if (ownedImportStaging !== undefined && !ownedStagingMatched) {
      throw new Error("Owned staging root disappeared");
    }
    return signatures.join("\n");
  }

  async #assertOwnedStagingIdentity(
    path: string,
    info: Stats,
    ownedImportStaging: NormalizedOwnedImportStaging,
  ): Promise<void> {
    await this.#assertCanonicalPlainPath(path, info, "directory");
    const identity = await this.#fileSystem.lstatIdentity(path);
    if (
      identity.device !== ownedImportStaging.device ||
      identity.inode !== ownedImportStaging.inode ||
      identity.birthtimeNs !== ownedImportStaging.birthtimeNs
    ) {
      throw new Error("Owned staging identity changed");
    }
  }

  async #snapshotDirectoryContents(
    root: string,
    signatureRoot: string,
    probe: ReparsePointProbe,
  ): Promise<{ count: number; signatures: string[] }> {
    const pending: Array<{ path: string; relativePath: string }> = [
      { path: root, relativePath: signatureRoot },
    ];
    const signatures: string[] = [];
    let count = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      const entries = (await this.#fileSystem.readdir(directory.path)).sort((left, right) =>
        compareNames(left.name, right.name),
      );
      for (const entry of entries) {
        const path = join(directory.path, entry.name);
        const relativePath = `${directory.relativePath}/${entry.name}`;
        const info = await this.#requiredPathInfo(path, probe);
        const kind = statsKind(info);
        await this.#assertCanonicalPlainPath(path, info, kind);
        signatures.push(statsSignature(relativePath, info, kind));
        count += 1;
        if (!Number.isSafeInteger(count)) throw new Error("Directory entry count overflow");
        if (kind === "directory") pending.push({ path, relativePath });
      }
    }
    signatures.sort(compareNames);
    return { count, signatures };
  }

  async #snapshotLogDirectory(
    root: string,
    probe: ReparsePointProbe,
  ): Promise<{ count: number; signatures: string[] }> {
    const signatures: string[] = [];
    let count = 0;
    const entries = (await this.#fileSystem.readdir(root)).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      if (!/^app(?:\.[1-6])?\.log$/u.test(entry.name)) {
        throw new Error("Unknown log artifact");
      }
      const path = join(root, entry.name);
      const info = await this.#requiredPathInfo(path, probe);
      await this.#assertCanonicalPlainPath(path, info, "file");
      await this.#readBounded(path, info, MAX_LOG_BYTES, true);
      signatures.push(stableArtifactIdentitySignature(`logs/${entry.name}`, info, "file"));
      count += 1;
      if (!Number.isSafeInteger(count)) throw new Error("Log file count overflow");
    }
    return { count, signatures };
  }

  async #validateRunState(path: string, info: Stats): Promise<void> {
    const bytes = await this.#readBounded(path, info, MAX_RUN_STATE_BYTES, false);
    PersistedRunStateSchema.parse(JSON.parse(bytes.toString("utf8")));
  }

  async #validateDefaultSettings(path: string, info: Stats): Promise<void> {
    const bytes = await this.#readBounded(path, info, MAX_SETTINGS_BYTES, false);
    const settings = AppSettingsSchema.parse(JSON.parse(bytes.toString("utf8")));
    // Seeing the tray hint is initialization state, not a user preference.
    settings.trayIntroDismissed = DEFAULT_APP_SETTINGS.trayIntroDismissed;
    settings.welcomeCompleted = DEFAULT_APP_SETTINGS.welcomeCompleted;
    if (
      JSON.stringify(this.#normalizeGeneratedIds(settings)) !==
      JSON.stringify(this.#normalizeGeneratedIds(DEFAULT_APP_SETTINGS))
    ) {
      throw new Error("Non-default settings are not inspectable");
    }
  }

  #normalizeGeneratedIds(value: unknown): unknown {
    if (typeof value === "string") {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
        ? "<generated-id>"
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.#normalizeGeneratedIds(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => compareNames(left, right))
          .map(([key, item]) => [key, this.#normalizeGeneratedIds(item)]),
      );
    }
    return value;
  }

  async #readBounded(
    path: string,
    info: Stats,
    maximumBytes: number,
    allowEmpty: boolean,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(info.size) ||
      info.size < (allowEmpty ? 0 : 1) ||
      info.size > maximumBytes
    ) {
      throw new Error("Invalid artifact size");
    }
    const bytes = await this.#fileSystem.readFile(path);
    if (bytes.byteLength !== info.size) throw new Error("Artifact changed while reading");
    return bytes;
  }

  async #assertCanonicalPlainPath(
    path: string,
    info: Stats,
    expectedKind: "directory" | "file",
  ): Promise<void> {
    if (statsKind(info) !== expectedKind) throw new Error("Unexpected filesystem object kind");
    const canonical = await this.#fileSystem.realpath(path);
    if (!sameFileSystemPath(canonical, path)) throw new Error("Filesystem object escaped its path");
  }

  async #requiredPathInfo(path: string, probe: ReparsePointProbe): Promise<Stats> {
    const info = await this.#pathInfo(path, probe);
    if (info === null) throw new Error("Required filesystem object disappeared");
    return info;
  }

  async #pathInfo(path: string, probe: ReparsePointProbe): Promise<Stats | null> {
    try {
      const info = await this.#fileSystem.lstat(path);
      await probe.assertSafe(path);
      return info;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }
}
