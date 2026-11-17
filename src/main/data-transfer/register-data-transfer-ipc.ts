import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  type DataTransferLibraryInspection,
  DataTransferLibraryInspectionSchema,
  DataTransferOperationIdSchema,
  type DataTransferProgress,
  DataTransferProgressSchema,
  FullDataExportRequestSchema,
  type FullDataExportResult,
  FullDataExportResultSchema,
  FullDataImportCommitRequestSchema,
  FullDataImportPrepareRequestSchema,
  type FullDataImportPreview,
  FullDataImportPreviewSchema,
  type TransferDestinationSelection,
  type TransferSourceSelection,
} from "../../shared/data-transfer/model.js";
import { IPC_CHANNELS, type IpcChannel } from "../../shared/ipc/contract.js";
import {
  type AppErrorCode,
  AppErrorCodeSchema,
  type AppResult,
  normalizeAppError,
} from "../../shared/ipc/result.js";
import { LibraryImportSwapError } from "./library-import-swap-coordinator.js";

const DEFAULT_SELECTION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_SELECTIONS = 8;

export type TransferSourceCapability = Readonly<{
  size: number;
  close(): Promise<void>;
  fork?(): Promise<TransferSourceCapability>;
}>;

type SourceRegistration = Readonly<{
  fileName: string;
  sourceHandle: TransferSourceCapability;
  header: Readonly<{
    packageFormatVersion: number;
    minimumImporterVersion: string;
    passwordHint: string | null;
  }>;
}>;

type DestinationRecord = Readonly<{
  kind: "destination";
  ownerId: number;
  finalPath: string;
  timeout: ReturnType<typeof setTimeout>;
}>;

type SourceRecord = Readonly<{
  kind: "source";
  ownerId: number;
  sourceHandle: TransferSourceCapability;
  timeout: ReturnType<typeof setTimeout>;
}>;

type SelectionRecord = DestinationRecord | SourceRecord;

export class TransferSelectionError extends Error {
  constructor(readonly code: AppErrorCode) {
    super(code);
    this.name = "TransferSelectionError";
  }
}

function sameOrInside(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(pathFromParent))
  );
}

function hasInternalTransferSegment(path: string): boolean {
  return resolve(path)
    .split(/[\\/]/u)
    .some((segment) =>
      /^(?:\.?(?:full-data-export|import-staging|import-rollback|data-import-staging))-/u.test(
        segment,
      ),
    );
}

export class TransferSelectionRegistry {
  readonly #records = new Map<string, SelectionRecord>();
  readonly #libraryRoot: string;
  readonly #userDataRoot: string;
  readonly #applicationDataRoot: string;
  readonly #ttlMs: number;
  readonly #maxSelections: number;
  readonly #createId: () => string;

  constructor(
    options: Readonly<{
      libraryRoot: string;
      userDataRoot: string;
      applicationDataRoot: string;
      ttlMs?: number;
      maxSelections?: number;
      createId?: () => string;
    }>,
  ) {
    this.#libraryRoot = resolve(options.libraryRoot);
    this.#userDataRoot = resolve(options.userDataRoot);
    this.#applicationDataRoot = resolve(options.applicationDataRoot);
    this.#ttlMs = options.ttlMs ?? DEFAULT_SELECTION_TTL_MS;
    this.#maxSelections = options.maxSelections ?? DEFAULT_MAX_SELECTIONS;
    this.#createId = options.createId ?? randomUUID;
  }

  #reserve(recordFactory: (timeout: ReturnType<typeof setTimeout>) => SelectionRecord): string {
    if (this.#records.size >= this.#maxSelections) {
      throw new TransferSelectionError("OPERATION_IN_PROGRESS");
    }
    const selectionId = this.#createId();
    const timeout = setTimeout(() => void this.#expire(selectionId), this.#ttlMs);
    timeout.unref?.();
    this.#records.set(selectionId, recordFactory(timeout));
    return selectionId;
  }

