import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { moveNoReplaceHarmony, moveNoReplaceMac } from "../platform/move-no-replace.js";
import type {
  DataImportJournalPhase,
  DataImportJournalRecord,
  DataImportJournalRecordInput,
} from "./data-import-journal.js";
import type {
  EmptyLibraryInspection,
  EmptyLibraryInspectOptions,
} from "./empty-library-inspector.js";
import type {
  PreparedFullDataImport,
  PreparedFullDataImportLease,
  PreparedImportReleaseDisposition,
  PreparedImportReleaseOptions,
} from "./full-data-import-service.js";
import type { ImportStagingValidationSummary } from "./import-staging-validator.js";

export type LibraryImportSwapFailurePoint =
  | "after-journal"
  | "after-old-library-move"
  | "after-new-library-install"
  | "after-old-drafts-move"
  | "after-new-drafts-install"
  | "after-old-polish-history-move"
  | "after-new-polish-history-install"
  | "after-settings-backup"
  | "after-settings-install";

export type LibraryImportSwapErrorCode =
  | "CANCELLED"
  | "CROSS_VOLUME"
  | "IMPORT_RECOVERY_REQUIRED"
  | "INSUFFICIENT_SPACE"
  | "INTERNAL"
  | "LIBRARY_NOT_EMPTY"
  | "OPERATION_IN_PROGRESS"
  | "UNSUPPORTED_ATOMIC_SWAP"
  | "UNSAFE_OVERWRITE";

export class LibraryImportSwapError extends Error {
  override readonly name = "LibraryImportSwapError";

  constructor(
    readonly code: LibraryImportSwapErrorCode,
    message: string = code,
    readonly restartRequired = false,
  ) {
    super(message);
    delete this.stack;
  }
}

export type LibraryImportSwapReleaseHandoff = Readonly<{
  operationId: string;
  stagingPath: string;
  rollbackLibraryPath: string;
  rollbackDraftsPath: string;
  rollbackSettingsPath: string;
  release(disposition?: PreparedImportReleaseDisposition): Promise<void>;
}>;

export type LibraryImportSwapResult = Readonly<{
  operationId: string;
  phase: "restart-validation-pending";
  releaseHandoff: LibraryImportSwapReleaseHandoff;
}>;

type BigIntStats = {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type PathIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}>;

type DirectoryCapability = Readonly<{
  path: string;
  identity: PathIdentity;
}>;

type SwapFileSystem = Readonly<{
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  moveNoReplace(source: string, target: string, kind: "directory" | "file"): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
}>;

const WINDOWS_MOVE_NO_REPLACE_SCRIPT = Buffer.from(
  [
    "$ErrorActionPreference='Stop'",
    "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    "$k=[Console]::In.ReadLine()",
    "try{if($k -eq 'directory'){[IO.Directory]::Move($s,$t)}else{[IO.File]::Move($s,$t)};[Console]::Out.Write('OK')}catch [IO.IOException]{",
    "  $n=$_.Exception.HResult -band 0xFFFF",
    "  if([IO.File]::Exists($t) -or [IO.Directory]::Exists($t)){[Console]::Out.Write('EEXIST')} ",
    "  elseif($n -eq 112){[Console]::Out.Write('ENOSPC')} ",
    "  elseif($n -eq 223){[Console]::Out.Write('EFBIG')} ",
    "  else{[Console]::Out.Write('EIO')} ",
    "}catch [UnauthorizedAccessException]{[Console]::Out.Write('EACCES')}catch{[Console]::Out.Write('EIO')}",
  ].join("\n"),
  "utf16le",
).toString("base64");

async function moveNoReplaceWindows(
  sourcePath: string,
  targetPath: string,
  kind: "directory" | "file",
): Promise<void> {
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_MOVE_NO_REPLACE_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  child.stdin.end(
    `${Buffer.from(sourcePath, "utf8").toString("base64")}\n${Buffer.from(targetPath, "utf8").toString("base64")}\n${kind}\n`,
    "ascii",
  );
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", () => resolvePromise());
  });
  const result = Buffer.concat(output).toString("utf8");
  if (result === "OK") return;
  throw Object.assign(new Error("Windows no-replace move failed"), { code: result || "EIO" });
}

async function moveNoReplacePosix(
  _sourcePath: string,
  _targetPath: string,
  _kind: "directory" | "file",
): Promise<void> {
  throw Object.assign(new Error("Atomic no-replace swap is unsupported on this platform"), {
    code: "UNSUPPORTED_ATOMIC_SWAP",
  });
}

