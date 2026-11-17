import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { removeOwnedPath } from "./owned-path-cleanup.js";

export const DATA_IMPORT_JOURNAL_FILE_NAME = "pending-data-import.json";
const QUARANTINED_JOURNAL_PREFIX = `${DATA_IMPORT_JOURNAL_FILE_NAME}.failed-`;

/** Unknown recovery bytes protect candidates until recovery is actually resolved. */
export async function hasUnresolvedDataImport(applicationDataRoot: string): Promise<boolean> {
  const entries = await readdir(applicationDataRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.some(
    (name) => name === DATA_IMPORT_JOURNAL_FILE_NAME || name.startsWith(QUARANTINED_JOURNAL_PREFIX),
  );
}
const DATA_IMPORT_JOURNAL_MAX_BYTES = 256 * 1024;
const IMPORT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_IN_NAME_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const IMPORT_JOURNAL_LOCK_FILE_NAME = "data-import-journal.lock";
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const REPARSE_PROBE_TIMEOUT_MS = 2_000;

export const DATA_IMPORT_JOURNAL_PHASES = Object.freeze([
  "prepared",
  "old-library-moved",
  "new-library-installed",
  "drafts-installed",
  "settings-installed",
  "restart-validation-pending",
  "committed",
  "rolled-back",
] as const);

export type DataImportJournalPhase = (typeof DATA_IMPORT_JOURNAL_PHASES)[number];

const PhaseSchema = z.enum(DATA_IMPORT_JOURNAL_PHASES);
const UuidSchema = z.string().regex(IMPORT_UUID_PATTERN);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const PackageSummarySchema = z
  .object({
    packageId: UuidSchema,
    packageFormatVersion: z.literal(2),
    payloadSha256: Sha256Schema,
    totalOriginalBytes: z.number().int().nonnegative().safe(),
    exportedAt: z.string().datetime(),
  })
  .strict();

const PathIdentitySchema = z
  .object({
    device: z.string().min(1),
    inode: z.string().min(1),
    birthtimeNs: z.string().min(1),
    size: z.string().min(1),
    mtimeNs: z.string().min(1),
    ctimeNs: z.string().min(1),
  })
  .strict();

const PathIdentitiesSchema = z
  .object({
    stagingRoot: PathIdentitySchema.optional(),
    stagingLibrary: PathIdentitySchema.optional(),
    library: PathIdentitySchema.optional(),
    stagingDraftsRoot: PathIdentitySchema.optional(),
    stagingDrafts: PathIdentitySchema.optional(),
    drafts: PathIdentitySchema.optional(),
    settingsCandidate: PathIdentitySchema.optional(),
    settings: PathIdentitySchema.optional(),
    manifest: PathIdentitySchema.optional(),
    rollbackLibrary: PathIdentitySchema.optional(),
    rollbackDrafts: PathIdentitySchema.optional(),
    rollbackSettings: PathIdentitySchema.optional(),
  })
  .strict();

export type DataImportJournalPathIdentity = z.infer<typeof PathIdentitySchema>;
export type DataImportJournalPathIdentities = z.infer<typeof PathIdentitiesSchema>;

const PolishHistorySwapSchema = z
  .object({
    stagingPath: z.string().min(1),
    livePath: z.string().min(1),
    rollbackPath: z.string().min(1),
    stagingIdentity: PathIdentitySchema,
    liveIdentity: PathIdentitySchema,
  })
  .strict();

/**
 * Paths that are safe to persist in the recovery journal. The fixed live
 * library/drafts/settings paths are intentionally included alongside the
 * UUID-owned staging and rollback paths so a restart can reconstruct the
 * exact rename sequence.
 */
export type DataImportJournalRecord = Readonly<{
  version: 1;
  operationId: string;
  phase: DataImportJournalPhase;
  createdAt: string;
  stagingPath: string;
  libraryPath: string;
  rollbackLibraryPath: string;
  stagingDraftsPath: string;
  draftsPath: string;
  rollbackDraftsPath: string;
  settingsCandidatePath: string;
  settingsPath: string;
  rollbackSettingsPath: string;
  polishHistory?: z.infer<typeof PolishHistorySwapSchema>;
  /** SHA-256 of the merged settings candidate captured before the swap. */
  settingsContentSha256?: string;
  /** Stable post-recovery database content captured before the swap. */
  databaseContentSha256?: string;
  databaseByteLength?: number;
  manifestPath?: string;
  pathIdentities?: DataImportJournalPathIdentities;
  packageSummary: Readonly<{
    packageId: string;
    packageFormatVersion: 2;
    payloadSha256: string;
    totalOriginalBytes: number;
    exportedAt: string;
  }>;
}>;

/**
 * The aliases keep the journal usable by the import preparation service,
 * whose vocabulary calls the same roots "stagingLibrary"/"libraryRollback".
 * The persisted representation is always the canonical shape above.
 */
export type DataImportJournalRecordInput = Omit<
  DataImportJournalRecord,
  | "version"
  | "stagingPath"
  | "rollbackLibraryPath"
  | "stagingDraftsPath"
  | "rollbackDraftsPath"
  | "rollbackSettingsPath"
> &
  Readonly<{
    version?: 1;
    stagingPath?: string;
    stagingLibraryPath?: string;
    rollbackLibraryPath?: string;
    libraryRollbackPath?: string;
    stagingDraftsPath?: string;
    draftsStagingPath?: string;
    rollbackDraftsPath?: string;
    draftsRollbackPath?: string;
    rollbackSettingsPath?: string;
    settingsRollbackPath?: string;
  }>;

const PersistedRecordSchema = z
  .object({
    version: z.literal(1),
    operationId: UuidSchema,
    phase: PhaseSchema,
    createdAt: z.string().datetime(),
    stagingPath: z.string().min(1),
    libraryPath: z.string().min(1),
    rollbackLibraryPath: z.string().min(1),
    stagingDraftsPath: z.string().min(1),
    draftsPath: z.string().min(1),
    rollbackDraftsPath: z.string().min(1),
    settingsCandidatePath: z.string().min(1),
    settingsPath: z.string().min(1),
    rollbackSettingsPath: z.string().min(1),
    polishHistory: PolishHistorySwapSchema.optional(),
    settingsContentSha256: Sha256Schema.optional(),
    databaseContentSha256: Sha256Schema.optional(),
    databaseByteLength: z.number().int().nonnegative().safe().optional(),
    manifestPath: z.string().min(1).optional(),
    pathIdentities: PathIdentitiesSchema.optional(),
    packageSummary: PackageSummarySchema,
  })
  .strict();

export class DataImportJournalError extends Error {
  override readonly name = "DataImportJournalError";
  readonly code = "IMPORT_RECOVERY_REQUIRED" as const;

  constructor(
    message = "Import recovery is required.",
    readonly fatal = true,
  ) {
    super(message);
    delete this.stack;
  }
}

type JournalFileSystem = Readonly<{
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Stats>;
  rename(source: string, target: string): Promise<void>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
}>;

const defaultFileSystem: JournalFileSystem = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  open,
  readFile,
  readdir: async (path) => await readdir(path, { encoding: "utf8" }),
  lstat,
  rename,
  realpath,
  stat,
  unlink,
};

