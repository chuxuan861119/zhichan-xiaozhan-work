import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import crypto, { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { createReadStream } from "node:fs";
import {
  link as linkFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  unlink as unlinkFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  DataTransferLibrarySummary,
  TransferManifest,
  TransferManifestEntry,
} from "../../shared/data-transfer/model.js";
import {
  type PortableSettings,
  PortableSettingsSchema,
  projectPortableSettings,
} from "../../shared/data-transfer/portable-settings.js";
import { CANONICAL_PATENT_FORMAT_VERSION } from "../../shared/patent/model.js";
import { type FileService, installNewFileWithoutClobber } from "../documents/file-service.js";
import type { DraftService } from "../drafts/draft-service.js";
import { LibraryDatabase } from "../library/library-database.js";
import { CURRENT_SCHEMA_VERSION, validateCurrentSchema } from "../library/schema.js";
import { usesHarmonyPublicFileCopy } from "../platform/harmony-public-files.js";
import { moveNoReplaceHarmony, moveNoReplaceMac } from "../platform/move-no-replace.js";
import type { SettingsService } from "../settings/settings-service.js";
import {
  DataTransferOperationError,
  type DataTransferOperationGate,
  getDataTransferOperationGate,
} from "./data-transfer-operation-gate.js";
import {
  type DataTransferQuiescence,
  DataTransferQuiescenceError,
  type DataTransferQuiescenceLease,
} from "./data-transfer-quiescence.js";
import {
  ExportSourceSnapshot,
  ExportSourceSnapshotError,
  type ExportSourceSnapshotRequest,
  type ExportSourceSnapshotSummary,
} from "./export-source-snapshot.js";
import {
  createOwnedExportTask,
  type ExportTaskReceipt,
  readOwnedExportTask,
  recordExportTaskFiles,
  removeOwnedExportTaskRoot,
} from "./export-task-recovery.js";
import { ImportStagingValidator } from "./import-staging-validator.js";
import {
  type PackageExtractionResult,
  PackageReader,
  PackageReaderError,
} from "./package-reader.js";
import {
  type PackageFileIdentity,
  PackageWriter,
  type PackageWriterCreateOptions,
  type PackageWriterEntry,
  PackageWriterError,
  type PackageWriterManifestMetadata,
  type PackageWriterProgress,
} from "./package-writer.js";

/*
 * Concrete transfer errors above are safe to return because their messages are
 * deliberately normalized and contain no paths, passwords, or business names.
 */
type SafeTransferError = DataTransferOperationError | DataTransferQuiescenceError;

const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;
const SPACE_MARGIN_BYTES = 512n * MIB;
const DEFAULT_MANIFEST_AND_TEMP_BYTES = 64n * MIB;
const HARD_LINK_UNSUPPORTED_CODES = new Set(["EXDEV", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP"]);
const WINDOWS_MOVE_NO_REPLACE_SCRIPT = Buffer.from(
  [
    "$ErrorActionPreference='Stop'",
    "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    "try{[IO.File]::Move($s,$t);[Console]::Out.Write('OK')}catch [IO.IOException]{",
    "  $n=$_.Exception.HResult -band 0xFFFF",
    "  if([IO.File]::Exists($t)){[Console]::Out.Write('EEXIST')}",
    "  elseif($n -eq 112){[Console]::Out.Write('ENOSPC')}",
    "  elseif($n -eq 223){[Console]::Out.Write('EFBIG')}",
    "  else{[Console]::Out.Write('EIO')} ",
    "}catch [UnauthorizedAccessException]{[Console]::Out.Write('EACCES')}",
  ].join("\n"),
  "utf16le",
).toString("base64");
const WINDOWS_FILE_ATTRIBUTES_SCRIPT = Buffer.from(
  [
    "$ErrorActionPreference='Stop'",
    "while(($l=[Console]::In.ReadLine()) -ne $null){",
    "  try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l));[Console]::Out.WriteLine([int64][IO.File]::GetAttributes($p))}",
    "  catch{[Console]::Out.WriteLine('ERR')}",
    "}",
  ].join("\n"),
  "utf16le",
).toString("base64");
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const WINDOWS_ATTRIBUTES_TIMEOUT_MS = 2_000;

export type FullDataExportServiceErrorCode =
  | "CANCELLED"
  | "DESTINATION_UNAVAILABLE"
  | "EXPORT_FAILED"
  | "INSUFFICIENT_SPACE"
  | "INTERNAL"
  | "PACKAGE_TAMPERED"
  | "SOURCE_SAVE_FAILED"
  | "UNSAFE_OVERWRITE";

export class FullDataExportError extends Error {
  override readonly name = "FullDataExportError";

  constructor(
    readonly code: FullDataExportServiceErrorCode,
    readonly scope?: "source" | "target",
  ) {
    super(code);
  }
}

export type FullDataExportDestinationDependencies = Readonly<{
  platform?: NodeJS.Platform;
  lstat?: (path: string) => ReturnType<typeof lstat>;
  realpath?: (path: string) => Promise<string>;
  probeWindowsFileAttributes?: (
    paths: readonly string[],
    signal?: AbortSignal,
  ) => Promise<readonly number[]>;
}>;

async function probeWindowsFileAttributes(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<readonly number[]> {
  if (signal?.aborted) throw new FullDataExportError("CANCELLED");
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_FILE_ATTRIBUTES_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  child.stdin.end(
    `${paths.map((candidate) => Buffer.from(candidate, "utf8").toString("base64")).join("\n")}\n`,
    "ascii",
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new FullDataExportError("DESTINATION_UNAVAILABLE"));
    }, WINDOWS_ATTRIBUTES_TIMEOUT_MS);
    const abort = () => {
      child.kill();
      reject(new FullDataExportError("CANCELLED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (callback: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    child.once("error", () =>
      settle(() => reject(new FullDataExportError("DESTINATION_UNAVAILABLE"))),
    );
    child.once("close", (code) =>
      settle(() =>
        code === 0 ? resolve() : reject(new FullDataExportError("DESTINATION_UNAVAILABLE")),
      ),
    );
  });
  const lines = Buffer.concat(output).toString("utf8").trim().split(/\r?\n/u);
  if (lines.length !== paths.length || lines.some((line) => !/^\d+$/u.test(line))) {
    throw new FullDataExportError("DESTINATION_UNAVAILABLE");
  }
  return Object.freeze(lines.map(Number));
}

function platformPathEquals(left: string, right: string, platform: NodeJS.Platform): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isInsidePlatformPath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const normalizedParent = platform === "win32" ? path.resolve(parent).toLowerCase() : parent;
  const normalizedChild = platform === "win32" ? path.resolve(child).toLowerCase() : child;
  return isInsidePath(normalizedParent, normalizedChild);
}

export async function validateFullDataExportDestinationDirectory(
  destinationDirectory: string,
  libraryRoot: string,
  dependencies: FullDataExportDestinationDependencies = {},
  signal?: AbortSignal,
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const inspect = dependencies.lstat ?? lstat;
  const resolveRealPath = dependencies.realpath ?? realpath;
  const resolvedDestination = path.resolve(destinationDirectory);
  const parsed = path.parse(resolvedDestination);
  const components = [parsed.root];
  let current = parsed.root;
  const remainder = path.relative(parsed.root, resolvedDestination);
  if (remainder) {
    for (const segment of remainder.split(path.sep)) {
      current = path.join(current, segment);
      components.push(current);
    }
  }
  try {
    for (const component of components) {
      checkServiceAbort(signal);
      const stats = await inspect(component);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new FullDataExportError("DESTINATION_UNAVAILABLE");
      }
    }
    if (platform === "win32") {
      const attributes = await (
        dependencies.probeWindowsFileAttributes ?? probeWindowsFileAttributes
      )(components, signal);
      if (
        attributes.length !== components.length ||
        attributes.some((value) => (value & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0)
      ) {
        throw new FullDataExportError("DESTINATION_UNAVAILABLE");
      }
    }
    const [canonicalLibraryRoot, canonicalDestination] = await Promise.all([
      resolveRealPath(path.resolve(libraryRoot)),
      resolveRealPath(resolvedDestination),
    ]);
    if (!platformPathEquals(canonicalDestination, resolvedDestination, platform)) {
      throw new FullDataExportError("DESTINATION_UNAVAILABLE");
    }
    if (
      platformPathEquals(canonicalLibraryRoot, canonicalDestination, platform) ||
      isInsidePlatformPath(canonicalLibraryRoot, canonicalDestination, platform)
    ) {
      throw new TypeError("Export destination cannot be inside the library");
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof FullDataExportError) throw error;
    throw new FullDataExportError("DESTINATION_UNAVAILABLE");
  }
}

export type FullDataExportWarning =
  | "BACKGROUND_RESUME_FAILED"
  | "CLEANUP_FAILED"
  | "DIRECTORY_SYNC_UNAVAILABLE"
  | "FAT32_OVER_4_GIB"
  | "PARTIAL_CLEANUP_FAILED"
  | "PROGRESS_DELIVERY_FAILED";

export type FullDataExportSpaceBudget = Readonly<{
  sourceRequiredBytes: bigint;
  targetRequiredBytes: bigint;
  warnings: readonly FullDataExportWarning[];
}>;

export type FullDataExportSpaceInput = Readonly<{
  databaseBytes: bigint;
  estimatedPackageBytes: bigint;
  stagedPackageBytes?: bigint;
  manifestAndTempBytes?: bigint;
}>;

function assertNonNegativeBytes(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("Invalid byte estimate");
}

function tenPercentCeiling(value: bigint): bigint {
  return (value + 9n) / 10n;
}

export function calculateFullDataExportSpaceBudget(
  input: FullDataExportSpaceInput,
): FullDataExportSpaceBudget {
  const manifestAndTempBytes = input.manifestAndTempBytes ?? DEFAULT_MANIFEST_AND_TEMP_BYTES;
  assertNonNegativeBytes(input.databaseBytes);
  assertNonNegativeBytes(input.estimatedPackageBytes);
  assertNonNegativeBytes(manifestAndTempBytes);
  const stagedPackageBytes = input.stagedPackageBytes ?? 0n;
  assertNonNegativeBytes(stagedPackageBytes);
  // The estimate is the uncompressed dataset, not just the encrypted output.
  // Frozen data and full verification extraction coexist in the source work root.
  const datasetBytes =
    input.estimatedPackageBytes > input.databaseBytes
      ? input.estimatedPackageBytes
      : input.databaseBytes;
  const sourcePeak = 2n * datasetBytes + stagedPackageBytes;
  const sourceMargin =
    tenPercentCeiling(sourcePeak) > SPACE_MARGIN_BYTES
      ? tenPercentCeiling(sourcePeak)
      : SPACE_MARGIN_BYTES;
  const targetMargin =
    tenPercentCeiling(input.estimatedPackageBytes) > SPACE_MARGIN_BYTES
      ? tenPercentCeiling(input.estimatedPackageBytes)
      : SPACE_MARGIN_BYTES;
  return Object.freeze({
    sourceRequiredBytes: sourcePeak + manifestAndTempBytes + sourceMargin,
    targetRequiredBytes: input.estimatedPackageBytes + targetMargin,
    warnings: Object.freeze(
      input.estimatedPackageBytes > 4n * GIB ? (["FAT32_OVER_4_GIB"] as const) : ([] as const),
    ),
  });
}

type StatFsResult = Readonly<{ bavail: bigint; bsize: bigint }>;
type SpacePreflightDependencies = Readonly<{
  statfs?: (path: string) => Promise<StatFsResult>;
  statDevice?: (path: string) => Promise<bigint>;
}>;

export type FullDataExportSpacePreflightInput = FullDataExportSpaceInput &
  Readonly<{ sourcePath: string; targetDirectory: string }>;

export type FullDataExportSpacePreflightResult = FullDataExportSpaceBudget &
  Readonly<{
    sourceAvailableBytes: bigint;
    targetAvailableBytes: bigint;
    sameVolume: boolean;
  }>;

async function defaultStatFs(filePath: string): Promise<StatFsResult> {
  const value = await statfs(filePath, { bigint: true });
  return { bavail: value.bavail, bsize: value.bsize };
}

async function defaultStatDevice(filePath: string): Promise<bigint> {
  return (await stat(filePath, { bigint: true })).dev;
}

function availableBytes(value: StatFsResult): bigint {
  if (value.bavail < 0n || value.bsize <= 0n) throw new Error("Invalid statfs result");
  return value.bavail * value.bsize;
}

function safeAddBytes(left: bigint, right: bigint): bigint {
  if (left < 0n || right < 0n) throw new Error("Invalid byte budget");
  return left + right;
}

export async function preflightFullDataExportSpace(
  input: FullDataExportSpacePreflightInput,
  dependencies: SpacePreflightDependencies = {},
): Promise<FullDataExportSpacePreflightResult> {
  const readStatFs = dependencies.statfs ?? defaultStatFs;
  const readDevice = dependencies.statDevice ?? defaultStatDevice;
  const budget = calculateFullDataExportSpaceBudget(input);
  try {
    const [sourceFs, targetFs, sourceDevice, targetDevice] = await Promise.all([
      readStatFs(input.sourcePath),
      readStatFs(input.targetDirectory),
      readDevice(input.sourcePath),
      readDevice(input.targetDirectory),
    ]);
    const sourceAvailableBytes = availableBytes(sourceFs);
    const targetAvailableBytes = availableBytes(targetFs);
    const sameVolume = sourceDevice === targetDevice;
    if (sameVolume) {
      const required = safeAddBytes(budget.sourceRequiredBytes, budget.targetRequiredBytes);
      if (sourceAvailableBytes < required || targetAvailableBytes < required) {
        throw new FullDataExportError(
          "INSUFFICIENT_SPACE",
          budget.sourceRequiredBytes >= budget.targetRequiredBytes ? "source" : "target",
        );
      }
    } else {
      if (sourceAvailableBytes < budget.sourceRequiredBytes) {
        throw new FullDataExportError("INSUFFICIENT_SPACE", "source");
      }
      if (targetAvailableBytes < budget.targetRequiredBytes) {
        throw new FullDataExportError("INSUFFICIENT_SPACE", "target");
      }
    }
    return Object.freeze({
      ...budget,
      sourceAvailableBytes,
      targetAvailableBytes,
      sameVolume,
    });
  } catch (error) {
    if (error instanceof FullDataExportError) throw error;
    throw new FullDataExportError("DESTINATION_UNAVAILABLE");
  }
}

export type FullDataExportProgressPhase =
  | "cancelled"
  | "checkpointing"
  | "collecting-data"
  | "completed"
  | "encrypting"
  | "failed"
  | "inspecting"
  | "publishing-package"
  | "quiescing-writes"
  | "verifying-package";

export type FullDataExportProgress = Readonly<{
  operationId: string;
  kind: "full-data-export";
  phase: FullDataExportProgressPhase;
  percent: number | null;
  processedBytes: number;
  totalBytes: number | null;
  elapsedMs: number;
  etaMs: number | null;
  currentCategory: "database" | "assets" | "settings" | "verification";
}>;

type ProgressReporterOptions = Readonly<{
  operationId: string;
  now?: () => number;
  onProgress?: (progress: FullDataExportProgress) => void;
}>;

export function createFullDataExportProgressReporter(options: ProgressReporterOptions) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let lastPhase: FullDataExportProgressPhase | undefined;
  const samples: Array<{ at: number; bytes: number }> = [];
  return (
    phase: FullDataExportProgressPhase,
    processedBytes: number,
    totalBytes: number | null,
    currentCategory: FullDataExportProgress["currentCategory"],
  ): void => {
    if (
      !Number.isSafeInteger(processedBytes) ||
      processedBytes < 0 ||
      (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || totalBytes < 0))
    ) {
      throw new TypeError("Invalid progress bytes");
    }
    const at = now();
    if (phase === lastPhase && at - lastEmittedAt < 100) return;
    samples.push({ at, bytes: processedBytes });
    while (samples.length > 1 && (samples[0]?.at ?? at) < at - 10_000) samples.shift();
    const first = samples[0];
    const elapsedSampleMs = first ? at - first.at : 0;
    const processedSampleBytes = first ? processedBytes - first.bytes : 0;
    let etaMs: number | null = null;
    if (
      totalBytes !== null &&
      totalBytes > processedBytes &&
      elapsedSampleMs > 0 &&
      processedSampleBytes > 0
    ) {
      etaMs = Math.max(
        0,
        Math.round(((totalBytes - processedBytes) * elapsedSampleMs) / processedSampleBytes),
      );
    }
    const percent =
      totalBytes === null
        ? null
        : totalBytes === 0
          ? 100
          : Math.min(100, Math.max(0, (processedBytes / totalBytes) * 100));
    const progress = Object.freeze({
      operationId: options.operationId,
      kind: "full-data-export" as const,
      phase,
      percent,
      processedBytes,
      totalBytes,
      elapsedMs: Math.max(0, Math.round(at - startedAt)),
      etaMs,
      currentCategory,
    });
    try {
      options.onProgress?.(progress);
    } catch {
      throw new FullDataExportError("INTERNAL");
    }
    lastPhase = phase;
    lastEmittedAt = at;
  };
}

