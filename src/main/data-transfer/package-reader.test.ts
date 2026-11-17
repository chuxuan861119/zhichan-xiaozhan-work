import { createHook } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { ChildProcess } from "node:child_process";
import crypto, { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TransferManifest } from "../../shared/data-transfer/model.js";
import {
  canonicalEncodeJson,
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_FRAME_HEADER_BYTES,
  DATA_TRANSFER_MAGIC,
  decodeFrameHeader,
  decodePublicHeader,
} from "../../shared/data-transfer/package-format.js";
import { DerivedPackageKeys } from "./package-crypto.js";
import { PackageReader, TransferSourceHandle } from "./package-reader.js";
import { PackageWriter } from "./package-writer.js";

const PASSWORD = "correct horse battery staple";
const PACKAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const createdDirectories: string[] = [];
type InternalChildProcessSpawn = (this: ChildProcess, options: unknown) => void;

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve: () => void = () => {
    throw new Error("Deferred promise was resolved before initialization");
  };
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function captureWindowsProbeProcess(): {
  spawn: ReturnType<typeof vi.spyOn>;
  child: () => ChildProcess;
} {
  const prototype = ChildProcess.prototype as unknown as { spawn: InternalChildProcessSpawn };
  const originalSpawn = prototype.spawn;
  let captured: ChildProcess | undefined;
  const spawn = vi.spyOn(prototype, "spawn").mockImplementation(function (
    this: ChildProcess,
    options: unknown,
  ) {
    Reflect.apply(originalSpawn, this, [options]);
    captured = this;
  });
  return {
    spawn,
    child: () => {
      if (!captured) throw new Error("Windows probe process was not spawned");
      return captured;
    },
  };
}

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

async function readdirWithoutCleanup(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => !name.includes(".cleanup-"));
}