  async #expire(selectionId: string): Promise<void> {
    const record = this.#records.get(selectionId);
    if (!record) return;
    this.#records.delete(selectionId);
    if (record.kind === "source") await record.sourceHandle.close().catch(() => undefined);
  }

  async registerDestination(
    ownerId: number,
    untrustedFinalPath: string,
  ): Promise<TransferDestinationSelection> {
    if (!Number.isSafeInteger(ownerId) || typeof untrustedFinalPath !== "string") {
      throw new TransferSelectionError("INVALID_INPUT");
    }
    const requestedPath = resolve(untrustedFinalPath);
    const requestedParent = dirname(requestedPath);
    const [canonicalParent, parentInfo] = await Promise.all([
      realpath(requestedParent),
      lstat(requestedParent),
    ]);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new TransferSelectionError("DESTINATION_UNAVAILABLE");
    }
    const finalPath = resolve(
      canonicalParent,
      extname(requestedPath).toLocaleLowerCase("en-US") === ".zxwbackup"
        ? basename(requestedPath)
        : `${basename(requestedPath)}.zxwbackup`,
    );
    const draftsRoot = resolve(this.#userDataRoot, "drafts");
    if (
      sameOrInside(this.#libraryRoot, finalPath) ||
      sameOrInside(this.#applicationDataRoot, finalPath) ||
      sameOrInside(draftsRoot, finalPath) ||
      hasInternalTransferSegment(finalPath)
    ) {
      throw new TransferSelectionError("UNSAFE_OVERWRITE");
    }
    const selectionId = this.#reserve((timeout) => ({
      kind: "destination",
      ownerId,
      finalPath,
      timeout,
    }));
    return Object.freeze({
      selectionId,
      displayPath: basename(canonicalParent),
      suggestedFileName: basename(finalPath),
    });
  }

  registerSource(ownerId: number, input: SourceRegistration): TransferSourceSelection {
    if (
      !Number.isSafeInteger(ownerId) ||
      !Number.isSafeInteger(input.sourceHandle.size) ||
      input.sourceHandle.size < 0
    ) {
      throw new TransferSelectionError("INVALID_INPUT");
    }
    const selectionId = this.#reserve((timeout) => ({
      kind: "source",
      ownerId,
      sourceHandle: input.sourceHandle,
      timeout,
    }));
    return Object.freeze({
      selectionId,
      fileName: basename(input.fileName),
      sizeBytes: input.sourceHandle.size,
      packageFormatVersion: input.header.packageFormatVersion,
      minimumImporterVersion: input.header.minimumImporterVersion,
      passwordHint: input.header.passwordHint,
    });
  }

  assertSourceOwner(selectionId: string, ownerId: number): void {
    const record = this.#records.get(selectionId);
    if (record?.kind !== "source" || record.ownerId !== ownerId) {
      throw new TransferSelectionError("INVALID_INPUT");
    }
  }

  consumeDestination(selectionId: string, ownerId: number): string {
    const record = this.#records.get(selectionId);
    if (record?.kind !== "destination" || record.ownerId !== ownerId) {
      throw new TransferSelectionError("INVALID_INPUT");
    }
    this.#records.delete(selectionId);
    clearTimeout(record.timeout);
    return record.finalPath;
  }

  consumeSource(selectionId: string): TransferSourceCapability {
    const record = this.#records.get(selectionId);
    if (record?.kind !== "source") throw new TransferSelectionError("INVALID_INPUT");
    this.#records.delete(selectionId);
    clearTimeout(record.timeout);
    return record.sourceHandle;
  }

  async leaseSource(selectionId: string): Promise<TransferSourceCapability> {
    const record = this.#records.get(selectionId);
    if (record?.kind !== "source" || !record.sourceHandle.fork)
      throw new TransferSelectionError("INVALID_INPUT");
    const handle = await record.sourceHandle.fork();
    if (this.#records.get(selectionId) !== record) {
      await handle.close();
      throw new TransferSelectionError("INVALID_INPUT");
    }
    return handle;
  }

  async releaseOwner(ownerId: number): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const [selectionId, record] of this.#records) {
      if (record.ownerId !== ownerId) continue;
      this.#records.delete(selectionId);
      clearTimeout(record.timeout);
      if (record.kind === "source") releases.push(record.sourceHandle.close());
    }
    await Promise.allSettled(releases);
  }

  async dispose(): Promise<void> {
    const owners = new Set([...this.#records.values()].map((record) => record.ownerId));
    await Promise.all([...owners].map(async (ownerId) => await this.releaseOwner(ownerId)));
  }
}

export interface DataTransferIpcSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
}