type PublishDependencies = Readonly<{
  platform?: NodeJS.Platform;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  moveNoReplace?: (sourcePath: string, targetPath: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
  retainSource?: boolean;
}>;

export type PublishCompletedPackageResult = Readonly<{
  warnings: readonly FullDataExportWarning[];
}>;

async function moveFileNoReplaceWindows(sourcePath: string, targetPath: string): Promise<void> {
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_MOVE_NO_REPLACE_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  child.stdin.end(
    `${Buffer.from(sourcePath, "utf8").toString("base64")}\n${Buffer.from(targetPath, "utf8").toString("base64")}\n`,
    "ascii",
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const result = Buffer.concat(output).toString("utf8");
  if (result === "OK") return;
  throw Object.assign(new Error("Windows no-replace move failed"), { code: result || "EIO" });
}

async function moveFileNoReplace(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") return moveFileNoReplaceWindows(sourcePath, targetPath);
  if (platform === "darwin") return moveNoReplaceMac(sourcePath, targetPath);
  if (["openharmony", "ohos"].includes(platform))
    return moveNoReplaceHarmony(sourcePath, targetPath);
  throw Object.assign(new Error("Atomic no-replace move is unsupported"), {
    code: "UNSUPPORTED_ATOMIC_SWAP",
  });
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function mapPublishError(error: unknown): FullDataExportError {
  const code = nativeErrorCode(error);
  if (code === "EEXIST") return new FullDataExportError("UNSAFE_OVERWRITE");
  if (code === "EFBIG" || code === "ENOSPC") {
    return new FullDataExportError("INSUFFICIENT_SPACE", "target");
  }
  return new FullDataExportError("DESTINATION_UNAVAILABLE");
}

export async function publishCompletedPackage(
  partialPath: string,
  finalPath: string,
  dependencies: PublishDependencies = {},
): Promise<PublishCompletedPackageResult> {
  const resolvedPartialPath = path.resolve(partialPath);
  const resolvedFinalPath = path.resolve(finalPath);
  if (
    path.dirname(resolvedPartialPath) !== path.dirname(resolvedFinalPath) ||
    !resolvedPartialPath.toLowerCase().endsWith(".zxwbackup.partial") ||
    path.extname(resolvedFinalPath).toLowerCase() !== ".zxwbackup"
  ) {
    throw new TypeError("Invalid completed package publication boundary");
  }
  const publishLink = dependencies.link ?? linkFile;
  const removePartial = dependencies.unlink ?? unlinkFile;
  const platform = dependencies.platform ?? process.platform;
  const warnings: FullDataExportWarning[] = [];
  let published = false;
  try {
    try {
      await publishLink(resolvedPartialPath, resolvedFinalPath);
      published = true;
      if (!dependencies.retainSource) {
        try {
          await removePartial(resolvedPartialPath);
        } catch {
          warnings.push("PARTIAL_CLEANUP_FAILED");
        }
      }
    } catch (error) {
      const code = nativeErrorCode(error);
      if (!HARD_LINK_UNSUPPORTED_CODES.has(code ?? "")) {
        throw mapPublishError(error);
      }
      await (
        dependencies.moveNoReplace ??
        ((source, target) => moveFileNoReplace(source, target, platform))
      )(resolvedPartialPath, resolvedFinalPath);
      published = true;
    }
  } catch (error) {
    if (error instanceof FullDataExportError) throw error;
    throw mapPublishError(error);
  }
  if (published) {
    try {
      await (dependencies.syncDirectory ?? syncDirectoryIfSupported)(
        path.dirname(resolvedFinalPath),
      );
    } catch {
      warnings.push("DIRECTORY_SYNC_UNAVAILABLE");
    }
  }
  return Object.freeze({ warnings: Object.freeze(warnings) });
}

export type FullDataExportServiceRequest = Readonly<{
  operationId: string;
  finalPath: string;
  password: string;
  passwordHint: string | null;
  passwordRecorded: true;
  signal?: AbortSignal;
  onProgress?: (progress: FullDataExportProgress) => void;
}>;

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_KEYS = new Set([
  "operationId",
  "finalPath",
  "password",
  "passwordHint",
  "passwordRecorded",
  "signal",
  "onProgress",
]);

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function stableFileIdentity(stats: BigIntStats): PackageFileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  });
}

