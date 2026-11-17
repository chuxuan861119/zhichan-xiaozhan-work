import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile as copyFileDefault,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalSystemPath } from "../platform/system-path.js";
import { LibraryDatabase } from "./library-database.js";
import {
  CURRENT_SCHEMA_VERSION,
  V10_UPGRADE_FROM_V9_STATEMENTS,
  V12_UPGRADE_FROM_V10_STATEMENTS,
  V13_UPGRADE_FROM_V11_STATEMENTS,
  V13_UPGRADE_FROM_V12_STATEMENTS,
  V14_UPGRADE_FROM_V13_STATEMENTS,
  V15_MIGRATION_STATEMENTS,
  V15_UPGRADE_FROM_V14_STATEMENTS,
  validateCurrentSchema,
  validateSchemaV9,
  validateSchemaV10,
  validateSchemaV11,
  validateSchemaV12,
  validateSchemaV13,
  validateSchemaV14,
  validateSchemaVersionV10,
} from "./schema.js";

const DATABASE_NAME = "library.sqlite3";
const ASSETS_DIRECTORY_NAME = "assets";
const BACKUPS_DIRECTORY_NAME = "safety-backups";
const ASSET_MANIFEST_NAME = "asset-manifest.json";
const MAX_ASSET_FILES = 10_000;
const MAX_ASSET_DIRECTORIES = 1_024;
const MAX_ASSET_DIRECTORY_ENTRIES = 4_096;
const MAX_ASSET_DEPTH = 32;
const MAX_ASSET_RELATIVE_PATH_BYTES = 1_024;
const MAX_ASSET_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_BACKUP_COLLISIONS = 1_000;
const MAX_INTEGRITY_MESSAGES = 100;
const MAX_INTEGRITY_MESSAGE_LENGTH = 1_024;

type MigrationEvent =
  | "integrity-check"
  | "checkpoint"
  | "close"
  | "backup-database"
  | "backup-wal"
  | "backup-shm"
  | "asset-manifest"
  | "reopen"
  | "exclusive-lock"
  | "migrate";

type Fingerprint = { size: number; sha256: string };
type SourceSnapshot = Map<string, Fingerprint>;

type VerifiedBackup = {
  directory: string;
  logicalDatabaseSnapshot: SourceSnapshot;
};

type MigrationDependencies = {
  now?: (() => Date) | undefined;
  onEvent?: ((event: MigrationEvent) => void) | undefined;
  migrationStatements?: readonly string[] | undefined;
  upgradeFromV9Statements?: readonly string[] | undefined;
  upgradeFromV10Statements?: readonly string[] | undefined;
  copyFile?: ((source: string, destination: string) => Promise<void>) | undefined;
  hashFile?: ((path: string) => Promise<Fingerprint>) | undefined;
};

export type LibraryPreparationResult =
  | { status: "ready"; database: LibraryDatabase; backupCreated: boolean }
  | { status: "read-only-corrupt"; database: null; messages: string[] }
  | {
      status: "upgrade-failed";
      database: LibraryDatabase | null;
      reason:
        | "backup-failed"
        | "incomplete-library"
        | "invalid-library-root"
        | "migration-failed"
        | "unsupported-schema";
    };

type ExistingLibrary = {
  root: string;
  databaseExisted: boolean;
  walExisted: boolean;
  shmExisted: boolean;
  assetsExisted: boolean;
};

