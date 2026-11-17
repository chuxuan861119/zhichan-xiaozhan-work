import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  AssetDescriptorSchema,
  type ImageRotation,
  type PatentBookDocument,
  PatentBookDocumentSchema,
} from "../../shared/document/model.js";
import { DrawingProjectsSchema } from "../../shared/drawing-markup/model.js";
import {
  PatentDescriptionEditorStateSchema,
  type PatentRecoveryResult,
} from "../../shared/ipc/contract.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import { normalizeDrawingBooks } from "../../shared/patent/drawing-content.js";
import { migratePatentBookDocument } from "../../shared/patent/migrations.js";
import {
  AuxiliaryDocumentSchema,
  type CanonicalPatent,
  CanonicalPatentSchema,
  DocxImportReportSchema,
  PatentBookKindSchema,
  PatentFigureSchema,
  type PatentType,
  PatentTypeSchema,
} from "../../shared/patent/model.js";
import {
  PatentReferenceMarkSchema,
  PatentReferenceMarkSettingsSchema,
} from "../../shared/patent/reference-marks.js";
import { preserveCurrentGraphicWorkspaces } from "../../shared/patent/snapshot-scope.js";
import {
  loadFlowchartFigureLink,
  loadFlowchartProjects,
} from "../flowcharts/flowchart-persistence.js";
import {
  decodeEnvelope,
  decodePatentRecoverySnapshot,
  encodeEnvelope,
  hashJson,
  LibraryServiceError,
} from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { readLiveGraphicWorkspaces } from "./live-graphic-workspaces.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";

export type RecoveryReport = {
  mode: "read-write" | "read-only";
  recoveredPatentIds: string[];
  quarantinedPatentIds: string[];
  replayedEditCount: number;
  backupPath: string | null;
  historyCleanupPendingPatentIds?: string[];
  assetIsolationPending?: boolean;
  /** Internal failure cause; excluded from the renderer-facing recovery summary. */
  assetIsolationFailure?: unknown;
};

