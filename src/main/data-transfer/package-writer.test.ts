import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open as openFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync, constants as zlibConstants } from "node:zlib";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import type { TransferManifest } from "../../shared/data-transfer/model.js";
import { TransferManifestSchema } from "../../shared/data-transfer/model.js";
import {
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_FOOTER_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  DATA_TRANSFER_MAGIC,
  DataTransferFrameType,
  decodeFrameHeader,
  decodePackageFooter,
  decodePublicHeader,
} from "../../shared/data-transfer/package-format.js";
import { ArchivePathPolicy } from "./archive-path-policy.js";
import { verifyPassword } from "./package-crypto.js";
import { AuthenticatedFrameReader, computePublicHeaderDigest } from "./package-framing.js";
import {
  computePackageFooterMac,
  PackageWriter,
  type PackageWriterCreateOptions,
} from "./package-writer.js";

const PASSWORD = "correct horse battery staple";
const PACKAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const createdDirectories: string[] = [];

type TestPaths = Readonly<{ partialPath: string; finalPath: string }>;
type TestFileHandle = {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

async function createPaths(): Promise<TestPaths> {
  const directory = await mkdtemp(path.join(tmpdir(), "package-writer-"));
  createdDirectories.push(directory);
  const finalPath = path.join(directory, "transfer.zxwbackup");
  return { partialPath: `${finalPath}.partial`, finalPath };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function manifestMetadata(
  totalBytes = 0,
): Omit<TransferManifest, "entries" | "payloadSha256" | "totalChunkCount" | "totalOriginalBytes"> {
  return {
    packageFormatVersion: 2,
    packageId: PACKAGE_ID,
    exportedByVersion: "0.1.0",
    minimumImporterVersion: "0.1.0",
    databaseSchemaVersion: 1,
    databaseSchemaFingerprint: "schema-v1",
    canonicalPatentFormatVersion: 1,
    exportedAt: "2026-08-16T00:00:00.000Z",
    cutoffAt: "2026-08-16T00:00:00.000Z",
    summary: {
      activePatents: 0,
      trashedPatents: 0,
      documents: 0,
      legacyDrafts: 0,
      snapshots: 0,
      assets: 0,
      flowchartProjects: 0,

      totalBytes,
    },
    portableSettingKeys: [],
    excludedMachineSettingCategories: [],
  };
}

async function createWriter(
  paths: TestPaths,
  overrides: Partial<PackageWriterCreateOptions> = {},
): Promise<PackageWriter> {
  return PackageWriter.create({
    ...paths,
    password: PASSWORD,
    header: {
      packageId: PACKAGE_ID,
      minimumImporterVersion: "0.1.0",
      passwordHint: null,
    },
    ...overrides,
  });
}

type EncodedFrame = Readonly<{
  offset: number;
  header: ReturnType<typeof decodeFrameHeader>;
}>;

function parsePackageStructure(bytes: Buffer) {
  expect(bytes.subarray(0, DATA_TRANSFER_MAGIC.byteLength)).toEqual(
    Buffer.from(DATA_TRANSFER_MAGIC),
  );
  const headerLengthOffset = DATA_TRANSFER_MAGIC.byteLength;
  const headerLength = bytes.readUInt32BE(headerLengthOffset);
  const publicHeaderOffset = headerLengthOffset + 4;
  const publicHeaderBytes = bytes.subarray(publicHeaderOffset, publicHeaderOffset + headerLength);
  const publicHeader = decodePublicHeader(Uint8Array.from(publicHeaderBytes));
  const footer = decodePackageFooter(Uint8Array.from(bytes.subarray(-DATA_TRANSFER_FOOTER_BYTES)));
  const frames: EncodedFrame[] = [];
  let offset = publicHeaderOffset + headerLength;
  while (offset < bytes.byteLength - DATA_TRANSFER_FOOTER_BYTES) {
    const header = decodeFrameHeader(
      Uint8Array.from(bytes.subarray(offset, offset + DATA_TRANSFER_FRAME_HEADER_BYTES)),
    );
    frames.push({ offset, header });
    offset += DATA_TRANSFER_FRAME_HEADER_BYTES + header.cipherLength;
  }
  expect(offset).toBe(bytes.byteLength - DATA_TRANSFER_FOOTER_BYTES);
  return { publicHeader, publicHeaderBytes, footer, frames };
}

async function roundTripPackage(bytes: Buffer, password = PASSWORD) {
  const { publicHeader, publicHeaderBytes, footer, frames } = parsePackageStructure(bytes);
  const keys = await verifyPassword(password, publicHeader);
  const dataFrames = new Map<number, Array<{ header: EncodedFrame["header"]; bytes: Buffer }>>();
  const entryEnds = new Map<
    number,
    { header: EncodedFrame["header"]; value: unknown; encodedBytes: number }
  >();
  let manifestValue: unknown;
  let manifestHeader: EncodedFrame["header"] | undefined;
  try {
    const footerMac = computePackageFooterMac(
      keys.headerAuthKey,
      footer.manifestFrameOffset,
      footer.totalFrames,
      Buffer.from(footer.finalAuthenticationChainDigest),
    );
    expect(footerMac).toEqual(Buffer.from(footer.footerMac));
    footerMac.fill(0);

    const reader = new AuthenticatedFrameReader({
      payloadKey: keys.payloadKey,
      packageId: publicHeader.packageId,
      publicHeaderDigest: computePublicHeaderDigest(Buffer.from(publicHeaderBytes)),
      noncePrefix: Buffer.from(publicHeader.noncePrefixHex, "hex"),
    });
    for (const encoded of frames) {
      const headerBytes = bytes.subarray(
        encoded.offset,
        encoded.offset + DATA_TRANSFER_FRAME_HEADER_BYTES,
      );
      const payload = bytes.subarray(
        encoded.offset + DATA_TRANSFER_FRAME_HEADER_BYTES,
        encoded.offset + DATA_TRANSFER_FRAME_HEADER_BYTES + encoded.header.cipherLength,
      );
      const decoded = reader.decrypt(headerBytes, payload);
      if (decoded.header.type === DataTransferFrameType.Manifest) {
        manifestHeader = decoded.header;
        manifestValue = JSON.parse(decoded.compressedBytes.toString("utf8"));
        expect(decoded.header.plainLength).toBe(decoded.compressedBytes.byteLength);
        decoded.compressedBytes.fill(0);
      } else if (decoded.header.flags === 1) {
        entryEnds.set(decoded.header.entryOrdinal, {
          header: decoded.header,
          value: JSON.parse(decoded.compressedBytes.toString("utf8")),
          encodedBytes: decoded.compressedBytes.byteLength,
        });
        decoded.compressedBytes.fill(0);
      } else {
        const chunks = dataFrames.get(decoded.header.entryOrdinal) ?? [];
        chunks.push({ header: decoded.header, bytes: decoded.compressedBytes });
        dataFrames.set(decoded.header.entryOrdinal, chunks);
      }
    }
    reader.finish(footer.totalFrames, Buffer.from(footer.finalAuthenticationChainDigest));
    expect(reader.finalAuthenticationChainDigest).toEqual(
      Buffer.from(footer.finalAuthenticationChainDigest),
    );

    const manifest = TransferManifestSchema.parse(manifestValue);
    expect(manifestHeader).toMatchObject({
      flags: 1,
      entryOrdinal: 0,
      chunkIndex: 0,
    });
    expect(footer.totalFrames).toBe(BigInt(manifest.totalChunkCount + manifest.entries.length + 1));
    expect(footer.manifestFrameOffset).toBe(
      BigInt(
        frames.find(({ header }) => header.type === DataTransferFrameType.Manifest)?.offset ?? -1,
      ),
    );

    const entries = new Map<string, Buffer>();
    const payloadHash = createHash("sha256");
    for (const entry of manifest.entries) {
      const entryEnd = entryEnds.get(entry.ordinal);
      expect(entryEnd).toBeDefined();
      if (!entryEnd) throw new Error("Missing entry-end frame");
      expect(entryEnd.value).toEqual(entry);
      expect(entryEnd.header).toMatchObject({
        type: DataTransferFrameType.EntryData,
        flags: 1,
        entryOrdinal: entry.ordinal,
        chunkIndex: entry.chunkCount,
        plainLength: entryEnd.encodedBytes,
      });
      const chunks = dataFrames.get(entry.ordinal) ?? [];
      expect(chunks).toHaveLength(entry.chunkCount);
      for (const { header } of chunks) {
        expect(header).toMatchObject({
          type: DataTransferFrameType.EntryData,
          flags: 0,
          entryOrdinal: entry.ordinal,
        });
      }
      expect(chunks.map(({ header }) => header.chunkIndex)).toEqual(
        Array.from({ length: entry.chunkCount }, (_, index) => index),
      );
      let compressedBytes = 0;
      const plaintextChunks = chunks.map(({ header, bytes: compressed }) => {
        compressedBytes += compressed.byteLength;
        const plaintext =
          entry.compression === "deflate-raw"
            ? Buffer.from(inflateRawSync(compressed))
            : Buffer.from(compressed);
        expect(plaintext.byteLength).toBe(header.plainLength);
        compressed.fill(0);
        return plaintext;
      });
      expect(compressedBytes).toBe(entry.compressedBytes);
      const plaintext = Buffer.concat(plaintextChunks);
      for (const chunk of plaintextChunks) chunk.fill(0);
      expect(plaintext.byteLength).toBe(entry.originalBytes);
      expect(createHash("sha256").update(plaintext).digest("hex")).toBe(entry.sha256);
      payloadHash.update(plaintext);
      entries.set(entry.logicalPath, plaintext);
    }
    expect(payloadHash.digest("hex")).toBe(manifest.payloadSha256);
    return { manifest, entries, publicHeader, footer, frames };
  } finally {
    for (const chunks of dataFrames.values()) {
      for (const chunk of chunks) chunk.bytes.fill(0);
    }
    keys.destroy();
  }
}

function deterministicNoise(bytes: number): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (let block = 0; offset < result.byteLength; block += 1) {
    const digest = createHash("sha256").update(`seed${block}`).digest();
    const copied = Math.min(digest.byteLength, result.byteLength - offset);
    digest.copy(result, offset, 0, copied);
    digest.fill(0);
    offset += copied;
  }
  return result;
}

async function fileHandlePrototype(): Promise<TestFileHandle> {
  const paths = await createPaths();
  const handle = await openFile(path.join(path.dirname(paths.finalPath), "prototype-probe"), "wx");
  const prototype = Object.getPrototypeOf(handle) as TestFileHandle;
  await handle.close();
  return prototype;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PackageWriter", () => {
  test("creates, syncs, and closes only the partial package", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    await writer.addEntry({
      logicalPath: "library/library.sqlite3",
      kind: "database",
      source: (async function* () {
        yield Buffer.from("abc");
      })(),
    });
    expect(await exists(paths.finalPath)).toBe(false);
    const manifest = await writer.finish(manifestMetadata(3));
    expect(await exists(paths.partialPath)).toBe(true);
    expect(await exists(paths.finalPath)).toBe(false);
    expect(manifest.entries[0]).toMatchObject({
      ordinal: 0,
      logicalPath: "library/library.sqlite3",
      originalBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      chunkCount: 1,
    });
  });

  test("round-trips stored, deflate, multichunk, empty, and irregular sources frame by frame", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    const database = Buffer.concat([
      Buffer.alloc(DATA_TRANSFER_CHUNK_BYTES, 0x41),
      randomBytes(DATA_TRANSFER_CHUNK_BYTES),
    ]);
    const stored = randomBytes(512 * 1024);
    const irregular = deterministicNoise(1_000_000);
    for (let offset = 0; offset < irregular.byteLength; offset += 100) {
      irregular.fill(0, offset, Math.min(offset + 12, irregular.byteLength));
    }
    const inputs = new Map<string, Buffer>([
      ["library/library.sqlite3", database],
      ["verification/integrity-summary.json", stored],
      ["legacy-drafts/123e4567-e89b-42d3-a456-426614174000/draft.json", irregular],
      ["portable-settings.json", Buffer.alloc(0)],
    ]);
    for (const [logicalPath, input] of inputs) {
      const kind = logicalPath.startsWith("library/")
        ? "database"
        : logicalPath.startsWith("verification/")
          ? "verification"
          : logicalPath.startsWith("legacy-drafts/")
            ? "legacy-draft"
            : "settings";
      await writer.addEntry({
        logicalPath,
        kind,
        source: (async function* () {
          const sizes = [1, 31, 65_537, 17, 900_001];
          let offset = 0;
          let index = 0;
          while (offset < input.byteLength) {
            const end = Math.min(input.byteLength, offset + (sizes[index] ?? 1));
            yield input.subarray(offset, end);
            offset = end;
            index = (index + 1) % sizes.length;
          }
        })(),
      });
    }
    const totalBytes = [...inputs.values()].reduce((sum, input) => sum + input.byteLength, 0);
    await writer.finish(manifestMetadata(totalBytes));
    const roundTrip = await roundTripPackage(await readFile(paths.partialPath));
    expect(roundTrip.manifest.entries.map(({ compression }) => compression)).toEqual([
      "deflate-raw",
      "stored",
      "deflate-raw",
      "stored",
    ]);
    for (const [logicalPath, input] of inputs) {
      expect(roundTrip.entries.get(logicalPath)?.equals(input)).toBe(true);
    }
    expect(roundTrip.manifest.entries[0]?.chunkCount).toBeGreaterThan(1);
    expect(
      roundTrip.frames.some(
        ({ header }) =>
          header.entryOrdinal === 0 &&
          header.type === DataTransferFrameType.EntryData &&
          header.flags === 0 &&
          header.plainLength < DATA_TRANSFER_CHUNK_BYTES,
      ),
    ).toBe(true);
    for (const frame of roundTrip.frames) {
      if (frame.header.type === DataTransferFrameType.EntryData && frame.header.flags === 0) {
        expect(frame.header.cipherLength).toBeLessThanOrEqual(
          DATA_TRANSFER_CHUNK_BYTES + DATA_TRANSFER_GCM_TAG_BYTES,
        );
      }
    }
  }, 30_000);

  test("exports a fully repetitive multichunk entry within the Task 6 compression ratio", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    const input = Buffer.alloc(DATA_TRANSFER_CHUNK_BYTES * 2 + 777, 0x41);
    const entry = await writer.addEntry({
      logicalPath: "library/library.sqlite3",
      kind: "database",
      source: (async function* () {
        yield input;
      })(),
    });
    expect(entry).toMatchObject({ compression: "deflate-raw" });
    expect(entry.chunkCount).toBeGreaterThan(1);
    expect(entry.compressedBytes).toBeGreaterThanOrEqual(Math.ceil(entry.originalBytes / 200));
    expect(() =>
      new ArchivePathPolicy().claim(entry.logicalPath, entry.compressedBytes, entry.originalBytes),
    ).not.toThrow();

    const manifest = await writer.finish(manifestMetadata(input.byteLength));
    expect(manifest.entries[0]).toEqual(entry);
    const roundTrip = await roundTripPackage(await readFile(paths.partialPath));
    expect(roundTrip.manifest.entries[0]?.compression).toBe("deflate-raw");
    expect(roundTrip.entries.get(entry.logicalPath)?.equals(input)).toBe(true);
    input.fill(0);
    roundTrip.entries.get(entry.logicalPath)?.fill(0);
  }, 30_000);

  test("keeps the production create API free of deterministic or replaceable internals", async () => {
    expectTypeOf<PackageWriterCreateOptions>().not.toHaveProperty("internal");
    const source = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "package-writer.ts"),
      "utf8",
    );
    expect(source).not.toContain("PackageWriterInternalOptions");
    expect(source).not.toMatch(/\binternal\??\s*:/u);
  });

  test("uses real deflate at the 4.99% and 5% sample boundary", async () => {
    const noise = deterministicNoise(10_000);
    const below = Buffer.from(noise);
    below.fill(0, below.byteLength - 1_001);
    const exact = Buffer.from(noise);
    exact.fill(0, exact.byteLength - 1_002);
    expect(deflateRawSync(below, { strategy: zlibConstants.Z_FIXED })).toHaveLength(9_501);
    expect(deflateRawSync(exact, { strategy: zlibConstants.Z_FIXED })).toHaveLength(9_500);

    async function write(input: Buffer) {
      const paths = await createPaths();
      const writer = await createWriter(paths);
      const entry = await writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          yield input;
        })(),
      });
      await writer.finish(manifestMetadata(input.byteLength));
      return entry;
    }
    await expect(write(below)).resolves.toMatchObject({ compression: "stored" });
    await expect(write(exact)).resolves.toMatchObject({ compression: "deflate-raw" });
    noise.fill(0);
    below.fill(0);
    exact.fill(0);
  });

  test("does not request the next source yield until the current frame is fully written", async () => {
    const paths = await createPaths();
    const first = deterministicNoise(DATA_TRANSFER_CHUNK_BYTES);
    const firstHash = createHash("sha256").update(first).digest("hex");
    const prototype = await fileHandlePrototype();
    const originalWrite = prototype.write;
    const originalAllocUnsafe = Buffer.allocUnsafe;
    let writeCalls = 0;
    let firstFrameWritten = false;
    let largeAllocationsBeforeFirstFrame = 0;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: TestFileHandle,
      ...args: Parameters<TestFileHandle["write"]>
    ) {
      const result = await Reflect.apply(originalWrite, this, args);
      writeCalls += 1;
      if (writeCalls >= 4) firstFrameWritten = true;
      return result;
    });
    vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size: number) => {
      if (!firstFrameWritten && size >= DATA_TRANSFER_CHUNK_BYTES - 64 * 1024) {
        largeAllocationsBeforeFirstFrame += 1;
      }
      return originalAllocUnsafe(size);
    });
    const writer = await createWriter(paths);
    await writer.addEntry({
      logicalPath: "library/library.sqlite3",
      kind: "database",
      source: (async function* () {
        yield first;
        if (!firstFrameWritten) throw new Error("source was prefetched");
        yield Buffer.from("tail");
      })(),
    });
    await writer.finish(manifestMetadata(first.byteLength + 4));
    expect(firstFrameWritten).toBe(true);
    expect(largeAllocationsBeforeFirstFrame).toBeLessThanOrEqual(2);
    expect(createHash("sha256").update(first).digest("hex")).toBe(firstHash);
  }, 20_000);

  test("observes cancellation after real sample compression and closes the partial", async () => {
    const paths = await createPaths();
    const controller = new AbortController();
    let delivered = false;
    const writer = await createWriter(paths, { signal: controller.signal });
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (delivered) return { done: true as const, value: undefined };
                delivered = true;
                setImmediate(() => controller.abort());
                return { done: false as const, value: Buffer.alloc(256 * 1024, 0x41) };
              },
            };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(rm(paths.partialPath)).resolves.toBeUndefined();
  });

  test("checks cancellation after every short write and never continues the write loop", async () => {
    const paths = await createPaths();
    const prototype = await fileHandlePrototype();
    const originalWrite = prototype.write as (...args: unknown[]) => Promise<{
      bytesWritten: number;
    }>;
    const controller = new AbortController();
    let writeCalls = 0;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: TestFileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      writeCalls += 1;
      const result = await Reflect.apply(originalWrite, this, [
        buffer,
        offset,
        Math.min(length, 7),
        position,
      ]);
      controller.abort();
      return result;
    });
    await expect(createWriter(paths, { signal: controller.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(writeCalls).toBe(1);
    expect(await exists(paths.partialPath)).toBe(false);
  });

  test("checks cancellation after the first frame write and closes permanently", async () => {
    const paths = await createPaths();
    const controller = new AbortController();
    const writer = await createWriter(paths, { signal: controller.signal });
    const prototype = await fileHandlePrototype();
    const originalWrite = prototype.write;
    let writeCalls = 0;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: TestFileHandle,
      ...args: Parameters<TestFileHandle["write"]>
    ) {
      writeCalls += 1;
      const result = await Reflect.apply(originalWrite, this, args);
      controller.abort();
      return result;
    });
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          yield Buffer.from("settings");
        })(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(writeCalls).toBe(1);
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
    await expect(rm(paths.partialPath)).resolves.toBeUndefined();
  });

  test("handles repeated short writes without truncating protocol bytes", async () => {
    const paths = await createPaths();
    const prototype = await fileHandlePrototype();
    const originalWrite = prototype.write;
    let writeCalls = 0;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: TestFileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      writeCalls += 1;
      return Reflect.apply(originalWrite, this, [buffer, offset, Math.min(length, 7), position]);
    });
    const writer = await createWriter(paths);
    await writer.finish(manifestMetadata());
    expect(writeCalls).toBeGreaterThan(10);
    await expect(roundTripPackage(await readFile(paths.partialPath))).resolves.toMatchObject({
      manifest: { entries: [] },
    });
  });

  test("closes after cancellation raised by sync and never publishes", async () => {
    const paths = await createPaths();
    const prototype = await fileHandlePrototype();
    const controller = new AbortController();
    vi.spyOn(prototype, "sync").mockImplementation(async () => controller.abort());
    const writer = await createWriter(paths, { signal: controller.signal });
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(rm(paths.partialPath)).resolves.toBeUndefined();
    expect(await exists(paths.finalPath)).toBe(false);
  });

  test("cancels before the footer write and after close without leaking the handle", async () => {
    const footerPaths = await createPaths();
    const footerController = new AbortController();
    const footerWriter = await createWriter(footerPaths, {
      signal: footerController.signal,
      onProgress: ({ phase }) => {
        if (phase === "footer") footerController.abort();
      },
    });
    await expect(footerWriter.finish(manifestMetadata())).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(rm(footerPaths.partialPath)).resolves.toBeUndefined();

    const closePaths = await createPaths();
    const closeController = new AbortController();
    const closeWriter = await createWriter(closePaths, { signal: closeController.signal });
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync;
    vi.spyOn(prototype, "sync").mockImplementation(async function (this: TestFileHandle) {
      await Reflect.apply(originalSync, this, []);
      const originalClose = this.close;
      vi.spyOn(this, "close").mockImplementationOnce(async function (this: TestFileHandle) {
        await Reflect.apply(originalClose, this, []);
        closeController.abort();
      });
    });
    await expect(closeWriter.finish(manifestMetadata())).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(rm(closePaths.partialPath)).resolves.toBeUndefined();
  });

  test.each(["write", "sync"] as const)(
    "preserves the first %s error and makes the writer unusable",
    async (stage) => {
      const paths = await createPaths();
      const prototype = await fileHandlePrototype();
      const error = new Error(`${stage} system error`);
      if (stage === "write") {
        vi.spyOn(prototype, "write").mockRejectedValueOnce(error);
        await expect(createWriter(paths)).rejects.toBe(error);
        return;
      }
      const writer = await createWriter(paths);
      vi.spyOn(prototype, stage).mockRejectedValueOnce(error);
      await expect(writer.finish(manifestMetadata())).rejects.toBe(error);
      await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
        code: "WRITER_STATE_INVALID",
      });
    },
  );

  test("preserves a close error and makes the writer unusable", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    const error = new Error("close system error");
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync as (...args: unknown[]) => Promise<void>;
    vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: TestFileHandle,
      ...args: Parameters<TestFileHandle["sync"]>
    ) {
      await Reflect.apply(originalSync, this, args);
      const originalClose = this.close;
      vi.spyOn(this, "close").mockImplementationOnce(async function (this: TestFileHandle) {
        await Reflect.apply(originalClose, this, []);
        throw error;
      });
    });
    await expect(writer.finish(manifestMetadata())).rejects.toBe(error);
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
  });

  test("preserves a frame write error over a later close error", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    const prototype = await fileHandlePrototype();
    const writeError = new Error("frame write system error");
    const closeError = new Error("secondary close system error");
    vi.spyOn(prototype, "write").mockImplementationOnce(async function (this: TestFileHandle) {
      const originalClose = this.close;
      vi.spyOn(this, "close").mockImplementationOnce(async function (this: TestFileHandle) {
        await Reflect.apply(originalClose, this, []);
        throw closeError;
      });
      throw writeError;
    });
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          yield Buffer.from("settings");
        })(),
      }),
    ).rejects.toBe(writeError);
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
  });

  test("rejects a zero-byte write result and closes the partial", async () => {
    const paths = await createPaths();
    const prototype = await fileHandlePrototype();
    vi.spyOn(prototype, "write").mockResolvedValueOnce({ bytesWritten: 0 });
    await expect(createWriter(paths)).rejects.toThrow("Invalid package write result");
    expect(await exists(paths.partialPath)).toBe(false);
  });

  test("rejects existing partial and final files without overwriting", async () => {
    const first = await createPaths();
    await writeFile(first.partialPath, "existing partial");
    await expect(createWriter(first)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(first.partialPath, "utf8")).toBe("existing partial");
    const second = await createPaths();
    await writeFile(second.finalPath, "existing final");
    await expect(createWriter(second)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(second.finalPath, "utf8")).toBe("existing final");
    expect(await exists(second.partialPath)).toBe(false);
  });

  test("removes only a partial created by this create attempt when initialization fails", async () => {
    const owned = await createPaths();
    const primary = Object.assign(new Error("secret native write failure"), { code: "ENOSPC" });
    await expect(
      PackageWriter.create(
        {
          ...owned,
          password: PASSWORD,
          header: {
            packageId: PACKAGE_ID,
            minimumImporterVersion: "0.1.0",
            passwordHint: null,
          },
        },
        {
          afterPartialCreate: async () => {
            throw primary;
          },
        },
      ),
    ).rejects.toBe(primary);
    expect(await exists(owned.partialPath)).toBe(false);

    const raced = await createPaths();
    await writeFile(raced.partialPath, "external owner");
    await expect(createWriter(raced)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(raced.partialPath, "utf8")).toBe("external owner");
  });

  test("does not delete a replacement installed after wx creation", async () => {
    const paths = await createPaths();
    const displaced = `${paths.partialPath}.displaced`;
    const primary = new Error("initialization failed");
    await expect(
      PackageWriter.create(
        {
          ...paths,
          password: PASSWORD,
          header: {
            packageId: PACKAGE_ID,
            minimumImporterVersion: "0.1.0",
            passwordHint: null,
          },
        },
        {
          afterPartialCreate: async () => {
            await rename(paths.partialPath, displaced);
            await writeFile(paths.partialPath, "external sentinel");
            throw primary;
          },
        },
      ),
    ).rejects.toBe(primary);
    expect(await readFile(paths.partialPath, "utf8")).toBe("external sentinel");
  });

  test("rejects duplicate paths and path-kind mismatches before reading", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    await writer.addEntry({
      logicalPath: "portable-settings.json",
      kind: "settings",
      source: (async function* () {
        yield Buffer.from("first");
      })(),
    });
    let sourceRead = false;
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          sourceRead = true;
          yield Buffer.from("second");
        })(),
      }),
    ).rejects.toMatchObject({ reason: "duplicate-logical-path" });
    expect(sourceRead).toBe(false);
    const mismatchPaths = await createPaths();
    const mismatch = await createWriter(mismatchPaths);
    await expect(
      mismatch.addEntry({
        logicalPath: "portable-settings.json",
        kind: "database",
        source: (async function* () {
          sourceRead = true;
          yield Buffer.from("never");
        })(),
      }),
    ).rejects.toThrow("entry kind");
  });

  test("fails closed when progress reporting throws and emits no paths", async () => {
    const paths = await createPaths();
    const reports: unknown[] = [];
    const callbackError = new Error("progress receiver failed");
    const writer = await createWriter(paths, {
      onProgress: (progress) => {
        reports.push(progress);
        throw callbackError;
      },
    });
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          yield Buffer.from("settings");
        })(),
      }),
    ).rejects.toBe(callbackError);
    expect(JSON.stringify(reports)).not.toContain("portable-settings");
    expect(JSON.stringify(reports)).not.toContain(paths.partialPath);
  });

  test("cancels after the final entry progress callback and closes permanently", async () => {
    const paths = await createPaths();
    const controller = new AbortController();
    const reports: Array<{ completedEntries: number }> = [];
    const writer = await createWriter(paths, {
      signal: controller.signal,
      onProgress: (progress) => {
        reports.push(progress);
        if (progress.completedEntries === 1) controller.abort();
      },
    });
    await expect(
      writer.addEntry({
        logicalPath: "portable-settings.json",
        kind: "settings",
        source: (async function* () {
          yield Buffer.from("settings");
        })(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reports.at(-1)).toMatchObject({ completedEntries: 1 });
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
    await expect(rm(paths.partialPath)).resolves.toBeUndefined();
  });

  test("reports monotonic bytes and entries and hashes original payload", async () => {
    const paths = await createPaths();
    const reports: Array<{ completedOriginalBytes: number; completedEntries: number }> = [];
    const writer = await createWriter(paths, { onProgress: (progress) => reports.push(progress) });
    await writer.addEntry({
      logicalPath: "portable-settings.json",
      kind: "settings",
      source: (async function* () {
        yield Buffer.from("one");
        yield Buffer.from("two");
      })(),
    });
    await writer.addEntry({
      logicalPath: "verification/integrity-summary.json",
      kind: "verification",
      source: (async function* () {
        yield Buffer.from("three");
      })(),
    });
    const manifest = await writer.finish(manifestMetadata(11));
    for (let index = 1; index < reports.length; index += 1) {
      expect(reports[index]?.completedOriginalBytes).toBeGreaterThanOrEqual(
        reports[index - 1]?.completedOriginalBytes ?? 0,
      );
      expect(reports[index]?.completedEntries).toBeGreaterThanOrEqual(
        reports[index - 1]?.completedEntries ?? 0,
      );
    }
    expect(manifest.payloadSha256).toBe(createHash("sha256").update("onetwothree").digest("hex"));
  });

  test("cancels before create or source read with stable CANCELLED", async () => {
    const beforeCreate = await createPaths();
    const createController = new AbortController();
    createController.abort();
    await expect(
      createWriter(beforeCreate, { signal: createController.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await exists(beforeCreate.partialPath)).toBe(false);

    const paths = await createPaths();
    const writer = await createWriter(paths);
    const sourceController = new AbortController();
    sourceController.abort();
    let sourceRead = false;
    await expect(
      writer.addEntry(
        {
          logicalPath: "library/library.sqlite3",
          kind: "database",
          source: (async function* () {
            sourceRead = true;
            yield Buffer.from("never");
          })(),
        },
        sourceController.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sourceRead).toBe(false);
  });

  test("finalizes a failed source iterator and preserves its first error", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    const sourceError = new Error("source device disappeared");
    let finalized = false;
    await expect(
      writer.addEntry({
        logicalPath: "library/library.sqlite3",
        kind: "database",
        source: (async function* () {
          try {
            yield Buffer.alloc(DATA_TRANSFER_CHUNK_BYTES, 1);
            throw sourceError;
          } finally {
            finalized = true;
          }
        })(),
      }),
    ).rejects.toBe(sourceError);
    expect(finalized).toBe(true);
  });

  test("allows finish once and binds manifest identity", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    await writer.finish(manifestMetadata());
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
    const mismatchPaths = await createPaths();
    const mismatch = await createWriter(mismatchPaths);
    await expect(
      mismatch.finish({
        ...manifestMetadata(),
        packageId: "123e4567-e89b-42d3-a456-426614174001",
      }),
    ).rejects.toThrow("manifest identity");
  });

  test("requires no active entry before finish and permanently fails on misuse", async () => {
    const paths = await createPaths();
    const writer = await createWriter(paths);
    let releaseSource: (() => void) | undefined;
    const sourceReady = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const adding = writer.addEntry({
      logicalPath: "portable-settings.json",
      kind: "settings",
      source: (async function* () {
        await sourceReady;
        yield Buffer.from("settings");
      })(),
    });
    await Promise.resolve();
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
    releaseSource?.();
    await expect(adding).rejects.toThrow();
    await expect(writer.finish(manifestMetadata())).rejects.toMatchObject({
      code: "WRITER_STATE_INVALID",
    });
  });

  test.each([
    ["different parent", "elsewhere/transfer.zxwbackup.partial", "transfer.zxwbackup"],
    ["not derived partial", "other.partial", "transfer.zxwbackup"],
    ["wrong final extension", "transfer.bin.partial", "transfer.bin"],
  ])("rejects %s path boundaries", async (_name, partial, final) => {
    const base = await createPaths();
    const directory = path.dirname(base.finalPath);
    await expect(
      createWriter({
        partialPath: path.join(directory, partial),
        finalPath: path.join(directory, final),
      }),
    ).rejects.toThrow("path boundary");
  });
});
