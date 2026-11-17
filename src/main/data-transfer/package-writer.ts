import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify, types } from "node:util";
import { deflateRaw, constants as zlibConstants } from "node:zlib";
import {
  type TransferManifest,
  type TransferManifestEntry,
  TransferManifestSchema,
} from "../../shared/data-transfer/model.js";
import {
  canonicalEncodeJson,
  createDataTransferMagicBytes,
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_PACKAGE_VERSION,
  DataTransferFrameType,
  type DataTransferPublicHeader,
  encodePackageFooter,
  encodePublicHeader,
} from "../../shared/data-transfer/package-format.js";
import {
  ArchivePathPolicy,
  assertArchiveLogicalPathsUnique,
  checkedAddArchiveBytes,
  DATA_TRANSFER_ARCHIVE_LIMITS,
} from "./archive-path-policy.js";
import {
  computePublicHeaderMac,
  createPasswordCheckBlock,
  type DerivedPackageKeys,
  derivePackageKeys,
  SAFE_SCRYPT_PARAMS,
} from "./package-crypto.js";
import { AuthenticatedFrameWriter, computePublicHeaderDigest } from "./package-framing.js";

export const DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES = 4;
const COMPRESSION_SAMPLE_BYTES = 256 * 1024;
const FOOTER_MAC_DOMAIN = Buffer.from("ZXW-DATA-TRANSFER-FOOTER-MAC-V1\0", "ascii");
const deflateRawAsync = promisify(deflateRaw);

function zlibCompressBound(sourceBytes: number): number {
  return sourceBytes + (sourceBytes >>> 12) + (sourceBytes >>> 14) + (sourceBytes >>> 25) + 13;
}

// zlib's documented compressBound formula bounds raw DEFLATE for every strategy,
// including Z_FIXED. Keeping every independently compressed payload within this
// input limit proves Task 5's 8 MiB frame ceiling cannot be exceeded by expansion.
const MAX_DEFLATE_PLAIN_CHUNK_BYTES = (() => {
  let bytes = DATA_TRANSFER_CHUNK_BYTES;
  while (zlibCompressBound(bytes) > DATA_TRANSFER_CHUNK_BYTES) bytes -= 1;
  return bytes;
})();

export type PackageWriterHeader = Readonly<{
  packageId: string;
  minimumImporterVersion: string;
  passwordHint: string | null;
}>;

export type PackageWriterEntry = Readonly<{
  logicalPath: string;
  kind: TransferManifestEntry["kind"];
  source: AsyncIterable<Uint8Array>;
}>;

export type PackageWriterManifestMetadata = Omit<
  TransferManifest,
  "entries" | "payloadSha256" | "totalChunkCount" | "totalOriginalBytes"
>;

export type PackageWriterProgress = Readonly<{
  phase: "entries" | "manifest" | "footer";
  completedOriginalBytes: number;
  completedEntries: number;
}>;

type PackageWritableHandle = Readonly<{
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
  stat(options: { bigint: true }): Promise<BigIntStats>;
}>;

export type PackageFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}>;

export type PackageWriterCreateOptions = Readonly<{
  partialPath: string;
  finalPath: string;
  password: string;
  header: PackageWriterHeader;
  signal?: AbortSignal;
  onProgress?: (progress: PackageWriterProgress) => void;
  onPartialCreated?: (identity: PackageFileIdentity) => Promise<void>;
}>;

type PackageWriterCreateDependencies = Readonly<{
  afterPartialCreate?: () => Promise<void> | void;
}>;

export class PackageWriterError extends Error {
  constructor(readonly code: "CANCELLED" | "WRITER_STATE_INVALID") {
    super(code === "CANCELLED" ? "操作已取消。" : "数据包写入器状态无效。");
    this.name = "PackageWriterError";
  }
}

function cancelled(): PackageWriterError {
  return new PackageWriterError("CANCELLED");
}

function stateInvalid(): PackageWriterError {
  return new PackageWriterError("WRITER_STATE_INVALID");
}