function createDefaultFileSystem(platform: NodeJS.Platform): SwapFileSystem {
  return {
    lstat: async (filePath) => (await lstat(filePath, { bigint: true })) as unknown as BigIntStats,
    realpath,
    writeFile: async (filePath, data) => {
      await writeFile(filePath, data, { encoding: "utf8", flag: "wx" });
    },
    moveNoReplace: async (source, target, kind) =>
      platform === "win32"
        ? await moveNoReplaceWindows(source, target, kind)
        : platform === "darwin"
          ? await moveNoReplaceMac(source, target)
          : ["openharmony", "ohos"].includes(platform)
            ? await moveNoReplaceHarmony(source, target)
            : await moveNoReplacePosix(source, target, kind),
    open,
  };
}

export type LibraryImportSwapCoordinatorOptions = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
  applicationDataRoot: string;
  prepared: PreparedFullDataImport;
  lease?: PreparedFullDataImportLease;
  journal: LibraryImportJournal;
  ensureCurrentState: () => Promise<void>;
  inspectEmptyLibrary: (options?: EmptyLibraryInspectOptions) => Promise<EmptyLibraryInspection>;
  validateStaging: (prepared: PreparedFullDataImport) => Promise<ImportStagingValidationSummary>;
  stopRuntime?: () => Promise<void>;
  closeRuntime: () => Promise<void>;
  fileSystem?: Partial<SwapFileSystem>;
  platform?: NodeJS.Platform;
  now?: () => string;
}>;

export type LibraryImportJournal = Readonly<{
  create(record: DataImportJournalRecordInput): Promise<DataImportJournalRecord | unknown>;
  advance(phase: DataImportJournalPhase): Promise<DataImportJournalRecord | unknown>;
}>;

export type LibraryImportSwapCommitOptions = Readonly<{
  signal?: AbortSignal;
  failurePoint?: LibraryImportSwapFailurePoint;
}>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function asPathIdentity(stats: BigIntStats): PathIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    size: String(stats.size),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  });
}

function sameDirectoryIdentity(actual: PathIdentity, expected: PathIdentity): boolean {
  return (
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.birthtimeNs === expected.birthtimeNs
  );
}

function ensureDirectory(stats: BigIntStats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
}

function ensureFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function inspectPath(
  fs: SwapFileSystem,
  filePath: string,
  kind: "directory" | "file",
): Promise<DirectoryCapability> {
  let stats: BigIntStats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
    }
    throw error;
  }
  if (kind === "directory") ensureDirectory(stats);
  else ensureFile(stats);
  let canonical: string;
  try {
    canonical = await fs.realpath(filePath);
  } catch {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
  if (!samePath(canonical, filePath)) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
  return Object.freeze({ path: resolve(filePath), identity: asPathIdentity(stats) });
}

async function inspectParent(fs: SwapFileSystem, filePath: string): Promise<DirectoryCapability> {
  return await inspectPath(fs, dirname(filePath), "directory");
}

