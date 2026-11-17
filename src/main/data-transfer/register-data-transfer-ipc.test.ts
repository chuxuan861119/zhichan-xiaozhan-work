import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparedFullDataImport } from "./full-data-import-service.js";
import {
  LibraryImportSwapCoordinator,
  LibraryImportSwapError,
} from "./library-import-swap-coordinator.js";
import {
  type DataTransferIpcSender,
  type FullDataExportProgress,
  registerDataTransferIpc,
  TransferSelectionRegistry,
} from "./register-data-transfer-ipc.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000901";
const PASSWORD = "虚构迁移口令十二字以上安全测试";
const SUMMARY = {
  activePatents: 0,
  trashedPatents: 0,
  documents: 0,
  legacyDrafts: 0,
  snapshots: 0,
  assets: 0,
  flowchartProjects: 0,

  totalBytes: 0,
} as const;
const createdRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    createdRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

class Sender extends EventEmitter implements DataTransferIpcSender {
  readonly sent: Array<{ channel: string; value: unknown }> = [];
  destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
  }

  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

async function createRoots() {
  const root = await mkdtemp(join(tmpdir(), "data-transfer-ipc-"));
  createdRoots.push(root);
  const libraryRoot = join(root, "app-data", "library");
  const applicationDataRoot = join(root, "app-data");
  const userDataRoot = join(root, "user-data");
  const externalRoot = join(root, "external");
  await Promise.all([
    mkdir(libraryRoot, { recursive: true }),
    mkdir(join(userDataRoot, "drafts"), { recursive: true }),
    mkdir(externalRoot, { recursive: true }),
  ]);
  return { root, libraryRoot, applicationDataRoot, userDataRoot, externalRoot };
}

function createRegistration(registry: TransferSelectionRegistry) {
  const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
  const exportPackage = vi.fn(
    async (request: {
      operationId: string;
      onProgress: (value: FullDataExportProgress) => void;
    }) => {
      request.onProgress({
        operationId: request.operationId,
        kind: "full-data-export",
        phase: "encrypting",
        processedBytes: 2,
        totalBytes: 4,
        elapsedMs: 10,
        etaMs: 10,
        currentCategory: "database",
      });
      return {
        operationId: request.operationId,
        finalPath: "must-not-leak",
        displayPath: "backup.zxwbackup",
        sizeBytes: 4,
        cutoffAt: "2026-08-16T00:00:00.000Z",
        packageFormatVersion: 2 as const,
        summary: SUMMARY,
        fullVerificationPassed: true as const,
        warnings: [],
      };
    },
  );
  const prepareImport = vi.fn(async (request: { operationId: string }) => ({
    operationId: request.operationId,
    packageId: "00000000-0000-4000-8000-000000000902",
    exportedAt: "2026-08-16T00:00:00.000Z",
    summary: SUMMARY,
    packageVerified: true as const,
    versionCompatible: true as const,
    targetLibraryEmpty: true as const,
    settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"] as const,
  }));
  const commitImport = vi.fn(async () => undefined);
  const lifecycle = {
    reportImportRecoveryFailure: vi.fn(),
    setImmediate: vi.fn((task: () => void) => task()),
    authorizeCloseForRelaunch: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(),
  };
  const dispose = registerDataTransferIpc({
    register: (channel, handler) => handlers.set(channel, handler as never),
    registry,
    services: {
      inspectLibrary: async () => ({ empty: true, blockers: [], summary: SUMMARY }),
      chooseExportPath: async () => null,
      chooseImportSource: async () => null,
      exportPackage,
      prepareImport,
      commitImport,
    },
    lifecycle,
  });
  return { handlers, exportPackage, prepareImport, commitImport, lifecycle, dispose };
}

