import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isCanonicalDocumentBlank } from "../../shared/document/content-state.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { defaultDocumentFont } from "../../shared/document/font-policy.js";
import type { CanonicalDocument } from "../../shared/document/model.js";
import { validateCanonicalDocument } from "../../shared/document/validation.js";
import type { JsonObject } from "../../shared/ipc/contract.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import {
  diffCanonicalDocument,
  type LibraryEditBatch,
} from "../../shared/library/edit-operations.js";
import {
  LibraryDocumentIdSchema,
  type LibraryDocumentSummary,
  type LibraryEditAck,
  LibraryRevisionSchema,
  type LibrarySaveState,
} from "../../shared/library/model.js";
import { TRASH_RETENTION_MS } from "../../shared/library/trash-retention.js";
import {
  decodeDocumentSnippet,
  decodeDocumentTitle,
  deleteDocumentEditorState,
  documentHistoryTables,
  documentMetadata,
  EditJournal,
  encodeSnapshot,
  LibraryServiceError,
  loadLibraryDocument,
  loadLibraryDocumentForValidation,
  readDocumentEditorState,
  writeDocumentEditorState,
} from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";

const LibraryTitleSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim().length > 0, "标题不能为空。");

export const LibraryRenameRequestSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    operationId: z.string().uuid(),
    expectedRevision: LibraryRevisionSchema,
    title: LibraryTitleSchema,
  })
  .strict();
export type LibraryRenameRequest = z.infer<typeof LibraryRenameRequestSchema>;

export type OpenedLibraryDocument = {
  libraryDocumentId: string;
  sessionId: string;
  revision: number;
  document: CanonicalDocument;
  editorState: JsonObject;
  saveState: LibrarySaveState;
};

export type LibraryFlushResult = {
  libraryDocumentId: string;
  revision: number;
  flushedAt: string;
};

export type LibraryImportHooks = {
  beforeCommit(): void;
  inTransaction(
    database: DatabaseSync,
    document: { libraryDocumentId: string; document: CanonicalDocument },
  ): void;
};

export type LibraryServiceOptions = {
  database: LibraryDatabase;
  now?: () => Date;
  randomUUID?: () => string;
  collectUnusedAssets?: (libraryDocumentId: string) => Promise<void> | void;
  snapshots?: {
    recordEdit(libraryDocumentId: string): void;
    flush(libraryDocumentId: string): Promise<unknown>;
  };
};

type ListRow = {
  library_document_id: string;
  revision: number;
  title: Uint8Array;
  snippet: Uint8Array;
  created_at: string;
  modified_at: string;
  deleted_at: string | null;
  quarantined_at: string | null;
};

type RevisionRow = {
  revision: number;
  deleted_at: string | null;
};

