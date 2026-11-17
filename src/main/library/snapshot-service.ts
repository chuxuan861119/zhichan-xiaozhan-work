import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AssetDescriptor,
  ImageRotation,
  PatentBookDocument,
} from "../../shared/document/model.js";
import type { JsonObject } from "../../shared/ipc/primitives.js";
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
  PATENT_BOOK_ORDER,
  type PatentBookKind,
  type PatentFigure,
  type PatentType,
} from "../../shared/patent/model.js";
import {
  documentSnapshotFigures,
  patentDocumentSnapshot,
  patentSnapshotContent,
} from "../../shared/patent/snapshot-scope.js";
import { countUnicodeCharacters, visiblePatentBookText } from "../../shared/patent/text.js";
import type {
  SnapshotContentPreview,
  SnapshotContentSummary,
  SnapshotCreationResult,
  SnapshotPreviewVersion,
  SnapshotSource,
} from "../../shared/snapshot/model.js";
import {
  decodeEnvelope,
  decodePatentRecoverySnapshot,
  hashJson,
  LibraryServiceError,
} from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { decodeBytes, decodeJson, PlaintextCodecError } from "./plaintext-codec.js";
import { parsePatentEditPayload, recoverPatentFromSnapshot } from "./recovery-service.js";
import { retainedSnapshotRevisions } from "./snapshot-retention.js";
import {
  createSnapshotPayload,
  createSnapshotPayloadInWorker,
  type SnapshotWorkerJob,
  type SnapshotWorkerResult,
} from "./snapshot-worker.js";

export type SnapshotMutationContext = {
  beforeCommit?: () => void;
  inTransaction?: (database: DatabaseSync, revision: number) => void;
};

export type SnapshotServiceOptions = {
  database: LibraryDatabase;
  readAssetPreview: (assetId: string) => Promise<Uint8Array>;
  worker?: (job: SnapshotWorkerJob) => Promise<SnapshotWorkerResult> | SnapshotWorkerResult;
  enqueueWrite?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  collectUnusedAssets?: (patentId: string) => Promise<void>;
  collectUnusedFlowchartSources?: (patentId: string) => Promise<void>;
  validateAsset?: (assetId: string) => Promise<void>;
  leaseAssets?: (assetIds: readonly string[]) => Promise<() => void>;
  now?: () => Date;
};

type SnapshotRow = {
  revision: number;
  model_version: number;
  payload: Uint8Array;
  content_hash: string;
  created_at: string;
  source: SnapshotSource;
};

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

type PatentFigureState = {
  drawingProjects?: CanonicalPatent["drawingProjects"];
  assets: AssetDescriptor[];
  abstractDrawingFigureId: string | null;
  rotations?: Record<string, ImageRotation>;
};

type PatentReferenceMarkState = Pick<CanonicalPatent, "referenceMarks" | "referenceMarkSettings">;

export type OpenedSnapshot = {
  revision: number;
  createdAt: string;
  patent: CanonicalPatent;
};

export type SnapshotMetadata = {
  revision: number;
  createdAt: string;
  source: SnapshotSource;
  sizeBytes: number;
  status: "healthy" | "resource-missing" | "damaged";
  errorMessage: string | null;
  deletable: boolean;
  contentSummary: SnapshotContentSummary | null;
};

export type SnapshotRetentionRunResult = {
  deletedCount: number;
  cleanupError: string | null;
};

export class SnapshotService {
  static createSnapshotPayload(job: SnapshotWorkerJob): SnapshotWorkerResult {
    return createSnapshotPayload(job);
  }

  private readonly database: LibraryDatabase;
  private readonly readAssetPreview: (assetId: string) => Promise<Uint8Array>;
  private readonly worker: (
    job: SnapshotWorkerJob,
  ) => Promise<SnapshotWorkerResult> | SnapshotWorkerResult;
  private readonly enqueueWrite: <T>(operation: () => T | Promise<T>) => Promise<T>;
  private readonly collectUnusedAssets: ((patentId: string) => Promise<void>) | undefined;
  private readonly collectUnusedFlowchartSources: ((patentId: string) => Promise<void>) | undefined;
  private readonly validateAsset: ((assetId: string) => Promise<void>) | undefined;
  private readonly leaseAssets: ((assetIds: readonly string[]) => Promise<() => void>) | undefined;
  private readonly now: () => Date;
  private lastError: string | null = null;
  private readonly pendingCreations = new Map<string, number>();
  private readonly prepared = new Map<string, { token: string; result: SnapshotWorkerResult }>();
  private readonly validated = new Map<
    string,
    { token: string; revision: number; patent: CanonicalPatent; bytes: number }
  >();
  private readonly preparationTokens = new Map<string, string>();

