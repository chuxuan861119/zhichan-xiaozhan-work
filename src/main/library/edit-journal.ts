import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalDocument } from "../../shared/document/model.js";
import { validateCanonicalDocument } from "../../shared/document/validation.js";
import { type JsonObject, JsonObjectSchema } from "../../shared/ipc/primitives.js";
import type { AppErrorCode } from "../../shared/ipc/result.js";
import {
  applyCanonicalOperations,
  type LibraryEditBatch,
  LibraryEditBatchSchema,
} from "../../shared/library/edit-operations.js";
import type { LibraryEditAck } from "../../shared/library/model.js";
import { retainCurrentPatentAssets } from "../../shared/patent/asset-references.js";
import { migrateCanonicalPatent } from "../../shared/patent/migrations.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { patentDocumentSnapshot } from "../../shared/patent/snapshot-scope.js";
import type { LibraryDatabase } from "./library-database.js";
import { decodeJson, encodeJson, type PlaintextEnvelope } from "./plaintext-codec.js";

const MAX_SNIPPET_LENGTH = 500;

export class LibraryServiceError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LibraryServiceError";
  }
}

type DocumentRow = {
  library_document_id: string;
  revision: number;
  deleted_at: string | null;
};

type SnapshotRow = {
  revision: number;
  model_version: number;
  payload: Uint8Array;
  content_hash: string;
};

type EditLogRow = {
  operation_id: string;
  base_revision: number;
  target_revision: number;
  payload: Uint8Array;
  content_hash: string;
  created_at: string;
};

type ExistingOperationRow = {
  library_document_id: string;
  base_revision: number;
  target_revision: number;
  content_hash: string;
  created_at: string;
};

export type LoadedLibraryDocument = {
  document: CanonicalDocument;
  revision: number;
};

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function encodeEnvelope(envelope: PlaintextEnvelope): Buffer {
  return Buffer.from(envelope);
}

export function decodeEnvelope(value: Uint8Array): PlaintextEnvelope {
  return Uint8Array.from(value);
}

export function readDocumentEditorState(database: DatabaseSync, documentId: string): JsonObject {
  const row = database
    .prepare("SELECT value FROM library_state WHERE key = ?")
    .get(`document-editor-state:${documentId}`) as { value: Uint8Array } | undefined;
  if (!row) return {};
  const parsed = JsonObjectSchema.safeParse(decodeJson(decodeEnvelope(row.value)));
  if (!parsed.success)
    throw new LibraryServiceError("CORRUPT_FILE", "Document editor state is invalid.");
  return parsed.data;
}

export function writeDocumentEditorState(
  database: DatabaseSync,
  documentId: string,
  editorState: JsonObject,
  updatedAt: string,
): void {
  database
    .prepare(`INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)`)
    .run(`document-editor-state:${documentId}`, encodeEnvelope(encodeJson(editorState)), updatedAt);
}

export function deleteDocumentEditorState(database: DatabaseSync, documentId: string): void {
  database
    .prepare("DELETE FROM library_state WHERE key = ?")
    .run(`document-editor-state:${documentId}`);
}

function validateDocument(document: CanonicalDocument): CanonicalDocument {
  const result = validateCanonicalDocument(document);
  if (!result.ok) throw new LibraryServiceError("CORRUPT_FILE", result.error.message);
  return result.value;
}

function validatePatent(patent: unknown): CanonicalPatent {
  const result = migrateCanonicalPatent(patent);
  if (!result.ok) throw new LibraryServiceError("CORRUPT_FILE", result.error.message);
  return result.value;
}

function textFromInlineNodes(
  nodes: CanonicalDocument["content"][number] extends infer Block
    ? Block extends { content: infer Content }
      ? Content
      : never
    : never,
): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((node) => {
      if (node && typeof node === "object" && "type" in node) {
        if (node.type === "text" && "text" in node && typeof node.text === "string") {
          return node.text;
        }
        if (node.type === "inline-formula" && "source" in node && typeof node.source === "string") {
          return node.source;
        }
      }
      return "";
    })
    .join("");
}

function collectBlockText(block: CanonicalDocument["content"][number]): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return textFromInlineNodes(block.content);
    case "bullet-list":
    case "ordered-list":
      return block.items.map((item) => item.content.map(collectBlockText).join(" ")).join(" ");
    case "table":
      return block.rows
        .map((row) =>
          row.cells
            .map((cell) => cell.content.map(collectBlockText).join(" "))
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
    case "figure":
      return "";
    case "block-formula":
      return block.source;
    case "chemical-structure":
      return "[化学结构]";
    case "page-break":
      return "";
  }
}

function documentSnippet(document: CanonicalDocument): string {
  return document.content
    .map(collectBlockText)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SNIPPET_LENGTH);
}

export function documentMetadata(document: CanonicalDocument): { title: Buffer; snippet: Buffer } {
  return {
    title: encodeEnvelope(encodeJson(document.title)),
    snippet: encodeEnvelope(encodeJson(documentSnippet(document))),
  };
}