type ReparsePointProbe = Readonly<{
  assertSafe(path: string): Promise<void>;
  close(): Promise<void>;
}>;

const noReparsePointProbe: ReparsePointProbe = Object.freeze({
  assertSafe: async () => {},
  close: async () => {},
});

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

export type DataImportJournalOptions = Readonly<{
  applicationDataRoot: string;
  libraryRoot: string;
  userDataRoot: string;
  fileSystem?: Partial<JournalFileSystem>;
  createTempId?: () => string;
  createReparsePointProbe?: () => ReparsePointProbe;
}>;

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function normalizePath(value: string): string {
  return process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isPortableAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value);
}

function isInside(parent: string, candidate: string): boolean {
  if (!isPortableAbsolute(candidate)) return false;
  const parentResolved = normalizePath(parent);
  const candidateResolved = normalizePath(candidate);
  const child = relative(parentResolved, candidateResolved);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function containsOperationId(path: string, operationId: string): boolean {
  return path
    .split(/[\\/]/u)
    .some((component) => component.toLowerCase().includes(operationId.toLowerCase()));
}

function isUuid(value: string): boolean {
  return IMPORT_UUID_PATTERN.test(value);
}

function hasUuidName(value: string, operationId: string): boolean {
  return (
    UUID_IN_NAME_PATTERN.test(basename(value)) &&
    basename(value).toLowerCase().includes(operationId.toLowerCase())
  );
}

function fixedImportRoot(root: string, prefix: string, operationId: string): string {
  return join(root, `${prefix}${operationId}`);
}

function isFixedImportPath(
  value: string,
  root: string,
  prefix: string,
  operationId: string,
  child?: string,
): boolean {
  const expectedRoot = fixedImportRoot(root, prefix, operationId);
  return samePath(value, child === undefined ? expectedRoot : join(expectedRoot, child));
}

function isFixedSettingsCandidatePath(
  value: string,
  userDataParent: string,
  operationId: string,
): boolean {
  return samePath(
    value,
    join(
      fixedImportRoot(userDataParent, ".import-user-data-", operationId),
      `settings-candidate-${operationId}.json`,
    ),
  );
}

function normalizeRecord(input: DataImportJournalRecordInput): DataImportJournalRecord {
  const stagingPath = input.stagingPath ?? input.stagingLibraryPath;
  const rollbackLibraryPath = input.rollbackLibraryPath ?? input.libraryRollbackPath;
  const stagingDraftsPath = input.stagingDraftsPath ?? input.draftsStagingPath;
  const rollbackDraftsPath = input.rollbackDraftsPath ?? input.draftsRollbackPath;
  const rollbackSettingsPath = input.rollbackSettingsPath ?? input.settingsRollbackPath;
  if (
    !stagingPath ||
    !rollbackLibraryPath ||
    !stagingDraftsPath ||
    !rollbackDraftsPath ||
    !rollbackSettingsPath
  ) {
    throw new DataImportJournalError();
  }
  return Object.freeze({
    version: 1,
    operationId: input.operationId,
    phase: input.phase,
    createdAt: input.createdAt,
    stagingPath,
    libraryPath: input.libraryPath,
    rollbackLibraryPath,
    stagingDraftsPath,
    draftsPath: input.draftsPath,
    rollbackDraftsPath,
    settingsCandidatePath: input.settingsCandidatePath,
    settingsPath: input.settingsPath,
    rollbackSettingsPath,
    ...(input.polishHistory ? { polishHistory: input.polishHistory } : {}),
    ...(input.settingsContentSha256 ? { settingsContentSha256: input.settingsContentSha256 } : {}),
    ...(input.databaseContentSha256 ? { databaseContentSha256: input.databaseContentSha256 } : {}),
    ...(input.databaseByteLength !== undefined
      ? { databaseByteLength: input.databaseByteLength }
      : {}),
    ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
    ...(input.pathIdentities ? { pathIdentities: input.pathIdentities } : {}),
    packageSummary: Object.freeze({ ...input.packageSummary }),
  });
}

function transitionAllowed(current: DataImportJournalPhase, next: DataImportJournalPhase): boolean {
  const index = DATA_IMPORT_JOURNAL_PHASES.indexOf(current);
  if (index < 0 || current === "committed" || current === "rolled-back") return false;
  if (next === "rolled-back") return true;
  return DATA_IMPORT_JOURNAL_PHASES[index + 1] === next;
}

function sanitizeFailure(
  error: unknown,
  fallback = "Import recovery is required.",
): DataImportJournalError {
  if (error instanceof DataImportJournalError) return error;
  return new DataImportJournalError(fallback);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const result = await handle.write(bytes, offset, remaining, offset);
    if (
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten <= 0 ||
      result.bytesWritten > remaining
    ) {
      throw new DataImportJournalError();
    }
    offset += result.bytesWritten;
  }
}

