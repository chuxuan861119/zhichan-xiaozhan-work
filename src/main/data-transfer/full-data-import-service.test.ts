import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TransferManifest } from "../../shared/data-transfer/model.js";
import { projectPortableSettings } from "../../shared/data-transfer/portable-settings.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { DataImportJournal } from "./data-import-journal.js";
import {
  calculateFullDataImportSpaceBudget,
  FullDataImportError,
  FullDataImportService,
  type FullDataImportServiceOptions,
  preflightFullDataImportSpace,
} from "./full-data-import-service.js";
import { LibraryImportSwapCoordinator } from "./library-import-swap-coordinator.js";
import {
  type PackageExtractionResult,
  PackageReaderError,
  type TransferSourceHandle,
} from "./package-reader.js";

const PASSWORD = "correct horse battery staple";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_OPERATION_ID = "323e4567-e89b-42d3-a456-426614174000";
const THIRD_OPERATION_ID = "423e4567-e89b-42d3-a456-426614174000";
const PACKAGE_ID = "223e4567-e89b-42d3-a456-426614174000";
const SALT = Buffer.alloc(32, 3);
const createdRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "full-import-service-"));
  createdRoots.push(root);
  return root;
}

function summary() {
  return {
    activePatents: 1,
    trashedPatents: 2,
    documents: 3,
    legacyDrafts: 0,
    snapshots: 4,
    assets: 5,
    flowchartProjects: 6,

    totalBytes: 2,
  } as const;
}

function manifest(content: Readonly<Record<string, Buffer>> = {}): TransferManifest {
  const entries: TransferManifest["entries"] = [
    ["library/library.sqlite3", "database", 1, "0"],
    ["portable-settings.json", "settings", 1, "1"],
    ["verification/integrity-summary.json", "verification", 0, "2"],
  ].map(([logicalPath, kind, bytes, hash], ordinal) => {
    const payload = content[logicalPath as string];
    const originalBytes = payload?.byteLength ?? (bytes as number);
    const sha256 = payload
      ? createHash("sha256").update(payload).digest("hex")
      : String(hash).repeat(64);
    return {
      ordinal,
      logicalPath: logicalPath as string,
      kind: kind as TransferManifest["entries"][number]["kind"],
      compression: "stored" as const,
      originalBytes,
      compressedBytes: originalBytes,
      sha256,
      chunkCount: originalBytes === 0 ? 0 : 1,
    };
  });
  return {
    packageFormatVersion: 2,
    packageId: PACKAGE_ID,
    exportedByVersion: "0.1.0",
    minimumImporterVersion: "0.1.0",
    databaseSchemaVersion: 9,
    databaseSchemaFingerprint: "schema-v9",
    canonicalPatentFormatVersion: 1,
    exportedAt: "2026-08-16T00:00:00.000Z",
    cutoffAt: "2026-08-16T00:00:00.000Z",
    summary: summary(),
    entries,
    portableSettingKeys: [],
    excludedMachineSettingCategories: [],
    totalOriginalBytes: entries.reduce((sum, entry) => sum + entry.originalBytes, 0),
    totalChunkCount: entries.reduce((sum, entry) => sum + entry.chunkCount, 0),
    payloadSha256: "4".repeat(64),
  };
}

