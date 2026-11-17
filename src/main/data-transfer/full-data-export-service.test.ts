import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { FileService } from "../documents/file-service.js";
import { DraftService } from "../drafts/draft-service.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import * as harmonyPublicFiles from "../platform/harmony-public-files.js";
import { DataTransferOperationError } from "./data-transfer-operation-gate.js";
import { ExportSourceSnapshotError } from "./export-source-snapshot.js";
import {
  assertFullDataExportRequest,
  calculateFullDataExportSpaceBudget,
  createFullDataExportProgressReporter,
  FullDataExportError,
  FullDataExportService,
  type FullDataExportSpacePreflightInput,
  preflightFullDataExportSpace,
  publishCompletedPackage,
  publishCopiedPackage,
  validateFullDataExportDestinationDirectory,
} from "./full-data-export-service.js";
import { PackageReader, PackageReaderError } from "./package-reader.js";
import { PackageWriterError } from "./package-writer.js";

const roots: string[] = [];

async function testFileIdentity(filePath: string) {
  const value = await stat(filePath, { bigint: true });
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    birthtimeNs: value.birthtimeNs,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full data export space preflight", () => {
  test("includes the sandbox package in the public-storage copy budget", () => {
    const gib = 1024n ** 3n;
    const budget = calculateFullDataExportSpaceBudget({
      databaseBytes: 1n,
      estimatedPackageBytes: gib,
      stagedPackageBytes: gib,
    });
    expect(budget.sourceRequiredBytes).toBeGreaterThan(3n * gib);
  });
  test("budgets both complete frozen data and verification extraction for an asset-heavy library", () => {
    const gib = 1024n ** 3n;
    const budget = calculateFullDataExportSpaceBudget({
      databaseBytes: 2n * 1024n ** 2n,
      estimatedPackageBytes: 2n * gib,
    });
    expect(budget.sourceRequiredBytes).toBeGreaterThanOrEqual(4n * gib);
  });
  test("uses bigint budgets without number overflow", async () => {
    const gib = 1024n * 1024n * 1024n;
    const budget = calculateFullDataExportSpaceBudget({
      databaseBytes: 9_007_199_254_740_993n,
      estimatedPackageBytes: 5n * gib,
      manifestAndTempBytes: 64n * 1024n * 1024n,
    });
    expect(budget.sourceRequiredBytes).toBe(19_815_838_427_539_049n);
    expect(budget.targetRequiredBytes).toBe(5_905_580_032n);
    expect(budget.warnings).toContain("FAT32_OVER_4_GIB");
  });

  test("requires the sum of source and target peaks on a shared volume", async () => {
    const mib = 1024n * 1024n;
    const input = {
      sourcePath: "S:\\Library",
      targetDirectory: "S:\\Exports",
      databaseBytes: 512n * mib,
      estimatedPackageBytes: 512n * mib,
      manifestAndTempBytes: 0n,
    };
    const dependencies = (available: bigint) => ({
      statfs: vi.fn(async () => ({ bavail: available, bsize: 1n })),
      statDevice: vi.fn(async () => 7n),
    });

    await expect(
      preflightFullDataExportSpace(input, dependencies(1_600n * mib)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_SPACE" });
    await expect(
      preflightFullDataExportSpace(input, dependencies(2_560n * mib)),
    ).resolves.toMatchObject({ sameVolume: true });

    const huge = 1n << 200n;
    const hugeBudget = calculateFullDataExportSpaceBudget({
      databaseBytes: huge,
      estimatedPackageBytes: huge,
      manifestAndTempBytes: 0n,
    });
    const exactHugeBoundary = hugeBudget.sourceRequiredBytes + hugeBudget.targetRequiredBytes;
    await expect(
      preflightFullDataExportSpace(
        {
          ...input,
          databaseBytes: huge,
          estimatedPackageBytes: huge,
        },
        dependencies(exactHugeBoundary),
      ),
    ).resolves.toMatchObject({ sameVolume: true });
  });

  test.each([
    ["source", 10n, 1_000_000_000n],
    ["target", 1_000_000_000n, 10n],
  ] as const)("rejects insufficient %s space", async (scope, sourceAvailable, targetAvailable) => {
    await expect(
      preflightFullDataExportSpace(
        {
          sourcePath: "S:\\Library",
          targetDirectory: "T:\\Exports",
          databaseBytes: 100n,
          estimatedPackageBytes: 100n,
          manifestAndTempBytes: 0n,
        },
        {
          statfs: vi.fn(async (path: string) => ({
            bavail: path.startsWith("S:") ? sourceAvailable : targetAvailable,
            bsize: 1n,
          })),
          statDevice: vi.fn(async (path: string) => (path.startsWith("S:") ? 1n : 2n)),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FullDataExportError>>({
        code: "INSUFFICIENT_SPACE",
        scope,
      }),
    );
  });
});

describe("verified public package copy", () => {
  test.each([false, true])(
    "never overwrites a raced destination (existing: %s)",
    async (existing) => {
      const root = await temporaryRoot();
      const source = join(root, "source.partial");
      const target = join(root, "target.zxwbackup");
      await writeFile(source, "complete verified synthetic package");
      const identity = await testFileIdentity(source);
      const unsupportedLink = async () => {
        if (existing) await writeFile(target, "sentinel");
        throw Object.assign(new Error("no public hard links"), { code: "ENOTSUP" });
      };
      const result = publishCopiedPackage(source, target, identity, unsupportedLink);
      if (existing) {
        await expect(result).rejects.toMatchObject({ code: "EEXIST" });
        expect(await readFile(target, "utf8")).toBe("sentinel");
      } else {
        await expect(result).resolves.toMatchObject({ size: identity.size });
        expect(await readFile(target)).toEqual(await readFile(source));
      }
    },
  );
  test("rejects a source changed after package verification", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.partial");
    const target = join(root, "target.zxwbackup");
    await writeFile(source, "verified");
    const identity = await testFileIdentity(source);
    await writeFile(source, "changed source");
    await expect(publishCopiedPackage(source, target, identity)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("full data export destination boundary", () => {
  test("rejects an intermediate symbolic link or junction before following it", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const outside = join(root, "outside");
    const linkPath = join(root, "redirect");
    await Promise.all([mkdir(libraryRoot), mkdir(outside)]);
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");

    await expect(
      validateFullDataExportDestinationDirectory(join(linkPath, "nested"), libraryRoot),
    ).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });
  });

  test("rejects generic Windows reparse points and accepts canonical case-only differences", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const destination = join(root, "Destination");
    await Promise.all([mkdir(libraryRoot), mkdir(destination)]);
    const canonicalLibrary = await realpath(libraryRoot);
    const canonicalDestination = await realpath(destination);

    await expect(
      validateFullDataExportDestinationDirectory(destination, libraryRoot, {
        platform: "win32",
        probeWindowsFileAttributes: async (paths) =>
          paths.map((candidate) => (candidate === destination ? 0x400 : 0x10)),
      }),
    ).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });

    await expect(
      validateFullDataExportDestinationDirectory(destination, libraryRoot, {
        platform: "win32",
        realpath: async (candidate) =>
          candidate === libraryRoot
            ? canonicalLibrary.toUpperCase()
            : canonicalDestination.toUpperCase(),
        probeWindowsFileAttributes: async (paths) => paths.map(() => 0x10),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("verified package publication", () => {
  test.each(["hardlink", "fallback"] as const)(
    "preserves the verified file identity through %s publication",
    async (mode) => {
      const root = await temporaryRoot();
      const partialPath = join(root, `.verified-${mode}.zxwbackup.partial`);
      const finalPath = join(root, `${mode}.zxwbackup`);
      await writeFile(partialPath, "verified-package");
      const before = await stat(partialPath, { bigint: true });
      await publishCompletedPackage(partialPath, finalPath, {
        ...(mode === "fallback"
          ? {
              platform: "win32" as const,
              link: async () => {
                throw Object.assign(new Error("unsupported"), { code: "EXDEV" });
              },
              moveNoReplace: async (sourcePath, targetPath) => {
                await rename(sourcePath, targetPath);
              },
            }
          : {}),
        syncDirectory: vi.fn(async () => undefined),
      });
      const after = await stat(finalPath, { bigint: true });
      expect({ dev: after.dev, ino: after.ino, birthtimeNs: after.birthtimeNs }).toEqual({
        dev: before.dev,
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
      });
    },
  );
  test("rejects a partial outside the final file directory", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const partialPath = join(first, ".transfer.task.zxwbackup.partial");
    const finalPath = join(second, "transfer.zxwbackup");
    await writeFile(partialPath, "verified-package");
    await expect(publishCompletedPackage(partialPath, finalPath)).rejects.toBeInstanceOf(TypeError);
    expect(await readFile(partialPath, "utf8")).toBe("verified-package");
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("links create-if-absent, preserves a concurrent target, and never creates an empty final", async () => {
    const root = await temporaryRoot();
    const partialPath = join(root, ".transfer.task.zxwbackup.partial");
    const finalPath = join(root, "transfer.zxwbackup");
    await writeFile(partialPath, "verified-package");

    const published = await publishCompletedPackage(partialPath, finalPath, {
      syncDirectory: vi.fn(async () => undefined),
    });
    expect(await readFile(finalPath, "utf8")).toBe("verified-package");
    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(published.warnings).toEqual([]);

    const secondPartial = join(root, ".second.task.zxwbackup.partial");
    await writeFile(secondPartial, "new-package");
    await expect(
      publishCompletedPackage(secondPartial, finalPath, {
        syncDirectory: vi.fn(async () => undefined),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
    expect(await readFile(finalPath, "utf8")).toBe("verified-package");
    expect(await readFile(secondPartial, "utf8")).toBe("new-package");
  });

  test.each(["win32", "darwin", "openharmony", "ohos"])(
    "uses %s no-replace fallback for unsupported hard links",
    async (platform) => {
      const root = await temporaryRoot();
      const partialPath = join(root, ".transfer.task.zxwbackup.partial");
      const finalPath = join(root, "transfer.zxwbackup");
      await writeFile(partialPath, "verified-package");
      const moveNoReplace = vi.fn(async (source: string, target: string) => {
        await link(source, target);
        await unlink(source);
      });

      await expect(
        publishCompletedPackage(partialPath, finalPath, {
          platform: platform as NodeJS.Platform,
          link: vi.fn(async () => {
            throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
          }),
          moveNoReplace,
          syncDirectory: vi.fn(async () => undefined),
        }),
      ).resolves.toMatchObject({ warnings: [] });
      expect(moveNoReplace).toHaveBeenCalledOnce();
      expect(await readFile(finalPath, "utf8")).toBe("verified-package");
    },
  );

  test.each(["EFBIG", "ENOSPC"])(
    "maps %s publication failures to insufficient space",
    async (code) => {
      const root = await temporaryRoot();
      const partialPath = join(root, ".transfer.task.zxwbackup.partial");
      const finalPath = join(root, "transfer.zxwbackup");
      await writeFile(partialPath, "verified-package");
      await expect(
        publishCompletedPackage(partialPath, finalPath, {
          link: vi.fn(async () => {
            throw Object.assign(new Error(code), { code });
          }),
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_SPACE" });
      await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test.runIf(process.platform === "darwin")(
    "publishes with the real Mac no-replace mover when hard links are unavailable",
    async () => {
      const root = await temporaryRoot();
      const partialPath = join(root, "native.zxwbackup.partial");
      const finalPath = join(root, "native.zxwbackup");
      await writeFile(partialPath, "verified-package");
      await publishCompletedPackage(partialPath, finalPath, {
        platform: "darwin",
        link: async () => {
          throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
        },
      });
      expect(await readFile(finalPath, "utf8")).toBe("verified-package");
      await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(partialPath, "new-package");
      await expect(
        publishCompletedPackage(partialPath, finalPath, {
          platform: "darwin",
          link: async () => {
            throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
          },
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
      expect(await readFile(finalPath, "utf8")).toBe("verified-package");
      expect(await readFile(partialPath, "utf8")).toBe("new-package");
    },
  );

  test("fails closed when hard links and an atomic mover are both unsupported", async () => {
    const root = await temporaryRoot();
    const partialPath = join(root, "unsupported.zxwbackup.partial");
    const finalPath = join(root, "unsupported.zxwbackup");
    await writeFile(partialPath, "verified-package");
    await expect(
      publishCompletedPackage(partialPath, finalPath, {
        platform: "linux",
        link: async () => {
          throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
        },
      }),
    ).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });
    expect(await readFile(partialPath, "utf8")).toBe("verified-package");
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["win32", "darwin", "openharmony", "ohos"])(
    "maps a %s fallback race to unsafe overwrite without changing the winner",
    async (platform) => {
      const root = await temporaryRoot();
      const partialPath = join(root, ".transfer.task.zxwbackup.partial");
      const finalPath = join(root, "transfer.zxwbackup");
      await writeFile(partialPath, "verified-package");
      await expect(
        publishCompletedPackage(partialPath, finalPath, {
          platform: platform as NodeJS.Platform,
          link: vi.fn(async () => {
            throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
          }),
          moveNoReplace: vi.fn(async () => {
            await writeFile(finalPath, "concurrent-winner", { flag: "wx" });
            throw Object.assign(new Error("exists"), { code: "EEXIST" });
          }),
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
      expect(await readFile(finalPath, "utf8")).toBe("concurrent-winner");
      expect(await readFile(partialPath, "utf8")).toBe("verified-package");
    },
  );

  test("keeps the published final and reports safe warnings when post-link cleanup cannot finish", async () => {
    const root = await temporaryRoot();
    const partialPath = join(root, ".transfer.task.zxwbackup.partial");
    const finalPath = join(root, "transfer.zxwbackup");
    await writeFile(partialPath, "verified-package");
    const result = await publishCompletedPackage(partialPath, finalPath, {
      unlink: vi.fn(async () => {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }),
      syncDirectory: vi.fn(async () => {
        throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
      }),
    });
    expect(result.warnings).toEqual(["PARTIAL_CLEANUP_FAILED", "DIRECTORY_SYNC_UNAVAILABLE"]);
    expect(await readFile(finalPath, "utf8")).toBe("verified-package");
    expect(await readFile(partialPath, "utf8")).toBe("verified-package");
  });
});

describe("full data export progress", () => {
  test("emits phase changes immediately, throttles bytes to 100ms, and derives ETA from ten seconds", () => {
    let now = 0;
    const events: Array<Record<string, unknown>> = [];
    const report = createFullDataExportProgressReporter({
      operationId: "00000000-0000-4000-8000-000000000014",
      now: () => now,
      onProgress: (event) => events.push(event),
    });

    report("inspecting", 0, 1_000, "database");
    now = 10;
    report("inspecting", 100, 1_000, "database");
    now = 20;
    report("checkpointing", 100, 1_000, "database");
    now = 120;
    report("checkpointing", 200, 1_000, "database");

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ percent: 0, etaMs: null });
    expect(events[1]).toMatchObject({ phase: "checkpointing", processedBytes: 100 });
    expect(events[2]).toMatchObject({ percent: 20, etaMs: 480 });
    expect(JSON.stringify(events)).not.toMatch(/password|path|name/iu);
  });

  test("fails closed when the progress callback throws", () => {
    const report = createFullDataExportProgressReporter({
      operationId: "00000000-0000-4000-8000-000000000014",
      now: () => 0,
      onProgress: () => {
        throw new Error("renderer disconnected");
      },
    });
    expect(() => report("inspecting", 0, null, "database")).toThrowError(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });
});

describe("full data export orchestration", () => {
  test.each(["hardlink", "darwin", "openharmony", "ohos"])(
    "runs the authority pipeline and verifies both %s publication stages",
    async (mode) => {
      const root = await temporaryRoot();
      const libraryRoot = join(root, "Library");
      const userDataRoot = join(root, "user-data");
      const workRoot = join(root, "work");
      const destination = join(root, "destination");
      await Promise.all(
        [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
      );
      const events: string[] = [];
      let writtenManifest: Record<string, unknown> | undefined;
      const service = new FullDataExportService({
        applicationVersion: "0.1.0",
        database: {} as never,
        libraryRoot,
        userDataRoot,
        workRoot,
        draftService: {} as never,
        fileService: {} as never,
        gate: {
          runExclusive: async (_kind, task, signal) => {
            events.push("gate");
            return await task(signal);
          },
        },
        quiescence: {
          acquire: async () => {
            events.push("acquire");
            return {
              release: async () => {
                events.push("release");
              },
            };
          },
        },
        snapshotter: {
          create: async ({ workRoot: operationRoot }) => {
            events.push("snapshot");
            const taskDirectory = join(operationRoot, "00000000-0000-4000-8000-000000000013");
            const sourcePath = join(taskDirectory, "library", "library.sqlite3");
            await mkdir(join(taskDirectory, "library"), { recursive: true });
            await writeFile(sourcePath, "frozen-database");
            return {
              taskDirectory,
              cutoffAt: "2026-08-16T00:00:00.000Z",
              database: {
                logicalPath: "library/library.sqlite3",
                kind: "database" as const,
                size: 15,
                hash: "0".repeat(64),
                sourcePath,
              },
              assetCount: 0,
              draftCount: 0,
              totalBytes: 15,
              entries: [
                {
                  logicalPath: "library/library.sqlite3",
                  kind: "database" as const,
                  size: 15,
                  hash: "0".repeat(64),
                  sourcePath,
                },
              ],
            };
          },
        },
        settingsService: {
          read: async () => {
            events.push("settings");
            return structuredClone(DEFAULT_APP_SETTINGS);
          },
        },
        estimateSpace: async () => ({ databaseBytes: 15n, estimatedPackageBytes: 1_024n }),
        preflightSpace: async () => {
          events.push("preflight");
          return {
            sourceRequiredBytes: 1n,
            targetRequiredBytes: 1n,
            sourceAvailableBytes: 2n,
            targetAvailableBytes: 2n,
            sameVolume: false,
            warnings: [],
          };
        },
        summarizeSnapshot: async () => ({
          activePatents: 0,
          trashedPatents: 0,
          documents: 0,
          legacyDrafts: 0,
          snapshots: 0,
          assets: 0,
          flowchartProjects: 0,

          totalBytes: 15,
        }),
        schemaFingerprint: async () => "schema-fingerprint",
        writerFactory: {
          create: async ({ partialPath }) => {
            events.push("writer.create");
            await writeFile(partialPath, "verified-package", { flag: "wx" });
            const createdPartialIdentity = await testFileIdentity(partialPath);
            const entries: unknown[] = [];
            return {
              createdPartialIdentity,
              addEntry: async () => {
                events.push("writer.add");
                const entry = { ordinal: entries.length };
                entries.push(entry);
                return entry as never;
              },
              addWrappedLibraryKey: async () => {
                events.push("writer.wrap");
                const entry = { ordinal: entries.length };
                entries.push(entry);
                return entry as never;
              },
              finish: async (metadata) => {
                events.push("writer.finish");
                writtenManifest = { ...metadata, entries };
                return writtenManifest as never;
              },
              close: async () => {
                events.push("writer.close");
              },
            };
          },
        },
        readerFactory: {
          open: async () => {
            events.push("reader.open");
            return {
              readPublicHeader: async () => ({
                packageId: "00000000-0000-4000-8000-000000000015",
              }),
              unlock: async () => {
                events.push("reader.unlock");
              },
              extractTo: async (stagingRoot) => {
                events.push("reader.extract");
                const stagingPath = join(stagingRoot, ".package-extract-test");
                await mkdir(stagingPath);
                return { manifest: writtenManifest as never, stagingPath };
              },
              close: async () => {
                events.push("reader.close");
              },
            };
          },
        },
        verifyExtractedPackage: async () => {
          events.push("verify");
        },
        publishDependencies: {
          ...(mode !== "hardlink" ? { platform: mode as NodeJS.Platform } : {}),
          link: async (partialPath, finalPath) => {
            events.push(finalPath.endsWith(".partial") ? "anchor" : "publish");
            if (mode !== "hardlink")
              throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" });
            await link(partialPath, finalPath);
          },
          moveNoReplace: async (source, target) => {
            await link(source, target);
            await unlink(source);
          },
          syncDirectory: vi.fn(async () => undefined),
        },
      });
      const finalPath = join(destination, "transfer.zxwbackup");
      const result = await service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      });

      expect(result).toMatchObject({ finalPath, fullVerificationPassed: true });
      expect(await readFile(finalPath, "utf8")).toBe("verified-package");
      expect(events).toEqual([
        "preflight",
        "gate",
        "acquire",
        "snapshot",
        "settings",
        "writer.create",
        "writer.add",
        "writer.add",
        "writer.add",
        "writer.finish",
        "reader.open",
        "reader.unlock",
        "reader.extract",
        "verify",
        "reader.close",
        "anchor",
        "publish",
        "writer.close",
        "release",
      ]);
    },
  );

  test.each([false, true])(
    "creates a missing work root and exports safely (Harmony public copy: %s)",
    async (publicCopy) => {
      vi.spyOn(harmonyPublicFiles, "usesHarmonyPublicFileCopy").mockReturnValue(publicCopy);
      const root = await temporaryRoot();
      const libraryRoot = join(root, "Library");
      const userDataRoot = join(root, "user-data");
      const workRoot = join(root, "missing-application-data");
      const destination = join(root, "destination");
      await Promise.all(
        [libraryRoot, userDataRoot, destination].map((directory) => mkdir(directory)),
      );
      await expect(lstat(workRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const events: string[] = [];
      let writtenManifest: Record<string, unknown> | undefined;
      const preflightSpace = vi.fn(async (input: FullDataExportSpacePreflightInput) => {
        events.push("preflight");
        expect(input.sourcePath).toBe(workRoot);
        if (publicCopy) expect(input.stagedPackageBytes).toBe(1_024n);
        const info = await lstat(input.sourcePath);
        expect(info.isDirectory()).toBe(true);
        expect(info.isSymbolicLink()).toBe(false);
        return {
          sourceRequiredBytes: 1n,
          targetRequiredBytes: 1n,
          sourceAvailableBytes: 2n,
          targetAvailableBytes: 2n,
          sameVolume: false,
          warnings: [],
        };
      });
      const service = new FullDataExportService({
        applicationVersion: "0.1.0",
        database: {} as never,
        libraryRoot,
        userDataRoot,
        workRoot,
        draftService: {} as never,
        fileService: {} as never,
        gate: {
          runExclusive: async (_kind, task, signal) => {
            events.push("gate");
            return await task(signal);
          },
        },
        quiescence: {
          acquire: async () => {
            events.push("acquire");
            return {
              release: async () => {
                events.push("release");
              },
            };
          },
        },
        snapshotter: {
          create: async ({ workRoot: operationRoot }) => {
            events.push("snapshot");
            const taskDirectory = join(operationRoot, "00000000-0000-4000-8000-000000000013");
            const sourcePath = join(taskDirectory, "library", "library.sqlite3");
            await mkdir(join(taskDirectory, "library"), { recursive: true });
            await writeFile(sourcePath, "frozen-database");
            return {
              taskDirectory,
              cutoffAt: "2026-08-16T00:00:00.000Z",
              database: {
                logicalPath: "library/library.sqlite3",
                kind: "database" as const,
                size: 15,
                hash: "0".repeat(64),
                sourcePath,
              },
              assetCount: 0,
              draftCount: 0,
              totalBytes: 15,
              entries: [
                {
                  logicalPath: "library/library.sqlite3",
                  kind: "database" as const,
                  size: 15,
                  hash: "0".repeat(64),
                  sourcePath,
                },
              ],
            };
          },
        },
        settingsService: {
          read: async () => {
            events.push("settings");
            return structuredClone(DEFAULT_APP_SETTINGS);
          },
        },
        estimateSpace: async () => ({ databaseBytes: 15n, estimatedPackageBytes: 1_024n }),
        preflightSpace,
        summarizeSnapshot: async () => ({
          activePatents: 0,
          trashedPatents: 0,
          documents: 0,
          legacyDrafts: 0,
          snapshots: 0,
          assets: 0,
          flowchartProjects: 0,

          totalBytes: 15,
        }),
        schemaFingerprint: async () => "schema-fingerprint",
        writerFactory: {
          create: async ({ partialPath }) => {
            events.push("writer.create");
            if (publicCopy) expect(partialPath.startsWith(`${workRoot}${sep}`)).toBe(true);
            await writeFile(partialPath, "verified-package", { flag: "wx" });
            const createdPartialIdentity = await testFileIdentity(partialPath);
            const entries: unknown[] = [];
            return {
              createdPartialIdentity,
              addEntry: async () => {
                events.push("writer.add");
                const entry = { ordinal: entries.length };
                entries.push(entry);
                return entry as never;
              },
              addWrappedLibraryKey: async () => {
                events.push("writer.wrap");
                const entry = { ordinal: entries.length };
                entries.push(entry);
                return entry as never;
              },
              finish: async (metadata) => {
                events.push("writer.finish");
                writtenManifest = { ...metadata, entries };
                return writtenManifest as never;
              },
              close: async () => {
                events.push("writer.close");
              },
            };
          },
        },
        readerFactory: {
          open: async () => {
            events.push("reader.open");
            return {
              readPublicHeader: async () => ({
                packageId: "00000000-0000-4000-8000-000000000015",
              }),
              unlock: async () => {
                events.push("reader.unlock");
              },
              extractTo: async (stagingRoot) => {
                events.push("reader.extract");
                const stagingPath = join(stagingRoot, ".package-extract-test");
                await mkdir(stagingPath);
                return { manifest: writtenManifest as never, stagingPath };
              },
              close: async () => {
                events.push("reader.close");
              },
            };
          },
        },
        verifyExtractedPackage: async () => {
          events.push("verify");
        },
        publishDependencies: {
          link: async (partialPath, finalPath) => {
            if (!finalPath.endsWith(".partial")) events.push("publish");
            if (publicCopy) throw Object.assign(new Error("public storage"), { code: "ENOTSUP" });
            await link(partialPath, finalPath);
          },
          syncDirectory: vi.fn(async () => undefined),
        },
      });
      const finalPath = join(destination, "transfer.zxwbackup");
      const result = await service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      });

      expect(preflightSpace).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ finalPath, fullVerificationPassed: true });
      expect(await readFile(finalPath, "utf8")).toBe("verified-package");
      expect(await readdir(destination)).toEqual(["transfer.zxwbackup"]);
      expect(await readdir(workRoot)).toEqual([]);
      expect(events).toEqual([
        "preflight",
        "gate",
        "acquire",
        "snapshot",
        "settings",
        "writer.create",
        "writer.add",
        "writer.add",
        "writer.add",
        "writer.finish",
        "reader.open",
        "reader.unlock",
        "reader.extract",
        "verify",
        "reader.close",
        "publish",
        "writer.close",
        "release",
      ]);
    },
  );

  test("rejects a work root that is a regular file and leaves it untouched", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "not-a-directory");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, destination].map((directory) => mkdir(directory)),
    );
    await writeFile(workRoot, "sentinel", "utf8");
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "file-work-root.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });
    expect(await readFile(workRoot, "utf8")).toBe("sentinel");
  });

  test("rejects a symbolic-link or junction work root without following or altering it", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const target = join(root, "application-data-target");
    const workRoot = join(root, "application-data-link");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, target, destination].map((directory) => mkdir(directory)),
    );
    await symlink(target, workRoot, process.platform === "win32" ? "junction" : "dir");
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "link-work-root.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });
    expect((await lstat(workRoot)).isSymbolicLink()).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  test("returns CANCELLED at entry and does not create the missing work root", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "missing-application-data");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, destination].map((directory) => mkdir(directory)),
    );
    const controller = new AbortController();
    controller.abort();
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "cancelled.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(lstat(workRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes a real small package, reopens it with the production reader, and keeps the source writable", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all([mkdir(workRoot), mkdir(destination)]);
    const prepared = await new LibraryMigrationService(libraryRoot).prepare();
    if (prepared.status !== "ready") throw new Error(`library setup failed: ${prepared.status}`);
    const database = prepared.database;
    const fileService = new FileService();
    const draftService = new DraftService(
      join(userDataRoot, "drafts"),
      () => new Date("2026-08-16T00:00:00.000Z"),
      fileService,
    );
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService,
      fileService,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: {
        acquire: async () => ({ release: async () => undefined }),
      },
      preflightSpace: async (input) => ({
        ...calculateFullDataExportSpaceBudget(input),
        sourceAvailableBytes: 10n ** 15n,
        targetAvailableBytes: 10n ** 15n,
        sameVolume: true,
      }),
      now: () => new Date("2026-08-16T00:00:01.000Z"),
      randomUUID: () => "00000000-0000-4000-8000-000000000015",
    });
    const finalPath = join(destination, "real.zxwbackup");
    try {
      const result = await service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath,
        password: "真实迁移密码足够长123456",
        passwordHint: "仅测试提示",
        passwordRecorded: true,
      });
      expect(result.fullVerificationPassed).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
      const extractionRoot = join(root, "independent-readback");
      await mkdir(extractionRoot);
      const reader = await PackageReader.open(finalPath, { currentImporterVersion: "0.1.0" });
      try {
        await reader.readPublicHeader();
        await reader.unlock("真实迁移密码足够长123456");
        const extraction = await reader.extractTo(extractionRoot);
        expect(extraction.manifest.packageId).toBe("00000000-0000-4000-8000-000000000015");
        expect(extraction.manifest.entries.map(({ logicalPath }) => logicalPath)).toContain(
          "library/library.sqlite3",
        );
        expect(extraction.manifest.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              logicalPath: "verification/integrity-summary.json",
              kind: "verification",
            }),
          ]),
        );
      } finally {
        await reader.close();
      }
      database.transaction((connection) =>
        connection
          .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
          .run("after-export", Buffer.from("source-still-writable"), "2026-08-16T00:00:02.000Z"),
      );
      expect(database.integrityCheck()).toEqual({ ok: true });
    } finally {
      database.close();
    }
  });

  test.each([
    ["preflight", "EIO"],
    ["gate", "EIO"],
    ["acquire", "EIO"],
    ["snapshot", "ENOSPC"],
    ["snapshot", "EFBIG"],
    ["settings", "EIO"],
    ["writer.create", "ENOSPC"],
    ["writer.create", "EFBIG"],
    ["writer.add", "EIO"],
    ["writer.finish", "EIO"],
    ["reader.open", "ENOSPC"],
    ["reader.open", "EFBIG"],
    ["partial.replace", "EIO"],
    ["reader.header", "EIO"],
    ["reader.unlock", "EIO"],
    ["reader.extract", "EIO"],
    ["verify", "EIO"],
    ["publish", "ENOSPC"],
    ["publish", "EFBIG"],
    ["final.replace", "EIO"],
  ] as const)("cleans up after %s/%s failure", async (failurePoint, nativeCode) => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const finalPath = join(destination, "failure.zxwbackup");
    let releaseCount = 0;
    let writtenManifest: Record<string, unknown> | undefined;
    let createdPartialPath: string | undefined;
    const fail = (point: typeof failurePoint) => {
      if (failurePoint === point) {
        if (point === "snapshot" && (nativeCode === "ENOSPC" || nativeCode === "EFBIG")) {
          throw new ExportSourceSnapshotError("SOURCE_SAVE_FAILED", false, nativeCode);
        }
        if (point === "writer.add") throw new PackageWriterError("WRITER_STATE_INVALID");
        if (point === "reader.header") throw new PackageReaderError("READER_STATE_INVALID");
        throw Object.assign(
          new Error(`fault:${point}:${finalPath}:correct horse battery staple:secret-name`),
          { code: nativeCode },
        );
      }
    };
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      gate: {
        runExclusive: async (_kind, task, signal) => {
          fail("gate");
          return await task(signal);
        },
      },
      quiescence: {
        acquire: async () => {
          fail("acquire");
          return {
            release: async () => {
              releaseCount += 1;
            },
          };
        },
      },
      snapshotter: {
        create: async ({ workRoot: operationRoot }) => {
          fail("snapshot");
          const taskDirectory = join(operationRoot, "00000000-0000-4000-8000-000000000013");
          const sourcePath = join(taskDirectory, "library", "library.sqlite3");
          await mkdir(join(taskDirectory, "library"), { recursive: true });
          await writeFile(sourcePath, "frozen-database");
          const databaseEntry = {
            logicalPath: "library/library.sqlite3",
            kind: "database" as const,
            size: 15,
            hash: "0".repeat(64),
            sourcePath,
          };
          return {
            taskDirectory,
            cutoffAt: "2026-08-16T00:00:00.000Z",
            database: databaseEntry,
            assetCount: 0,
            draftCount: 0,
            totalBytes: 15,
            entries: [databaseEntry],
          };
        },
      },
      settingsService: {
        read: async () => {
          fail("settings");
          return structuredClone(DEFAULT_APP_SETTINGS);
        },
      },
      estimateSpace: async () => ({ databaseBytes: 15n, estimatedPackageBytes: 1_024n }),
      preflightSpace: async () => {
        fail("preflight");
        return {
          sourceRequiredBytes: 1n,
          targetRequiredBytes: 1n,
          sourceAvailableBytes: 2n,
          targetAvailableBytes: 2n,
          sameVolume: false,
          warnings: [],
        };
      },
      summarizeSnapshot: async () => ({
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 15,
      }),
      schemaFingerprint: async () => "schema-fingerprint",
      writerFactory: {
        create: async ({ partialPath }) => {
          fail("writer.create");
          createdPartialPath = partialPath;
          await writeFile(partialPath, "partial-package", { flag: "wx" });
          const createdPartialIdentity = await testFileIdentity(partialPath);
          const entries: unknown[] = [];
          return {
            createdPartialIdentity,
            addEntry: async () => {
              fail("writer.add");
              const entry = { ordinal: entries.length };
              entries.push(entry);
              return entry as never;
            },
            finish: async (metadata) => {
              fail("writer.finish");
              writtenManifest = { ...metadata, entries };
              return writtenManifest as never;
            },
            close: async () => undefined,
          };
        },
      },
      readerFactory: {
        open: async () => {
          fail("reader.open");
          return {
            readPublicHeader: async () => {
              if (failurePoint === "partial.replace") {
                if (!createdPartialPath) throw new Error("missing partial path");
                const before = await stat(createdPartialPath);
                await unlink(createdPartialPath);
                await writeFile(createdPartialPath, Buffer.alloc(before.size, 0x78));
                await utimes(createdPartialPath, before.atime, before.mtime);
              }
              fail("reader.header");
              return { packageId: "00000000-0000-4000-8000-000000000015" };
            },
            unlock: async () => {
              fail("reader.unlock");
            },
            extractTo: async (stagingRoot) => {
              fail("reader.extract");
              const stagingPath = join(stagingRoot, ".package-extract-test");
              await mkdir(stagingPath);
              return { manifest: writtenManifest as never, stagingPath };
            },
            close: async () => undefined,
          };
        },
      },
      verifyExtractedPackage: async () => {
        fail("verify");
      },
      publishDependencies: {
        link: async (partialPath, targetPath) => {
          if (targetPath.endsWith(".partial")) return link(partialPath, targetPath);
          if (failurePoint === "final.replace") {
            await writeFile(targetPath, "external sentinel");
            return;
          }
          fail("publish");
          await link(partialPath, targetPath);
        },
        syncDirectory: vi.fn(async () => undefined),
      },
    });

    const failure = await service
      .export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (nativeCode === "ENOSPC" || nativeCode === "EFBIG") {
      expect(failure).toMatchObject({ code: "INSUFFICIENT_SPACE" });
    }
    if (failurePoint === "writer.add" || failurePoint === "reader.header") {
      expect(failure).toMatchObject({ code: "EXPORT_FAILED" });
      expect(failure).not.toBeInstanceOf(PackageWriterError);
      expect(failure).not.toBeInstanceOf(PackageReaderError);
    }
    if (failurePoint === "partial.replace") {
      expect(failure).toMatchObject({ code: "PACKAGE_TAMPERED" });
      expect(await readFile(createdPartialPath ?? "", "utf8")).toBe("x".repeat(15));
    }
    if (failurePoint === "final.replace") {
      expect(failure).toMatchObject({ code: "PACKAGE_TAMPERED" });
      expect(await readFile(finalPath, "utf8")).toBe("external sentinel");
    }
    expect((failure as Error).message).not.toContain(finalPath);
    expect((failure as Error).message).not.toContain("correct horse battery staple");
    expect((failure as Error).message).not.toContain("secret-name");
    if (failurePoint !== "final.replace") {
      await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (failurePoint === "partial.replace") {
      const recoveryFiles = await readdir(destination);
      expect(recoveryFiles).toHaveLength(2);
      for (const recoveryFile of recoveryFiles) {
        expect(await readFile(join(destination, recoveryFile), "utf8")).toBe("x".repeat(15));
      }
    } else if (failurePoint === "final.replace") {
      expect(await readdir(destination)).toEqual(["failure.zxwbackup"]);
    } else {
      expect(await readdir(destination)).toEqual([]);
    }
    if (failurePoint === "partial.replace") {
      // A replaced path is not ours: retain durable cleanup ownership, not the foreign bytes.
      const retained = await readdir(workRoot);
      expect(retained).toHaveLength(1);
      await expect(
        lstat(join(workRoot, retained[0]!, ".full-data-export-recovery.json")),
      ).resolves.toBeDefined();
    } else expect(await readdir(workRoot)).toEqual([]);
    await writeFile(join(libraryRoot, "source-remains-writable"), "ok");
    expect(await readFile(join(libraryRoot, "source-remains-writable"), "utf8")).toBe("ok");
    expect(releaseCount).toBe(["preflight", "gate", "acquire"].includes(failurePoint) ? 0 : 1);
  });

  test("returns success warnings rather than deleting a published final when cleanup and resume fail", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    let writtenManifest: Record<string, unknown> | undefined;
    let ownedOperationRoot = "";
    let replacementAnchor = "";
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      quiescence: {
        acquire: async () => ({
          release: async () => {
            throw new Error("resume failed");
          },
        }),
      },
      snapshotter: {
        create: async ({ workRoot: operationRoot }) => {
          ownedOperationRoot = operationRoot;
          const taskDirectory = join(operationRoot, "00000000-0000-4000-8000-000000000013");
          const sourcePath = join(taskDirectory, "library", "library.sqlite3");
          await mkdir(join(taskDirectory, "library"), { recursive: true });
          await writeFile(sourcePath, "frozen-database");
          const databaseEntry = {
            logicalPath: "library/library.sqlite3",
            kind: "database" as const,
            size: 15,
            hash: "0".repeat(64),
            sourcePath,
          };
          return {
            taskDirectory,
            cutoffAt: "2026-08-16T00:00:00.000Z",
            database: databaseEntry,
            assetCount: 0,
            draftCount: 0,
            totalBytes: 15,
            entries: [databaseEntry],
          };
        },
      },
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      estimateSpace: async () => ({ databaseBytes: 15n, estimatedPackageBytes: 1_024n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: false,
        warnings: [],
      }),
      summarizeSnapshot: async () => ({
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 15,
      }),
      schemaFingerprint: async () => "schema-fingerprint",
      writerFactory: {
        create: async ({ partialPath }) => {
          await writeFile(partialPath, "published-package", { flag: "wx" });
          const createdPartialIdentity = await testFileIdentity(partialPath);
          const entries: unknown[] = [];
          return {
            createdPartialIdentity,
            addEntry: async () => {
              const entry = { ordinal: entries.length };
              entries.push(entry);
              return entry as never;
            },
            addWrappedLibraryKey: async () => {
              const entry = { ordinal: entries.length };
              entries.push(entry);
              return entry as never;
            },
            finish: async (metadata) => {
              writtenManifest = { ...metadata, entries };
              return writtenManifest as never;
            },
            close: async () => {
              throw new Error("writer close failed");
            },
          };
        },
      },
      readerFactory: {
        open: async () => ({
          readPublicHeader: async () => ({
            packageId: "00000000-0000-4000-8000-000000000015",
          }),
          unlock: async () => undefined,
          extractTo: async (stagingRoot) => {
            const stagingPath = join(stagingRoot, ".package-extract-test");
            await mkdir(stagingPath);
            return { manifest: writtenManifest as never, stagingPath };
          },
          close: async () => undefined,
        }),
      },
      verifyExtractedPackage: async () => undefined,
      publishDependencies: {
        link: async (anchorPath, targetPath) => {
          if (targetPath.endsWith(".partial")) return link(anchorPath, targetPath);
          await link(anchorPath, targetPath);
          await unlink(anchorPath);
          await writeFile(anchorPath, "external anchor sentinel");
          replacementAnchor = anchorPath;
          await rename(ownedOperationRoot, `${ownedOperationRoot}.displaced`);
          await mkdir(ownedOperationRoot);
          await writeFile(join(ownedOperationRoot, "external-task-sentinel"), "preserve");
        },
        syncDirectory: vi.fn(async () => undefined),
      },
    });
    const finalPath = join(destination, "warning.zxwbackup");
    const result = await service.export({
      operationId: "00000000-0000-4000-8000-000000000014",
      finalPath,
      password: "correct horse battery staple",
      passwordHint: null,
      passwordRecorded: true,
    });
    expect(result.warnings).toEqual(["CLEANUP_FAILED", "BACKGROUND_RESUME_FAILED"]);
    expect(await readFile(finalPath, "utf8")).toBe("published-package");
    expect(await readFile(replacementAnchor, "utf8")).toBe("external anchor sentinel");
    expect(await readFile(join(ownedOperationRoot, "external-task-sentinel"), "utf8")).toBe(
      "preserve",
    );
  });

  test("never removes a pre-existing operation directory that it did not create", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const operationId = "00000000-0000-4000-8000-000000000014";
    const preExistingTaskRoot = join(workRoot, `.full-data-export-${operationId}`);
    await mkdir(preExistingTaskRoot);
    await writeFile(join(preExistingTaskRoot, "belongs-to-another-task"), "preserve-me");
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId,
        finalPath: join(destination, "preserve.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(preExistingTaskRoot, "belongs-to-another-task"), "utf8")).toBe(
      "preserve-me",
    );
  });

  test("never removes a pre-existing UUID partial that it did not create", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const operationId = "00000000-0000-4000-8000-000000000014";
    const partialPath = join(destination, `.preserve.${operationId}.zxwbackup.partial`);
    await writeFile(partialPath, "belongs-to-another-task");
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId,
        finalPath: join(destination, "preserve.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(partialPath, "utf8")).toBe("belongs-to-another-task");
    expect(await readdir(workRoot)).toEqual([]);
  });

  test("does not remove a replacement task root when cleanup ownership no longer matches", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    let replacementRoot = "";
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
      snapshotter: {
        create: async ({ workRoot: operationRoot }) => {
          replacementRoot = operationRoot;
          await rename(operationRoot, `${operationRoot}.displaced`);
          await mkdir(operationRoot);
          await writeFile(join(operationRoot, "external-sentinel"), "preserve");
          throw new Error("snapshot failed");
        },
      },
    });

    await expect(
      service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "task-root-race.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(replacementRoot, "external-sentinel"), "utf8")).toBe("preserve");
  });

  test("never recursively removes injected files when the task owner marker is not durable", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const probePath = join(root, "file-handle-probe");
    const probe = await open(probePath, "w");
    const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    await unlink(probePath);
    let injectedPath = "";
    vi.spyOn(prototype, "sync").mockImplementationOnce(async () => {
      const [taskName] = await readdir(workRoot);
      if (!taskName) throw new Error("task root missing");
      injectedPath = join(workRoot, taskName, "external-sentinel");
      await writeFile(injectedPath, "preserve");
      throw new Error("marker sync failed");
    });
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });

    await expect(
      service.export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "marker-failure.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(injectedPath, "utf8")).toBe("preserve");
  });

  test("does not unlink a partial created by another process between missing-check and writer create", async () => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const operationId = "00000000-0000-4000-8000-000000000014";
    const finalPath = join(destination, "race.zxwbackup");
    const partialPath = join(destination, `.race.${operationId}.zxwbackup.partial`);
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
      snapshotter: {
        create: async ({ workRoot: operationRoot }) => {
          const taskDirectory = join(operationRoot, "00000000-0000-4000-8000-000000000013");
          const sourcePath = join(taskDirectory, "library", "library.sqlite3");
          await mkdir(join(taskDirectory, "library"), { recursive: true });
          await writeFile(sourcePath, "x");
          const database = {
            logicalPath: "library/library.sqlite3",
            kind: "database" as const,
            size: 1,
            hash: "0".repeat(64),
            sourcePath,
          };
          return {
            taskDirectory,
            cutoffAt: "2026-08-16T00:00:00.000Z",
            database,
            assetCount: 0,
            draftCount: 0,
            totalBytes: 1,
            entries: [database],
          };
        },
      },
      summarizeSnapshot: async () => ({
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 1,
      }),
      schemaFingerprint: async () => "schema-fingerprint",
      writerFactory: {
        create: async ({ partialPath: candidate }) => {
          expect(candidate).toBe(partialPath);
          await writeFile(candidate, "external owner", { flag: "wx" });
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
      },
    });

    await expect(
      service.export({
        operationId,
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
    expect(await readFile(partialPath, "utf8")).toBe("external owner");
    await unlink(partialPath);
    expect(await readdir(workRoot)).toEqual([]);
  });

  test.each([
    ["cancelled", new FullDataExportError("CANCELLED")],
    ["busy", new DataTransferOperationError("OPERATION_IN_PROGRESS", "full-data-import")],
  ] as const)("preserves normalized %s gate outcomes", async (_case, gateFailure) => {
    const root = await temporaryRoot();
    const libraryRoot = join(root, "Library");
    const userDataRoot = join(root, "user-data");
    const workRoot = join(root, "work");
    const destination = join(root, "destination");
    await Promise.all(
      [libraryRoot, userDataRoot, workRoot, destination].map((directory) => mkdir(directory)),
    );
    const service = new FullDataExportService({
      applicationVersion: "0.1.0",
      database: {} as never,
      libraryRoot,
      userDataRoot,
      workRoot,
      draftService: {} as never,
      fileService: {} as never,
      settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
      quiescence: { acquire: async () => ({ release: async () => undefined }) },
      gate: {
        runExclusive: async () => {
          throw gateFailure;
        },
      },
      estimateSpace: async () => ({ databaseBytes: 1n, estimatedPackageBytes: 1n }),
      preflightSpace: async () => ({
        sourceRequiredBytes: 1n,
        targetRequiredBytes: 1n,
        sourceAvailableBytes: 2n,
        targetAvailableBytes: 2n,
        sameVolume: true,
        warnings: [],
      }),
    });
    const failure = await service
      .export({
        operationId: "00000000-0000-4000-8000-000000000014",
        finalPath: join(destination, "gate.zxwbackup"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      })
      .catch((error: unknown) => error);
    expect(failure).toBe(gateFailure);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "full-data-export-service-"));
  roots.push(root);
  return root;
}

describe("full data export request boundary", () => {
  test("accepts only a missing .zxwbackup final path", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "destination");
    await mkdir(destination);
    const operationId = "00000000-0000-4000-8000-000000000014";
    const finalPath = join(destination, "transfer.zxwbackup");

    expect(
      await assertFullDataExportRequest({
        operationId,
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).toMatchObject({ operationId, finalPath });

    await expect(
      assertFullDataExportRequest({
        operationId,
        finalPath: join(destination, "transfer.zip"),
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    await writeFile(finalPath, "existing-package");
    await expect(
      assertFullDataExportRequest({
        operationId,
        finalPath,
        password: "correct horse battery staple",
        passwordHint: null,
        passwordRecorded: true,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FullDataExportError>>({ code: "UNSAFE_OVERWRITE" }),
    );
  });
});