function sameStableFileIdentity(left: PackageFileIdentity, right: PackageFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameOwnedFileObject(left: PackageFileIdentity, right: PackageFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatStableFile(filePath: string): Promise<PackageFileIdentity> {
  const stats = await lstat(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) throw new FullDataExportError("PACKAGE_TAMPERED");
  return stableFileIdentity(stats);
}

/** Harmony public storage: publish only to a new file and verify the copied bytes. */
export async function publishCopiedPackage(
  sourcePath: string,
  finalPath: string,
  verifiedIdentity: PackageFileIdentity,
  link: (source: string, target: string) => Promise<void> = linkFile,
): Promise<PackageFileIdentity> {
  if (!sameStableFileIdentity(await lstatStableFile(sourcePath), verifiedIdentity))
    throw new FullDataExportError("PACKAGE_TAMPERED");
  const expected = await hashFile(sourcePath);
  if (!sameStableFileIdentity(await lstatStableFile(sourcePath), verifiedIdentity))
    throw new FullDataExportError("PACKAGE_TAMPERED");
  await installNewFileWithoutClobber(sourcePath, finalPath, link);
  const before = await lstatStableFile(finalPath);
  const copied = await hashFile(finalPath);
  const after = await lstatStableFile(finalPath);
  if (
    expected.hash !== copied.hash ||
    expected.bytes !== copied.bytes ||
    !sameStableFileIdentity(before, after) ||
    before.ctimeNs !== after.ctimeNs ||
    !sameStableFileIdentity(await lstatStableFile(sourcePath), verifiedIdentity)
  )
    throw new FullDataExportError("PACKAGE_TAMPERED");
  return after;
}

async function restoreFileIfMissing(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await linkFile(quarantinePath, originalPath);
    await unlinkFile(quarantinePath);
  } catch {
    // Preserve the quarantined object when no-clobber restoration cannot be proven.
  }
}

async function removeOwnedFilePath(
  filePath: string,
  expectedIdentity: PackageFileIdentity,
): Promise<boolean> {
  const quarantinePath = `${filePath}.cleanup-${crypto.randomUUID()}`;
  try {
    await rename(filePath, quarantinePath);
  } catch (error) {
    return nativeErrorCode(error) === "ENOENT";
  }
  try {
    const actualIdentity = await lstatStableFile(quarantinePath);
    if (!sameOwnedFileObject(actualIdentity, expectedIdentity)) {
      await restoreFileIfMissing(quarantinePath, filePath);
      return false;
    }
    await unlinkFile(quarantinePath);
    return true;
  } catch {
    await restoreFileIfMissing(quarantinePath, filePath);
    return false;
  }
}

type OwnedTaskRoot = Awaited<ReturnType<typeof createOwnedExportTask>>;

async function createOwnedTaskRoot(workRoot: string): Promise<OwnedTaskRoot> {
  return createOwnedExportTask(workRoot);
}

async function removeOwnedTaskRoot(owned: OwnedTaskRoot): Promise<boolean> {
  try {
    const current = await readOwnedExportTask(path.dirname(owned.path), path.basename(owned.path));
    if (
      !current ||
      current.identity.device !== owned.identity.device ||
      current.identity.inode !== owned.identity.inode ||
      current.identity.birthtimeNs !== owned.identity.birthtimeNs ||
      current.markerSecret !== owned.markerSecret
    )
      return false;
    await removeOwnedExportTaskRoot(current);
    return true;
  } catch (error) {
    return nativeErrorCode(error) === "ENOENT";
  }
}

async function moveVerifiedPartialToAnchor(
  partialPath: string,
  verifiedIdentity: PackageFileIdentity,
  dependencies: PublishDependencies = {},
  plannedAnchor?: string,
): Promise<string> {
  const anchorPath =
    plannedAnchor ??
    path.join(path.dirname(partialPath), `.verified-${crypto.randomUUID()}.zxwbackup.partial`);
  let movedByFallback = false;
  try {
    try {
      await (dependencies.link ?? linkFile)(partialPath, anchorPath);
    } catch (error) {
      if (!HARD_LINK_UNSUPPORTED_CODES.has(nativeErrorCode(error) ?? "")) {
        throw error;
      }
      await (
        dependencies.moveNoReplace ??
        ((source, target) =>
          moveFileNoReplace(source, target, dependencies.platform ?? process.platform))
      )(partialPath, anchorPath);
      movedByFallback = true;
    }
    const anchorIdentity = await lstatStableFile(anchorPath);
    if (!sameStableFileIdentity(anchorIdentity, verifiedIdentity)) {
      if (movedByFallback) {
        await restoreFileIfMissing(anchorPath, partialPath);
      } else {
        await removeOwnedFilePath(anchorPath, verifiedIdentity);
      }
      throw new FullDataExportError("PACKAGE_TAMPERED");
    }
    if (!movedByFallback) {
      const removedVerifiedPartial = await removeOwnedFilePath(partialPath, verifiedIdentity);
      if (!removedVerifiedPartial) {
        await removeOwnedFilePath(anchorPath, verifiedIdentity);
        throw new FullDataExportError("PACKAGE_TAMPERED");
      }
    }
    return anchorPath;
  } catch (error) {
    if (error instanceof FullDataExportError) throw error;
    if (movedByFallback) await restoreFileIfMissing(anchorPath, partialPath);
    throw normalizeServiceError(error);
  }
}

async function assertMissing(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT") return;
    throw new FullDataExportError("DESTINATION_UNAVAILABLE");
  }
  throw new FullDataExportError("UNSAFE_OVERWRITE");
}