export type FullDataExportProgress = Readonly<{
  operationId: string;
  kind: "full-data-export";
  phase:
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
  processedBytes: number;
  totalBytes: number | null;
  elapsedMs: number;
  etaMs: number | null;
  currentCategory: Exclude<DataTransferProgress["currentCategory"], "switching">;
}>;

type DataTransferServices = Readonly<{
  inspectLibrary(): Promise<DataTransferLibraryInspection>;
  chooseExportPath(event: { sender: DataTransferIpcSender }): Promise<string | null>;
  chooseImportSource(event: {
    sender: DataTransferIpcSender;
  }): Promise<(SourceRegistration & { fileName: string }) | null>;
  exportPackage(
    request: Readonly<{
      operationId: string;
      finalPath: string;
      password: string;
      passwordHint: string | null;
      passwordRecorded: true;
      signal: AbortSignal;
      onProgress(progress: FullDataExportProgress): void;
    }>,
  ): Promise<FullDataExportResult & { finalPath?: string; warnings?: readonly unknown[] }>;
  prepareImport(
    request: Readonly<{
      operationId: string;
      sourceSelectionId: string;
      password: string;
      signal: AbortSignal;
    }>,
  ): Promise<FullDataImportPreview>;
  commitImport(request: Readonly<{ operationId: string }>): Promise<void>;
  discardImport?(operationId: string): Promise<void>;
}>;

type RegisterHandler = (
  channel: IpcChannel,
  handler: (event: { sender: DataTransferIpcSender }, input?: unknown) => unknown,
) => void;

type ActiveOperation = Readonly<{
  ownerId: number;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}>;

function ipcFailure(error: unknown): AppResult<never> {
  const candidateCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : "INTERNAL";
  const code = AppErrorCodeSchema.safeParse(candidateCode).success
    ? (candidateCode as AppErrorCode)
    : "INTERNAL";
  return { ok: false, error: normalizeAppError({ code, message: "normalized" }) };
}

