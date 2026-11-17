import { Buffer } from "node:buffer";
import { types } from "node:util";
import {
  DATA_TRANSFER_HEADER_LIMIT,
  isTransferLogicalPath,
  type TransferLogicalPath,
} from "../../shared/data-transfer/package-format.js";
import type { AppErrorCode } from "../../shared/ipc/result.js";

export const DATA_TRANSFER_ARCHIVE_LIMITS = Object.freeze({
  publicHeaderBytes: DATA_TRANSFER_HEADER_LIMIT,
  logicalPathBytes: 1024,
  entryCount: 1_000_000,
  entryUncompressedBytes: 64 * 1024 ** 3,
  totalUncompressedBytes: 16 * 1024 ** 4,
  maximumCompressionRatio: 200,
} as const);

export type ArchiveResourceUsage = Readonly<{
  entryCount: number;
  totalUncompressedBytes: number;
}>;

export type ArchivePolicyErrorReason =
  | "invalid-resource-size"
  | "public-header-too-large"
  | "logical-path-too-long"
  | "logical-path-not-nfc"
  | "unsafe-logical-path"
  | "logical-path-not-allowlisted"
  | "duplicate-logical-path"
  | "duplicate-case-folded-logical-path"
  | "duplicate-nfc-logical-path"
  | "duplicate-nfc-case-folded-logical-path"
  | "entry-count-exceeded"
  | "entry-uncompressed-size-exceeded"
  | "total-uncompressed-size-exceeded"
  | "compression-ratio-exceeded"
  | "resource-budget-exceeded"
  | "unsafe-extraction-target-metadata";

type ArchivePolicyErrorCode = Extract<AppErrorCode, "PACKAGE_TAMPERED">;

export class ArchivePolicyError extends Error {
  readonly code: ArchivePolicyErrorCode = "PACKAGE_TAMPERED";

  constructor(readonly reason: ArchivePolicyErrorReason) {
    super("数据包资源或归档结构不符合安全要求。");
    this.name = "ArchivePolicyError";
  }
}

type PathIdentitySets = Readonly<{
  exact: Set<string>;
  caseFolded: Set<string>;
  nfc: Set<string>;
  nfcCaseFolded: Set<string>;
}>;

export type ExtractionTargetMetadata = Readonly<{
  classification:
    | "missing"
    | "regular-file"
    | "directory"
    | "symbolic-link"
    | "junction"
    | "directory-link"
    | "reparse-point";
}>;