describe("TransferSelectionRegistry", () => {
  test("leases a new source handle for each password attempt without consuming the selected capability", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const originalClose = vi.fn(async () => undefined);
    const fork = vi.fn(async () => ({ size: 12, close: vi.fn(async () => undefined) }));
    const source = registry.registerSource(7, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: originalClose, fork },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    await (await registry.leaseSource(source.selectionId)).close();
    registry.assertSourceOwner(source.selectionId, 7);
    await (await registry.leaseSource(source.selectionId)).close();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(originalClose).not.toHaveBeenCalled();
    await registry.dispose();
    expect(originalClose).toHaveBeenCalledOnce();
  });
  test("stores only bounded short-lived selections and closes source capabilities", async () => {
    vi.useFakeTimers();
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry({ ...roots, maxSelections: 1, ttlMs: 1_000 });
    const close = vi.fn(async () => undefined);
    registry.registerSource(7, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    expect(() =>
      registry.registerSource(7, {
        fileName: "second.zxwbackup",
        sourceHandle: { size: 12, close: vi.fn() },
        header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
      }),
    ).toThrow();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(close).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  test.each(["libraryRoot", "applicationDataRoot", "drafts"] as const)(
    "rejects protected export destination: %s",
    async (target) => {
      const roots = await createRoots();
      const registry = new TransferSelectionRegistry(roots);
      const parent =
        target === "drafts"
          ? join(roots.userDataRoot, "drafts")
          : target === "libraryRoot"
            ? roots.libraryRoot
            : roots.applicationDataRoot;
      await expect(
        registry.registerDestination(1, join(parent, "unsafe.zxwbackup")),
      ).rejects.toMatchObject({ code: "UNSAFE_OVERWRITE" });
      await registry.dispose();
    },
  );

  test("normalizes an external destination without exposing it to later renderer input", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const selected = await registry.registerDestination(
      4,
      join(roots.externalRoot, "portable.zxwbackup"),
    );
    expect(selected).toEqual({
      selectionId: expect.any(String),
      displayPath: "external",
      suggestedFileName: "portable.zxwbackup",
    });
    expect(registry.consumeDestination(selected.selectionId, 4)).toBe(
      join(roots.externalRoot, "portable.zxwbackup"),
    );
    expect(() => registry.consumeDestination(selected.selectionId, 4)).toThrow();
    await registry.dispose();
  });
});

describe("registerDataTransferIpc", () => {
  test("closes a source returned after its initiating sender was destroyed", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    let finishSelection!: (source: {
      fileName: string;
      sourceHandle: { size: number; close(): Promise<void> };
      header: { packageFormatVersion: number; minimumImporterVersion: string; passwordHint: null };
    }) => void;
    const selectionPending = new Promise<Parameters<typeof finishSelection>[0]>((resolve) => {
      finishSelection = resolve;
    });
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: async () => await selectionPending,
        exportPackage: vi.fn(),
        prepareImport: vi.fn(),
        commitImport: vi.fn(),
      },
      lifecycle: {
        reportImportRecoveryFailure: vi.fn(),
        setImmediate,
        authorizeCloseForRelaunch: vi.fn(),
        relaunch: vi.fn(),
        quit: vi.fn(),
      },
    });
    const close = vi.fn(async () => undefined);
    const sender = new Sender(14);
    const pending = handlers.get("data-transfer:select-import-package")?.({
      sender,
    }) as Promise<unknown>;
    sender.destroy();
    finishSelection({
      fileName: "late.zxwbackup",
      sourceHandle: { size: 12, close },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(close).toHaveBeenCalledOnce();
  });

  test("never includes the password or final filesystem path in results or progress", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const selected = await registry.registerDestination(
      5,
      join(roots.externalRoot, "portable.zxwbackup"),
    );
    const { handlers, dispose } = createRegistration(registry);
    const sender = new Sender(5);
    const result = await handlers.get("data-transfer:export-package")?.(
      { sender },
      {
        operationId: OPERATION_ID,
        destinationSelectionId: selected.selectionId,
        password: PASSWORD,
        passwordHint: null,
        passwordRecorded: true,
      },
    );
    expect(JSON.stringify({ result, progress: sender.sent })).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(roots.externalRoot);
    expect(sender.sent).toEqual([
      {
        channel: "data-transfer:progress",
        value: expect.objectContaining({ completedBytes: 2, cancellable: true }),
      },
    ]);
    await dispose();
  });

  test("sends progress only to the initiating sender and aborts when it is destroyed", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const selected = await registry.registerDestination(
      5,
      join(roots.externalRoot, "portable.zxwbackup"),
    );
    let observedSignal: AbortSignal | undefined;
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: vi.fn(),
        exportPackage: async (request) => {
          observedSignal = request.signal;
          await new Promise((resolve) => request.signal.addEventListener("abort", resolve));
          throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
        },
        prepareImport: vi.fn(),
        commitImport: vi.fn(),
      },
      lifecycle: {
        reportImportRecoveryFailure: vi.fn(),
        setImmediate,
        authorizeCloseForRelaunch: vi.fn(),
        relaunch: vi.fn(),
        quit: vi.fn(),
      },
    });
    const owner = new Sender(5);
    const unrelated = new Sender(6);
    const pending = handlers.get("data-transfer:export-package")?.(
      { sender: owner },
      {
        operationId: OPERATION_ID,
        destinationSelectionId: selected.selectionId,
        password: PASSWORD,
        passwordHint: null,
        passwordRecorded: true,
      },
    ) as Promise<unknown>;
    unrelated.destroy();
    expect(observedSignal?.aborted).toBe(false);
    owner.destroy();
    await pending;
    expect(observedSignal?.aborted).toBe(true);
    expect(unrelated.sent).toEqual([]);
  });

  test("reports a failed preflight without restarting or quitting", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const { handlers, commitImport, lifecycle, dispose } = createRegistration(registry);
    const source = registry.registerSource(8, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    const sender = new Sender(8);
    await handlers.get("data-transfer:prepare-import")?.(
      { sender },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    commitImport.mockRejectedValueOnce(new Error("synthetic switch failure"));
    const result = await handlers.get("data-transfer:commit-import")?.(
      { sender },
      { operationId: OPERATION_ID, acknowledgedEmptyLibraryAndRestart: true },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await vi.waitFor(() => expect(commitImport).toHaveBeenCalledOnce());
    expect(lifecycle.authorizeCloseForRelaunch).not.toHaveBeenCalled();
    expect(lifecycle.relaunch).not.toHaveBeenCalled();
    expect(lifecycle.quit).not.toHaveBeenCalled();
    // A pre-shutdown rejection still belongs to this sender and is cancellable.
    expect(await handlers.get("data-transfer:cancel")?.({ sender }, OPERATION_ID)).toMatchObject({
      ok: true,
    });
    await dispose();
  });

  test("reports a failure after shutdown before restarting for recovery", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const { handlers, commitImport, lifecycle, dispose } = createRegistration(registry);
    const source = registry.registerSource(8, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    const sender = new Sender(8);
    await handlers.get("data-transfer:prepare-import")?.(
      { sender },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    commitImport.mockRejectedValueOnce(
      new LibraryImportSwapError("IMPORT_RECOVERY_REQUIRED", "failed", true),
    );
    expect(
      await handlers.get("data-transfer:commit-import")?.(
        { sender },
        { operationId: OPERATION_ID, acknowledgedEmptyLibraryAndRestart: true },
      ),
    ).toEqual({ ok: true, value: { restartPending: true } });
    expect(lifecycle.reportImportRecoveryFailure).toHaveBeenCalledOnce();
    expect(lifecycle.relaunch).toHaveBeenCalledOnce();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    expect(lifecycle.reportImportRecoveryFailure.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.relaunch.mock.invocationCallOrder[0] ?? 0,
    );
    await dispose();
  });

  test("commits through the real swap coordinator before scheduling restart", async () => {
    const roots = await createRoots();
    const libraryRoot = join(roots.root, "swap", "library");
    const userDataRoot = join(roots.root, "swap-user-data");
    const stagingRoot = join(dirname(libraryRoot), `.import-staging-${OPERATION_ID}`);
    const stagingLibraryPath = join(stagingRoot, "library");
    const stagingUserRoot = join(dirname(userDataRoot), `.import-user-data-${OPERATION_ID}`);
    const stagingDraftsPath = join(stagingUserRoot, "drafts");
    const settingsCandidatePath = join(stagingUserRoot, `settings-candidate-${OPERATION_ID}.json`);
    await Promise.all([
      mkdir(join(libraryRoot, "library"), { recursive: true }),
      mkdir(join(stagingLibraryPath, "library"), { recursive: true }),
      mkdir(stagingDraftsPath, { recursive: true }),
      mkdir(join(userDataRoot, "drafts"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(libraryRoot, "library", "old.txt"), "old"),
      writeFile(join(stagingLibraryPath, "library", "new.txt"), "new"),
      writeFile(join(userDataRoot, "settings.json"), '{"current":true}\n'),
      writeFile(settingsCandidatePath, '{"candidate":true}\n'),
    ]);
    const [stagingInfo, userStagingInfo] = await Promise.all([
      lstat(stagingRoot, { bigint: true }),
      lstat(stagingUserRoot, { bigint: true }),
    ]);
    const prepared = {
      operationId: OPERATION_ID,
      packageId: "00000000-0000-4000-8000-000000000902",
      manifest: {
        packageId: "00000000-0000-4000-8000-000000000902",
        packageFormatVersion: 2,
        payloadSha256: "a".repeat(64),
        totalOriginalBytes: 0,
        exportedAt: "2026-08-16T00:00:00.000Z",
        summary: SUMMARY,
      },
      preview: {} as PreparedFullDataImport["preview"],
      stagingLibraryPath,
      stagingDraftsPath,
      settingsCandidatePath,
      settingsCandidateIntegrity: { sha256: "a".repeat(64) },
      stagingDatabaseIntegrity: { size: "1", sha256: "b".repeat(64) },
      libraryStagingCapability: {
        root: stagingRoot,
        identity: {
          device: String(stagingInfo.dev),
          inode: String(stagingInfo.ino),
          birthtimeNs: String(stagingInfo.birthtimeNs),
        },
      },
      userDataStagingCapability: {
        root: stagingUserRoot,
        identity: {
          device: String(userStagingInfo.dev),
          inode: String(userStagingInfo.ino),
          birthtimeNs: String(userStagingInfo.birthtimeNs),
        },
      },
    } as PreparedFullDataImport;
    let runtimeOpen = true;
    let finishCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const registry = new TransferSelectionRegistry(roots);
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    const lifecycle = {
      reportImportRecoveryFailure: vi.fn(),
      setImmediate: (task: () => void) => task(),
      authorizeCloseForRelaunch: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    };
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: vi.fn(),
        exportPackage: vi.fn(),
        prepareImport: async (request) => ({
          operationId: request.operationId,
          packageId: prepared.packageId,
          exportedAt: prepared.manifest.exportedAt,
          summary: SUMMARY,
          packageVerified: true,
          versionCompatible: true,
          targetLibraryEmpty: true,
          settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
        }),
        commitImport: async () => {
          try {
            await new LibraryImportSwapCoordinator({
              libraryRoot,
              userDataRoot,
              applicationDataRoot: roots.applicationDataRoot,
              prepared,
              journal: { create: async () => ({}), advance: async () => ({}) },
              ensureCurrentState: async () => undefined,
              inspectEmptyLibrary: async () => {
                if (!runtimeOpen) throw new Error("closed database used by IPC commit");
                return { empty: true, blockers: [] };
              },
              validateStaging: async () => SUMMARY,
              closeRuntime: async () => {
                runtimeOpen = false;
              },
            }).commit();
          } finally {
            finishCommit();
          }
        },
      },
      lifecycle,
    });
    const sender = new Sender(15);
    const source = registry.registerSource(sender.id, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    await handlers.get("data-transfer:prepare-import")?.(
      { sender },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    expect(
      await handlers.get("data-transfer:commit-import")?.(
        { sender },
        { operationId: OPERATION_ID, acknowledgedEmptyLibraryAndRestart: true },
      ),
    ).toEqual({ ok: true, value: { restartPending: true } });
    await committed;
    await expect(readFile(join(libraryRoot, "library", "new.txt"), "utf8")).resolves.toBe("new");
    expect(lifecycle.relaunch).toHaveBeenCalledOnce();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    expect(lifecycle.authorizeCloseForRelaunch).toHaveBeenCalledOnce();
  });

  test("rejects a commit from another sender and discards prepared staging when the owner exits", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    const discardImport = vi.fn(async () => undefined);
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: vi.fn(),
        exportPackage: vi.fn(),
        prepareImport: async (request) => ({
          operationId: request.operationId,
          packageId: "00000000-0000-4000-8000-000000000902",
          exportedAt: "2026-08-16T00:00:00.000Z",
          summary: SUMMARY,
          packageVerified: true,
          versionCompatible: true,
          targetLibraryEmpty: true,
          settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
        }),
        commitImport: vi.fn(),
        discardImport,
      },
      lifecycle: {
        reportImportRecoveryFailure: vi.fn(),
        setImmediate,
        authorizeCloseForRelaunch: vi.fn(),
        relaunch: vi.fn(),
        quit: vi.fn(),
      },
    });
    const owner = new Sender(10);
    const source = registry.registerSource(owner.id, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    await handlers.get("data-transfer:prepare-import")?.(
      { sender: owner },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    const otherResult = await handlers.get("data-transfer:commit-import")?.(
      { sender: new Sender(11) },
      { operationId: OPERATION_ID, acknowledgedEmptyLibraryAndRestart: true },
    );
    expect(otherResult).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    owner.destroy();
    await vi.waitFor(() => expect(discardImport).toHaveBeenCalledWith(OPERATION_ID));
  });

  test("lets only the initiating sender cancel and discard a prepared import", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    const discardImport = vi.fn(async () => undefined);
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: vi.fn(),
        exportPackage: vi.fn(),
        prepareImport: async (request) => ({
          operationId: request.operationId,
          packageId: "00000000-0000-4000-8000-000000000902",
          exportedAt: "2026-08-16T00:00:00.000Z",
          summary: SUMMARY,
          packageVerified: true,
          versionCompatible: true,
          targetLibraryEmpty: true,
          settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
        }),
        commitImport: vi.fn(),
        discardImport,
      },
      lifecycle: {
        reportImportRecoveryFailure: vi.fn(),
        setImmediate,
        authorizeCloseForRelaunch: vi.fn(),
        relaunch: vi.fn(),
        quit: vi.fn(),
      },
    });
    const owner = new Sender(12);
    const source = registry.registerSource(owner.id, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    await handlers.get("data-transfer:prepare-import")?.(
      { sender: owner },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    const denied = await handlers.get("data-transfer:cancel")?.(
      { sender: new Sender(13) },
      OPERATION_ID,
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const cancelled = await handlers.get("data-transfer:cancel")?.({ sender: owner }, OPERATION_ID);
    expect(cancelled).toEqual({ ok: true, value: undefined });
    expect(discardImport).toHaveBeenCalledWith(OPERATION_ID);
  });

  test("discards a late successful prepare after its active operation was cancelled", async () => {
    const roots = await createRoots();
    const registry = new TransferSelectionRegistry(roots);
    const handlers = new Map<string, (event: { sender: Sender }, input?: unknown) => unknown>();
    let finishPrepare!: () => void;
    const prepareCanFinish = new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const discardImport = vi.fn(async () => undefined);
    const commitImport = vi.fn(async () => undefined);
    registerDataTransferIpc({
      register: (channel, handler) => handlers.set(channel, handler as never),
      registry,
      services: {
        inspectLibrary: vi.fn(),
        chooseExportPath: vi.fn(),
        chooseImportSource: vi.fn(),
        exportPackage: vi.fn(),
        prepareImport: async (request) => {
          observedSignal = request.signal;
          await prepareCanFinish;
          return {
            operationId: request.operationId,
            packageId: "00000000-0000-4000-8000-000000000902",
            exportedAt: "2026-08-16T00:00:00.000Z",
            summary: SUMMARY,
            packageVerified: true,
            versionCompatible: true,
            targetLibraryEmpty: true,
            settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
          };
        },
        commitImport,
        discardImport,
      },
      lifecycle: {
        reportImportRecoveryFailure: vi.fn(),
        setImmediate,
        authorizeCloseForRelaunch: vi.fn(),
        relaunch: vi.fn(),
        quit: vi.fn(),
      },
    });
    const owner = new Sender(14);
    const source = registry.registerSource(owner.id, {
      fileName: "fixture.zxwbackup",
      sourceHandle: { size: 12, close: vi.fn(async () => undefined) },
      header: { packageFormatVersion: 2, minimumImporterVersion: "1.0.0", passwordHint: null },
    });
    const preparing = handlers.get("data-transfer:prepare-import")?.(
      { sender: owner },
      { operationId: OPERATION_ID, sourceSelectionId: source.selectionId, password: PASSWORD },
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const cancelling = handlers.get("data-transfer:cancel")?.({ sender: owner }, OPERATION_ID);
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    finishPrepare();
    await expect(cancelling).resolves.toEqual({ ok: true, value: undefined });

    await expect(preparing).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(discardImport).toHaveBeenCalledOnce();
    expect(discardImport).toHaveBeenCalledWith(OPERATION_ID);
    expect(
      await handlers.get("data-transfer:commit-import")?.(
        { sender: owner },
        { operationId: OPERATION_ID, acknowledgedEmptyLibraryAndRestart: true },
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(commitImport).not.toHaveBeenCalled();
  });
});