export async function assertFullDataExportRequest(
  request: FullDataExportServiceRequest,
): Promise<FullDataExportServiceRequest> {
  if (
    request === null ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => !REQUEST_KEYS.has(key)) ||
    !OPERATION_ID_PATTERN.test(request.operationId) ||
    typeof request.finalPath !== "string" ||
    path.extname(request.finalPath).toLowerCase() !== ".zxwbackup" ||
    typeof request.password !== "string" ||
    request.password.length === 0 ||
    (request.passwordHint !== null && typeof request.passwordHint !== "string") ||
    request.passwordRecorded !== true ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal)) ||
    (request.onProgress !== undefined && typeof request.onProgress !== "function")
  ) {
    throw new TypeError("Invalid full data export request");
  }
  const finalPath = path.resolve(request.finalPath);
  await assertMissing(finalPath);
  return Object.freeze({ ...request, finalPath });
}

type Snapshotter = Pick<ExportSourceSnapshot, "create">;
type WriterLike = Readonly<{
  createdPartialIdentity: PackageFileIdentity;
  addEntry(entry: PackageWriterEntry, signal?: AbortSignal): Promise<TransferManifestEntry>;
  finish(metadata: PackageWriterManifestMetadata, signal?: AbortSignal): Promise<TransferManifest>;
  close?: () => Promise<void>;
}>;
type WriterFactory = Readonly<{
  create(options: PackageWriterCreateOptions): Promise<WriterLike>;
}>;
type ReaderLike = Readonly<{
  readPublicHeader(): Promise<{ packageId: string; saltHex?: string }>;
  unlock(password: string): Promise<void>;
  extractTo(stagingRoot: string, signal?: AbortSignal): Promise<PackageExtractionResult>;
  close(): Promise<void>;
}>;
type ReaderFactory = Readonly<{
  open(sourcePath: string, options: { currentImporterVersion: string }): Promise<ReaderLike>;
}>;
type SpaceEstimate = Readonly<{ databaseBytes: bigint; estimatedPackageBytes: bigint }>;

