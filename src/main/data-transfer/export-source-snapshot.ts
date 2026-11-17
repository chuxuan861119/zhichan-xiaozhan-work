import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { backup } from "node:sqlite";
import { z } from "zod";
import {
  MAX_TEXT_POLISH_HISTORY_JSON_BYTES,
  stripTextPolishReasoning,
  textPolishHistoryPathPattern,
  validateTextPolishHistoryEntry,
} from "../../shared/data-transfer/text-polish-history.js";
import { DRAWING_TILES_MEDIA_TYPE } from "../../shared/drawing-markup/tiles.js";
import { DraftSummarySchema } from "../../shared/ipc/contract.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  EDITABLE_CAD_PATENT_FORMAT_VERSION,
  TILED_PATENT_FORMAT_VERSION,
  UNIFIED_CAD_PATENT_FORMAT_VERSION,
} from "../../shared/patent/model.js";
import type { FileService } from "../documents/file-service.js";
import type { DraftService } from "../drafts/draft-service.js";
import { LibraryDatabase } from "../library/library-database.js";
import { CURRENT_SCHEMA_VERSION, validateCurrentSchema } from "../library/schema.js";

const DATABASE_LOGICAL_PATH = "library/library.sqlite3";
const DATABASE_FILE_NAME = "library.sqlite3";
const ASSET_DIRECTORY_NAME = "assets";
const DRAFT_DIRECTORY_NAME = "drafts";
const OWNER_MARKER_NAME = ".export-source-owner";
const CLEANUP_QUARANTINE_PREFIX = ".export-source-cleanup-";
const MAX_CLEANUP_QUARANTINE_ATTEMPTS = 16;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_DRAFT_METADATA_BYTES = 64 * 1024;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const WINDOWS_PROBE_TIMEOUT_MS = 2_000;
const ASSET_FILE_PATTERN = /^[0-9A-F]{64}\.asset$/u;
const ASSET_TEMP_PATTERN =
  /^[0-9A-F]{64}\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PATDOC_FILE_PATTERN = /^[0-9]{8}-[0-9]{6}\.patdoc$/u;
const WINDOWS_ATTRIBUTE_SCRIPT = Buffer.from(
  [
    "$ErrorActionPreference='Stop'",
    "while(($l=[Console]::In.ReadLine()) -ne $null){",
    "  try{",
    "    $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l))",
    "    $a=[int64][IO.File]::GetAttributes($p)",
    "    [Console]::Out.WriteLine($a)",
    "  }catch{[Console]::Out.WriteLine('ERR')}",
    "  [Console]::Out.Flush()",
    "}",
  ].join("\n"),
  "utf16le",
).toString("base64");

const DraftMetadataSchema = DraftSummarySchema.extend({
  fileName: z.string().regex(PATDOC_FILE_PATTERN),
}).strict();

export type ExportSourceSnapshotEntryKind =
  | "database"
  | "asset"
  | "legacy-draft"
  | "text-polish-history";

export type ExportSourceSnapshotEntry = Readonly<{
  logicalPath: string;
  kind: ExportSourceSnapshotEntryKind;
  size: number;
  hash: string;
  sourcePath: string;
}>;

export type ExportSourceSnapshotSummary = Readonly<{
  canonicalPatentFormatVersion?: 12 | 13 | 14 | 15;
  taskDirectory: string;
  cutoffAt: string;
  database: ExportSourceSnapshotEntry;
  assetCount: number;
  draftCount: number;
  totalBytes: number;
  entries: readonly ExportSourceSnapshotEntry[];
}>;

export type ExportSourceSnapshotRequest = Readonly<{
  database: LibraryDatabase;
  libraryRoot: string;
  userDataRoot: string;
  workRoot: string;
  draftService: Pick<DraftService, "waitForIdle">;
  fileService: Pick<FileService, "openDocument">;
  signal?: AbortSignal;
}>;

type SourceStatHook = (sourcePath: string, logicalPath: string) => Promise<void> | void;

type ExportSourceSnapshotDependencies = Readonly<{
  now?: () => Date;
  randomUUID?: () => string;
  afterSourceStat?: SourceStatHook;
  afterDatabaseBackup?: (databasePath: string) => Promise<void> | void;
  afterCleanupValidation?: (taskDirectory: string) => Promise<void> | void;
}>;

export class ExportSourceSnapshotError extends Error {
  override readonly name = "ExportSourceSnapshotError";

  constructor(
    readonly code: "SOURCE_SAVE_FAILED" | "CANCELLED",
    readonly cleanupFailed = false,
    readonly nativeCode?: "ENOSPC" | "EFBIG",
  ) {
    super(code === "CANCELLED" ? "操作已取消。" : "无法生成完整数据迁移源快照。");
    delete this.stack;
  }
}

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}>;