export class DataImportJournal {
  readonly #applicationDataRoot: string;
  readonly #libraryRoot: string;
  readonly #userDataRoot: string;
  readonly #journalPath: string;
  readonly #fileSystem: JournalFileSystem;
  readonly #createTempId: () => string;
  readonly #createReparsePointProbe: () => ReparsePointProbe;
  #queue: Promise<void> = Promise.resolve();
  #writeFailure: DataImportJournalError | undefined;

  constructor(options: DataImportJournalOptions) {
    this.#applicationDataRoot = resolve(options.applicationDataRoot);
    this.#libraryRoot = resolve(options.libraryRoot);
    this.#userDataRoot = resolve(options.userDataRoot);
    this.#journalPath = join(this.#applicationDataRoot, DATA_IMPORT_JOURNAL_FILE_NAME);
    this.#fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.#createTempId = options.createTempId ?? randomUUID;
    this.#createReparsePointProbe =
      options.createReparsePointProbe ??
      (() => (process.platform === "win32" ? new WindowsReparsePointProbe() : noReparsePointProbe));
  }

  get path(): string {
    return this.#journalPath;
  }

  async create(input: DataImportJournalRecordInput): Promise<DataImportJournalRecord> {
    return await this.#serialize(async () => {
      const record = this.#validateRecord(normalizeRecord(input));
      if (record.phase !== "prepared") {
        throw new DataImportJournalError("Invalid import journal transition", false);
      }
      await this.#assertPathAnchors(record);
      return await this.#withLock(async () => {
        await this.#assertNoTemporaryJournal(true);
        await this.#fileSystem.mkdir(this.#applicationDataRoot, { recursive: true });
        try {
          await this.#fileSystem.stat(this.#journalPath);
          throw new DataImportJournalError(undefined, false);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
        const temporaryPath = this.#temporaryPath(record.operationId);
        await this.#writeTemporary(temporaryPath, record);
        try {
          await this.#fileSystem.stat(this.#journalPath);
          throw new DataImportJournalError(undefined, false);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) {
            try {
              await this.#fileSystem.unlink(temporaryPath);
              await this.#syncDirectory(this.#applicationDataRoot);
            } catch (cleanupError) {
              throw sanitizeFailure(cleanupError);
            }
            throw error;
          }
        }
        await this.#fileSystem.rename(temporaryPath, this.#journalPath);
        await this.#syncDirectory(this.#applicationDataRoot);
        return record;
      });
    });
  }

  async advance(nextPhase: DataImportJournalPhase): Promise<DataImportJournalRecord> {
    return await this.#serialize(async () => {
      return await this.#withLock(async () => {
        const current = await this.#readUnsafe(true);
        if (!current || !transitionAllowed(current.phase, nextPhase)) {
          throw new DataImportJournalError("Invalid import journal transition", false);
        }
        return await this.#writeReplacement({ ...current, phase: nextPhase });
      });
    });
  }

  async read(): Promise<DataImportJournalRecord | undefined> {
    return await this.#serialize(async () => await this.#readUnsafe(false), {
      latchFailure: false,
    });
  }

  /** Only the startup singleton owner may retire interrupted writer artifacts. */
  async recover(
    options: { exclusiveStartup?: boolean } = {},
  ): Promise<DataImportJournalRecord | undefined> {
    if (!options.exclusiveStartup) return await this.read();
    return await this.#serialize(
      async () => {
        await this.#retireInterruptedWriter();
        const record = await this.#readUnsafe(false);
        this.#writeFailure = undefined;
        return record;
      },
      { allowAfterFailure: true, latchFailure: false },
    );
  }

  async #retireInterruptedWriter(): Promise<void> {
    const entries: string[] = await this.#fileSystem
      .readdir(this.#applicationDataRoot)
      .catch((error) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      });
    const lockPath = join(this.#applicationDataRoot, IMPORT_JOURNAL_LOCK_FILE_NAME);
    const hasLock = entries.includes(IMPORT_JOURNAL_LOCK_FILE_NAME);
    if (hasLock) {
      const info = await this.#fileSystem.lstat(lockPath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 256 ||
        !samePath(await this.#fileSystem.realpath(lockPath), lockPath)
      )
        throw new DataImportJournalError();
      const text = (await this.#fileSystem.readFile(lockPath)).toString("utf8").trim();
      if (text && !isUuid(text)) {
        const owner = z
          .object({ pid: z.number().int().positive(), token: z.uuid() })
          .strict()
          .parse(JSON.parse(text));
        try {
          process.kill(owner.pid, 0);
          throw new DataImportJournalError("Import writer is still running", false);
        } catch (error) {
          if (!isNodeError(error, "ESRCH")) throw error;
        }
      }
    }
    // Never use a partial's phase. The last atomic, validated record remains authoritative.
    const durable = await this.#readUnsafe(true, true);
    const partials = entries.filter((name) =>
      name.startsWith(`.${DATA_IMPORT_JOURNAL_FILE_NAME}.`),
    );
    for (const name of partials) {
      const fields = name.slice(DATA_IMPORT_JOURNAL_FILE_NAME.length + 2).split(".");
      if (
        fields.length !== 3 ||
        !isUuid(fields[0] ?? "") ||
        !isUuid(fields[1] ?? "") ||
        fields[2] !== "partial" ||
        (durable && fields[0]?.toLowerCase() !== durable.operationId)
      )
        throw new DataImportJournalError();
      const path = join(this.#applicationDataRoot, name);
      const info = await this.#fileSystem.lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !samePath(await this.#fileSystem.realpath(path), path)
      )
        throw new DataImportJournalError();
    }
    for (const name of [...partials, ...(hasLock ? [IMPORT_JOURNAL_LOCK_FILE_NAME] : [])]) {
      const path = join(this.#applicationDataRoot, name);
      const info = await lstat(path, { bigint: true });
      await removeOwnedPath(path, {
        device: String(info.dev),
        inode: String(info.ino),
        birthtimeNs: String(info.birthtimeNs),
      });
    }
    if (partials.length || hasLock) await this.#syncDirectory(this.#applicationDataRoot);
  }

  async clear(): Promise<void> {
    await this.#serialize(async () => {
      await this.#withLock(async () => {
        const current = await this.#readUnsafe(true);
        if (!current) return;
        try {
          await this.#fileSystem.unlink(this.#journalPath);
          await this.#syncDirectory(this.#applicationDataRoot);
        } catch (error) {
          throw sanitizeFailure(error);
        }
      });
    });
  }

  /**
   * 将 journal 重命名到隔离路径（保留内容、不删除），后续启动仍保护未解决任务。
   * 返回隔离路径；无 journal 时返回 undefined。
   *
   * 用于明确失败的 journal（损坏、或锚定到其他实例上下文无法安全解析），
   * 隔离文件仍代表未解决的恢复任务，不能因为记录被移走就恢复写入或删除候选数据。
   */
  async quarantine(): Promise<string | undefined> {
    return await this.#serialize(
      async () => {
        return await this.#withLock(async () => {
          let metadata: Stats;
          try {
            metadata = await this.#fileSystem.stat(this.#journalPath);
          } catch (error) {
            if (isNodeError(error, "ENOENT")) return undefined;
            throw sanitizeFailure(error);
          }
          if (!metadata.isFile()) return undefined;
          const quarantinePath = join(
            this.#applicationDataRoot,
            `${DATA_IMPORT_JOURNAL_FILE_NAME}.failed-${randomUUID()}`,
          );
          try {
            await this.#fileSystem.rename(this.#journalPath, quarantinePath);
            await this.#syncDirectory(this.#applicationDataRoot);
          } catch (error) {
            throw sanitizeFailure(error);
          }
          return quarantinePath;
        });
      },
      { allowAfterFailure: true, latchFailure: false },
    );
  }

  async #serialize<T>(
    operation: () => Promise<T>,
    options: { allowAfterFailure?: boolean; latchFailure?: boolean } = {},
  ): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    if (this.#writeFailure && !options.allowAfterFailure) {
      release();
      throw this.#writeFailure;
    }
    try {
      return await operation();
    } catch (error) {
      if (
        options.latchFailure !== false &&
        error instanceof DataImportJournalError &&
        error.fatal
      ) {
        this.#writeFailure ??= error;
      }
      throw error;
    } finally {
      release();
    }
  }

  async #readUnsafe(
    ownedLock: boolean,
    recoveringWriter = false,
  ): Promise<DataImportJournalRecord | undefined> {
    if (recoveringWriter) await this.#assertNoQuarantinedJournal();
    else await this.#assertNoTemporaryJournal(ownedLock);
    let metadata: Stats;
    try {
      metadata = await this.#fileSystem.stat(this.#journalPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw sanitizeFailure(error);
    }
    try {
      const identity = await this.#fileSystem.lstat(this.#journalPath);
      if (identity.isSymbolicLink()) throw new DataImportJournalError();
      const canonical = await this.#fileSystem.realpath(this.#journalPath);
      if (!samePath(canonical, this.#journalPath)) throw new DataImportJournalError();
    } catch (error) {
      if (error instanceof DataImportJournalError) throw error;
      throw sanitizeFailure(error);
    }
    if (
      !metadata?.isFile() ||
      metadata.size <= 0 ||
      metadata.size > DATA_IMPORT_JOURNAL_MAX_BYTES
    ) {
      throw new DataImportJournalError();
    }
    let bytes: Buffer;
    try {
      bytes = await this.#fileSystem.readFile(this.#journalPath);
    } catch (error) {
      throw sanitizeFailure(error);
    }
    if (bytes.byteLength !== metadata.size) throw new DataImportJournalError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DataImportJournalError();
    } finally {
      bytes.fill(0);
    }
    try {
      const record = this.#validateRecord(PersistedRecordSchema.parse(parsed));
      await this.#assertPathAnchors(record);
      return record;
    } catch (error) {
      throw sanitizeFailure(error);
    }
  }

  async #writeReplacement(record: DataImportJournalRecord): Promise<DataImportJournalRecord> {
    const temporaryPath = this.#temporaryPath(record.operationId);
    await this.#fileSystem.mkdir(this.#applicationDataRoot, { recursive: true });
    await this.#writeTemporary(temporaryPath, record);
    await this.#syncDirectory(this.#applicationDataRoot);
    await this.#fileSystem.rename(temporaryPath, this.#journalPath);
    await this.#syncDirectory(this.#applicationDataRoot);
    return record;
  }

  #temporaryPath(operationId: string): string {
    return join(
      this.#applicationDataRoot,
      `.${DATA_IMPORT_JOURNAL_FILE_NAME}.${operationId}.${this.#createTempId()}.partial`,
    );
  }

  async #writeTemporary(path: string, record: DataImportJournalRecord): Promise<void> {
    const bytes = this.#encode(record);
    let handle: FileHandle | undefined;
    try {
      handle = await this.#fileSystem.open(path, "wx", 0o600);
      await writeAll(handle, bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      throw sanitizeFailure(error);
    } finally {
      try {
        await handle?.close();
      } catch {
        // Preserve the first write/sync/close error and leave the partial file.
      }
      bytes.fill(0);
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#fileSystem.mkdir(this.#applicationDataRoot, { recursive: true });
    const lockPath = join(this.#applicationDataRoot, IMPORT_JOURNAL_LOCK_FILE_NAME);
    const ownerToken = Buffer.from(
      `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`,
      "utf8",
    );
    let lockHandle: FileHandle | undefined;
    try {
      lockHandle = await this.#fileSystem.open(lockPath, "wx", 0o600);
      await writeAll(lockHandle, ownerToken);
      await lockHandle.sync();
      await lockHandle.close();
      lockHandle = undefined;
      await this.#syncDirectory(this.#applicationDataRoot);
    } catch (error) {
      try {
        await lockHandle?.close();
      } catch {
        // Preserve the acquisition failure.
      }
      ownerToken.fill(0);
      throw sanitizeFailure(
        isNodeError(error, "EEXIST") ? new DataImportJournalError(undefined, false) : error,
      );
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      const currentToken = await this.#fileSystem.readFile(lockPath);
      if (Buffer.compare(currentToken, ownerToken) !== 0) throw new DataImportJournalError();
      currentToken.fill(0);
      ownerToken.fill(0);
      await this.#fileSystem.unlink(lockPath);
      await this.#syncDirectory(this.#applicationDataRoot);
    } catch (error) {
      cleanupError = error;
      ownerToken.fill(0);
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupError !== undefined) throw sanitizeFailure(cleanupError);
    return result as T;
  }

  #encode(record: DataImportJournalRecord): Buffer {
    return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  }

  #validateRecord(record: unknown): DataImportJournalRecord {
    const parsed = PersistedRecordSchema.parse(record);
    if (!isUuid(parsed.operationId)) throw new DataImportJournalError();
    const operationId = parsed.operationId.toLowerCase();
    const libraryParent = dirname(this.#libraryRoot);
    const userDataParent = dirname(this.#userDataRoot);
    const fixedDraftsPath = join(this.#userDataRoot, "drafts");
    const fixedSettingsPath = join(this.#userDataRoot, "settings.json");
    if (
      parsed.polishHistory &&
      (!samePath(parsed.polishHistory.livePath, join(this.#userDataRoot, "text-polish-history")) ||
        !samePath(
          parsed.polishHistory.stagingPath,
          join(userDataParent, `.import-user-data-${operationId}`, "text-polish-history"),
        ) ||
        !samePath(
          parsed.polishHistory.rollbackPath,
          join(this.#userDataRoot, `.polish-history-rollback-${operationId}`),
        ))
    )
      throw new DataImportJournalError();
    const libraryPaths = [parsed.stagingPath, parsed.libraryPath, parsed.rollbackLibraryPath];
    for (const value of libraryPaths) {
      if (!isInside(libraryParent, value)) throw new DataImportJournalError();
      if (!isPortableAbsolute(value)) throw new DataImportJournalError();
    }
    const userDataPaths = [
      parsed.stagingDraftsPath,
      parsed.draftsPath,
      parsed.rollbackDraftsPath,
      parsed.settingsCandidatePath,
      parsed.settingsPath,
      parsed.rollbackSettingsPath,
    ];
    for (const value of userDataPaths) {
      if (
        !isPortableAbsolute(value) ||
        (!isInside(this.#userDataRoot, value) &&
          !isInside(this.#applicationDataRoot, value) &&
          !isInside(userDataParent, value))
      ) {
        throw new DataImportJournalError();
      }
    }
    if (!samePath(parsed.libraryPath, this.#libraryRoot)) throw new DataImportJournalError();
    if (!samePath(parsed.draftsPath, fixedDraftsPath)) throw new DataImportJournalError();
    if (!samePath(parsed.settingsPath, fixedSettingsPath)) throw new DataImportJournalError();
    const expectedManifestPath = join(parsed.stagingPath, `.import-manifest-${operationId}.json`);
    if (parsed.manifestPath !== undefined && !samePath(parsed.manifestPath, expectedManifestPath)) {
      throw new DataImportJournalError();
    }
    if (
      !isFixedImportPath(parsed.stagingPath, libraryParent, ".import-staging-", operationId) ||
      !isFixedImportPath(
        parsed.rollbackLibraryPath,
        libraryParent,
        ".import-rollback-",
        operationId,
      ) ||
      !isFixedImportPath(
        parsed.stagingDraftsPath,
        userDataParent,
        ".import-user-data-",
        operationId,
        "drafts",
      ) ||
      !isFixedImportPath(
        parsed.rollbackDraftsPath,
        this.#userDataRoot,
        ".drafts-rollback-",
        operationId,
      ) ||
      !samePath(
        parsed.rollbackSettingsPath,
        join(this.#userDataRoot, `settings-rollback-${operationId}.json`),
      ) ||
      !isFixedSettingsCandidatePath(parsed.settingsCandidatePath, userDataParent, operationId)
    ) {
      throw new DataImportJournalError();
    }
    const uuidPaths = [
      parsed.stagingPath,
      parsed.rollbackLibraryPath,
      parsed.rollbackDraftsPath,
      parsed.rollbackSettingsPath,
    ];
    if (parsed.manifestPath !== undefined) uuidPaths.push(parsed.manifestPath);
    if (uuidPaths.some((value) => !hasUuidName(value, operationId)))
      throw new DataImportJournalError();
    if (
      [
        parsed.stagingPath,
        parsed.libraryPath,
        parsed.rollbackLibraryPath,
        parsed.stagingDraftsPath,
        parsed.draftsPath,
        parsed.rollbackDraftsPath,
        parsed.settingsCandidatePath,
        parsed.settingsPath,
        parsed.rollbackSettingsPath,
        ...(parsed.manifestPath ? [parsed.manifestPath] : []),
      ].some(
        (value) =>
          !containsOperationId(value, operationId) &&
          !samePath(value, parsed.libraryPath) &&
          !samePath(value, parsed.draftsPath) &&
          !samePath(value, parsed.settingsPath),
      )
    ) {
      throw new DataImportJournalError();
    }
    const {
      polishHistory,
      settingsContentSha256,
      databaseContentSha256,
      databaseByteLength,
      manifestPath,
      pathIdentities,
      ...required
    } = parsed;
    return Object.freeze({
      ...required,
      operationId,
      ...(polishHistory !== undefined ? { polishHistory } : {}),
      ...(settingsContentSha256 !== undefined ? { settingsContentSha256 } : {}),
      ...(databaseContentSha256 !== undefined ? { databaseContentSha256 } : {}),
      ...(databaseByteLength !== undefined ? { databaseByteLength } : {}),
      ...(manifestPath !== undefined ? { manifestPath } : {}),
      ...(pathIdentities !== undefined ? { pathIdentities } : {}),
    });
  }

  async #assertNoTemporaryJournal(ownedLock = false): Promise<void> {
    await this.#assertNoQuarantinedJournal();
    let entries: string[];
    try {
      entries = await this.#fileSystem.readdir(this.#applicationDataRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw sanitizeFailure(error);
    }
    const temporary = entries.some((entry) => {
      if (ownedLock && entry === IMPORT_JOURNAL_LOCK_FILE_NAME) return false;
      return (
        entry === `${DATA_IMPORT_JOURNAL_FILE_NAME}.partial` ||
        entry.startsWith(`.${DATA_IMPORT_JOURNAL_FILE_NAME}.`) ||
        entry.startsWith(`${DATA_IMPORT_JOURNAL_FILE_NAME}.`)
      );
    });
    if (temporary) throw new DataImportJournalError();
    if (!ownedLock && entries.includes(IMPORT_JOURNAL_LOCK_FILE_NAME)) {
      throw new DataImportJournalError();
    }
  }

  async #assertNoQuarantinedJournal(): Promise<void> {
    const entries = await this.#fileSystem.readdir(this.#applicationDataRoot).catch((error) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw sanitizeFailure(error);
    });
    if (entries.some((name) => name.startsWith(QUARANTINED_JOURNAL_PREFIX)))
      throw new DataImportJournalError();
  }

  async #assertPathAnchors(record: DataImportJournalRecord): Promise<void> {
    const paths = [
      this.#applicationDataRoot,
      record.stagingPath,
      record.libraryPath,
      record.rollbackLibraryPath,
      record.stagingDraftsPath,
      record.draftsPath,
      record.rollbackDraftsPath,
      record.settingsCandidatePath,
      record.settingsPath,
      record.rollbackSettingsPath,
      ...(record.manifestPath ? [record.manifestPath] : []),
      ...(record.polishHistory
        ? [
            record.polishHistory.stagingPath,
            record.polishHistory.livePath,
            record.polishHistory.rollbackPath,
          ]
        : []),
    ];
    const probe = this.#createReparsePointProbe();
    let failure: unknown;
    try {
      for (const input of paths) {
        let candidate = resolve(input);
        while (true) {
          try {
            const info = await this.#fileSystem.lstat(candidate);
            await probe.assertSafe(candidate);
            if (info.isSymbolicLink()) throw new DataImportJournalError();
            const canonical = await this.#fileSystem.realpath(candidate);
            if (!samePath(canonical, candidate)) throw new DataImportJournalError();
            break;
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) {
              if (error instanceof DataImportJournalError) throw error;
              throw sanitizeFailure(error);
            }
            const parent = dirname(candidate);
            if (samePath(parent, candidate)) throw new DataImportJournalError();
            candidate = parent;
          }
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      await probe.close();
    } catch (error) {
      failure ??= sanitizeFailure(error);
    }
    if (failure !== undefined) throw failure;
  }

  async #syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined;
    let failure: unknown;
    try {
      handle = await this.#fileSystem.open(directory, "r");
      try {
        await handle.sync();
      } catch (error) {
        // Windows does not expose a fsync-capable directory handle. The file
        // itself is still fsynced; on POSIX this remains a hard requirement.
        if (!(process.platform === "win32" && isNodeError(error, "EPERM"))) failure = error;
      }
    } catch (error) {
      failure = error;
    }
    try {
      await handle?.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw sanitizeFailure(failure);
  }
}

export function hashDataImportJournalPayload(record: DataImportJournalRecord): string {
  return createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}