export function decodeDocumentTitle(value: Uint8Array): string {
  return decodeJson<string>(decodeEnvelope(value));
}

export function decodeDocumentSnippet(value: Uint8Array): string {
  return decodeJson<string>(decodeEnvelope(value));
}

export function encodeSnapshot(
  document: CanonicalDocument,
  _modelVersion = 1,
): { payload: Buffer; contentHash: string } {
  const validated = validateDocument(document);
  return {
    payload: encodeEnvelope(encodeJson(validated)),
    contentHash: hashJson(validated),
  };
}

export function decodeSnapshotDocument(snapshot: SnapshotRow): CanonicalDocument {
  const document = validateDocument(
    decodeJson<CanonicalDocument>(decodeEnvelope(snapshot.payload)),
  );
  if (hashJson(document) !== snapshot.content_hash) {
    throw new LibraryServiceError("CORRUPT_FILE", "Snapshot hash mismatch.");
  }
  return document;
}

export function encodePatentSnapshot(
  patent: CanonicalPatent,
  _modelVersion = 2,
): { payload: Buffer; contentHash: string } {
  const validated = retainCurrentPatentAssets(validatePatent(patent));
  return {
    payload: encodeEnvelope(encodeJson(validated)),
    contentHash: hashJson(validated),
  };
}

export function decodeSnapshotPatent(snapshot: SnapshotRow): CanonicalPatent {
  const decoded = decodeJson<unknown>(decodeEnvelope(snapshot.payload));
  if (hashJson(decoded) !== snapshot.content_hash) {
    throw new LibraryServiceError("CORRUPT_FILE", "Patent snapshot hash mismatch.");
  }
  return validatePatent(decoded);
}

type PatentRecoverySnapshotPayload = {
  formatVersion: 1 | 2 | 3;
  patent: CanonicalPatent;
};

export function encodePatentRecoverySnapshot(patent: CanonicalPatent): {
  payload: Buffer;
  contentHash: string;
} {
  const value: PatentRecoverySnapshotPayload = {
    formatVersion: 1,
    patent: retainCurrentPatentAssets(validatePatent(patent)),
  };
  return { payload: encodeEnvelope(encodeJson(value)), contentHash: hashJson(value) };
}

export function decodePatentRecoverySnapshot(snapshot: SnapshotRow): { patent: CanonicalPatent } {
  if (snapshot.model_version !== 3) return { patent: decodeSnapshotPatent(snapshot) };
  const decoded = decodeJson<PatentRecoverySnapshotPayload>(decodeEnvelope(snapshot.payload));
  if (hashJson(decoded) !== snapshot.content_hash || ![1, 2, 3].includes(decoded.formatVersion)) {
    throw new LibraryServiceError("CORRUPT_FILE", "Patent recovery snapshot hash mismatch.");
  }
  return { patent: validatePatent(decoded.patent) };
}

export function encodePatentDocumentSnapshot(patent: CanonicalPatent): {
  payload: Buffer;
  contentHash: string;
} {
  // Version 3 also excludes flowcharts; older readers must not interpret omission as deletion.
  const value: PatentRecoverySnapshotPayload = {
    formatVersion: 3,
    patent: patentDocumentSnapshot(validatePatent(patent)),
  };
  return { payload: encodeEnvelope(encodeJson(value)), contentHash: hashJson(value) };
}

function documentRow(
  database: DatabaseSync,
  libraryDocumentId: string,
  allowDeleted = false,
): DocumentRow {
  const row = database
    .prepare(
      "SELECT library_document_id, revision, deleted_at FROM documents WHERE library_document_id = ?",
    )
    .get(libraryDocumentId) as DocumentRow | undefined;
  if (row === undefined || (!allowDeleted && row.deleted_at !== null)) {
    throw new LibraryServiceError("NOT_FOUND", "Document not found.");
  }
  return row;
}

export type DocumentHistoryTables = {
  snapshots: "snapshots" | "document_snapshots";
  editLog: "edit_log" | "document_edit_log";
};

export function documentHistoryTables(database: DatabaseSync): DocumentHistoryTables {
  const current = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_snapshots'")
    .get();
  return current === undefined
    ? { snapshots: "snapshots", editLog: "edit_log" }
    : { snapshots: "document_snapshots", editLog: "document_edit_log" };
}

export function loadLibraryDocument(
  database: DatabaseSync,
  libraryDocumentId: string,
): LoadedLibraryDocument {
  return loadLibraryDocumentHistory(database, libraryDocumentId, false);
}

export function loadLibraryDocumentForValidation(
  database: DatabaseSync,
  libraryDocumentId: string,
): LoadedLibraryDocument {
  return loadLibraryDocumentHistory(database, libraryDocumentId, true);
}