export function registerDataTransferIpc(
  options: Readonly<{
    register: RegisterHandler;
    registry: TransferSelectionRegistry;
    services: DataTransferServices;
    lifecycle: Readonly<{
      setImmediate(task: () => void): unknown;
      reportImportRecoveryFailure(): void;
      authorizeCloseForRelaunch(): void;
      relaunch(): void;
      quit(): void;
    }>;
  }>,
): () => Promise<void> {
  const active = new Map<string, ActiveOperation>();
  const preparedOwners = new Map<string, number>();
  const committing = new Set<string>();
  const pendingTasks = new Set<Promise<unknown>>();
  const boundSenders = new Map<number, DataTransferIpcSender>();

  const bindSender = (sender: DataTransferIpcSender) => {
    if (boundSenders.has(sender.id)) return;
    boundSenders.set(sender.id, sender);
    sender.once("destroyed", () => {
      boundSenders.delete(sender.id);
      for (const [operationId, operation] of active) {
        if (operation.ownerId !== sender.id) continue;
        operation.controller.abort();
      }
      for (const [operationId, ownerId] of preparedOwners) {
        if (ownerId !== sender.id) continue;
        preparedOwners.delete(operationId);
        void options.services.discardImport?.(operationId).catch(() => undefined);
      }
      void options.registry.releaseOwner(sender.id);
    });
  };

  const beginOperation = (operationId: string, sender: DataTransferIpcSender) => {
    if (active.has(operationId) || preparedOwners.has(operationId)) {
      throw new TransferSelectionError("OPERATION_IN_PROGRESS");
    }
    bindSender(sender);
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((done) => {
      resolveSettled = done;
    });
    active.set(operationId, { ownerId: sender.id, controller, settled, resolveSettled });
    return controller;
  };
  const finishOperation = (operationId: string, controller: AbortController) => {
    if (active.get(operationId)?.controller !== controller) return;
    active.get(operationId)?.resolveSettled();
    active.delete(operationId);
  };

  const track = <T>(task: Promise<T>): Promise<T> => {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
    return task;
  };

  options.register(IPC_CHANNELS.dataTransferInspectLibrary, async () => {
    try {
      return {
        ok: true,
        value: DataTransferLibraryInspectionSchema.parse(await options.services.inspectLibrary()),
      };
    } catch (error) {
      return ipcFailure(error);
    }
  });

  options.register(IPC_CHANNELS.dataTransferSelectExportDestination, async (event) => {
    try {
      const { sender } = event;
      bindSender(sender);
      const finalPath = await options.services.chooseExportPath(event);
      return {
        ok: true,
        value: finalPath ? await options.registry.registerDestination(sender.id, finalPath) : null,
      };
    } catch (error) {
      return ipcFailure(error);
    }
  });

  options.register(IPC_CHANNELS.dataTransferSelectImportPackage, async (event) => {
    let source: SourceRegistration | null = null;
    try {
      const { sender } = event;
      bindSender(sender);
      source = await options.services.chooseImportSource(event);
      if (sender.isDestroyed()) throw new TransferSelectionError("CANCELLED");
      if (!source) return { ok: true, value: null };
      const selection = options.registry.registerSource(sender.id, source);
      source = null;
      return { ok: true, value: selection };
    } catch (error) {
      await source?.sourceHandle.close().catch(() => undefined);
      return ipcFailure(error);
    }
  });

  options.register(IPC_CHANNELS.dataTransferExportPackage, async ({ sender }, input) => {
    let operationId: string | undefined;
    let operationController: AbortController | undefined;
    try {
      const request = FullDataExportRequestSchema.parse(input);
      operationId = request.operationId;
      const controller = beginOperation(operationId, sender);
      operationController = controller;
      const finalPath = options.registry.consumeDestination(
        request.destinationSelectionId,
        sender.id,
      );
      const exported = await track(
        options.services.exportPackage({
          operationId,
          finalPath,
          password: request.password,
          passwordHint: request.passwordHint,
          passwordRecorded: request.passwordRecorded,
          signal: controller.signal,
          onProgress: (progress) => {
            if (sender.isDestroyed()) return;
            const event = DataTransferProgressSchema.parse({
              operationId: progress.operationId,
              kind: progress.kind,
              phase: progress.phase,
              completedBytes: progress.processedBytes,
              totalBytes: progress.totalBytes,
              currentCategory: progress.currentCategory,
              elapsedMs: progress.elapsedMs,
              remainingMs: progress.etaMs,
              cancellable: !["publishing-package", "completed", "cancelled", "failed"].includes(
                progress.phase,
              ),
            });
            sender.send(IPC_CHANNELS.dataTransferProgress, event);
          },
        }),
      );
      const safeResult = FullDataExportResultSchema.parse({
        operationId: exported.operationId,
        displayPath: basename(finalPath),
        sizeBytes: exported.sizeBytes,
        cutoffAt: exported.cutoffAt,
        packageFormatVersion: exported.packageFormatVersion,
        summary: exported.summary,
        fullVerificationPassed: exported.fullVerificationPassed,
      });
      return { ok: true, value: safeResult };
    } catch (error) {
      return ipcFailure(error);
    } finally {
      if (operationId && operationController) finishOperation(operationId, operationController);
    }
  });

  options.register(IPC_CHANNELS.dataTransferPrepareImport, async ({ sender }, input) => {
    let operationId: string | undefined;
    let operationController: AbortController | undefined;
    try {
      const request = FullDataImportPrepareRequestSchema.parse(input);
      operationId = request.operationId;
      options.registry.assertSourceOwner(request.sourceSelectionId, sender.id);
      const controller = beginOperation(operationId, sender);
      operationController = controller;
      preparedOwners.set(operationId, sender.id);
      if (!sender.isDestroyed()) {
        sender.send(
          IPC_CHANNELS.dataTransferProgress,
          DataTransferProgressSchema.parse({
            operationId,
            kind: "full-data-import",
            phase: "reading-header",
            completedBytes: 0,
            totalBytes: null,
            currentCategory: "verification",
            elapsedMs: 0,
            remainingMs: null,
            cancellable: true,
          }),
        );
      }
      const preview = await track(
        options.services.prepareImport({
          ...request,
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) {
        await options.services.discardImport?.(operationId);
        throw new TransferSelectionError("CANCELLED");
      }
      if (sender.isDestroyed()) {
        await options.services.discardImport?.(operationId);
        throw new TransferSelectionError("CANCELLED");
      }
      preparedOwners.set(operationId, sender.id);
      if (!sender.isDestroyed()) {
        sender.send(
          IPC_CHANNELS.dataTransferProgress,
          DataTransferProgressSchema.parse({
            operationId,
            kind: "full-data-import",
            phase: "preview-ready",
            completedBytes: 0,
            totalBytes: null,
            currentCategory: "verification",
            elapsedMs: 0,
            remainingMs: null,
            cancellable: true,
          }),
        );
      }
      return { ok: true, value: FullDataImportPreviewSchema.parse(preview) };
    } catch (error) {
      const failure = ipcFailure(error);
      if (
        operationId &&
        operationController &&
        preparedOwners.get(operationId) === sender.id &&
        !failure.ok &&
        failure.error.code !== "IMPORT_RECOVERY_REQUIRED"
      )
        preparedOwners.delete(operationId);
      return failure;
    } finally {
      if (operationId && operationController) finishOperation(operationId, operationController);
    }
  });

  options.register(IPC_CHANNELS.dataTransferCancel, async ({ sender }, input) => {
    try {
      const operationId = DataTransferOperationIdSchema.parse(input);
      if (committing.has(operationId)) throw new TransferSelectionError("OPERATION_IN_PROGRESS");
      const operation = active.get(operationId);
      if (operation) {
        if (operation.ownerId !== sender.id) throw new TransferSelectionError("NOT_FOUND");
        operation.controller.abort();
        await operation.settled;
        if (preparedOwners.get(operationId) === sender.id) {
          await options.services.discardImport?.(operationId);
          preparedOwners.delete(operationId);
        }
        return { ok: true, value: undefined };
      }
      if (preparedOwners.get(operationId) === sender.id) {
        await options.services.discardImport?.(operationId);
        preparedOwners.delete(operationId);
        return { ok: true, value: undefined };
      }
      throw new TransferSelectionError("NOT_FOUND");
    } catch (error) {
      return ipcFailure(error);
    }
  });

  options.register(IPC_CHANNELS.dataTransferCommitImport, async ({ sender }, input) => {
    let committingOperation: string | undefined;
    try {
      bindSender(sender);
      const request = FullDataImportCommitRequestSchema.parse(input);
      if (preparedOwners.get(request.operationId) !== sender.id) {
        throw new TransferSelectionError("NOT_FOUND");
      }
      if (committing.has(request.operationId))
        throw new TransferSelectionError("OPERATION_IN_PROGRESS");
      committing.add(request.operationId);
      committingOperation = request.operationId;
      let recoveryRequired = false;
      try {
        await track(options.services.commitImport({ operationId: request.operationId }));
      } catch (error) {
        if (!(error instanceof LibraryImportSwapError) || !error.restartRequired) throw error;
        recoveryRequired = true;
      }
      preparedOwners.delete(request.operationId);
      options.lifecycle.setImmediate(() => {
        try {
          if (recoveryRequired) options.lifecycle.reportImportRecoveryFailure();
        } finally {
          try {
            options.lifecycle.authorizeCloseForRelaunch();
            options.lifecycle.relaunch();
          } finally {
            options.lifecycle.quit();
          }
        }
      });
      return { ok: true, value: { restartPending: true as const } };
    } catch (error) {
      return ipcFailure(error);
    } finally {
      if (committingOperation) committing.delete(committingOperation);
    }
  });

  return async () => {
    for (const operation of active.values()) operation.controller.abort();
    await Promise.all([...active.values()].map((operation) => operation.settled));
    await Promise.allSettled([...pendingTasks]);
    active.clear();
    for (const operationId of preparedOwners.keys()) {
      await options.services.discardImport?.(operationId).catch(() => undefined);
    }
    preparedOwners.clear();
    await options.registry.dispose();
  };
}
