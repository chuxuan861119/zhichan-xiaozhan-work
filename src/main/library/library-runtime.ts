import { join } from "node:path";
import type { LibraryInitializationFailure } from "../../shared/recovery/startup-recovery.js";
import { settleShutdownTasks } from "../application-lifecycle.js";
import { FlowchartService } from "../flowcharts/flowchart-service.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { ContentSearchService } from "../search/content-search-service.js";
import { AssetCleanupScheduler } from "./asset-cleanup-scheduler.js";
import { isolateLibraryAssets } from "./asset-isolation.js";
import { AssetStore } from "./asset-store.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { LibrarySafetyBackupService } from "./library-safety-backup.js";
import { LibraryService } from "./library-service.js";
import { PatentHistoryDeletion } from "./patent-history-deletion.js";
import { PatentService } from "./patent-service.js";
import { PatentTemplateService } from "./patent-template-service.js";
import { LibraryRecoveryService, type RecoveryReport } from "./recovery-service.js";
import { SnapshotService } from "./snapshot-service.js";
import { TrashPurgeScheduler } from "./trash-purge-scheduler.js";

export type CreateLibraryRuntimeOptions = Readonly<{
  libraryRoot: string;
  userDataRoot?: string;
  readOnly: boolean;
  runRecovery: boolean;
  startBackgroundSchedulers: boolean;
  /** Migration validation must retain every manifest-declared byte until install validation. */
  preserveAssetsForMigration?: boolean;
}>;

export type LibraryRuntime = Readonly<{
  contentSearch?: ContentSearchService;
  database: LibraryDatabase;
  assetStore: AssetStore;
  library: LibraryService;
  patents: PatentService;
  patentTemplates: PatentTemplateService;
  snapshots: SnapshotService;
  recovery: LibraryRecoveryService;
  recoveryReport: RecoveryReport;
  flowchartSourceStore: FlowchartSourceStore;
  flowcharts: FlowchartService;

  backgroundScheduler: TrashPurgeScheduler;
  readOnly: boolean;
  close(): Promise<void>;
}>;

export class LibraryRuntimePreparationError extends Error {
  readonly code: "UNSUPPORTED_LIBRARY_SCHEMA" | "LIBRARY_INITIALIZATION_FAILED";

  constructor(readonly reason: LibraryInitializationFailure | "unsupported-schema") {
    super(`Library preparation failed: ${reason}`);
    this.code =
      reason === "unsupported-schema"
        ? "UNSUPPORTED_LIBRARY_SCHEMA"
        : "LIBRARY_INITIALIZATION_FAILED";
    this.name = "LibraryRuntimePreparationError";
  }
}

const skippedRecoveryReport = (): RecoveryReport => ({
  mode: "read-write",
  recoveredPatentIds: [],
  quarantinedPatentIds: [],
  replayedEditCount: 0,
  backupPath: null,
});