async function assertStable(
  fs: SwapFileSystem,
  capability: DirectoryCapability,
  kind: "directory" | "file",
): Promise<void> {
  const current = await inspectPath(fs, capability.path, kind);
  if (!sameDirectoryIdentity(current.identity, capability.identity)) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function assertParentStable(fs: SwapFileSystem, parent: DirectoryCapability): Promise<void> {
  const current = await inspectPath(fs, parent.path, "directory");
  if (!sameDirectoryIdentity(current.identity, parent.identity)) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function assertAbsent(fs: SwapFileSystem, filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  throw new LibraryImportSwapError("UNSAFE_OVERWRITE");
}

async function syncDirectory(fs: SwapFileSystem, directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  let failure: LibraryImportSwapError | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(process.platform === "win32" && isNodeError(error, "EPERM"))) {
      failure = new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
    }
  }
  try {
    await handle?.close();
  } catch {
    failure ??= new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
  if (failure !== undefined) throw failure;
}

async function renameNoReplace(
  fs: SwapFileSystem,
  source: DirectoryCapability,
  sourceParent: DirectoryCapability,
  target: string,
  targetParent: DirectoryCapability,
  kind: "directory" | "file",
  onMoved?: () => void,
): Promise<DirectoryCapability> {
  await assertStable(fs, source, kind);
  await assertParentStable(fs, sourceParent);
  await assertParentStable(fs, targetParent);
  await assertAbsent(fs, target);
  try {
    await fs.moveNoReplace(source.path, target, kind);
  } catch (error) {
    if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
      throw new LibraryImportSwapError("UNSAFE_OVERWRITE");
    }
    if (isNodeError(error, "UNSUPPORTED_ATOMIC_SWAP")) {
      throw new LibraryImportSwapError("UNSUPPORTED_ATOMIC_SWAP");
    }
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
  onMoved?.();
  await assertParentStable(fs, sourceParent);
  await assertParentStable(fs, targetParent);
  const installed = await inspectPath(fs, target, kind);
  if (
    installed.identity.device !== source.identity.device ||
    installed.identity.inode !== source.identity.inode
  ) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
  await syncDirectory(fs, sourceParent.path);
  if (!samePath(sourceParent.path, targetParent.path)) {
    await syncDirectory(fs, targetParent.path);
  }
  return installed;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LibraryImportSwapError("CANCELLED");
}

function sameValidationSummary(
  actual: ImportStagingValidationSummary,
  expected: ImportStagingValidationSummary,
): boolean {
  return (
    actual.activePatents === expected.activePatents &&
    actual.trashedPatents === expected.trashedPatents &&
    actual.documents === expected.documents &&
    actual.legacyDrafts === expected.legacyDrafts &&
    actual.snapshots === expected.snapshots &&
    actual.assets === expected.assets &&
    actual.flowchartProjects === expected.flowchartProjects &&
    actual.totalBytes === expected.totalBytes
  );
}

function assertPreparedPathLayout(
  prepared: PreparedFullDataImport,
  libraryRoot: string,
  userDataRoot: string,
): void {
  const operationId = prepared.operationId;
  const libraryStagingRoot = resolve(prepared.libraryStagingCapability.root);
  const userDataStagingRoot = resolve(prepared.userDataStagingCapability.root);
  const expectedLibraryStagingRoot = resolve(
    dirname(libraryRoot),
    `.import-staging-${operationId}`,
  );
  const expectedUserDataStagingRoot = resolve(
    dirname(userDataRoot),
    `.import-user-data-${operationId}`,
  );
  if (
    !samePath(libraryStagingRoot, expectedLibraryStagingRoot) ||
    !samePath(userDataStagingRoot, expectedUserDataStagingRoot) ||
    !samePath(dirname(resolve(prepared.stagingLibraryPath)), libraryStagingRoot) ||
    basename(resolve(prepared.stagingLibraryPath)) !== "library" ||
    !samePath(dirname(resolve(prepared.stagingDraftsPath)), userDataStagingRoot) ||
    basename(resolve(prepared.stagingDraftsPath)) !== "drafts" ||
    (prepared.stagingPolishHistoryPath !== undefined &&
      !samePath(
        prepared.stagingPolishHistoryPath,
        join(userDataStagingRoot, "text-polish-history"),
      )) ||
    !samePath(
      resolve(prepared.settingsCandidatePath),
      join(userDataStagingRoot, `settings-candidate-${operationId}.json`),
    )
  ) {
    throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }
}

function normalizeFailure(error: unknown): LibraryImportSwapError {
  if (error instanceof LibraryImportSwapError) return error;
  if (isNodeError(error, "ENOSPC") || isNodeError(error, "EFBIG")) {
    return new LibraryImportSwapError("INSUFFICIENT_SPACE");
  }
  return new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
}

export class LibraryImportSwapCoordinator {
  readonly #options: LibraryImportSwapCoordinatorOptions;
  readonly #fileSystem: SwapFileSystem;
  readonly #now: () => string;
  #active = false;

  constructor(options: LibraryImportSwapCoordinatorOptions) {
    this.#options = options;
    this.#fileSystem = {
      ...createDefaultFileSystem(options.platform ?? process.platform),
      ...options.fileSystem,
    };
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async commit(options: LibraryImportSwapCommitOptions = {}): Promise<LibraryImportSwapResult> {
    if (this.#active) throw new LibraryImportSwapError("OPERATION_IN_PROGRESS");
    this.#active = true;
    const fs = this.#fileSystem;
    const prepared = this.#options.lease?.prepared ?? this.#options.prepared;
    const signal = options.signal;
    const operationId = prepared.operationId;
    const libraryRoot = resolve(this.#options.libraryRoot);
    const userDataRoot = resolve(this.#options.userDataRoot);
    const rollbackLibraryPath = resolve(dirname(libraryRoot), `.import-rollback-${operationId}`);
    const rollbackDraftsPath = resolve(userDataRoot, `.drafts-rollback-${operationId}`);
    const settingsPath = resolve(userDataRoot, "settings.json");
    const rollbackSettingsPath = resolve(userDataRoot, `settings-rollback-${operationId}.json`);
    let journalCreated = false;
    let firstRenameStarted = false;
    let runtimeClosingStarted = false;
    let settingsCandidateConsumed = false;
    let leaseReleaseStarted = false;
    try {
      checkAbort(signal);
      assertPreparedPathLayout(prepared, libraryRoot, userDataRoot);
      await this.#options.ensureCurrentState();
      if (prepared.stagingPolishHistoryPath) {
        await inspectPath(fs, userDataRoot, "directory");
        await mkdir(join(userDataRoot, "text-polish-history"), { recursive: true });
      }
      checkAbort(signal);
      await this.#assertPathsAndVolumes(fs, prepared, {
        libraryRoot,
        userDataRoot,
        rollbackLibraryPath,
        rollbackDraftsPath,
        settingsPath,
        rollbackSettingsPath,
      });
      checkAbort(signal);

      const currentInspection = await this.#options.inspectEmptyLibrary({
        ownedImportStaging: prepared.libraryStagingCapability,
      });
      checkAbort(signal);
      if (!currentInspection.empty) throw new LibraryImportSwapError("LIBRARY_NOT_EMPTY");

      runtimeClosingStarted = true;
      await this.#options.stopRuntime?.();
      checkAbort(signal);
      await this.#options.closeRuntime();
      checkAbort(signal);
      await this.#assertStaging(prepared, fs);
      checkAbort(signal);
      const validationSummary = await this.#options.validateStaging(prepared);
      checkAbort(signal);
      if (!sameValidationSummary(validationSummary, prepared.manifest.summary)) {
        throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
      }

      const stagingRoot = resolve(prepared.libraryStagingCapability.root);
      const stagingDrafts = resolve(prepared.stagingDraftsPath);
      const stagingLibrary = resolve(prepared.stagingLibraryPath);
      const manifestPath = join(stagingRoot, `.import-manifest-${operationId}.json`);
      await fs.writeFile(manifestPath, `${JSON.stringify(prepared.manifest)}\n`);
      const libraryParent = await inspectParent(fs, libraryRoot);
      checkAbort(signal);
      const userDataParent = await inspectParent(fs, userDataRoot);
      checkAbort(signal);
      const librarySource = await inspectPath(fs, libraryRoot, "directory");
      checkAbort(signal);
      const stagingLibrarySource = await inspectPath(fs, stagingLibrary, "directory");
      checkAbort(signal);
      const stagingLibraryParent = await inspectParent(fs, stagingLibrary);
      checkAbort(signal);
      const draftsSource = await inspectPath(fs, resolve(userDataRoot, "drafts"), "directory");
      checkAbort(signal);
      const stagingDraftsSource = await inspectPath(fs, stagingDrafts, "directory");
      checkAbort(signal);
      const stagingDraftsParent = await inspectParent(fs, stagingDrafts);
      checkAbort(signal);
      const settingsSource = await inspectPath(fs, settingsPath, "file");
      checkAbort(signal);
      const settingsCandidate = await inspectPath(fs, prepared.settingsCandidatePath, "file");
      checkAbort(signal);
      const settingsCandidateParent = await inspectParent(fs, prepared.settingsCandidatePath);
      const stagingRootSource = await inspectPath(fs, stagingRoot, "directory");
      const manifestFile = await inspectPath(fs, manifestPath, "file");
      const polishSource = prepared.stagingPolishHistoryPath
        ? await inspectPath(fs, join(userDataRoot, "text-polish-history"), "directory")
        : undefined;
      const polishStaging = prepared.stagingPolishHistoryPath
        ? await inspectPath(fs, prepared.stagingPolishHistoryPath, "directory")
        : undefined;
      const polishRollback = join(userDataRoot, `.polish-history-rollback-${operationId}`);
      if (polishSource && polishStaging) {
        if (
          polishSource.identity.device !== polishStaging.identity.device ||
          polishSource.identity.device !== draftsSource.identity.device
        )
          throw new LibraryImportSwapError("CROSS_VOLUME");
        await assertAbsent(fs, polishRollback);
      }
      checkAbort(signal);
      const record: DataImportJournalRecordInput = {
        operationId,
        phase: "prepared",
        createdAt: this.#now(),
        stagingPath: stagingRoot,
        libraryPath: libraryRoot,
        rollbackLibraryPath,
        stagingDraftsPath: stagingDrafts,
        draftsPath: draftsSource.path,
        rollbackDraftsPath,
        settingsCandidatePath: settingsCandidate.path,
        settingsPath,
        rollbackSettingsPath,
        ...(polishSource && polishStaging
          ? {
              polishHistory: {
                livePath: polishSource.path,
                stagingPath: polishStaging.path,
                rollbackPath: polishRollback,
                liveIdentity: polishSource.identity,
                stagingIdentity: polishStaging.identity,
              },
            }
          : {}),
        settingsContentSha256: prepared.settingsCandidateIntegrity.sha256,
        databaseContentSha256: prepared.stagingDatabaseIntegrity.sha256,
        databaseByteLength: Number(prepared.stagingDatabaseIntegrity.size),
        manifestPath,
        pathIdentities: {
          stagingRoot: stagingRootSource.identity,
          stagingLibrary: stagingLibrarySource.identity,
          library: librarySource.identity,
          stagingDraftsRoot: stagingDraftsParent.identity,
          stagingDrafts: stagingDraftsSource.identity,
          drafts: draftsSource.identity,
          settingsCandidate: settingsCandidate.identity,
          settings: settingsSource.identity,
          manifest: manifestFile.identity,
        },
        packageSummary: {
          packageId: prepared.manifest.packageId,
          packageFormatVersion: 2,
          payloadSha256: prepared.manifest.payloadSha256,
          totalOriginalBytes: prepared.manifest.totalOriginalBytes,
          exportedAt: prepared.manifest.exportedAt,
        },
      };
      await this.#options.journal.create(record);
      journalCreated = true;
      checkAbort(signal);
      this.#injectFailure(options.failurePoint, "after-journal");

      firstRenameStarted = true;
      await renameNoReplace(
        fs,
        librarySource,
        libraryParent,
        rollbackLibraryPath,
        libraryParent,
        "directory",
      );
      this.#injectFailure(options.failurePoint, "after-old-library-move");
      await this.#options.journal.advance("old-library-moved");

      await renameNoReplace(
        fs,
        stagingLibrarySource,
        stagingLibraryParent,
        libraryRoot,
        libraryParent,
        "directory",
      );
      await this.#options.journal.advance("new-library-installed");
      this.#injectFailure(options.failurePoint, "after-new-library-install");

      await renameNoReplace(
        fs,
        draftsSource,
        userDataParent,
        rollbackDraftsPath,
        userDataParent,
        "directory",
      );
      this.#injectFailure(options.failurePoint, "after-old-drafts-move");

      await renameNoReplace(
        fs,
        stagingDraftsSource,
        stagingDraftsParent,
        draftsSource.path,
        userDataParent,
        "directory",
      );
      await this.#options.journal.advance("drafts-installed");
      this.#injectFailure(options.failurePoint, "after-new-drafts-install");

      if (polishSource && polishStaging) {
        await renameNoReplace(
          fs,
          polishSource,
          userDataParent,
          polishRollback,
          userDataParent,
          "directory",
        );
        this.#injectFailure(options.failurePoint, "after-old-polish-history-move");
        await renameNoReplace(
          fs,
          polishStaging,
          stagingDraftsParent,
          polishSource.path,
          userDataParent,
          "directory",
        );
        this.#injectFailure(options.failurePoint, "after-new-polish-history-install");
      }

      await renameNoReplace(
        fs,
        settingsSource,
        userDataParent,
        rollbackSettingsPath,
        userDataParent,
        "file",
      );
      this.#injectFailure(options.failurePoint, "after-settings-backup");

      await renameNoReplace(
        fs,
        settingsCandidate,
        settingsCandidateParent,
        settingsPath,
        userDataParent,
        "file",
        () => {
          settingsCandidateConsumed = true;
        },
      );
      await this.#options.journal.advance("settings-installed");
      this.#injectFailure(options.failurePoint, "after-settings-install");
      await this.#options.journal.advance("restart-validation-pending");

      const releaseHandoff: LibraryImportSwapReleaseHandoff = Object.freeze({
        operationId,
        stagingPath: stagingRoot,
        rollbackLibraryPath,
        rollbackDraftsPath,
        rollbackSettingsPath,
        release: async (disposition: PreparedImportReleaseDisposition = "released") => {
          if (!this.#options.lease) return;
          const releaseOptions: PreparedImportReleaseOptions = {
            settingsCandidateConsumed,
          };
          await this.#options.lease.release(disposition, releaseOptions);
        },
      });

      return Object.freeze({
        operationId,
        phase: "restart-validation-pending",
        releaseHandoff,
      });
    } catch (error) {
      if (this.#options.lease && !leaseReleaseStarted) {
        leaseReleaseStarted = true;
        const disposition: PreparedImportReleaseDisposition =
          runtimeClosingStarted || journalCreated || firstRenameStarted
            ? "recovery-required"
            : "retryable";
        try {
          await this.#options.lease.release(disposition, { settingsCandidateConsumed });
        } catch {
          // Preserve the original failure; the durable journal remains the recovery source.
        }
      }
      const failure = normalizeFailure(error);
      throw new LibraryImportSwapError(
        failure.code,
        failure.message,
        runtimeClosingStarted || journalCreated || firstRenameStarted,
      );
    } finally {
      this.#active = false;
    }
  }

  #injectFailure(
    requested: LibraryImportSwapFailurePoint | undefined,
    current: LibraryImportSwapFailurePoint,
  ): void {
    if (requested === current) throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
  }

  async #assertPathsAndVolumes(
    fs: SwapFileSystem,
    prepared: PreparedFullDataImport,
    paths: Readonly<{
      libraryRoot: string;
      userDataRoot: string;
      rollbackLibraryPath: string;
      rollbackDraftsPath: string;
      settingsPath: string;
      rollbackSettingsPath: string;
    }>,
  ): Promise<void> {
    const libraryStaging = await inspectPath(fs, prepared.stagingLibraryPath, "directory");
    const library = await inspectPath(fs, paths.libraryRoot, "directory");
    const libraryRollbackParent = await inspectParent(fs, paths.rollbackLibraryPath);
    const draftsStaging = await inspectPath(fs, prepared.stagingDraftsPath, "directory");
    const drafts = await inspectPath(fs, resolve(paths.userDataRoot, "drafts"), "directory");
    const draftsRollbackParent = await inspectParent(fs, paths.rollbackDraftsPath);
    const settingsCandidate = await inspectPath(fs, prepared.settingsCandidatePath, "file");
    const settings = await inspectPath(fs, paths.settingsPath, "file");
    const settingsRollbackParent = await inspectParent(fs, paths.rollbackSettingsPath);
    const libraryDevice = library.identity.device;
    if (
      libraryStaging.identity.device !== libraryDevice ||
      libraryRollbackParent.identity.device !== libraryDevice
    ) {
      throw new LibraryImportSwapError("CROSS_VOLUME");
    }
    const userDevice = drafts.identity.device;
    if (
      draftsStaging.identity.device !== userDevice ||
      draftsRollbackParent.identity.device !== userDevice ||
      settingsCandidate.identity.device !== userDevice ||
      settings.identity.device !== userDevice ||
      settingsRollbackParent.identity.device !== userDevice
    ) {
      throw new LibraryImportSwapError("CROSS_VOLUME");
    }
  }

  async #assertStaging(prepared: PreparedFullDataImport, fs: SwapFileSystem): Promise<void> {
    assertPreparedPathLayout(prepared, this.#options.libraryRoot, this.#options.userDataRoot);
    const stagingRoot = await inspectPath(fs, prepared.libraryStagingCapability.root, "directory");
    if (
      stagingRoot.identity.device !== prepared.libraryStagingCapability.identity.device ||
      stagingRoot.identity.inode !== prepared.libraryStagingCapability.identity.inode ||
      stagingRoot.identity.birthtimeNs !== prepared.libraryStagingCapability.identity.birthtimeNs
    ) {
      throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
    }
    const userDataStagingRoot = await inspectPath(
      fs,
      prepared.userDataStagingCapability.root,
      "directory",
    );
    if (
      userDataStagingRoot.identity.device !== prepared.userDataStagingCapability.identity.device ||
      userDataStagingRoot.identity.inode !== prepared.userDataStagingCapability.identity.inode ||
      userDataStagingRoot.identity.birthtimeNs !==
        prepared.userDataStagingCapability.identity.birthtimeNs
    ) {
      throw new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED");
    }
    await inspectPath(fs, prepared.stagingLibraryPath, "directory");
    await inspectPath(fs, prepared.stagingDraftsPath, "directory");
    await inspectPath(fs, prepared.settingsCandidatePath, "file");
  }
}