  /** Prepare serialization only; history and asset ownership are committed by create(). */
  async prepareClose(patentId: string, requireStable = false): Promise<void> {
    const token = this.database.changeToken();
    if (requireStable && this.preparationTokens.get(patentId) !== token) {
      this.preparationTokens.delete(patentId);
      this.preparationTokens.set(patentId, token);
      if (this.preparationTokens.size > 64)
        this.preparationTokens.delete(this.preparationTokens.keys().next().value!);
      return;
    }
    if (this.prepared.get(patentId)?.token === token) return;
    const revision = this.database.read((db) =>
      db
        .prepare("SELECT revision FROM patents WHERE patent_id = ? AND deleted_at IS NULL")
        .get(patentId),
    ) as { revision: number } | undefined;
    if (!revision) {
      this.prepared.delete(patentId);
      return;
    }
    if (this.#creationResultForRevision(patentId, revision.revision, "already-exists")) {
      this.prepared.delete(patentId);
      await this.#validateSnapshot(patentId, revision.revision);
      return;
    }
    const loaded = this.database.read((db) => loadPatent(db, patentId));
    const unchanged = this.#workspaceOnlySnapshot(patentId, loaded.patent);
    if (unchanged) {
      this.prepared.delete(patentId);
      await this.#validateSnapshot(patentId, unchanged.revision);
      return;
    }
    const result = await this.worker({
      patentId,
      revision: loaded.revision,
      modelVersion: 3,
      scope: "documents",
      patent: loaded.patent,
    });
    if (this.database.changeToken() !== token) return;
    this.prepared.delete(patentId);
    if (result.payload.byteLength > 32 * 1024 * 1024) return;
    this.prepared.set(patentId, { token, result });
    while (
      this.prepared.size > 8 ||
      [...this.prepared.values()].reduce((sum, entry) => sum + entry.result.payload.byteLength, 0) >
        32 * 1024 * 1024
    ) {
      const oldest = this.prepared.keys().next().value;
      if (oldest === undefined) break;
      this.prepared.delete(oldest);
    }
  }

  constructor(options: SnapshotServiceOptions) {
    this.database = options.database;
    this.readAssetPreview = options.readAssetPreview;
    this.worker = options.worker ?? createSnapshotPayloadInWorker;
    this.enqueueWrite =
      options.enqueueWrite ??
      (async (operation) => {
        return await operation();
      });
    this.collectUnusedAssets = options.collectUnusedAssets;
    this.collectUnusedFlowchartSources = options.collectUnusedFlowchartSources;
    this.validateAsset = options.validateAsset;
    this.leaseAssets = options.leaseAssets;
    this.now = options.now ?? (() => new Date());
  }

  status(): { lastSnapshotAt: string | null; lastError: string | null } {
    return { lastSnapshotAt: this.lastAutomaticSnapshotAt(), lastError: this.lastError };
  }

  lastAutomaticSnapshotAt(): string | null {
    const row = this.database.read((database) =>
      database
        .prepare("SELECT MAX(created_at) AS created_at FROM snapshots WHERE source = 'automatic'")
        .get(),
    ) as { created_at: string | null };
    return row.created_at;
  }

  async create(
    patentId: string,
    source: SnapshotSource,
    context: SnapshotMutationContext = {},
  ): Promise<SnapshotCreationResult> {
    const prepared = this.prepared.get(patentId);
    const preparedIsCurrent = prepared?.token === this.database.changeToken();
    this.prepared.delete(patentId);
    const current = this.database.read((db) =>
      db
        .prepare("SELECT revision FROM patents WHERE patent_id = ? AND deleted_at IS NULL")
        .get(patentId),
    ) as { revision: number } | undefined;
    if (!current) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
    const existing = this.#creationResultForRevision(patentId, current.revision, "already-exists");
    if (existing) {
      await this.#validateSnapshot(patentId, existing.revision);
      context.beforeCommit?.();
      return existing;
    }
    const loaded = this.database.read((database) => loadPatent(database, patentId));
    const unchanged = this.#workspaceOnlySnapshot(patentId, loaded.patent);
    if (unchanged) {
      await this.#validateSnapshot(patentId, unchanged.revision);
      context.beforeCommit?.();
      return unchanged;
    }

    // The worker has captured flowchart descriptors but has not linked their sources yet.
    // Newer snapshots may prune the journals that otherwise retain those sources.
    this.pendingCreations.set(patentId, (this.pendingCreations.get(patentId) ?? 0) + 1);
    let releaseAssetLease: (() => void) | undefined;
    let result: SnapshotWorkerResult;
    try {
      releaseAssetLease = await this.leaseAssets?.(
        loaded.patent.assets.map((asset) => asset.assetId),
      );
      result =
        preparedIsCurrent && prepared?.result.revision === loaded.revision
          ? prepared.result
          : await this.worker({
              patentId,
              revision: loaded.revision,
              modelVersion: 3,
              scope: "documents",
              patent: loaded.patent,
            });

      const createdAt = this.now().toISOString();
      const inserted = await this.enqueueWrite(() => {
        context.beforeCommit?.();
        return this.database.transaction((database) => {
          const insertResult = database
            .prepare(
              `INSERT INTO snapshots(
               patent_id,
               revision,
               model_version,
               payload,
               content_hash,
               created_at,
               source
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(patent_id, revision) DO NOTHING`,
            )
            .run(
              patentId,
              result.revision,
              result.modelVersion,
              result.payload,
              result.contentHash,
              createdAt,
              source,
            );
          if (Number(insertResult.changes) !== 1) return false;
          const link = database.prepare(
            `INSERT OR IGNORE INTO snapshot_assets(patent_id, revision, asset_id)
           SELECT ?, ?, asset_id FROM assets WHERE asset_id = ?`,
          );
          for (const asset of loaded.patent.assets) {
            link.run(patentId, result.revision, asset.assetId);
          }
          linkSnapshotFlowchartRevisions(
            database,
            patentId,
            result.revision,
            loaded.patent.flowchartProjects,
          );
          context.inTransaction?.(database, result.revision);
          return true;
        });
      });

      if (!inserted) {
        const winner = this.#creationResultForRevision(patentId, result.revision, "already-exists");
        if (!winner) throw new LibraryServiceError("CORRUPT_FILE", "Snapshot conflict vanished.");
        await this.#validateSnapshot(patentId, winner.revision);
        return winner;
      }
    } finally {
      const pending = (this.pendingCreations.get(patentId) ?? 1) - 1;
      if (pending === 0) this.pendingCreations.delete(patentId);
      else this.pendingCreations.set(patentId, pending);
      releaseAssetLease?.();
    }

    await this.#validateSnapshot(patentId, result.revision);
    // Retention scans old history and resources. The maintenance timer handles it;
    // closing must only establish the current recovery point.
    if (source !== "application-close" && source !== "patent-close") {
      const retention = await this.prunePatent(patentId);
      this.lastError = retention.cleanupError;
    }
    const created = this.#creationResultForRevision(patentId, result.revision, "created");
    if (!created) throw new LibraryServiceError("CORRUPT_FILE", "Created snapshot is missing.");
    return created;
  }