type OwnedTaskDirectory = Readonly<{
  path: string;
  taskId: string;
  identity: ObjectIdentity;
}>;

type ObjectIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}>;

type AssetDirectoryScan = Readonly<{
  rootIdentity: FileIdentity | undefined;
  declaredIdentities: ReadonlyMap<string, FileIdentity>;
}>;

type AssetSnapshot = Readonly<{
  entries: readonly ExportSourceSnapshotEntry[];
  initialRootIdentity: FileIdentity | undefined;
  initialDeclaredIdentities: ReadonlyMap<string, FileIdentity>;
  frozenSourceIdentities: ReadonlyMap<string, FileIdentity>;
}>;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportSourceSnapshotError("CANCELLED");
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function nativeSpaceCode(error: unknown): "ENOSPC" | "EFBIG" | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): "ENOSPC" | "EFBIG" | undefined => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate))
      return undefined;
    seen.add(candidate);
    if (candidate instanceof ExportSourceSnapshotError && candidate.nativeCode) {
      return candidate.nativeCode;
    }
    const code = nativeErrorCode(candidate);
    if (code === "ENOSPC" || code === "EFBIG") return code;
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        const found = visit(nested);
        if (found) return found;
      }
    }
    if ("cause" in candidate) return visit((candidate as { cause?: unknown }).cause);
    return undefined;
  };
  return visit(error);
}

function identity(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function objectIdentity(value: FileIdentity): ObjectIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    birthtimeNs: value.birthtimeNs,
  });
}

function sameOwnedObjectIdentity(left: ObjectIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function safeSize(size: bigint): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) !== size) {
    throw new Error("Source file size is unsupported");
  }
  return value;
}

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent !== "" &&
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

function compareSnapshotEntries(
  left: ExportSourceSnapshotEntry,
  right: ExportSourceSnapshotEntry,
): number {
  const order: Record<ExportSourceSnapshotEntryKind, number> = {
    database: 0,
    asset: 1,
    "legacy-draft": 2,
    "text-polish-history": 3,
  };
  return (
    order[left.kind] - order[right.kind] ||
    (left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0)
  );
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("Could not write snapshot file");
    offset += result.bytesWritten;
  }
}

class WindowsReparsePointProbe implements AsyncDisposable {
  readonly #child: ChildProcessWithoutNullStreams | undefined;
  readonly #lines: AsyncIterator<string> | undefined;
  #closed = false;

  constructor() {
    if (process.platform !== "win32") {
      this.#child = undefined;
      this.#lines = undefined;
      return;
    }
    this.#child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_ATTRIBUTE_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#lines = createInterface({
      input: this.#child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    })[Symbol.asyncIterator]();
  }

