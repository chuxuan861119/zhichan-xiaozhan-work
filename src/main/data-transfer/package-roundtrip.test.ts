import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createV1MinimalPackageFixture,
  V1_FIXTURE_PASSWORD,
  type V1FixtureFrame,
  type V1FixtureFrameRole,
} from "../../../tests/fixtures/data-transfer/v1-minimal-package.fixture.js";
import {
  DATA_TRANSFER_FOOTER_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_GCM_TAG_BYTES,
  DATA_TRANSFER_MAGIC,
  DataTransferFrameType,
  decodeFrameHeader,
  decodePackageFooter,
  decodePublicHeader,
} from "../../shared/data-transfer/package-format.js";
import { PackageReader, type PackageReaderErrorCode } from "./package-reader.js";

const WRONG_PASSWORD = "虚构错误口令用于兼容测试丙丁";
const GOLDEN_BYTE_LENGTH = 4242;
const GOLDEN_SHA256 = "9fcb39387ccd621a49e86992f23546722fd4aa5ae9329103854aaa0f6c8f1ffb";
const createdDirectories: string[] = [];

type PackageStructure = Readonly<{
  headerOffset: number;
  headerLength: number;
  frames: readonly V1FixtureFrame[];
  footerOffset: number;
}>;

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function countDifferences(left: Buffer, right: Buffer): number {
  expect(right).toHaveLength(left.byteLength);
  let differences = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) differences += 1;
  }
  return differences;
}

function mutateOneByte(bytes: Buffer, offset: number): Buffer {
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset).toBeLessThan(bytes.byteLength);
  const changed = Buffer.from(bytes);
  const before = changed[offset];
  changed[offset] = (before ?? 0) ^ 1;
  expect(changed[offset]).not.toBe(before);
  expect(countDifferences(bytes, changed)).toBe(1);
  return changed;
}

function replaceEqualLengthAscii(bytes: Buffer, needle: string, replacement: string): Buffer {
  expect(Buffer.byteLength(replacement, "ascii")).toBe(Buffer.byteLength(needle, "ascii"));
  const offset = bytes.indexOf(needle, 0, "ascii");
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(bytes.indexOf(needle, offset + 1, "ascii")).toBe(-1);
  const changed = Buffer.from(bytes);
  changed.write(replacement, offset, "ascii");
  expect(changed.subarray(offset, offset + replacement.length).toString("ascii")).toBe(replacement);
  expect(countDifferences(bytes, changed)).toBeGreaterThan(0);
  return changed;
}

function parsePackageStructure(bytes: Buffer): PackageStructure {
  expect(bytes.subarray(0, DATA_TRANSFER_MAGIC.byteLength)).toEqual(
    Buffer.from(DATA_TRANSFER_MAGIC),
  );
  const headerLengthOffset = DATA_TRANSFER_MAGIC.byteLength;
  const headerLength = bytes.readUInt32BE(headerLengthOffset);
  const headerOffset = headerLengthOffset + 4;
  decodePublicHeader(bytes.subarray(headerOffset, headerOffset + headerLength));
  const footerOffset = bytes.byteLength - DATA_TRANSFER_FOOTER_BYTES;
  decodePackageFooter(bytes.subarray(footerOffset));
  const frames: V1FixtureFrame[] = [];
  let offset = headerOffset + headerLength;
  while (offset < footerOffset) {
    const header = decodeFrameHeader(
      bytes.subarray(offset, offset + DATA_TRANSFER_FRAME_HEADER_BYTES),
    );
    const cipherOffset = offset + DATA_TRANSFER_FRAME_HEADER_BYTES;
    const tagOffset = cipherOffset + header.cipherLength - DATA_TRANSFER_GCM_TAG_BYTES;
    const endOffset = cipherOffset + header.cipherLength;
    const role: V1FixtureFrameRole =
      header.type === DataTransferFrameType.Manifest
        ? "manifest"
        : header.flags === 1
          ? "entry-end"
          : header.entryOrdinal === 0
            ? "deflate"
            : "stored";
    frames.push(
      Object.freeze({
        role,
        entryOrdinal: header.entryOrdinal,
        offset,
        headerBytes: DATA_TRANSFER_FRAME_HEADER_BYTES,
        cipherOffset,
        tagOffset,
        endOffset,
      }),
    );
    offset = endOffset;
  }
  expect(offset).toBe(footerOffset);
  return { headerOffset, headerLength, frames, footerOffset };
}