function loadLibraryDocumentHistory(
  database: DatabaseSync,
  libraryDocumentId: string,
  allowDeleted: boolean,
): LoadedLibraryDocument {
  const row = documentRow(database, libraryDocumentId, allowDeleted);
  const history = documentHistoryTables(database);
  const snapshot = database
    .prepare(
      `SELECT revision, model_version, payload, content_hash
       FROM ${history.snapshots}
       WHERE library_document_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
    )
    .get(libraryDocumentId) as SnapshotRow | undefined;
  if (snapshot === undefined) throw new LibraryServiceError("CORRUPT_FILE", "Snapshot missing.");

  let document = decodeSnapshotDocument(snapshot);

  let currentRevision = snapshot.revision;
  const edits = database
    .prepare(
      `SELECT operation_id, base_revision, target_revision, payload, content_hash, created_at
       FROM ${history.editLog}
       WHERE library_document_id = ? AND target_revision > ?
       ORDER BY target_revision`,
    )
    .all(libraryDocumentId, snapshot.revision) as EditLogRow[];

  for (const edit of edits) {
    if (edit.base_revision !== currentRevision || edit.target_revision !== currentRevision + 1) {
      throw new LibraryServiceError("CORRUPT_FILE", "Edit log revision chain is broken.");
    }
    const batch = LibraryEditBatchSchema.parse(
      decodeJson<LibraryEditBatch>(decodeEnvelope(edit.payload)),
    );
    if (
      batch.libraryDocumentId !== libraryDocumentId ||
      batch.operationId !== edit.operation_id ||
      batch.baseRevision !== edit.base_revision ||
      batch.targetRevision !== edit.target_revision ||
      hashJson(batch) !== edit.content_hash
    ) {
      throw new LibraryServiceError("CORRUPT_FILE", "Edit log hash mismatch.");
    }
    document = applyCanonicalOperations(document, batch.operations);
    document.modifiedAt = edit.created_at;
    document = validateDocument(document);
    currentRevision = edit.target_revision;
  }

  if (currentRevision !== row.revision) {
    throw new LibraryServiceError("CORRUPT_FILE", "Stored revision does not match edit log.");
  }

  return { document, revision: currentRevision };
}

export class EditJournal {
  private readonly history: DocumentHistoryTables;

  constructor(
    private readonly database: LibraryDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.history = this.database.read(documentHistoryTables);
  }

  async append(
    batchInput: LibraryEditBatch,
    inTransaction?: (database: DatabaseSync, ack: LibraryEditAck) => void,
  ): Promise<LibraryEditAck> {
    const batch = LibraryEditBatchSchema.parse(batchInput);
    const contentHash = hashJson(batch);
    return this.database.transaction((database) => {
      const existing = database
        .prepare(
          `SELECT library_document_id, base_revision, target_revision, content_hash, created_at
           FROM ${this.history.editLog}
           WHERE operation_id = ?`,
        )
        .get(batch.operationId) as ExistingOperationRow | undefined;
      if (existing !== undefined) {
        if (
          existing.library_document_id === batch.libraryDocumentId &&
          existing.base_revision === batch.baseRevision &&
          existing.target_revision === batch.targetRevision &&
          existing.content_hash === contentHash
        ) {
          return {
            libraryDocumentId: batch.libraryDocumentId,
            operationId: batch.operationId,
            revision: batch.targetRevision,
            savedAt: existing.created_at,
          };
        }
        throw new LibraryServiceError("INVALID_INPUT", "Operation id already has different data.");
      }

      const row = documentRow(database, batch.libraryDocumentId);
      if (row.revision !== batch.baseRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }

      let nextDocument = applyCanonicalOperations(
        loadLibraryDocument(database, batch.libraryDocumentId).document,
        batch.operations,
      );
      const savedAt = this.now().toISOString();
      nextDocument.modifiedAt = savedAt;
      nextDocument = validateDocument(nextDocument);
      const metadata = documentMetadata(nextDocument);
      const payload = encodeEnvelope(encodeJson(batch));

      database
        .prepare(
          `INSERT INTO ${this.history.editLog}(
             operation_id,
             library_document_id,
             base_revision,
             target_revision,
             model_version,
             payload,
             content_hash,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batch.operationId,
          batch.libraryDocumentId,
          batch.baseRevision,
          batch.targetRevision,
          batch.modelVersion,
          payload,
          contentHash,
          savedAt,
        );
      database
        .prepare(
          `UPDATE documents
           SET title = ?,
               snippet = ?,
               revision = ?,
               modified_at = ?
           WHERE library_document_id = ?`,
        )
        .run(
          metadata.title,
          metadata.snippet,
          batch.targetRevision,
          savedAt,
          batch.libraryDocumentId,
        );

      const ack: LibraryEditAck = {
        libraryDocumentId: batch.libraryDocumentId,
        operationId: batch.operationId,
        revision: batch.targetRevision,
        savedAt,
      };
      writeDocumentEditorState(database, batch.libraryDocumentId, batch.editorState, savedAt);
      inTransaction?.(database, ack);
      return ack;
    });
  }
}
