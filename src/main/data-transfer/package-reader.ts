import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import {
  type TransferManifest,
  type TransferManifestEntry,
  TransferManifestEntrySchema,
  TransferManifestSchema,
} from "../../shared/data-transfer/model.js";
import {
  canonicalEncodeJson,
  createDataTransferFooterMagicBytes,
  createDataTransferMagicBytes,
  DATA_TRANSFER_FOOTER_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  DATA_TRANSFER_HEADER_LIMIT,
  DATA_TRANSFER_PACKAGE_VERSION,
  DataTransferFrameType,
  type DataTransferPublicHeader,
  decodeFrameHeader,
  decodePackageFooter,
  decodePublicHeader,
} from "../../shared/data-transfer/package-format.js";
import {
  ArchivePathPolicy,
  assertSafeExtractionTargetMetadata,
  checkedAddArchiveBytes,
  DATA_TRANSFER_ARCHIVE_LIMITS,
} from "./archive-path-policy.js";
import { type DerivedPackageKeys, verifyPassword } from "./package-crypto.js";
import { AuthenticatedFrameReader, computePublicHeaderDigest } from "./package-framing.js";
import {
  computePackageFooterMac,
  DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES,
} from "./package-writer.js";

const inflateRawAsync = promisify(inflateRaw);
const CURRENT_IMPORTER_VERSION = "0.1.0";
const MINIMUM_SERIALIZED_FRAME_BYTES =
  DATA_TRANSFER_FRAME_HEADER_BYTES + DATA_TRANSFER_GCM_TAG_BYTES;
const ENTRY_SPOOL_RECORD_HEADER_BYTES = 8;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const WINDOWS_PROBE_REQUEST_TIMEOUT_MS = 2_000;
const WINDOWS_PROBE_CLOSE_TIMEOUT_MS = 2_000;
const WINDOWS_PROBE_STDOUT_LIMIT = 1_024;
const WINDOWS_PROBE_STDERR_LIMIT = 4_096;
const WINDOWS_ATTRIBUTE_SCRIPT = Buffer.from(
  [
    "$ErrorActionPreference='Stop'",
    "while(($l=[Console]::In.ReadLine()) -ne $null){",
    '  $f=$l.Split("`t",2)',
    "  if($f.Length -ne 2 -or $f[0] -notmatch '^[1-9][0-9]*$'){exit 2}",
    "  $id=$f[0]",
    "  try{",
    "    $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($f[1]))",
    "    $a=[int64][IO.File]::GetAttributes($p)",
    '    [Console]::Out.WriteLine("$id`tOK`t$a")',
    '  }catch{[Console]::Out.WriteLine("$id`tERR`t1")}',
    "  [Console]::Out.Flush()",
    "}",
  ].join("\n"),
  "utf16le",
).toString("base64");
const ASSERT_NO_REPARSE_POINT = Symbol("assertNoReparsePoint");

export type PackageReaderErrorCode =
  | "CANCELLED"
  | "PASSWORD_OR_PACKAGE_INVALID"
  | "PACKAGE_TOO_NEW"
  | "PACKAGE_INCOMPLETE"
  | "PACKAGE_TAMPERED"
  | "READER_STATE_INVALID";

const READER_ERROR_MESSAGES: Record<PackageReaderErrorCode, string> = {
  CANCELLED: "操作已取消。",
  PASSWORD_OR_PACKAGE_INVALID: "密码不正确或数据包无效。",
  PACKAGE_TOO_NEW: "数据包需要更新版本的应用。",
  PACKAGE_INCOMPLETE: "数据包不完整。",
  PACKAGE_TAMPERED: "数据包完整性验证失败。",
  READER_STATE_INVALID: "数据包读取器状态无效。",
};

export class PackageReaderError extends Error {
  recoveryPaths: readonly string[] = [];

  constructor(readonly code: PackageReaderErrorCode) {
    super(READER_ERROR_MESSAGES[code]);
    this.name = "PackageReaderError";
  }
}

type StableSourceIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}>;

type ReadableHandle = Pick<FileHandle, "read">;
type WritableHandle = Pick<FileHandle, "write" | "sync" | "close">;

function readerError(code: PackageReaderErrorCode): PackageReaderError {
  return new PackageReaderError(code);
}

function attachReaderRecoveryPath(error: unknown, recoveryPath: string): void {
  if (!(error instanceof PackageReaderError)) return;
  error.recoveryPaths = Object.freeze([...error.recoveryPaths, recoveryPath]);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw readerError("CANCELLED");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

type WindowsProbeRequest = {
  resolve: (attributes: number) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
};

class WindowsReparsePointProbe {
  readonly #child: ChildProcessWithoutNullStreams | undefined;
  readonly #pending = new Map<number, WindowsProbeRequest>();
  readonly #exitPromise: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #nextRequestId = 1;
  #stdoutBuffer = "";
  #stderrBytes = 0;
  #poisoned: unknown;
  #closing = false;
  #exited = false;
  #closePromise: Promise<void> | undefined;

  constructor() {
    if (process.platform !== "win32") {
      this.#child = undefined;
      this.#exited = true;
      this.#exitPromise = Promise.resolve();
      return;
    }
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_ATTRIBUTE_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.#acceptStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > WINDOWS_PROBE_STDERR_LIMIT) {
        this.#poison(new Error("Windows file attribute probe stderr limit exceeded"));
      }
    });
    child.stdin.on("error", (error) => {
      if (!this.#closing) this.#poison(error);
    });
    child.on("error", (error) => this.#poison(error));
    child.once("close", (code, signal) => {
      this.#exited = true;
      this.#resolveExit?.();
      this.#resolveExit = undefined;
      if (!this.#closing && this.#poisoned === undefined) {
        this.#poison(
          new Error(
            `Windows file attribute probe exited unexpectedly (${String(code)}, ${String(signal)})`,
          ),
        );
      }
    });
  }

  async assertNotReparsePoint(filePath: string, signal?: AbortSignal): Promise<void> {
    const child = this.#child;
    if (!child) {
      checkAbort(signal);
      return;
    }
    checkAbort(signal);
    if (this.#poisoned !== undefined) throw this.#poisoned;
    if (this.#closing || this.#exited) throw readerError("READER_STATE_INVALID");
    const requestId = this.#nextRequestId;
    if (!Number.isSafeInteger(requestId)) {
      const error = new Error("Windows file attribute probe request id exhausted");
      this.#poison(error);
      throw error;
    }
    this.#nextRequestId += 1;
    const attributes = await new Promise<number>((resolve, reject) => {
      const abortListener = signal ? () => this.#poison(readerError("CANCELLED")) : undefined;
      const timeout = setTimeout(() => {
        this.#poison(new Error("Windows file attribute probe request timed out"));
      }, WINDOWS_PROBE_REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timeout, signal, abortListener });
      if (abortListener) signal?.addEventListener("abort", abortListener, { once: true });
      const request = `${requestId}\t${Buffer.from(filePath, "utf8").toString("base64")}\n`;
      child.stdin.write(request, "ascii", (error) => {
        if (error) this.#poison(error);
      });
    });
    checkAbort(signal);
    if ((attributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0) {
      throw readerError("PACKAGE_TAMPERED");
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (!this.#child || this.#exited) return;
    this.#closing = true;
    if (this.#pending.size > 0 && this.#poisoned === undefined) {
      this.#poison(readerError("READER_STATE_INVALID"));
    } else if (this.#poisoned === undefined) {
      this.#child.stdin.end();
    }
    if (this.#exited) return;
    if (await this.#waitForExit(WINDOWS_PROBE_CLOSE_TIMEOUT_MS)) return;
    this.#child.kill();
    if (!(await this.#waitForExit(WINDOWS_PROBE_CLOSE_TIMEOUT_MS))) {
      throw new Error("Windows file attribute probe did not exit");
    }
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.#exitPromise.then(() => true as const), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #acceptStdout(chunk: Buffer): void {
    if (this.#poisoned !== undefined || this.#closing) return;
    if (this.#stdoutBuffer.length + chunk.byteLength > WINDOWS_PROBE_STDOUT_LIMIT) {
      this.#poison(new Error("Windows file attribute probe stdout limit exceeded"));
      return;
    }
    this.#stdoutBuffer += chunk.toString("ascii");
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      this.#acceptResponseLine(line);
      if (this.#poisoned !== undefined) return;
    }
  }

  #acceptResponseLine(line: string): void {
    const fields = line.split("\t");
    const requestId = Number(fields[0]);
    if (fields.length !== 3 || !Number.isSafeInteger(requestId) || requestId <= 0) {
      this.#poison(new Error("Invalid Windows file attribute probe response"));
      return;
    }
    const request = this.#pending.get(requestId);
    if (!request) {
      this.#poison(new Error("Unmatched Windows file attribute probe response"));
      return;
    }
    this.#pending.delete(requestId);
    this.#releaseRequest(request);
    if (fields[1] === "ERR" && fields[2] === "1") {
      request.reject(new Error("Windows file attribute query failed"));
      return;
    }
    const attributes = Number(fields[2]);
    if (
      fields[1] !== "OK" ||
      !/^[0-9]+$/u.test(fields[2] ?? "") ||
      !Number.isSafeInteger(attributes) ||
      attributes < 0
    ) {
      const error = new Error("Invalid Windows file attribute probe response");
      request.reject(error);
      this.#poison(error);
      return;
    }
    request.resolve(attributes);
  }

  #releaseRequest(request: WindowsProbeRequest): void {
    clearTimeout(request.timeout);
    if (request.abortListener) {
      request.signal?.removeEventListener("abort", request.abortListener);
    }
  }

  #poison(error: unknown): void {
    if (this.#poisoned === undefined) this.#poisoned = error;
    const failure = this.#poisoned;
    for (const request of this.#pending.values()) {
      this.#releaseRequest(request);
      request.reject(failure);
    }
    this.#pending.clear();
    this.#closing = true;
    if (this.#child && !this.#exited) {
      this.#child.stdin.destroy();
      this.#child.kill();
    }
  }
}

function asIdentity(stats: BigIntStats): StableSourceIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  });
}

function hasReliableFileId(identity: StableSourceIdentity): boolean {
  return identity.ino !== 0n;
}

function sameFileIdentity(left: StableSourceIdentity, right: StableSourceIdentity): boolean {
  const stableMetadataEqual =
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs;
  if (!stableMetadataEqual) return false;
  if (hasReliableFileId(left) && hasReliableFileId(right)) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return true;
}

function bigintToSafeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw readerError("PACKAGE_TAMPERED");
  }
  return Number(value);
}