function locateFrame(structure: PackageStructure, role: V1FixtureFrameRole): V1FixtureFrame {
  const frame = structure.frames.find((candidate) => candidate.role === role);
  expect(frame, `missing ${role} frame`).toBeDefined();
  return frame as V1FixtureFrame;
}

function mutateFramePart(
  bytes: Buffer,
  structure: PackageStructure,
  role: V1FixtureFrameRole,
  part: "cipher" | "header" | "tag",
): Buffer {
  const frame = locateFrame(structure, role);
  const offset =
    part === "header" ? frame.offset + 2 : part === "cipher" ? frame.cipherOffset : frame.tagOffset;
  const changed = mutateOneByte(bytes, offset);
  expect(changed.subarray(frame.offset, frame.endOffset)).not.toEqual(
    bytes.subarray(frame.offset, frame.endOffset),
  );
  return changed;
}

function deleteFrame(bytes: Buffer, frame: V1FixtureFrame): Buffer {
  const changed = Buffer.concat([bytes.subarray(0, frame.offset), bytes.subarray(frame.endOffset)]);
  expect(changed.byteLength).toBe(bytes.byteLength - (frame.endOffset - frame.offset));
  expect(changed).not.toEqual(bytes);
  return changed;
}

function duplicateFrame(bytes: Buffer, frame: V1FixtureFrame): Buffer {
  const serialized = bytes.subarray(frame.offset, frame.endOffset);
  const changed = Buffer.concat([
    bytes.subarray(0, frame.endOffset),
    serialized,
    bytes.subarray(frame.endOffset),
  ]);
  expect(changed.byteLength).toBe(bytes.byteLength + serialized.byteLength);
  expect(changed.subarray(frame.endOffset, frame.endOffset + serialized.byteLength)).toEqual(
    serialized,
  );
  return changed;
}

function swapFrames(bytes: Buffer, first: V1FixtureFrame, second: V1FixtureFrame): Buffer {
  expect(first.endOffset).toBe(second.offset);
  const firstBytes = bytes.subarray(first.offset, first.endOffset);
  const secondBytes = bytes.subarray(second.offset, second.endOffset);
  const changed = Buffer.concat([
    bytes.subarray(0, first.offset),
    secondBytes,
    firstBytes,
    bytes.subarray(second.endOffset),
  ]);
  expect(changed).toHaveLength(bytes.byteLength);
  expect(changed.subarray(first.offset, first.offset + secondBytes.byteLength)).toEqual(
    secondBytes,
  );
  expect(changed).not.toEqual(bytes);
  return changed;
}

async function writeFixture(
  bytes: Buffer,
): Promise<Readonly<{ sourcePath: string; stagingRoot: string }>> {
  const directory = await createDirectory("zxwbackup-v1-");
  const sourcePath = path.join(directory, "fixture.zxwbackup");
  const stagingRoot = path.join(directory, "staging");
  await writeFile(sourcePath, bytes);
  await mkdir(stagingRoot);
  return { sourcePath, stagingRoot };
}