export type SafeExtractionTargetMetadata = Readonly<{
  classification: "missing" | "regular-file" | "directory";
}>;

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const WINDOWS_ILLEGAL_PATH_CHARACTER = /[<>"|?*]/u;
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;

function archivePolicyError(reason: ArchivePolicyErrorReason): ArchivePolicyError {
  return new ArchivePolicyError(reason);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function requireSafeNonNegativeInteger(value: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw archivePolicyError("invalid-resource-size");
  }
}

function requireUsage(usage: ArchiveResourceUsage): void {
  if (typeof usage !== "object" || usage === null) {
    throw archivePolicyError("invalid-resource-size");
  }
  requireSafeNonNegativeInteger(usage.entryCount);
  requireSafeNonNegativeInteger(usage.totalUncompressedBytes);
}

export function checkedAddArchiveBytes(current: number, addition: number, limit: number): number {
  requireSafeNonNegativeInteger(current);
  requireSafeNonNegativeInteger(addition);
  requireSafeNonNegativeInteger(limit);
  if (
    current > limit ||
    addition > Number.MAX_SAFE_INTEGER - current ||
    addition > limit - current
  ) {
    throw archivePolicyError("resource-budget-exceeded");
  }
  return current + addition;
}

export function assertPublicHeaderWithinArchiveLimit(byteLength: number): number {
  requireSafeNonNegativeInteger(byteLength);
  if (byteLength > DATA_TRANSFER_ARCHIVE_LIMITS.publicHeaderBytes) {
    throw archivePolicyError("public-header-too-large");
  }
  return byteLength;
}

function assertCompressionRatio(compressedBytes: number, uncompressedBytes: number): void {
  if (uncompressedBytes === 0) return;
  if (compressedBytes === 0) {
    throw archivePolicyError("compression-ratio-exceeded");
  }
  const minimumCompressedBytes = Math.ceil(
    uncompressedBytes / DATA_TRANSFER_ARCHIVE_LIMITS.maximumCompressionRatio,
  );
  if (compressedBytes < minimumCompressedBytes) {
    throw archivePolicyError("compression-ratio-exceeded");
  }
}

export function claimArchiveResourceUsage(
  currentUsage: ArchiveResourceUsage,
  compressedBytes: number,
  uncompressedBytes: number,
): ArchiveResourceUsage {
  requireUsage(currentUsage);
  requireSafeNonNegativeInteger(compressedBytes);
  requireSafeNonNegativeInteger(uncompressedBytes);
  if (currentUsage.entryCount >= DATA_TRANSFER_ARCHIVE_LIMITS.entryCount) {
    throw archivePolicyError("entry-count-exceeded");
  }
  if (uncompressedBytes > DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes) {
    throw archivePolicyError("entry-uncompressed-size-exceeded");
  }
  assertCompressionRatio(compressedBytes, uncompressedBytes);

  if (uncompressedBytes > Number.MAX_SAFE_INTEGER - currentUsage.totalUncompressedBytes) {
    throw archivePolicyError("resource-budget-exceeded");
  }
  if (
    currentUsage.totalUncompressedBytes > DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes ||
    uncompressedBytes >
      DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes - currentUsage.totalUncompressedBytes
  ) {
    throw archivePolicyError("total-uncompressed-size-exceeded");
  }

  return Object.freeze({
    entryCount: currentUsage.entryCount + 1,
    totalUncompressedBytes: currentUsage.totalUncompressedBytes + uncompressedBytes,
  });
}

function createPathIdentitySets(): PathIdentitySets {
  return {
    exact: new Set(),
    caseFolded: new Set(),
    nfc: new Set(),
    nfcCaseFolded: new Set(),
  };
}

function caseFold(value: string): string {
  // The initial lowercase pass makes the closure stable for pairs such as ẞ/ß.
  // Uppercasing then expands multi-code-point folds (for example, ß/SS and ﬀ/FF),
  // while the final lowercase pass closes context variants such as Greek Σ/ς.
  // This locale-independent closure may conservatively reject extra names, which is safe
  // for an extraction boundary and avoids platform-locale-dependent comparisons.
  return value.toLowerCase().toUpperCase().toLowerCase();
}

function duplicateReason(
  pathIdentities: PathIdentitySets,
  logicalPath: string,
): ArchivePolicyErrorReason | null {
  const nfcPath = logicalPath.normalize("NFC");
  if (pathIdentities.exact.has(logicalPath)) return "duplicate-logical-path";
  if (pathIdentities.nfc.has(nfcPath)) return "duplicate-nfc-logical-path";
  if (pathIdentities.caseFolded.has(caseFold(logicalPath))) {
    return "duplicate-case-folded-logical-path";
  }
  if (pathIdentities.nfcCaseFolded.has(caseFold(nfcPath))) {
    return "duplicate-nfc-case-folded-logical-path";
  }
  return null;
}

function addPathIdentity(pathIdentities: PathIdentitySets, logicalPath: string): void {
  const nfcPath = logicalPath.normalize("NFC");
  pathIdentities.exact.add(logicalPath);
  pathIdentities.caseFolded.add(caseFold(logicalPath));
  pathIdentities.nfc.add(nfcPath);
  pathIdentities.nfcCaseFolded.add(caseFold(nfcPath));
}

export function assertArchiveLogicalPathsUnique(logicalPaths: readonly string[]): void {
  const pathIdentities = createPathIdentitySets();
  for (const logicalPath of logicalPaths) {
    if (typeof logicalPath !== "string") {
      throw archivePolicyError("unsafe-logical-path");
    }
    const reason = duplicateReason(pathIdentities, logicalPath);
    if (reason) throw archivePolicyError(reason);
    addPathIdentity(pathIdentities, logicalPath);
  }
}

function assertSafeLogicalPathSyntax(logicalPath: string): void {
  if (logicalPath.length === 0) throw archivePolicyError("unsafe-logical-path");
  if (Buffer.byteLength(logicalPath, "utf8") > DATA_TRANSFER_ARCHIVE_LIMITS.logicalPathBytes) {
    throw archivePolicyError("logical-path-too-long");
  }
  if (
    logicalPath.startsWith("/") ||
    logicalPath.includes("\\") ||
    logicalPath.includes(":") ||
    hasControlCharacter(logicalPath) ||
    UNPAIRED_SURROGATE.test(logicalPath)
  ) {
    throw archivePolicyError("unsafe-logical-path");
  }

  const segments = logicalPath.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_DEVICE_NAME.test(segment) ||
      WINDOWS_ILLEGAL_PATH_CHARACTER.test(segment)
    ) {
      throw archivePolicyError("unsafe-logical-path");
    }
  }
}

function validateArchiveLogicalPath(
  pathIdentities: PathIdentitySets,
  logicalPath: string,
): TransferLogicalPath {
  if (typeof logicalPath !== "string") throw archivePolicyError("unsafe-logical-path");
  assertSafeLogicalPathSyntax(logicalPath);
  const reason = duplicateReason(pathIdentities, logicalPath);
  if (reason) throw archivePolicyError(reason);
  if (logicalPath !== logicalPath.normalize("NFC")) {
    throw archivePolicyError("logical-path-not-nfc");
  }
  if (!isTransferLogicalPath(logicalPath)) {
    throw archivePolicyError("logical-path-not-allowlisted");
  }
  return logicalPath;
}

export function assertSafeExtractionTargetMetadata(
  metadata: unknown,
): SafeExtractionTargetMetadata {
  if (typeof metadata !== "object" || metadata === null) {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }
  if (types.isProxy(metadata)) {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }

  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(metadata);
    ownKeys = Reflect.ownKeys(metadata);
  } catch {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== 1 ||
    ownKeys[0] !== "classification"
  ) {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(metadata, "classification");
  } catch {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, "value") ||
    Object.hasOwn(descriptor, "get") ||
    Object.hasOwn(descriptor, "set")
  ) {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }

  const classification: unknown = descriptor.value;
  if (
    classification !== "missing" &&
    classification !== "regular-file" &&
    classification !== "directory"
  ) {
    throw archivePolicyError("unsafe-extraction-target-metadata");
  }
  return Object.freeze({ classification });
}

export class ArchivePathPolicy {
  #usage: ArchiveResourceUsage = Object.freeze({
    entryCount: 0,
    totalUncompressedBytes: 0,
  });
  readonly #pathIdentities = createPathIdentitySets();

  get usage(): ArchiveResourceUsage {
    return this.#usage;
  }

  claim(
    logicalPath: string,
    compressedBytes: number,
    uncompressedBytes: number,
  ): ArchiveResourceUsage {
    const claimedPath = validateArchiveLogicalPath(this.#pathIdentities, logicalPath);
    const nextUsage = claimArchiveResourceUsage(this.#usage, compressedBytes, uncompressedBytes);

    addPathIdentity(this.#pathIdentities, claimedPath);
    this.#usage = nextUsage;
    return nextUsage;
  }
}