function checkedOffsetEnd(offset: number, length: number, limit: number): number {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(limit) ||
    offset < 0 ||
    length < 0 ||
    limit < 0 ||
    length > Number.MAX_SAFE_INTEGER - offset
  ) {
    throw readerError("PACKAGE_TAMPERED");
  }
  const end = offset + length;
  if (end > limit) throw readerError("PACKAGE_INCOMPLETE");
  return end;
}

async function readExactlyFromHandle(
  handle: ReadableHandle,
  position: number,
  length: number,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  checkedOffsetEnd(position, length, limit);
  let output: Buffer | undefined = Buffer.allocUnsafe(length);
  let offset = 0;
  try {
    while (offset < length) {
      checkAbort(signal);
      const result = await handle.read(output, offset, length - offset, position + offset);
      checkAbort(signal);
      if (result.bytesRead === 0) throw readerError("PACKAGE_INCOMPLETE");
      if (result.bytesRead < 0 || result.bytesRead > length - offset) {
        throw new Error("Invalid package read result");
      }
      offset += result.bytesRead;
    }
    const result = output;
    output = undefined;
    return result;
  } finally {
    output?.fill(0);
  }
}

async function writeAll(
  handle: WritableHandle,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    checkAbort(signal);
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    checkAbort(signal);
    if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw new Error("Invalid package write result");
    }
    offset += result.bytesWritten;
  }
}

function attachSecondaryFailure(primary: unknown, phase: string, secondary: unknown): void {
  if (!(primary instanceof Error)) return;
  const record = primary as Error & {
    secondaryFailures?: Array<Readonly<{ phase: string; error: unknown }>>;
  };
  const failures = record.secondaryFailures ?? [];
  failures.push(Object.freeze({ phase, error: secondary }));
  Object.defineProperty(record, "secondaryFailures", {
    value: failures,
    enumerable: false,
    configurable: true,
  });
}

export class TransferSourceHandle {
  readonly #sourcePath: string;
  readonly #handle: FileHandle;
  readonly #reparseProbe: WindowsReparsePointProbe;
  readonly #initialIdentity: StableSourceIdentity;
  readonly #size: number;
  #closePromise: Promise<void> | undefined;

  private constructor(
    sourcePath: string,
    handle: FileHandle,
    reparseProbe: WindowsReparsePointProbe,
    initialIdentity: StableSourceIdentity,
  ) {
    this.#sourcePath = sourcePath;
    this.#handle = handle;
    this.#reparseProbe = reparseProbe;
    this.#initialIdentity = initialIdentity;
    this.#size = bigintToSafeNumber(initialIdentity.size);
  }

