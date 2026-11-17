import type { CanonicalDocument } from "../../../shared/document/model";
import { randomUuid } from "../../../shared/id";
import type { JsonObject } from "../../../shared/ipc/contract";
import type { AppError, AppResult } from "../../../shared/ipc/result";
import {
  diffCanonicalDocument,
  type LibraryEditBatch,
} from "../../../shared/library/edit-operations";
import type { LibraryEditAck, LibrarySaveState } from "../../../shared/library/model";

type QueueCallbacks = {
  onQueued?(snapshot: DocumentSaveQueueSnapshot): void;
  onConfirmed?(snapshot: DocumentSaveQueueSnapshot): void;
  onFailed?(snapshot: DocumentSaveQueueSnapshot): void;
  onRetrying?(snapshot: DocumentSaveQueueSnapshot): void;
};

export type DocumentSaveQueueSnapshot = {
  libraryDocumentId: string;
  sessionId: string;
  model: CanonicalDocument;
  localRevision: number;
  persistedRevision: number;
  saveState: LibrarySaveState;
  lastSavedAt: string | null;
  saveError: AppError | null;
};

type DocumentSaveQueueOptions = QueueCallbacks & {
  libraryDocumentId: string;
  sessionId: string;
  initialDocument: CanonicalDocument;
  initialRevision: number;
  applyEdit(batch: LibraryEditBatch): Promise<AppResult<LibraryEditAck>>;
  flushRevision(
    libraryDocumentId: string,
    revision: number,
  ): Promise<AppResult<{ revision: number; flushedAt: string }>>;
  randomUUID?: () => string;
};

type QueuedBatch = {
  batch: LibraryEditBatch;
  model: CanonicalDocument;
};

type DrainWaiter = {
  resolve(): void;
  reject(error: AppError): void;
};

function internalError(): AppError {
  return { code: "INTERNAL", message: "本地保存队列失败。" };
}

function toAppError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const typed = error as AppError;
    return { code: typed.code, message: typed.message, nextAction: typed.nextAction };
  }
  return internalError();
}

export class DocumentSaveQueue {
  readonly libraryDocumentId: string;
  readonly sessionId: string;

  #model: CanonicalDocument;
  #localRevision: number;
  #persistedRevision: number;
  #saveState: LibrarySaveState = "saved";
  #lastSavedAt: string | null = null;
  #saveError: AppError | null = null;
  #running = false;
  #disposed = false;
  readonly #applyEdit: DocumentSaveQueueOptions["applyEdit"];
  readonly #flushRevision: DocumentSaveQueueOptions["flushRevision"];
  readonly #randomUUID: () => string;
  readonly #callbacks: QueueCallbacks;
  readonly #pending: QueuedBatch[] = [];
  readonly #waiters: DrainWaiter[] = [];

  constructor(options: DocumentSaveQueueOptions) {
    this.libraryDocumentId = options.libraryDocumentId;
    this.sessionId = options.sessionId;
    this.#model = structuredClone(options.initialDocument);
    this.#localRevision = options.initialRevision;
    this.#persistedRevision = options.initialRevision;
    this.#applyEdit = options.applyEdit;
    this.#flushRevision = options.flushRevision;
    this.#randomUUID = options.randomUUID ?? randomUuid;
    const callbacks: QueueCallbacks = {};
    if (options.onQueued) callbacks.onQueued = options.onQueued;
    if (options.onConfirmed) callbacks.onConfirmed = options.onConfirmed;
    if (options.onFailed) callbacks.onFailed = options.onFailed;
    if (options.onRetrying) callbacks.onRetrying = options.onRetrying;
    this.#callbacks = callbacks;
  }

  snapshot(): DocumentSaveQueueSnapshot {
    return {
      libraryDocumentId: this.libraryDocumentId,
      sessionId: this.sessionId,
      model: this.#model,
      localRevision: this.#localRevision,
      persistedRevision: this.#persistedRevision,
      saveState: this.#saveState,
      lastSavedAt: this.#lastSavedAt,
      saveError: this.#saveError,
    };
  }

  enqueue(modelInput: CanonicalDocument, editorState: JsonObject = {}): DocumentSaveQueueSnapshot {
    const model = structuredClone(modelInput);
    const operations = diffCanonicalDocument(this.#model, model);
    this.#model = model;
    if (operations.length === 0) return this.snapshot();

    const baseRevision = this.#localRevision;
    const targetRevision = baseRevision + 1;
    this.#localRevision = targetRevision;
    this.#pending.push({
      model,
      batch: {
        libraryDocumentId: this.libraryDocumentId,
        sessionId: this.sessionId,
        operationId: this.#randomUUID(),
        baseRevision,
        targetRevision,
        modelVersion: 1,
        operations,
        editorState,
      },
    });
    if (this.#saveState !== "failed") this.#saveState = "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  async retry(): Promise<void> {
    if (!this.#saveError) return this.flush();
    this.#saveError = null;
    this.#saveState = "saving";
    this.#emit("onRetrying");
    this.#startPump();
    await this.flush();
  }

  async flush(options: { snapshot?: boolean } = {}): Promise<void> {
    if (this.#saveError) throw this.#saveError;
    await this.#waitForDrain();
    if (this.#saveError) throw this.#saveError;
    if (!options.snapshot) return;

    const result = await this.#flushRevision(this.libraryDocumentId, this.#persistedRevision);
    if (!result.ok) throw result.error;
  }

  dispose(): void {
    this.#disposed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(internalError());
  }

  #startPump(): void {
    if (this.#running || this.#saveError || this.#disposed) return;
    this.#running = true;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#disposed && !this.#saveError && this.#pending.length > 0) {
        const item = this.#pending[0];
        if (!item) break;
        const result = await this.#applyEdit(item.batch);
        if (!result.ok) {
          this.#fail(result.error);
          break;
        }
        if (
          result.value.operationId !== item.batch.operationId ||
          result.value.revision !== item.batch.targetRevision
        ) {
          this.#fail({
            code: "REVISION_CONFLICT",
            message: "文档修订与保存队列不一致。",
          });
          break;
        }
        this.#pending.shift();
        this.#persistedRevision = result.value.revision;
        this.#lastSavedAt = result.value.savedAt;
        this.#saveState = this.#pending.length === 0 ? "saved" : "saving";
        this.#emit("onConfirmed");
      }
    } catch (error) {
      this.#fail(toAppError(error));
    } finally {
      this.#running = false;
      this.#notifyWaiters();
      if (!this.#disposed && !this.#saveError && this.#pending.length > 0) this.#startPump();
    }
  }

  #fail(error: AppError): void {
    this.#saveError = error;
    this.#saveState = "failed";
    this.#emit("onFailed");
  }

  #waitForDrain(): Promise<void> {
    if (this.#saveError) return Promise.reject(this.#saveError);
    if (!this.#running && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #notifyWaiters(): void {
    if (this.#running || (!this.#saveError && this.#pending.length > 0)) return;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (this.#saveError) waiter.reject(this.#saveError);
      else waiter.resolve();
    }
  }

  #emit(callback: keyof QueueCallbacks): void {
    if (this.#disposed) return;
    this.#callbacks[callback]?.(this.snapshot());
  }
}