async function createFixture(overrides: Partial<FullDataImportServiceOptions> = {}) {
  const root = await createRoot();
  const applicationDataRoot = path.join(root, "application-data");
  const libraryRoot = path.join(applicationDataRoot, "Library");
  const userDataRoot = path.join(root, "user-data");
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(path.join(libraryRoot, "empty-marker"), "unchanged");
  const events: string[] = [];
  const portableSettingsBytes = Buffer.from(
    JSON.stringify(projectPortableSettings(DEFAULT_APP_SETTINGS)),
  );
  const transferManifest = manifest({
    "library/library.sqlite3": Buffer.from("db"),
    "portable-settings.json": portableSettingsBytes,
    "verification/integrity-summary.json": Buffer.from("{}"),
  });
  const readerFactory = vi.fn(async () => ({
    readPublicHeader: vi.fn(async () => {
      events.push("header");
      return { packageId: PACKAGE_ID, saltHex: SALT.toString("hex") } as never;
    }),
    unlock: vi.fn(async () => {
      events.push("unlock");
    }),
    scanManifest: vi.fn(async () => {
      events.push("manifest");
      return transferManifest;
    }),
    extractTo: vi.fn(async (roots: { libraryRoot: string; userDataRoot: string }) => {
      events.push("extract");
      const library = path.join(roots.libraryRoot, ".package-extract-test");
      const userData = path.join(roots.userDataRoot, ".package-extract-test");
      await mkdir(path.join(library, "library"), { recursive: true });
      await mkdir(path.join(library, "verification"), { recursive: true });
      await mkdir(userData, { recursive: true });
      await writeFile(path.join(library, "library", "library.sqlite3"), "db");
      await writeFile(path.join(library, "verification", "integrity-summary.json"), "{}");
      await writeFile(
        path.join(userData, "portable-settings.json"),
        JSON.stringify(projectPortableSettings(DEFAULT_APP_SETTINGS)),
      );
      const libraryStats = await lstat(library, { bigint: true });
      const userDataStats = await lstat(userData, { bigint: true });
      return {
        manifest: transferManifest,
        stagingPath: library,
        stagingPaths: { library, userData },
        stagingCapabilities: {
          library: {
            path: library,
            identity: {
              device: String(libraryStats.dev),
              inode: String(libraryStats.ino),
              birthtimeNs: String(libraryStats.birthtimeNs),
            },
          },
          userData: {
            path: userData,
            identity: {
              device: String(userDataStats.dev),
              inode: String(userDataStats.ino),
              birthtimeNs: String(userDataStats.birthtimeNs),
            },
          },
        },
      };
    }),
    close: vi.fn(async () => {
      events.push("close");
    }),
  }));
  const sleep = vi.fn(async (_milliseconds: number) => {});
  const options: FullDataImportServiceOptions = {
    libraryRoot,
    userDataRoot,
    applicationDataRoot,
    inspector: {
      inspect: vi.fn(async () => {
        events.push("inspect");
        return { empty: true, blockers: [] };
      }),
    },
    resolveSourceSelection: vi.fn(async (selectionId) => {
      events.push("selection");
      return { selectionId, sourceHandle: {} as TransferSourceHandle };
    }),
    readCurrentSettings: vi.fn(async () => DEFAULT_APP_SETTINGS),
    readerFactory,
    validator: {
      validate: vi.fn(async () => {
        events.push("validate");
        return summary();
      }),
    },
    preflightSpace: vi.fn(async (input) => {
      events.push("space");
      return calculateFullDataImportSpaceBudget(input);
    }),
    sleep,
    ...overrides,
  };
  return {
    service: new FullDataImportService(options),
    applicationDataRoot,
    libraryRoot,
    userDataRoot,
    events,
    readerFactory,
    sleep,
  };
}

function request(signal?: AbortSignal) {
  return {
    operationId: OPERATION_ID,
    sourceSelectionId: "selected-source",
    password: PASSWORD,
    ...(signal ? { signal } : {}),
  };
}

test("normal preview cancellation removes owned bytes and permits another prepare", async () => {
  const fixture = await createFixture();
  await fixture.service.prepareImport(request());
  await expect(fixture.service.discardPreparedImport(OPERATION_ID)).resolves.toBeUndefined();
  expect(
    (await readdir(path.dirname(fixture.libraryRoot))).filter((name) =>
      name.startsWith(".import-staging-"),
    ),
  ).toEqual([]);
  expect(
    (await readdir(path.dirname(fixture.userDataRoot))).filter((name) =>
      name.startsWith(".import-user-data-"),
    ),
  ).toEqual([]);
  await expect(
    fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
  ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
  await fixture.service.discardPreparedImport(SECOND_OPERATION_ID);
});

async function expectRecoveryDiscard(
  service: FullDataImportService,
  operationId: string,
): Promise<void> {
  await expect(service.discardPreparedImport(operationId)).rejects.toEqual(
    new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
  );
}

async function fingerprint(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else output.push(`${path.relative(root, child)}:${(await readFile(child)).toString("hex")}`);
    }
  }
  return output.sort();
}