  static async open(sourcePath: string): Promise<TransferSourceHandle> {
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      throw new TypeError("Invalid transfer source path");
    }
    const resolvedPath = path.resolve(sourcePath);
    const reparseProbe = new WindowsReparsePointProbe();
    let handle: FileHandle | undefined;
    try {
      handle = await open(resolvedPath, "r");
      const [handleStats, pathStats] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(resolvedPath, { bigint: true }),
      ]);
      if (!handleStats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()) {
        throw readerError("PACKAGE_INCOMPLETE");
      }
      await reparseProbe.assertNotReparsePoint(resolvedPath);
      const handleIdentity = asIdentity(handleStats);
      if (!sameFileIdentity(handleIdentity, asIdentity(pathStats))) {
        throw readerError("PACKAGE_INCOMPLETE");
      }
      return new TransferSourceHandle(resolvedPath, handle, reparseProbe, handleIdentity);
    } catch (error) {
      try {
        await handle?.close();
      } catch (closeError) {
        attachSecondaryFailure(error, "source-close", closeError);
      }
      try {
        await reparseProbe.close();
      } catch (closeError) {
        attachSecondaryFailure(error, "reparse-probe-close", closeError);
      }
      throw error;
    }
  }

  get size(): number {
    return this.#size;
  }

  async fork(): Promise<TransferSourceHandle> {
    await this.assertStable();
    const handle = await TransferSourceHandle.open(this.#sourcePath);
    try {
      await this.assertStable();
      if (!sameFileIdentity(this.#initialIdentity, handle.#initialIdentity))
        throw readerError("PACKAGE_INCOMPLETE");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readExactly(position: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    if (this.#closePromise) throw readerError("READER_STATE_INVALID");
    return readExactlyFromHandle(this.#handle, position, length, this.#size, signal);
  }

  async assertStable(signal?: AbortSignal): Promise<void> {
    if (this.#closePromise) throw readerError("READER_STATE_INVALID");
    checkAbort(signal);
    const handleStats = await this.#handle.stat({ bigint: true });
    checkAbort(signal);
    let pathStats: BigIntStats;
    try {
      pathStats = await lstat(this.#sourcePath, { bigint: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw readerError("PACKAGE_INCOMPLETE");
      throw error;
    }
    if (!handleStats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw readerError("PACKAGE_INCOMPLETE");
    }
    await this.#reparseProbe.assertNotReparsePoint(this.#sourcePath, signal);
    checkAbort(signal);
    const handleIdentity = asIdentity(handleStats);
    const pathIdentity = asIdentity(pathStats);
    if (
      !sameFileIdentity(this.#initialIdentity, handleIdentity) ||
      !sameFileIdentity(this.#initialIdentity, pathIdentity) ||
      !sameFileIdentity(handleIdentity, pathIdentity)
    ) {
      throw readerError("PACKAGE_INCOMPLETE");
    }
  }

  [ASSERT_NO_REPARSE_POINT](filePath: string, signal?: AbortSignal): Promise<void> {
    if (this.#closePromise) throw readerError("READER_STATE_INVALID");
    return this.#reparseProbe.assertNotReparsePoint(filePath, signal);
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      let primary: unknown;
      try {
        await this.#reparseProbe.close();
      } catch (error) {
        primary = error;
      }
      try {
        await this.#handle.close();
      } catch (error) {
        if (primary === undefined) primary = error;
        else attachSecondaryFailure(primary, "source-close", error);
      }
      if (primary !== undefined) throw primary;
    })();
    return this.#closePromise;
  }
}

export type PackageReaderOpenOptions = Readonly<{
  currentImporterVersion?: string;
}>;

export type PackageExtractionResult = Readonly<{
  manifest: TransferManifest;
  stagingPath: string;
  stagingPaths?: Readonly<{ library: string; userData: string }>;
  stagingCapabilities?: Readonly<{
    library: PackageExtractionCapability;
    userData: PackageExtractionCapability;
  }>;
  entryDestinations?: Readonly<Record<string, "library" | "user-data">>;
}>;

export type PackageExtractionCapability = Readonly<{
  path: string;
  identity: Readonly<{
    device: string;
    inode: string;
    birthtimeNs: string;
  }>;
}>;

export type PackageExtractionRoots = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
}>;

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const match =
      /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
        value,
      );
    if (!match) throw readerError("PACKAGE_TAMPERED");
    return {
      core: [BigInt(match[1] ?? "0"), BigInt(match[2] ?? "0"), BigInt(match[3] ?? "0")] as const,
      prerelease: match[4]?.split("."),
    };
  };
  const first = parse(left);
  const second = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const a = first.core[index] ?? 0n;
    const b = second.core[index] ?? 0n;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (!first.prerelease && !second.prerelease) return 0;
  if (!first.prerelease) return 1;
  if (!second.prerelease) return -1;
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = first.prerelease[index];
    const b = second.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/u.test(a);
    const bNumeric = /^[0-9]+$/u.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function decodePublicHeaderForReader(bytes: Buffer): DataTransferPublicHeader {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const candidate = JSON.parse(text) as { packageFormatVersion?: unknown };
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.packageFormatVersion === "number" &&
      candidate.packageFormatVersion > DATA_TRANSFER_PACKAGE_VERSION
    ) {
      throw readerError("PACKAGE_TOO_NEW");
    }
    return decodePublicHeader(bytes);
  } catch (error) {
    if (error instanceof PackageReaderError) throw error;
    throw readerError("PACKAGE_TAMPERED");
  }
}

function decodeFrameHeaderForReader(bytes: Buffer) {
  try {
    return decodeFrameHeader(bytes);
  } catch {
    throw readerError("PACKAGE_TAMPERED");
  }
}

function decodeFooterForReader(bytes: Buffer) {
  try {
    return decodePackageFooter(bytes);
  } catch {
    const magic = Buffer.from(createDataTransferFooterMagicBytes());
    if (bytes.indexOf(magic, 1) !== -1) throw readerError("PACKAGE_INCOMPLETE");
    throw readerError("PACKAGE_TAMPERED");
  }
}

function expectedEntryKind(logicalPath: string): TransferManifestEntry["kind"] | undefined {
  if (logicalPath === "library/library.sqlite3") return "database";
  if (logicalPath.startsWith("library/assets/")) return "asset";
  if (logicalPath.startsWith("legacy-drafts/")) return "legacy-draft";
  if (logicalPath.startsWith("text-polish-history/")) return "text-polish-history";
  if (logicalPath === "portable-settings.json") return "settings";
  if (logicalPath === "verification/integrity-summary.json") return "verification";
  return undefined;
}

function isUserDataEntry(entry: TransferManifestEntry): boolean {
  return (
    entry.kind === "legacy-draft" ||
    entry.kind === "text-polish-history" ||
    entry.kind === "settings"
  );
}

function parseCanonicalJson<T>(bytes: Buffer, parse: (value: unknown) => T): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parse(JSON.parse(text));
    if (!bytesEqual(bytes, canonicalEncodeJson(value))) throw new Error("not canonical");
    return value;
  } catch {
    throw readerError("PACKAGE_TAMPERED");
  }
}

function normalizedPathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseCanonicalManifest(bytes: Buffer): TransferManifest {
  const verified = parseCanonicalJson(bytes, (input) => {
    const manifest = TransferManifestSchema.parse(input);
    const summary = (input as { summary: Record<string, unknown> }).summary;
    // Validate the original canonical bytes before discarding the retired count.
    if (Object.hasOwn(summary, "scientificChartProjects")) {
      return {
        ...manifest,
        summary: { ...manifest.summary, scientificChartProjects: summary.scientificChartProjects },
      };
    }
    return manifest;
  });
  return TransferManifestSchema.parse(verified);
}

async function assertSafeDirectory(
  source: TransferSourceHandle,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const stats = await lstat(directory);
  checkAbort(signal);
  const classification = stats.isSymbolicLink()
    ? "symbolic-link"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "regular-file"
        : "reparse-point";
  assertSafeExtractionTargetMetadata({ classification });
  if (classification !== "directory") throw readerError("PACKAGE_TAMPERED");
  await source[ASSERT_NO_REPARSE_POINT](directory, signal);
  const resolvedRealPath = await realpath(directory);
  checkAbort(signal);
  if (normalizedPathForComparison(resolvedRealPath) !== normalizedPathForComparison(directory)) {
    throw readerError("PACKAGE_TAMPERED");
  }
}

function sameExtractionIdentity(
  stats: BigIntStats,
  capability: PackageExtractionCapability,
): boolean {
  return (
    String(stats.dev) === capability.identity.device &&
    String(stats.ino) === capability.identity.inode &&
    String(stats.birthtimeNs) === capability.identity.birthtimeNs
  );
}

async function extractionCapability(
  source: TransferSourceHandle,
  directory: string,
  signal?: AbortSignal,
): Promise<PackageExtractionCapability> {
  await assertSafeDirectory(source, directory, signal);
  const stats = await lstat(directory, { bigint: true });
  return Object.freeze({
    path: directory,
    identity: Object.freeze({
      device: String(stats.dev),
      inode: String(stats.ino),
      birthtimeNs: String(stats.birthtimeNs),
    }),
  });
}

async function assertOwnedExtractionDirectory(
  source: TransferSourceHandle,
  capability: PackageExtractionCapability,
  signal?: AbortSignal,
): Promise<void> {
  await assertSafeDirectory(source, capability.path, signal);
  const stats = await lstat(capability.path, { bigint: true });
  if (!sameExtractionIdentity(stats, capability)) throw readerError("PACKAGE_TAMPERED");
}

async function restoreExtractionIfMissing(
  source: TransferSourceHandle,
  owned: PackageExtractionCapability,
  quarantinePath: string,
  originalPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await lstat(originalPath);
    return true;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return false;
  }
  try {
    const parentPath = path.dirname(originalPath);
    await assertSafeDirectory(source, parentPath, signal);
    const parentBefore = await lstat(parentPath, { bigint: true });
    await assertSafeDirectory(source, quarantinePath, signal);
    const quarantineStats = await lstat(quarantinePath, { bigint: true });
    if (!sameExtractionIdentity(quarantineStats, { ...owned, path: quarantinePath })) {
      return false;
    }
    await rename(quarantinePath, originalPath);
    const parentAfter = await lstat(parentPath, { bigint: true });
    if (
      !sameExtractionIdentity(parentAfter, {
        path: parentPath,
        identity: {
          device: String(parentBefore.dev),
          inode: String(parentBefore.ino),
          birthtimeNs: String(parentBefore.birthtimeNs),
        },
      })
    ) {
      return false;
    }
    const restored = await lstat(originalPath, { bigint: true });
    return sameExtractionIdentity(restored, owned);
  } catch {
    // Preserve the quarantined object when no-clobber restoration cannot be proven.
    return false;
  }
}

type ExtractionCleanupResult = Readonly<{
  cleaned: boolean;
  recoveryPath?: string;
}>;

async function removeOwnedExtractionDirectory(
  source: TransferSourceHandle,
  owned: PackageExtractionCapability,
  signal?: AbortSignal,
): Promise<ExtractionCleanupResult> {
  const quarantinePath = `${owned.path}.cleanup-${crypto.randomUUID()}`;
  try {
    await rename(owned.path, quarantinePath);
  } catch (error) {
    return { cleaned: isNodeError(error, "ENOENT") };
  }
  try {
    const first = await lstat(quarantinePath, { bigint: true });
    if (
      !first.isDirectory() ||
      first.isSymbolicLink() ||
      !sameExtractionIdentity(first, { ...owned, path: quarantinePath }) ||
      normalizedPathForComparison(await realpath(quarantinePath)) !==
        normalizedPathForComparison(quarantinePath)
    ) {
      await restoreExtractionIfMissing(source, owned, quarantinePath, owned.path, signal);
      return { cleaned: false, recoveryPath: quarantinePath };
    }
    const second = await lstat(quarantinePath, { bigint: true });
    if (
      !second.isDirectory() ||
      second.isSymbolicLink() ||
      !sameExtractionIdentity(second, { ...owned, path: quarantinePath })
    ) {
      await restoreExtractionIfMissing(source, owned, quarantinePath, owned.path, signal);
      return { cleaned: false, recoveryPath: quarantinePath };
    }
    // Node has no cross-platform recursive unlink-by-handle API. Keeping the
    // isolated extraction is a cleanup failure, not successful cleanup.
    return { cleaned: false, recoveryPath: quarantinePath };
  } catch {
    await restoreExtractionIfMissing(source, owned, quarantinePath, owned.path, signal);
    return { cleaned: false, recoveryPath: quarantinePath };
  }
}

async function createOwnedExtractionDirectory(
  source: TransferSourceHandle,
  directory: string,
  signal?: AbortSignal,
): Promise<PackageExtractionCapability> {
  const parent = path.dirname(directory);
  await assertSafeDirectory(source, parent, signal);
  const parentBefore = await lstat(parent, { bigint: true });
  let created = false;
  let createdCapability: PackageExtractionCapability | undefined;
  try {
    await mkdir(directory);
    created = true;
    const createdStats = await lstat(directory, { bigint: true });
    createdCapability = Object.freeze({
      path: directory,
      identity: Object.freeze({
        device: String(createdStats.dev),
        inode: String(createdStats.ino),
        birthtimeNs: String(createdStats.birthtimeNs),
      }),
    });
    const parentAfter = await lstat(parent, { bigint: true });
    if (
      !sameExtractionIdentity(parentAfter, {
        path: parent,
        identity: {
          device: String(parentBefore.dev),
          inode: String(parentBefore.ino),
          birthtimeNs: String(parentBefore.birthtimeNs),
        },
      })
    ) {
      throw readerError("PACKAGE_TAMPERED");
    }
    const capability = await extractionCapability(source, directory, signal);
    if (!sameExtractionIdentity(createdStats, capability)) {
      throw readerError("PACKAGE_TAMPERED");
    }
    return capability;
  } catch (error) {
    const failure = error instanceof PackageReaderError ? error : readerError("PACKAGE_TAMPERED");
    if (!created) throw error;
    if (!createdCapability) {
      attachReaderRecoveryPath(failure, directory);
      attachSecondaryFailure(failure, "staging-cleanup", new Error("staging cleanup unavailable"));
      throw failure;
    }
    const cleanup = await removeOwnedExtractionDirectory(source, createdCapability, signal);
    if (!cleanup.cleaned) {
      attachReaderRecoveryPath(failure, cleanup.recoveryPath ?? directory);
      attachSecondaryFailure(failure, "staging-cleanup", new Error("staging cleanup failed"));
    }
    throw failure;
  }
}

async function assertSafeRegularFile(
  source: TransferSourceHandle,
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const stats = await lstat(filePath);
  checkAbort(signal);
  const classification = stats.isSymbolicLink()
    ? "symbolic-link"
    : stats.isFile()
      ? "regular-file"
      : stats.isDirectory()
        ? "directory"
        : "reparse-point";
  assertSafeExtractionTargetMetadata({ classification });
  if (classification !== "regular-file") throw readerError("PACKAGE_TAMPERED");
  await source[ASSERT_NO_REPARSE_POINT](filePath, signal);
}

async function ensureSafeParentDirectories(
  source: TransferSourceHandle,
  taskDirectory: string,
  logicalPath: string,
  signal?: AbortSignal,
  capabilities?: Map<string, PackageExtractionCapability>,
): Promise<string> {
  const segments = logicalPath.split("/");
  const fileName = segments.pop();
  if (!fileName) throw readerError("PACKAGE_TAMPERED");
  let current = taskDirectory;
  for (const segment of segments) {
    checkAbort(signal);
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const existingCapability = capabilities?.get(current);
    if (existingCapability) {
      await assertOwnedExtractionDirectory(source, existingCapability, signal);
    } else {
      await assertSafeDirectory(source, current, signal);
      const created = await extractionCapability(source, current, signal);
      capabilities?.set(current, created);
    }
  }
  const destination = path.join(current, fileName);
  const relative = path.relative(taskDirectory, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw readerError("PACKAGE_TAMPERED");
  }
  try {
    await lstat(destination);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return destination;
    throw error;
  }
  throw readerError("PACKAGE_TAMPERED");
}

async function closePreserving(
  handle: WritableHandle | undefined,
  primary: unknown,
  phase: string,
): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    attachSecondaryFailure(primary, phase, error);
  }
}