export type RecoveredPatent = {
  baseSnapshotRevision: number;
  patent: CanonicalPatent;
  replayedEditCount: number;
  repairedPersistedState: boolean;
  clearedQuarantine: boolean;
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

type PatentRow = {
  patent_id: string;
  revision: number;
  recovery_state: "healthy" | "quarantined";
};

type PersistedPatentRow = {
  patent_id: string;
  name: string | null;
  customer: string | null;
  patent_type: PatentType;
  drawing_books_enabled: number;
  revision: number;
  created_at: string;
  modified_at: string;
};

type PersistedBookRow = {
  book_id: string;
  kind: z.infer<typeof PatentBookKindSchema>;
  revision: number;
  document_json: Uint8Array;
  editor_state_json: Uint8Array;
};

type PersistedFigureRow = {
  figure_id: string;
  asset_id: string;
  width_mm: number;
  flowchart_link: Uint8Array | null;
};

type PersistedAuxiliaryDocumentRow = {
  auxiliary_document_id: string;
  title: string;
  revision: number;
  document_json: Uint8Array;
  editor_state_json: Uint8Array;
  source_file_name: string | null;
};

type RecoverableAssetStore = {
  reconcile(): Promise<{ quarantinedAssetIds: string[] }>;
  references(scope: { kind: "patent" }, assetIds: readonly string[]): string[];
};

type RecoverySafetyBackup = {
  create(): Promise<{ directory: string }>;
};

const PatentSettingsEditPayloadSchema = z
  .object({
    type: z.literal("settings"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(500).nullable(),
    customer: z.string().trim().max(200).nullable().optional(),
    patentType: PatentTypeSchema,
    assets: z.array(AssetDescriptorSchema).max(100_000).optional(),
    referenceMarks: z.array(PatentReferenceMarkSchema).max(100_000).optional(),
    referenceMarkSettings: PatentReferenceMarkSettingsSchema.optional(),
    bookEdits: z
      .array(
        z
          .object({
            bookKind: PatentBookKindSchema,
            document: PatentBookDocumentSchema,
            editorState: JsonObjectSchema,
          })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict();

const PatentBookEditPayloadSchema = z
  .object({
    type: z.literal("book-edit"),
    patentId: z.string().uuid(),
    bookKind: PatentBookKindSchema,
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    document: PatentBookDocumentSchema,
    editorState: JsonObjectSchema,
    assets: z.array(AssetDescriptorSchema).max(100_000).optional(),
  })
  .strict();

const PatentAuxiliaryDocumentsPayloadSchema = z
  .object({
    type: z.literal("auxiliary-documents"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    auxiliaryDocuments: z.array(AuxiliaryDocumentSchema).max(10_000),
    assets: z.array(AssetDescriptorSchema).max(100_000),
    docxImportReport: DocxImportReportSchema.nullable().optional(),
  })
  .strict();

const PatentFigureEditPayloadSchema = z
  .object({
    type: z.literal("figure-edit"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    figures: z.array(PatentFigureSchema).max(100_000),
    abstractDrawingFigureId: z.string().uuid().nullable(),
    assets: z.array(AssetDescriptorSchema).max(100_000),
    drawingProjects: DrawingProjectsSchema.optional(),
    descriptionEdit: z
      .object({
        document: PatentBookDocumentSchema,
        editorState: PatentDescriptionEditorStateSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const PatentDrawingBooksEnabledPayloadSchema = z
  .object({
    type: z.literal("drawing-books-enabled"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    patentType: PatentTypeSchema,
    assetIdsForPostCommitGarbageCollection: z.array(z.string().uuid()).max(100_000),
    patent: CanonicalPatentSchema,
  })
  .strict();

const PatentFlowchartEditPayloadSchema = z
  .object({
    type: z.literal("flowchart-edit"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    patent: CanonicalPatentSchema,
  })
  .strict();

const PatentAutomationChangePayloadSchema = z
  .object({
    type: z.literal("automation-change"),
    patentId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    patent: CanonicalPatentSchema,
  })
  .strict();

export const PatentEditPayloadSchema = z.discriminatedUnion("type", [
  PatentAutomationChangePayloadSchema,
  PatentSettingsEditPayloadSchema,
  PatentBookEditPayloadSchema,
  PatentAuxiliaryDocumentsPayloadSchema,
  PatentFigureEditPayloadSchema,
  PatentDrawingBooksEnabledPayloadSchema,

  PatentFlowchartEditPayloadSchema,
]);
export type PatentEditPayload = z.infer<typeof PatentEditPayloadSchema>;

export function parsePatentEditPayload(input: unknown): PatentEditPayload {
  if (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "scientific-chart-edit"
  ) {
    const { scientificChartArchive: _retiredArchive, ...record } = input as Record<string, unknown>;
    input = { ...record, type: "flowchart-edit" };
  }
  return PatentEditPayloadSchema.parse(migratePatentEditPayloadDocuments(input));
}

/**
 * Replay failures that mean "the recorded history can no longer be verified" rather than
 * "content is damaged". In every one of them the live rows still hold the full content, so
 * rebuilding the recovery anchor from those rows is lossless.
 *
 * They carry their own error code so that the quarantine diagnosis shown to the user — and the
 * suggested next action — describes a broken chain instead of claiming the file is corrupt.
 * The messages are matched as well: the same replay failure also surfaces from the shared
 * journal replay code, and the diagnosis, not the wording, is what makes a repair safe.
 */
const UNVERIFIABLE_HISTORY_CODE = "RECOVERY_CHAIN_BROKEN";

const UNVERIFIABLE_HISTORY_MESSAGE = {
  noValidSnapshot: "No valid snapshot.",
  brokenChain: "Edit log revision chain is broken.",
  unreachableTarget: "Could not recover target revision.",
} as const;

const UNVERIFIABLE_HISTORY_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(UNVERIFIABLE_HISTORY_MESSAGE),
);

function unverifiableHistoryError(message: string): LibraryServiceError {
  return new LibraryServiceError(UNVERIFIABLE_HISTORY_CODE, message);
}

function isUnverifiableHistoryError(error: unknown): boolean {
  if (!(error instanceof LibraryServiceError)) return false;
  return (
    error.code === UNVERIFIABLE_HISTORY_CODE || UNVERIFIABLE_HISTORY_MESSAGES.has(error.message)
  );
}

function asLibraryServiceError(error: unknown): LibraryServiceError {
  return error instanceof LibraryServiceError
    ? error
    : new LibraryServiceError("CORRUPT_FILE", "Patent recovery failed.");
}

export class LibraryRecoveryService {
  integrityCheck: () => { ok: true } | { ok: false; messages: string[] };

  constructor(
    private readonly options: {
      database: LibraryDatabase;
      now?: () => Date;
      assetStore?: RecoverableAssetStore;
      safetyBackup?: RecoverySafetyBackup;
      rebuildRecoveryAnchor?: (patentId: string) => Promise<{ revision: number }>;
    },
  ) {
    this.integrityCheck = () => this.options.database.integrityCheck();
  }

  async open(): Promise<RecoveryReport> {
    const integrity = this.integrityCheck();
    if (!integrity.ok) {
      return {
        mode: "read-only",
        recoveredPatentIds: [],
        quarantinedPatentIds: [],
        replayedEditCount: 0,
        backupPath: null,
      };
    }

    const patentRows = this.options.database.read((database) =>
      database
        .prepare("SELECT patent_id, recovery_state FROM patents ORDER BY patent_id")
        .all()
        .map((row) => row as { patent_id: string; recovery_state: string }),
    );
    const existingQuarantinedPatentIds = patentRows
      .filter((row) => row.recovery_state === "quarantined")
      .map((row) => row.patent_id);
    let backupPath: string | null = null;
    if (existingQuarantinedPatentIds.length > 0) {
      try {
        const backup = await this.options.safetyBackup?.create();
        if (backup === undefined) {
          throw new LibraryServiceError("CORRUPT_FILE", "Safety backup is not configured.");
        }
        backupPath = backup.directory;
      } catch {
        return {
          mode: "read-only",
          recoveredPatentIds: [],
          quarantinedPatentIds: existingQuarantinedPatentIds,
          replayedEditCount: 0,
          backupPath: null,
        };
      }
    }
    const patentIds = patentRows.map((row) => row.patent_id);
    const recoveredPatentIds: string[] = [];
    const quarantinedPatentIds: string[] = [];
    const replayedByPatent = new Map<string, number>();
    let replayedEditCount = 0;
    for (const patentId of patentIds) {
      try {
        const recovered = await this.recoverPatent(patentId);
        if (
          recovered.replayedEditCount > 0 ||
          recovered.repairedPersistedState ||
          recovered.clearedQuarantine
        ) {
          recoveredPatentIds.push(patentId);
          replayedByPatent.set(patentId, recovered.replayedEditCount);
          replayedEditCount += recovered.replayedEditCount;
        }
      } catch (error) {
        quarantinedPatentIds.push(patentId);
        this.#quarantine(patentId, error);
      }
    }
    const assetReport = await this.options.assetStore?.reconcile();
    if (assetReport && assetReport.quarantinedAssetIds.length > 0) {
      for (const patentId of this.options.assetStore?.references(
        { kind: "patent" },
        assetReport.quarantinedAssetIds,
      ) ?? []) {
        if (!quarantinedPatentIds.includes(patentId)) {
          quarantinedPatentIds.push(patentId);
          this.#quarantine(
            patentId,
            new LibraryServiceError("CORRUPT_FILE", "Referenced asset is corrupt."),
          );
        }
        const recoveredIndex = recoveredPatentIds.indexOf(patentId);
        if (recoveredIndex >= 0) {
          recoveredPatentIds.splice(recoveredIndex, 1);
          replayedEditCount -= replayedByPatent.get(patentId) ?? 0;
          replayedByPatent.delete(patentId);
        }
      }
    }
    return {
      mode: "read-write",
      recoveredPatentIds,
      quarantinedPatentIds,
      replayedEditCount,
      backupPath,
    };
  }

  async recoverPatent(patentId: string): Promise<RecoveredPatent> {
    const recovered = this.options.database.read((database) =>
      this.#recoverPatentInDatabase(database, patentId),
    );
    const repairedPersistedState = this.#persistRecoveredPatent(recovered.patent);
    const replayedEditCount = repairedPersistedState
      ? recovered.patent.revision - recovered.baseSnapshotRevision
      : 0;
    this.#clearQuarantine(patentId);
    return {
      ...recovered,
      replayedEditCount,
      repairedPersistedState,
      clearedQuarantine: recovered.clearedQuarantine,
    };
  }

  /**
   * Repairs a quarantined patent. Replaying the edit journal from the newest usable
   * snapshot is always tried first.
   *
   * When that fails because the journal itself can no longer be verified — the shape the
   * snapshot retention policy used to create by trimming the journal out of reach — the
   * history carries no information any more, while the live rows still hold the full
   * content. A fresh recovery anchor is then rebuilt from those live rows and replay is
   * retried, so the patent becomes verifiable again without losing anything.
   *
   * A safety backup is taken before anything is written: a repair is never allowed to be
   * the only copy of the data. Failures that point at real content damage (an unreadable
   * snapshot, a corrupt row, a missing resource) are never repaired over; the patent stays
   * quarantined and the original diagnosis is reported.
   */
  async retryPatent(patentId: string): Promise<PatentRecoveryResult> {
    if (!this.options.safetyBackup) {
      throw new LibraryServiceError("CORRUPT_FILE", "Safety backup is not configured.");
    }
    await this.options.safetyBackup.create();
    let replayError: unknown;
    try {
      await this.recoverPatent(patentId);
      return { patentId, backupCreated: true };
    } catch (error) {
      replayError = error;
    }
    if (!isUnverifiableHistoryError(replayError)) {
      this.#quarantine(patentId, replayError);
      throw asLibraryServiceError(replayError);
    }
    const anchorOutcome = await this.#rebuildRecoveryAnchor(patentId);
    if (anchorOutcome === "unavailable") {
      this.#quarantine(patentId, replayError);
      throw asLibraryServiceError(replayError);
    }
    let repairError: unknown = replayError;
    if (anchorOutcome === "rebuilt") {
      try {
        await this.recoverPatent(patentId);
        return { patentId, backupCreated: true };
      } catch (error) {
        repairError = error;
      }
    }
    const failure = new LibraryServiceError(
      "RECOVERY_REPAIR_FAILED",
      repairError instanceof Error ? repairError.message : "Patent recovery failed.",
    );
    this.#quarantine(patentId, failure);
    throw failure;
  }

  /**
   * Rebuilds the recovery anchor from the live content. Reports `unavailable` when no anchor
   * builder is wired in, and `failed` when the anchor cannot be written — in particular when
   * the live rows are unreadable themselves.
   */
  async #rebuildRecoveryAnchor(patentId: string): Promise<"rebuilt" | "unavailable" | "failed"> {
    const rebuild = this.options.rebuildRecoveryAnchor;
    if (rebuild === undefined) return "unavailable";
    try {
      await rebuild(patentId);
      return "rebuilt";
    } catch {
      return "failed";
    }
  }

  #recoverPatentInDatabase(database: DatabaseSync, patentId: string): RecoveredPatent {
    const patent = database
      .prepare("SELECT patent_id, revision, recovery_state FROM patents WHERE patent_id = ?")
      .get(patentId) as PatentRow | undefined;
    if (patent === undefined) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");

    const snapshots = database
      .prepare(
        `SELECT revision, model_version, payload, content_hash
         FROM snapshots
         WHERE patent_id = ?
         ORDER BY revision DESC`,
      )
      .all(patentId) as SnapshotRow[];

    let lastError: unknown = unverifiableHistoryError(UNVERIFIABLE_HISTORY_MESSAGE.noValidSnapshot);
    for (const snapshot of snapshots) {
      try {
        const recovered = recoverPatentFromSnapshot(database, patentId, patent.revision, snapshot);
        return {
          baseSnapshotRevision: snapshot.revision,
          patent: recovered.patent,

          replayedEditCount: 0,
          repairedPersistedState: false,
          clearedQuarantine: patent.recovery_state === "quarantined",
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  #persistRecoveredPatent(input: CanonicalPatent): boolean {
    const patent = CanonicalPatentSchema.parse(input);
    // Persisted figure rows materialize the optional zero rotation. Match that
    // representation before comparing or verifying a recovered CLI/legacy state.
    patent.figures = patent.figures.map((figure) => ({
      ...figure,
      rotationDeg: figure.rotationDeg ?? 0,
    }));
    // Older bundle snapshots kept insertion order. SQL presents projects by latest
    // modification, then ID; this ordering difference does not change their contents.
    patent.flowchartProjects.sort((left, right) => {
      if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt > right.modifiedAt ? -1 : 1;
      return left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0;
    });
    try {
      const current = this.options.database.read((database) =>
        this.#loadPersistedPatent(database, patent),
      );
      if (isDeepStrictEqual(current, patent)) return false;
    } catch {
      // Rebuild invalid live rows from the verified snapshot and edit journal below.
    }
    this.options.database.transaction((database) => {
      const updated = database
        .prepare(
          `UPDATE patents
           SET name = ?,
               customer = ?,
               patent_type = ?,
               drawing_books_enabled = ?,
               revision = ?,
               created_at = ?,
               modified_at = ?
           WHERE patent_id = ?`,
        )
        .run(
          patent.name,
          patent.customer,
          patent.patentType,
          patent.drawingBooksEnabled ? 1 : 0,
          patent.revision,
          patent.createdAt,
          patent.modifiedAt,
          patent.patentId,
        );
      if (updated.changes !== 1) {
        throw new LibraryServiceError("NOT_FOUND", "Patent not found during recovery.");
      }

      database.prepare("DELETE FROM patent_books WHERE patent_id = ?").run(patent.patentId);
      const insertBook = database.prepare(
        `INSERT INTO patent_books(
           patent_id, book_id, kind, revision, document_json, editor_state_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const book of patent.books) {
        insertBook.run(
          patent.patentId,
          book.bookId,
          book.kind,
          book.persistedRevision,
          encodeEnvelope(encodeJson(book.document)),
          encodeEnvelope(encodeJson(book.editorState)),
        );
      }

      database
        .prepare("DELETE FROM patent_auxiliary_documents WHERE patent_id = ?")
        .run(patent.patentId);
      const insertAuxiliary = database.prepare(
        `INSERT INTO patent_auxiliary_documents(
           patent_id, auxiliary_document_id, position, title, revision,
           document_json, editor_state_json, source_file_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      patent.auxiliaryDocuments.forEach((document, position) => {
        insertAuxiliary.run(
          patent.patentId,
          document.auxiliaryDocumentId,
          position,
          document.title,
          document.persistedRevision,
          encodeEnvelope(encodeJson(document.document)),
          encodeEnvelope(encodeJson(document.editorState)),
          document.sourceFileName,
        );
      });
      if (patent.docxImportReport === null) {
        database
          .prepare("DELETE FROM patent_import_reports WHERE patent_id = ?")
          .run(patent.patentId);
      } else {
        database
          .prepare(
            `INSERT OR REPLACE INTO patent_import_reports(patent_id, report_json, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(
            patent.patentId,
            encodeEnvelope(encodeJson(patent.docxImportReport)),
            patent.docxImportReport.importedAt,
          );
      }

      database.prepare("DELETE FROM patent_figures WHERE patent_id = ?").run(patent.patentId);
      const insertFigure = database.prepare(
        `INSERT INTO patent_figures(
           patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
         ) VALUES (?, ?, ?, ?, ?, '', ?)`,
      );
      patent.figures.forEach((figure, position) => {
        insertFigure.run(
          patent.patentId,
          figure.figureId,
          figure.assetId,
          position,
          figure.widthMm,
          figure.flowchartLink ? encodeEnvelope(encodeJson(figure.flowchartLink)) : null,
        );
      });

      database.prepare("DELETE FROM patent_flowcharts WHERE patent_id = ?").run(patent.patentId);
      const findSource = database.prepare(
        `SELECT source_revision_id FROM patent_flowchart_source_revisions
         WHERE patent_id = ? AND project_id = ? AND project_revision = ? AND source_sha256 = ?`,
      );
      const insertProject = database.prepare(
        `INSERT INTO patent_flowcharts(
           patent_id, project_id, revision, metadata, current_source_revision_id,
           source_sha256, created_at, modified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const project of patent.flowchartProjects) {
        const source = findSource.get(
          patent.patentId,
          project.projectId,
          project.revision,
          project.sourceSha256,
        ) as { source_revision_id: string } | undefined;
        if (source === undefined) {
          throw new LibraryServiceError("CORRUPT_FILE", "Recovered flowchart source is missing.");
        }
        insertProject.run(
          patent.patentId,
          project.projectId,
          project.revision,
          encodeEnvelope(
            encodeJson({
              name: project.name,
              pageCount: project.pageCount,
              lastPageId: project.lastPageId,
            }),
          ),
          source.source_revision_id,
          project.sourceSha256,
          project.createdAt,
          project.modifiedAt,
        );
      }

      const insertAsset = database.prepare(
        "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
      );
      for (const asset of patent.assets) insertAsset.run(patent.patentId, asset.assetId);

      database
        .prepare("INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          `patent:${patent.patentId}:figure-state`,
          encodeEnvelope(
            encodeJson({
              assets: patent.assets,
              drawingProjects: patent.drawingProjects,
              abstractDrawingFigureId: patent.abstractDrawingFigureId,

              rotations: Object.fromEntries(
                patent.figures.map((figure) => [figure.figureId, figure.rotationDeg ?? 0] as const),
              ),
            }),
          ),
          patent.modifiedAt,
        );

      database
        .prepare("INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          `patent:${patent.patentId}:reference-mark-state`,
          encodeEnvelope(
            encodeJson({
              referenceMarks: patent.referenceMarks,
              referenceMarkSettings: patent.referenceMarkSettings,
            }),
          ),
          patent.modifiedAt,
        );
    });

    const persisted = this.options.database.read((database) =>
      this.#loadPersistedPatent(database, patent),
    );
    if (!isDeepStrictEqual(persisted, patent)) {
      throw new LibraryServiceError("CORRUPT_FILE", "Recovered patent verification failed.");
    }
    return true;
  }

  #loadPersistedPatent(database: DatabaseSync, expected: CanonicalPatent): CanonicalPatent {
    const row = database
      .prepare(
        `SELECT patent_id, name, customer, patent_type, drawing_books_enabled,
                revision, created_at, modified_at
         FROM patents WHERE patent_id = ?`,
      )
      .get(expected.patentId) as PersistedPatentRow | undefined;
    if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
    const books = database
      .prepare(
        `SELECT book_id, kind, revision, document_json, editor_state_json
         FROM patent_books
         WHERE patent_id = ?
         ORDER BY CASE kind
           WHEN 'claims' THEN 1
           WHEN 'description' THEN 2
           WHEN 'description-drawings' THEN 3
           WHEN 'abstract' THEN 4
           WHEN 'abstract-drawing' THEN 5
         END`,
      )
      .all(expected.patentId) as PersistedBookRow[];
    const figures = database
      .prepare(
        `SELECT figure_id, asset_id, width_mm, flowchart_link
         FROM patent_figures WHERE patent_id = ? ORDER BY position`,
      )
      .all(expected.patentId) as PersistedFigureRow[];
    const auxiliaryDocuments = database
      .prepare(
        `SELECT auxiliary_document_id, title, revision, document_json,
                editor_state_json, source_file_name
         FROM patent_auxiliary_documents
         WHERE patent_id = ?
         ORDER BY position`,
      )
      .all(expected.patentId) as PersistedAuxiliaryDocumentRow[];
    const importReportRow = database
      .prepare("SELECT report_json FROM patent_import_reports WHERE patent_id = ?")
      .get(expected.patentId) as { report_json: Uint8Array } | undefined;
    const figureState = this.#readStoredLibraryState<
      Pick<CanonicalPatent, "assets" | "abstractDrawingFigureId"> & {
        drawingProjects?: CanonicalPatent["drawingProjects"];
        rotations?: Record<string, ImageRotation>;
      }
    >(
      database,
      `patent:${expected.patentId}:figure-state`,
      `patent-figure-state:${expected.patentId}`,
    );
    const referenceMarkState = this.#readStoredLibraryState<
      Pick<CanonicalPatent, "referenceMarks" | "referenceMarkSettings">
    >(
      database,
      `patent:${expected.patentId}:reference-mark-state`,
      `patent-reference-mark-state:${expected.patentId}`,
    );
    const ownedAssetIds = (
      database
        .prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ? ORDER BY asset_id")
        .all(expected.patentId) as Array<{ asset_id: string }>
    ).map((owned) => owned.asset_id);
    const ownedAssetIdSet = new Set(ownedAssetIds);
    if (expected.assets.some((asset) => !ownedAssetIdSet.has(asset.assetId))) {
      throw new LibraryServiceError("CORRUPT_FILE", "Recovered patent asset ownership is invalid.");
    }

    return CanonicalPatentSchema.parse({
      formatVersion: expected.formatVersion,
      patentId: row.patent_id,
      name: row.name,
      customer: row.customer,
      patentType: row.patent_type,
      drawingBooksEnabled: row.drawing_books_enabled !== 0,
      revision: row.revision,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      activeBookKind: expected.activeBookKind,
      books: books.map((book) => ({
        bookId: book.book_id,
        kind: book.kind,
        document: migrateRecoveredBookDocument(decodeJson(decodeEnvelope(book.document_json))),
        editorState: JsonObjectSchema.parse(decodeJson(decodeEnvelope(book.editor_state_json))),
        localRevision: book.revision,
        persistedRevision: book.revision,
      })),
      auxiliaryDocuments: auxiliaryDocuments.map((document) => ({
        auxiliaryDocumentId: document.auxiliary_document_id,
        title: document.title,
        document: migrateRecoveredBookDocument(decodeJson(decodeEnvelope(document.document_json))),
        editorState: JsonObjectSchema.parse(decodeJson(decodeEnvelope(document.editor_state_json))),
        localRevision: document.revision,
        persistedRevision: document.revision,
        sourceFileName: document.source_file_name,
      })),
      docxImportReport:
        importReportRow === undefined
          ? null
          : DocxImportReportSchema.parse(decodeJson(decodeEnvelope(importReportRow.report_json))),
      figures: figures.map((figure) => ({
        figureId: figure.figure_id,
        assetId: figure.asset_id,
        widthMm: figure.width_mm,
        rotationDeg: figureState.rotations?.[figure.figure_id] ?? 0,
        ...(figure.flowchart_link
          ? {
              flowchartLink: loadFlowchartFigureLink(figure.flowchart_link),
            }
          : {}),
      })),
      flowchartProjects: loadFlowchartProjects(database, expected.patentId),
      assets: figureState.assets,
      drawingProjects: figureState.drawingProjects ?? [],
      abstractDrawingFigureId: figureState.abstractDrawingFigureId,
      referenceMarks: referenceMarkState.referenceMarks,
      referenceMarkSettings: referenceMarkState.referenceMarkSettings,
    });
  }

  #readStoredLibraryState<T>(database: DatabaseSync, key: string, _context: string): T {
    const row = database.prepare("SELECT value FROM library_state WHERE key = ?").get(key) as
      | { value: Uint8Array }
      | undefined;
    if (row === undefined) {
      throw new LibraryServiceError("CORRUPT_FILE", "Recovered patent state is missing.");
    }
    return decodeJson<T>(decodeEnvelope(row.value));
  }

  #quarantine(patentId: string, error: unknown): void {
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const diagnostic = {
      code: error instanceof LibraryServiceError ? error.code : "CORRUPT_FILE",
      message: error instanceof Error ? error.message : "Recovery failed.",
      quarantinedAt: now,
    };
    const storedDiagnostic = encodeEnvelope(encodeJson(diagnostic));
    this.options.database.transaction((database) => {
      database
        .prepare(
          `UPDATE patents
           SET recovery_state = 'quarantined',
               recovery_error_code = ?
           WHERE patent_id = ?`,
        )
        .run(diagnostic.code, patentId);
      database
        .prepare(
          `INSERT OR REPLACE INTO library_state(key, value, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(`recovery:${patentId}`, storedDiagnostic, now);
    });
  }

  #clearQuarantine(patentId: string): void {
    this.options.database.transaction((database) => {
      database
        .prepare(
          `UPDATE patents
           SET recovery_state = 'healthy',
               recovery_error_code = NULL
           WHERE patent_id = ?`,
        )
        .run(patentId);
      database.prepare("DELETE FROM library_state WHERE key = ?").run(`recovery:${patentId}`);
    });
  }
}

/** Read-only replay shared by startup recovery and snapshot deletion protection. */
export function recoverPatentFromSnapshot(
  database: DatabaseSync,
  patentId: string,
  targetRevision: number,
  snapshot: SnapshotRow,
): { patent: CanonicalPatent } {
  let patent = decodePatentRecoverySnapshot(snapshot).patent;
  let currentRevision = snapshot.revision;
  const edits = database
    .prepare(
      `SELECT operation_id, base_revision, target_revision, payload, content_hash, created_at
       FROM edit_log WHERE patent_id = ? AND target_revision > ? ORDER BY target_revision`,
    )
    .all(patentId, snapshot.revision) as EditLogRow[];
  for (const edit of edits) {
    if (edit.target_revision > targetRevision) break;
    if (edit.base_revision !== currentRevision || edit.target_revision !== currentRevision + 1) {
      throw unverifiableHistoryError(UNVERIFIABLE_HISTORY_MESSAGE.brokenChain);
    }
    const decoded = decodeJson<unknown>(decodeEnvelope(edit.payload));
    if (hashJson(decoded) !== edit.content_hash) {
      throw new LibraryServiceError("CORRUPT_FILE", "Edit log hash mismatch.");
    }
    patent = replayPatentEdit(patent, parsePatentEditPayload(decoded), edit.created_at);
    currentRevision = edit.target_revision;
  }
  if (currentRevision !== targetRevision) {
    throw unverifiableHistoryError(UNVERIFIABLE_HISTORY_MESSAGE.unreachableTarget);
  }
  return {
    patent: preserveCurrentGraphicWorkspaces(patent, readLiveGraphicWorkspaces(database, patentId)),
  };
}

function migratePatentEditPayloadDocuments(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const payload = input as Record<string, unknown>;
  const migrateDocument = (value: unknown): unknown => {
    const migrated = migratePatentBookDocument(value);
    if (!migrated.ok) throw new LibraryServiceError("CORRUPT_FILE", migrated.error.message);
    return migrated.value;
  };
  if (payload.type === "book-edit") {
    return { ...payload, document: migrateDocument(payload.document) };
  }
  if (payload.type === "auxiliary-documents" && Array.isArray(payload.auxiliaryDocuments)) {
    return {
      ...payload,
      auxiliaryDocuments: payload.auxiliaryDocuments.map((document) =>
        typeof document === "object" && document !== null && !Array.isArray(document)
          ? {
              ...document,
              document: migrateDocument((document as Record<string, unknown>).document),
            }
          : document,
      ),
    };
  }
  if (payload.type === "settings" && Array.isArray(payload.bookEdits)) {
    return {
      ...payload,
      bookEdits: payload.bookEdits.map((edit) =>
        typeof edit === "object" && edit !== null && !Array.isArray(edit)
          ? { ...edit, document: migrateDocument((edit as Record<string, unknown>).document) }
          : edit,
      ),
    };
  }
  if (
    payload.type === "figure-edit" &&
    typeof payload.descriptionEdit === "object" &&
    payload.descriptionEdit !== null &&
    !Array.isArray(payload.descriptionEdit)
  ) {
    return {
      ...payload,
      descriptionEdit: {
        ...payload.descriptionEdit,
        document: migrateDocument((payload.descriptionEdit as Record<string, unknown>).document),
      },
    };
  }
  return input;
}

function migrateRecoveredBookDocument(input: unknown): PatentBookDocument {
  const migrated = migratePatentBookDocument(input);
  if (!migrated.ok) throw new LibraryServiceError("CORRUPT_FILE", migrated.error.message);
  return migrated.value;
}

export function replayPatentEdit(
  patent: CanonicalPatent,
  payload: PatentEditPayload,
  savedAt: string,
): CanonicalPatent {
  if (payload.patentId !== patent.patentId || payload.baseRevision !== patent.revision) {
    throw new LibraryServiceError("CORRUPT_FILE", "Edit log does not match patent revision.");
  }

  if (payload.type === "settings") {
    const editsByKind = new Map(
      (payload.bookEdits ?? []).map((edit) => [edit.bookKind, edit] as const),
    );
    return CanonicalPatentSchema.parse({
      ...patent,
      name: payload.name,
      customer: payload.customer === undefined ? patent.customer : payload.customer,
      patentType: payload.patentType,
      revision: payload.targetRevision,
      modifiedAt: savedAt,
      assets: payload.assets ?? patent.assets,
      referenceMarks: payload.referenceMarks ?? patent.referenceMarks,
      referenceMarkSettings: payload.referenceMarkSettings ?? patent.referenceMarkSettings,
      books: patent.books.map((book) => {
        const edit = editsByKind.get(book.kind);
        return edit
          ? {
              ...book,
              document: edit.document,
              editorState: edit.editorState,
              localRevision: payload.targetRevision,
              persistedRevision: payload.targetRevision,
            }
          : book;
      }),
    });
  }

  if (payload.type === "book-edit") {
    return CanonicalPatentSchema.parse({
      ...patent,
      revision: payload.targetRevision,
      modifiedAt: savedAt,
      books: patent.books.map((book) =>
        book.kind === payload.bookKind
          ? {
              ...book,
              document: payload.document,
              editorState: payload.editorState,
              localRevision: payload.targetRevision,
              persistedRevision: payload.targetRevision,
            }
          : book,
      ),
      assets: payload.assets ?? patent.assets,
    });
  }

  if (payload.type === "auxiliary-documents") {
    return CanonicalPatentSchema.parse({
      ...patent,
      revision: payload.targetRevision,
      modifiedAt: savedAt,
      auxiliaryDocuments: payload.auxiliaryDocuments,
      assets: payload.assets,
      docxImportReport:
        payload.docxImportReport === undefined ? patent.docxImportReport : payload.docxImportReport,
    });
  }

  if (payload.type === "drawing-books-enabled") {
    return CanonicalPatentSchema.parse({
      ...payload.patent,
      revision: payload.targetRevision,
      modifiedAt: savedAt,
    });
  }

  if (payload.type === "flowchart-edit" || payload.type === "automation-change") {
    return CanonicalPatentSchema.parse({
      ...payload.patent,
      revision: payload.targetRevision,
      modifiedAt: savedAt,
    });
  }

  const descriptionEdit = payload.descriptionEdit;
  const normalizedBooks = normalizeDrawingBooks(patent);
  const books = descriptionEdit
    ? normalizedBooks.map((book) =>
        book.kind === "description"
          ? {
              ...book,
              document: descriptionEdit.document,
              editorState: descriptionEdit.editorState,
              localRevision: payload.targetRevision,
              persistedRevision: payload.targetRevision,
            }
          : book,
      )
    : normalizedBooks;

  // A document-only anchor has no editable projects. Replay the image even when
  // its historical link has no project here; matching live links are added after replay.
  const projectIds = new Set(patent.flowchartProjects.map((project) => project.projectId));
  const figures = payload.figures.map(({ flowchartLink, ...figure }) =>
    flowchartLink && projectIds.has(flowchartLink.projectId)
      ? { ...figure, flowchartLink }
      : figure,
  );

  return CanonicalPatentSchema.parse({
    ...patent,
    revision: payload.targetRevision,
    modifiedAt: savedAt,
    books,
    figures,
    abstractDrawingFigureId: payload.abstractDrawingFigureId,
    assets: payload.assets,
    drawingProjects: payload.drawingProjects ?? patent.drawingProjects,
  });
}