async function readFailureCode(
  bytes: Buffer,
  options: Readonly<{
    password?: string;
    stopAfterHeader?: boolean;
    stopAfterUnlock?: boolean;
    currentImporterVersion?: string;
  }> = {},
): Promise<PackageReaderErrorCode> {
  const { sourcePath, stagingRoot } = await writeFixture(bytes);
  const readerOptions =
    options.currentImporterVersion === undefined
      ? {}
      : { currentImporterVersion: options.currentImporterVersion };
  const reader = await PackageReader.open(sourcePath, readerOptions);
  try {
    await reader.readPublicHeader();
    if (options.stopAfterHeader) throw new Error("Expected public-header failure");
    await reader.unlock(options.password ?? V1_FIXTURE_PASSWORD);
    if (options.stopAfterUnlock) throw new Error("Expected unlock failure");
    await reader.extractTo(stagingRoot);
    throw new Error("Expected package failure");
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return (error as Error & { code: PackageReaderErrorCode }).code;
    }
    throw error;
  } finally {
    await reader.close();
  }
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("zxwbackup v2 compatibility", () => {
  test("generates identical cross-platform fixture bytes with a locked golden digest", async () => {
    const first = await createV1MinimalPackageFixture();
    const second = await createV1MinimalPackageFixture();
    const firstDigest = createHash("sha256").update(first.bytes).digest("hex");
    const secondDigest = createHash("sha256").update(second.bytes).digest("hex");

    expect(first.bytes).toEqual(second.bytes);
    expect(firstDigest).toBe(secondDigest);
    expect(first.bytes).toHaveLength(GOLDEN_BYTE_LENGTH);
    expect(firstDigest).toBe(GOLDEN_SHA256);
  });

  test("reads the legacy v1 fixture from disk and restores all five allowlisted entries byte-for-byte", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const { sourcePath, stagingRoot } = await writeFixture(fixture.bytes);
    const reader = await PackageReader.open(sourcePath);
    try {
      const header = await reader.readPublicHeader();
      expect(header).toEqual(fixture.publicHeader);
      await reader.unlock(V1_FIXTURE_PASSWORD);
      const result = await reader.extractTo(stagingRoot);

      expect(result.manifest).toEqual(fixture.manifest);
      expect(result.manifest.packageFormatVersion).toBe(2);
      expect(result.manifest.entries).toHaveLength(4);
      expect(
        result.manifest.entries.map(({ logicalPath, kind }) => ({ logicalPath, kind })),
      ).toEqual(fixture.expectedEntries.map(({ logicalPath, kind }) => ({ logicalPath, kind })));
      expect(result.manifest.portableSettingKeys).toContain("patentTemplates");
      for (const entry of fixture.expectedEntries) {
        expect(
          await readFile(path.join(result.stagingPath, ...entry.logicalPath.split("/"))),
        ).toEqual(entry.bytes);
      }
    } finally {
      await reader.close();
    }
  });

  test("keeps wrong password, damaged verifier, and damaged header authentication indistinguishable", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const structure = parsePackageStructure(fixture.bytes);
    const passwordCheckMarker = '"passwordCheckHex":"';
    const passwordCheckStart =
      fixture.bytes.indexOf(passwordCheckMarker, structure.headerOffset, "ascii") +
      passwordCheckMarker.length;
    expect(passwordCheckStart).toBeGreaterThan(structure.headerOffset);
    const damagedVerifier = mutateOneByte(fixture.bytes, passwordCheckStart);
    const headerMacMarker = '"headerMacHex":"';
    const headerMacStart =
      fixture.bytes.indexOf(headerMacMarker, structure.headerOffset, "ascii") +
      headerMacMarker.length;
    expect(headerMacStart).toBeGreaterThan(structure.headerOffset);
    const damagedHeaderMac = mutateOneByte(fixture.bytes, headerMacStart);

    expect(await readFailureCode(fixture.bytes, { password: WRONG_PASSWORD })).toBe(
      "PASSWORD_OR_PACKAGE_INVALID",
    );
    expect(await readFailureCode(damagedVerifier)).toBe("PASSWORD_OR_PACKAGE_INVALID");
    expect(await readFailureCode(damagedHeaderMac)).toBe("PASSWORD_OR_PACKAGE_INVALID");
  });

  test("rejects magic and canonical header JSON byte mutations", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const damagedMagic = mutateOneByte(fixture.bytes, 0);
    const damagedHeaderJson = replaceEqualLengthAscii(
      fixture.bytes,
      '"algorithm":"scrypt"',
      '"blgorithm":"scrypt"',
    );

    expect(await readFailureCode(damagedMagic, { stopAfterHeader: true })).toBe("PACKAGE_TAMPERED");
    expect(await readFailureCode(damagedHeaderJson, { stopAfterHeader: true })).toBe(
      "PACKAGE_TAMPERED",
    );
  });

  test.each(["deflate", "stored", "entry-end", "manifest"] as const)(
    "rejects authenticated %s frame header, ciphertext, and tag mutations",
    async (role) => {
      const fixture = await createV1MinimalPackageFixture();
      const structure = parsePackageStructure(fixture.bytes);
      for (const part of ["header", "cipher", "tag"] as const) {
        const changed = mutateFramePart(fixture.bytes, structure, role, part);
        expect(await readFailureCode(changed)).toBe("PACKAGE_TAMPERED");
      }
    },
  );

  test("rejects deleted, duplicated, swapped, and truncated authenticated frame streams", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const structure = parsePackageStructure(fixture.bytes);
    const first = structure.frames[0] as V1FixtureFrame;
    const second = structure.frames[1] as V1FixtureFrame;
    const deleted = deleteFrame(fixture.bytes, first);
    const duplicated = duplicateFrame(fixture.bytes, first);
    const swapped = swapFrames(fixture.bytes, first, second);
    const truncated = fixture.bytes.subarray(0, fixture.bytes.byteLength - 1);
    expect(truncated.byteLength).toBe(fixture.bytes.byteLength - 1);

    expect(await readFailureCode(deleted)).toBe("PACKAGE_TAMPERED");
    expect(await readFailureCode(duplicated)).toBe("PACKAGE_TAMPERED");
    expect(await readFailureCode(swapped)).toBe("PACKAGE_TAMPERED");
    expect(await readFailureCode(Buffer.from(truncated))).toBe("PACKAGE_INCOMPLETE");
  });

  test("rejects re-authenticated manifest digest and entry metadata mutations", async () => {
    const baseline = await createV1MinimalPackageFixture();
    for (const kind of ["manifest-payload-digest", "entry-metadata"] as const) {
      const changed = await createV1MinimalPackageFixture(kind);
      const mutation = changed.semanticMutation;
      expect(mutation).not.toBeNull();
      expect(mutation?.before).not.toBe(mutation?.after);
      const baselineFrame = baseline.frames.find(
        (frame) => frame.role === mutation?.role && frame.entryOrdinal === mutation.entryOrdinal,
      );
      const changedFrame = changed.frames.find(
        (frame) => frame.role === mutation?.role && frame.entryOrdinal === mutation.entryOrdinal,
      );
      expect(baselineFrame).toEqual(changedFrame);
      expect(changed.bytes.subarray(changedFrame?.offset, changedFrame?.endOffset)).not.toEqual(
        baseline.bytes.subarray(baselineFrame?.offset, baselineFrame?.endOffset),
      );
      expect(changed.bytes).not.toEqual(baseline.bytes);
      expect(await readFailureCode(changed.bytes)).toBe("PACKAGE_TAMPERED");
    }
  });

  test("rejects footer magic, MAC, offset, count, final chain, and trailing bytes", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const structure = parsePackageStructure(fixture.bytes);
    const footerFieldOffsets = {
      magic: structure.footerOffset,
      offset: structure.footerOffset + 8,
      count: structure.footerOffset + 16,
      finalChain: structure.footerOffset + 24,
      mac: structure.footerOffset + 56,
    } as const;
    for (const offset of Object.values(footerFieldOffsets)) {
      const changed = mutateOneByte(fixture.bytes, offset);
      expect(await readFailureCode(changed, { stopAfterUnlock: true })).toBe("PACKAGE_TAMPERED");
    }
    const trailing = Buffer.concat([fixture.bytes, Buffer.from([0x00])]);
    expect(trailing.byteLength).toBe(fixture.bytes.byteLength + 1);
    expect(await readFailureCode(trailing, { stopAfterUnlock: true })).toBe("PACKAGE_TAMPERED");
  }, 15_000);

  test("rejects a higher package format and minimum importer version before password work", async () => {
    const fixture = await createV1MinimalPackageFixture();
    const higherFormat = replaceEqualLengthAscii(
      fixture.bytes,
      '"packageFormatVersion":2',
      '"packageFormatVersion":3',
    );
    const higherMinimumImporter = replaceEqualLengthAscii(
      fixture.bytes,
      '"minimumImporterVersion":"0.1.0"',
      '"minimumImporterVersion":"9.9.9"',
    );

    expect(await readFailureCode(higherFormat, { stopAfterHeader: true })).toBe("PACKAGE_TOO_NEW");
    expect(await readFailureCode(higherMinimumImporter, { stopAfterHeader: true })).toBe(
      "PACKAGE_TOO_NEW",
    );
  });
});