function fileIdentity(stats: BigIntStats): PackageFileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  });
}

function sameFileIdentity(left: PackageFileIdentity, right: PackageFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function restoreQuarantinedFile(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
  } catch {
    // A mismatch is preserved at the quarantine path when no-clobber restoration is unavailable.
  }
}

async function removeCreatedPartial(
  partialPath: string,
  expectedIdentity: PackageFileIdentity,
): Promise<void> {
  const quarantinePath = `${partialPath}.cleanup-${crypto.randomUUID()}`;
  try {
    await rename(partialPath, quarantinePath);
  } catch {
    return;
  }
  try {
    const stats = await lstat(quarantinePath, { bigint: true });
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !sameFileIdentity(fileIdentity(stats), expectedIdentity)
    ) {
      await restoreQuarantinedFile(quarantinePath, partialPath);
      return;
    }
    await unlink(quarantinePath);
  } catch {
    await restoreQuarantinedFile(quarantinePath, partialPath);
    // Cleanup remains secondary to the create failure.
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function resolveAndValidatePaths(
  partialPath: string,
  finalPath: string,
): {
  partialPath: string;
  finalPath: string;
} {
  if (typeof partialPath !== "string" || typeof finalPath !== "string") {
    throw new TypeError("Invalid package writer path");
  }
  const resolvedPartialPath = path.resolve(partialPath);
  const resolvedFinalPath = path.resolve(finalPath);
  if (
    path.dirname(resolvedPartialPath) !== path.dirname(resolvedFinalPath) ||
    resolvedPartialPath !== `${resolvedFinalPath}.partial` ||
    !resolvedFinalPath.toLowerCase().endsWith(".zxwbackup")
  ) {
    throw new TypeError("Invalid package writer path boundary");
  }
  return { partialPath: resolvedPartialPath, finalPath: resolvedFinalPath };
}

async function assertPathMissing(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const error = new Error("Package destination already exists") as NodeJS.ErrnoException;
  error.code = "EEXIST";
  throw error;
}

async function writeAll(
  handle: PackageWritableHandle,
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

export function encodePackagePreamble(headerBytes: Uint8Array): Buffer {
  const magic = createDataTransferMagicBytes();
  const preamble = Buffer.alloc(
    magic.byteLength + DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES + headerBytes.byteLength,
  );
  preamble.set(magic, 0);
  preamble.writeUInt32BE(headerBytes.byteLength, magic.byteLength);
  preamble.set(headerBytes, magic.byteLength + DATA_TRANSFER_PUBLIC_HEADER_LENGTH_BYTES);
  return preamble;
}

export function computePackageFooterMac(
  headerAuthKey: Buffer,
  manifestFrameOffset: bigint,
  totalFrames: bigint,
  finalAuthenticationChainDigest: Buffer,
): Buffer {
  const unsignedFooter = Buffer.from(
    encodePackageFooter({
      manifestFrameOffset,
      totalFrames,
      finalAuthenticationChainDigest: Uint8Array.from(finalAuthenticationChainDigest),
      footerMac: new Uint8Array(32),
    }),
  );
  try {
    return crypto
      .createHmac("sha256", headerAuthKey)
      .update(FOOTER_MAC_DOMAIN)
      .update(unsignedFooter.subarray(0, 56))
      .digest();
  } finally {
    unsignedFooter.fill(0);
  }
}

async function compressRaw(bytes: Buffer): Promise<Buffer> {
  // Z_FIXED prevents a dynamic tree from encoding repeated input above Task 6's
  // 200:1 limit. A 258-byte match requires at least the fixed 8-bit length code
  // plus a 5-bit distance code: 2,064 / 13 ~= 158.8:1 before block overhead.
  return Buffer.from(
    await deflateRawAsync(bytes, {
      strategy: zlibConstants.Z_FIXED,
    }),
  );
}

class SequentialPlaintextReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #signal: AbortSignal | undefined;
  #pending: Uint8Array | undefined;
  #pendingOffset = 0;
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    if (source === null || typeof source?.[Symbol.asyncIterator] !== "function") {
      throw new TypeError("Entry source must be an AsyncIterable");
    }
    this.#iterator = source[Symbol.asyncIterator]();
    this.#signal = signal;
  }

  async read(maxBytes: number, prefix?: Buffer): Promise<Buffer | null> {
    let output: Buffer | undefined = Buffer.allocUnsafe(maxBytes);
    let used = 0;
    try {
      if (prefix) {
        prefix.copy(output);
        used = prefix.byteLength;
      }
      while (used < maxBytes && !this.#done) {
        if (!this.#pending || this.#pendingOffset === this.#pending.byteLength) {
          checkAbort(this.#signal);
          const next = await this.#iterator.next();
          checkAbort(this.#signal);
          if (next.done) {
            this.#done = true;
            this.#pending = undefined;
            break;
          }
          if (!types.isUint8Array(next.value)) {
            throw new TypeError("Entry source yielded invalid bytes");
          }
          this.#pending = next.value;
          this.#pendingOffset = 0;
          if (next.value.byteLength === 0) continue;
        }
        const pending = this.#pending;
        const copied = Math.min(maxBytes - used, pending.byteLength - this.#pendingOffset);
        Buffer.from(pending.buffer, pending.byteOffset + this.#pendingOffset, copied).copy(
          output,
          used,
        );
        used += copied;
        this.#pendingOffset += copied;
        checkAbort(this.#signal);
      }
      if (used === 0) return null;
      const result = output.subarray(0, used);
      output = undefined;
      return result;
    } finally {
      output?.fill(0);
    }
  }

  async close(): Promise<void> {
    this.#pending = undefined;
    await this.#iterator.return?.();
  }
}

function shouldDeflate(sampleBytes: number, compressedSampleBytes: number): boolean {
  if (sampleBytes === 0) return false;
  return compressedSampleBytes * 100 <= sampleBytes * 95;
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

export class PackageWriter {
  readonly createdPartialIdentity: PackageFileIdentity;
  readonly #handle: PackageWritableHandle;
  readonly #keys: DerivedPackageKeys;
  readonly #frameWriter: AuthenticatedFrameWriter;
  readonly #onProgress: ((progress: PackageWriterProgress) => void) | undefined;
  readonly #defaultSignal: AbortSignal | undefined;
  readonly #packageId: string;
  readonly #minimumImporterVersion: string;
  readonly #entries: TransferManifestEntry[] = [];
  readonly #pathPolicy = new ArchivePathPolicy();
  readonly #payloadHash = crypto.createHash("sha256");
  #position: number;
  #completedOriginalBytes = 0;
  #activeEntry = false;
  #state: "active" | "finishing" | "finished" | "failed" = "active";
  #closeAttempted = false;

  private constructor(
    handle: PackageWritableHandle,
    keys: DerivedPackageKeys,
    frameWriter: AuthenticatedFrameWriter,
    position: number,
    publicHeader: DataTransferPublicHeader,
    createdPartialIdentity: PackageFileIdentity,
    options: Pick<PackageWriterCreateOptions, "onProgress" | "signal">,
  ) {
    this.#handle = handle;
    this.#keys = keys;
    this.#frameWriter = frameWriter;
    this.#position = position;
    this.#packageId = publicHeader.packageId;
    this.#minimumImporterVersion = publicHeader.minimumImporterVersion;
    this.#onProgress = options.onProgress;
    this.#defaultSignal = options.signal;
    this.createdPartialIdentity = createdPartialIdentity;
  }

  static async create(
    options: PackageWriterCreateOptions,
    dependencies: PackageWriterCreateDependencies = {},
  ): Promise<PackageWriter> {
    const paths = resolveAndValidatePaths(options.partialPath, options.finalPath);
    checkAbort(options.signal);
    await assertPathMissing(paths.finalPath);
    checkAbort(options.signal);

    const salt = crypto.randomBytes(32);
    const passwordCheckNonce = crypto.randomBytes(12);
    const noncePrefix = crypto.randomBytes(4);
    let keys: DerivedPackageKeys | undefined;
    let handle: PackageWritableHandle | undefined;
    let partialIdentity: PackageFileIdentity | undefined;
    try {
      keys = await derivePackageKeys(options.password, salt);
      checkAbort(options.signal);
      const passwordCheck = createPasswordCheckBlock(keys.passwordCheckKey, passwordCheckNonce);
      const unsignedHeader: DataTransferPublicHeader = {
        packageFormatVersion: DATA_TRANSFER_PACKAGE_VERSION,
        packageId: options.header.packageId,
        minimumImporterVersion: options.header.minimumImporterVersion,
        kdf: SAFE_SCRYPT_PARAMS,
        saltHex: salt.toString("hex"),
        noncePrefixHex: noncePrefix.toString("hex"),
        passwordCheckHex: passwordCheck.toString("hex"),
        passwordHint: options.header.passwordHint,
        headerMacHex: "00".repeat(32),
      };
      const headerMac = computePublicHeaderMac(keys.headerAuthKey, unsignedHeader);
      const publicHeader: DataTransferPublicHeader = {
        ...unsignedHeader,
        headerMacHex: headerMac.toString("hex"),
      };
      const publicHeaderBytes = encodePublicHeader(publicHeader);
      const preamble = encodePackagePreamble(publicHeaderBytes);
      handle = await open(paths.partialPath, "wx");
      partialIdentity = fileIdentity(await handle.stat({ bigint: true }));
      await options.onPartialCreated?.(partialIdentity);
      await dependencies.afterPartialCreate?.();
      checkAbort(options.signal);
      await writeAll(handle, preamble, options.signal);
      checkAbort(options.signal);
      const frameWriter = new AuthenticatedFrameWriter({
        payloadKey: keys.payloadKey,
        packageId: publicHeader.packageId,
        publicHeaderDigest: computePublicHeaderDigest(Buffer.from(publicHeaderBytes)),
        noncePrefix,
      });
      return new PackageWriter(
        handle,
        keys,
        frameWriter,
        preamble.byteLength,
        publicHeader,
        partialIdentity,
        options,
      );
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The first create error remains authoritative.
        }
      }
      if (partialIdentity) await removeCreatedPartial(paths.partialPath, partialIdentity);
      keys?.destroy();
      throw error;
    } finally {
      salt.fill(0);
      passwordCheckNonce.fill(0);
      noncePrefix.fill(0);
    }
  }

  async addEntry(
    entry: PackageWriterEntry,
    signal = this.#defaultSignal,
  ): Promise<TransferManifestEntry> {
    return this.#addEntryCore(entry, signal);
  }

  async #addEntryCore(
    entry: PackageWriterEntry,
    signal: AbortSignal | undefined,
  ): Promise<TransferManifestEntry> {
    if (this.#state !== "active") throw stateInvalid();
    if (this.#activeEntry) {
      const error = stateInvalid();
      await this.#fail(error);
      throw error;
    }
    this.#activeEntry = true;
    let reader: SequentialPlaintextReader | undefined;
    let sample: Buffer | null = null;
    let plaintext: Buffer | null = null;
    try {
      checkAbort(signal);
      assertArchiveLogicalPathsUnique([
        ...this.#entries.map(({ logicalPath }) => logicalPath),
        entry.logicalPath,
      ]);
      const pathProbe = new ArchivePathPolicy();
      for (const existing of this.#entries) {
        pathProbe.claim(existing.logicalPath, existing.compressedBytes, existing.originalBytes);
      }
      pathProbe.claim(entry.logicalPath, 1, 1);
      if (expectedEntryKind(entry.logicalPath) !== entry.kind) {
        throw new TypeError("Package entry kind does not match logical path");
      }

      const ordinal = this.#entries.length;
      const hash = crypto.createHash("sha256");
      reader = new SequentialPlaintextReader(entry.source, signal);
      sample = await reader.read(COMPRESSION_SAMPLE_BYTES);
      checkAbort(signal);
      let compression: TransferManifestEntry["compression"] = "stored";
      if (sample) {
        checkAbort(signal);
        const compressedSample = await compressRaw(sample);
        try {
          checkAbort(signal);
          compression = shouldDeflate(sample.byteLength, compressedSample.byteLength)
            ? "deflate-raw"
            : "stored";
        } finally {
          compressedSample.fill(0);
        }
      }
      const plainChunkBytes =
        compression === "deflate-raw" ? MAX_DEFLATE_PLAIN_CHUNK_BYTES : DATA_TRANSFER_CHUNK_BYTES;

      let originalBytes = 0;
      let compressedBytes = 0;
      let chunkCount = 0;
      if (sample) {
        plaintext = await reader.read(plainChunkBytes, sample);
        sample.fill(0);
        sample = null;
        while (plaintext) {
          checkAbort(signal);
          try {
            originalBytes = checkedAddArchiveBytes(
              originalBytes,
              plaintext.byteLength,
              DATA_TRANSFER_ARCHIVE_LIMITS.entryUncompressedBytes,
            );
            checkedAddArchiveBytes(
              this.#pathPolicy.usage.totalUncompressedBytes,
              originalBytes,
              DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
            );
            hash.update(plaintext);
            this.#payloadHash.update(plaintext);
            let compressed: Buffer;
            if (compression === "deflate-raw") {
              checkAbort(signal);
              compressed = await compressRaw(plaintext);
              checkAbort(signal);
              if (compressed.byteLength > DATA_TRANSFER_CHUNK_BYTES) {
                compressed.fill(0);
                throw new Error("Compressed package chunk exceeds protocol limit");
              }
            } else {
              compressed = plaintext;
            }
            const currentCompressedBytes = compressed.byteLength;
            try {
              await this.#writeFrame(
                {
                  type: DataTransferFrameType.EntryData,
                  flags: 0,
                  entryOrdinal: ordinal,
                  chunkIndex: chunkCount,
                  plainLength: plaintext.byteLength,
                  compressedBytes: compressed,
                },
                signal,
              );
            } finally {
              compressed.fill(0);
            }
            compressedBytes = checkedAddArchiveBytes(
              compressedBytes,
              currentCompressedBytes,
              Number.MAX_SAFE_INTEGER,
            );
            chunkCount += 1;
            this.#completedOriginalBytes = checkedAddArchiveBytes(
              this.#completedOriginalBytes,
              plaintext.byteLength,
              DATA_TRANSFER_ARCHIVE_LIMITS.totalUncompressedBytes,
            );
            this.#emitProgress("entries");
          } finally {
            plaintext.fill(0);
            plaintext = null;
          }
          checkAbort(signal);
          plaintext = await reader.read(plainChunkBytes);
        }
      }

      this.#pathPolicy.claim(entry.logicalPath, compressedBytes, originalBytes);
      const result: TransferManifestEntry = Object.freeze({
        ordinal,
        logicalPath: entry.logicalPath,
        kind: entry.kind,
        compression,
        originalBytes,
        compressedBytes,
        sha256: hash.digest("hex"),
        chunkCount,
      });
      const entryEndBytes = Buffer.from(canonicalEncodeJson(result));
      try {
        await this.#writeFrame(
          {
            type: DataTransferFrameType.EntryData,
            flags: 1,
            entryOrdinal: ordinal,
            chunkIndex: chunkCount,
            plainLength: entryEndBytes.byteLength,
            compressedBytes: entryEndBytes,
          },
          signal,
        );
      } finally {
        entryEndBytes.fill(0);
      }
      this.#entries.push(result);
      this.#emitProgress("entries");
      checkAbort(signal);
      return result;
    } catch (error) {
      try {
        await reader?.close();
      } catch {
        // The first entry failure remains authoritative.
      }
      await this.#fail(error);
      throw error;
    } finally {
      sample?.fill(0);
      plaintext?.fill(0);
      this.#activeEntry = false;
    }
  }

  async finish(
    metadata: PackageWriterManifestMetadata,
    signal = this.#defaultSignal,
  ): Promise<TransferManifest> {
    if (this.#state !== "active") throw stateInvalid();
    if (this.#activeEntry) {
      const error = stateInvalid();
      await this.#fail(error);
      throw error;
    }
    this.#state = "finishing";
    try {
      checkAbort(signal);
      if (
        metadata.packageId !== this.#packageId ||
        metadata.minimumImporterVersion !== this.#minimumImporterVersion
      ) {
        throw new Error("Package manifest identity does not match public header");
      }
      const totalChunkCount = this.#entries.reduce((sum, entry) => sum + entry.chunkCount, 0);
      const manifest = TransferManifestSchema.parse({
        ...metadata,
        entries: this.#entries,
        totalOriginalBytes: this.#completedOriginalBytes,
        totalChunkCount,
        payloadSha256: this.#payloadHash.digest("hex"),
      });
      const manifestBytes = Buffer.from(canonicalEncodeJson(manifest));
      const manifestFrameOffset = BigInt(this.#position);
      try {
        if (manifestBytes.byteLength > DATA_TRANSFER_CHUNK_BYTES) {
          throw new Error("Package manifest exceeds protocol limit");
        }
        this.#emitProgress("manifest");
        await this.#writeFrame(
          {
            type: DataTransferFrameType.Manifest,
            flags: 1,
            entryOrdinal: 0,
            chunkIndex: 0,
            plainLength: manifestBytes.byteLength,
            compressedBytes: manifestBytes,
          },
          signal,
        );
      } finally {
        manifestBytes.fill(0);
      }
      checkAbort(signal);
      this.#emitProgress("footer");
      const finalAuthenticationChainDigest = this.#frameWriter.finalAuthenticationChainDigest;
      const footerMac = computePackageFooterMac(
        this.#keys.headerAuthKey,
        manifestFrameOffset,
        this.#frameWriter.totalFrames,
        finalAuthenticationChainDigest,
      );
      const footer = Buffer.from(
        encodePackageFooter({
          manifestFrameOffset,
          totalFrames: this.#frameWriter.totalFrames,
          finalAuthenticationChainDigest: Uint8Array.from(finalAuthenticationChainDigest),
          footerMac: Uint8Array.from(footerMac),
        }),
      );
      try {
        checkAbort(signal);
        await this.#writeBytes(footer, signal);
        checkAbort(signal);
        await this.#handle.sync();
        checkAbort(signal);
        this.#closeAttempted = true;
        await this.#handle.close();
        checkAbort(signal);
      } finally {
        finalAuthenticationChainDigest.fill(0);
        footerMac.fill(0);
        footer.fill(0);
      }
      this.#keys.destroy();
      this.#state = "finished";
      return manifest;
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #writeFrame(
    input: Parameters<AuthenticatedFrameWriter["encrypt"]>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const frame = this.#frameWriter.encrypt(input);
    try {
      checkAbort(signal);
      await this.#writeBytes(frame.headerBytes, signal);
      await this.#writeBytes(frame.ciphertext, signal);
      await this.#writeBytes(frame.authenticationTag, signal);
      checkAbort(signal);
    } finally {
      frame.nonce.fill(0);
      frame.ciphertext.fill(0);
      frame.authenticationTag.fill(0);
      frame.authenticationChainDigest.fill(0);
    }
  }

  async #writeBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await writeAll(this.#handle, bytes, signal);
    this.#position += bytes.byteLength;
  }

  #emitProgress(phase: PackageWriterProgress["phase"]): void {
    this.#onProgress?.(
      Object.freeze({
        phase,
        completedOriginalBytes: this.#completedOriginalBytes,
        completedEntries: this.#entries.length,
      }),
    );
  }

  async #fail(_error: unknown): Promise<void> {
    this.#state = "failed";
    if (!this.#closeAttempted) {
      this.#closeAttempted = true;
      try {
        await this.#handle.close();
      } catch {
        // The first operation error remains authoritative.
      }
    }
    this.#keys.destroy();
  }
}