type VerifyExtractedPackageInput = Readonly<{
  extraction: PackageExtractionResult;
  publicHeader: { packageId: string; saltHex?: string };
  writtenManifest: TransferManifest;
  snapshot: ExportSourceSnapshotSummary;
  portableSettings: PortableSettings;
  expectedSummary: DataTransferLibrarySummary;
  expectedSchemaFingerprint: string;
  signal?: AbortSignal;
}>;

export type FullDataExportServiceOptions = Readonly<{
  applicationVersion: string;
  minimumImporterVersion?: string;
  database: LibraryDatabase;
  libraryRoot: string;
  userDataRoot: string;
  workRoot: string;
  draftService: Pick<DraftService, "waitForIdle">;
  fileService: Pick<FileService, "openDocument">;
  settingsService: Pick<SettingsService, "read">;
  gate?: Pick<DataTransferOperationGate, "runExclusive">;
  quiescence: Pick<DataTransferQuiescence, "acquire">;
  snapshotter?: Snapshotter;
  writerFactory?: WriterFactory;
  readerFactory?: ReaderFactory;
  estimateSpace?: () => Promise<SpaceEstimate>;
  preflightSpace?: typeof preflightFullDataExportSpace;
  summarizeSnapshot?: (
    snapshot: ExportSourceSnapshotSummary,
  ) => Promise<DataTransferLibrarySummary>;
  schemaFingerprint?: (databasePath: string) => Promise<string>;
  verifyExtractedPackage?: (input: VerifyExtractedPackageInput) => Promise<void>;
  publishDependencies?: PublishDependencies;
  destinationDependencies?: FullDataExportDestinationDependencies;
  now?: () => Date;
  randomUUID?: () => string;
}>;

export type FullDataExportServiceResult = Readonly<{
  operationId: string;
  finalPath: string;
  displayPath: string;
  sizeBytes: number;
  cutoffAt: string;
  packageFormatVersion: 2;
  summary: DataTransferLibrarySummary;
  fullVerificationPassed: true;
  warnings: readonly FullDataExportWarning[];
}>;

function checkServiceAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FullDataExportError("CANCELLED");
}

async function ensureFullDataExportWorkRoot(workRoot: string, signal?: AbortSignal): Promise<void> {
  checkServiceAbort(signal);
  const resolvedWorkRoot = path.resolve(workRoot);
  try {
    await mkdir(resolvedWorkRoot, { recursive: true });
    const info = await lstat(resolvedWorkRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FullDataExportError("SOURCE_SAVE_FAILED");
    }
  } catch (error) {
    if (error instanceof FullDataExportError) throw error;
    throw new FullDataExportError("SOURCE_SAVE_FAILED");
  }
  checkServiceAbort(signal);
}

function isInsidePath(parent: string, child: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || BigInt(number) !== value) {
    throw new FullDataExportError("SOURCE_SAVE_FAILED");
  }
  return number;
}

async function recursiveRegularFileBytes(root: string): Promise<bigint> {
  let rootStats: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStats = await lstat(root, { bigint: true });
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT") return 0n;
    throw error;
  }
  if (rootStats.isSymbolicLink()) throw new Error("Space estimate root is a link");
  if (rootStats.isFile()) return rootStats.size;
  if (!rootStats.isDirectory()) throw new Error("Space estimate root is unsupported");
  let total = 0n;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Space estimate entry is a link");
    total += await recursiveRegularFileBytes(path.join(root, entry.name));
  }
  return total;
}

async function hashFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; hash: string }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    checkServiceAbort(signal);
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  return { bytes, hash: hash.digest("hex") };
}

function databaseCount(database: LibraryDatabase, sql: string): number {
  const value = database.read(
    (connection) => connection.prepare(sql).get() as { count?: unknown } | undefined,
  )?.count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid database summary count");
  }
  return value as number;
}

async function summarizeFrozenSnapshot(
  snapshot: ExportSourceSnapshotSummary,
): Promise<DataTransferLibrarySummary> {
  using database = LibraryDatabase.openReadOnly(snapshot.database.sourcePath);
  const activePatents = databaseCount(
    database,
    "SELECT COUNT(*) AS count FROM patents WHERE deleted_at IS NULL",
  );
  const trashedPatents = databaseCount(
    database,
    "SELECT COUNT(*) AS count FROM patents WHERE deleted_at IS NOT NULL",
  );
  const documents = databaseCount(database, "SELECT COUNT(*) AS count FROM documents");
  const snapshots =
    databaseCount(database, "SELECT COUNT(*) AS count FROM snapshots") +
    databaseCount(database, "SELECT COUNT(*) AS count FROM document_snapshots");
  const flowchartProjects = databaseCount(
    database,
    "SELECT COUNT(*) AS count FROM patent_flowcharts",
  );

  return Object.freeze({
    activePatents,
    trashedPatents,
    documents,
    legacyDrafts: snapshot.draftCount,
    snapshots,
    assets: snapshot.assetCount,
    flowchartProjects,

    totalBytes: snapshot.totalBytes,
  });
}

