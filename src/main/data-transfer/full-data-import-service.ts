import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import {
  type FullDataImportPrepareRequest,
  FullDataImportPrepareRequestSchema,
  type FullDataImportPreview,
  FullDataImportPreviewSchema,
  type TransferManifest,
} from "../../shared/data-transfer/model.js";
import type { DataTransferPublicHeader } from "../../shared/data-transfer/package-format.js";
import {
  mergePortableSettings,
  PortableSettingsSchema,
} from "../../shared/data-transfer/portable-settings.js";
import { type AppSettings, AppSettingsSchema } from "../../shared/settings/model.js";
import type {
  EmptyLibraryInspection,
  OwnedImportStagingCapability,
} from "./empty-library-inspector.js";
import { ImportStagingOwnership } from "./import-staging-ownership.js";
import {
  ImportStagingValidationError,
  type ImportStagingValidationSummary,
  ImportStagingValidator,
} from "./import-staging-validator.js";
import { removeOwnedPath } from "./owned-path-cleanup.js";
import { DataTransferCryptoError } from "./package-crypto.js";
import {
  type PackageExtractionCapability,
  type PackageExtractionResult,
  PackageReader,
  PackageReaderError,
  type TransferSourceHandle,
} from "./package-reader.js";

const GIB = 1024n * 1024n * 1024n;
const IMPORT_STAGING_PREFIX = ".import-staging-";
const IMPORT_USER_DATA_PREFIX = ".import-user-data-";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type FullDataImportServiceErrorCode =
  | "CANCELLED"
  | "IMPORT_RECOVERY_REQUIRED"
  | "INSUFFICIENT_SPACE"
  | "INTERNAL"
  | "INVALID_INPUT"
  | "LIBRARY_NOT_EMPTY"
  | "OPERATION_IN_PROGRESS"
  | "PACKAGE_INCOMPLETE"
  | "PACKAGE_TAMPERED"
  | "PACKAGE_TOO_NEW"
  | "PASSWORD_OR_PACKAGE_INVALID"
  | "UNSAFE_OVERWRITE";

export class FullDataImportError extends Error {
  override readonly name = "FullDataImportError";

  constructor(readonly code: FullDataImportServiceErrorCode) {
    super(code);
    delete this.stack;
  }
}

class OwnedRootCreationError extends FullDataImportError {
  constructor(
    readonly owned: OwnedRoot | undefined,
    readonly createdRoot: string,
  ) {
    super("IMPORT_RECOVERY_REQUIRED");
  }
}

class OwnedRootCleanupError extends FullDataImportError {
  constructor(readonly owned: OwnedRoot) {
    super("IMPORT_RECOVERY_REQUIRED");
  }
}

export type FullDataImportSpaceInput = Readonly<{
  totalOriginalBytes: bigint;
  currentLibraryBytes: bigint;
  currentUserDataBytes: bigint;
}>;

export type FullDataImportSpaceBudget = Readonly<{
  payloadBytes: bigint;
  currentBytes: bigint;
  rollbackBytes: bigint;
  marginBytes: bigint;
  totalRequiredBytes: bigint;
}>;

function tenPercentCeiling(value: bigint): bigint {
  return (value + 9n) / 10n;
}

function nonNegative(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("Invalid byte budget");
}

export function calculateFullDataImportSpaceBudget(
  input: FullDataImportSpaceInput,
): FullDataImportSpaceBudget {
  nonNegative(input.totalOriginalBytes);
  nonNegative(input.currentLibraryBytes);
  nonNegative(input.currentUserDataBytes);
  const currentBytes = input.currentLibraryBytes + input.currentUserDataBytes;
  const rollbackBytes = currentBytes;
  const marginBytes =
    tenPercentCeiling(input.totalOriginalBytes) > GIB
      ? tenPercentCeiling(input.totalOriginalBytes)
      : GIB;
  return Object.freeze({
    payloadBytes: input.totalOriginalBytes,
    currentBytes,
    rollbackBytes,
    marginBytes,
    totalRequiredBytes: input.totalOriginalBytes + currentBytes + rollbackBytes + marginBytes,
  });
}

type StatFsResult = Readonly<{ bavail: bigint; bsize: bigint }>;

export type FullDataImportSpacePreflightInput = FullDataImportSpaceInput &
  Readonly<{
    libraryParent: string;
    userDataParent: string;
    libraryPayloadBytes: bigint;
    userDataPayloadBytes: bigint;
  }>;

export type FullDataImportSpacePreflightDependencies = Readonly<{
  statfs?: (path: string) => Promise<StatFsResult>;
  statDevice?: (path: string) => Promise<bigint>;
}>;

async function defaultStatFs(filePath: string): Promise<StatFsResult> {
  const value = await statfs(filePath, { bigint: true });
  return { bavail: value.bavail, bsize: value.bsize };
}

async function defaultStatDevice(filePath: string): Promise<bigint> {
  return (await lstat(filePath, { bigint: true })).dev;
}

function availableBytes(result: StatFsResult): bigint {
  if (result.bavail < 0n || result.bsize <= 0n) throw new Error("Invalid statfs result");
  return result.bavail * result.bsize;
}

