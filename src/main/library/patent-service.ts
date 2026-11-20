import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { remapAssetIds } from "../../shared/document/asset-references.js";
import type {
  AssetDescriptor,
  ImageRotation,
  PatentBookDocument,
} from "../../shared/document/model.js";
import { canonicalToTiptap } from "../../shared/document/model-adapter.js";
import { validatePatentBookDocument } from "../../shared/document/validation.js";
import {
  applyDrawingProjectEdits,
  type DrawingProjectEdits,
} from "../../shared/drawing-markup/project-edits.js";
import {
  FlowchartFigureLinkSchema,
  FlowchartProjectDescriptorSchema,
  FlowchartProjectMetadataSchema,
} from "../../shared/flowcharts/model.js";
import type {
  ImportedAsset,
  PatentResourceInspectionCancel,
  PatentResourceInspectionRequest,
} from "../../shared/ipc/contract.js";
import type { JsonObject } from "../../shared/ipc/primitives.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import type { LibrarySaveState, PatentBookStatus } from "../../shared/library/model.js";
import { canPermanentlyDeletePatent } from "../../shared/library/trash-protection.js";
import { TRASH_RETENTION_MS } from "../../shared/library/trash-retention.js";
import { retainCurrentPatentAssets } from "../../shared/patent/asset-references.js";
import {
  moveAuxiliaryDocument,
  uniqueAuxiliaryTitle,
} from "../../shared/patent/auxiliary-management.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import {
  type DesignPatent,
  DesignPatentSchema,
} from "../../shared/patent/design-patent.js";
import {
  planDisableDrawingBooks,
  planEnableDrawingBooks,
} from "../../shared/patent/drawing-books.js";
import { normalizeDrawingBooks } from "../../shared/patent/drawing-content.js";
import {
  deriveReferenceMarksFromDescription,
  migratePatentBookDocument,
} from "../../shared/patent/migrations.js";
import {
  type AuxiliaryDocument,
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  CanonicalPatentSchema,
  DocxImportReportSchema,
  DRAWING_BOOK_KINDS,
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
  type PatentFigure,
  type PatentType,
  parsePatentWithVerifiedBooks,
} from "../../shared/patent/model.js";
import { documentText } from "../../shared/patent/reference-mark-text.js";
import {
  patentDocumentSnapshot,
  preserveCurrentGraphicWorkspaces,
} from "../../shared/patent/snapshot-scope.js";
import type { PatentTemplateSettings } from "../../shared/patent/templates.js";
import { createPatentTerminologyBookEdits } from "../../shared/patent/terminology.js";
import { inspectPatent } from "../../shared/patent/validation.js";
import type { AssetOwner, StoredAsset } from "../assets/asset-store.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { portablePatdocPayload } from "../documents/patdoc-transfer-scope.js";
import { loadFlowchartProjects } from "../flowcharts/flowchart-persistence.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import {
  decodeEnvelope,
  encodeEnvelope,
  encodePatentDocumentSnapshot,
  LibraryServiceError,
} from "./edit-journal.js";
import { inspectResourceFiles } from "./inspection-resources.js";
import type { LibraryDatabase } from "./library-database.js";
import { installPatdocHistory } from "./patdoc-history-install.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";

const MAX_LIBRARY_SUMMARY_CACHE_ENTRIES = 2048;

export type LibraryPatentSummary = {
  patentId: string;
  name: string | null;
  customer: string | null;
  patentType: PatentType;
  revision: number;
  bookStatuses: Record<PatentBookKind, PatentBookStatus>;
  issueCount: number;
  saveState: LibrarySaveState;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
  recoveryState: "healthy" | "quarantined";
  recoveryErrorCode: string | null;
  abstractText: string;
  drawingPreviewAssetId: string | null;
};

export type OpenedPatent = {
  patentId: string;
  sessionId: string;
  revision: number;
  patent: CanonicalPatent;
  saveState: LibrarySaveState;
};

export type PatentEditAck = {
  patentId: string;
  revision: number;
  savedAt: string;
};

export type PatentAggregateEditResult = {
  patent: CanonicalPatent;
  savedAt: string;
  assetIdsForPostCommitGarbageCollection: string[];
  notice: string | null;
};

export type PatentServiceOptions = {
  database: LibraryDatabase;
  assetStore?: {
    readAsset(
      assetId: string,
    ): Promise<{ descriptor: AssetDescriptor; original?: Uint8Array; preview?: Uint8Array }>;
    stageMany?(
      sessionId: string,
      assets: StoredAsset[],
      operationId?: string,
    ): Promise<ImportedAsset[]>;
    commitStaged?(sessionId: string, assetIds: readonly string[]): Promise<void>;
    discardStaged?(sessionId: string, assetIds: readonly string[]): Promise<void>;
    assertIndependentOwner?(owner: AssetOwner, assetId: string): void;
    readVerifiedDescriptor?(assetId: string): Promise<AssetDescriptor>;
    preview?(assetId: string): Promise<Uint8Array>;
    retainPatentHistoryAssets?(patentId: string): void;
    releasePatentHistoryAssets?(patentId: string): void;
  };
  adoptAsset?: (owner: AssetOwner, assetId: string) => Promise<void>;
  collectUnusedAssets?: (patentId: string) => Promise<void> | void;
  deleteWithHistory?: (patentId: string, commit: () => void) => void;
  preparePermanentDelete?: (patentId: string) => Promise<() => void>;
  now?: () => Date;
  randomUUID?: () => string;
  inspectPatent?: (patent: CanonicalPatent) => Readonly<{ issues: readonly unknown[] }>;
};

export type PatentLifecycleContext = {
  expectedRevision?: number;
  expectedDeletedAt?: string;
  beforeCommit?: () => void;
  inTransaction?: (database: DatabaseSync) => void;
};

function verifyLifecycleState(
  row: { revision: number; deleted_at: string | null },
  context: PatentLifecycleContext,
) {
  if (
    (context.expectedRevision !== undefined && context.expectedRevision !== row.revision) ||
    (context.expectedDeletedAt !== undefined && context.expectedDeletedAt !== row.deleted_at)
  )
    throw new LibraryServiceError("REVISION_CONFLICT", "Patent lifecycle state changed.");
  context.beforeCommit?.();
}

type PatentRow = {
  patent_id: string;
  name: string | null;
  customer: string | null;
  patent_type: PatentType;
  drawing_books_enabled: number;
  revision: number;
  created_at: string;
  modified_at: string;
  deleted_at: string | null;
  recovery_state: "healthy" | "quarantined";
  recovery_error_code: string | null;
};

type PatentBookRow = {
  book_id: string;
  kind: PatentBookKind;
  revision: number;
  document_json: Uint8Array;
  editor_state_json: Uint8Array;
};

type PatentAuxiliaryDocumentRow = {
  auxiliary_document_id: string;
  title: string;
  revision: number;
  document_json: Uint8Array;
  editor_state_json: Uint8Array;
  source_file_name: string | null;
};

type PatentFigureRow = {
  figure_id: string;
  asset_id: string;
  width_mm: number;
  flowchart_link: Uint8Array | null;
};

type FlowchartProjectRow = {
  project_id: string;
  revision: number;
  metadata: Uint8Array;
  source_sha256: string;
  created_at: string;
  modified_at: string;
};

type PatentFigureState = {
  drawingProjects?: CanonicalPatent["drawingProjects"] | undefined;
  assets: AssetDescriptor[];
  abstractDrawingFigureId: string | null;

  rotations?: Record<string, ImageRotation>;
};

const UNAVAILABLE_BOOK_STATUSES: Record<PatentBookKind, PatentBookStatus> = {
  claims: "unavailable",
  description: "unavailable",
  "description-drawings": "unavailable",
  abstract: "unavailable",
  "abstract-drawing": "unavailable",
};