  async assertSafe(path: string, signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    if (!this.#child || !this.#lines) return;
    if (this.#closed) throw new Error("Windows reparse point probe is closed");
    const response = this.#lines.next();
    this.#child.stdin.write(`${Buffer.from(path, "utf8").toString("base64")}\n`, "ascii");
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Windows attribute probe timed out")),
            WINDOWS_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      checkAbort(signal);
      if (line.done || line.value === "ERR" || !/^[0-9]+$/u.test(line.value)) {
        throw new Error("Windows attribute probe failed");
      }
      const attributes = Number(line.value);
      if (
        !Number.isSafeInteger(attributes) ||
        (attributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0
      ) {
        throw new Error("Unsafe Windows reparse point");
      }
    } catch (error) {
      this.#child.kill();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#child || this.#child.exitCode !== null) return;
    this.#child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.#child?.kill();
        resolveClose();
      }, WINDOWS_PROBE_TIMEOUT_MS);
      this.#child?.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

async function assertSafeDirectory(
  directory: string,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  checkAbort(signal);
  const stats = await lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Unsafe source directory");
  await probe.assertSafe(directory, signal);
  const canonical = await realpath(directory);
  if (normalizedPath(canonical) !== normalizedPath(directory)) {
    throw new Error("Source directory is not canonical");
  }
  return identity(stats);
}

async function assertSafeEntry(
  path: string,
  entry: Dirent,
  expected: "file" | "directory",
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  checkAbort(signal);
  if (entry.isSymbolicLink()) throw new Error("Unsafe source entry");
  const stats = await lstat(path, { bigint: true });
  if (
    stats.isSymbolicLink() ||
    (expected === "file"
      ? !stats.isFile() || !entry.isFile()
      : !stats.isDirectory() || !entry.isDirectory())
  ) {
    throw new Error("Unexpected source entry type");
  }
  await probe.assertSafe(path, signal);
  return stats;
}

async function stableFileIdentity(
  path: string,
  handle: FileHandle,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  checkAbort(signal);
  const [handleStats, pathStats] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (
    !handleStats.isFile() ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !sameIdentity(identity(handleStats), identity(pathStats))
  ) {
    throw new Error("Source file identity mismatch");
  }
  await probe.assertSafe(path, signal);
  return identity(handleStats);
}

async function hashStableFile(
  path: string,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, "r");
  try {
    const initial = await stableFileIdentity(path, handle, probe, signal);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const final = await stableFileIdentity(path, handle, probe, signal);
    if (!sameIdentity(initial, final) || position !== safeSize(initial.size)) {
      throw new Error("File changed while hashing");
    }
    return { size: position, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function stableReadableFileIdentity(
  path: string,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  const handle = await open(path, "r");
  try {
    return await stableFileIdentity(path, handle, probe, signal);
  } finally {
    await handle.close();
  }
}

async function copyStableFile(
  sourcePath: string,
  targetPath: string,
  logicalPath: string,
  probe: WindowsReparsePointProbe,
  afterSourceStat: SourceStatHook,
  signal?: AbortSignal,
  validate?: () => Promise<void>,
  recordFrozenSourceIdentity?: (value: FileIdentity) => void,
  expectedInitialIdentity?: FileIdentity,
): Promise<ExportSourceSnapshotEntry> {
  const source = await open(sourcePath, "r");
  let target: FileHandle | undefined;
  try {
    const initial = await stableFileIdentity(sourcePath, source, probe, signal);
    if (expectedInitialIdentity && !sameIdentity(expectedInitialIdentity, initial)) {
      throw new Error("Source identity changed after enumeration");
    }
    await afterSourceStat(sourcePath, logicalPath);
    await validate?.();
    const afterValidation = await stableFileIdentity(sourcePath, source, probe, signal);
    if (!sameIdentity(initial, afterValidation)) throw new Error("Source changed before copying");
    target = await open(targetPath, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeAll(target, chunk);
      position += bytesRead;
    }
    await target.sync();
    await target.close();
    target = undefined;
    const final = await stableFileIdentity(sourcePath, source, probe, signal);
    if (!sameIdentity(initial, final) || position !== safeSize(initial.size)) {
      throw new Error("Source changed while copying");
    }
    recordFrozenSourceIdentity?.(final);
    const firstHash = hash.digest("hex");
    const copied = await hashStableFile(targetPath, probe, signal);
    if (copied.size !== position || copied.sha256 !== firstHash) {
      throw new Error("Snapshot copy verification failed");
    }
    return Object.freeze({
      logicalPath,
      kind: logicalPath.startsWith("library/assets/")
        ? ("asset" as const)
        : ("legacy-draft" as const),
      size: copied.size,
      hash: copied.sha256,
      sourcePath: targetPath,
    });
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function readStableMetadata(
  sourcePath: string,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<z.infer<typeof DraftMetadataSchema>> {
  const handle = await open(sourcePath, "r");
  try {
    const initial = await stableFileIdentity(sourcePath, handle, probe, signal);
    const size = safeSize(initial.size);
    if (size > MAX_DRAFT_METADATA_BYTES) throw new Error("Draft metadata is too large");
    const bytes = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(bytes, position, size - position, position);
      if (bytesRead === 0) throw new Error("Draft metadata is truncated");
      position += bytesRead;
    }
    const final = await stableFileIdentity(sourcePath, handle, probe, signal);
    if (!sameIdentity(initial, final)) throw new Error("Draft metadata changed while reading");
    return DraftMetadataSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } finally {
    await handle.close();
  }
}

async function writeFrozenJson(
  targetPath: string,
  value: unknown,
  probe: WindowsReparsePointProbe,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  checkAbort(signal);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(targetPath, "wx");
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return await hashStableFile(targetPath, probe, signal);
}

async function markerMatches(
  path: string,
  expected: Uint8Array,
  probe: WindowsReparsePointProbe,
): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const initial = await stableFileIdentity(path, handle, probe);
    if (initial.size !== BigInt(expected.byteLength)) return false;
    const actual = Buffer.alloc(expected.byteLength);
    let position = 0;
    while (position < actual.byteLength) {
      const { bytesRead } = await handle.read(
        actual,
        position,
        actual.byteLength - position,
        position,
      );
      if (bytesRead === 0) return false;
      position += bytesRead;
    }
    const final = await stableFileIdentity(path, handle, probe);
    return sameIdentity(initial, final) && actual.equals(expected);
  } finally {
    await handle.close();
  }
}

export class ExportSourceSnapshot {
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #afterSourceStat: SourceStatHook;
  readonly #afterDatabaseBackup: (databasePath: string) => Promise<void> | void;
  readonly #afterCleanupValidation: (taskDirectory: string) => Promise<void> | void;

  constructor(dependencies: ExportSourceSnapshotDependencies = {}) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUUID = dependencies.randomUUID ?? randomUUID;
    this.#afterSourceStat = dependencies.afterSourceStat ?? (() => undefined);
    this.#afterDatabaseBackup = dependencies.afterDatabaseBackup ?? (() => undefined);
    this.#afterCleanupValidation = dependencies.afterCleanupValidation ?? (() => undefined);
  }

  async create(request: ExportSourceSnapshotRequest): Promise<ExportSourceSnapshotSummary> {
    let ownedTask: OwnedTaskDirectory | undefined;
    const probe = new WindowsReparsePointProbe();
    try {
      checkAbort(request.signal);
      await assertSafeDirectory(request.workRoot, probe, request.signal);
      await assertSafeDirectory(request.libraryRoot, probe, request.signal);
      ownedTask = await this.#createTaskDirectory(request.workRoot, probe, request.signal);
      await request.draftService.waitForIdle();
      checkAbort(request.signal);

      request.database.checkpoint();
      if (!request.database.integrityCheck().ok) throw new Error("Source integrity check failed");
      if (!request.database.foreignKeyCheck().ok)
        throw new Error("Source foreign key check failed");

      const libraryTarget = join(ownedTask.path, "library");
      await mkdir(libraryTarget);
      const databasePath = join(libraryTarget, DATABASE_FILE_NAME);
      await request.database.read((database) =>
        backup(database, databasePath, {
          rate: 64,
          progress: () => checkAbort(request.signal),
        }),
      );
      await this.#afterDatabaseBackup(databasePath);
      const databaseHandle = await open(databasePath, "r+");
      try {
        await databaseHandle.sync();
      } finally {
        await databaseHandle.close();
      }

      let assetPaths: string[];
      let canonicalPatentFormatVersion: 12 | 13 | 14 | 15 = CANONICAL_PATENT_FORMAT_VERSION;
      {
        using copiedDatabase = LibraryDatabase.openReadOnly(databasePath);
        if (!copiedDatabase.integrityCheck().ok) throw new Error("Snapshot integrity check failed");
        if (!copiedDatabase.foreignKeyCheck().ok) {
          throw new Error("Snapshot foreign key check failed");
        }
        if (copiedDatabase.schemaVersion() !== CURRENT_SCHEMA_VERSION) {
          throw new Error("Snapshot schema version mismatch");
        }
        if (!copiedDatabase.read((database) => validateCurrentSchema(database)).ok) {
          throw new Error("Snapshot schema fingerprint mismatch");
        }
        // Includes resources retained only by earlier document/patent snapshots.
        if (
          copiedDatabase.read((database) =>
            database
              .prepare("SELECT 1 FROM assets WHERE mime_type = ? LIMIT 1")
              .get(DRAWING_TILES_MEDIA_TYPE),
          )
        )
          canonicalPatentFormatVersion = TILED_PATENT_FORMAT_VERSION;
        // Current edit logs and retained snapshots can require a newer reader even
        // after the user removes the last CAD drawing from the current patent.
        const unifiedKeys = [
          "unified",
          "objects",
          "overlayAssetId",
          "backgroundSize",
          "semanticKey",
        ];
        const unified = (value: string, path: string) =>
          unifiedKeys
            .map((key) => `json_type(${value}, '${path}.${key}') IS NOT NULL`)
            .join(" OR ");
        // model_version describes the journal envelope, not the patent format.
        // Inspect the actual current figure state, journal payload and recovery models.
        const modelVersion = copiedDatabase.read((database) =>
          database
            .prepare(`
          WITH raw(state) AS (
            SELECT CAST(payload AS TEXT) FROM snapshots UNION ALL
            SELECT CAST(payload AS TEXT) FROM edit_log UNION ALL
            SELECT CAST(value AS TEXT) FROM library_state WHERE key LIKE 'patent:%:figure-state'
          ), states(state) AS (SELECT CASE WHEN json_valid(state) THEN state ELSE '{}' END FROM raw)
          SELECT MAX(MAX(12, COALESCE(json_extract(state, '$.patent.formatVersion'), json_extract(state, '$.formatVersion'), 12),
            COALESCE((SELECT MAX(CASE
              WHEN ${unified("project.value", "$.cad")} OR EXISTS(
                SELECT 1 FROM json_each(project.value, '$.detailViews') detail WHERE ${unified("detail.value", "$.cadSource")}
              ) THEN 15
              WHEN json_type(project.value, '$.cad') IS NOT NULL OR EXISTS(
                SELECT 1 FROM json_each(project.value, '$.detailViews') detail WHERE json_type(detail.value,'$.cadSource') IS NOT NULL
              ) THEN 14 ELSE 12 END)
              FROM json_each(COALESCE(json_extract(state, '$.patent.drawingProjects'), json_extract(state, '$.drawingProjects'), '[]')) project
              WHERE project.type = 'object'),12)
          )) AS version FROM states
        `)
            .get(),
        ) as { version: number | null };
        if (
          modelVersion.version !== null &&
          modelVersion.version > UNIFIED_CAD_PATENT_FORMAT_VERSION
        )
          throw new Error("Snapshot patent model version is newer than this application");
        if (modelVersion.version === UNIFIED_CAD_PATENT_FORMAT_VERSION)
          canonicalPatentFormatVersion = UNIFIED_CAD_PATENT_FORMAT_VERSION;
        else if (modelVersion.version === EDITABLE_CAD_PATENT_FORMAT_VERSION)
          canonicalPatentFormatVersion = EDITABLE_CAD_PATENT_FORMAT_VERSION;
        assetPaths = copiedDatabase.read((database) =>
          (
            database
              .prepare("SELECT relative_path FROM assets ORDER BY relative_path")
              .all() as Array<{ relative_path: unknown }>
          ).map((row) => {
            if (
              typeof row.relative_path !== "string" ||
              !ASSET_FILE_PATTERN.test(row.relative_path)
            ) {
              throw new Error("Invalid encrypted asset path");
            }
            return row.relative_path;
          }),
        );
      }
      await this.#removeSnapshotSqliteSidecar(`${databasePath}-wal`, probe, request.signal);
      await this.#removeSnapshotSqliteSidecar(`${databasePath}-shm`, probe, request.signal);

      const databaseHash = await hashStableFile(databasePath, probe, request.signal);
      const databaseEntry: ExportSourceSnapshotEntry = Object.freeze({
        logicalPath: DATABASE_LOGICAL_PATH,
        kind: "database",
        size: databaseHash.size,
        hash: databaseHash.sha256,
        sourcePath: databasePath,
      });
      const assetSnapshot = await this.#snapshotAssets(
        request.libraryRoot,
        ownedTask.path,
        assetPaths,
        probe,
        request.signal,
      );
      const draftEntries = await this.#snapshotDrafts(request, ownedTask.path, probe);
      const polishEntries = await this.#snapshotPolishHistory(request, ownedTask.path, probe);
      await this.#verifyFrozenAssets(
        request.libraryRoot,
        assetPaths,
        assetSnapshot,
        probe,
        request.signal,
      );
      const entries = Object.freeze(
        [databaseEntry, ...assetSnapshot.entries, ...draftEntries, ...polishEntries].sort(
          compareSnapshotEntries,
        ),
      );
      // The cutoff is the instant every database/resource/draft entry has been frozen and
      // independently re-hashed inside the owned task directory.
      const cutoffAt = this.#now().toISOString();
      const totalBytes = entries.reduce((total, entry) => {
        const next = total + entry.size;
        if (!Number.isSafeInteger(next)) throw new Error("Snapshot total size is unsupported");
        return next;
      }, 0);
      return Object.freeze({
        canonicalPatentFormatVersion,
        taskDirectory: ownedTask.path,
        cutoffAt,
        database: databaseEntry,
        assetCount: assetSnapshot.entries.length,
        draftCount: draftEntries.length / 2,
        totalBytes,
        entries,
      });
    } catch (error) {
      const cleanupFailed = ownedTask
        ? !(await this.#removeOwnedTaskDirectory(ownedTask, probe).catch(() => false))
        : false;
      const code =
        (error instanceof ExportSourceSnapshotError && error.code === "CANCELLED") ||
        request.signal?.aborted
          ? "CANCELLED"
          : "SOURCE_SAVE_FAILED";
      throw new ExportSourceSnapshotError(code, cleanupFailed, nativeSpaceCode(error));
    } finally {
      await probe.close().catch(() => undefined);
    }
  }

  async #createTaskDirectory(
    workRoot: string,
    probe: WindowsReparsePointProbe,
    signal?: AbortSignal,
  ): Promise<OwnedTaskDirectory> {
    checkAbort(signal);
    const taskId = this.#randomUUID();
    if (!UUID_DIRECTORY_PATTERN.test(taskId)) throw new Error("Invalid snapshot task UUID");
    const path = join(resolve(workRoot), taskId);
    if (!isInside(workRoot, path)) throw new Error("Snapshot task path escapes work root");
    await mkdir(path);
    const taskIdentity = objectIdentity(await assertSafeDirectory(path, probe, signal));
    const marker = await open(join(path, OWNER_MARKER_NAME), "wx");
    try {
      await writeAll(marker, Buffer.from(`${taskId}\n`, "utf8"));
      await marker.sync();
    } finally {
      await marker.close();
    }
    return Object.freeze({ path, taskId, identity: taskIdentity });
  }

  async #removeSnapshotSqliteSidecar(
    path: string,
    probe: WindowsReparsePointProbe,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    try {
      const stats = await lstat(path, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Unsafe snapshot SQLite sidecar");
      }
      await probe.assertSafe(path, signal);
      await unlink(path);
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") throw error;
    }
  }

  async #removeOwnedTaskDirectory(
    owned: OwnedTaskDirectory,
    probe: WindowsReparsePointProbe,
  ): Promise<boolean> {
    const stats = await lstat(owned.path, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !sameOwnedObjectIdentity(owned.identity, identity(stats))
    ) {
      return false;
    }
    await probe.assertSafe(owned.path);
    const markerPath = join(owned.path, OWNER_MARKER_NAME);
    const expectedMarker = Buffer.from(`${owned.taskId}\n`, "utf8");
    if (!(await markerMatches(markerPath, expectedMarker, probe))) return false;
    await this.#afterCleanupValidation(owned.path);
    const quarantinePath = await this.#isolateForCleanup(owned.path);
    const quarantineStats = await lstat(quarantinePath, { bigint: true });
    if (
      !quarantineStats.isDirectory() ||
      quarantineStats.isSymbolicLink() ||
      !sameOwnedObjectIdentity(owned.identity, identity(quarantineStats))
    ) {
      await this.#restoreQuarantinedDirectory(quarantinePath, owned.path);
      return false;
    }
    await probe.assertSafe(quarantinePath);
    if (!(await markerMatches(join(quarantinePath, OWNER_MARKER_NAME), expectedMarker, probe))) {
      await this.#restoreQuarantinedDirectory(quarantinePath, owned.path);
      return false;
    }
    const finalStats = await lstat(quarantinePath, { bigint: true });
    if (
      !finalStats.isDirectory() ||
      finalStats.isSymbolicLink() ||
      !sameOwnedObjectIdentity(owned.identity, identity(finalStats))
    ) {
      await this.#restoreQuarantinedDirectory(quarantinePath, owned.path);
      return false;
    }
    await probe.assertSafe(quarantinePath);
    await rm(quarantinePath, { recursive: true, force: false });
    return true;
  }