export async function preflightFullDataImportSpace(
  input: FullDataImportSpacePreflightInput,
  dependencies: FullDataImportSpacePreflightDependencies = {},
): Promise<FullDataImportSpaceBudget> {
  const budget = calculateFullDataImportSpaceBudget(input);
  try {
    const readStatFs = dependencies.statfs ?? defaultStatFs;
    const readDevice = dependencies.statDevice ?? defaultStatDevice;
    const [libraryFs, userDataFs, libraryDevice, userDataDevice] = await Promise.all([
      readStatFs(input.libraryParent),
      readStatFs(input.userDataParent),
      readDevice(input.libraryParent),
      readDevice(input.userDataParent),
    ]);
    const libraryAvailable = availableBytes(libraryFs);
    const userDataAvailable = availableBytes(userDataFs);
    const libraryRequired =
      input.libraryPayloadBytes + input.currentLibraryBytes * 2n + budget.marginBytes;
    const userDataRequired = input.userDataPayloadBytes + input.currentUserDataBytes * 2n;
    if (libraryDevice === userDataDevice) {
      const required = libraryRequired + userDataRequired;
      if (libraryAvailable < required || userDataAvailable < required) {
        throw new FullDataImportError("INSUFFICIENT_SPACE");
      }
    } else if (libraryAvailable < libraryRequired || userDataAvailable < userDataRequired) {
      throw new FullDataImportError("INSUFFICIENT_SPACE");
    }
    return budget;
  } catch (error) {
    if (error instanceof FullDataImportError) throw error;
    throw new FullDataImportError("INSUFFICIENT_SPACE");
  }
}

type ImportReader = {
  readPublicHeader(): Promise<DataTransferPublicHeader>;
  unlock(password: string): Promise<void>;
  scanManifest(signal?: AbortSignal): Promise<TransferManifest>;
  extractTo(
    roots: Readonly<{ libraryRoot: string; userDataRoot: string }>,
    signal?: AbortSignal,
  ): Promise<PackageExtractionResult>;
  close(): Promise<void>;
};

export type FullDataImportSourceSelection = Readonly<{
  selectionId: string;
  sourceHandle: TransferSourceHandle;
}>;

type OwnedRoot = Readonly<{
  root: string;
  capability: OwnedImportStagingCapability;
}>;

type RecoveryRoot = Readonly<{
  root: string;
  capability?: OwnedImportStagingCapability;
}>;

export type PreparedFullDataImport = Readonly<{
  operationId: string;
  packageId: string;
  manifest: TransferManifest;
  preview: FullDataImportPreview;
  stagingLibraryPath: string;
  stagingDraftsPath: string;
  stagingPolishHistoryPath?: string;
  settingsCandidatePath: string;
  settingsCandidateIntegrity: PreparedSettingsCandidateIntegrity;
  stagingDatabaseIntegrity: PreparedStagingDatabaseIntegrity;
  libraryStagingCapability: OwnedImportStagingCapability;
  userDataStagingCapability: OwnedImportStagingCapability;
}>;

export type PreparedImportReleaseDisposition = "released" | "recovery-required" | "retryable";

export type PreparedImportReleaseOptions = Readonly<{
  settingsCandidateConsumed?: boolean;
}>;

export type PreparedFullDataImportLease = Readonly<{
  prepared: PreparedFullDataImport;
  release(
    disposition?: PreparedImportReleaseDisposition,
    options?: PreparedImportReleaseOptions,
  ): Promise<void>;
}>;

type PreparedImportState =
  | "prepared"
  | "taking"
  | "committing"
  | "releasing"
  | "cleaning"
  | "recovery-required"
  | "cleanup-failed";

type PreparedImportRecord = Readonly<{
  state: PreparedImportState;
  task?: PreparedFullDataImport;
  roots: readonly RecoveryRoot[];
}>;

type ImportFileSystem = Readonly<{
  createOwnedRoot(parent: string, name: string): Promise<OwnedRoot>;
  removeOwnedRoot(owned: OwnedRoot): Promise<void>;
  recursiveBytes(root: string): Promise<bigint>;
  writeCandidate(path: string, settings: AppSettings): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  removeOwnedExtraction(extraction: PackageExtractionCapability): Promise<void>;
}>;

export type FullDataImportServiceOptions = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
  applicationDataRoot: string;
  inspector: { inspect(): Promise<EmptyLibraryInspection> };
  resolveSourceSelection(selectionId: string): Promise<FullDataImportSourceSelection>;
  readCurrentSettings(): Promise<AppSettings>;
  readerFactory?: (source: TransferSourceHandle) => Promise<ImportReader>;
  validator?: Pick<ImportStagingValidator, "validate">;
  preflightSpace?: (input: FullDataImportSpacePreflightInput) => Promise<FullDataImportSpaceBudget>;
  sleep?: (milliseconds: number) => Promise<void>;
  createId?: () => string;
  fileSystem?: ImportFileSystem;
}>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function isCanonicalPath(value: string): Promise<boolean> {
  try {
    return samePath(await realpath(value), value);
  } catch {
    return false;
  }
}

async function createOwnedRoot(parentInput: string, name: string): Promise<OwnedRoot> {
  const parent = path.resolve(parentInput);
  const parentInfo = await lstat(parent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  if (!(await isCanonicalPath(parent))) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  const parentIdentity = {
    device: String(parentInfo.dev),
    inode: String(parentInfo.ino),
    birthtimeNs: String(parentInfo.birthtimeNs),
  };
  const root = path.join(parent, name);
  try {
    await mkdir(root);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new FullDataImportError("UNSAFE_OVERWRITE");
    throw error;
  }
  let owned: OwnedRoot | undefined;
  try {
    const info = await lstat(root, { bigint: true });
    const identity = Object.freeze({
      device: String(info.dev),
      inode: String(info.ino),
      birthtimeNs: String(info.birthtimeNs),
    });
    owned = Object.freeze({ root, capability: Object.freeze({ root, identity }) });
    const finalParent = await lstat(parent, { bigint: true });
    if (!sameOwnedIdentity(finalParent, parentIdentity) || !(await isCanonicalPath(parent))) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !(await isCanonicalPath(root))) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    return owned;
  } catch (error) {
    if (owned) {
      try {
        await removeOwnedRoot(owned);
      } catch (cleanupError) {
        if (cleanupError instanceof OwnedRootCleanupError) {
          throw new OwnedRootCreationError(cleanupError.owned, root);
        }
      }
      throw new OwnedRootCreationError(owned, root);
    }
    if (error instanceof FullDataImportError) throw error;
    throw new OwnedRootCreationError(undefined, root);
  }
}