type AssetManifestEntry = {
  relativePath: string;
  size: number;
  sha256: string;
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function compareAssetRelativePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function normalizedFileSystemPath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameFileSystemPath(left: string, right: string): boolean {
  return normalizedFileSystemPath(left) === normalizedFileSystemPath(right);
}

async function pathInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function defaultHashFile(path: string): Promise<Fingerprint> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (!Number.isSafeInteger(size)) throw new Error("File is too large to verify safely");
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

export class LibraryMigrationService {
  private readonly now: () => Date;
  private readonly onEvent: (event: MigrationEvent) => void;
  private readonly migrationStatements: readonly string[];
  private readonly upgradeFromV9Statements: readonly string[];
  private readonly upgradeFromV10Statements: readonly string[];
  private readonly copyFile: (source: string, destination: string) => Promise<void>;
  private readonly hashFile: (path: string) => Promise<Fingerprint>;

  constructor(
    private readonly requestedRoot: string,
    dependencies: MigrationDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.onEvent = dependencies.onEvent ?? (() => undefined);
    this.migrationStatements = dependencies.migrationStatements ?? V15_MIGRATION_STATEMENTS;
    this.upgradeFromV9Statements =
      dependencies.upgradeFromV9Statements ?? V10_UPGRADE_FROM_V9_STATEMENTS;
    this.upgradeFromV10Statements =
      dependencies.upgradeFromV10Statements ?? V12_UPGRADE_FROM_V10_STATEMENTS;
    this.copyFile = dependencies.copyFile ?? copyFileDefault;
    this.hashFile = dependencies.hashFile ?? defaultHashFile;
  }

  async prepare(): Promise<LibraryPreparationResult> {
    let existing: ExistingLibrary;
    try {
      existing = await this.#validateLibraryRoot();
    } catch {
      return { status: "upgrade-failed", database: null, reason: "invalid-library-root" };
    }

    const hasExistingData = existing.databaseExisted || existing.assetsExisted;
    if (existing.assetsExisted && !existing.databaseExisted) {
      return { status: "upgrade-failed", database: null, reason: "incomplete-library" };
    }
    if (!existing.databaseExisted && (existing.walExisted || existing.shmExisted)) {
      return { status: "upgrade-failed", database: null, reason: "incomplete-library" };
    }

    const databasePath = resolve(existing.root, DATABASE_NAME);
    let existingVersion: number | null = null;
    let needsDocumentSchema = false;
    if (existing.databaseExisted) {
      this.onEvent("integrity-check");
      const integrity = this.#checkExistingIntegrity(databasePath);
      if (!integrity.ok) {
        return { status: "read-only-corrupt", database: null, messages: integrity.messages };
      }
      const schema = this.#inspectExistingSchema(databasePath);
      if (schema.status === "invalid") {
        return {
          status: "read-only-corrupt",
          database: null,
          messages: ["database schema does not match its recorded version"],
        };
      }
      if (schema.status === "unsupported") {
        return { status: "upgrade-failed", database: null, reason: "unsupported-schema" };
      }
      existingVersion = schema.version;
      needsDocumentSchema = schema.needsDocumentSchema;
    }

    let database: LibraryDatabase;
    try {
      database = LibraryDatabase.open(databasePath);
    } catch {
      return {
        status: "read-only-corrupt",
        database: null,
        messages: ["database could not be opened for an integrity check"],
      };
    }

    if (!existing.databaseExisted) {
      this.onEvent("integrity-check");
      const integrity = database.integrityCheck();
      if (!integrity.ok) {
        database.close();
        return { status: "read-only-corrupt", database: null, messages: integrity.messages };
      }
    }

    let version = existingVersion;
    if (!existing.databaseExisted) {
      try {
        version = database.schemaVersion();
      } catch {
        return { status: "upgrade-failed", database, reason: "unsupported-schema" };
      }
    }
    if (version === CURRENT_SCHEMA_VERSION && !needsDocumentSchema) {
      return { status: "ready", database, backupCreated: false };
    }
    if (version !== null && version > CURRENT_SCHEMA_VERSION) {
      return { status: "upgrade-failed", database, reason: "unsupported-schema" };
    }

    let backupCreated = false;
    let verifiedBackup: VerifiedBackup | null = null;
    if (hasExistingData) {
      try {
        database.checkpoint();
        this.onEvent("checkpoint");
        database.close();
        this.onEvent("close");
        verifiedBackup = await this.#createVerifiedBackup(existing.root);
        backupCreated = true;
      } catch {
        database.close();
        return {
          status: "upgrade-failed",
          database: this.#tryReopen(databasePath),
          reason: "backup-failed",
        };
      }
      try {
        database = LibraryDatabase.open(databasePath);
        this.onEvent("reopen");
      } catch {
        return { status: "upgrade-failed", database: null, reason: "backup-failed" };
      }
    }

    let exclusiveTransactionOpen = false;
    let failureReason: "backup-failed" | "migration-failed" = "migration-failed";
    try {
      database.read((rawDatabase) => rawDatabase.exec("BEGIN EXCLUSIVE"));
      exclusiveTransactionOpen = true;
      this.onEvent("exclusive-lock");

      if (verifiedBackup !== null) {
        const lockedSnapshot = await this.#snapshotLogicalDatabaseSources(existing.root);
        if (!this.#sameSnapshot(verifiedBackup.logicalDatabaseSnapshot, lockedSnapshot)) {
          failureReason = "backup-failed";
          throw new Error("Database changed after backup verification");
        }
      }

      this.onEvent("migrate");
      database.read((rawDatabase) => {
        const statements: string[] = [];
        if (version === null) {
          statements.push(...this.migrationStatements);
        } else if (version === 9) {
          statements.push(...this.upgradeFromV9Statements, ...this.upgradeFromV10Statements);
          statements.push(...V13_UPGRADE_FROM_V12_STATEMENTS);
        } else if (version === 10) {
          statements.push(...this.upgradeFromV10Statements, ...V13_UPGRADE_FROM_V12_STATEMENTS);
        } else if (version === 11) {
          statements.push(...V13_UPGRADE_FROM_V11_STATEMENTS);
        } else if (version === 12) {
          statements.push(...V13_UPGRADE_FROM_V12_STATEMENTS);
        } else if (version !== 13 && version !== 14 && version !== CURRENT_SCHEMA_VERSION) {
          throw new Error("Unsupported schema migration path");
        }
        if (version !== null && version >= 9 && version <= 13)
          statements.push(...V14_UPGRADE_FROM_V13_STATEMENTS);
        if (version !== null && version >= 9 && version <= 14)
          statements.push(...V15_UPGRADE_FROM_V14_STATEMENTS);
        for (const statement of statements) rawDatabase.exec(statement);
        if (!validateCurrentSchema(rawDatabase).ok) {
          throw new Error("Schema version validation failed");
        }
        rawDatabase.exec("COMMIT");
      });
      exclusiveTransactionOpen = false;
      return { status: "ready", database, backupCreated };
    } catch {
      if (exclusiveTransactionOpen) {
        try {
          database.read((rawDatabase) => rawDatabase.exec("ROLLBACK"));
        } catch {
          // Closing the connection below is the final lock-release fallback.
        }
      }
      database.close();
      if (failureReason === "backup-failed" && verifiedBackup !== null) {
        await rm(verifiedBackup.directory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!existing.databaseExisted) {
        await this.#removeNewSqliteFiles(existing).catch(() => undefined);
        return { status: "upgrade-failed", database: null, reason: failureReason };
      }
      return {
        status: "upgrade-failed",
        database: this.#tryReopen(databasePath),
        reason: failureReason,
      };
    }
  }

  async #validateLibraryRoot(): Promise<ExistingLibrary> {
    const absoluteRoot = canonicalSystemPath(this.requestedRoot);
    await this.#validateExistingAncestorChain(absoluteRoot);
    const rootInfo = await pathInfo(absoluteRoot);
    if (rootInfo !== null && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) {
      throw new Error("Invalid library root");
    }
    if (rootInfo === null) await mkdir(absoluteRoot, { recursive: true });
    const root = await realpath(absoluteRoot);
    if (!isSameFileSystemPath(root, absoluteRoot)) throw new Error("Library root escaped its path");

    const databaseInfo = await pathInfo(resolve(root, DATABASE_NAME));
    if (databaseInfo !== null && (!databaseInfo.isFile() || databaseInfo.isSymbolicLink())) {
      throw new Error("Invalid database file");
    }
    const walInfo = await pathInfo(resolve(root, `${DATABASE_NAME}-wal`));
    if (walInfo !== null && (!walInfo.isFile() || walInfo.isSymbolicLink())) {
      throw new Error("Invalid database WAL file");
    }
    const shmInfo = await pathInfo(resolve(root, `${DATABASE_NAME}-shm`));
    if (shmInfo !== null && (!shmInfo.isFile() || shmInfo.isSymbolicLink())) {
      throw new Error("Invalid database SHM file");
    }
    const assetsInfo = await pathInfo(resolve(root, ASSETS_DIRECTORY_NAME));
    if (assetsInfo !== null && (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink())) {
      throw new Error("Invalid asset root");
    }
    return {
      root,
      databaseExisted: databaseInfo !== null,
      walExisted: walInfo !== null,
      shmExisted: shmInfo !== null,
      assetsExisted: assetsInfo !== null,
    };
  }

  async #validateExistingAncestorChain(absoluteRoot: string): Promise<void> {
    const parsed = parse(absoluteRoot);
    let current = parsed.root;
    let nearestExistingAncestor = parsed.root;
    const components = absoluteRoot.slice(parsed.root.length).split(sep).filter(Boolean);
    for (const component of components) {
      current = resolve(current, component);
      const info = await pathInfo(current);
      if (info === null) break;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Library ancestor is not a plain directory");
      }
      nearestExistingAncestor = current;
      try {
        const canonical = await realpath(current);
        if (!isSameFileSystemPath(canonical, current)) {
          throw new Error("Library ancestor escaped its lexical path");
        }
      } catch (error) {
        if (!isNodeError(error, "EPERM")) throw error;
      }
    }
    const canonicalAncestor = await realpath(nearestExistingAncestor);
    if (!isSameFileSystemPath(canonicalAncestor, nearestExistingAncestor)) {
      throw new Error("Library ancestor escaped its lexical path");
    }
  }

  async #removeNewSqliteFiles(existing: ExistingLibrary): Promise<void> {
    for (const [name, existed] of [
      [DATABASE_NAME, existing.databaseExisted],
      [`${DATABASE_NAME}-wal`, existing.walExisted],
      [`${DATABASE_NAME}-shm`, existing.shmExisted],
    ] as const) {
      if (existed) continue;
      const path = resolve(existing.root, name);
      const info = await pathInfo(path);
      if (info === null) continue;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe SQLite cleanup target");
      const canonicalPath = await realpath(path);
      if (!isInside(existing.root, canonicalPath) || canonicalPath !== path) {
        throw new Error("SQLite cleanup target escaped library");
      }
      await rm(path, { force: true });
    }
  }

  #checkExistingIntegrity(databasePath: string): { ok: true } | { ok: false; messages: string[] } {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(toNamespacedPath(databasePath), { readOnly: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "database could not be opened";
      return { ok: false, messages: [message.slice(0, MAX_INTEGRITY_MESSAGE_LENGTH)] };
    }

    try {
      const rows = database.prepare(`PRAGMA integrity_check(${MAX_INTEGRITY_MESSAGES})`).all();
      const messages = rows.slice(0, MAX_INTEGRITY_MESSAGES).map((row) => {
        const message = (row as Record<string, unknown>).integrity_check;
        return typeof message === "string"
          ? message.slice(0, MAX_INTEGRITY_MESSAGE_LENGTH)
          : "unknown integrity error";
      });
      if (messages.length === 1 && messages[0] === "ok") return { ok: true };
      return { ok: false, messages };
    } catch (error) {
      const message = error instanceof Error ? error.message : "database integrity check failed";
      return { ok: false, messages: [message.slice(0, MAX_INTEGRITY_MESSAGE_LENGTH)] };
    } finally {
      database.close();
    }
  }

  #inspectExistingSchema(
    databasePath: string,
  ):
    | { status: "supported"; version: number | null; needsDocumentSchema: boolean }
    | { status: "invalid" }
    | { status: "unsupported" } {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(toNamespacedPath(databasePath), { readOnly: true });
      const table = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("schema_migrations");
      if (table === undefined) {
        return { status: "supported", version: null, needsDocumentSchema: false };
      }
      const rows = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      if (rows.length !== 1) return { status: "invalid" };
      const version = (rows[0] as { version?: unknown }).version;
      if (!Number.isSafeInteger(version) || (version as number) < 1) {
        return { status: "invalid" };
      }
      if (version === 9) {
        return validateSchemaV9(database).ok
          ? { status: "supported", version: 9, needsDocumentSchema: false }
          : { status: "invalid" };
      }
      if (version === 10) {
        return validateSchemaV10(database).ok && validateSchemaVersionV10(database).ok
          ? { status: "supported", version: 10, needsDocumentSchema: false }
          : { status: "invalid" };
      }
      if (version === 11 || version === 12) {
        const validation =
          version === 11 ? validateSchemaV11(database) : validateSchemaV12(database);
        return validation.ok
          ? { status: "supported", version, needsDocumentSchema: false }
          : { status: "invalid" };
      }
      if (version === 13) {
        return validateSchemaV13(database).ok
          ? { status: "supported", version: 13, needsDocumentSchema: false }
          : { status: "invalid" };
      }
      if (version === 14) {
        return validateSchemaV14(database).ok
          ? { status: "supported", version: 14, needsDocumentSchema: false }
          : { status: "invalid" };
      }
      if (version !== CURRENT_SCHEMA_VERSION) return { status: "unsupported" };
      return validateCurrentSchema(database).ok
        ? { status: "supported", version: CURRENT_SCHEMA_VERSION, needsDocumentSchema: false }
        : { status: "invalid" };
    } catch {
      return { status: "invalid" };
    } finally {
      database?.close();
    }
  }

  async #createVerifiedBackup(root: string): Promise<VerifiedBackup> {
    const backup = await this.#createUniqueBackupDirectory(root);
    try {
      const before = await this.#snapshotBackupSources(root);
      for (const name of before.keys()) {
        await this.copyFile(resolve(root, name), resolve(backup, name));
      }
      await this.#writeAndVerifyAssetManifest(root, backup);
      const after = await this.#snapshotBackupSources(root);
      if (!this.#sameSnapshot(before, after)) throw new Error("Backup source set changed");
      for (const [name, sourceFingerprint] of before) {
        const destinationFingerprint = await this.hashFile(resolve(backup, name));
        if (
          destinationFingerprint.size !== sourceFingerprint.size ||
          destinationFingerprint.sha256 !== sourceFingerprint.sha256
        ) {
          throw new Error("Backup destination verification failed");
        }
      }
      const events = new Map<string, MigrationEvent>([
        [DATABASE_NAME, "backup-database"],
        [`${DATABASE_NAME}-wal`, "backup-wal"],
        [`${DATABASE_NAME}-shm`, "backup-shm"],
      ]);
      for (const name of before.keys()) {
        const event = events.get(name);
        if (event !== undefined) this.onEvent(event);
      }
      this.onEvent("asset-manifest");
      return {
        directory: backup,
        logicalDatabaseSnapshot: this.#logicalDatabaseSnapshot(after),
      };
    } catch (error) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #createUniqueBackupDirectory(root: string): Promise<string> {
    const backups = resolve(root, BACKUPS_DIRECTORY_NAME);
    const backupsInfo = await pathInfo(backups);
    if (backupsInfo !== null && (!backupsInfo.isDirectory() || backupsInfo.isSymbolicLink())) {
      throw new Error("Invalid safety backup root");
    }
    if (backupsInfo === null) await mkdir(backups);
    const resolvedBackups = await realpath(backups);
    if (!isInside(root, resolvedBackups)) throw new Error("Safety backup root escaped library");

    const timestamp = this.now().toISOString().replace(/[-:.]/gu, "");
    for (let collision = 0; collision < MAX_BACKUP_COLLISIONS; collision += 1) {
      const suffix = collision === 0 ? "" : `-${collision}`;
      const candidate = resolve(resolvedBackups, `${timestamp}${suffix}`);
      if (!isInside(resolvedBackups, candidate)) throw new Error("Invalid backup destination");
      try {
        await mkdir(candidate);
        return candidate;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    throw new Error("Could not allocate a unique safety backup directory");
  }

  async #snapshotBackupSources(root: string): Promise<SourceSnapshot> {
    const snapshot: SourceSnapshot = new Map();
    for (const [name, optional] of [
      [DATABASE_NAME, false],
      [`${DATABASE_NAME}-wal`, true],
      [`${DATABASE_NAME}-shm`, true],
    ] as const) {
      const source = resolve(root, name);
      const sourceInfo = await pathInfo(source);
      if (sourceInfo === null && optional) continue;
      if (sourceInfo === null || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error("Invalid backup source");
      }
      const canonicalSource = await realpath(source);
      if (!isInside(root, canonicalSource) || canonicalSource !== source) {
        throw new Error("Backup source escaped library");
      }
      snapshot.set(name, await this.hashFile(source));
    }
    return snapshot;
  }

  async #snapshotLogicalDatabaseSources(root: string): Promise<SourceSnapshot> {
    const snapshot: SourceSnapshot = new Map();
    for (const [name, optional] of [
      [DATABASE_NAME, false],
      [`${DATABASE_NAME}-wal`, true],
    ] as const) {
      const source = resolve(root, name);
      const sourceInfo = await pathInfo(source);
      if (sourceInfo === null && optional) continue;
      if (sourceInfo === null || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error("Invalid database source");
      }
      const canonicalSource = await realpath(source);
      if (!isInside(root, canonicalSource) || canonicalSource !== source) {
        throw new Error("Database source escaped library");
      }
      const fingerprint = await this.hashFile(source);
      if (optional && fingerprint.size === 0) continue;
      snapshot.set(name, fingerprint);
    }
    return snapshot;
  }

  #logicalDatabaseSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
    const logical: SourceSnapshot = new Map();
    const database = snapshot.get(DATABASE_NAME);
    if (database === undefined) throw new Error("Backup database fingerprint is missing");
    logical.set(DATABASE_NAME, database);
    const wal = snapshot.get(`${DATABASE_NAME}-wal`);
    if (wal !== undefined && wal.size > 0) logical.set(`${DATABASE_NAME}-wal`, wal);
    return logical;
  }

  #sameSnapshot(left: SourceSnapshot, right: SourceSnapshot): boolean {
    if (left.size !== right.size) return false;
    for (const [name, fingerprint] of left) {
      const candidate = right.get(name);
      if (
        candidate === undefined ||
        candidate.size !== fingerprint.size ||
        candidate.sha256 !== fingerprint.sha256
      ) {
        return false;
      }
    }
    return true;
  }

  async #writeAndVerifyAssetManifest(root: string, backup: string): Promise<void> {
    const assetRoot = resolve(root, ASSETS_DIRECTORY_NAME);
    const assetInfo = await pathInfo(assetRoot);
    const entries = assetInfo === null ? [] : await this.#collectAssets(root, assetRoot);
    const manifest = `${JSON.stringify({ version: 1, assets: entries }, null, 2)}\n`;
    if (Buffer.byteLength(manifest) > MAX_ASSET_MANIFEST_BYTES) {
      throw new Error("Asset manifest is too large");
    }

    const manifestPath = resolve(backup, ASSET_MANIFEST_NAME);
    await writeFile(manifestPath, manifest, { encoding: "utf8", flag: "wx" });
    const copiedManifest = await readFile(manifestPath, "utf8");
    if (copiedManifest !== manifest) throw new Error("Asset manifest verification failed");
    for (const entry of entries) {
      const source = resolve(assetRoot, ...entry.relativePath.split("/"));
      const fingerprint = await this.hashFile(source);
      if (fingerprint.size !== entry.size || fingerprint.sha256 !== entry.sha256) {
        throw new Error("Asset changed while creating its manifest");
      }
    }
  }

  async #collectAssets(root: string, assetRoot: string): Promise<AssetManifestEntry[]> {
    const canonicalAssetRoot = await realpath(assetRoot);
    if (!isInside(root, canonicalAssetRoot) || canonicalAssetRoot !== assetRoot) {
      throw new Error("Asset root escaped library");
    }

    const files: Array<{ path: string; relativePath: string; size: number }> = [];
    const directories: Array<{ path: string; depth: number }> = [{ path: assetRoot, depth: 0 }];
    let directoryCount = 1;
    let entryCount = 0;
    let totalBytes = 0;
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) break;
      const handle = await opendir(directory.path);
      for await (const child of handle) {
        entryCount += 1;
        if (entryCount > MAX_ASSET_DIRECTORY_ENTRIES) {
          throw new Error("Asset directory entry bound exceeded");
        }
        const path = resolve(directory.path, child.name);
        if (!isInside(assetRoot, path) || child.isSymbolicLink()) {
          throw new Error("Asset path escaped asset root");
        }
        const relativePath = relative(assetRoot, path).split(sep).join("/");
        if (
          relativePath.length === 0 ||
          Buffer.byteLength(relativePath, "utf8") > MAX_ASSET_RELATIVE_PATH_BYTES
        ) {
          throw new Error("Invalid asset relative path");
        }
        if (child.isDirectory()) {
          const childDepth = directory.depth + 1;
          directoryCount += 1;
          if (directoryCount > MAX_ASSET_DIRECTORIES || childDepth > MAX_ASSET_DEPTH) {
            throw new Error("Asset directory bound exceeded");
          }
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("Invalid asset directory");
          }
          directories.push({ path, depth: childDepth });
          continue;
        }
        if (!child.isFile()) throw new Error("Unsupported entry in asset root");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)) {
          throw new Error("Invalid asset file");
        }
        totalBytes += info.size;
        if (
          files.length >= MAX_ASSET_FILES ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_ASSET_TOTAL_BYTES
        ) {
          throw new Error("Asset manifest bounds exceeded");
        }
        files.push({ path, relativePath, size: info.size });
      }
    }

    files.sort((left, right) => compareAssetRelativePaths(left.relativePath, right.relativePath));
    const entries: AssetManifestEntry[] = [];
    for (const file of files) {
      const fingerprint = await this.hashFile(file.path);
      if (fingerprint.size !== file.size) throw new Error("Asset changed while hashing");
      entries.push({
        relativePath: file.relativePath,
        size: fingerprint.size,
        sha256: fingerprint.sha256,
      });
    }
    return entries;
  }

  #tryReopen(databasePath: string): LibraryDatabase | null {
    try {
      return LibraryDatabase.open(databasePath);
    } catch {
      return null;
    }
  }
}