  /**
   * Rebuilds the recovery anchor of a patent whose edit journal can no longer be replayed.
   * Writes a fresh snapshot of the current live content at the live revision, so recovery
   * has a verified starting point again.
   *
   * Live rows are the primary store and are written in the same transaction as the edit
   * journal, so they are never behind it; rebuilding from them therefore cannot drop
   * content that the journal still holds. When the live rows themselves cannot be read
   * this throws and the caller keeps the patent quarantined.
   */
  async rebuildRecoveryAnchor(patentId: string): Promise<{ revision: number }> {
    const loaded = this.database.read((database) => loadPatent(database, patentId));
    const existing = this.database.read(
      (database) =>
        database
          .prepare(
            `SELECT revision, model_version, payload, content_hash, created_at, source
             FROM snapshots
             WHERE patent_id = ? AND revision = ?`,
          )
          .get(patentId, loaded.revision) as SnapshotRow | undefined,
    );
    // A snapshot at the live revision has nothing left to replay, so quarantine could only
    // have been reached through an unreadable payload. Replace exactly that row and leave a
    // readable one alone: it would have recovered the patent on its own.
    if (existing !== undefined && !isReadableSnapshot(existing)) {
      this.database.transaction((database) => {
        database
          .prepare("DELETE FROM snapshots WHERE patent_id = ? AND revision = ?")
          .run(patentId, loaded.revision);
      });
    }
    const created = await this.create(patentId, "manual-create");
    return { revision: created.revision };
  }