async function assertOwnedRoot(owned: OwnedRoot): Promise<void> {
  const info = await lstat(owned.root, { bigint: true });
  const identity = owned.capability.identity;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !(await isCanonicalPath(owned.root)) ||
    String(info.dev) !== identity.device ||
    String(info.ino) !== identity.inode ||
    String(info.birthtimeNs) !== identity.birthtimeNs
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function assertOwnedChildDirectory(
  owner: OwnedRoot,
  childPath: string,
): Promise<PackageExtractionCapability> {
  await assertOwnedRoot(owner);
  const relative = path.relative(path.resolve(owner.root), path.resolve(childPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  const info = await lstat(childPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !(await isCanonicalPath(childPath))) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  await assertOwnedRoot(owner);
  return Object.freeze({
    path: childPath,
    identity: Object.freeze({
      device: String(info.dev),
      inode: String(info.ino),
      birthtimeNs: String(info.birthtimeNs),
    }),
  });
}

function sameOwnedIdentity(
  stats: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  identity: Readonly<{ device: string; inode: string; birthtimeNs: string }>,
): boolean {
  return (
    String(stats.dev) === identity.device &&
    String(stats.ino) === identity.inode &&
    String(stats.birthtimeNs) === identity.birthtimeNs
  );
}

type StableFileIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}>;

export type PreparedSettingsCandidateIntegrity = Readonly<
  StableFileIdentity & {
    sha256: string;
  }
>;

export type PreparedStagingDatabaseIntegrity = Readonly<
  StableFileIdentity & {
    sha256: string;
  }
>;

function stableFileIdentity(stats: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): StableFileIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    size: String(stats.size),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  });
}