describe("full data import space budget", () => {
  test("includes payload, current empty data, rollback, and the fixed margin", () => {
    expect(
      calculateFullDataImportSpaceBudget({
        totalOriginalBytes: 2n * 1024n * 1024n * 1024n,
        currentLibraryBytes: 10n,
        currentUserDataBytes: 20n,
      }).totalRequiredBytes,
    ).toBe(3n * 1024n * 1024n * 1024n + 60n);
  });

  test("fails closed for insufficient or unknown statfs results", async () => {
    const input = {
      libraryParent: "library-parent",
      userDataParent: "user-parent",
      totalOriginalBytes: 100n,
      currentLibraryBytes: 5n,
      currentUserDataBytes: 7n,
      libraryPayloadBytes: 60n,
      userDataPayloadBytes: 40n,
    };
    await expect(
      preflightFullDataImportSpace(input, {
        statfs: async () => ({ bavail: 1n, bsize: 1n }),
        statDevice: async () => 1n,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_SPACE" });
    await expect(
      preflightFullDataImportSpace(input, {
        statfs: async () => Promise.reject(new Error("sensitive path")),
      }),
    ).rejects.toEqual(new FullDataImportError("INSUFFICIENT_SPACE"));
  });
});

describe("FullDataImportService", () => {
  test("uses fixed order, returns metadata only, and retains a prepared task", async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.prepareImport(request());
    expect(fixture.events).toEqual([
      "inspect",
      "selection",
      "header",
      "unlock",
      "manifest",
      "space",
      "extract",
      "validate",
      "close",
    ]);
    expect(preview).toMatchObject({ packageId: PACKAGE_ID, packageVerified: true });
    expect(JSON.stringify(preview)).not.toMatch(/正文|correct horse/u);
    const prepared = fixture.service.getPreparedImport(OPERATION_ID);
    expect(prepared).toMatchObject({ packageId: PACKAGE_ID });
    expect(await readFile(prepared?.settingsCandidatePath ?? "", "utf8")).toContain(
      '"enabled":false',
    );
    await fixture.service.discardPreparedImport(OPERATION_ID);
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeUndefined();
  });

  test("records the settings candidate identity and rejects a replaced candidate on handoff", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const prepared = fixture.service.getPreparedImport(OPERATION_ID);
    if (!prepared) throw new Error("prepared import missing");
    expect(prepared.settingsCandidateIntegrity.sha256).toMatch(/^[0-9a-f]{64}$/u);
    await writeFile(prepared.settingsCandidatePath, "replaced candidate");
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeDefined();
  });

  test("records the recovered staging database hash and rejects replacement on handoff", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const prepared = fixture.service.getPreparedImport(OPERATION_ID);
    if (!prepared) throw new Error("prepared import missing");
    expect(prepared.stagingDatabaseIntegrity.sha256).toMatch(/^[0-9a-f]{64}$/u);
    await writeFile(path.join(prepared.stagingLibraryPath, "library.sqlite3"), "replaced database");

    await expect(fixture.service.takePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeDefined();
  });

  test("rejects a replaced settings candidate before releasing a prepared task", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const prepared = fixture.service.getPreparedImport(OPERATION_ID);
    if (!prepared) throw new Error("prepared import missing");
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).resolves.toBeDefined();
    await writeFile(prepared.settingsCandidatePath, "replaced candidate");
    await expect(fixture.service.releasePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeDefined();
  });

  test("releases a lease after the coordinator consumes its settings candidate", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const lease = await fixture.service.takePreparedImportLease(OPERATION_ID);
    if (!lease) throw new Error("prepared import lease missing");
    await rename(
      lease.prepared.settingsCandidatePath,
      path.join(fixture.userDataRoot, "settings.json"),
    );
    await lease.release("released", { settingsCandidateConsumed: true });
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeUndefined();
  });
  test("a pre-swap retryable lease can be cancelled and prepared again", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const lease = await fixture.service.takePreparedImportLease(OPERATION_ID);
    if (!lease) throw new Error("lease missing");
    await lease.release("retryable");
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeDefined();
    await fixture.service.discardPreparedImport(OPERATION_ID);
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
    await fixture.service.discardPreparedImport(SECOND_OPERATION_ID);
  });

  test("completes a real prepare-take-coordinator-release handoff", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const lease = await fixture.service.takePreparedImportLease(OPERATION_ID);
    if (!lease) throw new Error("prepared import lease missing");
    await mkdir(path.join(fixture.userDataRoot, "drafts"), { recursive: true });
    await writeFile(path.join(fixture.userDataRoot, "settings.json"), "current\n");
    const journal = new DataImportJournal({
      applicationDataRoot: fixture.applicationDataRoot,
      libraryRoot: fixture.libraryRoot,
      userDataRoot: fixture.userDataRoot,
      createReparsePointProbe: () => ({
        assertSafe: async () => undefined,
        close: async () => undefined,
      }),
    });
    const result = await new LibraryImportSwapCoordinator({
      applicationDataRoot: fixture.applicationDataRoot,
      libraryRoot: fixture.libraryRoot,
      userDataRoot: fixture.userDataRoot,
      prepared: lease.prepared,
      lease,
      journal,
      ensureCurrentState: async () => undefined,
      inspectEmptyLibrary: async () => ({ empty: true, blockers: [] }),
      validateStaging: async (prepared) => prepared.manifest.summary,
      closeRuntime: async () => undefined,
    }).commit();
    expect(result.phase).toBe("restart-validation-pending");
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeDefined();
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
    await result.releaseHandoff.release("released");
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeUndefined();
  });

  test("serializes concurrent take calls before candidate verification awaits", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const first = fixture.service.takePreparedImport(OPERATION_ID);
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("OPERATION_IN_PROGRESS"),
    );
    await expect(first).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(OPERATION_ID);
  });

  test("serializes concurrent release calls before candidate verification awaits", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    await fixture.service.takePreparedImport(OPERATION_ID);
    const first = fixture.service.releasePreparedImport(OPERATION_ID);
    await expect(fixture.service.releasePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("OPERATION_IN_PROGRESS"),
    );
    await expect(first).resolves.toBeUndefined();
  });

  test("rejects a same-size portable-settings replacement by identity and manifest hash", async () => {
    const fixture = await createFixture();
    const createReader = fixture.readerFactory.getMockImplementation();
    if (!createReader) throw new Error("reader factory missing");
    fixture.readerFactory.mockImplementation(async (...args) => {
      const reader = await createReader(...args);
      const extract = reader.extractTo as unknown as (
        roots: { libraryRoot: string; userDataRoot: string },
        signal?: AbortSignal,
      ) => Promise<PackageExtractionResult>;
      return {
        ...reader,
        extractTo: async (
          roots: { libraryRoot: string; userDataRoot: string },
          signal?: AbortSignal,
        ) => {
          const result = await extract(roots, signal);
          const settingsPath = path.join(
            result.stagingPaths?.userData ?? result.stagingPath,
            "portable-settings.json",
          );
          const bytes = await readFile(settingsPath);
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
          await writeFile(settingsPath, bytes);
          return result;
        },
      } as never;
    });
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("PACKAGE_TAMPERED"),
    );
    expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeUndefined();
  });

  test("does not swallow reader close failures after staging succeeds", async () => {
    const fixture = await createFixture();
    const createReader = fixture.readerFactory.getMockImplementation();
    if (!createReader) throw new Error("reader factory missing");
    fixture.readerFactory.mockImplementation(async (...args) => {
      const reader = await createReader(...args);
      return { ...reader, close: async () => Promise.reject(new Error("close failed")) } as never;
    });
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    await fixture.service.discardPreparedImport(OPERATION_ID);
  });

  test("rejects non-empty library before resolving or reading package", async () => {
    const readerFactory = vi.fn();
    const resolveSourceSelection = vi.fn();
    const fixture = await createFixture({
      inspector: {
        inspect: async () => ({ empty: false, blockers: [{ kind: "patents", count: 1 }] }),
      },
      resolveSourceSelection,
      readerFactory,
    });
    await expect(fixture.service.prepareImport(request())).rejects.toMatchObject({
      code: "LIBRARY_NOT_EMPTY",
    });
    expect(resolveSourceSelection).not.toHaveBeenCalled();
    expect(readerFactory).not.toHaveBeenCalled();
  });

  test.each(["space", "validate"] as const)(
    "keeps formal library byte-for-byte unchanged and removes roots after %s failure",
    async (phase) => {
      const fixture = await createFixture(
        phase === "space"
          ? {
              preflightSpace: async () =>
                Promise.reject(new FullDataImportError("INSUFFICIENT_SPACE")),
            }
          : {
              validator: { validate: async () => Promise.reject(new Error("secret patent name")) },
            },
      );
      const before = await fingerprint(fixture.libraryRoot);
      const failure = fixture.service.prepareImport(request());
      await expect(failure).rejects.toBeInstanceOf(FullDataImportError);
      await expect(failure).rejects.not.toThrow("secret patent name");
      expect(await fingerprint(fixture.libraryRoot)).toEqual(before);
      expect(
        (await readdir(path.dirname(fixture.libraryRoot))).filter(
          (name) => name.startsWith(".import-staging-") && !name.includes(".cleanup-"),
        ),
      ).toEqual([]);
      expect(
        (await readdir(path.dirname(fixture.userDataRoot))).filter(
          (name) => name.startsWith(".import-user-data-") && !name.includes(".cleanup-"),
        ),
      ).toEqual([]);
    },
  );

  test("delays attempts 4-6 by two seconds and later attempts by five seconds", async () => {
    const fixture = await createFixture({
      readerFactory: async () =>
        ({
          readPublicHeader: async () =>
            ({ packageId: PACKAGE_ID, saltHex: SALT.toString("hex") }) as never,
          unlock: async () => {
            throw new PackageReaderError("PASSWORD_OR_PACKAGE_INVALID");
          },
          scanManifest: async () => manifest(),
          extractTo: async () => {
            throw new Error("not reached");
          },
          close: async () => {},
        }) as never,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(fixture.service.prepareImport(request())).rejects.toMatchObject({
        code: "PASSWORD_OR_PACKAGE_INVALID",
      });
    }
    expect(fixture.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      2_000, 2_000, 2_000, 5_000, 5_000,
    ]);
  });

  test("resets password-failure delays after a successful unlock", async () => {
    const fixture = await createFixture();
    const createReader = fixture.readerFactory.getMockImplementation();
    if (!createReader) throw new Error("reader factory missing");
    let attempt = 0;
    fixture.readerFactory.mockImplementation(async (...args) => {
      const reader = await createReader(...args);
      attempt += 1;
      if (attempt <= 3 || attempt === 5) {
        return {
          ...reader,
          unlock: vi.fn(async (): Promise<void> => {
            throw new PackageReaderError("PASSWORD_OR_PACKAGE_INVALID");
          }),
        };
      }
      return reader;
    });

    for (let failed = 0; failed < 3; failed += 1) {
      await expect(fixture.service.prepareImport(request())).rejects.toMatchObject({
        code: "PASSWORD_OR_PACKAGE_INVALID",
      });
    }
    await fixture.service.prepareImport(request());
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(OPERATION_ID);
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toMatchObject({ code: "PASSWORD_OR_PACKAGE_INVALID" });
    expect(fixture.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000]);
  });

  test("keeps one global prepared import until cancel or commit releases it", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());

    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
    expect(fixture.readerFactory).toHaveBeenCalledTimes(1);

    await expect(fixture.service.takePreparedImport(OPERATION_ID)).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(OPERATION_ID);
    await fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID });
    await expect(fixture.service.takePreparedImport(SECOND_OPERATION_ID)).resolves.toBeDefined();
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: THIRD_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
    await fixture.service.releasePreparedImport(SECOND_OPERATION_ID);
    await fixture.service.prepareImport({ ...request(), operationId: THIRD_OPERATION_ID });
    await expect(fixture.service.takePreparedImport(THIRD_OPERATION_ID)).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(THIRD_OPERATION_ID);
    expect(fixture.readerFactory).toHaveBeenCalledTimes(3);
  });

  test("does not let take race with an in-progress discard", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const discarding = fixture.service.discardPreparedImport(OPERATION_ID);
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).rejects.toEqual(
      new FullDataImportError("OPERATION_IN_PROGRESS"),
    );
    await expect(discarding).resolves.toBeUndefined();
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
  });

  test("holds a recovery lock when commit handoff requires recovery", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(OPERATION_ID, "recovery-required");
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
    await expectRecoveryDiscard(fixture.service, OPERATION_ID);
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
  });

  test("never downgrades journal-owned staging to cancellable when its candidate becomes unreadable", async () => {
    const fixture = await createFixture();
    await fixture.service.prepareImport(request());
    const lease = await fixture.service.takePreparedImportLease(OPERATION_ID);
    if (!lease) throw new Error("prepared import lease missing");
    await mkdir(path.join(fixture.userDataRoot, "drafts"), { recursive: true });
    await writeFile(path.join(fixture.userDataRoot, "settings.json"), "current\n");
    const journal = new DataImportJournal({
      applicationDataRoot: fixture.applicationDataRoot,
      libraryRoot: fixture.libraryRoot,
      userDataRoot: fixture.userDataRoot,
      createReparsePointProbe: () => ({
        assertSafe: async () => undefined,
        close: async () => undefined,
      }),
    });
    await expect(
      new LibraryImportSwapCoordinator({
        applicationDataRoot: fixture.applicationDataRoot,
        libraryRoot: fixture.libraryRoot,
        userDataRoot: fixture.userDataRoot,
        prepared: lease.prepared,
        lease,
        journal: {
          create: async (record) => {
            const durable = await journal.create(record);
            await rename(
              lease.prepared.settingsCandidatePath,
              `${lease.prepared.settingsCandidatePath}.unavailable`,
            );
            return durable;
          },
          advance: async (phase) => await journal.advance(phase),
        },
        ensureCurrentState: async () => undefined,
        inspectEmptyLibrary: async () => ({ empty: true, blockers: [] }),
        validateStaging: async (prepared) => prepared.manifest.summary,
        closeRuntime: async () => undefined,
      }).commit({ failurePoint: "after-journal" }),
    ).rejects.toMatchObject({ restartRequired: true });
    const journalPath = path.join(fixture.applicationDataRoot, "pending-data-import.json");
    const durableBytes = await readFile(journalPath);
    await expectRecoveryDiscard(fixture.service, OPERATION_ID);
    await expect(fixture.service.retirePreparedImport(OPERATION_ID)).rejects.toMatchObject({
      code: "IMPORT_RECOVERY_REQUIRED",
    });
    await expect(lstat(lease.prepared.libraryStagingCapability.root)).resolves.toBeDefined();
    await expect(lstat(lease.prepared.userDataStagingCapability.root)).resolves.toBeDefined();
    expect(await readFile(journalPath)).toEqual(durableBytes);
  });

  test("keeps cleanup-failed locked and never deletes a replacement directory", async () => {
    let originalStagingRoot = "";
    let movedStagingRoot = "";
    let preflights = 0;
    const fixture = await createFixture({
      preflightSpace: async (input) => {
        preflights += 1;
        if (preflights > 1) return calculateFullDataImportSpaceBudget(input);
        originalStagingRoot = path.join(input.libraryParent, `.import-staging-${OPERATION_ID}`);
        movedStagingRoot = `${originalStagingRoot}.moved`;
        await rename(originalStagingRoot, movedStagingRoot);
        await mkdir(originalStagingRoot);
        await writeFile(path.join(originalStagingRoot, "replacement-marker"), "keep");
        throw new FullDataImportError("INSUFFICIENT_SPACE");
      },
    });

    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(await readFile(path.join(originalStagingRoot, "replacement-marker"), "utf8")).toBe(
      "keep",
    );
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).rejects.toEqual(new FullDataImportError("OPERATION_IN_PROGRESS"));
    expect(fixture.readerFactory).toHaveBeenCalledTimes(1);

    await rm(originalStagingRoot, { recursive: true });
    await rename(movedStagingRoot, originalStagingRoot);
    await fixture.service.discardPreparedImport(OPERATION_ID);
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
  });

  test("allows retry only after a failed preparation has cleaned its staging", async () => {
    let attempts = 0;
    const fixture = await createFixture({
      preflightSpace: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new FullDataImportError("INSUFFICIENT_SPACE");
        return calculateFullDataImportSpaceBudget(input);
      },
    });
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("INSUFFICIENT_SPACE"),
    );
    await expect(
      fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
    ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
  });

  test("fails closed when a library child changes during staged validation", async () => {
    const sentinel = await createRoot();
    await writeFile(path.join(sentinel, "sentinel.txt"), "outside");
    const fixture = await createFixture({
      validator: {
        validate: async (layout) => {
          const child = (layout as unknown as { libraryDirectoryCapability?: { root?: string } })
            .libraryDirectoryCapability?.root;
          if (!child) throw new Error("library child capability missing");
          await rm(child, { recursive: true });
          await symlink(sentinel, child, process.platform === "win32" ? "junction" : "dir");
          return summary();
        },
      },
    });
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(await readFile(path.join(sentinel, "sentinel.txt"), "utf8")).toBe("outside");
  });

  test("rejects an owned user-data replacement before writing settings", async () => {
    const sentinel = await createRoot();
    await writeFile(path.join(sentinel, "sentinel.txt"), "outside");
    let userDataRoot = "";
    const originalReadSettings = async () => {
      const stagingRoot = path.join(
        path.dirname(userDataRoot),
        `${".import-user-data-"}${OPERATION_ID}`,
      );
      await rename(stagingRoot, `${stagingRoot}.moved`);
      await symlink(sentinel, stagingRoot, process.platform === "win32" ? "junction" : "dir");
      return DEFAULT_APP_SETTINGS;
    };
    const fixture = await createFixture({ readCurrentSettings: originalReadSettings });
    userDataRoot = fixture.userDataRoot;
    const replacementPath = path.join(
      path.dirname(userDataRoot),
      `${".import-user-data-"}${OPERATION_ID}`,
    );
    const movedPath = `${replacementPath}.moved`;
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("IMPORT_RECOVERY_REQUIRED"),
    );
    expect(await readFile(path.join(sentinel, "sentinel.txt"), "utf8")).toBe("outside");
    await rm(replacementPath, { recursive: true });
    await rename(movedPath, replacementPath);
    await fixture.service.discardPreparedImport(OPERATION_ID);
  });

  test("rejects concurrent and cancelled preparation", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture({
      inspector: {
        inspect: async () => {
          await waiting;
          return { empty: true, blockers: [] };
        },
      },
    });
    const first = fixture.service.prepareImport(request());
    await expect(fixture.service.prepareImport(request())).rejects.toEqual(
      new FullDataImportError("OPERATION_IN_PROGRESS"),
    );
    release?.();
    await first;
    await expect(fixture.service.takePreparedImport(OPERATION_ID)).resolves.toBeDefined();
    await fixture.service.releasePreparedImport(OPERATION_ID);
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.service.prepareImport(request(controller.signal))).rejects.toEqual(
      new FullDataImportError("CANCELLED"),
    );
  });
});

test("CLI retirement deletes verified staging and permits a new import", async () => {
  const fixture = await createFixture();
  await fixture.service.prepareImport(request());
  const retained = await fixture.service.retirePreparedImport(OPERATION_ID);
  expect(retained).toEqual([]);
  expect(
    (await readdir(fixture.applicationDataRoot)).filter(
      (name) => name.startsWith(".import-") || name.startsWith(".discarded-"),
    ),
  ).toEqual([]);
  expect(fixture.service.getPreparedImport(OPERATION_ID)).toBeUndefined();
  await expect(
    fixture.service.prepareImport({ ...request(), operationId: SECOND_OPERATION_ID }),
  ).resolves.toMatchObject({ operationId: SECOND_OPERATION_ID });
});