async function computeSchemaFingerprint(databasePath: string): Promise<string> {
  using database = LibraryDatabase.openReadOnly(databasePath);
  const rows = database.read((connection) =>
    connection
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
         WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all(),
  );
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyExtractedPackageProduction(input: VerifyExtractedPackageInput): Promise<void> {
  checkServiceAbort(input.signal);
  if (!jsonEqual(input.extraction.manifest, input.writtenManifest)) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  if (!isInsidePath(path.dirname(input.extraction.stagingPath), input.extraction.stagingPath)) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  for (const entry of input.snapshot.entries) {
    const extractedPath = path.join(input.extraction.stagingPath, ...entry.logicalPath.split("/"));
    if (!isInsidePath(input.extraction.stagingPath, extractedPath)) {
      throw new FullDataExportError("PACKAGE_TAMPERED");
    }
    const digest = await hashFile(extractedPath, input.signal);
    if (digest.bytes !== entry.size || digest.hash !== entry.hash) {
      throw new FullDataExportError("PACKAGE_TAMPERED");
    }
  }

  const settingsBytes = await readFile(
    path.join(input.extraction.stagingPath, "portable-settings.json"),
  );
  let extractedSettings: PortableSettings;
  try {
    extractedSettings = PortableSettingsSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(settingsBytes)),
    );
  } catch {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  if (!jsonEqual(extractedSettings, input.portableSettings)) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }

  const databasePath = path.join(input.extraction.stagingPath, "library", "library.sqlite3");
  using database = LibraryDatabase.openReadOnly(databasePath);
  if (!database.integrityCheck().ok || !database.foreignKeyCheck().ok) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  if (
    database.schemaVersion() !== CURRENT_SCHEMA_VERSION ||
    !database.read((connection) => validateCurrentSchema(connection)).ok
  ) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  const actualFingerprint = await computeSchemaFingerprint(databasePath);
  if (actualFingerprint !== input.expectedSchemaFingerprint) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  const extractedSummary = await summarizeFrozenSnapshot({
    ...input.snapshot,
    database: { ...input.snapshot.database, sourcePath: databasePath },
  });
  if (!jsonEqual(extractedSummary, input.expectedSummary)) {
    throw new FullDataExportError("PACKAGE_TAMPERED");
  }
  // Verify recoverability with the same domain/history checks used by the actual importer.
  // Only this decrypted readback copy may be migrated/recovered; never mutate the source.
  await new ImportStagingValidator().validate(input.extraction.stagingPath, input.writtenManifest);
  checkServiceAbort(input.signal);
}

function isSafeTransferError(error: unknown): error is SafeTransferError {
  return (
    error instanceof DataTransferOperationError || error instanceof DataTransferQuiescenceError
  );
}

function recursiveNativeSpaceCode(error: unknown): "EFBIG" | "ENOSPC" | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): "EFBIG" | "ENOSPC" | undefined => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate))
      return undefined;
    seen.add(candidate);
    if (candidate instanceof ExportSourceSnapshotError && candidate.nativeCode) {
      return candidate.nativeCode;
    }
    const code = nativeErrorCode(candidate);
    if (code === "EFBIG" || code === "ENOSPC") return code;
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

function normalizeServiceError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new FullDataExportError("CANCELLED");
  if (error instanceof FullDataExportError || isSafeTransferError(error)) return error;
  const nativeSpaceCode = recursiveNativeSpaceCode(error);
  if (nativeSpaceCode) {
    return new FullDataExportError(
      "INSUFFICIENT_SPACE",
      error instanceof ExportSourceSnapshotError ? "source" : "target",
    );
  }
  if (error instanceof ExportSourceSnapshotError) return error;
  if (error instanceof PackageWriterError) {
    return new FullDataExportError(error.code === "CANCELLED" ? "CANCELLED" : "EXPORT_FAILED");
  }
  if (error instanceof PackageReaderError) {
    if (error.code === "CANCELLED") return new FullDataExportError("CANCELLED");
    return new FullDataExportError(
      error.code === "READER_STATE_INVALID" ? "EXPORT_FAILED" : "PACKAGE_TAMPERED",
    );
  }
  const code = nativeErrorCode(error);
  if (code === "EEXIST") return new FullDataExportError("UNSAFE_OVERWRITE");
  if (
    code === "CANCELLED" ||
    code === "DESTINATION_UNAVAILABLE" ||
    code === "EXPORT_FAILED" ||
    code === "INSUFFICIENT_SPACE" ||
    code === "PACKAGE_TAMPERED" ||
    code === "SOURCE_SAVE_FAILED" ||
    code === "UNSAFE_OVERWRITE"
  ) {
    return new FullDataExportError(code);
  }
  return new FullDataExportError("EXPORT_FAILED");
}

export class FullDataExportService {
  readonly #options: FullDataExportServiceOptions;

  constructor(options: FullDataExportServiceOptions) {
    this.#options = options;
  }