function unavailablePatentSummary(row: PatentRow): LibraryPatentSummary {
  return {
    patentId: row.patent_id,
    name: row.name,
    customer: row.customer,
    patentType: row.patent_type,
    revision: row.revision,
    bookStatuses: { ...UNAVAILABLE_BOOK_STATUSES },
    issueCount: 1,
    saveState: "saved",
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    deletedAt: row.deleted_at,
    recoveryState: "quarantined",
    recoveryErrorCode: row.recovery_error_code ?? "CORRUPT_FILE",
    abstractText: "",
    drawingPreviewAssetId: null,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function storedJson(_context: string, value: unknown): Buffer {
  return encodeEnvelope(encodeJson(value));
}

function parsedJson<T>(_context: string, value: Uint8Array): T {
  return decodeJson<T>(decodeEnvelope(value));
}

function sameAssetDescriptor(left: AssetDescriptor, right: AssetDescriptor): boolean {
  return (
    left.assetId === right.assetId &&
    left.kind === right.kind &&
    left.originalName === right.originalName &&
    left.mediaType === right.mediaType &&
    left.extension === right.extension &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.widthPx === right.widthPx &&
    left.heightPx === right.heightPx &&
    left.previewByteLength === right.previewByteLength &&
    left.previewSha256 === right.previewSha256
  );
}

function patentAbstractText(patent: CanonicalPatent): string {
  const abstractBook = patent.books.find((book) => book.kind === "abstract");
  return abstractBook ? documentText(abstractBook.document).trim() : "";
}

function preferredLibraryDrawingAssetId(patent: CanonicalPatent): string | null {
  const preferredFigure =
    patent.figures.find((figure) => figure.figureId === patent.abstractDrawingFigureId) ??
    patent.figures[0];
  return preferredFigure?.assetId ?? null;
}

export class PatentService {
  private readonly database: LibraryDatabase;
  private readonly assetStore: PatentServiceOptions["assetStore"];
  private readonly adoptAsset: PatentServiceOptions["adoptAsset"];
  private readonly collectUnusedAssets: (patentId: string) => Promise<void> | void;
  private readonly deleteWithHistory: (patentId: string, commit: () => void) => void;
  private readonly preparePermanentDelete: PatentServiceOptions["preparePermanentDelete"];
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly inspectPatent: NonNullable<PatentServiceOptions["inspectPatent"]>;
  private readonly summaryCache = new Map<
    string,
    Readonly<{ fingerprint: string; summary: LibraryPatentSummary }>
  >();
  private readonly leases = new Map<string, string>();
  private writeTail: Promise<unknown> = Promise.resolve();
  #listSnapshot:
    | {
        token: string;
        scope: "active" | "trash";
        summaries: LibraryPatentSummary[];
        dirty?: Set<string>;
      }
    | undefined;
  #patentSnapshot:
    | {
        token: string;
        patentId: string;
        patent: CanonicalPatent;
        books: PatentBookRow[];
        auxiliary: PatentAuxiliaryDocumentRow[];
      }
    | undefined;

  constructor(options: PatentServiceOptions) {
    this.database = options.database;
    this.assetStore = options.assetStore;
    this.adoptAsset = options.adoptAsset;
    this.collectUnusedAssets = options.collectUnusedAssets ?? (() => undefined);
    this.deleteWithHistory = options.deleteWithHistory ?? ((_patentId, commit) => commit());
    this.preparePermanentDelete = options.preparePermanentDelete;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => randomUUID());
    this.inspectPatent = options.inspectPatent ?? inspectPatent;
  }

  create(options: {
    patentType: PatentType;
    name: string | null;
    customer?: string | null | undefined;
    templates: PatentTemplateSettings;
    templateAssetIds?: readonly string[];
    beforeCommit?: (() => void) | undefined;
    inTransaction?: ((database: DatabaseSync, patent: CanonicalPatent) => void) | undefined;
  }): Promise<OpenedPatent> {
    return this.#enqueueWrite(async () => {
      const { templateAssetIds = [], beforeCommit, inTransaction, ...createOptions } = options;
      const templateSources = await Promise.all(
        [...new Set(templateAssetIds)].map(async (assetId) => {
          if (!this.assetStore) {
            throw new LibraryServiceError("NOT_FOUND", "Template asset store is unavailable.");
          }
          return await this.assetStore.readAsset(assetId);
        }),
      );
      const patent = createBlankPatent(createOptions, {
        now: this.now,
        createId: this.randomUUID,
      });
      const createdAt = patent.createdAt;
      const sessionId = this.randomUUID();
      let templateAssets: ImportedAsset[] = [];
      if (templateSources.length) {
        if (!this.assetStore?.stageMany)
          throw new LibraryServiceError("INTERNAL", "Template resource copying is unavailable.");
        templateAssets = await this.assetStore.stageMany(
          sessionId,
          templateSources.map((source) => {
            if (!source.original || !source.preview)
              throw new LibraryServiceError("CORRUPT_FILE", "Template resource bytes are missing.");
            return {
              descriptor: { ...source.descriptor, assetId: this.randomUUID() },
              original: source.original,
              preview: source.preview,
            };
          }),
        );
      }
      const stagedIds = templateAssets.map((asset) => asset.descriptor.assetId);
      try {
        patent.assets = templateAssets.map((asset) => asset.descriptor);
        const replacements = new Map(
          templateSources.map((source, index) => [
            source.descriptor.assetId,
            templateAssets[index]!.descriptor.assetId,
          ]),
        );
        const validated = parseCurrentPatent(remapAssetIds(patent, replacements));

        this.database.transaction((database) => {
          beforeCommit?.();
          database
            .prepare(
              `INSERT INTO patents(
              patent_id,
              name,
              customer,
              patent_type,
              drawing_books_enabled,
              revision,
              created_at,
              modified_at,
              deleted_at,
              recovery_state,
              recovery_error_code
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 'healthy', NULL)`,
            )
            .run(
              validated.patentId,
              validated.name,
              validated.customer,
              validated.patentType,
              validated.drawingBooksEnabled ? 1 : 0,
              createdAt,
              createdAt,
            );
          const insertBook = database.prepare(
            `INSERT INTO patent_books(
            patent_id,
            book_id,
            kind,
            revision,
            document_json,
            editor_state_json
          ) VALUES (?, ?, ?, 0, ?, ?)`,
          );
          for (const book of validated.books) {
            insertBook.run(
              validated.patentId,
              book.bookId,
              book.kind,
              storedJson(`book:${validated.patentId}:${book.kind}:0`, book.document),
              storedJson(`book-editor:${validated.patentId}:${book.kind}:0`, {}),
            );
          }
          const insertAsset = database.prepare(
            "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
          );
          for (const asset of validated.assets) insertAsset.run(validated.patentId, asset.assetId);
          this.#saveFigureState(database, validated.patentId, createdAt, {
            assets: validated.assets,
            abstractDrawingFigureId: validated.abstractDrawingFigureId,
            rotations: rotationsByFigure(validated.figures),
          });
          this.#saveReferenceMarkState(database, validated.patentId, createdAt, {
            referenceMarks: validated.referenceMarks,
            referenceMarkSettings: validated.referenceMarkSettings,
          });
          this.#saveDesignPatentState(
            database,
            validated.patentId,
            createdAt,
            validated.designPatent,
          );
          if (validated.patentType !== "design") {
            const snapshotPayload = storedJson(
              `patent-snapshot:${validated.patentId}:0:2`,
              validated,
            );
            database
              .prepare(
                `INSERT INTO snapshots(
              patent_id,
              revision,
              model_version,
              payload,
              content_hash,
              created_at,
              source
            ) VALUES (?, 0, 2, ?, ?, ?, 'initial')`,
              )
              .run(validated.patentId, snapshotPayload, hashJson(validated), createdAt);
            for (const asset of validated.assets)
              database
                .prepare(
                  "INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, 0, ?)",
                )
                .run(validated.patentId, asset.assetId);
          }
          inTransaction?.(database, structuredClone(validated));
        });

        await this.assetStore?.commitStaged?.(sessionId, stagedIds);
        this.leases.set(sessionId, validated.patentId);
        return {
          patentId: validated.patentId,
          sessionId,
          revision: validated.revision,
          patent: validated,
          saveState: "saved" as const,
        };
      } catch (error) {
        await this.assetStore?.discardStaged?.(sessionId, stagedIds);
        throw error;
      }
    });
  }

  createImported(
    input: { patent: CanonicalPatent; operationId: string },
    context?: {
      beforeCommit(): void;
      inTransaction(database: DatabaseSync, patent: CanonicalPatent): void;
    },
  ): Promise<OpenedPatent> {
    return this.#enqueueWrite(() => {
      context?.beforeCommit();
      const operationKey = `docx-import-operation:${input.operationId}`;
      const completedOperation = this.database.read((database) =>
        database.prepare("SELECT value FROM library_state WHERE key = ?").get(operationKey),
      ) as { value: Uint8Array } | undefined;
      if (completedOperation) {
        const patentId = parsedJson<string>(operationKey, completedOperation.value);
        const patent = this.#loadPatent(patentId);
        const sessionId = this.randomUUID();
        this.leases.set(sessionId, patentId);
        return {
          patentId,
          sessionId,
          revision: patent.revision,
          patent,
          saveState: "saved" as const,
        };
      }

      const validated = parseCurrentPatent(structuredClone(input.patent));
      if (validated.revision !== 0) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Imported patent must start at revision zero.",
        );
      }
      const sessionId = this.randomUUID();
      this.database.transaction((database) => {
        this.#insertImported(database, validated, operationKey);
        context?.inTransaction(database, validated);
      });
      this.leases.set(sessionId, validated.patentId);
      return {
        patentId: validated.patentId,
        sessionId,
        revision: 0,
        patent: validated,
        saveState: "saved" as const,
      };
    });
  }

  restorePatdocHistory(
    patentId: string,
    snapshots: NonNullable<PatentPatdocPayload["snapshots"]>,
  ): Promise<number> {
    return this.#enqueueWrite(() => {
      const current = this.#loadPatent(patentId);
      return this.database.transaction((database) => {
        const next = installPatdocHistory(this.database, database, current, snapshots);
        for (const figure of next.figures) {
          database
            .prepare(
              "UPDATE patent_figures SET flowchart_link = ? WHERE patent_id = ? AND figure_id = ?",
            )
            .run(
              figure.flowchartLink
                ? storedJson(
                    `flowchart-figure-link:${patentId}:${figure.figureId}`,
                    figure.flowchartLink,
                  )
                : null,
              patentId,
              figure.figureId,
            );
        }
        this.summaryCache.delete(patentId);
        return next.revision;
      });
    });
  }

  #insertImported(database: DatabaseSync, validated: CanonicalPatent, operationKey: string): void {
    database
      .prepare(
        `INSERT INTO patents(
          patent_id, name, customer, patent_type, drawing_books_enabled, revision,
          created_at, modified_at, deleted_at, recovery_state, recovery_error_code
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 'healthy', NULL)`,
      )
      .run(
        validated.patentId,
        validated.name,
        validated.customer,
        validated.patentType,
        validated.drawingBooksEnabled ? 1 : 0,
        validated.createdAt,
        validated.modifiedAt,
      );
    const insertBook = database.prepare(
      `INSERT INTO patent_books(
        patent_id, book_id, kind, revision, document_json, editor_state_json
      ) VALUES (?, ?, ?, 0, ?, ?)`,
    );
    for (const book of validated.books) {
      insertBook.run(
        validated.patentId,
        book.bookId,
        book.kind,
        storedJson(`book:${validated.patentId}:${book.kind}:0`, book.document),
        storedJson(`book-editor:${validated.patentId}:${book.kind}:0`, book.editorState),
      );
    }
    this.#replaceAuxiliaryDocuments(database, validated.patentId, validated.auxiliaryDocuments);
    this.#saveImportReport(database, validated.patentId, validated.docxImportReport);
    const insertAsset = database.prepare(
      "INSERT INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
    );
    for (const asset of validated.assets) insertAsset.run(validated.patentId, asset.assetId);
    const insertFigure = database.prepare(
      `INSERT INTO patent_figures(
         patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    validated.figures.forEach((figure, index) => {
      insertFigure.run(
        validated.patentId,
        figure.figureId,
        figure.assetId,
        index,
        figure.widthMm,
        "",
        figure.flowchartLink
          ? storedJson(
              `flowchart-figure-link:${validated.patentId}:${figure.figureId}`,
              figure.flowchartLink,
            )
          : null,
      );
    });
    this.#saveFigureState(database, validated.patentId, validated.modifiedAt, {
      assets: validated.assets,
      drawingProjects: validated.drawingProjects,
      abstractDrawingFigureId: validated.abstractDrawingFigureId,
      rotations: rotationsByFigure(validated.figures),
    });
    this.#saveReferenceMarkState(database, validated.patentId, validated.modifiedAt, {
      referenceMarks: validated.referenceMarks,
      referenceMarkSettings: validated.referenceMarkSettings,
    });
    this.#saveDesignPatentState(
      database,
      validated.patentId,
      validated.modifiedAt,
      validated.designPatent,
    );
    if (validated.patentType !== "design") {
      const snapshot = encodePatentDocumentSnapshot(validated);
      database
        .prepare(
          `INSERT INTO snapshots(
          patent_id, revision, model_version, payload, content_hash, created_at, source
        ) VALUES (?, 0, 3, ?, ?, ?, 'initial')`,
        )
        .run(validated.patentId, snapshot.payload, snapshot.contentHash, validated.createdAt);
      for (const asset of patentDocumentSnapshot(validated).assets)
        database
          .prepare("INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, 0, ?)")
          .run(validated.patentId, asset.assetId);
    }
    database
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run(operationKey, storedJson(operationKey, validated.patentId), validated.createdAt);
  }

  hasImportedBundle(bundleId: string): boolean {
    return !!this.database.read((database) =>
      database
        .prepare("SELECT 1 FROM library_state WHERE key = ?")
        .get(`patent-bundle:${bundleId}`),
    );
  }

  importBundle(input: {
    bundleId: string;
    patents: PatentPatdocPayload[];
    allowDuplicate?: boolean;
    allowAttachments?: boolean;
    beforeCommit?: () => void;
    inTransaction?: (database: DatabaseSync, patents: CanonicalPatent[]) => void;
  }): Promise<number> {
    return this.#enqueueWrite(() => {
      if (!input.patents.length || input.patents.length > 100)
        throw new LibraryServiceError("INVALID_INPUT", "压缩包专利数量无效。");
      if (this.hasImportedBundle(input.bundleId) && !input.allowDuplicate)
        throw new LibraryServiceError("INVALID_INPUT", "此压缩包已导入，请确认后再试。");
      const store = new FlowchartSourceStore({ database: this.database });
      input.beforeCommit?.();
      return this.database.transaction((database) => {
        for (const inputPayload of input.patents) {
          const payload = portablePatdocPayload(inputPayload);
          const patent = CanonicalPatentSchema.parse(payload.patent);
          if (
            patent.revision !== 0 ||
            (!input.allowAttachments && patent.auxiliaryDocuments.length)
          )
            throw new LibraryServiceError("INVALID_INPUT", "还原数据范围无效。");
          this.#insertImported(database, patent, `bundle-item:${patent.patentId}`);
          for (const project of patent.flowchartProjects) {
            const source = payload.flowcharts?.find(
              (item) => item.projectId === project.projectId,
            )?.source;
            if (!source) throw new LibraryServiceError("INVALID_INPUT", "缺少流程图原稿。");
            const saved = store.appendRevisionInTransaction(database, {
              patentId: patent.patentId,
              projectId: project.projectId,
              expectedProjectRevision: 0,
              source,
              metadata: {
                name: project.name,
                pageCount: project.pageCount,
                lastPageId: project.lastPageId,
              },
            });
            project.revision = saved.revision;
            project.createdAt = saved.createdAt;
            project.modifiedAt = saved.modifiedAt;
            for (const figure of patent.figures) {
              if (figure.flowchartLink?.projectId !== project.projectId) continue;
              figure.flowchartLink.exportedProjectRevision = saved.revision;
              database
                .prepare(
                  "UPDATE patent_figures SET flowchart_link = ? WHERE patent_id = ? AND figure_id = ?",
                )
                .run(
                  storedJson(
                    `flowchart-figure-link:${patent.patentId}:${figure.figureId}`,
                    figure.flowchartLink,
                  ),
                  patent.patentId,
                  figure.figureId,
                );
            }
          }
          // Source installation assigns timestamps; snapshot the same order used on reopen.
          patent.flowchartProjects = loadFlowchartProjects(database, patent.patentId);
          const snapshot = encodePatentDocumentSnapshot(patent);
          database
            .prepare(
              "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = 0",
            )
            .run(snapshot.payload, snapshot.contentHash, patent.patentId);
        }
        database
          .prepare("INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
          .run(
            `patent-bundle:${input.bundleId}`,
            storedJson(`patent-bundle:${input.bundleId}`, true),
            this.now().toISOString(),
          );
        input.inTransaction?.(
          database,
          input.patents.map((payload) => this.#loadPatent(payload.patent.patentId)),
        );
        return input.patents.length;
      });
    });
  }

  async list(scope: "active" | "trash"): Promise<LibraryPatentSummary[]> {
    const token = this.database.changeToken();
    const snapshot =
      this.#listSnapshot?.token === token && this.#listSnapshot.scope === scope
        ? this.#listSnapshot
        : undefined;
    if (snapshot && !snapshot.dirty?.size) return structuredClone(snapshot.summaries);
    const unchanged = new Map(snapshot?.summaries.map((summary) => [summary.patentId, summary]));
    const additions: Array<
      [string, Readonly<{ fingerprint: string; summary: LibraryPatentSummary }>]
    > = [];
    const rows = this.database.read((database) =>
      database
        .prepare(
          `SELECT patent_id,
                  name,
                  customer,
                  patent_type,
                  drawing_books_enabled,
                  revision,
                  created_at,
                  modified_at,
                  deleted_at,
                  recovery_state,
                  recovery_error_code
           FROM patents
           WHERE ${scope === "active" ? "deleted_at IS NULL" : "deleted_at IS NOT NULL"}
           ORDER BY modified_at DESC`,
        )
        .all(),
    ) as PatentRow[];

    const summaries = rows.map((row) => {
      const previous = unchanged.get(row.patent_id);
      if (previous && !snapshot?.dirty?.has(row.patent_id)) return structuredClone(previous);
      if (row.recovery_state === "quarantined") return unavailablePatentSummary(row);
      try {
        let verifiedBookRows: PatentBookRow[] | undefined;
        const fingerprint = this.#summaryFingerprint(row, (books) => {
          verifiedBookRows = books;
        });
        const cached = this.summaryCache.get(row.patent_id);
        if (fingerprint !== null && cached?.fingerprint === fingerprint) {
          return structuredClone(cached.summary);
        }
        const patent = this.#loadPatent(row.patent_id, {
          allowTrash: scope === "trash",
          cache: false,
          row,
          ...(verifiedBookRows ? { books: verifiedBookRows } : {}),
        });
        const summary: LibraryPatentSummary = {
          patentId: row.patent_id,
          name: row.name,
          customer: row.customer,
          patentType: row.patent_type,
          revision: row.revision,
          bookStatuses: Object.fromEntries(
            patent.books.map((book) => [
              book.kind,
              !patent.drawingBooksEnabled &&
              DRAWING_BOOK_KINDS.includes(book.kind as (typeof DRAWING_BOOK_KINDS)[number])
                ? "unavailable"
                : bookStatus(book.kind, book.document.content),
            ]),
          ) as Record<PatentBookKind, PatentBookStatus>,
          issueCount: this.#inspectionIssueCount(patent),
          saveState: "saved",
          createdAt: row.created_at,
          modifiedAt: row.modified_at,
          deletedAt: row.deleted_at,
          recoveryState: row.recovery_state,
          recoveryErrorCode: row.recovery_error_code,
          abstractText: patentAbstractText(patent),
          drawingPreviewAssetId: preferredLibraryDrawingAssetId(patent),
        };
        if (fingerprint !== null) {
          additions.push([row.patent_id, { fingerprint, summary }]);
        }
        return structuredClone(summary);
      } catch {
        this.summaryCache.delete(row.patent_id);
        return unavailablePatentSummary(row);
      }
    });
    // Insert after the scan so a miss cannot evict a later, still-useful hit.
    for (const [id, entry] of additions) {
      this.summaryCache.delete(id);
      this.summaryCache.set(id, entry);
      if (this.summaryCache.size > MAX_LIBRARY_SUMMARY_CACHE_ENTRIES)
        this.summaryCache.delete(this.summaryCache.keys().next().value!);
    }
    const bytes = summaries.reduce(
      (total, item) =>
        total +
        512 +
        2 * ((item.name?.length ?? 0) + (item.customer?.length ?? 0) + item.abstractText.length),
      0,
    );
    this.#listSnapshot =
      token === this.database.changeToken() && bytes <= 8 * 1024 * 1024
        ? { token, scope, summaries: structuredClone(summaries) }
        : undefined;
    return summaries;
  }

  async getLibraryPreview(patentId: string): Promise<Uint8Array> {
    if (!this.assetStore) {
      throw new LibraryServiceError("CORRUPT_FILE", "Patent preview asset store is unavailable.");
    }
    const patent = this.#loadPatent(patentId);
    const assetId = preferredLibraryDrawingAssetId(patent);
    if (!assetId) throw new LibraryServiceError("CORRUPT_FILE", "Patent has no drawing preview.");
    const preview = this.assetStore.preview
      ? await this.assetStore.preview(assetId)
      : (await this.assetStore.readAsset(assetId)).preview;
    if (!preview)
      throw new LibraryServiceError("CORRUPT_FILE", "Patent drawing preview is missing.");
    return Uint8Array.from(preview);
  }

  async open(patentId: string): Promise<OpenedPatent> {
    const patent = this.#loadPatent(patentId);
    const sessionId = this.randomUUID();
    this.leases.set(sessionId, patentId);
    return {
      patentId,
      sessionId,
      revision: patent.revision,
      patent,
      saveState: "saved",
    };
  }

  mutateFlowcharts<T>(input: {
    beforeCommit?: (() => void) | undefined;
    inTransaction?: ((database: DatabaseSync, patent: CanonicalPatent) => void) | undefined;
    patentId: string;
    expectedRevision: number;
    mutation: (
      database: DatabaseSync,
      savedAt: string,
    ) => {
      changed: boolean;
      value: T;
      retainedSources?: Array<{ projectId: string; sourceRevisionId: string }>;
    };
  }): Promise<{ value: T; patent: CanonicalPatent; savedAt: string }> {
    return this.#enqueueWrite(() => {
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const savedAt = this.now().toISOString();
      const result = this.database.transaction((database) => {
        input.beforeCommit?.();
        const mutation = input.mutation(database, savedAt);
        if (!mutation.changed) {
          const patent = this.#loadPatent(input.patentId);
          input.inTransaction?.(database, patent);
          return { value: mutation.value, patent, savedAt };
        }
        const targetRevision = row.revision + 1;
        database
          .prepare("UPDATE patents SET revision = ?, modified_at = ? WHERE patent_id = ?")
          .run(targetRevision, savedAt, input.patentId);
        const patent = this.#loadPatent(input.patentId);
        const operationId = this.randomUUID();
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision,
          savedAt,
          payload: {
            type: "flowchart-edit",
            patentId: input.patentId,
            baseRevision: row.revision,
            targetRevision,
            patent,
          },
        });
        for (const retained of mutation.retainedSources ?? []) {
          database
            .prepare(
              "INSERT INTO edit_log_flowchart_revisions(operation_id, project_id, source_revision_id) VALUES (?, ?, ?)",
            )
            .run(operationId, retained.projectId, retained.sourceRevisionId);
        }
        input.inTransaction?.(database, patent);
        return { value: mutation.value, patent, savedAt };
      });
      this.summaryCache.delete(input.patentId);
      return result;
    });
  }

  private resourceInspections = new Map<
    string,
    { sessionId: string; controller: AbortController }
  >();

  async inspectResources(request: PatentResourceInspectionRequest) {
    const patent = this.requireActiveReadSession(request.sessionId, request.patentId);
    if (patent.revision !== request.expectedRevision)
      throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
    const assetStore = this.assetStore;
    if (!assetStore) throw new LibraryServiceError("INTERNAL", "Asset store unavailable.");
    if (this.resourceInspections.has(request.operationId))
      throw new LibraryServiceError("INVALID_INPUT", "Operation is already active.");
    const controller = new AbortController();
    this.resourceInspections.set(request.operationId, { sessionId: request.sessionId, controller });
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await inspectResourceFiles(
        patent,
        (id) => {
          if (this.leases.get(request.sessionId) !== request.patentId) controller.abort();
          controller.signal.throwIfAborted();
          return assetStore.readAsset(id);
        },
        controller.signal,
      );
      const current = this.requireActiveReadSession(request.sessionId, request.patentId);
      if (current.revision !== patent.revision)
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      return result;
    } finally {
      clearTimeout(timeout);
      this.resourceInspections.delete(request.operationId);
    }
  }

  cancelResourceInspection(request: PatentResourceInspectionCancel): void {
    const task = this.resourceInspections.get(request.operationId);
    if (task?.sessionId === request.sessionId) task.controller.abort();
  }

  requireActiveReadSession(sessionId: string, patentId: string): CanonicalPatent {
    if (this.leases.get(sessionId) !== patentId) {
      throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
    }
    return structuredClone(this.#loadPatent(patentId));
  }

  loadSavedPatent(patentId: string): CanonicalPatent {
    return structuredClone(this.#loadPatent(patentId));
  }

  captureAutomation(patentId: string): Promise<CanonicalPatent> {
    return this.#enqueueWrite(() => structuredClone(this.#loadPatent(patentId)));
  }

  /** Trusted automation commits a server-prepared candidate and its receipt together. */
  applyAutomationChange(input: {
    patentId: string;
    expectedRevision: number;
    patent: CanonicalPatent;
    restoreSnapshot?: boolean;
    allowBookPageChanges?: boolean;
    allowPatentSettingsChanges?: boolean;
    allowAuxiliaryChanges?: boolean;
    allowDrawingChanges?: boolean;
    beforeCommit?: (() => void) | undefined;
    inTransaction?: ((database: DatabaseSync, patent: CanonicalPatent) => void) | undefined;
  }): Promise<CanonicalPatent> {
    return this.#enqueueWrite(async () => {
      const original = this.#loadPatent(input.patentId);
      if (original.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const checked = CanonicalPatentSchema.parse(structuredClone(input.patent));
      const candidate = input.restoreSnapshot
        ? preserveCurrentGraphicWorkspaces(checked, original)
        : checked;
      for (const key of [
        "patentId",
        "patentType",
        "createdAt",
        "drawingBooksEnabled",
        "activeBookKind",
        "drawingProjects",
        "flowchartProjects",
        "auxiliaryDocuments",
        "docxImportReport",
        "referenceMarks",
        "referenceMarkSettings",
      ] as const) {
        if (
          (!input.restoreSnapshot || ["patentId", "createdAt"].includes(key)) &&
          !(
            input.allowPatentSettingsChanges &&
            [
              "patentType",
              "drawingBooksEnabled",
              "activeBookKind",
              "referenceMarks",
              "referenceMarkSettings",
            ].includes(key)
          ) &&
          !(input.allowAuxiliaryChanges && key === "auxiliaryDocuments") &&
          !(input.allowDrawingChanges && key === "drawingProjects") &&
          JSON.stringify(candidate[key]) !== JSON.stringify(original[key])
        ) {
          throw new LibraryServiceError("INVALID_INPUT", `Automation cannot change ${key}.`);
        }
      }
      const savedAt = this.now().toISOString();
      const revision = original.revision + 1;
      const changedKinds = new Set<PatentBookKind>();
      const books = original.books.map((book, index) => {
        const historical = candidate.books[index]!;
        const next = input.restoreSnapshot
          ? {
              ...historical,
              bookId: book.bookId,
              document: {
                ...historical.document,
                documentId: book.document.documentId,
                createdAt: book.document.createdAt,
              },
            }
          : historical;
        if (
          next.bookId !== book.bookId ||
          next.kind !== book.kind ||
          next.document.documentId !== book.document.documentId ||
          next.document.createdAt !== book.document.createdAt ||
          (!input.restoreSnapshot &&
            !input.allowBookPageChanges &&
            JSON.stringify(next.document.page) !== JSON.stringify(book.document.page))
        ) {
          throw new LibraryServiceError(
            "INVALID_INPUT",
            "Automation book identity or settings changed.",
          );
        }
        if (
          JSON.stringify(next.document.content) === JSON.stringify(book.document.content) &&
          JSON.stringify(next.document.page) === JSON.stringify(book.document.page)
        )
          return book;
        changedKinds.add(book.kind);
        return {
          ...book,
          document: { ...next.document, modifiedAt: savedAt },
          editorState: JsonObjectSchema.parse(
            canonicalToTiptap({ ...next.document, assets: candidate.assets }),
          ),
          localRevision: revision,
          persistedRevision: revision,
        };
      });
      const assets: AssetDescriptor[] = [];
      for (const requested of candidate.assets) {
        if (!this.assetStore)
          throw new LibraryServiceError("INTERNAL", "Patent asset store is unavailable.");
        const stored = await this.assetStore.readAsset(requested.assetId);
        if (!sameAssetDescriptor(requested, stored.descriptor)) {
          throw new LibraryServiceError(
            "INVALID_INPUT",
            "Patent asset descriptor does not match store.",
          );
        }
        assets.push(structuredClone(stored.descriptor));
      }
      for (const book of books) {
        const validation = validatePatentBookDocument(
          book.document,
          new Set(assets.map((asset) => asset.assetId)),
          assets,
        );
        if (!validation.ok)
          throw new LibraryServiceError("INVALID_INPUT", validation.error.message);
      }
      const auxiliaryDocuments = candidate.auxiliaryDocuments.map((auxiliary) => {
        const previous = original.auxiliaryDocuments.find(
          (entry) => entry.auxiliaryDocumentId === auxiliary.auxiliaryDocumentId,
        );
        const validation = validatePatentBookDocument(
          auxiliary.document,
          new Set(assets.map((asset) => asset.assetId)),
          assets,
        );
        if (!validation.ok)
          throw new LibraryServiceError("INVALID_INPUT", validation.error.message);
        if (previous && JSON.stringify(previous.document) === JSON.stringify(auxiliary.document))
          return previous;
        if (
          previous &&
          !input.restoreSnapshot &&
          (previous.document.documentId !== auxiliary.document.documentId ||
            previous.document.createdAt !== auxiliary.document.createdAt)
        )
          throw new LibraryServiceError("INVALID_INPUT", "Auxiliary identity changed.");
        return {
          ...auxiliary,
          document: { ...auxiliary.document, modifiedAt: savedAt },
          editorState: JsonObjectSchema.parse(canonicalToTiptap({ ...auxiliary.document, assets })),
          localRevision: revision,
          persistedRevision: revision,
        };
      });
      const validated = parseCurrentPatent({
        ...candidate,
        auxiliaryDocuments,
        books,
        assets,
        modifiedAt: savedAt,
        revision,
      });
      this.database.transaction((database) => {
        input.beforeCommit?.();
        const row = ensureActivePatent(this.#patentRow(input.patentId));
        if (row.revision !== input.expectedRevision)
          throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
        const insertAsset = database.prepare(
          "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        for (const asset of validated.assets) insertAsset.run(input.patentId, asset.assetId);
        const updateBook = database.prepare(
          "UPDATE patent_books SET revision = ?, document_json = ?, editor_state_json = ? WHERE patent_id = ? AND kind = ?",
        );
        for (const book of books.filter((book) => changedKinds.has(book.kind))) {
          updateBook.run(
            revision,
            storedJson("automation-book", book.document),
            storedJson("automation-editor", book.editorState),
            input.patentId,
            book.kind,
          );
        }
        database.prepare("DELETE FROM patent_figures WHERE patent_id = ?").run(input.patentId);
        const insertFigure = database.prepare(
          "INSERT INTO patent_figures(patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link) VALUES (?, ?, ?, ?, ?, '', ?)",
        );
        validated.figures.forEach((figure, index) => {
          insertFigure.run(
            input.patentId,
            figure.figureId,
            figure.assetId,
            index,
            figure.widthMm,
            figure.flowchartLink
              ? storedJson("automation-figure-link", figure.flowchartLink)
              : null,
          );
        });
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: validated.abstractDrawingFigureId,
          rotations: rotationsByFigure(validated.figures),
          drawingProjects: validated.drawingProjects,
        });
        database
          .prepare(
            "UPDATE patents SET name = ?, customer = ?, revision = ?, modified_at = ? WHERE patent_id = ?",
          )
          .run(
            normalizePatentName(validated.name),
            normalizeCustomerName(validated.customer),
            revision,
            savedAt,
            input.patentId,
          );
        if (input.restoreSnapshot || input.allowPatentSettingsChanges) {
          database
            .prepare(
              "UPDATE patents SET drawing_books_enabled = ?, patent_type = ? WHERE patent_id = ?",
            )
            .run(validated.drawingBooksEnabled ? 1 : 0, validated.patentType, input.patentId);
          this.#saveReferenceMarkState(database, input.patentId, savedAt, {
            referenceMarks: validated.referenceMarks,
            referenceMarkSettings: validated.referenceMarkSettings,
          });
        }
        if (input.restoreSnapshot || input.allowAuxiliaryChanges)
          this.#replaceAuxiliaryDocuments(database, input.patentId, validated.auxiliaryDocuments);
        if (input.restoreSnapshot) {
          this.#saveImportReport(database, input.patentId, validated.docxImportReport);
          const pointers = validated.flowchartProjects.map((project) => {
            const source = database
              .prepare(
                "SELECT source_revision_id FROM patent_flowchart_source_revisions WHERE patent_id = ? AND project_id = ? AND project_revision = ? AND source_sha256 = ? LIMIT 1",
              )
              .get(input.patentId, project.projectId, project.revision, project.sourceSha256) as
              | { source_revision_id: string }
              | undefined;
            if (!source)
              throw new LibraryServiceError(
                "CORRUPT_FILE",
                "Historical flowchart source is unavailable.",
              );
            return { project, source };
          });
          database.prepare("DELETE FROM patent_flowcharts WHERE patent_id = ?").run(input.patentId);
          for (const { project, source } of pointers)
            database
              .prepare(
                "INSERT INTO patent_flowcharts(patent_id,project_id,revision,metadata,current_source_revision_id,source_sha256,created_at,modified_at) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                input.patentId,
                project.projectId,
                project.revision,
                storedJson("automation-flowchart", {
                  name: project.name,
                  pageCount: project.pageCount,
                  lastPageId: project.lastPageId,
                }),
                source.source_revision_id,
                project.sourceSha256,
                project.createdAt,
                project.modifiedAt,
              );
        }
        const operationId = this.randomUUID();
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: original.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "automation-change",
            patentId: input.patentId,
            baseRevision: original.revision,
            targetRevision: revision,
            patent: validated,
          },
        });
        for (const project of validated.flowchartProjects) {
          const pointer = database
            .prepare(
              "SELECT current_source_revision_id FROM patent_flowcharts WHERE patent_id=? AND project_id=?",
            )
            .get(input.patentId, project.projectId) as { current_source_revision_id: string };
          database
            .prepare(
              "INSERT INTO edit_log_flowchart_revisions(operation_id,project_id,source_revision_id) VALUES(?,?,?)",
            )
            .run(operationId, project.projectId, pointer.current_source_revision_id);
        }
        input.inTransaction?.(database, structuredClone(validated));
      });
      this.summaryCache.delete(input.patentId);
      return structuredClone(validated);
    });
  }

  async updateSettings(input: {
    patentId: string;
    expectedRevision: number;
    name?: string | null | undefined;
    customer?: string | null | undefined;
    patentType: PatentType;
    bookEdits?:
      | Array<{
          bookKind: PatentBookKind;
          document: PatentBookDocument;
          editorState: JsonObject;
        }>
      | undefined;
    assets?: AssetDescriptor[] | undefined;
    referenceMarks?: CanonicalPatent["referenceMarks"] | undefined;
    referenceMarkSettings?: CanonicalPatent["referenceMarkSettings"] | undefined;
  }): Promise<PatentEditAck> {
    const acknowledgement = await this.#enqueueWrite(async () => {
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const operationId = this.randomUUID();
      const bookEdits = input.bookEdits ?? [];
      if (new Set(bookEdits.map((edit) => edit.bookKind)).size !== bookEdits.length) {
        throw new LibraryServiceError("INVALID_INPUT", "Patent setting book edits are duplicated.");
      }
      const currentPatent = this.#loadPatent(input.patentId);
      const name = input.name === undefined ? currentPatent.name : normalizePatentName(input.name);
      const customer =
        input.customer === undefined
          ? currentPatent.customer
          : normalizeCustomerName(input.customer);
      const restoringDrawingBooks =
        input.patentType === "utility-model" && !currentPatent.drawingBooksEnabled;
      const transitionSource = restoringDrawingBooks
        ? planEnableDrawingBooks(currentPatent, {
            now: this.now,
            createId: this.randomUUID,
          })
        : currentPatent;
      const editsByKind = new Map(bookEdits.map((edit) => [edit.bookKind, edit]));
      if ((input.referenceMarks === undefined) !== (input.referenceMarkSettings === undefined)) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Reference marks and settings must be supplied together.",
        );
      }
      const requestedAssets = structuredClone(input.assets ?? currentPatent.assets);
      if (new Set(requestedAssets.map((asset) => asset.assetId)).size !== requestedAssets.length) {
        throw new LibraryServiceError("INVALID_INPUT", "Patent setting assets are duplicated.");
      }
      const assets = await this.#authoritativeBookAssets(input.patentId, requestedAssets);
      for (const edit of bookEdits) {
        const validation = validatePatentBookDocument(
          edit.document,
          new Set(assets.map((asset) => asset.assetId)),
          assets,
        );
        if (!validation.ok) {
          throw new LibraryServiceError("INVALID_INPUT", validation.error.message);
        }
      }
      const validated = parseCurrentPatent({
        ...transitionSource,
        name,
        customer,
        patentType: input.patentType,
        revision,
        modifiedAt: savedAt,
        assets,
        referenceMarks: structuredClone(input.referenceMarks ?? transitionSource.referenceMarks),
        referenceMarkSettings: structuredClone(
          input.referenceMarkSettings ?? transitionSource.referenceMarkSettings,
        ),
        books: transitionSource.books.map((book) => {
          const edit = editsByKind.get(book.kind);
          return edit
            ? {
                ...book,
                document: structuredClone(edit.document),
                editorState: structuredClone(edit.editorState),
                localRevision: revision,
                persistedRevision: revision,
              }
            : book;
        }),
      });
      const validatedBookEdits = validated.books.filter(
        (book) =>
          editsByKind.has(book.kind) ||
          (restoringDrawingBooks &&
            DRAWING_BOOK_KINDS.includes(book.kind as (typeof DRAWING_BOOK_KINDS)[number])),
      );

      this.database.transaction((database) => {
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: restoringDrawingBooks
            ? {
                type: "drawing-books-enabled",
                patentId: input.patentId,
                baseRevision: row.revision,
                targetRevision: revision,
                enabled: true,
                patentType: validated.patentType,
                assetIdsForPostCommitGarbageCollection: [],
                patent: validated,
              }
            : {
                type: "settings",
                patentId: input.patentId,
                baseRevision: row.revision,
                targetRevision: revision,
                name: validated.name,
                customer: validated.customer,
                patentType: validated.patentType,
                assets: validated.assets,
                referenceMarks: validated.referenceMarks,
                referenceMarkSettings: validated.referenceMarkSettings,
                bookEdits: validatedBookEdits.map((book) => ({
                  bookKind: book.kind,
                  document: book.document,
                  editorState: book.editorState,
                })),
              },
        });
        database
          .prepare(
            `UPDATE patents
             SET name = ?, customer = ?, patent_type = ?, drawing_books_enabled = ?, revision = ?, modified_at = ?
             WHERE patent_id = ?`,
          )
          .run(
            validated.name,
            validated.customer,
            validated.patentType,
            validated.drawingBooksEnabled ? 1 : 0,
            revision,
            savedAt,
            input.patentId,
          );
        const updateBook = database.prepare(
          `UPDATE patent_books
           SET book_id = ?, revision = ?, document_json = ?, editor_state_json = ?
           WHERE patent_id = ? AND kind = ?`,
        );
        for (const book of validatedBookEdits) {
          updateBook.run(
            book.bookId,
            revision,
            storedJson(`book:${input.patentId}:${book.kind}:${revision}`, book.document),
            storedJson(`book-editor:${input.patentId}:${book.kind}:${revision}`, book.editorState),
            input.patentId,
            book.kind,
          );
        }
        const ownedAsset = database.prepare(
          "SELECT 1 FROM patent_assets WHERE patent_id = ? AND asset_id = ?",
        );
        for (const asset of validated.assets) {
          if (ownedAsset.get(input.patentId, asset.assetId) === undefined) {
            throw new LibraryServiceError(
              "INVALID_INPUT",
              "Patent setting asset is not owned by patent.",
            );
          }
        }
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        const insertAssetReference = database.prepare(
          "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        for (const asset of validated.assets) {
          insertAssetReference.run(input.patentId, asset.assetId);
        }
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: validated.abstractDrawingFigureId,
          rotations: rotationsByFigure(validated.figures),
        });
        this.#saveReferenceMarkState(database, input.patentId, savedAt, {
          referenceMarks: validated.referenceMarks,
          referenceMarkSettings: validated.referenceMarkSettings,
        });
      });

      return { patentId: input.patentId, revision, savedAt };
    });
    await this.#collectUnusedAssetsAfterCommit(acknowledgement.patentId);
    return acknowledgement;
  }

  async setDrawingBooksEnabled(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    enabled: boolean;
    settings?:
      | {
          name: string | null;
          customer: string | null;
          patentType: PatentType;
          terminologyReplacementRequested: boolean;
        }
      | undefined;
  }): Promise<PatentAggregateEditResult> {
    const result = await this.#enqueueWrite(() => {
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const current = this.#loadPatent(input.patentId);
      const requestedType = input.settings?.patentType ?? current.patentType;
      if (!input.enabled && requestedType === "utility-model") {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Utility-model patents must keep drawing books enabled.",
        );
      }
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const shouldRestoreForUtility =
        requestedType === "utility-model" && !current.drawingBooksEnabled;
      let transitioned = current;
      let gcAssetIds: string[] = [];
      if (input.enabled && !current.drawingBooksEnabled) {
        transitioned = planEnableDrawingBooks(current, {
          now: this.now,
          createId: this.randomUUID,
        });
      }
      const transitionSource =
        requestedType === current.patentType
          ? transitioned
          : CanonicalPatentSchema.parse({ ...transitioned, patentType: requestedType });
      if (!input.enabled && current.drawingBooksEnabled) {
        const plan = planDisableDrawingBooks(transitionSource, {
          now: this.now,
          createId: this.randomUUID,
        });
        transitioned = plan.patent;
        gcAssetIds = plan.assetIdsForPostCommitGarbageCollection;
      }
      const terminologyEdits =
        input.settings?.terminologyReplacementRequested && requestedType !== current.patentType
          ? createPatentTerminologyBookEdits(transitioned, requestedType)
          : [];
      const terminologyByKind = new Map(terminologyEdits.map((edit) => [edit.bookKind, edit]));
      const next = parseCurrentPatent({
        ...transitioned,
        name: input.settings ? normalizePatentName(input.settings.name) : transitioned.name,
        customer: input.settings
          ? normalizeCustomerName(input.settings.customer)
          : transitioned.customer,
        patentType: requestedType,
        revision,
        modifiedAt: savedAt,
        books: transitioned.books.map((book) => {
          const edit = terminologyByKind.get(book.kind);
          return {
            ...book,
            document: structuredClone(edit?.document ?? book.document),
            editorState: structuredClone(edit?.editorState ?? book.editorState),
            localRevision: revision,
            persistedRevision: revision,
          };
        }),
      });
      const operationId = this.randomUUID();

      this.database.transaction((database) => {
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "drawing-books-enabled",
            patentId: input.patentId,
            baseRevision: row.revision,
            targetRevision: revision,
            enabled: next.drawingBooksEnabled,
            patentType: next.patentType,
            assetIdsForPostCommitGarbageCollection: gcAssetIds,
            patent: next,
          },
        });
        database
          .prepare(
            `UPDATE patents
             SET name = ?, customer = ?, patent_type = ?, drawing_books_enabled = ?, revision = ?, modified_at = ?
             WHERE patent_id = ?`,
          )
          .run(
            next.name,
            next.customer,
            next.patentType,
            next.drawingBooksEnabled ? 1 : 0,
            revision,
            savedAt,
            input.patentId,
          );
        const updateBook = database.prepare(
          `UPDATE patent_books
           SET book_id = ?, revision = ?, document_json = ?, editor_state_json = ?
           WHERE patent_id = ? AND kind = ?`,
        );
        for (const book of next.books) {
          updateBook.run(
            book.bookId,
            revision,
            storedJson(`book:${input.patentId}:${book.kind}:${revision}`, book.document),
            storedJson(`book-editor:${input.patentId}:${book.kind}:${revision}`, book.editorState),
            input.patentId,
            book.kind,
          );
        }
        database.prepare("DELETE FROM patent_figures WHERE patent_id = ?").run(input.patentId);
        const insertFigure = database.prepare(
          `INSERT INTO patent_figures(
             patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        next.figures.forEach((figure, index) => {
          insertFigure.run(
            input.patentId,
            figure.figureId,
            figure.assetId,
            index,
            figure.widthMm,
            "",
            figure.flowchartLink
              ? storedJson(
                  `flowchart-figure-link:${input.patentId}:${figure.figureId}`,
                  figure.flowchartLink,
                )
              : null,
          );
        });
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        const insertAsset = database.prepare(
          "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        for (const asset of next.assets) insertAsset.run(input.patentId, asset.assetId);
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: next.assets,
          abstractDrawingFigureId: next.abstractDrawingFigureId,

          rotations: rotationsByFigure(next.figures),
        });
        this.#saveReferenceMarkState(database, input.patentId, savedAt, {
          referenceMarks: next.referenceMarks,
          referenceMarkSettings: next.referenceMarkSettings,
        });
      });

      return {
        patent: CanonicalPatentSchema.parse({
          ...structuredClone(this.#loadPatent(input.patentId)),
          activeBookKind: next.activeBookKind,
        }),
        savedAt,
        assetIdsForPostCommitGarbageCollection: gcAssetIds,
        notice: shouldRestoreForUtility ? "实用新型需要保留附图，已恢复两份空白附图文档。" : null,
      };
    });
    await this.#collectUnusedAssetsAfterCommit(result.patent.patentId);
    return result;
  }

  async applyBookEdit(input: {
    patentId: string;
    sessionId: string;
    bookKind: PatentBookKind;
    expectedRevision: number;
    document: PatentBookDocument;
    editorState: JsonObject;
    assets?: AssetDescriptor[];
  }): Promise<PatentEditAck> {
    let removedAssets = false;
    const acknowledgement = await this.#enqueueWrite(async () => {
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const operationId = this.randomUUID();
      const currentPatent = this.#loadPatent(input.patentId);
      let document = input.document;
      const requestedAssets = structuredClone(input.assets ?? currentPatent.assets);
      if (new Set(requestedAssets.map((asset) => asset.assetId)).size !== requestedAssets.length) {
        throw new LibraryServiceError("INVALID_INPUT", "Patent book assets are duplicated.");
      }
      const documentValidation = validatePatentBookDocument(
        document,
        new Set(requestedAssets.map((asset) => asset.assetId)),
        requestedAssets,
      );
      if (!documentValidation.ok) {
        throw new LibraryServiceError("INVALID_INPUT", documentValidation.error.message);
      }
      document = documentValidation.value;
      const assets = await this.#authoritativeBookAssets(input.patentId, requestedAssets);
      // Store descriptors must match every requested field; the earlier resource validation remains valid.
      const validated = retainCurrentPatentAssets(
        parsePatentWithVerifiedBooks(
          {
            ...currentPatent,
            modifiedAt: savedAt,
            revision,
            assets,
            books: currentPatent.books.map((book) =>
              book.kind === input.bookKind
                ? {
                    ...book,
                    document,
                    editorState: structuredClone(input.editorState),
                    localRevision: revision,
                    persistedRevision: revision,
                  }
                : book,
            ),
          },
          currentPatent,
          new Set([document]),
        ),
      );
      const retainedIds = new Set(validated.assets.map((asset) => asset.assetId));
      removedAssets = currentPatent.assets.some((asset) => !retainedIds.has(asset.assetId));
      const validatedBook = validated.books.find((book) => book.kind === input.bookKind);
      if (!validatedBook) {
        throw new LibraryServiceError("NOT_FOUND", "Patent book was not found.");
      }

      this.#summaryAwareTransaction(input.patentId, (database) => {
        const ownedAsset = database.prepare(
          "SELECT 1 FROM patent_assets WHERE patent_id = ? AND asset_id = ?",
        );
        for (const asset of validated.assets) {
          if (ownedAsset.get(input.patentId, asset.assetId) === undefined) {
            throw new LibraryServiceError(
              "INVALID_INPUT",
              "Patent book asset is not owned by patent.",
            );
          }
        }
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "book-edit",
            patentId: input.patentId,
            bookKind: input.bookKind,
            baseRevision: row.revision,
            targetRevision: revision,
            document: validatedBook.document,
            editorState: validatedBook.editorState,
            assets: validated.assets,
          },
        });
        database
          .prepare(
            `UPDATE patent_books
             SET revision = ?, document_json = ?, editor_state_json = ?
             WHERE patent_id = ? AND kind = ?`,
          )
          .run(
            revision,
            storedJson(
              `book:${input.patentId}:${input.bookKind}:${revision}`,
              validatedBook.document,
            ),
            storedJson(
              `book-editor:${input.patentId}:${input.bookKind}:${revision}`,
              validatedBook.editorState,
            ),
            input.patentId,
            input.bookKind,
          );
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        const insertAssetReference = database.prepare(
          "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        for (const asset of validated.assets) {
          insertAssetReference.run(input.patentId, asset.assetId);
        }
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: currentPatent.abstractDrawingFigureId,

          rotations: rotationsByFigure(currentPatent.figures),
        });
        database
          .prepare("UPDATE patents SET revision = ?, modified_at = ? WHERE patent_id = ?")
          .run(revision, savedAt, input.patentId);
      });

      this.#loadPatent(input.patentId);
      return { patentId: input.patentId, revision, savedAt };
    });
    if (removedAssets) await this.#collectUnusedAssetsAfterCommit(acknowledgement.patentId);
    return acknowledgement;
  }

  async appendImportedDocuments(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    operationId: string;
    documents: AuxiliaryDocument[];
    assets: AssetDescriptor[];
  }): Promise<OpenedPatent> {
    await this.#applyAuxiliaryDocumentsMutation(
      input,
      (patent, revision) => {
        const names = patent.auxiliaryDocuments.map((document) => document.title);
        return [
          ...patent.auxiliaryDocuments,
          ...input.documents.map((document) => {
            const title = uniqueAuxiliaryTitle(document.title, names);
            names.push(title);
            return {
              ...structuredClone(document),
              title,
              document: { ...structuredClone(document.document), title },
              localRevision: revision,
              persistedRevision: revision,
            };
          }),
        ];
      },
      (patent) => [
        ...new Map(
          [...patent.assets, ...input.assets].map((asset) => [asset.assetId, asset]),
        ).values(),
      ],
    );
    const patent = this.#loadPatent(input.patentId);
    return {
      patentId: input.patentId,
      sessionId: input.sessionId,
      revision: patent.revision,
      patent,
      saveState: "saved",
    };
  }

  async restorePatdocAttachments(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    documents: AuxiliaryDocument[];
    report: CanonicalPatent["docxImportReport"];
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(
      input,
      (_patent, revision) =>
        input.documents.map((document) => ({
          ...structuredClone(document),
          localRevision: revision,
          persistedRevision: revision,
        })),
      undefined,
      input.report,
    );
  }

  async createAuxiliaryDocument(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    document: AuxiliaryDocument;
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(input, (patent, revision) => [
      ...patent.auxiliaryDocuments,
      {
        ...structuredClone(input.document),
        localRevision: revision,
        persistedRevision: revision,
      },
    ]);
  }

  async applyAuxiliaryDocumentEdit(input: {
    patentId: string;
    sessionId: string;
    auxiliaryDocumentId: string;
    expectedRevision: number;
    document: PatentBookDocument;
    editorState: JsonObject;
    assets: AssetDescriptor[];
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(
      input,
      (patent, revision) => {
        if (
          !patent.auxiliaryDocuments.some(
            (document) => document.auxiliaryDocumentId === input.auxiliaryDocumentId,
          )
        ) {
          throw new LibraryServiceError("NOT_FOUND", "Auxiliary document was not found.");
        }
        return patent.auxiliaryDocuments.map((document) =>
          document.auxiliaryDocumentId === input.auxiliaryDocumentId
            ? {
                ...document,
                document: structuredClone(input.document),
                editorState: structuredClone(input.editorState),
                localRevision: revision,
                persistedRevision: revision,
              }
            : document,
        );
      },
      input.assets,
    );
  }

  async renameAuxiliaryDocument(input: {
    patentId: string;
    sessionId: string;
    auxiliaryDocumentId: string;
    expectedRevision: number;
    title: string;
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(input, (patent, revision) => {
      const title = input.title.trim();
      if (
        patent.auxiliaryDocuments.some(
          (document) =>
            document.auxiliaryDocumentId !== input.auxiliaryDocumentId && document.title === title,
        )
      ) {
        throw new LibraryServiceError("INVALID_INPUT", "已有同名其他文档，请使用不同的名称。");
      }
      if (title.length === 0) {
        throw new LibraryServiceError("INVALID_INPUT", "Auxiliary document title is empty.");
      }
      if (
        !patent.auxiliaryDocuments.some(
          (document) => document.auxiliaryDocumentId === input.auxiliaryDocumentId,
        )
      ) {
        throw new LibraryServiceError("NOT_FOUND", "Auxiliary document was not found.");
      }
      return patent.auxiliaryDocuments.map((document) =>
        document.auxiliaryDocumentId === input.auxiliaryDocumentId
          ? {
              ...document,
              title,
              document: { ...document.document, title, modifiedAt: this.now().toISOString() },
              localRevision: revision,
              persistedRevision: revision,
            }
          : document,
      );
    });
  }

  async moveAuxiliaryDocument(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    auxiliaryDocumentId: string;
    direction: "up" | "down";
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(input, (patent) =>
      moveAuxiliaryDocument(patent.auxiliaryDocuments, input.auxiliaryDocumentId, input.direction),
    );
  }

  async deleteAuxiliaryDocument(input: {
    patentId: string;
    sessionId: string;
    auxiliaryDocumentId: string;
    expectedRevision: number;
  }): Promise<PatentEditAck> {
    return this.#applyAuxiliaryDocumentsMutation(input, (patent) => {
      const retained = patent.auxiliaryDocuments.filter(
        (document) => document.auxiliaryDocumentId !== input.auxiliaryDocumentId,
      );
      if (retained.length === patent.auxiliaryDocuments.length) {
        throw new LibraryServiceError("NOT_FOUND", "Auxiliary document was not found.");
      }
      return retained;
    });
  }

  async #applyAuxiliaryDocumentsMutation(
    input: { patentId: string; sessionId: string; expectedRevision: number; operationId?: string },
    mutate: (patent: CanonicalPatent, revision: number) => AuxiliaryDocument[],
    requestedAssets?: readonly AssetDescriptor[] | ((patent: CanonicalPatent) => AssetDescriptor[]),
    importedReport?: CanonicalPatent["docxImportReport"],
  ): Promise<PatentEditAck> {
    const acknowledgement = await this.#enqueueWrite(async () => {
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      const operationKey = input.operationId
        ? `docx-append-operation:${input.patentId}:${input.operationId}`
        : null;
      if (operationKey) {
        const completed = this.database.read((database) =>
          database.prepare("SELECT value FROM library_state WHERE key = ?").get(operationKey),
        ) as { value: Uint8Array } | undefined;
        if (completed) return parsedJson<PatentEditAck>(operationKey, completed.value);
      }
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const current = this.#loadPatent(input.patentId);
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const assets = await this.#authoritativeBookAssets(
        input.patentId,
        structuredClone(
          typeof requestedAssets === "function"
            ? requestedAssets(current)
            : (requestedAssets ?? current.assets),
        ),
      );
      const auxiliaryDocuments = mutate(current, revision);
      const validated = parseCurrentPatent({
        ...current,
        revision,
        modifiedAt: savedAt,
        assets,
        auxiliaryDocuments,
        docxImportReport: importedReport === undefined ? current.docxImportReport : importedReport,
      });
      const operationId = this.randomUUID();
      this.database.transaction((database) => {
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "auxiliary-documents",
            patentId: input.patentId,
            baseRevision: row.revision,
            targetRevision: revision,
            auxiliaryDocuments: validated.auxiliaryDocuments,
            assets: validated.assets,
            ...(importedReport === undefined
              ? {}
              : { docxImportReport: validated.docxImportReport }),
          },
        });
        this.#replaceAuxiliaryDocuments(database, input.patentId, validated.auxiliaryDocuments);
        if (importedReport !== undefined) {
          this.#saveImportReport(database, input.patentId, validated.docxImportReport);
        }
        if (operationKey) {
          database
            .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
            .run(
              operationKey,
              storedJson(operationKey, { patentId: input.patentId, revision, savedAt }),
              savedAt,
            );
        }
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        const insertAsset = database.prepare(
          "INSERT INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        for (const asset of validated.assets) insertAsset.run(input.patentId, asset.assetId);
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: validated.abstractDrawingFigureId,
          rotations: rotationsByFigure(validated.figures),
        });
        database
          .prepare("UPDATE patents SET revision = ?, modified_at = ? WHERE patent_id = ?")
          .run(revision, savedAt, input.patentId);
      });
      this.#loadPatent(input.patentId);
      return { patentId: input.patentId, revision, savedAt };
    });
    await this.#collectUnusedAssetsAfterCommit(acknowledgement.patentId);
    return acknowledgement;
  }

  async applyFigureEdit(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    figures: PatentFigure[];
    abstractDrawingFigureId: string | null;
    assets: AssetDescriptor[];
    drawingProjects?: CanonicalPatent["drawingProjects"] | undefined;
    drawingProjectEdits?: DrawingProjectEdits | undefined;
  }): Promise<PatentEditAck> {
    const acknowledgement = await this.#enqueueWrite(() => {
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const operationId = this.randomUUID();
      const currentPatent = this.#loadPatent(input.patentId);
      if (input.drawingProjects !== undefined && input.drawingProjectEdits !== undefined)
        throw new LibraryServiceError("INVALID_INPUT", "不能同时提交完整图纸和图纸编辑。");
      const validated = parseCurrentPatent({
        ...currentPatent,
        revision,
        modifiedAt: savedAt,
        figures: structuredClone(input.figures).map((figure) => ({
          ...figure,
          rotationDeg: figure.rotationDeg ?? 0,
        })),
        books: normalizeDrawingBooks(currentPatent),
        abstractDrawingFigureId: input.abstractDrawingFigureId,
        assets: structuredClone(input.assets),
        drawingProjects: input.drawingProjectEdits
          ? applyDrawingProjectEdits(currentPatent.drawingProjects, input.drawingProjectEdits)
          : (input.drawingProjects ?? currentPatent.drawingProjects),
      });

      this.database.transaction((database) => {
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "figure-edit",
            patentId: input.patentId,
            baseRevision: row.revision,
            targetRevision: revision,
            figures: validated.figures,
            abstractDrawingFigureId: validated.abstractDrawingFigureId,
            assets: validated.assets,
            drawingProjects: validated.drawingProjects,
          },
        });
        for (const book of validated.books) {
          const previous = currentPatent.books.find((candidate) => candidate.kind === book.kind);
          if (
            JSON.stringify(book.document) === JSON.stringify(previous?.document) &&
            JSON.stringify(book.editorState) === JSON.stringify(previous?.editorState)
          )
            continue;
          database
            .prepare(
              "UPDATE patent_books SET document_json = ?, editor_state_json = ? WHERE patent_id = ? AND kind = ?",
            )
            .run(
              storedJson("drawing-book", book.document),
              storedJson("drawing-editor", book.editorState),
              input.patentId,
              book.kind,
            );
        }
        if (JSON.stringify(validated.figures) !== JSON.stringify(currentPatent.figures)) {
          database.prepare("DELETE FROM patent_figures WHERE patent_id = ?").run(input.patentId);
          const insertFigure = database.prepare(
            `INSERT INTO patent_figures(
             patent_id,
             figure_id,
             asset_id,
             position,
             width_mm,
             explanation,
             flowchart_link
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
          validated.figures.forEach((figure, index) => {
            insertFigure.run(
              input.patentId,
              figure.figureId,
              figure.assetId,
              index,
              figure.widthMm,
              "",
              figure.flowchartLink
                ? storedJson(
                    `flowchart-figure-link:${input.patentId}:${figure.figureId}`,
                    figure.flowchartLink,
                  )
                : null,
            );
          });
        }
        if (JSON.stringify(validated.assets) !== JSON.stringify(currentPatent.assets)) {
          database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
          const insertAssetReference = database.prepare(
            "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
          );
          for (const asset of validated.assets) {
            insertAssetReference.run(input.patentId, asset.assetId);
          }
        }
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: validated.abstractDrawingFigureId,
          rotations: rotationsByFigure(validated.figures),
          drawingProjects: validated.drawingProjects,
        });
        database
          .prepare("UPDATE patents SET revision = ?, modified_at = ? WHERE patent_id = ?")
          .run(revision, savedAt, input.patentId);
      });

      return { patentId: input.patentId, revision, savedAt };
    });
    await this.#collectUnusedAssetsAfterCommit(acknowledgement.patentId);
    return acknowledgement;
  }

  async updateDesignPatent(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    designPatent: DesignPatent;
    assets: AssetDescriptor[];
  }): Promise<PatentEditAck> {
    const acknowledgement = await this.#enqueueWrite(async () => {
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const currentPatent = this.#loadPatent(input.patentId);
      if (currentPatent.patentType !== "design") {
        throw new LibraryServiceError("INVALID_INPUT", "Patent is not a design patent.");
      }
      const savedAt = this.now().toISOString();
      const revision = row.revision + 1;
      const assets = await this.#authoritativeBookAssets(input.patentId, input.assets);
      const validated = CanonicalPatentSchema.parse({
        ...currentPatent,
        revision,
        modifiedAt: savedAt,
        assets,
        designPatent: structuredClone(input.designPatent),
      });
      const operationId = this.randomUUID();
      this.database.transaction((database) => {
        this.#insertEditLog(database, {
          operationId,
          patentId: input.patentId,
          baseRevision: row.revision,
          targetRevision: revision,
          savedAt,
          payload: {
            type: "design-patent-edit",
            patentId: input.patentId,
            baseRevision: row.revision,
            targetRevision: revision,
            designPatent: validated.designPatent,
            assets: validated.assets,
          },
        });
        database.prepare("DELETE FROM patent_assets WHERE patent_id = ?").run(input.patentId);
        const insertAsset = database.prepare(
          "INSERT OR IGNORE INTO patent_assets(patent_id, asset_id) VALUES (?, ?)",
        );
        for (const asset of validated.assets) insertAsset.run(input.patentId, asset.assetId);
        this.#saveFigureState(database, input.patentId, savedAt, {
          assets: validated.assets,
          abstractDrawingFigureId: null,
        });
        this.#saveDesignPatentState(database, input.patentId, savedAt, validated.designPatent);
        database
          .prepare("UPDATE patents SET revision = ?, modified_at = ? WHERE patent_id = ?")
          .run(revision, savedAt, input.patentId);
      });
      return { patentId: input.patentId, revision, savedAt };
    });
    await this.#collectUnusedAssetsAfterCommit(acknowledgement.patentId);
    return acknowledgement;
  }

  flush(
    patentId: string,
    expectedRevision: number,
  ): Promise<{
    patentId: string;
    revision: number;
    flushedAt: string;
  }> {
    return this.#enqueueWrite(async () => {
      const row = ensureActivePatent(this.#patentRow(patentId));
      if (row.revision !== expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      return { patentId, revision: row.revision, flushedAt: this.now().toISOString() };
    });
  }

  loadForExport(input: {
    patentId: string;
    sessionId: string;
    expectedRevision: number;
  }): Promise<CanonicalPatent> {
    return this.#enqueueWrite(() => {
      if (this.leases.get(input.sessionId) !== input.patentId) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent session is not active.");
      }
      const row = ensureActivePatent(this.#patentRow(input.patentId));
      if (row.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      const patent = this.#loadPatent(input.patentId);
      if (patent.revision !== input.expectedRevision) {
        throw new LibraryServiceError("REVISION_CONFLICT", "Revision conflict.");
      }
      return CanonicalPatentSchema.parse(structuredClone(patent));
    });
  }

  moveToTrash(patentId: string, context: PatentLifecycleContext = {}): Promise<void> {
    return this.#enqueueWrite(() => {
      if (this.#isLeased(patentId)) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent has an active lease.");
      }
      const deletedAt = this.now().toISOString();
      verifyLifecycleState(this.#patentRow(patentId), context);
      this.database.transaction((database) => {
        ensureActivePatent(this.#patentRow(patentId));
        database
          .prepare("UPDATE patents SET deleted_at = ?, modified_at = ? WHERE patent_id = ?")
          .run(deletedAt, deletedAt, patentId);
        context.inTransaction?.(database);
      });
    });
  }

  restore(patentId: string, context: PatentLifecycleContext = {}): Promise<void> {
    return this.#enqueueWrite(() => {
      const restoredAt = this.now().toISOString();
      verifyLifecycleState(this.#patentRow(patentId), context);
      this.database.transaction((database) => {
        this.#patentRow(patentId);
        database
          .prepare("UPDATE patents SET deleted_at = NULL, modified_at = ? WHERE patent_id = ?")
          .run(restoredAt, patentId);
        context.inTransaction?.(database);
      });
    });
  }

  purgeExpired(now: Date = this.now()): Promise<{ purgedPatentIds: string[] }> {
    return this.#enqueueWrite(async () => {
      const rows = this.database.read((database) =>
        database
          .prepare(
            "SELECT patent_id, deleted_at FROM patents WHERE deleted_at IS NOT NULL ORDER BY deleted_at, patent_id",
          )
          .all(),
      ) as Array<{ patent_id: string; deleted_at: string }>;
      const purgedPatentIds: string[] = [];
      for (const row of rows) {
        const expiresAt = Date.parse(row.deleted_at) + TRASH_RETENTION_MS;
        if (
          !canPermanentlyDeletePatent(row.deleted_at, now.getTime()) ||
          expiresAt > now.getTime() ||
          this.#isLeased(row.patent_id)
        )
          continue;
        const release = await this.preparePermanentDelete?.(row.patent_id);
        try {
          this.deleteWithHistory(row.patent_id, () =>
            this.database.transaction((database) => {
              const deleted = database
                .prepare("DELETE FROM patents WHERE patent_id = ? AND deleted_at IS NOT NULL")
                .run(row.patent_id);
              if (deleted.changes) this.#deleteDesignPatentState(database, row.patent_id);
            }),
          );
        } finally {
          release?.();
        }
        purgedPatentIds.push(row.patent_id);
        await this.#collectUnusedAssetsAfterCommit(row.patent_id);
      }
      return { purgedPatentIds };
    });
  }

  async permanentlyDelete(patentId: string, context: PatentLifecycleContext = {}): Promise<void> {
    await this.#enqueueWrite(async () => {
      if (this.#isLeased(patentId)) {
        throw new LibraryServiceError("LIBRARY_LOCKED", "Patent has an active lease.");
      }
      const row = this.#patentRow(patentId);
      if (row.deleted_at === null) {
        throw new LibraryServiceError("INVALID_INPUT", "Patent must be in trash.");
      }
      if (!canPermanentlyDeletePatent(row.deleted_at, this.now().getTime())) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "专利移入回收站未满 24 小时，暂不能永久删除。删除时间异常时请先恢复专利。",
        );
      }
      verifyLifecycleState(row, context);
      const release = await this.preparePermanentDelete?.(patentId);
      try {
        this.deleteWithHistory(patentId, () =>
          this.database.transaction((database) => {
            database.prepare("DELETE FROM patents WHERE patent_id = ?").run(patentId);
            this.#deleteDesignPatentState(database, patentId);
            context.inTransaction?.(database);
          }),
        );
      } finally {
        release?.();
      }
    });
    await this.#collectUnusedAssetsAfterCommit(patentId);
  }

  async release(sessionId: string): Promise<void> {
    for (const task of this.resourceInspections.values())
      if (task.sessionId === sessionId) task.controller.abort();
    const patentId = this.leases.get(sessionId);
    this.leases.delete(sessionId);
    if (patentId && !this.#isLeased(patentId)) {
      this.assetStore?.releasePatentHistoryAssets?.(patentId);
      await this.#collectUnusedAssetsAfterCommit(patentId);
    }
  }

  async #collectUnusedAssetsAfterCommit(patentId: string): Promise<void> {
    try {
      await this.collectUnusedAssets(patentId);
    } catch {
      // The logical transaction has committed. Startup/release reconciliation will retry GC.
    }
  }

  async #authoritativeBookAssets(
    patentId: string,
    requestedAssets: readonly AssetDescriptor[],
  ): Promise<AssetDescriptor[]> {
    if (requestedAssets.length === 0) return [];
    if (!this.assetStore) {
      throw new LibraryServiceError("INTERNAL", "Patent asset store is unavailable.");
    }
    const assets: AssetDescriptor[] = [];
    for (const requested of requestedAssets) {
      const owned = this.database.read((database) =>
        database
          .prepare("SELECT 1 FROM patent_assets WHERE patent_id = ? AND asset_id = ?")
          .get(patentId, requested.assetId),
      );
      if (owned === undefined) {
        // Accept assets staged for this patent by the renderer (e.g. chemical structure
        // previews) and adopt them on the first save. The adopt is idempotent and must
        // fail when the resource does not exist in the store.
        if (!this.adoptAsset) {
          throw new LibraryServiceError(
            "INVALID_INPUT",
            "Patent book asset is not owned by patent.",
          );
        }
        try {
          await this.adoptAsset({ kind: "patent", patentId }, requested.assetId);
        } catch {
          throw new LibraryServiceError(
            "INVALID_INPUT",
            "Patent book asset is not owned by patent.",
          );
        }
      }
      const descriptor = this.assetStore.readVerifiedDescriptor
        ? await this.assetStore.readVerifiedDescriptor(requested.assetId)
        : (await this.assetStore.readAsset(requested.assetId)).descriptor;
      if (!sameAssetDescriptor(requested, descriptor)) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Patent book asset descriptor does not match store.",
        );
      }
      assets.push(structuredClone(descriptor));
    }
    return assets;
  }

  #loadPatent(
    patentId: string,
    options: {
      allowTrash?: boolean;
      cache?: boolean;
      row?: PatentRow;
      books?: PatentBookRow[];
    } = {},
  ): CanonicalPatent {
    // The open editor can undo removal of any previously referenced resource.
    // Retain before mutations; other owners' collectors must respect this lease too.
    if (this.#isLeased(patentId)) this.assetStore?.retainPatentHistoryAssets?.(patentId);
    const token = options.cache === false ? undefined : this.database.changeToken();
    const cached =
      token !== undefined && this.#patentSnapshot?.patentId === patentId
        ? this.#patentSnapshot
        : undefined;
    if (cached && cached.token === token) {
      if (!options.allowTrash) ensureActivePatent(this.#patentRow(patentId));
      return structuredClone(cached.patent);
    }
    const row = options.row ?? this.#patentRow(patentId);
    if (!options.allowTrash) ensureActivePatent(row);
    const books =
      options.books
        ?.slice()
        .sort((a, b) => PATENT_BOOK_ORDER.indexOf(a.kind) - PATENT_BOOK_ORDER.indexOf(b.kind)) ??
      (this.database.read((database) =>
        database
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
          .all(patentId),
      ) as PatentBookRow[]);
    const reusedBooks = new Map<PatentBookKind, CanonicalPatent["books"][number]>();
    for (const book of books) {
      const previous = cached?.books.find((item) => item.kind === book.kind);
      if (
        previous &&
        previous.book_id === book.book_id &&
        previous.revision === book.revision &&
        Buffer.from(previous.document_json).equals(book.document_json) &&
        Buffer.from(previous.editor_state_json).equals(book.editor_state_json)
      ) {
        const verified = cached?.patent.books.find((item) => item.kind === book.kind);
        if (verified) reusedBooks.set(book.kind, verified);
      }
    }
    const figureState = this.#loadFigureState(patentId);
    const designPatent = this.#loadDesignPatentState(patentId, row.patent_type);
    const auxiliaryDocuments = this.database.read((database) =>
      database
        .prepare(
          `SELECT auxiliary_document_id, title, revision, document_json,
                  editor_state_json, source_file_name
           FROM patent_auxiliary_documents
           WHERE patent_id = ?
           ORDER BY position`,
        )
        .all(patentId),
    ) as PatentAuxiliaryDocumentRow[];
    const importReportRow = this.database.read((database) =>
      database
        .prepare("SELECT report_json FROM patent_import_reports WHERE patent_id = ?")
        .get(patentId),
    ) as { report_json: Uint8Array } | undefined;
    const descriptionBook = books.find((book) => book.kind === "description");
    const descriptionDocument = descriptionBook
      ? (reusedBooks.get("description")?.document ??
        migrateBookDocument(
          parsedJson<PatentBookDocument>(
            `book:${patentId}:description:${descriptionBook.revision}`,
            descriptionBook.document_json,
          ),
        ))
      : undefined;
    const referenceMarkState = this.#loadReferenceMarkState(patentId, descriptionDocument);
    const figures = this.database.read((database) =>
      database
        .prepare(
          `SELECT figure_id, asset_id, width_mm, explanation, flowchart_link
           FROM patent_figures
           WHERE patent_id = ?
           ORDER BY position`,
        )
        .all(patentId),
    ) as PatentFigureRow[];
    const flowchartProjects = this.database.read((database) =>
      database
        .prepare(
          `SELECT project_id, revision, metadata, source_sha256, created_at, modified_at
           FROM patent_flowcharts WHERE patent_id = ? ORDER BY modified_at DESC, project_id`,
        )
        .all(patentId),
    ) as FlowchartProjectRow[];

    const input = {
      formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
      patentId: row.patent_id,
      name: row.name,
      customer: row.customer,
      patentType: row.patent_type,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      revision: row.revision,
      drawingBooksEnabled: row.drawing_books_enabled !== 0,
      activeBookKind: "description",
      books: books.map((book) => {
        const verified = reusedBooks.get(book.kind);
        if (verified) return verified;
        const document =
          book.kind === "description" && descriptionDocument
            ? descriptionDocument
            : migrateBookDocument(
                parsedJson(`book:${patentId}:${book.kind}:${book.revision}`, book.document_json),
              );
        return {
          bookId: book.book_id,
          kind: book.kind,
          document,
          editorState: parsedJson<JsonObject>(
            `book-editor:${patentId}:${book.kind}:${book.revision}`,
            book.editor_state_json,
          ),
          localRevision: book.revision,
          persistedRevision: book.revision,
        };
      }),
      auxiliaryDocuments: auxiliaryDocuments.map((item): AuxiliaryDocument => {
        const previous = cached?.auxiliary.find(
          (value) => value.auxiliary_document_id === item.auxiliary_document_id,
        );
        const verified = cached?.patent.auxiliaryDocuments.find(
          (value) => value.auxiliaryDocumentId === item.auxiliary_document_id,
        );
        if (
          previous &&
          verified &&
          previous.title === item.title &&
          previous.revision === item.revision &&
          previous.source_file_name === item.source_file_name &&
          Buffer.from(previous.document_json).equals(item.document_json) &&
          Buffer.from(previous.editor_state_json).equals(item.editor_state_json)
        )
          return verified;
        const document = migrateBookDocument(
          parsedJson(
            `auxiliary-document:${patentId}:${item.auxiliary_document_id}:${item.revision}`,
            item.document_json,
          ),
        );
        return {
          auxiliaryDocumentId: item.auxiliary_document_id,
          title: item.title,
          document,
          editorState: parsedJson<JsonObject>(
            `auxiliary-editor:${patentId}:${item.auxiliary_document_id}:${item.revision}`,
            item.editor_state_json,
          ),
          localRevision: item.revision,
          persistedRevision: item.revision,
          sourceFileName: item.source_file_name,
        };
      }),
      docxImportReport:
        importReportRow === undefined
          ? null
          : DocxImportReportSchema.parse(
              parsedJson(`docx-import-report:${patentId}`, importReportRow.report_json),
            ),
      figures: figures.map((figure) => ({
        figureId: figure.figure_id,
        assetId: figure.asset_id,
        widthMm: figure.width_mm,
        rotationDeg: figureState.rotations?.[figure.figure_id] ?? 0,
        ...(figure.flowchart_link === null
          ? {}
          : {
              flowchartLink: FlowchartFigureLinkSchema.parse(
                parsedJson(
                  `flowchart-figure-link:${patentId}:${figure.figure_id}`,
                  figure.flowchart_link,
                ),
              ),
            }),
      })),
      abstractDrawingFigureId: figureState.abstractDrawingFigureId,
      assets: figureState.assets,
      drawingProjects: figureState.drawingProjects ?? [],
      flowchartProjects: flowchartProjects.map((project) => {
        const metadata = FlowchartProjectMetadataSchema.parse(
          parsedJson(
            `flowchart-metadata:${patentId}:${project.project_id}:${project.revision}`,
            project.metadata,
          ),
        );
        return FlowchartProjectDescriptorSchema.parse({
          projectId: project.project_id,
          name: metadata.name,
          revision: project.revision,
          pageCount: metadata.pageCount,
          lastPageId: metadata.lastPageId,
          sourceSha256: project.source_sha256,
          createdAt: project.created_at,
          modifiedAt: project.modified_at,
        });
      }),

      referenceMarks: referenceMarkState.referenceMarks,
      referenceMarkSettings: referenceMarkState.referenceMarkSettings,
      designPatent,
    };
    const patent = retainCurrentPatentAssets(
      cached
        ? parsePatentWithVerifiedBooks(input, cached.patent)
        : CanonicalPatentSchema.parse(input),
    );
    const bytes = [...books, ...auxiliaryDocuments].reduce(
      (total, item) => total + item.document_json.byteLength + item.editor_state_json.byteLength,
      0,
    );
    if (token !== undefined) {
      this.#patentSnapshot =
        token === this.database.changeToken() && bytes <= 8 * 1024 * 1024
          ? {
              token,
              patentId,
              patent: structuredClone(patent),
              books,
              auxiliary: auxiliaryDocuments,
            }
          : undefined;
    }
    return patent;
  }

  #deleteDesignPatentState(database: DatabaseSync, patentId: string): void {
    database
      .prepare("DELETE FROM library_state WHERE key = ?")
      .run(`patent:${patentId}:design-patent-state`);
  }

  #loadDesignPatentState(patentId: string, patentType: PatentType): DesignPatent | null {
    if (patentType !== "design") return null;
    const row = this.database.read((database) =>
      database
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get(`patent:${patentId}:design-patent-state`),
    ) as { value: Uint8Array } | undefined;
    if (!row) throw new LibraryServiceError("CORRUPT_FILE", "Design patent state is missing.");
    return DesignPatentSchema.parse(
      parsedJson(`patent-design-state:${patentId}`, row.value),
    );
  }

  #saveDesignPatentState(
    database: DatabaseSync,
    patentId: string,
    savedAt: string,
    state: DesignPatent | null,
  ): void {
    if (state === null) return;
    database
      .prepare(`INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)`)
      .run(
        `patent:${patentId}:design-patent-state`,
        storedJson(`patent-design-state:${patentId}`, state),
        savedAt,
      );
  }

  #loadReferenceMarkState(
    patentId: string,
    description: PatentBookDocument | undefined,
  ): Pick<CanonicalPatent, "referenceMarks" | "referenceMarkSettings"> {
    const row = this.database.read((database) =>
      database
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get(`patent:${patentId}:reference-mark-state`),
    ) as { value: Uint8Array } | undefined;
    if (!row)
      return {
        // 本功能上线前保存的旧库没有 reference-mark-state 行：从当前说明书图例派生，
        // 不写库、不改正文；确实没有合法图例时才返回空列表。
        referenceMarks: deriveReferenceMarksFromDescription(description),
        referenceMarkSettings: { synchronizedEditingEnabled: false },
      };
    return parsedJson(`patent-reference-mark-state:${patentId}`, row.value);
  }

  #saveReferenceMarkState(
    database: DatabaseSync,
    patentId: string,
    savedAt: string,
    state: Pick<CanonicalPatent, "referenceMarks" | "referenceMarkSettings">,
  ): void {
    database
      .prepare(`INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)`)
      .run(
        `patent:${patentId}:reference-mark-state`,
        storedJson(`patent-reference-mark-state:${patentId}`, state),
        savedAt,
      );
  }

  #loadFigureState(patentId: string): PatentFigureState {
    const row = this.database.read((database) =>
      database
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get(`patent:${patentId}:figure-state`),
    ) as { value: Uint8Array } | undefined;
    if (row === undefined) return { assets: [], abstractDrawingFigureId: null };
    return parsedJson<PatentFigureState>(`patent-figure-state:${patentId}`, row.value);
  }

  #saveFigureState(
    database: DatabaseSync,
    patentId: string,
    savedAt: string,
    state: PatentFigureState,
  ): void {
    for (const asset of state.assets)
      this.assetStore?.assertIndependentOwner?.({ kind: "patent", patentId }, asset.assetId);
    // Old libraries may have surplus owner rows even when both compared live lists
    // are already normalized. Reconcile them on every successful state save.
    const retainedIds = new Set(state.assets.map((asset) => asset.assetId));
    const owned = database
      .prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?")
      .all(patentId) as { asset_id: string }[];
    const remove = database.prepare(
      "DELETE FROM patent_assets WHERE patent_id = ? AND asset_id = ?",
    );
    for (const asset of owned)
      if (!retainedIds.has(asset.asset_id)) remove.run(patentId, asset.asset_id);
    database
      .prepare(
        `INSERT OR REPLACE INTO library_state(key, value, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(
        `patent:${patentId}:figure-state`,
        storedJson(`patent-figure-state:${patentId}`, {
          drawingProjects: this.#loadFigureState(patentId).drawingProjects ?? [],
          ...state,
        }),
        savedAt,
      );
  }

  #replaceAuxiliaryDocuments(
    database: DatabaseSync,
    patentId: string,
    documents: readonly AuxiliaryDocument[],
  ): void {
    database.prepare("DELETE FROM patent_auxiliary_documents WHERE patent_id = ?").run(patentId);
    const insert = database.prepare(
      `INSERT INTO patent_auxiliary_documents(
         patent_id, auxiliary_document_id, position, title, revision,
         document_json, editor_state_json, source_file_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    documents.forEach((document, position) => {
      insert.run(
        patentId,
        document.auxiliaryDocumentId,
        position,
        document.title,
        document.persistedRevision,
        storedJson(
          `auxiliary-document:${patentId}:${document.auxiliaryDocumentId}:${document.persistedRevision}`,
          document.document,
        ),
        storedJson(
          `auxiliary-editor:${patentId}:${document.auxiliaryDocumentId}:${document.persistedRevision}`,
          document.editorState,
        ),
        document.sourceFileName,
      );
    });
  }

  #saveImportReport(
    database: DatabaseSync,
    patentId: string,
    report: CanonicalPatent["docxImportReport"],
  ): void {
    if (report === null) {
      database.prepare("DELETE FROM patent_import_reports WHERE patent_id = ?").run(patentId);
      return;
    }
    database
      .prepare(
        `INSERT OR REPLACE INTO patent_import_reports(patent_id, report_json, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(patentId, storedJson(`docx-import-report:${patentId}`, report), report.importedAt);
  }

  #patentRow(patentId: string): PatentRow {
    const row = this.database.read((database) =>
      database
        .prepare(
          `SELECT patent_id,
                  name,
                  customer,
                  patent_type,
                  drawing_books_enabled,
                  revision,
                  created_at,
                  modified_at,
                  deleted_at,
                  recovery_state,
                  recovery_error_code
           FROM patents
           WHERE patent_id = ?`,
        )
        .get(patentId),
    ) as PatentRow | undefined;
    if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
    return row;
  }

  #isLeased(patentId: string): boolean {
    for (const leasedPatentId of this.leases.values()) {
      if (leasedPatentId === patentId) return true;
    }
    return false;
  }

  #summaryFingerprint(
    row: PatentRow,
    captureBooks?: (books: PatentBookRow[]) => void,
  ): string | null {
    return this.database.read((database) => {
      const hash = createHash("sha256").update(JSON.stringify(row));
      const queries: Array<[string, string[]]> = [
        [
          "SELECT book_id, kind, revision, document_json, editor_state_json FROM patent_books WHERE patent_id = ? ORDER BY book_id",
          [row.patent_id],
        ],
        [
          "SELECT figure_id, asset_id, width_mm, position, flowchart_link FROM patent_figures WHERE patent_id = ? ORDER BY position, figure_id",
          [row.patent_id],
        ],
        [
          "SELECT project_id, revision, metadata, source_sha256, created_at, modified_at FROM patent_flowcharts WHERE patent_id = ? ORDER BY project_id",
          [row.patent_id],
        ],
        [
          "SELECT key, value FROM library_state WHERE key IN (?, ?) ORDER BY key",
          [`patent:${row.patent_id}:figure-state`, `patent:${row.patent_id}:reference-mark-state`],
        ],
      ];
      for (const [query, parameters] of queries) {
        hash.update(query);
        const storedRows = database.prepare(query).all(...parameters);
        if (query === queries[0]?.[0]) captureBooks?.(storedRows as PatentBookRow[]);
        for (const stored of storedRows) {
          for (const value of Object.values(stored)) {
            if (ArrayBuffer.isView(value)) {
              hash.update(`bytes:${value.byteLength}:`).update(value as Uint8Array);
            } else {
              hash.update(JSON.stringify(value));
            }
            hash.update(";");
          }
          hash.update("\n");
        }
      }
      return hash.digest("hex");
    });
  }

  #inspectionIssueCount(patent: CanonicalPatent): number {
    try {
      return this.inspectPatent(patent).issues.length;
    } catch {
      return 0;
    }
  }

  #summaryAwareTransaction<T>(patentId: string, operation: (database: DatabaseSync) => T): T {
    const before = this.database.changeToken();
    const snapshot = this.#listSnapshot?.token === before ? this.#listSnapshot : undefined;
    const result = this.database.transaction(operation);
    const after = this.database.changeToken();
    // External commit/schema changes must still force complete inspection, even if
    // they land immediately after our transaction releases SQLite's writer lock.
    if (
      snapshot &&
      !this.database.read((database) =>
        database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' LIMIT 1").get(),
      ) &&
      JSON.stringify(JSON.parse(before).slice(1)) === JSON.stringify(JSON.parse(after).slice(1))
    ) {
      snapshot.token = after;
      snapshot.dirty ??= new Set();
      snapshot.dirty.add(patentId);
    }
    return result;
  }

  #insertEditLog(
    database: DatabaseSync,
    input: {
      operationId: string;
      patentId: string;
      baseRevision: number;
      targetRevision: number;
      savedAt: string;
      payload: unknown;
    },
  ): void {
    const contentHash = hashJson(input.payload);
    const context = `patent-edit:${input.patentId}:${input.baseRevision}:${input.targetRevision}:${input.operationId}`;
    database
      .prepare(
        `INSERT INTO edit_log(
           operation_id,
           patent_id,
           base_revision,
           target_revision,
           model_version,
           payload,
           content_hash,
           created_at
         ) VALUES (?, ?, ?, ?, 2, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.patentId,
        input.baseRevision,
        input.targetRevision,
        storedJson(context, input.payload),
        contentHash,
        input.savedAt,
      );
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

function migrateBookDocument(input: unknown): PatentBookDocument {
  const result = migratePatentBookDocument(input);
  if (!result.ok) throw new LibraryServiceError("CORRUPT_FILE", result.error.message);
  return result.value;
}

function parseCurrentPatent(input: unknown): CanonicalPatent {
  return retainCurrentPatentAssets(CanonicalPatentSchema.parse(input));
}

function ensureActivePatent(row: PatentRow): PatentRow {
  if (row.deleted_at !== null) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
  return row;
}

function normalizePatentName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCustomerName(customer: string | null | undefined): string | null {
  if (customer === null || customer === undefined) return null;
  const trimmed = customer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rotationsByFigure(figures: readonly PatentFigure[]): Record<string, ImageRotation> {
  return Object.fromEntries(
    figures.map((figure) => [figure.figureId, figure.rotationDeg ?? 0] as const),
  );
}

function bookStatus(
  kind: PatentBookKind,
  content: CanonicalPatent["books"][number]["document"]["content"],
): PatentBookStatus {
  if (content.length === 0) return "empty";
  if (kind === "description") return "draft";
  return content.some((block) => JSON.stringify(block).trim().length > 0) ? "draft" : "empty";
}

export { PATENT_BOOK_LABELS };