function manifestMetadata(
  totalBytes: number,
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

type FixtureEntry = Readonly<{
  logicalPath: string;
  kind: "database" | "asset" | "legacy-draft" | "settings" | "verification";
  bytes: Buffer;
}>;

async function createPackage(entries: readonly FixtureEntry[] = []): Promise<string> {
  const directory = await createDirectory("package-reader-source-");
  const finalPath = path.join(directory, "transfer.zxwbackup");
  const partialPath = `${finalPath}.partial`;
  const writer = await PackageWriter.create({
    partialPath,
    finalPath,
    password: PASSWORD,
    header: {
      packageId: PACKAGE_ID,
      minimumImporterVersion: "0.1.0",
      passwordHint: "fixture hint",
    },
  });
  for (const entry of entries) {
    await writer.addEntry({
      logicalPath: entry.logicalPath,
      kind: entry.kind,
      source: (async function* () {
        yield entry.bytes;
      })(),
    });
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  await writer.finish(manifestMetadata(totalBytes));
  return partialPath;
}

async function openAndUnlock(sourcePath: string, password = PASSWORD): Promise<PackageReader> {
  const reader = await PackageReader.open(sourcePath);
  await reader.readPublicHeader();
  await reader.unlock(password);
  return reader;
}

async function fileHandlePrototype() {
  const directory = await createDirectory("package-reader-probe-");
  const handle = await openFile(path.join(directory, "probe"), "wx+");
  const prototype = Object.getPrototypeOf(handle) as {
    read: typeof handle.read;
    write: typeof handle.write;
    sync: typeof handle.sync;
    close: typeof handle.close;
  };
  await handle.close();
  return prototype;
}

async function mutateCanonicalHeader(
  sourcePath: string,
  mutate: (header: ReturnType<typeof decodePublicHeader>) => unknown,
): Promise<void> {
  const bytes = await readFile(sourcePath);
  const lengthOffset = DATA_TRANSFER_MAGIC.byteLength;
  const headerLength = bytes.readUInt32BE(lengthOffset);
  const headerOffset = lengthOffset + 4;
  const header = decodePublicHeader(bytes.subarray(headerOffset, headerOffset + headerLength));
  const changed = Buffer.from(canonicalEncodeJson(mutate(header)));
  expect(changed).toHaveLength(headerLength);
  changed.copy(bytes, headerOffset);
  await writeFile(sourcePath, bytes);
}

function serializedFrameOffsets(bytes: Buffer): number[] {
  const headerLength = bytes.readUInt32BE(DATA_TRANSFER_MAGIC.byteLength);
  const footerOffset = bytes.byteLength - 88;
  const offsets: number[] = [];
  let offset = DATA_TRANSFER_MAGIC.byteLength + 4 + headerLength;
  while (offset < footerOffset) {
    offsets.push(offset);
    const header = decodeFrameHeader(
      bytes.subarray(offset, offset + DATA_TRANSFER_FRAME_HEADER_BYTES),
    );
    offset += DATA_TRANSFER_FRAME_HEADER_BYTES + header.cipherLength;
  }
  expect(offset).toBe(footerOffset);
  return offsets;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PackageReader", () => {
  test("source leases close independently and reject replacement before retry", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    try {
      const lease = await source.fork();
      await lease.close();
      await expect(source.assertStable()).resolves.toBeUndefined();
      const retry = await source.fork();
      await retry.close();
      await rename(sourcePath, `${sourcePath}.moved`);
      await writeFile(sourcePath, "replacement");
      await expect(source.fork()).rejects.toMatchObject({ code: "PACKAGE_INCOMPLETE" });
    } finally {
      await source.close();
    }
  });
  test("reads the public header through one stable source handle", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    try {
      expect(await reader.readPublicHeader()).toMatchObject({
        packageId: PACKAGE_ID,
        passwordHint: "fixture hint",
      });
      expect((await readFile(sourcePath)).byteLength).toBeGreaterThan(0);
    } finally {
      await reader.close();
    }
  });

  test("rejects an overlapping public-header read without duplicating I/O", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    const firstReadStarted = createDeferred();
    const originalReadExactly = source.readExactly.bind(source);
    let readCount = 0;
    const readExactly = vi.spyOn(source, "readExactly").mockImplementation(async (...args) => {
      readCount += 1;
      if (readCount === 1) await firstReadStarted.promise;
      return originalReadExactly(...args);
    });
    const first = reader.readPublicHeader();
    const secondOutcome = await reader.readPublicHeader().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    firstReadStarted.resolve();
    await expect(first).resolves.toMatchObject({ packageId: PACKAGE_ID });
    expect(secondOutcome).toMatchObject({
      ok: false,
      error: { code: "READER_STATE_INVALID" },
    });
    expect(readExactly).toHaveBeenCalledTimes(3);
    await reader.close();
  });

  test("rejects an overlapping unlock before a second scrypt starts", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    await reader.readPublicHeader();
    const firstStableStarted = createDeferred();
    const originalAssertStable = source.assertStable.bind(source);
    let stableCount = 0;
    vi.spyOn(source, "assertStable").mockImplementation(async (...args) => {
      stableCount += 1;
      if (stableCount === 1) await firstStableStarted.promise;
      return originalAssertStable(...args);
    });
    let scryptCount = 0;
    const scryptObserver = createHook({
      init: (_asyncId, type) => {
        if (type === "SCRYPTREQUEST") scryptCount += 1;
      },
    });
    scryptObserver.enable();
    try {
      const first = reader.unlock(PASSWORD);
      const secondOutcome = await reader.unlock(PASSWORD).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      firstStableStarted.resolve();
      await expect(first).resolves.toBeUndefined();
      expect(secondOutcome).toMatchObject({
        ok: false,
        error: { code: "READER_STATE_INVALID" },
      });
      expect(scryptCount).toBe(1);
      expect(stableCount).toBe(2);
    } finally {
      firstStableStarted.resolve();
      scryptObserver.disable();
      await reader.close();
    }
  });

  test("destroys uncommitted unlock keys once when close wins the race", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    await reader.readPublicHeader();
    const footerReadStarted = createDeferred();
    const originalReadExactly = source.readExactly.bind(source);
    const readExactly = vi.spyOn(source, "readExactly").mockImplementation(async (...args) => {
      await footerReadStarted.promise;
      return originalReadExactly(...args);
    });
    const originalDestroy = DerivedPackageKeys.prototype.destroy;
    const destroyed: DerivedPackageKeys[] = [];
    vi.spyOn(DerivedPackageKeys.prototype, "destroy").mockImplementation(function (
      this: DerivedPackageKeys,
    ) {
      destroyed.push(this);
      originalDestroy.call(this);
    });
    const unlocking = reader.unlock(PASSWORD);
    await vi.waitFor(() => expect(readExactly).toHaveBeenCalledTimes(1));
    const closing = reader.close();
    await closing;
    footerReadStarted.resolve();
    await expect(unlocking).rejects.toMatchObject({ code: "READER_STATE_INVALID" });
    expect(destroyed).toHaveLength(1);
    for (const keys of destroyed) {
      expect(keys.passwordCheckKey.equals(Buffer.alloc(32))).toBe(true);
      expect(keys.headerAuthKey.equals(Buffer.alloc(32))).toBe(true);
      expect(keys.payloadKey.equals(Buffer.alloc(32))).toBe(true);
    }
    await expect(reader.close()).resolves.toBeUndefined();
  });

  test("destroys locally derived keys when footer authentication fails", async () => {
    const sourcePath = await createPackage();
    const bytes = await readFile(sourcePath);
    bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 1;
    await writeFile(sourcePath, bytes);
    const reader = await PackageReader.open(sourcePath);
    await reader.readPublicHeader();
    const originalDestroy = DerivedPackageKeys.prototype.destroy;
    const destroyed: DerivedPackageKeys[] = [];
    vi.spyOn(DerivedPackageKeys.prototype, "destroy").mockImplementation(function (
      this: DerivedPackageKeys,
    ) {
      destroyed.push(this);
      originalDestroy.call(this);
    });
    await expect(reader.unlock(PASSWORD)).rejects.toMatchObject({ code: "PACKAGE_TAMPERED" });
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.payloadKey.equals(Buffer.alloc(32))).toBe(true);
  });

  test("bounds public-header reads and does not read frames or footer", async () => {
    const sourcePath = await createPackage([
      {
        logicalPath: "library/library.sqlite3",
        kind: "database",
        bytes: Buffer.alloc(2 * 1024 * 1024, 0x41),
      },
    ]);
    const prototype = await fileHandlePrototype();
    const originalRead = prototype.read;
    const requested: number[] = [];
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      requested.push(args[2] as number);
      return Reflect.apply(originalRead, this, args as never);
    });
    const reader = await PackageReader.open(sourcePath);
    try {
      await reader.readPublicHeader();
      expect(Math.max(...requested)).toBeLessThanOrEqual(64 * 1024);
      expect(requested.reduce((sum, value) => sum + value, 0)).toBeLessThan(65 * 1024);
    } finally {
      await reader.close();
    }
  });

  test("keeps wrong-password, damaged-verifier, and damaged-header-MAC presentation identical", async () => {
    const wrongPasswordPath = await createPackage();
    const damagedVerifierPath = await createPackage();
    await mutateCanonicalHeader(damagedVerifierPath, (header) => ({
      ...header,
      passwordCheckHex: `${header.passwordCheckHex[0] === "0" ? "1" : "0"}${header.passwordCheckHex.slice(1)}`,
    }));
    const damagedMacPath = await createPackage();
    await mutateCanonicalHeader(damagedMacPath, (header) => ({
      ...header,
      headerMacHex: `${header.headerMacHex[0] === "0" ? "1" : "0"}${header.headerMacHex.slice(1)}`,
    }));
    const presentations: string[] = [];
    for (const [sourcePath, password] of [
      [wrongPasswordPath, "wrong password phrase"],
      [damagedVerifierPath, PASSWORD],
      [damagedMacPath, PASSWORD],
    ] as const) {
      const reader = await PackageReader.open(sourcePath);
      await reader.readPublicHeader();
      const failure = await reader.unlock(password).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "PASSWORD_OR_PACKAGE_INVALID" });
      presentations.push(
        JSON.stringify({
          code: (failure as Error & { code: string }).code,
          message: (failure as Error).message,
        }),
      );
    }
    expect(new Set(presentations)).toHaveLength(1);
  }, 30_000);

  test("supports the compatibility open-and-unlock form without exposing footer damage to a wrong password", async () => {
    const sourcePath = await createPackage();
    const bytes = await readFile(sourcePath);
    bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 1;
    await writeFile(sourcePath, bytes);
    await expect(PackageReader.open(sourcePath, "wrong password phrase")).rejects.toMatchObject({
      code: "PASSWORD_OR_PACKAGE_INVALID",
    });
    await expect(PackageReader.open(sourcePath, PASSWORD)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
    });
  }, 30_000);

  test("detects path replacement, truncation, and timestamp changes", async () => {
    const replacementPath = await createPackage();
    const replacement = await TransferSourceHandle.open(replacementPath);
    const movedPath = `${replacementPath}.moved`;
    await rename(replacementPath, movedPath);
    await copyFile(movedPath, replacementPath);
    await expect(replacement.assertStable()).rejects.toMatchObject({ code: "PACKAGE_INCOMPLETE" });
    await replacement.close();

    const truncationPath = await createPackage();
    const truncated = await TransferSourceHandle.open(truncationPath);
    await truncate(truncationPath, (await stat(truncationPath)).size - 1);
    await expect(truncated.assertStable()).rejects.toMatchObject({ code: "PACKAGE_INCOMPLETE" });
    await truncated.close();

    const mtimePath = await createPackage();
    const changedTime = await TransferSourceHandle.open(mtimePath);
    const before = await stat(mtimePath);
    await utimes(mtimePath, before.atime, new Date(before.mtimeMs + 2_000));
    await expect(changedTime.assertStable()).rejects.toMatchObject({ code: "PACKAGE_INCOMPLETE" });
    await changedTime.close();
  });

  test("closes a transfer source idempotently", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    await source.close();
    await expect(source.close()).resolves.toBeUndefined();
    await expect(source.readExactly(0, 1)).rejects.toMatchObject({
      code: "READER_STATE_INVALID",
    });
  });

  test("extracts stored, deflate, multichunk, and empty entries", async () => {
    const database = Buffer.alloc(8 * 1024 * 1024 + 777, 0x41);
    const settings = randomBytes(512 * 1024);
    const empty = Buffer.alloc(0);
    const sourcePath = await createPackage([
      { logicalPath: "library/library.sqlite3", kind: "database", bytes: database },
      { logicalPath: "portable-settings.json", kind: "settings", bytes: settings },
      {
        logicalPath: "verification/integrity-summary.json",
        kind: "verification",
        bytes: empty,
      },
    ]);
    const stagingRoot = await createDirectory("package-reader-staging-");
    await writeFile(path.join(stagingRoot, "caller-owned.txt"), "keep");
    const reader = await openAndUnlock(sourcePath);
    const result = await reader.extractTo(stagingRoot);
    expect(await readFile(path.join(result.stagingPath, "library/library.sqlite3"))).toEqual(
      database,
    );
    expect(await readFile(path.join(result.stagingPath, "portable-settings.json"))).toEqual(
      settings,
    );
    expect(
      await readFile(path.join(result.stagingPath, "verification/integrity-summary.json")),
    ).toHaveLength(0);
    expect(result.manifest.entries.map(({ compression }) => compression)).toEqual([
      "deflate-raw",
      "stored",
      "stored",
    ]);
    expect(result.manifest.entries[0]?.chunkCount).toBeGreaterThan(1);
    expect(await readFile(path.join(stagingRoot, "caller-owned.txt"), "utf8")).toBe("keep");
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
      code: "READER_STATE_INVALID",
    });
  }, 30_000);

  test("authenticates the manifest without writing entries and then extracts from the same handle", async () => {
    const database = Buffer.alloc(8 * 1024 * 1024 + 17, 0x41);
    const sourcePath = await createPackage([
      { logicalPath: "library/library.sqlite3", kind: "database", bytes: database },
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const stagingRoot = await createDirectory("package-reader-manifest-scan-");
    await writeFile(path.join(stagingRoot, "caller-owned.txt"), "keep");
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    await reader.readPublicHeader();
    await reader.unlock(PASSWORD);

    const manifest = await reader.scanManifest();
    expect(manifest.totalOriginalBytes).toBe(database.byteLength + 8);
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual(["caller-owned.txt"]);

    const result = await reader.extractTo(stagingRoot);
    expect(result.manifest).toEqual(manifest);
    expect(await readFile(path.join(result.stagingPath, "library/library.sqlite3"))).toEqual(
      database,
    );
  }, 30_000);

  test("scans a multi-chunk package with chunk-bounded reads and no staging writes", async () => {
    const sourcePath = await createPackage([
      {
        logicalPath: "library/library.sqlite3",
        kind: "database",
        bytes: randomBytes(DATA_TRANSFER_CHUNK_BYTES * 2 + 31),
      },
    ]);
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    const readExactly = vi.spyOn(source, "readExactly");
    await reader.readPublicHeader();
    await reader.unlock(PASSWORD);
    const scanned = await reader.scanManifest();
    expect(scanned.entries[0]?.chunkCount).toBe(3);
    expect(Math.max(...readExactly.mock.calls.map(([, length]) => length))).toBeLessThanOrEqual(
      DATA_TRANSFER_CHUNK_BYTES + 64,
    );
    await reader.close();
  }, 30_000);

  test("fails a cancelled or tampered manifest scan without creating plaintext", async () => {
    const cancelledPath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const cancelled = await openAndUnlock(cancelledPath);
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.scanManifest(controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(cancelled.scanManifest()).rejects.toMatchObject({ code: "READER_STATE_INVALID" });

    const tamperedPath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const bytes = await readFile(tamperedPath);
    const frameOffset = serializedFrameOffsets(bytes)[0];
    if (frameOffset === undefined) throw new Error("fixture frame missing");
    bytes[frameOffset + DATA_TRANSFER_FRAME_HEADER_BYTES] =
      (bytes[frameOffset + DATA_TRANSFER_FRAME_HEADER_BYTES] ?? 0) ^ 1;
    await writeFile(tamperedPath, bytes);
    const tampered = await openAndUnlock(tamperedPath);
    await expect(tampered.scanManifest()).rejects.toMatchObject({ code: "PACKAGE_TAMPERED" });
  });

  test("serializes manifest scanning and extraction states", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.alloc(1024, 7) },
    ]);
    const stagingRoot = await createDirectory("package-reader-scan-state-");
    const reader = await openAndUnlock(sourcePath);
    const scanning = reader.scanManifest();
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
      code: "READER_STATE_INVALID",
    });
    await expect(scanning).resolves.toMatchObject({ packageId: PACKAGE_ID });
    await expect(reader.scanManifest()).resolves.toMatchObject({ packageId: PACKAGE_ID });
    await reader.close();
  });

  test("routes protocol entry kinds only to the two fixed staging roots", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "library/library.sqlite3", kind: "database", bytes: Buffer.from("db") },
      {
        logicalPath: "legacy-drafts/11111111-1111-4111-8111-111111111111/draft.json",
        kind: "legacy-draft",
        bytes: Buffer.from("draft"),
      },
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
      {
        logicalPath: "verification/integrity-summary.json",
        kind: "verification",
        bytes: Buffer.from("verification"),
      },
    ]);
    const libraryRoot = await createDirectory("package-reader-library-root-");
    const userDataRoot = await createDirectory("package-reader-user-root-");
    const reader = await openAndUnlock(sourcePath);
    await reader.scanManifest();
    const result = await reader.extractTo({ libraryRoot, userDataRoot });
    expect(result.entryDestinations).toEqual({
      "library/library.sqlite3": "library",
      "legacy-drafts/11111111-1111-4111-8111-111111111111/draft.json": "user-data",
      "portable-settings.json": "user-data",
      "verification/integrity-summary.json": "library",
    });
    const roots = result.stagingPaths;
    if (!roots) throw new Error("split staging paths missing");
    const capabilities = result.stagingCapabilities;
    if (!capabilities) throw new Error("split staging capabilities missing");
    expect(capabilities.library.path).toBe(roots.library);
    expect(capabilities.userData.path).toBe(roots.userData);
    expect(await readFile(path.join(roots.library, "library/library.sqlite3"), "utf8")).toBe("db");
    expect(await readFile(path.join(roots.userData, "portable-settings.json"), "utf8")).toBe(
      "settings",
    );
    await expect(
      readFile(path.join(roots.library, "portable-settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["frame", "footer", "truncate"] as const)(
    "rejects %s damage and leaves no task directory",
    async (mutation) => {
      const sourcePath = await createPackage([
        { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
      ]);
      const bytes = await readFile(sourcePath);
      if (mutation === "truncate") {
        await truncate(sourcePath, bytes.byteLength - 1);
      } else if (mutation === "footer") {
        bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 1;
        await writeFile(sourcePath, bytes);
      } else {
        const headerLength = bytes.readUInt32BE(DATA_TRANSFER_MAGIC.byteLength);
        const frameOffset = DATA_TRANSFER_MAGIC.byteLength + 4 + headerLength;
        bytes[frameOffset + 28] = (bytes[frameOffset + 28] ?? 0) ^ 1;
        await writeFile(sourcePath, bytes);
      }
      const stagingRoot = await createDirectory("package-reader-failed-");
      await writeFile(path.join(stagingRoot, "caller-owned.txt"), "keep");
      const reader = await PackageReader.open(sourcePath);
      await reader.readPublicHeader();
      if (mutation === "frame") {
        await reader.unlock(PASSWORD);
        await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
          code: "PACKAGE_TAMPERED",
        });
      } else {
        await expect(reader.unlock(PASSWORD)).rejects.toMatchObject({
          code: mutation === "truncate" ? "PACKAGE_INCOMPLETE" : "PACKAGE_TAMPERED",
        });
      }
      expect(await readdirWithoutCleanup(stagingRoot)).toEqual(["caller-owned.txt"]);
    },
  );

  test.each([
    ["entry data", 0],
    ["entry end", 1],
    ["manifest", 2],
  ] as const)("rejects authenticated %s ciphertext tamper", async (_name, frameIndex) => {
    const sourcePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const bytes = await readFile(sourcePath);
    const frameOffset = serializedFrameOffsets(bytes)[frameIndex];
    if (frameOffset === undefined) throw new Error("fixture frame missing");
    const tamperOffset = frameOffset + DATA_TRANSFER_FRAME_HEADER_BYTES;
    bytes[tamperOffset] = (bytes[tamperOffset] ?? 0) ^ 1;
    await writeFile(sourcePath, bytes);
    const stagingRoot = await createDirectory("package-reader-frame-tamper-");
    const reader = await openAndUnlock(sourcePath);
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
    });
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual([]);
  });

  test("rejects an unknown frame type before creating plaintext output", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const bytes = await readFile(sourcePath);
    const frameOffset = serializedFrameOffsets(bytes)[0];
    if (frameOffset === undefined) throw new Error("fixture frame missing");
    bytes[frameOffset] = 0xff;
    await writeFile(sourcePath, bytes);
    const stagingRoot = await createDirectory("package-reader-unknown-frame-");
    const reader = await openAndUnlock(sourcePath);
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
    });
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual([]);
  });

  test("rejects an aborted extraction, removes only its own directory, and permanently fails", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "library/library.sqlite3", kind: "database", bytes: Buffer.alloc(1024, 1) },
    ]);
    const stagingRoot = await createDirectory("package-reader-cancel-");
    await mkdir(path.join(stagingRoot, "caller-owned"));
    const reader = await openAndUnlock(sourcePath);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.extractTo(stagingRoot, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual(["caller-owned"]);
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({
      code: "READER_STATE_INVALID",
    });
  });

  test("rejects a symbolic-link or junction staging root", async () => {
    const sourcePath = await createPackage();
    const parent = await createDirectory("package-reader-link-");
    const realRoot = path.join(parent, "real");
    const linkedRoot = path.join(parent, "linked");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const reader = await openAndUnlock(sourcePath);
    await expect(reader.extractTo(linkedRoot)).rejects.toMatchObject({ code: "PACKAGE_TAMPERED" });
    expect(await readdir(realRoot)).toEqual([]);
  });

  test("inspects and extracts from Chinese source and staging paths", async () => {
    const originalSource = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const parent = await createDirectory("package-reader-unicode-");
    const sourcePath = path.join(parent, "完整数据包 中文.zxwbackup");
    const stagingRoot = path.join(parent, "导入 暂存区");
    await copyFile(originalSource, sourcePath);
    await mkdir(stagingRoot);
    const reader = await openAndUnlock(sourcePath);
    const result = await reader.extractTo(stagingRoot);
    expect(await readFile(path.join(result.stagingPath, "portable-settings.json"), "utf8")).toBe(
      "settings",
    );
  });

  test("reuses one persistent Windows reparse probe across many entry checks", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "library/library.sqlite3", kind: "database", bytes: Buffer.from("database") },
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
      {
        logicalPath: "verification/integrity-summary.json",
        kind: "verification",
        bytes: Buffer.from("verification"),
      },
    ]);
    const stagingRoot = await createDirectory("package-reader-persistent-probe-");
    const probe = captureWindowsProbeProcess();
    const reader = await openAndUnlock(sourcePath);
    await reader.extractTo(stagingRoot);
    expect(probe.spawn).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 0);
    if (process.platform === "win32") expect(probe.child().exitCode).toBe(0);
  });

  test("does not remove a pre-existing directory when the task UUID collides", async () => {
    const sourcePath = await createPackage();
    const stagingRoot = await createDirectory("package-reader-existing-task-");
    const fixedUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const occupied = path.join(stagingRoot, `.package-extract-${fixedUuid}`);
    await mkdir(occupied);
    await writeFile(path.join(occupied, "caller-owned.txt"), "keep");
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(fixedUuid);
    const reader = await openAndUnlock(sourcePath);
    await expect(reader.extractTo(stagingRoot)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(occupied, "caller-owned.txt"), "utf8")).toBe("keep");
  });

  test("cancels a stable-source reparse check through its AbortSignal", async () => {
    const sourcePath = await createPackage();
    const source = await TransferSourceHandle.open(sourcePath);
    const controller = new AbortController();
    controller.abort();
    await expect(source.assertStable(controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await source.close();
  });

  test.runIf(process.platform === "win32")(
    "poisons and terminates a probe when an in-flight check is cancelled",
    async () => {
      const sourcePath = await createPackage();
      const probe = captureWindowsProbeProcess();
      const source = await TransferSourceHandle.open(sourcePath);
      const child = probe.child();
      child.stdout?.pause();
      if (!child.stdin) throw new Error("Windows probe stdin was not piped");
      const write = vi.spyOn(child.stdin, "write");
      const controller = new AbortController();
      const stable = source.assertStable(controller.signal);
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      controller.abort();
      await expect(stable).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(source.assertStable()).rejects.toMatchObject({ code: "CANCELLED" });
      await source.close();
      expect(child.killed).toBe(true);
      expect(probe.spawn).toHaveBeenCalledTimes(1);
    },
  );

  test.runIf(process.platform === "win32")(
    "times out and terminates a probe that stops producing responses",
    async () => {
      const sourcePath = await createPackage();
      const probe = captureWindowsProbeProcess();
      const source = await TransferSourceHandle.open(sourcePath);
      const child = probe.child();
      child.stdout?.pause();
      await expect(source.assertStable()).rejects.toThrow(
        "Windows file attribute probe request timed out",
      );
      await expect(source.assertStable()).rejects.toThrow(
        "Windows file attribute probe request timed out",
      );
      await source.close();
      expect(child.killed).toBe(true);
      expect(probe.spawn).toHaveBeenCalledTimes(1);
    },
    5_000,
  );

  test.runIf(process.platform === "win32")(
    "keeps the first failure when the persistent probe exits",
    async () => {
      const sourcePath = await createPackage();
      const probe = captureWindowsProbeProcess();
      const source = await TransferSourceHandle.open(sourcePath);
      const child = probe.child();
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await exited;
      await expect(source.assertStable()).rejects.toThrow(
        "Windows file attribute probe exited unexpectedly",
      );
      await expect(source.assertStable()).rejects.toThrow(
        "Windows file attribute probe exited unexpectedly",
      );
      await source.close();
      expect(probe.spawn).toHaveBeenCalledTimes(1);
    },
  );

  test.runIf(process.platform === "win32")(
    "rejects a partial response that corrupts the next probe frame",
    async () => {
      const sourcePath = await createPackage();
      const probe = captureWindowsProbeProcess();
      const source = await TransferSourceHandle.open(sourcePath);
      const child = probe.child();
      child.stdout?.emit("data", Buffer.from("999\tOK"));
      await expect(source.assertStable()).rejects.toThrow(
        "Invalid Windows file attribute probe response",
      );
      await source.close();
      expect(child.killed).toBe(true);
      expect(probe.spawn).toHaveBeenCalledTimes(1);
    },
  );

  test.runIf(process.platform === "win32")(
    "correlates multiple requests for an ordinary Chinese source path",
    async () => {
      const parent = await createDirectory("package-reader-probe-chinese-");
      const originalSource = await createPackage();
      const sourcePath = path.join(parent, "普通中文路径 数据包.zxwbackup");
      await copyFile(originalSource, sourcePath);
      const probe = captureWindowsProbeProcess();
      const source = await TransferSourceHandle.open(sourcePath);
      await Promise.all([source.assertStable(), source.assertStable(), source.assertStable()]);
      await source.close();
      expect(probe.spawn).toHaveBeenCalledTimes(1);
    },
  );

  test("handles repeated short source reads and staging writes", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const stagingRoot = await createDirectory("package-reader-short-io-");
    const prototype = await fileHandlePrototype();
    const originalRead = prototype.read;
    const originalWrite = prototype.write;
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const changed = [...args];
      changed[2] = Math.min(changed[2] as number, 7);
      return Reflect.apply(originalRead, this, changed as never);
    });
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const changed = [...args];
      changed[2] = Math.min(changed[2] as number, 5);
      return Reflect.apply(originalWrite, this, changed as never);
    });
    const reader = await openAndUnlock(sourcePath);
    const result = await reader.extractTo(stagingRoot);
    expect(await readFile(path.join(result.stagingPath, "portable-settings.json"), "utf8")).toBe(
      "settings",
    );
  });

  test("rejects zero-length read and write progress without looping", async () => {
    const readPath = await createPackage();
    const prototype = await fileHandlePrototype();
    vi.spyOn(prototype, "read").mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(15) });
    const readReader = await PackageReader.open(readPath);
    await expect(readReader.readPublicHeader()).rejects.toMatchObject({
      code: "PACKAGE_INCOMPLETE",
    });

    vi.restoreAllMocks();
    const writePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const stagingRoot = await createDirectory("package-reader-zero-write-");
    const writeReader = await openAndUnlock(writePath);
    const writePrototype = await fileHandlePrototype();
    vi.spyOn(writePrototype, "write").mockResolvedValueOnce({ bytesWritten: 0 } as never);
    await expect(writeReader.extractTo(stagingRoot)).rejects.toThrow(
      "Invalid package write result",
    );
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual([]);
  });

  test("preserves a sync system error, cleans its task directory, and keeps caller files", async () => {
    const sourcePath = await createPackage([
      { logicalPath: "portable-settings.json", kind: "settings", bytes: Buffer.from("settings") },
    ]);
    const stagingRoot = await createDirectory("package-reader-sync-error-");
    await writeFile(path.join(stagingRoot, "caller-owned.txt"), "keep");
    const reader = await openAndUnlock(sourcePath);
    const prototype = await fileHandlePrototype();
    const systemError = new Error("simulated staging sync failure");
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(systemError);
    await expect(reader.extractTo(stagingRoot)).rejects.toBe(systemError);
    expect(await readdirWithoutCleanup(stagingRoot)).toEqual(["caller-owned.txt"]);
    expect((await readdir(stagingRoot)).some((name) => name.includes(".cleanup-"))).toBe(true);
  });

  test("preserves a final source-close error and removes the otherwise complete staging task", async () => {
    const sourcePath = await createPackage();
    const stagingRoot = await createDirectory("package-reader-close-error-");
    const source = await TransferSourceHandle.open(sourcePath);
    const reader = await PackageReader.open(source);
    await reader.readPublicHeader();
    await reader.unlock(PASSWORD);
    const systemError = new Error("simulated final source close failure");
    const close = vi.spyOn(source, "close").mockRejectedValue(systemError);
    try {
      await expect(reader.extractTo(stagingRoot)).rejects.toBe(systemError);
      expect(await readdirWithoutCleanup(stagingRoot)).toEqual([]);
    } finally {
      close.mockRestore();
      await source.close();
    }
  });

  test("rejects unknown versions before password work", async () => {
    const sourcePath = await createPackage();
    await mutateCanonicalHeader(sourcePath, (header) => ({ ...header, packageFormatVersion: 3 }));
    const reader = await PackageReader.open(sourcePath);
    await expect(reader.readPublicHeader()).rejects.toMatchObject({ code: "PACKAGE_TOO_NEW" });
  });
});