  async export(
    untrustedRequest: FullDataExportServiceRequest,
  ): Promise<FullDataExportServiceResult> {
    const request = await assertFullDataExportRequest(untrustedRequest);
    await ensureFullDataExportWorkRoot(this.#options.workRoot, request.signal);
    const destinationDirectory = path.dirname(request.finalPath);
    await validateFullDataExportDestinationDirectory(
      destinationDirectory,
      this.#options.libraryRoot,
      this.#options.destinationDependencies,
      request.signal,
    );
    checkServiceAbort(request.signal);
    let estimate: SpaceEstimate;
    let preflight: FullDataExportSpacePreflightResult;
    try {
      estimate = await (this.#options.estimateSpace ?? (() => this.#estimateSpace()))();
      preflight = await (this.#options.preflightSpace ?? preflightFullDataExportSpace)({
        sourcePath: this.#options.workRoot,
        targetDirectory: destinationDirectory,
        databaseBytes: estimate.databaseBytes,
        estimatedPackageBytes: estimate.estimatedPackageBytes,
        ...(usesHarmonyPublicFileCopy(request.finalPath)
          ? { stagedPackageBytes: estimate.estimatedPackageBytes }
          : {}),
      });
    } catch (error) {
      throw normalizeServiceError(error, request.signal);
    }
    const warnings: FullDataExportWarning[] = [...preflight.warnings];
    const report = createFullDataExportProgressReporter({
      operationId: request.operationId,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    report("inspecting", 0, safeNumber(estimate.estimatedPackageBytes), "database");
    const gate = this.#options.gate ?? getDataTransferOperationGate();
    try {
      return await gate.runExclusive(
        "full-data-export",
        async () => await this.#exportExclusive(request, report, warnings),
        request.signal,
      );
    } catch (error) {
      throw normalizeServiceError(error, request.signal);
    }
  }

  async #estimateSpace(): Promise<SpaceEstimate> {
    const databasePath = path.join(this.#options.libraryRoot, "library.sqlite3");
    const databaseStats = await lstat(databasePath, { bigint: true });
    if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
      throw new FullDataExportError("SOURCE_SAVE_FAILED");
    }
    const [libraryBytes, draftBytes, polishBytes] = await Promise.all([
      recursiveRegularFileBytes(this.#options.libraryRoot),
      recursiveRegularFileBytes(path.join(this.#options.userDataRoot, "drafts")),
      recursiveRegularFileBytes(path.join(this.#options.userDataRoot, "text-polish-history")),
    ]);
    return Object.freeze({
      databaseBytes: databaseStats.size,
      estimatedPackageBytes: libraryBytes + draftBytes + polishBytes + 64n * 1024n,
    });
  }

  async #exportExclusive(
    request: FullDataExportServiceRequest,
    report: ReturnType<typeof createFullDataExportProgressReporter>,
    warnings: FullDataExportWarning[],
  ): Promise<FullDataExportServiceResult> {
    let lease: DataTransferQuiescenceLease | undefined;
    let writer: WriterLike | undefined;
    let reader: ReaderLike | undefined;
    let ownedTaskRoot: OwnedTaskRoot | undefined;
    let taskRoot: string | undefined;
    let partialPath: string | undefined;
    let ownedPartialIdentity: PackageFileIdentity | undefined;
    let anchorPath: string | undefined;
    let anchorIdentity: PackageFileIdentity | undefined;
    let published = false;
    let result: Omit<FullDataExportServiceResult, "warnings"> | undefined;
    let primary: unknown;
    const publicCopy = usesHarmonyPublicFileCopy(request.finalPath);
    try {
      checkServiceAbort(request.signal);
      report("quiescing-writes", 0, null, "database");
      lease = await this.#options.quiescence.acquire();
      checkServiceAbort(request.signal);

      ownedTaskRoot = await createOwnedTaskRoot(this.#options.workRoot);
      taskRoot = ownedTaskRoot.path;
      const baseName = path.basename(request.finalPath, path.extname(request.finalPath));
      const stagingFinalPath = path.join(
        publicCopy ? taskRoot : path.dirname(request.finalPath),
        `.${baseName}.${request.operationId}.zxwbackup`,
      );
      partialPath = `${stagingFinalPath}.partial`;
      await Promise.all([assertMissing(stagingFinalPath), assertMissing(partialPath)]);
      const recoveryReceipt: ExportTaskReceipt = {
        version: 1,
        rootPath: taskRoot,
        rootIdentity: ownedTaskRoot.identity,
        markerSecret: ownedTaskRoot.markerSecret,
        operationId: request.operationId,
        finalPath: request.finalPath,
        files: [],
      };
      await recordExportTaskFiles(recoveryReceipt);

      report("checkpointing", 0, null, "database");
      const snapshotter = this.#options.snapshotter ?? new ExportSourceSnapshot();
      const snapshot = await snapshotter.create({
        database: this.#options.database,
        libraryRoot: this.#options.libraryRoot,
        userDataRoot: this.#options.userDataRoot,
        workRoot: taskRoot,
        draftService: this.#options.draftService,
        fileService: this.#options.fileService,
        ...(request.signal ? { signal: request.signal } : {}),
      } satisfies ExportSourceSnapshotRequest);
      if (!isInsidePath(taskRoot, snapshot.taskDirectory)) {
        throw new FullDataExportError("SOURCE_SAVE_FAILED");
      }
      checkServiceAbort(request.signal);

      const portableSettings = projectPortableSettings(await this.#options.settingsService.read());
      const settingsBytes = Buffer.from(JSON.stringify(portableSettings), "utf8");
      const summarize = this.#options.summarizeSnapshot ?? summarizeFrozenSnapshot;
      const summary = await summarize(snapshot);
      const schemaFingerprint = await (this.#options.schemaFingerprint ?? computeSchemaFingerprint)(
        snapshot.database.sourcePath,
      );
      const integritySummaryBytes = Buffer.from(JSON.stringify(summary), "utf8");
      const packageId = (this.#options.randomUUID ?? randomUUID)();
      if (!OPERATION_ID_PATTERN.test(packageId)) throw new FullDataExportError("INTERNAL");
      const totalBytes =
        snapshot.totalBytes + settingsBytes.byteLength + integritySummaryBytes.byteLength;
      if (!Number.isSafeInteger(totalBytes)) throw new FullDataExportError("SOURCE_SAVE_FAILED");

      const createWriter: WriterFactory = this.#options.writerFactory ?? {
        create: (options) => PackageWriter.create(options),
      };
      report("collecting-data", 0, totalBytes, "database");
      const createdPartialPath = partialPath;
      writer = await createWriter.create({
        partialPath,
        finalPath: stagingFinalPath,
        password: request.password,
        onPartialCreated: async (identity) => {
          ownedPartialIdentity = identity;
          // Internal files are already owned by the task root and recovered with it.
          if (publicCopy) return;
          recoveryReceipt.files = [
            {
              path: createdPartialPath,
              identity: {
                device: String(identity.dev),
                inode: String(identity.ino),
                birthtimeNs: String(identity.birthtimeNs),
              },
            },
          ];
          await recordExportTaskFiles(recoveryReceipt);
        },
        header: {
          packageId,
          minimumImporterVersion:
            this.#options.minimumImporterVersion ?? this.#options.applicationVersion,
          passwordHint: request.passwordHint,
        },
        ...(request.signal ? { signal: request.signal } : {}),
        onProgress: (progress: PackageWriterProgress) =>
          report(
            progress.phase === "entries" ? "collecting-data" : "encrypting",
            progress.completedOriginalBytes,
            totalBytes,
            progress.phase === "entries" ? "assets" : "settings",
          ),
      });
      ownedPartialIdentity = writer.createdPartialIdentity;
      for (const entry of snapshot.entries) {
        const source = createReadStream(entry.sourcePath);
        try {
          await writer.addEntry(
            {
              logicalPath: entry.logicalPath,
              kind: entry.kind,
              source,
            },
            request.signal,
          );
        } finally {
          source.destroy();
        }
      }
      await writer.addEntry(
        {
          logicalPath: "portable-settings.json",
          kind: "settings",
          source: (async function* () {
            yield settingsBytes;
          })(),
        },
        request.signal,
      );
      await writer.addEntry(
        {
          logicalPath: "verification/integrity-summary.json",
          kind: "verification",
          source: (async function* () {
            yield integritySummaryBytes;
          })(),
        },
        request.signal,
      );
      const exportedAt = (this.#options.now ?? (() => new Date()))().toISOString();
      const writtenManifest = await writer.finish(
        {
          packageFormatVersion: 2,
          packageId,
          exportedByVersion: this.#options.applicationVersion,
          minimumImporterVersion:
            this.#options.minimumImporterVersion ?? this.#options.applicationVersion,
          databaseSchemaVersion: CURRENT_SCHEMA_VERSION,
          databaseSchemaFingerprint: schemaFingerprint,
          canonicalPatentFormatVersion:
            snapshot.canonicalPatentFormatVersion ?? CANONICAL_PATENT_FORMAT_VERSION,
          exportedAt,
          cutoffAt: snapshot.cutoffAt,
          summary,
          portableSettingKeys: Object.freeze(Object.keys(portableSettings).sort()),
          excludedMachineSettingCategories: Object.freeze([
            "ai-credentials",
            "backup-folder",
            "printer",
            "recent-directory",
            "window-bounds",
          ]),
        },
        request.signal,
      );
      settingsBytes.fill(0);
      integritySummaryBytes.fill(0);
      checkServiceAbort(request.signal);

      report("verifying-package", 0, totalBytes, "verification");
      const verifiedPartialIdentity = await lstatStableFile(partialPath);
      if (!publicCopy && !recoveryReceipt.files.length) {
        // Custom writer adapters must meet the same cleanup ownership contract.
        recoveryReceipt.files = [
          {
            path: partialPath,
            identity: {
              device: String(verifiedPartialIdentity.dev),
              inode: String(verifiedPartialIdentity.ino),
              birthtimeNs: String(verifiedPartialIdentity.birthtimeNs),
            },
          },
        ];
        await recordExportTaskFiles(recoveryReceipt);
      }
      const verifyRoot = path.join(taskRoot, "readback-verification");
      await mkdir(verifyRoot);
      const readerFactory: ReaderFactory = this.#options.readerFactory ?? {
        open: (sourcePath, options) => PackageReader.open(sourcePath, options),
      };
      reader = await readerFactory.open(partialPath, {
        currentImporterVersion: this.#options.applicationVersion,
      });
      const publicHeader = await reader.readPublicHeader();
      await reader.unlock(request.password);
      const extraction = await reader.extractTo(verifyRoot, request.signal);
      try {
        await (this.#options.verifyExtractedPackage ?? verifyExtractedPackageProduction)({
          extraction,
          publicHeader,
          writtenManifest,
          snapshot,
          portableSettings,
          expectedSummary: summary,
          expectedSchemaFingerprint: schemaFingerprint,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (error instanceof FullDataExportError) throw error;
        throw new FullDataExportError("PACKAGE_TAMPERED");
      }
      await reader.close();
      reader = undefined;
      report("verifying-package", totalBytes, totalBytes, "verification");
      checkServiceAbort(request.signal);

      await assertMissing(request.finalPath);
      report("publishing-package", 0, totalBytes, "verification");
      let expectedFinalIdentity = verifiedPartialIdentity;
      if (publicCopy) {
        expectedFinalIdentity = await publishCopiedPackage(
          partialPath,
          request.finalPath,
          verifiedPartialIdentity,
          this.#options.publishDependencies?.link,
        );
      } else {
        const plannedAnchor = path.join(
          path.dirname(partialPath),
          `.verified-${crypto.randomUUID()}.zxwbackup.partial`,
        );
        recoveryReceipt.files.push({
          path: plannedAnchor,
          identity: {
            device: String(verifiedPartialIdentity.dev),
            inode: String(verifiedPartialIdentity.ino),
            birthtimeNs: String(verifiedPartialIdentity.birthtimeNs),
          },
        });
        await recordExportTaskFiles(recoveryReceipt);
        anchorPath = await moveVerifiedPartialToAnchor(
          partialPath,
          verifiedPartialIdentity,
          this.#options.publishDependencies,
          plannedAnchor,
        );
        anchorIdentity = verifiedPartialIdentity;
        const publication = await publishCompletedPackage(anchorPath, request.finalPath, {
          ...this.#options.publishDependencies,
          retainSource: true,
        });
        warnings.push(...publication.warnings);
      }
      const finalStats = await lstat(request.finalPath, { bigint: true });
      if (
        !finalStats.isFile() ||
        finalStats.isSymbolicLink() ||
        !sameStableFileIdentity(stableFileIdentity(finalStats), expectedFinalIdentity)
      ) {
        throw new FullDataExportError("PACKAGE_TAMPERED");
      }
      published = true;
      ownedPartialIdentity = undefined;
      result = Object.freeze({
        operationId: request.operationId,
        finalPath: request.finalPath,
        displayPath: request.finalPath,
        sizeBytes: safeNumber(finalStats.size),
        cutoffAt: snapshot.cutoffAt,
        packageFormatVersion: 2 as const,
        summary,
        fullVerificationPassed: true as const,
      });
    } catch (error) {
      primary = normalizeServiceError(error, request.signal);
    } finally {
      if (reader) {
        try {
          await reader.close();
        } catch (error) {
          if (published) warnings.push("CLEANUP_FAILED");
          else primary ??= error;
        }
      }
      if (writer?.close) {
        try {
          await writer.close();
        } catch (error) {
          if (published) warnings.push("CLEANUP_FAILED");
          else primary ??= error;
        }
      }
      let cleanupFailed = false;
      if (partialPath && ownedPartialIdentity) {
        if (!(await removeOwnedFilePath(partialPath, ownedPartialIdentity))) cleanupFailed = true;
      }
      if (anchorPath && anchorIdentity) {
        if (!(await removeOwnedFilePath(anchorPath, anchorIdentity))) cleanupFailed = true;
      }
      // Do not erase durable cleanup ownership while an external temporary package remains.
      if (ownedTaskRoot && !cleanupFailed) {
        if (!(await removeOwnedTaskRoot(ownedTaskRoot))) cleanupFailed = true;
      }
      if (cleanupFailed) {
        if (published) warnings.push("CLEANUP_FAILED");
        else primary ??= new FullDataExportError("INTERNAL");
      }
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          if (published) warnings.push("BACKGROUND_RESUME_FAILED");
          else primary ??= error;
        }
      }
    }
    if (primary !== undefined) throw normalizeServiceError(primary, request.signal);
    if (!result) throw new FullDataExportError("INTERNAL");
    try {
      report("completed", result.sizeBytes, result.sizeBytes, "verification");
    } catch {
      warnings.push("PROGRESS_DELIVERY_FAILED");
    }
    return Object.freeze({ ...result, warnings: Object.freeze([...new Set(warnings)]) });
  }
}