  async #isolateForCleanup(taskDirectory: string): Promise<string> {
    const workRoot = dirname(taskDirectory);
    for (let attempt = 0; attempt < MAX_CLEANUP_QUARANTINE_ATTEMPTS; attempt += 1) {
      const quarantinePath = join(workRoot, `${CLEANUP_QUARANTINE_PREFIX}${randomUUID()}`);
      try {
        await lstat(quarantinePath);
        continue;
      } catch (error) {
        if (nativeErrorCode(error) !== "ENOENT") throw error;
      }
      try {
        await rename(taskDirectory, quarantinePath);
        return quarantinePath;
      } catch (error) {
        try {
          await lstat(quarantinePath);
          continue;
        } catch (targetError) {
          if (nativeErrorCode(targetError) !== "ENOENT") throw targetError;
        }
        throw error;
      }
    }
    throw new Error("Could not isolate snapshot cleanup directory");
  }

  async #restoreQuarantinedDirectory(quarantinePath: string, taskDirectory: string): Promise<void> {
    try {
      await lstat(taskDirectory);
      return;
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") return;
    }
    await rename(quarantinePath, taskDirectory).catch(() => undefined);
  }

  async #snapshotAssets(
    libraryRoot: string,
    taskDirectory: string,
    declaredPaths: readonly string[],
    probe: WindowsReparsePointProbe,
    signal?: AbortSignal,
  ): Promise<AssetSnapshot> {
    const assetRoot = join(resolve(libraryRoot), ASSET_DIRECTORY_NAME);
    const initialScan = await this.#scanAssetDirectory(assetRoot, declaredPaths, probe, signal);
    if (declaredPaths.length === 0) {
      return Object.freeze({
        entries: Object.freeze([]),
        initialRootIdentity: initialScan.rootIdentity,
        initialDeclaredIdentities: initialScan.declaredIdentities,
        frozenSourceIdentities: new Map(),
      });
    }
    const targetRoot = join(taskDirectory, "library", ASSET_DIRECTORY_NAME);
    await mkdir(targetRoot);
    const snapshots: ExportSourceSnapshotEntry[] = [];
    const frozenSourceIdentities = new Map<string, FileIdentity>();
    for (const assetPath of declaredPaths) {
      checkAbort(signal);
      const initialIdentity = initialScan.declaredIdentities.get(assetPath);
      if (!initialIdentity) throw new Error("Initial asset identity is missing");
      const logicalPath = `library/assets/${assetPath}`;
      snapshots.push(
        await copyStableFile(
          join(assetRoot, assetPath),
          join(targetRoot, assetPath),
          logicalPath,
          probe,
          this.#afterSourceStat,
          signal,
          undefined,
          (value) => frozenSourceIdentities.set(assetPath, value),
          initialIdentity,
        ),
      );
    }
    return Object.freeze({
      entries: Object.freeze(snapshots),
      initialRootIdentity: initialScan.rootIdentity,
      initialDeclaredIdentities: initialScan.declaredIdentities,
      frozenSourceIdentities,
    });
  }

  async #scanAssetDirectory(
    assetRoot: string,
    declaredPaths: readonly string[],
    probe: WindowsReparsePointProbe,
    signal?: AbortSignal,
  ): Promise<AssetDirectoryScan> {
    let rootIdentity: FileIdentity;
    let entries: Dirent[];
    try {
      rootIdentity = await assertSafeDirectory(assetRoot, probe, signal);
      entries = await readdir(assetRoot, { withFileTypes: true });
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT" && declaredPaths.length === 0) {
        return Object.freeze({ rootIdentity: undefined, declaredIdentities: new Map() });
      }
      throw error;
    }
    const declared = new Set(declaredPaths);
    const declaredIdentities = new Map<string, FileIdentity>();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = join(assetRoot, entry.name);
      const stats = await assertSafeEntry(sourcePath, entry, "file", probe, signal);
      if (ASSET_TEMP_PATTERN.test(entry.name)) continue;
      if (!declared.has(entry.name)) throw new Error("Undeclared asset file");
      if (!stats.isFile()) throw new Error("Unexpected asset entry type");
      declaredIdentities.set(
        entry.name,
        await stableReadableFileIdentity(sourcePath, probe, signal),
      );
    }
    if (
      declaredIdentities.size !== declared.size ||
      declaredPaths.some((path) => !declaredIdentities.has(path))
    ) {
      throw new Error("Declared asset is missing");
    }
    const finalRootIdentity = await assertSafeDirectory(assetRoot, probe, signal);
    if (!sameIdentity(rootIdentity, finalRootIdentity)) {
      throw new Error("Asset directory changed while enumerating");
    }
    return Object.freeze({ rootIdentity, declaredIdentities });
  }

  async #verifyFrozenAssets(
    libraryRoot: string,
    declaredPaths: readonly string[],
    snapshot: AssetSnapshot,
    probe: WindowsReparsePointProbe,
    signal?: AbortSignal,
  ): Promise<void> {
    const finalScan = await this.#scanAssetDirectory(
      join(resolve(libraryRoot), ASSET_DIRECTORY_NAME),
      declaredPaths,
      probe,
      signal,
    );
    if (
      snapshot.initialRootIdentity === undefined || finalScan.rootIdentity === undefined
        ? snapshot.initialRootIdentity !== finalScan.rootIdentity
        : !sameObjectIdentity(snapshot.initialRootIdentity, finalScan.rootIdentity)
    ) {
      throw new Error("Asset directory identity changed");
    }
    const declared = new Set(declaredPaths);
    for (const identities of [
      snapshot.initialDeclaredIdentities,
      snapshot.frozenSourceIdentities,
      finalScan.declaredIdentities,
    ]) {
      if (
        identities.size !== declared.size ||
        declaredPaths.some((assetPath) => !identities.has(assetPath))
      ) {
        throw new Error("Asset identity set changed");
      }
    }
    for (const assetPath of declaredPaths) {
      const initialIdentity = snapshot.initialDeclaredIdentities.get(assetPath);
      const frozenIdentity = snapshot.frozenSourceIdentities.get(assetPath);
      const finalIdentity = finalScan.declaredIdentities.get(assetPath);
      if (
        !initialIdentity ||
        !frozenIdentity ||
        !finalIdentity ||
        !sameIdentity(initialIdentity, frozenIdentity) ||
        !sameIdentity(initialIdentity, finalIdentity) ||
        !sameIdentity(frozenIdentity, finalIdentity)
      ) {
        throw new Error("Frozen asset identity changed");
      }
    }
  }

  async #snapshotPolishHistory(
    request: ExportSourceSnapshotRequest,
    taskDirectory: string,
    probe: WindowsReparsePointProbe,
  ): Promise<ExportSourceSnapshotEntry[]> {
    const root = join(resolve(request.userDataRoot), "text-polish-history");
    let directories: Dirent[];
    try {
      await assertSafeDirectory(root, probe, request.signal);
      directories = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") return [];
      throw error;
    }
    const entries: ExportSourceSnapshotEntry[] = [];
    for (const directory of directories) {
      if (!UUID_DIRECTORY_PATTERN.test(directory.name))
        throw new Error("Invalid polish history directory");
      const sourceDirectory = join(root, directory.name);
      const directoryIdentity = await assertSafeEntry(
        sourceDirectory,
        directory,
        "directory",
        probe,
        request.signal,
      );
      const children = await readdir(sourceDirectory, { withFileTypes: true });
      for (const child of children) {
        const logicalPath = `text-polish-history/${directory.name}/${child.name}`;
        if (!textPolishHistoryPathPattern.test(logicalPath))
          throw new Error("Invalid polish history file");
        const source = join(sourceDirectory, child.name);
        await assertSafeEntry(source, child, "file", probe, request.signal);
        const target = join(taskDirectory, ...logicalPath.split("/"));
        await mkdir(dirname(target), { recursive: true });
        let copied = await copyStableFile(
          source,
          target,
          logicalPath,
          probe,
          this.#afterSourceStat,
          request.signal,
        );
        if (!logicalPath.includes(".unreadable-")) {
          if (copied.size > MAX_TEXT_POLISH_HISTORY_JSON_BYTES)
            throw new Error("Polish history JSON exceeds size limit");
          validateTextPolishHistoryEntry(logicalPath, await readFile(target));
        }
        const bytes = await readFile(target);
        const stripped = stripTextPolishReasoning(bytes);
        if (stripped !== bytes) {
          await writeFile(target, stripped);
          copied = {
            ...copied,
            size: stripped.byteLength,
            hash: createHash("sha256").update(stripped).digest("hex"),
          };
        }
        entries.push(Object.freeze({ ...copied, kind: "text-polish-history" }));
      }
      if (
        !sameIdentity(
          identity(directoryIdentity),
          await assertSafeDirectory(sourceDirectory, probe, request.signal),
        )
      )
        throw new Error("Polish history changed during snapshot");
    }
    return entries;
  }

  async #snapshotDrafts(
    request: ExportSourceSnapshotRequest,
    taskDirectory: string,
    probe: WindowsReparsePointProbe,
  ): Promise<ExportSourceSnapshotEntry[]> {
    const draftRoot = join(resolve(request.userDataRoot), DRAFT_DIRECTORY_NAME);
    let draftDirectories: Dirent[];
    try {
      await assertSafeDirectory(draftRoot, probe, request.signal);
      draftDirectories = await readdir(draftRoot, { withFileTypes: true });
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") return [];
      throw error;
    }
    const snapshots: ExportSourceSnapshotEntry[] = [];
    const targetRoot = join(taskDirectory, "legacy-drafts");
    if (draftDirectories.length > 0) await mkdir(targetRoot);
    for (const directory of draftDirectories.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!UUID_DIRECTORY_PATTERN.test(directory.name)) throw new Error("Invalid draft directory");
      const sourceDirectory = join(draftRoot, directory.name);
      await assertSafeEntry(sourceDirectory, directory, "directory", probe, request.signal);
      const children = await readdir(sourceDirectory, { withFileTypes: true });
      const names = children.map((entry) => entry.name).sort();
      const patdocs = names.filter((name) => PATDOC_FILE_PATTERN.test(name));
      if (patdocs.length !== 1 || names.length !== 2 || !names.includes("draft.json")) {
        throw new Error("Invalid draft directory structure");
      }
      for (const child of children) {
        await assertSafeEntry(
          join(sourceDirectory, child.name),
          child,
          "file",
          probe,
          request.signal,
        );
      }
      const metadataPath = join(sourceDirectory, "draft.json");
      const metadata = await readStableMetadata(metadataPath, probe, request.signal);
      if (
        metadata.draftId !== directory.name ||
        metadata.documentId !== directory.name ||
        metadata.fileName !== patdocs[0]
      ) {
        throw new Error("Draft metadata does not match its directory");
      }
      const targetDirectory = join(targetRoot, directory.name);
      await mkdir(targetDirectory);
      const portableMetadata = { ...metadata, originalPath: null };
      const targetMetadataPath = join(targetDirectory, "draft.json");
      const metadataHash = await writeFrozenJson(
        targetMetadataPath,
        portableMetadata,
        probe,
        request.signal,
      );
      snapshots.push(
        Object.freeze({
          logicalPath: `legacy-drafts/${directory.name}/draft.json`,
          kind: "legacy-draft" as const,
          size: metadataHash.size,
          hash: metadataHash.sha256,
          sourcePath: targetMetadataPath,
        }),
      );
      const patdocName = patdocs[0];
      if (!patdocName) throw new Error("Draft PATDOC is missing");
      const sourcePatdocPath = join(sourceDirectory, patdocName);
      snapshots.push(
        await copyStableFile(
          sourcePatdocPath,
          join(targetDirectory, patdocName),
          `legacy-drafts/${directory.name}/${patdocName}`,
          probe,
          this.#afterSourceStat,
          request.signal,
          async () => {
            const opened = await request.fileService.openDocument(sourcePatdocPath);
            if (!opened.ok) throw new Error("Draft PATDOC validation failed");
            const value = opened.value as unknown as {
              document?: { documentId?: unknown };
              patent?: { patentId?: unknown };
            };
            const documentId = value.document?.documentId ?? value.patent?.patentId;
            if (documentId !== directory.name) {
              throw new Error("Draft PATDOC validation failed");
            }
          },
        ),
      );
    }
    return snapshots;
  }
}