type ActiveEntry = {
  taskDirectory: string;
  spoolPath: string;
  spoolHandle: FileHandle;
  spoolBytes: number;
  chunkCount: number;
  compressedBytes: number;
  originalBytes: number;
};

type PackageReaderState =
  | "new"
  | "reading-header"
  | "header"
  | "unlocking"
  | "unlocked"
  | "scanning-manifest"
  | "manifest-ready"
  | "extracting"
  | "succeeded"
  | "failed"
  | "closing"
  | "closed";

export class PackageReader {
  readonly #source: TransferSourceHandle;
  readonly #currentImporterVersion: string;
  #state: PackageReaderState = "new";
  #header: DataTransferPublicHeader | undefined;
  #publicHeaderBytes: Buffer | undefined;
  #framesOffset = 0;
  #footer: ReturnType<typeof decodePackageFooter> | undefined;
  #footerOffset = 0;
  #keys: DerivedPackageKeys | undefined;
  #scannedManifest: TransferManifest | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(source: TransferSourceHandle, currentImporterVersion: string) {
    this.#source = source;
    this.#currentImporterVersion = currentImporterVersion;
  }

  static async open(
    source: string | TransferSourceHandle,
    options?: PackageReaderOpenOptions,
  ): Promise<PackageReader>;
  static async open(
    source: string | TransferSourceHandle,
    password: string,
    options?: PackageReaderOpenOptions,
  ): Promise<PackageReader>;
  static async open(
    source: string | TransferSourceHandle,
    passwordOrOptions: string | PackageReaderOpenOptions = {},
    passwordOptions: PackageReaderOpenOptions = {},
  ): Promise<PackageReader> {
    const sourceHandle =
      typeof source === "string" ? await TransferSourceHandle.open(source) : source;
    if (!(sourceHandle instanceof TransferSourceHandle)) {
      throw new TypeError("Invalid transfer source handle");
    }
    const options = typeof passwordOrOptions === "string" ? passwordOptions : passwordOrOptions;
    const currentImporterVersion = options.currentImporterVersion ?? CURRENT_IMPORTER_VERSION;
    compareSemver(currentImporterVersion, currentImporterVersion);
    const reader = new PackageReader(sourceHandle, currentImporterVersion);
    if (typeof passwordOrOptions === "string") {
      await reader.readPublicHeader();
      await reader.unlock(passwordOrOptions);
    }
    return reader;
  }

  get publicHeader(): DataTransferPublicHeader | undefined {
    return this.#header;
  }

  get manifest(): TransferManifest | undefined {
    return this.#scannedManifest;
  }

  async readPublicHeader(): Promise<DataTransferPublicHeader> {
    if (this.#state === "header" || this.#state === "unlocked") {
      if (!this.#header) throw readerError("READER_STATE_INVALID");
      return this.#header;
    }
    if (this.#state !== "new") throw readerError("READER_STATE_INVALID");
    this.#state = "reading-header";
    try {
      const header = await this.#readAndCommitPublicHeader("reading-header");
      if (this.#state !== "reading-header") throw readerError("READER_STATE_INVALID");
      this.#state = "header";
      return header;
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async unlock(password: string): Promise<void> {
    const needsHeader = this.#state === "new";
    if (!needsHeader && this.#state !== "header") throw readerError("READER_STATE_INVALID");
    this.#state = "unlocking";
    let localKeys: DerivedPackageKeys | undefined;
    try {
      if (needsHeader) await this.#readAndCommitPublicHeader("unlocking");
      if (this.#state !== "unlocking" || !this.#header || !this.#publicHeaderBytes) {
        throw readerError("READER_STATE_INVALID");
      }
      const header = this.#header;
      await this.#source.assertStable();
      localKeys = await verifyPassword(password, header);
      if (this.#source.size < this.#framesOffset + DATA_TRANSFER_FOOTER_BYTES) {
        throw readerError("PACKAGE_INCOMPLETE");
      }
      const footerOffset = this.#source.size - DATA_TRANSFER_FOOTER_BYTES;
      const footerBytes = await this.#source.readExactly(footerOffset, DATA_TRANSFER_FOOTER_BYTES);
      let footer: ReturnType<typeof decodePackageFooter>;
      try {
        footer = decodeFooterForReader(footerBytes);
      } finally {
        footerBytes.fill(0);
      }
      const manifestOffset = bigintToSafeNumber(footer.manifestFrameOffset);
      if (manifestOffset < this.#framesOffset || manifestOffset >= footerOffset) {
        throw readerError("PACKAGE_TAMPERED");
      }
      const maximumFrames = BigInt(
        Math.floor((footerOffset - this.#framesOffset) / MINIMUM_SERIALIZED_FRAME_BYTES),
      );
      if (footer.totalFrames < 1n || footer.totalFrames > maximumFrames) {
        throw readerError("PACKAGE_TAMPERED");
      }
      const expectedMac = computePackageFooterMac(
        localKeys.headerAuthKey,
        footer.manifestFrameOffset,
        footer.totalFrames,
        Buffer.from(footer.finalAuthenticationChainDigest),
      );
      const suppliedMac = Buffer.from(footer.footerMac);
      try {
        if (!crypto.timingSafeEqual(expectedMac, suppliedMac)) {
          throw readerError("PACKAGE_TAMPERED");
        }
      } finally {
        expectedMac.fill(0);
        suppliedMac.fill(0);
      }
      await this.#source.assertStable();
      if (this.#state !== "unlocking") throw readerError("READER_STATE_INVALID");
      this.#footer = footer;
      this.#footerOffset = footerOffset;
      this.#keys = localKeys;
      localKeys = undefined;
      this.#state = "unlocked";
    } catch (error) {
      await this.#fail(error);
      throw error;
    } finally {
      localKeys?.destroy();
    }
  }

  async scanManifest(signal?: AbortSignal): Promise<TransferManifest> {
    if (this.#state === "manifest-ready") {
      if (!this.#scannedManifest) throw readerError("READER_STATE_INVALID");
      return this.#scannedManifest;
    }
    if (
      this.#state !== "unlocked" ||
      !this.#header ||
      !this.#publicHeaderBytes ||
      !this.#footer ||
      !this.#keys
    ) {
      throw readerError("READER_STATE_INVALID");
    }
    this.#state = "scanning-manifest";
    try {
      checkAbort(signal);
      await this.#source.assertStable(signal);
      const frameReader = new AuthenticatedFrameReader({
        payloadKey: this.#keys.payloadKey,
        packageId: this.#header.packageId,
        publicHeaderDigest: computePublicHeaderDigest(this.#publicHeaderBytes),
        noncePrefix: Buffer.from(this.#header.noncePrefixHex, "hex"),
      });
      const pathPolicy = new ArchivePathPolicy();
      const entries: TransferManifestEntry[] = [];
      let activeEntry:
        | { chunkCount: number; compressedBytes: number; originalBytes: number }
        | undefined;
      let totalOriginalBytes = 0;
      let totalChunkCount = 0;
      let expectedOrdinal = 0;
      let position = this.#framesOffset;
      let manifest: TransferManifest | undefined;
      const manifestOffset = bigintToSafeNumber(this.#footer.manifestFrameOffset);

      while (position < this.#footerOffset) {
        checkAbort(signal);
        const headerBytes = await this.#source.readExactly(
          position,
          DATA_TRANSFER_FRAME_HEADER_BYTES,
          signal,
        );
        const frameHeader = decodeFrameHeaderForReader(headerBytes);
        const payloadOffset = position + DATA_TRANSFER_FRAME_HEADER_BYTES;
        const frameEnd = checkedOffsetEnd(
          payloadOffset,
          frameHeader.cipherLength,
          this.#footerOffset,
        );
        const payload = await this.#source.readExactly(
          payloadOffset,
          frameHeader.cipherLength,
          signal,
        );
        let decoded: ReturnType<AuthenticatedFrameReader["decrypt"]> | undefined;
        try {
          decoded = frameReader.decrypt(headerBytes, payload);
          checkAbort(signal);
        } finally {
          headerBytes.fill(0);
          payload.fill(0);
        }
        const compressedBytes = decoded.compressedBytes;
        try {
          if (decoded.header.type === DataTransferFrameType.Manifest) {
            if (
              position !== manifestOffset ||
              frameEnd !== this.#footerOffset ||
              activeEntry ||
              decoded.header.flags !== 1 ||
              decoded.header.entryOrdinal !== 0 ||
              decoded.header.chunkIndex !== 0 ||
              decoded.header.plainLength !== compressedBytes.byteLength
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            manifest = parseCanonicalManifest(compressedBytes);
          } else if (position >= manifestOffset) {
            throw readerError("PACKAGE_TAMPERED");
          } else if (decoded.header.flags === 0) {
            if (
              decoded.header.entryOrdinal !== expectedOrdinal ||
              decoded.header.chunkIndex !== (activeEntry?.chunkCount ?? 0)
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            activeEntry ??= { chunkCount: 0, compressedBytes: 0, originalBytes: 0 };
            activeEntry.compressedBytes = checkedAddArchiveBytes(
              activeEntry.compressedBytes,
              compressedBytes.byteLength,
              Number.MAX_SAFE_INTEGER,
            );
            activeEntry.originalBytes = checkedAddArchiveBytes(
              activeEntry.originalBytes,
              decoded.header.plainLength,
              DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
            );
            activeEntry.chunkCount += 1;
          } else {
            if (
              decoded.header.entryOrdinal !== expectedOrdinal ||
              decoded.header.chunkIndex !== (activeEntry?.chunkCount ?? 0) ||
              decoded.header.plainLength !== compressedBytes.byteLength
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            const entry = parseCanonicalJson(compressedBytes, (value) =>
              TransferManifestEntrySchema.parse(value),
            );
            activeEntry ??= { chunkCount: 0, compressedBytes: 0, originalBytes: 0 };
            if (
              entry.ordinal !== expectedOrdinal ||
              entry.chunkCount !== activeEntry.chunkCount ||
              entry.compressedBytes !== activeEntry.compressedBytes ||
              entry.originalBytes !== activeEntry.originalBytes ||
              expectedEntryKind(entry.logicalPath) !== entry.kind
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            pathPolicy.claim(entry.logicalPath, entry.compressedBytes, entry.originalBytes);
            entries.push(entry);
            totalOriginalBytes = checkedAddArchiveBytes(
              totalOriginalBytes,
              entry.originalBytes,
              DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
            );
            totalChunkCount = checkedAddArchiveBytes(
              totalChunkCount,
              entry.chunkCount,
              Number.MAX_SAFE_INTEGER,
            );
            expectedOrdinal += 1;
            activeEntry = undefined;
          }
        } finally {
          compressedBytes.fill(0);
          decoded.authenticationChainDigest.fill(0);
        }
        position = frameEnd;
      }

      if (!manifest || position !== this.#footerOffset || activeEntry) {
        throw readerError("PACKAGE_INCOMPLETE");
      }
      frameReader.finish(
        this.#footer.totalFrames,
        Buffer.from(this.#footer.finalAuthenticationChainDigest),
      );
      const expectedFrameCount = BigInt(totalChunkCount) + BigInt(entries.length) + 1n;
      if (
        this.#footer.totalFrames !== expectedFrameCount ||
        manifest.packageFormatVersion !== DATA_TRANSFER_PACKAGE_VERSION ||
        manifest.packageId !== this.#header.packageId ||
        manifest.minimumImporterVersion !== this.#header.minimumImporterVersion ||
        manifest.totalOriginalBytes !== totalOriginalBytes ||
        manifest.totalChunkCount !== totalChunkCount ||
        manifest.entries.length !== entries.length ||
        !bytesEqual(canonicalEncodeJson(manifest.entries), canonicalEncodeJson(entries))
      ) {
        throw readerError("PACKAGE_TAMPERED");
      }
      await this.#source.assertStable(signal);
      checkAbort(signal);
      if (this.#state !== "scanning-manifest" || !this.#keys) {
        throw readerError("READER_STATE_INVALID");
      }
      this.#scannedManifest = manifest;
      this.#state = "manifest-ready";
      return manifest;
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #readAndCommitPublicHeader(
    expectedState: "reading-header" | "unlocking",
  ): Promise<DataTransferPublicHeader> {
    const magic = await this.#source.readExactly(0, createDataTransferMagicBytes().byteLength);
    try {
      if (!magic.equals(Buffer.from(createDataTransferMagicBytes()))) {
        throw readerError("PACKAGE_TAMPERED");
      }
    } finally {
      magic.fill(0);
    }
    const lengthOffset = createDataTransferMagicBytes().byteLength;
    const lengthBytes = await this.#source.readExactly(
      lengthOffset,
      DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES,
    );
    let headerLength: number;
    try {
      headerLength = lengthBytes.readUInt32BE(0);
    } finally {
      lengthBytes.fill(0);
    }
    if (headerLength < 1 || headerLength > DATA_TRANSFER_HEADER_LIMIT) {
      throw readerError("PACKAGE_TAMPERED");
    }
    const headerOffset = lengthOffset + DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES;
    let publicHeaderBytes: Buffer | undefined = await this.#source.readExactly(
      headerOffset,
      headerLength,
    );
    try {
      const header = decodePublicHeaderForReader(publicHeaderBytes);
      if (compareSemver(header.minimumImporterVersion, this.#currentImporterVersion) > 0) {
        throw readerError("PACKAGE_TOO_NEW");
      }
      await this.#source.assertStable();
      if (this.#state !== expectedState) throw readerError("READER_STATE_INVALID");
      this.#header = header;
      this.#publicHeaderBytes = publicHeaderBytes;
      publicHeaderBytes = undefined;
      this.#framesOffset = headerOffset + headerLength;
      return header;
    } finally {
      publicHeaderBytes?.fill(0);
    }
  }

  async extractTo(stagingRoot: string, signal?: AbortSignal): Promise<PackageExtractionResult>;
  async extractTo(
    stagingRoots: PackageExtractionRoots,
    signal?: AbortSignal,
  ): Promise<PackageExtractionResult>;
  async extractTo(
    stagingRootOrRoots: string | PackageExtractionRoots,
    signal?: AbortSignal,
  ): Promise<PackageExtractionResult> {
    if (
      (this.#state !== "unlocked" && this.#state !== "manifest-ready") ||
      !this.#header ||
      !this.#publicHeaderBytes ||
      !this.#footer ||
      !this.#keys
    ) {
      throw readerError("READER_STATE_INVALID");
    }
    const splitRoots = typeof stagingRootOrRoots === "object";
    if (splitRoots && !this.#scannedManifest) throw readerError("READER_STATE_INVALID");
    this.#state = "extracting";
    let libraryTaskDirectory: string | undefined;
    let userDataTaskDirectory: string | undefined;
    let libraryTaskCapability: PackageExtractionCapability | undefined;
    let userDataTaskCapability: PackageExtractionCapability | undefined;
    const createdTaskDirectories: PackageExtractionCapability[] = [];
    let activeEntry: ActiveEntry | undefined;
    try {
      checkAbort(signal);
      await this.#source.assertStable(signal);
      const libraryRoot = path.resolve(
        splitRoots ? stagingRootOrRoots.libraryRoot : stagingRootOrRoots,
      );
      const userDataRoot = splitRoots ? path.resolve(stagingRootOrRoots.userDataRoot) : libraryRoot;
      await assertSafeDirectory(this.#source, libraryRoot, signal);
      if (splitRoots) await assertSafeDirectory(this.#source, userDataRoot, signal);
      const taskId = crypto.randomUUID();
      libraryTaskDirectory = path.join(libraryRoot, `.package-extract-${taskId}`);
      libraryTaskCapability = await createOwnedExtractionDirectory(
        this.#source,
        libraryTaskDirectory,
        signal,
      );
      createdTaskDirectories.push(libraryTaskCapability);
      if (splitRoots) {
        userDataTaskDirectory = path.join(userDataRoot, `.package-extract-${taskId}`);
        userDataTaskCapability = await createOwnedExtractionDirectory(
          this.#source,
          userDataTaskDirectory,
          signal,
        );
        createdTaskDirectories.push(userDataTaskCapability);
      } else {
        userDataTaskDirectory = libraryTaskDirectory;
        userDataTaskCapability = libraryTaskCapability;
      }
      const assertTaskDirectory = async (taskDirectory: string): Promise<void> => {
        const capability =
          taskDirectory === userDataTaskDirectory ? userDataTaskCapability : libraryTaskCapability;
        if (!capability) throw readerError("READER_STATE_INVALID");
        await assertOwnedExtractionDirectory(this.#source, capability, signal);
      };
      const destinationDirectoryCapabilities = new Map<string, PackageExtractionCapability>();

      const frameReader = new AuthenticatedFrameReader({
        payloadKey: this.#keys.payloadKey,
        packageId: this.#header.packageId,
        publicHeaderDigest: computePublicHeaderDigest(this.#publicHeaderBytes),
        noncePrefix: Buffer.from(this.#header.noncePrefixHex, "hex"),
      });
      const pathPolicy = new ArchivePathPolicy();
      const entries: TransferManifestEntry[] = [];
      const payloadHash = crypto.createHash("sha256");
      let totalOriginalBytes = 0;
      let totalChunkCount = 0;
      let expectedOrdinal = 0;
      let position = this.#framesOffset;
      let manifest: TransferManifest | undefined;
      const manifestOffset = bigintToSafeNumber(this.#footer.manifestFrameOffset);

      while (position < this.#footerOffset) {
        checkAbort(signal);
        const headerBytes = await this.#source.readExactly(
          position,
          DATA_TRANSFER_FRAME_HEADER_BYTES,
          signal,
        );
        const frameHeader = decodeFrameHeaderForReader(headerBytes);
        const payloadOffset = position + DATA_TRANSFER_FRAME_HEADER_BYTES;
        const frameEnd = checkedOffsetEnd(
          payloadOffset,
          frameHeader.cipherLength,
          this.#footerOffset,
        );
        const payload = await this.#source.readExactly(
          payloadOffset,
          frameHeader.cipherLength,
          signal,
        );
        let decoded: ReturnType<AuthenticatedFrameReader["decrypt"]> | undefined;
        try {
          checkAbort(signal);
          decoded = frameReader.decrypt(headerBytes, payload);
          checkAbort(signal);
        } finally {
          headerBytes.fill(0);
          payload.fill(0);
        }
        const compressedBytes = decoded.compressedBytes;
        try {
          if (decoded.header.type === DataTransferFrameType.Manifest) {
            if (
              position !== manifestOffset ||
              frameEnd !== this.#footerOffset ||
              activeEntry ||
              decoded.header.flags !== 1 ||
              decoded.header.entryOrdinal !== 0 ||
              decoded.header.chunkIndex !== 0 ||
              decoded.header.plainLength !== compressedBytes.byteLength
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            manifest = parseCanonicalManifest(compressedBytes);
          } else if (position >= manifestOffset) {
            throw readerError("PACKAGE_TAMPERED");
          } else if (decoded.header.flags === 0) {
            if (
              decoded.header.entryOrdinal !== expectedOrdinal ||
              decoded.header.chunkIndex !== (activeEntry?.chunkCount ?? 0)
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            if (!activeEntry) {
              const scannedEntry = this.#scannedManifest?.entries[expectedOrdinal];
              if (splitRoots && !scannedEntry) throw readerError("PACKAGE_TAMPERED");
              const taskDirectory =
                splitRoots && scannedEntry && isUserDataEntry(scannedEntry)
                  ? userDataTaskDirectory
                  : libraryTaskDirectory;
              if (!taskDirectory) throw readerError("READER_STATE_INVALID");
              await assertTaskDirectory(taskDirectory);
              const spoolPath = path.join(taskDirectory, `.compressed-${crypto.randomUUID()}.tmp`);
              activeEntry = {
                taskDirectory,
                spoolPath,
                spoolHandle: await open(spoolPath, "wx+"),
                spoolBytes: 0,
                chunkCount: 0,
                compressedBytes: 0,
                originalBytes: 0,
              };
              await assertSafeRegularFile(this.#source, spoolPath, signal);
            }
            const recordHeader = Buffer.alloc(ENTRY_SPOOL_RECORD_HEADER_BYTES);
            recordHeader.writeUInt32BE(decoded.header.plainLength, 0);
            recordHeader.writeUInt32BE(compressedBytes.byteLength, 4);
            try {
              await writeAll(activeEntry.spoolHandle, recordHeader, signal);
              await writeAll(activeEntry.spoolHandle, compressedBytes, signal);
            } finally {
              recordHeader.fill(0);
            }
            activeEntry.spoolBytes = checkedAddArchiveBytes(
              activeEntry.spoolBytes,
              ENTRY_SPOOL_RECORD_HEADER_BYTES + compressedBytes.byteLength,
              Number.MAX_SAFE_INTEGER,
            );
            activeEntry.compressedBytes = checkedAddArchiveBytes(
              activeEntry.compressedBytes,
              compressedBytes.byteLength,
              Number.MAX_SAFE_INTEGER,
            );
            activeEntry.originalBytes = checkedAddArchiveBytes(
              activeEntry.originalBytes,
              decoded.header.plainLength,
              DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
            );
            activeEntry.chunkCount += 1;
          } else {
            if (
              decoded.header.entryOrdinal !== expectedOrdinal ||
              decoded.header.chunkIndex !== (activeEntry?.chunkCount ?? 0) ||
              decoded.header.plainLength !== compressedBytes.byteLength
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            const entry = parseCanonicalJson(compressedBytes, (value) =>
              TransferManifestEntrySchema.parse(value),
            );
            if (!activeEntry) {
              const scannedEntry = this.#scannedManifest?.entries[expectedOrdinal];
              if (splitRoots && !scannedEntry) throw readerError("PACKAGE_TAMPERED");
              const taskDirectory =
                splitRoots && scannedEntry && isUserDataEntry(scannedEntry)
                  ? userDataTaskDirectory
                  : libraryTaskDirectory;
              if (!taskDirectory) throw readerError("READER_STATE_INVALID");
              await assertTaskDirectory(taskDirectory);
              const spoolPath = path.join(taskDirectory, `.compressed-${crypto.randomUUID()}.tmp`);
              activeEntry = {
                taskDirectory,
                spoolPath,
                spoolHandle: await open(spoolPath, "wx+"),
                spoolBytes: 0,
                chunkCount: 0,
                compressedBytes: 0,
                originalBytes: 0,
              };
              await assertSafeRegularFile(this.#source, spoolPath, signal);
            }
            if (
              entry.ordinal !== expectedOrdinal ||
              entry.chunkCount !== activeEntry.chunkCount ||
              entry.compressedBytes !== activeEntry.compressedBytes ||
              entry.originalBytes !== activeEntry.originalBytes ||
              expectedEntryKind(entry.logicalPath) !== entry.kind
            ) {
              throw readerError("PACKAGE_TAMPERED");
            }
            const expectedDestination = isUserDataEntry(entry) ? "user-data" : "library";
            const actualDestination =
              activeEntry.taskDirectory === userDataTaskDirectory && splitRoots
                ? "user-data"
                : "library";
            if (splitRoots && actualDestination !== expectedDestination) {
              throw readerError("PACKAGE_TAMPERED");
            }
            pathPolicy.claim(entry.logicalPath, entry.compressedBytes, entry.originalBytes);
            await activeEntry.spoolHandle.sync();
            checkAbort(signal);
            const taskDirectory = activeEntry.taskDirectory;
            await assertTaskDirectory(taskDirectory);
            const outputPath = path.join(taskDirectory, `.plaintext-${crypto.randomUUID()}.tmp`);
            let outputHandle: FileHandle | undefined;
            let outputClosed = false;
            const entryHash = crypto.createHash("sha256");
            let outputBytes = 0;
            try {
              outputHandle = await open(outputPath, "wx");
              await assertSafeRegularFile(this.#source, outputPath, signal);
              let spoolPosition = 0;
              for (let chunkIndex = 0; chunkIndex < activeEntry.chunkCount; chunkIndex += 1) {
                checkAbort(signal);
                const recordHeader = await readExactlyFromHandle(
                  activeEntry.spoolHandle,
                  spoolPosition,
                  ENTRY_SPOOL_RECORD_HEADER_BYTES,
                  activeEntry.spoolBytes,
                  signal,
                );
                let plainLength: number;
                let compressedLength: number;
                try {
                  plainLength = recordHeader.readUInt32BE(0);
                  compressedLength = recordHeader.readUInt32BE(4);
                } finally {
                  recordHeader.fill(0);
                }
                spoolPosition += ENTRY_SPOOL_RECORD_HEADER_BYTES;
                const compressed = await readExactlyFromHandle(
                  activeEntry.spoolHandle,
                  spoolPosition,
                  compressedLength,
                  activeEntry.spoolBytes,
                  signal,
                );
                spoolPosition += compressedLength;
                let plaintext: Buffer | undefined;
                try {
                  checkAbort(signal);
                  if (entry.compression === "stored") {
                    if (compressed.byteLength !== plainLength) {
                      throw readerError("PACKAGE_TAMPERED");
                    }
                    plaintext = Buffer.from(compressed);
                  } else {
                    try {
                      plaintext = Buffer.from(
                        await inflateRawAsync(compressed, { maxOutputLength: plainLength }),
                      );
                    } catch {
                      throw readerError("PACKAGE_TAMPERED");
                    }
                    if (plaintext.byteLength !== plainLength) {
                      throw readerError("PACKAGE_TAMPERED");
                    }
                  }
                  checkAbort(signal);
                  entryHash.update(plaintext);
                  payloadHash.update(plaintext);
                  await writeAll(outputHandle, plaintext, signal);
                  outputBytes = checkedAddArchiveBytes(
                    outputBytes,
                    plaintext.byteLength,
                    entry.originalBytes,
                  );
                } finally {
                  compressed.fill(0);
                  plaintext?.fill(0);
                }
              }
              if (spoolPosition !== activeEntry.spoolBytes || outputBytes !== entry.originalBytes) {
                throw readerError("PACKAGE_TAMPERED");
              }
              if (entryHash.digest("hex") !== entry.sha256) {
                throw readerError("PACKAGE_TAMPERED");
              }
              checkAbort(signal);
              await outputHandle.sync();
              checkAbort(signal);
              await outputHandle.close();
              outputClosed = true;
              checkAbort(signal);
              await activeEntry.spoolHandle.close();
              await assertSafeDirectory(this.#source, taskDirectory, signal);
              await unlink(activeEntry.spoolPath);
              checkAbort(signal);
              const destination = await ensureSafeParentDirectories(
                this.#source,
                taskDirectory,
                entry.logicalPath,
                signal,
                destinationDirectoryCapabilities,
              );
              checkAbort(signal);
              await assertTaskDirectory(taskDirectory);
              const destinationParent = path.dirname(destination);
              const destinationParentCapability =
                destinationDirectoryCapabilities.get(destinationParent);
              if (destinationParentCapability) {
                await assertOwnedExtractionDirectory(
                  this.#source,
                  destinationParentCapability,
                  signal,
                );
              } else {
                await assertSafeDirectory(this.#source, destinationParent, signal);
              }
              await assertSafeRegularFile(this.#source, outputPath, signal);
              const outputBeforeRename = await lstat(outputPath, { bigint: true });
              const outputCapability: PackageExtractionCapability = Object.freeze({
                path: outputPath,
                identity: Object.freeze({
                  device: String(outputBeforeRename.dev),
                  inode: String(outputBeforeRename.ino),
                  birthtimeNs: String(outputBeforeRename.birthtimeNs),
                }),
              });
              if (!sameExtractionIdentity(outputBeforeRename, outputCapability)) {
                throw readerError("PACKAGE_TAMPERED");
              }
              try {
                await lstat(destination);
                throw readerError("PACKAGE_TAMPERED");
              } catch (error) {
                if (error instanceof PackageReaderError) throw error;
                if (!isNodeError(error, "ENOENT")) throw error;
              }
              await rename(outputPath, destination);
              checkAbort(signal);
              if (destinationParentCapability) {
                await assertOwnedExtractionDirectory(
                  this.#source,
                  destinationParentCapability,
                  signal,
                );
              } else {
                await assertSafeDirectory(this.#source, destinationParent, signal);
              }
              await assertSafeRegularFile(this.#source, destination, signal);
              const movedOutput = await lstat(destination, { bigint: true });
              if (!sameExtractionIdentity(movedOutput, outputCapability)) {
                throw readerError("PACKAGE_TAMPERED");
              }
            } catch (error) {
              if (!outputClosed) await closePreserving(outputHandle, error, "entry-output-close");
              throw error;
            }
            entries.push(entry);
            totalOriginalBytes = checkedAddArchiveBytes(
              totalOriginalBytes,
              entry.originalBytes,
              DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
            );
            totalChunkCount = checkedAddArchiveBytes(
              totalChunkCount,
              entry.chunkCount,
              Number.MAX_SAFE_INTEGER,
            );
            expectedOrdinal += 1;
            activeEntry = undefined;
          }
        } finally {
          compressedBytes.fill(0);
          decoded.authenticationChainDigest.fill(0);
        }
        position = frameEnd;
      }

      if (!manifest || position !== this.#footerOffset || activeEntry) {
        throw readerError("PACKAGE_INCOMPLETE");
      }
      frameReader.finish(
        this.#footer.totalFrames,
        Buffer.from(this.#footer.finalAuthenticationChainDigest),
      );
      const expectedFrameCount = BigInt(totalChunkCount) + BigInt(entries.length) + 1n;
      const payloadDigest = payloadHash.digest("hex");
      if (
        this.#footer.totalFrames !== expectedFrameCount ||
        manifest.packageFormatVersion !== DATA_TRANSFER_PACKAGE_VERSION ||
        manifest.packageId !== this.#header.packageId ||
        manifest.minimumImporterVersion !== this.#header.minimumImporterVersion ||
        manifest.totalOriginalBytes !== totalOriginalBytes ||
        manifest.totalChunkCount !== totalChunkCount ||
        manifest.payloadSha256 !== payloadDigest ||
        manifest.entries.length !== entries.length ||
        !bytesEqual(canonicalEncodeJson(manifest.entries), canonicalEncodeJson(entries))
      ) {
        throw readerError("PACKAGE_TAMPERED");
      }
      if (
        this.#scannedManifest &&
        !bytesEqual(canonicalEncodeJson(manifest), canonicalEncodeJson(this.#scannedManifest))
      ) {
        throw readerError("PACKAGE_TAMPERED");
      }
      await this.#source.assertStable(signal);
      checkAbort(signal);
      if (this.#state !== "extracting" || !this.#keys) {
        throw readerError("READER_STATE_INVALID");
      }
      this.#keys.destroy();
      this.#keys = undefined;
      await this.#source.close();
      if (this.#state !== "extracting") throw readerError("READER_STATE_INVALID");
      this.#state = "succeeded";
      if (
        !libraryTaskDirectory ||
        !userDataTaskDirectory ||
        !libraryTaskCapability ||
        !userDataTaskCapability
      ) {
        throw readerError("READER_STATE_INVALID");
      }
      if (!splitRoots) {
        return Object.freeze({
          manifest,
          stagingPath: libraryTaskDirectory,
          stagingCapabilities: Object.freeze({
            library: libraryTaskCapability,
            userData: userDataTaskCapability,
          }),
        });
      }
      const entryDestinations = Object.freeze(
        Object.fromEntries(
          manifest.entries.map((entry) => [
            entry.logicalPath,
            isUserDataEntry(entry) ? "user-data" : "library",
          ]),
        ) as Record<string, "library" | "user-data">,
      );
      return Object.freeze({
        manifest,
        stagingPath: libraryTaskDirectory,
        stagingPaths: Object.freeze({
          library: libraryTaskDirectory,
          userData: userDataTaskDirectory,
        }),
        stagingCapabilities: Object.freeze({
          library: libraryTaskCapability,
          userData: userDataTaskCapability,
        }),
        entryDestinations,
      });
    } catch (error) {
      if (activeEntry) {
        await closePreserving(activeEntry.spoolHandle, error, "entry-spool-close");
      }
      for (const taskDirectory of createdTaskDirectories.reverse()) {
        const cleanup = await removeOwnedExtractionDirectory(this.#source, taskDirectory, signal);
        if (!cleanup.cleaned) {
          attachReaderRecoveryPath(error, cleanup.recoveryPath ?? taskDirectory.path);
          attachSecondaryFailure(error, "staging-cleanup", new Error("staging cleanup failed"));
        }
      }
      await this.#fail(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state !== "succeeded" && this.#state !== "failed" && this.#state !== "closed") {
      this.#state = "closing";
    }
    this.#closePromise ??= (async () => {
      try {
        this.#keys?.destroy();
        this.#keys = undefined;
        this.#publicHeaderBytes?.fill(0);
        this.#publicHeaderBytes = undefined;
        await this.#source.close();
      } finally {
        if (this.#state === "closing") this.#state = "closed";
      }
    })();
    return this.#closePromise;
  }

  async #fail(primary: unknown): Promise<void> {
    if (this.#state !== "closing" && this.#state !== "closed") this.#state = "failed";
    this.#keys?.destroy();
    this.#keys = undefined;
    this.#publicHeaderBytes?.fill(0);
    this.#publicHeaderBytes = undefined;
    try {
      await this.#source.close();
    } catch (error) {
      attachSecondaryFailure(primary, "source-close", error);
    }
  }
}