export async function createLibraryRuntime(
  options: CreateLibraryRuntimeOptions,
): Promise<LibraryRuntime> {
  let contentSearch: ContentSearchService | undefined;
  let database: LibraryDatabase | undefined;
  let scheduler: TrashPurgeScheduler | undefined;
  let assetCleanup: AssetCleanupScheduler | undefined;
  let flowchartSourceStore: FlowchartSourceStore | undefined;
  let flowcharts: FlowchartService | undefined;
  try {
    const prepared = await new LibraryMigrationService(options.libraryRoot).prepare();
    if (prepared.status !== "ready") {
      prepared.database?.close();
      if (prepared.status === "upgrade-failed" && prepared.reason === "unsupported-schema") {
        throw new LibraryRuntimePreparationError("unsupported-schema");
      }
      throw new LibraryRuntimePreparationError(
        prepared.status === "read-only-corrupt" ? "validation-failed" : prepared.reason,
      );
    }
    database = prepared.database;
    const assetStore = new AssetStore({ root: options.libraryRoot, database });
    const cleanup = new AssetCleanupScheduler(assetStore);
    // No resource cleanup before recovery and ownership migration establish writability.
    const resumeCleanup = await cleanup.suspend();
    assetCleanup = cleanup;
    const sourceStore = new FlowchartSourceStore({ database });
    flowchartSourceStore = sourceStore;
    const snapshots = new SnapshotService({
      database,
      readAssetPreview: (assetId) => assetStore.preview(assetId),
      leaseAssets: (assetIds) => assetStore.leaseSnapshotAssets(assetIds),
      collectUnusedAssets: async (patentId) => {
        await cleanup.collect({ kind: "patent", patentId });
      },
      collectUnusedFlowchartSources: async (patentId) => {
        sourceStore.collectUnreferenced(patentId);
      },
      validateAsset: async (assetId) => {
        await assetStore.readVerifiedDescriptor(assetId);
      },
    });
    const recovery = new LibraryRecoveryService({
      database,
      assetStore,
      safetyBackup: new LibrarySafetyBackupService(options.libraryRoot),
      rebuildRecoveryAnchor: (patentId) => snapshots.rebuildRecoveryAnchor(patentId),
    });
    const recoveryReport = options.runRecovery ? await recovery.open() : skippedRecoveryReport();
    let readOnly = options.readOnly || recoveryReport.mode === "read-only";
    const historyDeletion = options.userDataRoot
      ? new PatentHistoryDeletion(join(options.userDataRoot, "text-polish-history"))
      : undefined;
    if (!readOnly && historyDeletion)
      recoveryReport.historyCleanupPendingPatentIds = historyDeletion.reconcile((patentId) =>
        prepared.database.read(
          (raw) =>
            raw.prepare("SELECT 1 FROM patents WHERE patent_id = ?").get(patentId) !== undefined,
        ),
      );
    if (!readOnly) {
      await snapshots.reconcileAssetReferences();
      if (!options.preserveAssetsForMigration) {
        try {
          await isolateLibraryAssets({ root: options.libraryRoot, database, assets: assetStore });
        } catch (error) {
          // Isolation rolls references back. Keep the library accessible, but never
          // allow edits or GC against unfinished ownership migration.
          readOnly = true;
          recoveryReport.mode = "read-only";
          recoveryReport.assetIsolationPending = true;
          recoveryReport.assetIsolationFailure = error;
        }
      }
      // Retry interrupted cleanup even if the last owning patent has been deleted.
      if (!readOnly && !options.preserveAssetsForMigration) {
        await resumeCleanup();
        await cleanup.collect();
      }
    }
    const library = new LibraryService({
      database,
      collectUnusedAssets: async (libraryDocumentId) => {
        await cleanup.collect({ kind: "library-document", libraryDocumentId });
      },
    });
    const patents = new PatentService({
      database,
      preparePermanentDelete: async (patentId) =>
        contentSearch ? contentSearch.preparePermanentDelete(patentId) : () => {},
      ...(historyDeletion
        ? {
            deleteWithHistory: (patentId: string, commit: () => void) =>
              historyDeletion.run(patentId, commit),
          }
        : {}),
      assetStore,
      adoptAsset: (owner, assetId) => assetStore.adopt(owner, assetId),
      collectUnusedAssets: async (patentId) => {
        await cleanup.collect({ kind: "patent", patentId });
      },
    });
    const patentTemplates = new PatentTemplateService({
      database,
      assetStore,
      loadPatent: (patentId) => patents.loadSavedPatent(patentId),
    });
    const flowchartService = new FlowchartService({
      database,
      sourceStore,
      patentService: patents,
      assetStore,
    });
    flowcharts = flowchartService;
    scheduler = new TrashPurgeScheduler(patents, undefined, cleanup);

    if (!readOnly && options.startBackgroundSchedulers) scheduler.start();

    if (!readOnly && options.userDataRoot && options.startBackgroundSchedulers) {
      contentSearch = new ContentSearchService({
        libraryRoot: options.libraryRoot,
        cacheRoot: join(options.userDataRoot, "content-search-cache"),
      });
      // Start maintenance independently; a cache failure must never block the editor.
      void contentSearch.request({ action: "status" }).catch(() => undefined);
    }
    let closing: Promise<void> | undefined;
    return {
      ...(contentSearch ? { contentSearch } : {}),
      database,
      assetStore,
      library,
      patents,
      patentTemplates,
      snapshots,
      recovery,
      recoveryReport,
      flowchartSourceStore: sourceStore,
      flowcharts: flowchartService,

      backgroundScheduler: scheduler,
      readOnly,
      close() {
        if (closing !== undefined) return closing;
        closing = (async () => {
          try {
            await settleShutdownTasks([() => contentSearch?.close(), () => scheduler?.close()]);
          } finally {
            await settleShutdownTasks([
              () => flowchartService.dispose(),
              () => sourceStore.dispose(),
              () => database?.close(),
            ]);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await scheduler?.close();
      await assetCleanup?.close();
    } finally {
      flowcharts?.dispose();
      flowchartSourceStore?.dispose();
      database?.close();
    }
    throw error;
  }
}