  async reconcileAssetReferences(): Promise<void> {
    const rows = this.database.read(
      (database) =>
        database
          .prepare("SELECT patent_id, revision FROM snapshots ORDER BY patent_id, revision")
          .all() as Array<{ patent_id: string; revision: number }>,
    );
    let incomplete = false;
    for (const row of rows) {
      try {
        await this.open(row.patent_id, row.revision);
        this.database.transaction((database) => {
          database
            .prepare("DELETE FROM snapshot_assets WHERE patent_id = ? AND revision = ?")
            .run(row.patent_id, row.revision);
          const link = database.prepare(
            `INSERT OR IGNORE INTO snapshot_assets(patent_id, revision, asset_id)
             SELECT ?, ?, asset_id FROM assets WHERE asset_id = ?`,
          );
          // Legacy payloads keep their original resource contract until retention removes them.
          // Do not leave an unchanged historical archive with physically missing declared assets.
          const raw = database
            .prepare(
              "SELECT revision, model_version, payload, content_hash FROM snapshots WHERE patent_id = ? AND revision = ?",
            )
            .get(row.patent_id, row.revision) as SnapshotRow | undefined;
          if (!raw) throw new LibraryServiceError("NOT_FOUND", "Snapshot no longer exists.");
          const legacyPatent = decodePatentRecoverySnapshot(raw).patent;
          for (const asset of legacyPatent.assets) {
            link.run(row.patent_id, row.revision, asset.assetId);
          }
          linkSnapshotFlowchartRevisions(
            database,
            row.patent_id,
            row.revision,
            legacyPatent.flowchartProjects,
          );
        });
      } catch {
        incomplete = true;
      }
    }
    this.database.transaction((database) => {
      if (incomplete) {
        database
          .prepare(
            `INSERT OR REPLACE INTO library_state(key, value, updated_at)
             VALUES ('snapshot-asset-index-incomplete', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run(Buffer.from("1"));
      } else {
        database
          .prepare("DELETE FROM library_state WHERE key = 'snapshot-asset-index-incomplete'")
          .run();
      }
    });
    if (!incomplete) {
      await Promise.all(
        [...new Set(rows.map((row) => row.patent_id))].map((patentId) =>
          this.#collectUnusedResources(patentId),
        ),
      );
    }
  }

  async delete(
    patentId: string,
    revision: number,
    context: SnapshotMutationContext = {},
  ): Promise<{ cleanupError: string | null }> {
    const healthy = new Set(
      (await this.list(patentId))
        .filter((entry) => entry.status === "healthy")
        .map((entry) => entry.revision),
    );
    const changed = await this.enqueueWrite(() => {
      context.beforeCommit?.();
      return this.database.transaction((database) => {
        // Recompute inside the deletion transaction: another deletion or journal pruning
        // may have removed the fallback while resource validation was awaiting I/O.
        const anchors = usableRecoveryRevisions(database, patentId, healthy);
        if (anchors.length === 1 && anchors[0] === revision) {
          throw new LibraryServiceError(
            "SNAPSHOT_RECOVERY_PROTECTED",
            "这是最后一个可恢复到当前内容的有效快照，不能删除。请先创建新的有效快照。",
          );
        }
        const changes = database
          .prepare("DELETE FROM snapshots WHERE patent_id = ? AND revision = ?")
          .run(patentId, revision).changes;
        if (changes !== 0) context.inTransaction?.(database, revision);
        return changes;
      });
    });
    if (changed === 0) throw new LibraryServiceError("NOT_FOUND", "Snapshot not found.");
    try {
      await this.#collectUnusedResources(patentId);
      return { cleanupError: null };
    } catch (error) {
      const cleanupError = (error instanceof Error ? error.message : "快照资源整理失败").slice(
        0,
        2000,
      );
      this.lastError = cleanupError;
      return { cleanupError };
    }
  }

  async list(patentId: string): Promise<SnapshotMetadata[]> {
    const rows = this.database.read(
      (database) =>
        database
          .prepare(
            `SELECT revision, created_at, source, length(payload) AS size_bytes
           FROM snapshots
           WHERE patent_id = ?
           ORDER BY revision DESC`,
          )
          .all(patentId) as Array<{
          revision: number;
          created_at: string;
          source: SnapshotSource;
          size_bytes: number;
        }>,
    );
    const entries: SnapshotMetadata[] = [];
    for (const row of rows) {
      try {
        const opened = await this.open(patentId, row.revision);
        try {
          await this.#validateSnapshotResources(patentId, row.revision, opened.patent);
          entries.push({
            revision: row.revision,
            createdAt: row.created_at,
            source: row.source,
            sizeBytes: row.size_bytes,
            status: "healthy",
            errorMessage: null,
            deletable: true,
            contentSummary: createContentSummary(opened.patent),
          });
        } catch (error) {
          entries.push({
            revision: row.revision,
            createdAt: row.created_at,
            source: row.source,
            sizeBytes: row.size_bytes,
            status: "resource-missing",
            errorMessage: error instanceof Error ? error.message : "快照资源缺失",
            deletable: true,
            contentSummary: createContentSummary(opened.patent),
          });
        }
      } catch (error) {
        entries.push({
          revision: row.revision,
          createdAt: row.created_at,
          source: row.source,
          sizeBytes: row.size_bytes,
          status: "damaged",
          errorMessage: error instanceof Error ? error.message : "快照损坏",
          deletable: true,
          contentSummary: null,
        });
      }
    }
    const healthy = new Set(
      entries.filter((entry) => entry.status === "healthy").map((entry) => entry.revision),
    );
    const anchors = this.database.read((database) =>
      usableRecoveryRevisions(database, patentId, healthy),
    );
    if (anchors.length === 1) {
      const anchor = entries.find((entry) => entry.revision === anchors[0]);
      if (anchor) anchor.deletable = false;
    }
    return entries;
  }

  async open(patentId: string, revision?: number): Promise<OpenedSnapshot> {
    const snapshot = this.database.read((database) => {
      const sql =
        revision === undefined
          ? `SELECT revision, model_version, payload, content_hash, created_at, source
             FROM snapshots
             WHERE patent_id = ?
             ORDER BY revision DESC
             LIMIT 1`
          : `SELECT revision, model_version, payload, content_hash, created_at, source
             FROM snapshots
             WHERE patent_id = ? AND revision = ?`;
      return (
        revision === undefined
          ? database.prepare(sql).get(patentId)
          : database.prepare(sql).get(patentId, revision)
      ) as SnapshotRow | undefined;
    });
    if (snapshot === undefined) throw new LibraryServiceError("NOT_FOUND", "Snapshot not found.");
    const recovered = decodePatentRecoverySnapshot(snapshot);
    return {
      revision: snapshot.revision,
      createdAt: snapshot.created_at,
      patent: patentDocumentSnapshot(recovered.patent),
    };
  }

  async readFlowchartArchive(patentId: string, revision: number) {
    const snapshot = await this.open(patentId, revision);
    return this.database.read((database) => {
      const read = database.prepare(`SELECT source.source, source.source_sha256,
          source.byte_length, source.project_revision
        FROM snapshot_flowchart_revisions AS link
        JOIN patent_flowchart_source_revisions AS source
          ON source.source_revision_id = link.source_revision_id
          AND source.patent_id = link.patent_id AND source.project_id = link.project_id
        WHERE link.patent_id = ? AND link.snapshot_revision = ? AND link.project_id = ?`);
      return snapshot.patent.flowchartProjects.map((project) => {
        const row = read.get(patentId, revision, project.projectId) as
          | {
              source: Uint8Array;
              source_sha256: string;
              byte_length: number;
              project_revision: number;
            }
          | undefined;
        if (!row || row.project_revision !== project.revision) {
          throw new LibraryServiceError("CORRUPT_FILE", "快照的流程图历史源文件缺失。");
        }
        let source: Uint8Array;
        try {
          source = decodeBytes(decodeEnvelope(row.source));
        } catch {
          throw new LibraryServiceError("CORRUPT_FILE", "快照的流程图历史源文件损坏。");
        }
        if (
          source.byteLength !== row.byte_length ||
          row.source_sha256 !== project.sourceSha256 ||
          createHash("sha256").update(source).digest("hex").toUpperCase() !== project.sourceSha256
        ) {
          throw new LibraryServiceError("CORRUPT_FILE", "快照的流程图历史源文件校验失败。");
        }
        return { projectId: project.projectId, source };
      });
    });
  }

  async preview(patentId: string, revision: number): Promise<SnapshotContentPreview> {
    const rows = this.database.read(
      (database) =>
        database
          .prepare(
            `SELECT revision
             FROM snapshots
             WHERE patent_id = ? AND revision <= ?
             ORDER BY revision DESC`,
          )
          .all(patentId, revision) as Array<{ revision: number }>,
    );
    const current = previewVersion(await this.open(patentId, revision));
    const olderRows = rows.filter((row) => row.revision < revision);
    const skippedRevisions: number[] = [];
    for (const row of olderRows) {
      try {
        return {
          current,
          baseline: previewVersion(await this.open(patentId, row.revision)),
          comparison: "compared",
          skippedRevisions,
        };
      } catch (error) {
        if (!isUnreadableSnapshotError(error)) throw error;
        skippedRevisions.push(row.revision);
      }
    }
    return {
      current,
      baseline: null,
      comparison: olderRows.length === 0 ? "initial" : "no-readable-baseline",
      skippedRevisions,
    };
  }

  async previewAsset(patentId: string, revision: number, assetId: string): Promise<Uint8Array> {
    const linked = this.database.read((database) =>
      database
        .prepare(
          `SELECT 1
           FROM snapshot_assets
           WHERE patent_id = ? AND revision = ? AND asset_id = ?`,
        )
        .get(patentId, revision, assetId),
    );
    if (linked === undefined) {
      throw new LibraryServiceError("NOT_FOUND", "Snapshot asset not found.");
    }
    return await this.readAssetPreview(assetId);
  }

  async prunePatent(patentId: string): Promise<SnapshotRetentionRunResult> {
    const history = await this.list(patentId);
    const unhealthy = history.find((entry) => entry.status !== "healthy");
    if (unhealthy) {
      return {
        deletedCount: 0,
        cleanupError: `快照 v${unhealthy.revision} 损坏或资源不完整，已暂停自动整理并保留全部历史版本。`,
      };
    }
    const pruneOutcome = await this.enqueueWrite(() =>
      this.database.transaction((database) => {
        const rows = database
          .prepare(
            `SELECT revision, model_version, payload, content_hash, created_at, source
             FROM snapshots
             WHERE patent_id = ?
             ORDER BY revision DESC`,
          )
          .all(patentId) as SnapshotRow[];
        // Resource checks await disk reads. Recheck the immutable history before deleting
        // so a concurrent create/delete or damaged payload cannot invalidate that check.
        if (
          rows.length !== history.length ||
          rows.some(
            (row, index) =>
              row.revision !== history[index]?.revision ||
              row.created_at !== history[index]?.createdAt,
          )
        )
          return null;
        try {
          for (const row of rows) decodePatentRecoverySnapshot(row);
        } catch {
          return null;
        }
        // Recovery replays the edit journal forward from a snapshot. A snapshot is only
        // usable while every target revision between it and the live patent revision is
        // still present, so trimming the journal must never strand the newest snapshots.
        const protectedRevisions = usableRecoveryRevisions(
          database,
          patentId,
          new Set(rows.map((row) => row.revision)),
          PROTECTED_RECOVERY_ANCHORS,
        );
        if (protectedRevisions.length === 0) {
          return {
            deletedCount: 0,
            skippedReason:
              "编辑流水与快照无法相互印证：没有可重放到当前修订的快照。已暂停本次自动整理并保留全部历史；请在文档库中对该专利执行“修复并打开”。",
          };
        }
        const retained = retainedSnapshotRevisions(
          rows.map((row) => ({ revision: row.revision, createdAt: row.created_at })),
          this.now(),
        );
        // Retention may only drop snapshots that recovery does not depend on.
        const keep = new Set<number>([...retained, ...protectedRevisions]);
        const deleteRevisions = rows
          .filter((row) => !keep.has(row.revision))
          .map((row) => row.revision);
        if (deleteRevisions.length > 0) {
          const placeholders = deleteRevisions.map(() => "?").join(", ");
          database
            .prepare(
              `DELETE FROM snapshots
               WHERE patent_id = ? AND revision IN (${placeholders})`,
            )
            .run(patentId, ...deleteRevisions);
        }

        // Everything at or below the lowest protected snapshot is captured by that snapshot,
        // so the journal below it can go. The chain above it stays intact for recovery.
        const recoveryFloor = Math.min(...protectedRevisions);
        database
          .prepare("DELETE FROM edit_log WHERE patent_id = ? AND target_revision <= ?")
          .run(patentId, recoveryFloor);
        return { deletedCount: deleteRevisions.length, skippedReason: null };
      }),
    );

    if (pruneOutcome === null) {
      return {
        deletedCount: 0,
        cleanupError: "快照历史在校验期间发生变化，已暂停本次自动整理，稍后重试。",
      };
    }
    if (pruneOutcome.skippedReason !== null) {
      return { deletedCount: 0, cleanupError: pruneOutcome.skippedReason };
    }
    const deletedCount = pruneOutcome.deletedCount;

    let cleanupError: string | null = null;
    try {
      await this.#collectUnusedResources(patentId);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : "快照资源整理失败";
    }
    return { deletedCount, cleanupError };
  }

  async pruneAll(): Promise<SnapshotRetentionRunResult> {
    const patentIds = this.database.read(
      (database) =>
        database
          .prepare("SELECT DISTINCT patent_id FROM snapshots ORDER BY patent_id")
          .all() as Array<{
          patent_id: string;
        }>,
    );
    let deletedCount = 0;
    const cleanupErrors: string[] = [];
    for (const { patent_id: patentId } of patentIds) {
      try {
        const result = await this.prunePatent(patentId);
        deletedCount += result.deletedCount;
        if (result.cleanupError) cleanupErrors.push(`${patentId}: ${result.cleanupError}`);
      } catch (error) {
        cleanupErrors.push(
          `${patentId}: ${error instanceof Error ? error.message : "快照维护失败"}`,
        );
      }
    }
    const cleanupError = cleanupErrors.length === 0 ? null : cleanupErrors.join("; ");
    this.lastError = cleanupError;
    return { deletedCount, cleanupError };
  }

  async #collectUnusedResources(patentId: string): Promise<void> {
    await Promise.all([
      this.collectUnusedAssets?.(patentId),
      this.pendingCreations.has(patentId)
        ? undefined
        : this.collectUnusedFlowchartSources?.(patentId),
    ]);
  }

  async #validateSnapshotResources(
    patentId: string,
    revision: number,
    patent: CanonicalPatent,
  ): Promise<void> {
    if (this.validateAsset) {
      await Promise.all(patent.assets.map((asset) => this.validateAsset?.(asset.assetId)));
    }
    if (patent.flowchartProjects.length > 0) await this.readFlowchartArchive(patentId, revision);
  }

  async #validateSnapshot(patentId: string, revision: number): Promise<void> {
    const token = this.database.changeToken();
    const cached = this.validated.get(patentId);
    if (cached?.token === token && cached.revision === revision) {
      // Database content is unchanged, but files can be replaced outside the app.
      // AssetStore verifies its file fingerprints even on a cache hit.
      if (this.validateAsset)
        await Promise.all(cached.patent.assets.map((asset) => this.validateAsset?.(asset.assetId)));
      return;
    }
    this.validated.delete(patentId);
    const opened = await this.open(patentId, revision);
    await this.#validateSnapshotResources(patentId, revision, opened.patent);
    if (this.database.changeToken() !== token) return;
    const bytes = Buffer.byteLength(JSON.stringify(opened.patent));
    if (bytes > 16 * 1024 * 1024) return;
    this.validated.set(patentId, { token, revision, patent: opened.patent, bytes });
    while (
      this.validated.size > 8 ||
      [...this.validated.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 16 * 1024 * 1024
    ) {
      const oldest = this.validated.keys().next().value;
      if (oldest === undefined) break;
      this.validated.delete(oldest);
    }
  }

  /** Workspace-only entries bridge revisions without producing document history versions. */
  #workspaceOnlySnapshot(
    patentId: string,
    current: CanonicalPatent,
  ): SnapshotCreationResult | null {
    return this.database.read((database) => {
      const row = database
        .prepare(
          "SELECT revision, model_version, payload, content_hash, created_at, source FROM snapshots WHERE patent_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(patentId) as SnapshotRow | undefined;
      if (!row || row.revision >= current.revision) return null;
      try {
        const previous = patentDocumentSnapshot(decodePatentRecoverySnapshot(row).patent);
        const documentHash = hashJson(patentSnapshotContent(previous));
        if (documentHash !== hashJson(patentSnapshotContent(current))) return null;
        const figures = JSON.stringify(previous.figures);
        let revision = row.revision;
        for (const entry of database
          .prepare(
            "SELECT payload, content_hash FROM edit_log WHERE patent_id = ? AND target_revision > ? AND target_revision <= ? ORDER BY target_revision",
          )
          .iterate(patentId, row.revision, current.revision)) {
          const decoded = decodeJson<unknown>(decodeEnvelope(entry.payload as Uint8Array));
          if (hashJson(decoded) !== entry.content_hash) return null;
          const edit = parsePatentEditPayload(decoded);
          if (
            edit.patentId !== patentId ||
            edit.baseRevision !== revision ||
            edit.targetRevision !== revision + 1
          )
            return null;
          if (edit.type === "automation-change" || edit.type === "flowchart-edit") {
            if (hashJson(patentSnapshotContent(edit.patent)) !== documentHash) return null;
          } else if (
            edit.type !== "figure-edit" ||
            edit.descriptionEdit ||
            JSON.stringify(documentSnapshotFigures(edit.figures)) !== figures ||
            edit.abstractDrawingFigureId !== previous.abstractDrawingFigureId
          )
            return null;
          revision = edit.targetRevision;
        }
        if (revision !== current.revision) return null;
        return {
          outcome: "already-exists",
          revision: row.revision,
          createdAt: row.created_at,
          source: row.source,
        };
      } catch {
        // Unverifiable history must get a fresh recovery anchor, not an assumed no-change result.
        return null;
      }
    });
  }

  #creationResultForRevision(
    patentId: string,
    revision: number,
    outcome: SnapshotCreationResult["outcome"],
  ): SnapshotCreationResult | null {
    const row = this.database.read((database) =>
      database
        .prepare(
          `SELECT revision, created_at, source
           FROM snapshots WHERE patent_id = ? AND revision = ?`,
        )
        .get(patentId, revision),
    ) as { revision: number; created_at: string; source: SnapshotSource } | undefined;
    return row
      ? { outcome, revision: row.revision, createdAt: row.created_at, source: row.source }
      : null;
  }
}

/**
 * How many of the newest replayable snapshots are exempt from retention. Keeping more
 * than one preserves a fallback when the newest snapshot turns out to be unreadable.
 */
const PROTECTED_RECOVERY_ANCHORS = 3;

function loadPatentRevision(database: DatabaseSync, patentId: string): number {
  const row = database.prepare("SELECT revision FROM patents WHERE patent_id = ?").get(patentId) as
    | { revision: number }
    | undefined;
  if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
  return row.revision;
}

function usableRecoveryRevisions(
  database: DatabaseSync,
  patentId: string,
  healthy: Set<number>,
  limit = 2,
): number[] {
  const targetRevision = loadPatentRevision(database, patentId);
  const rows = database
    .prepare(
      "SELECT revision, model_version, payload, content_hash FROM snapshots WHERE patent_id = ? ORDER BY revision DESC",
    )
    .all(patentId) as SnapshotRow[];
  const usable: number[] = [];
  for (const row of rows) {
    if (!healthy.has(row.revision)) continue;
    try {
      recoverPatentFromSnapshot(database, patentId, targetRevision, row);
      usable.push(row.revision);
      if (usable.length === limit) break;
    } catch {
      // A readable version is not a recovery fallback if its journal is corrupt or incomplete.
    }
  }
  return usable;
}

function isReadableSnapshot(snapshot: SnapshotRow): boolean {
  try {
    decodePatentRecoverySnapshot(snapshot);
    return true;
  } catch {
    return false;
  }
}

function createContentSummary(patent: CanonicalPatent): SnapshotContentSummary {
  return {
    books: PATENT_BOOK_ORDER.map((kind) => {
      const book = patent.books.find((candidate) => candidate.kind === kind);
      if (!book) throw new LibraryServiceError("CORRUPT_FILE", `Snapshot book missing: ${kind}`);
      const text = visiblePatentBookText(book.document);
      const normalized = text.replace(/\s+/gu, " ").trim();
      return {
        kind,
        characterCount: countUnicodeCharacters(text),
        preview: [...normalized].slice(0, 120).join(""),
      };
    }),
    figureCount: patent.figures.length,
    assetCount: patent.assets.length,
    flowchartCount: patent.flowchartProjects.length,

    referenceMarkCount: patent.referenceMarks.length,
  };
}

function previewVersion(opened: OpenedSnapshot): SnapshotPreviewVersion {
  return {
    abstractDrawingFigureId: opened.patent.abstractDrawingFigureId,
    auxiliaryDocuments: opened.patent.auxiliaryDocuments.map(
      ({ auxiliaryDocumentId, title, document }) => ({
        auxiliaryDocumentId,
        title,
        document: structuredClone(document),
      }),
    ),
    revision: opened.revision,
    createdAt: opened.createdAt,
    books: PATENT_BOOK_ORDER.map((kind) => {
      const book = opened.patent.books.find((candidate) => candidate.kind === kind);
      if (!book) throw new LibraryServiceError("CORRUPT_FILE", `Snapshot book missing: ${kind}`);
      return { kind, document: structuredClone(book.document) };
    }),
    figures: opened.patent.figures.map((figure) => ({
      figureId: figure.figureId,
      assetId: figure.assetId,
      widthMm: figure.widthMm,
      rotationDeg: figure.rotationDeg ?? 0,
    })),
  };
}

function isUnreadableSnapshotError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof PlaintextCodecError ||
    (error instanceof LibraryServiceError && error.code === "CORRUPT_FILE")
  );
}

function linkSnapshotFlowchartRevisions(
  database: DatabaseSync,
  patentId: string,
  snapshotRevision: number,
  projects: CanonicalPatent["flowchartProjects"],
): void {
  database
    .prepare(
      "DELETE FROM snapshot_flowchart_revisions WHERE patent_id = ? AND snapshot_revision = ?",
    )
    .run(patentId, snapshotRevision);
  const link = database.prepare(
    `INSERT INTO snapshot_flowchart_revisions(
       patent_id, snapshot_revision, project_id, source_revision_id
     )
     SELECT ?, ?, ?, source_revision_id
     FROM patent_flowchart_source_revisions
     WHERE patent_id = ? AND project_id = ? AND project_revision = ? AND source_sha256 = ?`,
  );
  for (const project of projects) {
    const result = link.run(
      patentId,
      snapshotRevision,
      project.projectId,
      patentId,
      project.projectId,
      project.revision,
      project.sourceSha256,
    );
    if (Number(result.changes) !== 1) {
      throw new LibraryServiceError("CORRUPT_FILE", "Snapshot flowchart source is missing.");
    }
  }
}

function loadPatent(
  database: DatabaseSync,
  patentId: string,
): { revision: number; patent: CanonicalPatent } {
  const row = database
    .prepare(
      `SELECT patent_id,
              name,
              customer,
              patent_type,
              drawing_books_enabled,
              revision,
              created_at,
              modified_at,
              deleted_at
       FROM patents
       WHERE patent_id = ?`,
    )
    .get(patentId) as PatentRow | undefined;
  if (row === undefined || row.deleted_at !== null) {
    throw new LibraryServiceError("NOT_FOUND", "Patent not found.");
  }
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
    .all(patentId) as PatentBookRow[];
  const figures = database
    .prepare(
      `SELECT figure_id, asset_id, width_mm, flowchart_link
           FROM patent_figures
           WHERE patent_id = ?
           ORDER BY position`,
    )
    .all(patentId) as PatentFigureRow[];
  const auxiliaryDocuments = database
    .prepare(
      `SELECT auxiliary_document_id, title, revision, document_json,
              editor_state_json, source_file_name
       FROM patent_auxiliary_documents
       WHERE patent_id = ?
       ORDER BY position`,
    )
    .all(patentId) as PatentAuxiliaryDocumentRow[];
  const importReportRow = database
    .prepare("SELECT report_json FROM patent_import_reports WHERE patent_id = ?")
    .get(patentId) as { report_json: Uint8Array } | undefined;
  const figureStateRow = database
    .prepare("SELECT value FROM library_state WHERE key = ?")
    .get(`patent:${patentId}:figure-state`) as { value: Uint8Array } | undefined;
  const figureState =
    figureStateRow === undefined
      ? { assets: [], abstractDrawingFigureId: null }
      : storedJson<PatentFigureState>(figureStateRow.value);
  const referenceMarkStateRow = database
    .prepare("SELECT value FROM library_state WHERE key = ?")
    .get(`patent:${patentId}:reference-mark-state`) as { value: Uint8Array } | undefined;
  const descriptionBook = books.find((book) => book.kind === "description");
  const descriptionDocument = descriptionBook
    ? migrateBookDocument(storedJson<PatentBookDocument>(descriptionBook.document_json))
    : undefined;
  const referenceMarkState: PatentReferenceMarkState =
    referenceMarkStateRow === undefined
      ? {
          // 旧库没有 reference-mark-state 行：从当前说明书图例派生，不写库、不改正文。
          referenceMarks: deriveReferenceMarksFromDescription(descriptionDocument),
          referenceMarkSettings: { synchronizedEditingEnabled: false },
        }
      : storedJson<PatentReferenceMarkState>(referenceMarkStateRow.value);

  const patent = CanonicalPatentSchema.parse({
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
    books: books.map((book) => ({
      bookId: book.book_id,
      kind: book.kind,
      document: migrateBookDocument(storedJson<PatentBookDocument>(book.document_json)),
      editorState: storedJson<JsonObject>(book.editor_state_json),
      localRevision: book.revision,
      persistedRevision: book.revision,
    })),
    auxiliaryDocuments: auxiliaryDocuments.map(
      (item): AuxiliaryDocument => ({
        auxiliaryDocumentId: item.auxiliary_document_id,
        title: item.title,
        document: migrateBookDocument(storedJson<PatentBookDocument>(item.document_json)),
        editorState: storedJson<JsonObject>(item.editor_state_json),
        localRevision: item.revision,
        persistedRevision: item.revision,
        sourceFileName: item.source_file_name,
      }),
    ),
    docxImportReport:
      importReportRow === undefined
        ? null
        : DocxImportReportSchema.parse(storedJson(importReportRow.report_json)),
    figures: figures.map(
      (figure): PatentFigure => ({
        figureId: figure.figure_id,
        assetId: figure.asset_id,
        widthMm: figure.width_mm,
        rotationDeg: figureState.rotations?.[figure.figure_id] ?? 0,
      }),
    ),
    flowchartProjects: [],
    abstractDrawingFigureId: figureState.abstractDrawingFigureId,
    assets: figureState.assets,
    drawingProjects: [],

    referenceMarks: referenceMarkState.referenceMarks,
    referenceMarkSettings: referenceMarkState.referenceMarkSettings,
  });

  if (patent.books.map((book) => book.kind).join("|") !== PATENT_BOOK_ORDER.join("|")) {
    throw new LibraryServiceError("CORRUPT_FILE", "Patent books are incomplete.");
  }
  return { revision: row.revision, patent: patentDocumentSnapshot(patent) };
}

function storedJson<T>(value: Uint8Array): T {
  return decodeJson<T>(decodeEnvelope(value));
}

function migrateBookDocument(input: unknown): PatentBookDocument {
  const result = migratePatentBookDocument(input);
  if (!result.ok) throw new LibraryServiceError("CORRUPT_FILE", result.error.message);
  return result.value;
}