function sameStableFileIdentity(
  stats: {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  expected: StableFileIdentity,
): boolean {
  const actual = stableFileIdentity(stats);
  return (
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.birthtimeNs === expected.birthtimeNs &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs
  );
}

async function assertOwnedExtraction(
  root: OwnedRoot,
  extraction: PackageExtractionCapability,
): Promise<void> {
  await assertOwnedRoot(root);
  const expected = path.resolve(extraction.path);
  const rootPath = path.resolve(root.root);
  const relative = path.relative(rootPath, expected);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(expected, { bigint: true });
  } catch {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !(await isCanonicalPath(expected)) ||
    !sameOwnedIdentity(info, extraction.identity)
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function ownedExtractionChild(
  owner: OwnedRoot,
  extraction: PackageExtractionCapability,
  relativePath: string,
): Promise<PackageExtractionCapability | undefined> {
  await assertOwnedExtraction(owner, extraction);
  const childPath = path.resolve(extraction.path, relativePath);
  const relative = path.relative(path.resolve(extraction.path), childPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(childPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !(await isCanonicalPath(childPath))) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  return Object.freeze({
    path: childPath,
    identity: Object.freeze({
      device: String(info.dev),
      inode: String(info.ino),
      birthtimeNs: String(info.birthtimeNs),
    }),
  });
}

type OwnedExtractionOperationGuard = Readonly<{
  owner: OwnedRoot;
  extraction: PackageExtractionCapability;
}>;

async function withOwnedExtractionOperation<T>(
  guards: readonly OwnedExtractionOperationGuard[],
  operation: () => Promise<T>,
): Promise<T> {
  for (const guard of guards) await assertOwnedExtraction(guard.owner, guard.extraction);
  let value: T | undefined;
  let operationError: unknown;
  let completed = false;
  try {
    value = await operation();
    completed = true;
  } catch (error) {
    operationError = error;
  }
  try {
    for (const guard of guards) await assertOwnedExtraction(guard.owner, guard.extraction);
  } catch {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  if (!completed) throw operationError;
  return value as T;
}

async function readOwnedExtractionFile(
  owner: OwnedRoot,
  extraction: PackageExtractionCapability,
  relativePath: string,
  expectedSha256?: string,
): Promise<Buffer> {
  await assertOwnedExtraction(owner, extraction);
  const filePath = path.resolve(extraction.path, relativePath);
  const relative = path.relative(path.resolve(extraction.path), filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(filePath, { bigint: true });
  } catch {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  if (!info.isFile() || info.isSymbolicLink() || !(await isCanonicalPath(filePath))) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  let handle: FileHandle | undefined;
  let bytes: Buffer | undefined;
  let failure: unknown;
  let failed = false;
  try {
    handle = await open(filePath, "r");
    const expectedIdentity = stableFileIdentity(info);
    const handleBefore = await handle.stat({ bigint: true });
    if (!sameStableFileIdentity(handleBefore, expectedIdentity)) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    bytes = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    if (
      !sameStableFileIdentity(handleAfter, expectedIdentity) ||
      !sameStableFileIdentity(pathAfter, expectedIdentity) ||
      handleAfter.size !== pathAfter.size
    ) {
      bytes.fill(0);
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    if (
      expectedSha256 !== undefined &&
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      bytes.fill(0);
      throw new FullDataImportError("PACKAGE_TAMPERED");
    }
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      failure ??= error;
      failed = true;
    }
    if (failed) bytes?.fill(0);
  }
  if (failed || failure !== undefined) {
    if (failure instanceof FullDataImportError) throw failure;
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  if (!bytes) throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  return bytes;
}

async function restoreOwnedDirectoryIfMissing(
  quarantinePath: string,
  originalPath: string,
): Promise<"restored" | "already-present" | "preserved"> {
  try {
    await lstat(originalPath);
    return "already-present";
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return "preserved";
  }
  try {
    await rename(quarantinePath, originalPath);
    return "restored";
  } catch {
    // Preserve the quarantined object when no-clobber restoration cannot be proven.
    return "preserved";
  }
}

async function removeOwnedExtraction(extraction: PackageExtractionCapability): Promise<void> {
  try {
    await removeOwnedPath(extraction.path, extraction.identity);
  } catch {
    throw new OwnedRootCleanupError({
      root: extraction.path,
      capability: { root: extraction.path, identity: extraction.identity },
    });
  }
}

async function removeOwnedRoot(owned: OwnedRoot): Promise<void> {
  try {
    await removeOwnedPath(owned.root, owned.capability.identity);
  } catch {
    throw new OwnedRootCleanupError(owned);
  }
}

async function moveOwnedExtraction(
  owner: OwnedRoot,
  extraction: PackageExtractionCapability,
  destination: string,
  extractionParent?: PackageExtractionCapability,
): Promise<void> {
  await assertOwnedExtraction(owner, extraction);
  if (extractionParent) await assertOwnedExtraction(owner, extractionParent);
  if (!samePath(path.dirname(path.resolve(destination)), path.resolve(owner.root))) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  await assertOwnedRoot(owner);
  try {
    if (extractionParent) await assertOwnedExtraction(owner, extractionParent);
    await lstat(destination);
    throw new FullDataImportError("UNSAFE_OVERWRITE");
  } catch (error) {
    if (error instanceof FullDataImportError) throw error;
    if (!isNodeError(error, "ENOENT")) throw new FullDataImportError("UNSAFE_OVERWRITE");
  }
  const quarantinePath = `${extraction.path}.move-${randomUUID()}`;
  try {
    await rename(extraction.path, quarantinePath);
  } catch {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  try {
    const first = await lstat(quarantinePath, { bigint: true });
    if (
      !first.isDirectory() ||
      first.isSymbolicLink() ||
      !(await isCanonicalPath(quarantinePath)) ||
      !sameOwnedIdentity(first, extraction.identity)
    ) {
      await restoreOwnedDirectoryIfMissing(quarantinePath, extraction.path);
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    const second = await lstat(quarantinePath, { bigint: true });
    if (
      !second.isDirectory() ||
      second.isSymbolicLink() ||
      !sameOwnedIdentity(second, extraction.identity)
    ) {
      await restoreOwnedDirectoryIfMissing(quarantinePath, extraction.path);
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    try {
      await lstat(destination);
      await restoreOwnedDirectoryIfMissing(quarantinePath, extraction.path);
      throw new FullDataImportError("UNSAFE_OVERWRITE");
    } catch (error) {
      if (error instanceof FullDataImportError) throw error;
      if (!isNodeError(error, "ENOENT")) throw new FullDataImportError("UNSAFE_OVERWRITE");
    }
    await rename(quarantinePath, destination);
    await assertOwnedRoot(owner);
    if (extractionParent) await assertOwnedExtraction(owner, extractionParent);
    const moved = await lstat(destination, { bigint: true });
    if (
      !moved.isDirectory() ||
      moved.isSymbolicLink() ||
      !(await isCanonicalPath(destination)) ||
      !sameOwnedIdentity(moved, extraction.identity)
    ) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
  } catch (error) {
    await restoreOwnedDirectoryIfMissing(quarantinePath, extraction.path);
    if (error instanceof FullDataImportError) throw error;
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function recursiveBytes(root: string): Promise<bigint> {
  let total = 0n;
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const info = await lstat(child, { bigint: true });
      if (info.isSymbolicLink()) throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
      if (info.isDirectory()) pending.push(child);
      else if (info.isFile()) total += info.size;
      else throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
  }
  return total;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(directory, "r");
  } catch (error) {
    if (
      process.platform === "win32" &&
      (isNodeError(error, "EPERM") || isNodeError(error, "EACCES"))
    ) {
      return;
    }
    throw error;
  }
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (
        process.platform !== "win32" ||
        (!isNodeError(error, "EPERM") && !isNodeError(error, "EACCES"))
      ) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

async function writeCandidate(candidatePath: string, settings: AppSettings): Promise<void> {
  const parentPath = path.dirname(path.resolve(candidatePath));
  const parentBefore = await lstat(parentPath, { bigint: true });
  const bytes = Buffer.from(`${JSON.stringify(AppSettingsSchema.parse(settings))}\n`, "utf8");
  if (
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink() ||
    !(await isCanonicalPath(parentPath))
  ) {
    bytes.fill(0);
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidatePath, "wx");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw new Error("Settings candidate write made no progress");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    bytes.fill(0);
    await handle?.close();
  }
  const parentAfter = await lstat(parentPath, { bigint: true });
  if (
    !sameOwnedIdentity(parentAfter, {
      device: String(parentBefore.dev),
      inode: String(parentBefore.ino),
      birthtimeNs: String(parentBefore.birthtimeNs),
    }) ||
    !(await isCanonicalPath(parentPath))
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  const candidate = await lstat(candidatePath, { bigint: true });
  if (
    !candidate.isFile() ||
    candidate.isSymbolicLink() ||
    !(await isCanonicalPath(candidatePath))
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  await syncDirectory(path.dirname(candidatePath));
}

async function capturePreparedFileIntegrity(
  candidatePath: string,
): Promise<PreparedSettingsCandidateIntegrity> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(candidatePath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || !(await isCanonicalPath(candidatePath))) {
      throw new Error("unsafe settings candidate");
    }
  } catch {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  const expected = stableFileIdentity(initial);
  let handle: FileHandle | undefined;
  let bytes: Buffer | undefined;
  let digest: string | undefined;
  let failure: unknown;
  try {
    handle = await open(candidatePath, "r");
    const before = await handle.stat({ bigint: true });
    if (!sameStableFileIdentity(before, expected)) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(candidatePath, { bigint: true });
    if (
      !sameStableFileIdentity(after, expected) ||
      !sameStableFileIdentity(pathAfter, expected) ||
      !(await isCanonicalPath(candidatePath))
    ) {
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    digest = createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      failure ??= error;
    }
    bytes?.fill(0);
  }
  if (failure !== undefined || digest === undefined) {
    if (failure instanceof FullDataImportError) throw failure;
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
  return Object.freeze({ ...expected, sha256: digest });
}

async function assertSettingsCandidateIntegrity(task: PreparedFullDataImport): Promise<void> {
  const actual = await capturePreparedFileIntegrity(task.settingsCandidatePath);
  if (
    actual.device !== task.settingsCandidateIntegrity.device ||
    actual.inode !== task.settingsCandidateIntegrity.inode ||
    actual.birthtimeNs !== task.settingsCandidateIntegrity.birthtimeNs ||
    actual.size !== task.settingsCandidateIntegrity.size ||
    actual.mtimeNs !== task.settingsCandidateIntegrity.mtimeNs ||
    actual.ctimeNs !== task.settingsCandidateIntegrity.ctimeNs ||
    actual.sha256 !== task.settingsCandidateIntegrity.sha256
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
}

async function assertStagingDatabaseIntegrity(task: PreparedFullDataImport): Promise<void> {
  const actual = await capturePreparedFileIntegrity(
    path.join(task.stagingLibraryPath, "library.sqlite3"),
  );
  if (
    actual.device !== task.stagingDatabaseIntegrity.device ||
    actual.inode !== task.stagingDatabaseIntegrity.inode ||
    actual.birthtimeNs !== task.stagingDatabaseIntegrity.birthtimeNs ||
    actual.size !== task.stagingDatabaseIntegrity.size ||
    actual.mtimeNs !== task.stagingDatabaseIntegrity.mtimeNs ||
    actual.ctimeNs !== task.stagingDatabaseIntegrity.ctimeNs ||
    actual.sha256 !== task.stagingDatabaseIntegrity.sha256
  ) {
    throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
  }
}

const defaultFileSystem: ImportFileSystem = Object.freeze({
  createOwnedRoot,
  removeOwnedRoot,
  recursiveBytes,
  writeCandidate,
  makeDirectory: async (directory) => await mkdir(directory),
  removeOwnedExtraction,
});

function delayForFailedAttempts(failures: number): number {
  if (failures < 3) return 0;
  if (failures < 6) return 2_000;
  return 5_000;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FullDataImportError("CANCELLED");
}

function normalizeError(error: unknown, signal?: AbortSignal): FullDataImportError {
  if (signal?.aborted) return new FullDataImportError("CANCELLED");
  if (error instanceof FullDataImportError) return error;
  if (error instanceof PackageReaderError) {
    if (error.code === "READER_STATE_INVALID") return new FullDataImportError("INTERNAL");
    return new FullDataImportError(error.code);
  }
  if (error instanceof ImportStagingValidationError) {
    return new FullDataImportError("PACKAGE_TAMPERED");
  }
  if (error instanceof DataTransferCryptoError) {
    return new FullDataImportError(error.code);
  }
  if (isNodeError(error, "ENOSPC") || isNodeError(error, "EFBIG")) {
    return new FullDataImportError("INSUFFICIENT_SPACE");
  }
  return new FullDataImportError("INTERNAL");
}

function manifestEntrySha256(manifest: TransferManifest, logicalPath: string): string {
  const entry = manifest.entries.find((candidate) => candidate.logicalPath === logicalPath);
  if (!entry) throw new FullDataImportError("PACKAGE_TAMPERED");
  return entry.sha256;
}

function manifestPayloadByRoot(manifest: TransferManifest): {
  library: bigint;
  userData: bigint;
} {
  let library = 0n;
  let userData = 0n;
  for (const entry of manifest.entries) {
    if (
      entry.kind === "legacy-draft" ||
      entry.kind === "text-polish-history" ||
      entry.kind === "settings"
    ) {
      userData += BigInt(entry.originalBytes);
    } else {
      library += BigInt(entry.originalBytes);
    }
  }
  return { library, userData };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class FullDataImportService {
  readonly #options: FullDataImportServiceOptions;
  readonly #fileSystem: ImportFileSystem;
  readonly #ownership: ImportStagingOwnership;
  readonly #prepared = new Map<string, PreparedImportRecord>();
  #active = false;
  #passwordFailures = 0;

  constructor(options: FullDataImportServiceOptions) {
    this.#options = options;
    this.#fileSystem = options.fileSystem ?? defaultFileSystem;
    this.#ownership = new ImportStagingOwnership(options);
  }

  getPreparedImport(operationId: string): PreparedFullDataImport | undefined {
    return this.#prepared.get(operationId)?.task;
  }

  async takePreparedImport(operationId: string): Promise<PreparedFullDataImport | undefined> {
    const prepared = this.#prepared.get(operationId);
    if (!prepared) return undefined;
    if (prepared.state !== "prepared" || !prepared.task) {
      throw new FullDataImportError("OPERATION_IN_PROGRESS");
    }
    this.#prepared.set(operationId, Object.freeze({ ...prepared, state: "taking" }));
    try {
      await Promise.all([
        assertSettingsCandidateIntegrity(prepared.task),
        assertStagingDatabaseIntegrity(prepared.task),
      ]);
    } catch (error) {
      const current = this.#prepared.get(operationId);
      if (current?.state === "taking") {
        this.#prepared.set(operationId, Object.freeze({ ...current, state: "cleanup-failed" }));
      }
      throw error;
    }
    const current = this.#prepared.get(operationId);
    if (current?.state !== "taking") throw new FullDataImportError("OPERATION_IN_PROGRESS");
    this.#prepared.set(operationId, Object.freeze({ ...current, state: "committing" }));
    return prepared.task;
  }

  async takePreparedImportLease(
    operationId: string,
  ): Promise<PreparedFullDataImportLease | undefined> {
    const prepared = await this.takePreparedImport(operationId);
    if (!prepared) return undefined;
    return Object.freeze({
      prepared,
      release: async (
        disposition: PreparedImportReleaseDisposition = "released",
        options: PreparedImportReleaseOptions = {},
      ) => await this.releasePreparedImport(operationId, disposition, options),
    });
  }

  async releasePreparedImport(
    operationId: string,
    disposition: PreparedImportReleaseDisposition = "released",
    options: PreparedImportReleaseOptions = {},
  ): Promise<void> {
    const prepared = this.#prepared.get(operationId);
    if (prepared?.state !== "committing") {
      throw new FullDataImportError("OPERATION_IN_PROGRESS");
    }
    if (!prepared.task) throw new FullDataImportError("OPERATION_IN_PROGRESS");
    if (disposition === "retryable") {
      this.#prepared.set(operationId, Object.freeze({ ...prepared, state: "prepared" }));
      return;
    }
    // Recovery ownership must not depend on a candidate that may already be
    // moved, damaged or unavailable. No cancellation path may retire its roots.
    if (disposition === "recovery-required") {
      this.#prepared.set(operationId, Object.freeze({ ...prepared, state: "recovery-required" }));
      return;
    }
    this.#prepared.set(operationId, Object.freeze({ ...prepared, state: "releasing" }));
    if (!options.settingsCandidateConsumed) {
      try {
        await assertSettingsCandidateIntegrity(prepared.task);
      } catch (error) {
        const current = this.#prepared.get(operationId);
        if (current?.state === "releasing") {
          this.#prepared.set(operationId, Object.freeze({ ...current, state: "cleanup-failed" }));
        }
        throw error;
      }
    }
    const current = this.#prepared.get(operationId);
    if (current?.state !== "releasing") throw new FullDataImportError("OPERATION_IN_PROGRESS");
    // A published swap journal now owns the rollback and staging roots.
    // Without that journal, releasing a lease is equivalent to cancellation.
    const journalPath = path.join(this.#options.applicationDataRoot, "pending-data-import.json");
    const journalExists = await lstat(journalPath).then(
      () => true,
      (error) => {
        if (isNodeError(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (!journalExists) {
      this.#prepared.set(operationId, Object.freeze({ ...current, state: "prepared" }));
      await this.discardPreparedImport(operationId);
    } else this.#prepared.delete(operationId);
  }

  async retirePreparedImport(operationId: string): Promise<readonly string[]> {
    await this.discardPreparedImport(operationId);
    return Object.freeze([]);
  }

  async discardPreparedImport(operationId: string): Promise<void> {
    const prepared = this.#prepared.get(operationId);
    if (!prepared) return;
    if (prepared.state === "recovery-required")
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    if (prepared.state !== "prepared" && prepared.state !== "cleanup-failed") {
      throw new FullDataImportError("OPERATION_IN_PROGRESS");
    }
    this.#prepared.set(operationId, Object.freeze({ ...prepared, state: "cleaning" }));
    const failedRoots = await this.#removeOwnedRoots(prepared.roots);
    if (failedRoots.length > 0) {
      this.#prepared.set(
        operationId,
        Object.freeze({ ...prepared, state: "cleanup-failed", roots: failedRoots }),
      );
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    try {
      await this.#ownership.finish();
    } catch {
      this.#prepared.set(
        operationId,
        Object.freeze({ ...prepared, state: "cleanup-failed", roots: Object.freeze([]) }),
      );
      throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
    }
    this.#prepared.delete(operationId);
  }

  async #removeOwnedRoots(roots: readonly RecoveryRoot[]): Promise<readonly RecoveryRoot[]> {
    const failed: RecoveryRoot[] = [];
    for (const root of [...roots].reverse()) {
      if (!root.capability) {
        failed.push(root);
        continue;
      }
      const owned: OwnedRoot = { root: root.root, capability: root.capability };
      try {
        await this.#fileSystem.removeOwnedRoot(owned);
      } catch (error) {
        failed.push(error instanceof OwnedRootCleanupError ? error.owned : owned);
      }
    }
    return Object.freeze(failed);
  }

  async prepareImport(
    untrustedRequest: FullDataImportPrepareRequest & Readonly<{ signal?: AbortSignal }>,
  ): Promise<FullDataImportPreview> {
    if (this.#active || this.#prepared.size > 0) {
      throw new FullDataImportError("OPERATION_IN_PROGRESS");
    }
    this.#active = true;
    let reader: ImportReader | undefined;
    const roots: OwnedRoot[] = [];
    let successful = false;
    let operationId: string | undefined;
    let readerCloseAttempted = false;
    let ownershipStarted = false;
    const signal = untrustedRequest.signal;
    try {
      const parsedRequest = FullDataImportPrepareRequestSchema.safeParse({
        operationId: untrustedRequest.operationId,
        sourceSelectionId: untrustedRequest.sourceSelectionId,
        password: untrustedRequest.password,
      });
      if (!parsedRequest.success) throw new FullDataImportError("INVALID_INPUT");
      const request = parsedRequest.data;
      if (!UUID_V4_PATTERN.test(request.operationId)) {
        throw new FullDataImportError("INVALID_INPUT");
      }
      operationId = request.operationId;
      checkAbort(signal);
      const inspection = await this.#options.inspector.inspect();
      if (!inspection.empty) throw new FullDataImportError("LIBRARY_NOT_EMPTY");
      checkAbort(signal);

      const selection = await this.#options.resolveSourceSelection(request.sourceSelectionId);
      if (selection.selectionId !== request.sourceSelectionId) {
        throw new FullDataImportError("INVALID_INPUT");
      }
      reader = await (this.#options.readerFactory ?? ((source) => PackageReader.open(source)))(
        selection.sourceHandle,
      );
      await reader.readPublicHeader();
      const delay = delayForFailedAttempts(this.#passwordFailures);
      if (delay > 0) await (this.#options.sleep ?? defaultSleep)(delay);
      checkAbort(signal);
      try {
        await reader.unlock(request.password);
        this.#passwordFailures = 0;
      } catch (error) {
        if (error instanceof PackageReaderError && error.code === "PASSWORD_OR_PACKAGE_INVALID") {
          this.#passwordFailures += 1;
        }
        throw error;
      }
      const manifest = await reader.scanManifest(signal);
      checkAbort(signal);

      const libraryParent = path.dirname(path.resolve(this.#options.libraryRoot));
      const userDataParent = path.dirname(path.resolve(this.#options.userDataRoot));
      await this.#ownership.begin(request.operationId);
      ownershipStarted = true;
      const libraryOwned = await this.#fileSystem.createOwnedRoot(
        libraryParent,
        `${IMPORT_STAGING_PREFIX}${request.operationId}`,
      );
      roots.push(libraryOwned);
      await this.#ownership.register(libraryOwned.root, libraryOwned.capability.identity);
      const userDataOwned = await this.#fileSystem.createOwnedRoot(
        userDataParent,
        `${IMPORT_USER_DATA_PREFIX}${request.operationId}`,
      );
      roots.push(userDataOwned);
      await this.#ownership.register(userDataOwned.root, userDataOwned.capability.identity);

      const [currentLibraryBytes, currentDraftBytes, currentPolishBytes] = await Promise.all([
        this.#fileSystem.recursiveBytes(this.#options.libraryRoot),
        this.#fileSystem.recursiveBytes(path.join(this.#options.userDataRoot, "drafts")),
        this.#fileSystem.recursiveBytes(
          path.join(this.#options.userDataRoot, "text-polish-history"),
        ),
      ]);
      let currentSettingsBytes = 0n;
      try {
        currentSettingsBytes = BigInt(
          (await lstat(path.join(this.#options.userDataRoot, "settings.json"), { bigint: true }))
            .size,
        );
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      const payload = manifestPayloadByRoot(manifest);
      await (this.#options.preflightSpace ?? preflightFullDataImportSpace)({
        libraryParent,
        userDataParent,
        totalOriginalBytes: BigInt(manifest.totalOriginalBytes),
        currentLibraryBytes,
        currentUserDataBytes: currentDraftBytes + currentPolishBytes + currentSettingsBytes,
        libraryPayloadBytes: payload.library,
        userDataPayloadBytes: payload.userData,
      });
      checkAbort(signal);

      const extraction = await reader.extractTo(
        { libraryRoot: libraryOwned.root, userDataRoot: userDataOwned.root },
        signal,
      );
      checkAbort(signal);
      const layout = extraction.stagingPaths;
      const capabilities = extraction.stagingCapabilities;
      if (
        !layout ||
        !capabilities ||
        !samePath(layout.library, capabilities.library.path) ||
        !samePath(layout.userData, capabilities.userData.path) ||
        !jsonEqual(extraction.manifest, manifest)
      ) {
        throw new FullDataImportError("PACKAGE_TAMPERED");
      }
      await assertOwnedExtraction(libraryOwned, capabilities.library);
      await assertOwnedExtraction(userDataOwned, capabilities.userData);
      let libraryDirectory: PackageExtractionCapability | undefined;
      let legacyDraftsDirectory: PackageExtractionCapability | undefined;
      let validationSummary: ImportStagingValidationSummary;
      libraryDirectory = await ownedExtractionChild(libraryOwned, capabilities.library, "library");
      if (!libraryDirectory) throw new FullDataImportError("PACKAGE_TAMPERED");
      const importedLibraryDirectory = libraryDirectory;
      legacyDraftsDirectory = await ownedExtractionChild(
        userDataOwned,
        capabilities.userData,
        "legacy-drafts",
      );
      checkAbort(signal);
      const validationGuards: OwnedExtractionOperationGuard[] = [
        { owner: libraryOwned, extraction: capabilities.library },
        { owner: libraryOwned, extraction: importedLibraryDirectory },
        { owner: userDataOwned, extraction: capabilities.userData },
      ];
      if (legacyDraftsDirectory) {
        validationGuards.push({ owner: userDataOwned, extraction: legacyDraftsDirectory });
      }
      validationSummary = await withOwnedExtractionOperation(validationGuards, () =>
        (this.#options.validator ?? new ImportStagingValidator()).validate(
          {
            libraryRoot: layout.library,
            userDataRoot: layout.userData,
            libraryCapability: {
              root: capabilities.library.path,
              identity: capabilities.library.identity,
            },
            userDataCapability: {
              root: capabilities.userData.path,
              identity: capabilities.userData.identity,
            },
            libraryDirectoryCapability: {
              root: importedLibraryDirectory.path,
              identity: importedLibraryDirectory.identity,
            },
            ...(legacyDraftsDirectory
              ? {
                  legacyDraftsCapability: {
                    root: legacyDraftsDirectory.path,
                    identity: legacyDraftsDirectory.identity,
                  },
                }
              : {}),
          },
          manifest,
        ),
      );
      checkAbort(signal);
      if (!jsonEqual(validationSummary, manifest.summary)) {
        throw new FullDataImportError("PACKAGE_TAMPERED");
      }

      await assertOwnedExtraction(libraryOwned, capabilities.library);
      await assertOwnedExtraction(userDataOwned, capabilities.userData);
      const portableBytes = await readOwnedExtractionFile(
        userDataOwned,
        capabilities.userData,
        "portable-settings.json",
        manifestEntrySha256(manifest, "portable-settings.json"),
      );
      let portable: ReturnType<typeof PortableSettingsSchema.parse>;
      try {
        portable = PortableSettingsSchema.parse(JSON.parse(portableBytes.toString("utf8")));
      } catch {
        throw new FullDataImportError("PACKAGE_TAMPERED");
      } finally {
        portableBytes.fill(0);
      }
      const currentSettings = AppSettingsSchema.parse(await this.#options.readCurrentSettings());
      const merged = mergePortableSettings(
        currentSettings,
        portable,
        this.#options.createId ?? randomUUID,
      );
      const settingsCandidatePath = path.join(
        userDataOwned.root,
        `settings-candidate-${request.operationId}.json`,
      );
      await assertOwnedRoot(libraryOwned);
      await assertOwnedRoot(userDataOwned);
      await this.#fileSystem.writeCandidate(settingsCandidatePath, merged);
      const settingsCandidateIntegrity = await capturePreparedFileIntegrity(settingsCandidatePath);
      await assertOwnedRoot(userDataOwned);
      checkAbort(signal);

      const stagingLibraryPath = path.join(libraryOwned.root, "library");
      if (!libraryDirectory) throw new FullDataImportError("PACKAGE_TAMPERED");
      await moveOwnedExtraction(
        libraryOwned,
        libraryDirectory,
        stagingLibraryPath,
        capabilities.library,
      );
      const stagingDraftsPath = path.join(userDataOwned.root, "drafts");
      if (legacyDraftsDirectory) {
        await moveOwnedExtraction(
          userDataOwned,
          legacyDraftsDirectory,
          stagingDraftsPath,
          capabilities.userData,
        );
      } else {
        await assertOwnedRoot(userDataOwned);
        await this.#fileSystem.makeDirectory(stagingDraftsPath);
        legacyDraftsDirectory = await assertOwnedChildDirectory(userDataOwned, stagingDraftsPath);
      }
      const stagingPolishHistoryPath = path.join(userDataOwned.root, "text-polish-history");
      const polishDirectory = await ownedExtractionChild(
        userDataOwned,
        capabilities.userData,
        "text-polish-history",
      );
      if (polishDirectory) {
        await moveOwnedExtraction(
          userDataOwned,
          polishDirectory,
          stagingPolishHistoryPath,
          capabilities.userData,
        );
      } else {
        // Old packages carry no polish state. Install an empty root, never reuse target history.
        await assertOwnedRoot(userDataOwned);
        await this.#fileSystem.makeDirectory(stagingPolishHistoryPath);
        await assertOwnedChildDirectory(userDataOwned, stagingPolishHistoryPath);
      }
      await assertOwnedExtraction(libraryOwned, capabilities.library);
      await assertOwnedExtraction(userDataOwned, capabilities.userData);
      const stagingDatabaseIntegrity = await capturePreparedFileIntegrity(
        path.join(stagingLibraryPath, "library.sqlite3"),
      );

      const preview = FullDataImportPreviewSchema.parse({
        operationId: request.operationId,
        packageId: manifest.packageId,
        exportedAt: manifest.exportedAt,
        summary: manifest.summary,
        packageVerified: true,
        versionCompatible: true,
        targetLibraryEmpty: true,
        settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
      });
      const task: PreparedFullDataImport = Object.freeze({
        operationId: request.operationId,
        packageId: manifest.packageId,
        manifest,
        preview,
        stagingLibraryPath,
        stagingDraftsPath,
        stagingPolishHistoryPath,
        settingsCandidatePath,
        settingsCandidateIntegrity,
        stagingDatabaseIntegrity,
        libraryStagingCapability: libraryOwned.capability,
        userDataStagingCapability: userDataOwned.capability,
      });
      this.#prepared.set(
        request.operationId,
        Object.freeze({ state: "prepared", task, roots: Object.freeze([...roots]) }),
      );
      successful = true;
      readerCloseAttempted = true;
      try {
        await reader?.close();
      } catch {
        this.#prepared.set(
          request.operationId,
          Object.freeze({ state: "cleanup-failed", task, roots: Object.freeze([...roots]) }),
        );
        throw new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
      }
      this.#active = false;
      return preview;
    } catch (error) {
      let normalized = normalizeError(error, signal);
      const readerRecoveryPaths =
        error instanceof PackageReaderError ? error.recoveryPaths : ([] as readonly string[]);
      const creationFailure = error instanceof OwnedRootCreationError ? error : undefined;
      if (creationFailure?.owned) roots.push(creationFailure.owned);
      if (!successful) {
        const failedRoots = creationFailure
          ? await this.#removeOwnedRoots(creationFailure.owned ? roots.slice(0, -1) : roots)
          : await this.#removeOwnedRoots(roots);
        const recoveryRoots = Object.freeze([
          ...failedRoots,
          ...(creationFailure
            ? [creationFailure.owned ?? { root: creationFailure.createdRoot }]
            : []),
          ...readerRecoveryPaths.map((root) => ({ root })),
        ]);
        if (recoveryRoots.length > 0 && operationId) {
          this.#prepared.set(
            operationId,
            Object.freeze({ state: "cleanup-failed", roots: recoveryRoots }),
          );
          normalized = new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
        } else if (creationFailure && operationId) {
          this.#prepared.set(
            operationId,
            Object.freeze({ state: "cleanup-failed", roots: Object.freeze([]) }),
          );
          normalized = new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
        }
        if (
          recoveryRoots.length === 0 &&
          !creationFailure &&
          (ownershipStarted || this.#ownership.hasOwnedPreparation)
        ) {
          try {
            await this.#ownership.finish();
          } catch {
            if (operationId)
              this.#prepared.set(
                operationId,
                Object.freeze({ state: "cleanup-failed", roots: Object.freeze([]) }),
              );
            normalized = new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
          }
        }
      }
      let closeFailure = false;
      if (!readerCloseAttempted) {
        readerCloseAttempted = true;
        try {
          await reader?.close();
        } catch {
          closeFailure = true;
        }
      }
      if (closeFailure) {
        const current = operationId ? this.#prepared.get(operationId) : undefined;
        if (operationId && current) {
          this.#prepared.set(operationId, Object.freeze({ ...current, state: "cleanup-failed" }));
        } else if (operationId) {
          this.#prepared.set(
            operationId,
            Object.freeze({ state: "cleanup-failed", roots: Object.freeze([]) }),
          );
        }
        normalized = new FullDataImportError("IMPORT_RECOVERY_REQUIRED");
      }
      this.#active = false;
      throw normalized;
    }
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