function defaultTitle(now: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `未命名文档 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function createTitle(input: string | undefined, now: Date): string {
  return LibraryTitleSchema.parse(input?.trim() || defaultTitle(now));
}

function ensureActive(row: RevisionRow | undefined): RevisionRow {
  if (row === undefined || row.deleted_at !== null) {
    throw new LibraryServiceError("NOT_FOUND", "Document not found.");
  }
  return row;
}

function validateLibraryDocument(document: CanonicalDocument): CanonicalDocument {
  const result = validateCanonicalDocument(document);
  if (!result.ok) throw new LibraryServiceError("INVALID_INPUT", result.error.message);
  LibraryTitleSchema.parse(result.value.title);
  return result.value;
}

export class LibraryService {
  private readonly database: LibraryDatabase;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly collectUnusedAssets: (libraryDocumentId: string) => Promise<void> | void;
  private readonly snapshots: LibraryServiceOptions["snapshots"];
  private readonly journal: EditJournal;
  private readonly snapshotTable: "snapshots" | "document_snapshots";
  private readonly leases = new Map<string, string>();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(options: LibraryServiceOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => randomUUID());
    this.collectUnusedAssets = options.collectUnusedAssets ?? (() => undefined);
    this.snapshots = options.snapshots;
    this.snapshotTable = this.database.read(documentHistoryTables).snapshots;
    this.journal = new EditJournal(this.database, this.now);
  }

  create(title?: string): Promise<OpenedLibraryDocument> {
    return this.#enqueueWrite(() => {
      const now = this.now();
      const createdAt = now.toISOString();
      const libraryDocumentId = this.randomUUID();
      const sessionId = this.randomUUID();
      const normalizedTitle = createTitle(title, now);
      const document = createBlankDocument(normalizedTitle);
      const paragraph = document.content[0];
      if (paragraph?.type === "paragraph")
        paragraph.attrs.defaultFontFamily = defaultDocumentFont(process.platform);
      document.documentId = this.randomUUID();
      document.createdAt = createdAt;
      document.modifiedAt = createdAt;

      const metadata = documentMetadata(document);
      const snapshot = encodeSnapshot(document);
      this.database.transaction((database) => {
        database
          .prepare(
            `INSERT INTO documents(
               library_document_id,
               canonical_document_id,
               revision,
               title,
               snippet,
               created_at,
               modified_at,
               deleted_at,
               quarantined_at
             ) VALUES (?, ?, 0, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            libraryDocumentId,
            document.documentId,
            metadata.title,
            metadata.snippet,
            createdAt,
            createdAt,
          );
        database
          .prepare(
            `INSERT INTO ${this.snapshotTable}(
               library_document_id,
               revision,
               model_version,
               payload,
               content_hash,
               created_at
             ) VALUES (?, 0, 1, ?, ?, ?)`,
          )
          .run(libraryDocumentId, snapshot.payload, snapshot.contentHash, createdAt);
      });
      this.leases.set(sessionId, libraryDocumentId);
      return {
        libraryDocumentId,
        sessionId,
        revision: 0,
        document,
        editorState: {},
        saveState: "saved",
      };
    });
  }

  importDocument(
    documentInput: CanonicalDocument,
    hooks?: LibraryImportHooks,
    editorStateInput: JsonObject = {},
  ): Promise<OpenedLibraryDocument> {
    return this.#enqueueWrite(() => {
      const now = this.now();
      const createdAt = now.toISOString();
      const libraryDocumentId = this.randomUUID();
      const sessionId = this.randomUUID();
      const document = validateLibraryDocument(structuredClone(documentInput));
      const editorState = JsonObjectSchema.parse(editorStateInput);
      const metadata = documentMetadata(document);
      const snapshot = encodeSnapshot(document);
      hooks?.beforeCommit();
      this.database.transaction((database) => {
        database
          .prepare(
            `INSERT INTO documents(
               library_document_id,
               canonical_document_id,
               revision,
               title,
               snippet,
               created_at,
               modified_at,
               deleted_at,
               quarantined_at
             ) VALUES (?, ?, 0, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            libraryDocumentId,
            document.documentId,
            metadata.title,
            metadata.snippet,
            createdAt,
            createdAt,
          );
        database
          .prepare(
            `INSERT INTO ${this.snapshotTable}(
               library_document_id,
               revision,
               model_version,
               payload,
               content_hash,
               created_at
             ) VALUES (?, 0, 1, ?, ?, ?)`,
          )
          .run(libraryDocumentId, snapshot.payload, snapshot.contentHash, createdAt);
        hooks?.inTransaction(database, { libraryDocumentId, document });
        writeDocumentEditorState(database, libraryDocumentId, editorState, createdAt);
      });
      this.leases.set(sessionId, libraryDocumentId);
      return {
        libraryDocumentId,
        sessionId,
        revision: 0,
        document,
        editorState,
        saveState: "saved",
      };
    });
  }

  replaceInitialDocument(
    libraryDocumentIdInput: string,
    documentInput: CanonicalDocument,
    editorStateInput: JsonObject = {},
  ): Promise<OpenedLibraryDocument> {
    return this.#enqueueWrite(() => {
      const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
      const sessionId = this.randomUUID();
      const document = validateLibraryDocument(structuredClone(documentInput));
      const editorState = JsonObjectSchema.parse(editorStateInput);
      const modifiedAt = this.now().toISOString();
      const metadata = documentMetadata(document);
      const snapshot = encodeSnapshot(document);
      this.database.transaction((database) => {
        const row = ensureActive(
          database
            .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
            .get(libraryDocumentId) as RevisionRow | undefined,
        );
        if (row.revision !== 0) {
          throw new LibraryServiceError("REVISION_CONFLICT", "Initial document already changed.");
        }
        database
          .prepare(
            `UPDATE documents
             SET canonical_document_id = ?,
                 title = ?,
                 snippet = ?,
                 modified_at = ?
             WHERE library_document_id = ?`,
          )
          .run(
            document.documentId,
            metadata.title,
            metadata.snippet,
            modifiedAt,
            libraryDocumentId,
          );
        database
          .prepare(
            `UPDATE ${this.snapshotTable}
             SET payload = ?,
                 content_hash = ?,
                 created_at = ?
             WHERE library_document_id = ? AND revision = 0`,
          )
          .run(snapshot.payload, snapshot.contentHash, modifiedAt, libraryDocumentId);
        writeDocumentEditorState(database, libraryDocumentId, editorState, modifiedAt);
      });
      this.leases.set(sessionId, libraryDocumentId);
      return {
        libraryDocumentId,
        sessionId,
        revision: 0,
        document,
        editorState,
        saveState: "saved",
      };
    });
  }

  async list(scope: "active" | "trash", includeBlank = false): Promise<LibraryDocumentSummary[]> {
    const rows = this.database.read((database) =>
      database
        .prepare(
          `SELECT library_document_id,
                  revision,
                  title,
                  snippet,
                  created_at,
                  modified_at,
                  deleted_at,
                  quarantined_at
           FROM documents
           WHERE ${scope === "active" ? "deleted_at IS NULL" : "deleted_at IS NOT NULL"}
           ORDER BY modified_at DESC`,
        )
        .all(),
    ) as ListRow[];

    const summaries = rows.map((row) => ({
      libraryDocumentId: row.library_document_id,
      title: decodeDocumentTitle(row.title),
      snippet: decodeDocumentSnippet(row.snippet),
      revision: row.revision,
      saveState: "saved" as const,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      deletedAt: row.deleted_at,
      quarantinedAt: null,
      recoveryState: "healthy" as const,
      recoveryErrorCode: null,
    }));
    if (scope === "trash" || includeBlank) return summaries;

    return summaries.filter((summary) => {
      if (summary.snippet.length > 0) return true;
      const loaded = this.database.read((database) =>
        loadLibraryDocument(database, summary.libraryDocumentId),
      );
      return !isCanonicalDocumentBlank(loaded.document);
    });
  }

  async open(libraryDocumentIdInput: string): Promise<OpenedLibraryDocument> {
    const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
    const loaded = this.database.read((database) => {
      ensureActive(
        database
          .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
          .get(libraryDocumentId) as RevisionRow | undefined,
      );
      return {
        ...loadLibraryDocument(database, libraryDocumentId),
        editorState: readDocumentEditorState(database, libraryDocumentId),
      };
    });
    const sessionId = this.randomUUID();
    this.leases.set(sessionId, libraryDocumentId);
    return {
      libraryDocumentId,
      sessionId,
      revision: loaded.revision,
      document: loaded.document,
      editorState: loaded.editorState,
      saveState: "saved",
    };
  }

  captureAutomation(libraryDocumentId: string, persisted = false) {
    LibraryDocumentIdSchema.parse(libraryDocumentId);
    if (!persisted && this.#isLeased(libraryDocumentId))
      throw new LibraryServiceError(
        "LIBRARY_LOCKED",
        "文档正在编辑，请关闭编辑窗口或显式读取已保存版本。",
      );
    return this.database.read((database) => {
      const row = database
        .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id=?")
        .get(libraryDocumentId) as RevisionRow | undefined;
      if (!row) throw new LibraryServiceError("NOT_FOUND", "Document not found.");
      const loaded = loadLibraryDocumentForValidation(database, libraryDocumentId);
      return {
        documentId: libraryDocumentId,
        revision: row.revision,
        deletedAt: row.deleted_at,
        document: loaded.document,
        editorState: readDocumentEditorState(database, libraryDocumentId),
      };
    });
  }

  mutateAutomation(
    input: { documentId: string; expectedRevision: number } & (
      | { action: "update"; document: CanonicalDocument }
      | { action: "trash" | "restore" | "delete"; expectedDeletedAt: string | null }
      | { action: "asset"; assetId: string }
    ),
    hooks: {
      assertAuthorized(): void;
      inTransaction(database: DatabaseSync, result: unknown): void;
    },
  ): Promise<unknown> {
    return this.#enqueueWrite(async () => {
      hooks.assertAuthorized();
      const current = this.captureAutomation(input.documentId);
      if (current.revision !== input.expectedRevision)
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      if (input.action === "update") {
        if (current.deletedAt !== null)
          throw new LibraryServiceError("NOT_FOUND", "Document is in trash.");
        const document = validateLibraryDocument(input.document);
        if (
          document.documentId !== current.document.documentId ||
          document.createdAt !== current.document.createdAt ||
          document.patentType !== current.document.patentType
        )
          throw new LibraryServiceError("INVALID_INPUT", "不能更改文档身份或创建时间。");
        for (const asset of document.assets) {
          const owned = this.database.read((database) =>
            database
              .prepare("SELECT 1 FROM document_assets WHERE library_document_id=? AND asset_id=?")
              .get(input.documentId, asset.assetId),
          );
          if (!owned) throw new LibraryServiceError("INVALID_INPUT", "资源不属于当前文档。");
        }
        const operations = diffCanonicalDocument(current.document, document);
        if (operations.length === 0) {
          const result = { documentId: input.documentId, revision: current.revision };
          this.database.transaction((database) => hooks.inTransaction(database, result));
          return result;
        }
        return this.journal.append(
          {
            libraryDocumentId: input.documentId,
            sessionId: this.randomUUID(),
            operationId: this.randomUUID(),
            baseRevision: current.revision,
            targetRevision: current.revision + 1,
            modelVersion: 1,
            operations,
            editorState: this.database.read((database) =>
              readDocumentEditorState(database, input.documentId),
            ),
          },
          (database, ack) =>
            hooks.inTransaction(database, { documentId: input.documentId, revision: ack.revision }),
        );
      }
      return this.database.transaction((database) => {
        if (input.action === "asset") {
          if (current.deletedAt !== null)
            throw new LibraryServiceError("NOT_FOUND", "Document is in trash.");
          database
            .prepare(
              "INSERT OR IGNORE INTO document_assets(library_document_id, asset_id) VALUES (?, ?)",
            )
            .run(input.documentId, input.assetId);
        } else {
          if (current.deletedAt !== input.expectedDeletedAt)
            throw new LibraryServiceError("REVISION_CONFLICT", "回收站状态已变化。");
          if (
            (input.action === "trash" && current.deletedAt !== null) ||
            (input.action !== "trash" && current.deletedAt === null)
          )
            throw new LibraryServiceError("INVALID_INPUT", "回收站状态不符合操作要求。");
          if (input.action === "delete") {
            database
              .prepare("DELETE FROM documents WHERE library_document_id=?")
              .run(input.documentId);
            deleteDocumentEditorState(database, input.documentId);
          } else
            database
              .prepare(
                "UPDATE documents SET deleted_at=?, modified_at=? WHERE library_document_id=?",
              )
              .run(
                input.action === "trash" ? this.now().toISOString() : null,
                this.now().toISOString(),
                input.documentId,
              );
        }
        const result = {
          documentId: input.documentId,
          revision: current.revision,
          action: input.action,
        };
        hooks.inTransaction(database, result);
        return result;
      });
    }).then(async (result) => {
      if (input.action === "delete") await this.collectUnusedAssets(input.documentId);
      return result;
    });
  }

  rename(requestInput: LibraryRenameRequest): Promise<LibraryEditAck> {
    const request = LibraryRenameRequestSchema.parse(requestInput);
    return this.#enqueueWrite(() =>
      this.journal.append({
        libraryDocumentId: request.libraryDocumentId,
        sessionId: this.randomUUID(),
        operationId: request.operationId,
        baseRevision: request.expectedRevision,
        targetRevision: request.expectedRevision + 1,
        modelVersion: 1,
        operations: [{ type: "set-title", title: request.title }],
        editorState: this.database.read((database) =>
          readDocumentEditorState(database, request.libraryDocumentId),
        ),
      }),
    ).then((ack) => this.#recordEditForSnapshots(ack));
  }

  applyEdit(batch: LibraryEditBatch): Promise<LibraryEditAck> {
    return this.#enqueueWrite(() => this.journal.append(batch)).then((ack) =>
      this.#recordEditForSnapshots(ack),
    );
  }

  async flush(
    libraryDocumentIdInput: string,
    expectedRevision: number,
  ): Promise<LibraryFlushResult> {
    const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
    await this.snapshots?.flush(libraryDocumentId);
    return await this.#enqueueWrite(() => {
      const row = ensureActive(
        this.database.read((database) =>
          database
            .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
            .get(libraryDocumentId),
        ) as RevisionRow | undefined,
      );
      if (row.revision !== expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      this.database.checkpoint();
      return {
        libraryDocumentId,
        revision: expectedRevision,
        flushedAt: this.now().toISOString(),
      };
    });
  }

  moveToTrash(libraryDocumentIdInput: string): Promise<void> {
    return this.#enqueueWrite(() => {
      const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
      const deletedAt = this.now().toISOString();
      this.database.transaction((database) => {
        ensureActive(
          database
            .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
            .get(libraryDocumentId) as RevisionRow | undefined,
        );
        database
          .prepare(
            "UPDATE documents SET deleted_at = ?, modified_at = ? WHERE library_document_id = ?",
          )
          .run(deletedAt, deletedAt, libraryDocumentId);
      });
    });
  }

  restore(libraryDocumentIdInput: string): Promise<void> {
    return this.#enqueueWrite(() => {
      const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
      const restoredAt = this.now().toISOString();
      this.database.transaction((database) => {
        const row = database
          .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
          .get(libraryDocumentId) as RevisionRow | undefined;
        if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Document not found.");
        database
          .prepare(
            "UPDATE documents SET deleted_at = NULL, modified_at = ? WHERE library_document_id = ?",
          )
          .run(restoredAt, libraryDocumentId);
      });
    });
  }

  async permanentlyDelete(libraryDocumentIdInput: string): Promise<void> {
    const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
    await this.#enqueueWrite(() => {
      if (this.#isLeased(libraryDocumentId)) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Document has an active lease.");
      }
      this.database.transaction((database) => {
        const row = database
          .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
          .get(libraryDocumentId) as RevisionRow | undefined;
        if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Document not found.");
        if (row.deleted_at === null) {
          throw new LibraryServiceError("INVALID_INPUT", "Document must be in trash.");
        }
        database
          .prepare("DELETE FROM documents WHERE library_document_id = ?")
          .run(libraryDocumentId);
        deleteDocumentEditorState(database, libraryDocumentId);
      });
    });
    await this.collectUnusedAssets(libraryDocumentId);
  }

  purgeExpired(now: Date = this.now()): Promise<{ purgedDocumentIds: string[] }> {
    return this.#enqueueWrite(async () => {
      const rows = this.database.read((database) =>
        database
          .prepare(
            "SELECT library_document_id, deleted_at FROM documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at, library_document_id",
          )
          .all(),
      ) as Array<{ library_document_id: string; deleted_at: string }>;
      const purgedDocumentIds: string[] = [];
      for (const row of rows) {
        const expiresAt = Date.parse(row.deleted_at) + TRASH_RETENTION_MS;
        if (expiresAt > now.getTime() || this.#isLeased(row.library_document_id)) continue;
        this.database.transaction((database) => {
          database
            .prepare(
              "DELETE FROM documents WHERE library_document_id = ? AND deleted_at IS NOT NULL",
            )
            .run(row.library_document_id);
          deleteDocumentEditorState(database, row.library_document_id);
        });
        purgedDocumentIds.push(row.library_document_id);
        await this.collectUnusedAssets(row.library_document_id);
      }
      return { purgedDocumentIds };
    });
  }

  async release(sessionId: string, options?: { preserveBlank?: boolean }): Promise<void> {
    const libraryDocumentId = this.leases.get(sessionId);
    if (libraryDocumentId === undefined) return;
    this.leases.delete(sessionId);
    if (options?.preserveBlank) return;
    if (this.#isLeased(libraryDocumentId)) return;

    let deleted = false;
    try {
      deleted = await this.#enqueueWrite(() => {
        if (this.#isLeased(libraryDocumentId)) return false;
        const row = this.database.read((database) =>
          database
            .prepare("SELECT revision, deleted_at FROM documents WHERE library_document_id = ?")
            .get(libraryDocumentId),
        ) as RevisionRow | undefined;
        if (row === undefined || row.deleted_at !== null) return false;

        const loaded = this.database.read((database) =>
          loadLibraryDocument(database, libraryDocumentId),
        );
        if (!isCanonicalDocumentBlank(loaded.document)) return false;

        this.database.transaction((database) => {
          database
            .prepare("DELETE FROM documents WHERE library_document_id = ? AND deleted_at IS NULL")
            .run(libraryDocumentId);
          deleteDocumentEditorState(database, libraryDocumentId);
        });
        return true;
      });
    } catch (error) {
      this.leases.set(sessionId, libraryDocumentId);
      throw error;
    }
    if (deleted) await this.collectUnusedAssets(libraryDocumentId);
  }

  #isLeased(libraryDocumentId: string): boolean {
    for (const leasedDocumentId of this.leases.values()) {
      if (leasedDocumentId === libraryDocumentId) return true;
    }
    return false;
  }

  #recordEditForSnapshots(ack: LibraryEditAck): LibraryEditAck {
    this.snapshots?.recordEdit(ack.libraryDocumentId);
    return ack;
  }

  #enqueueWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.writeTail.catch(() => undefined).then(operation);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
