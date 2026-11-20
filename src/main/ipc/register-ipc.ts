/// <reference types="electron-vite/node" />
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as electronIpcMain,
  type IpcMainInvokeEvent,
  nativeImage,
  safeStorage,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import writeFileAtomic from "write-file-atomic";
import { ZodError, z } from "zod";
import {
  AutomationError,
  type AutomationEvent,
  AutomationUiRequestSchema,
} from "../../shared/automation/protocol.js";
import {
  APPLICATION_DOCUMENT_TYPE_NAME,
  APPLICATION_NAME,
  APPLICATION_VERSION,
} from "../../shared/branding.js";
import { referencedDocumentAssetIds } from "../../shared/document/asset-references.js";
import { publicDocxExportIssue } from "../../shared/exports/docx-error-message.js";
import { createDocxDefaultFilename } from "../../shared/exports/docx-filename.js";
import { auxiliaryExportDocument } from "../../shared/exports/patent-export-scope.js";
import {
  ActivateDocumentSessionRequestSchema,
  AppSettingsPatchSchema,
  AssetReferenceRequestSchema,
  AuxiliaryDocumentExportRequestSchema,
  BackupConfigureRequestSchema,
  BackupTargetSchema,
  CadConvertRequestSchema,
  CadExportRequestSchema,
  CadPrepareRequestSchema,
  ChemicalPreviewRequestSchema,
  ChemicalPreviewResultSchema,
  ChemicalStructureSourceResultSchema,
  ClipboardImageSchema,
  ClipboardTextSchema,
  ClipboardTextWriteRequestSchema,
  CopyImagesRequestSchema,
  DesignImageProcessRequestSchema,
  DesignPatentExportRequestSchema,
  DirectPrintRequestSchema,
  DiscardImportedAssetsRequestSchema,
  DrawingCancelImportSchema,
  DrawingImportRequestSchema,
  DrawingTileRequestSchema,
  ExportRequestSchema,
  FlowchartPdfRequestSchema,
  FormulaDrawingRenderRequestSchema,
  FormulaDrawingRenderResultSchema,
  ImportAssetBatchRequestSchema,
  ImportAssetRequestSchema,
  IPC_CHANNELS,
  type IpcChannel,
  imageClipboardMarker,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
  MAX_IMAGE_IMPORT_BATCH_BYTES,
  MAX_IMAGE_IMPORT_COUNT,
  PatdocPathSchema,
  PatentDocxExportRequestSchema,
  PatentTemplateCaptureCurrentRequestSchema,
  PatentTemplateEditorCloseRequestSchema,
  PatentTemplateEditorOpenRequestSchema,
  PatentTemplateEditorSaveRequestSchema,
  PRELOAD_INVOKE_CHANNELS,
  PreviewIdSchema,
  PrintPreviewRequestSchema,
  type SaveDocumentRequest,
  SaveDocumentRequestSchema,
  SaveDraftRequestSchema,
  SaveImageRequestSchema,
  SaveImagesRequestSchema,
  SavePreviewPdfRequestSchema,
  SessionIdSchema,
  SnapshotContentPreviewRequestSchema,
  SnapshotCreateRequestSchema,
  type SnapshotListResult,
  SnapshotPreviewAssetRequestSchema,
  SnapshotRestoreRequestSchema,
  SnapshotSettingsSchema,
  StableIdSchema,
  StageAssetReferencesRequestSchema,
  StageDesignEditorProjectRequestSchema,
  StorageFolderKindSchema,
} from "../../shared/ipc/contract.js";
import {
  type AppError,
  type AppErrorCode,
  type AppResult,
  normalizeAppError,
} from "../../shared/ipc/result.js";
import { AgreementAcceptSchema } from "../../shared/legal/model.js";
import { ContentSearchRequestSchema } from "../../shared/library/content-search.js";
import { redDraftClipboardFormats } from "../../shared/patent/claims-draft-clipboard.js";
import { richDraftClipboardFormats } from "../../shared/patent/claims-rich-text.js";
import { validateEditorBinaryHeader } from "../../shared/patent/design-editor-binary.js";
import { DESIGN_IMAGE_EXTENSIONS } from "../../shared/patent/design-image-formats.js";
import { inspectDesignPatent } from "../../shared/patent/design-patent.js";
import type { PatentTemplateEditorSnapshot } from "../../shared/patent/template-catalog.js";
import {
  isAgentCliAvailable,
  isHarmonyPlatform,
  isNetworkAiAvailable,
} from "../../shared/platform.js";
import { RecoverySourceSchema } from "../../shared/recovery/self-service-recovery.js";
import type { StartupRecoveryReport } from "../../shared/recovery/startup-recovery.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../../shared/snapshot/model.js";
import { TutorialLessonIdSchema } from "../../shared/tutorial/model.js";
import { StableVersionSchema, UpdateDismissSchema } from "../../shared/updates/model.js";
import { UsageChoiceSchema } from "../../shared/usage-statistics/model.js";
import {
  AiCorrectionEventRouter,
  TextPolishConversationEventRouter,
  TextPolishEventRouter,
} from "../ai-correction/ai-correction-event-router.js";
import { AiCredentialVault } from "../ai-correction/ai-credential-vault.js";
import { AiConnectionGate } from "../ai-correction/connection-gate.js";
import {
  createHttpsJsonClient,
  createHttpsJsonGetter,
} from "../ai-correction/https-json-client.js";
import { createHttpsSseClient } from "../ai-correction/https-sse-client.js";
import { AiModelDiscoveryService } from "../ai-correction/model-discovery.js";
import { OpenAiCompatibleProvider } from "../ai-correction/openai-compatible-provider.js";
import { PatentCorrectionService } from "../ai-correction/patent-correction-service.js";
import { PatentPolishService } from "../ai-correction/patent-polish-service.js";
import { registerAiCorrectionIpc } from "../ai-correction/register-ai-correction-ipc.js";
import { TextPolishHistoryStore } from "../ai-correction/text-polish-history-store.js";
import { AiUploadConsent } from "../ai-correction/upload-consent.js";
import { AppOperationError } from "../app-operation-error.js";
import { settleShutdownTasks } from "../application-lifecycle.js";
import type { PersistentAssetStore } from "../assets/asset-store.js";
import { AssetStore } from "../assets/asset-store.js";
import { prepareCadAssets } from "../assets/cadcraft-assets.js";
import { runCadCodec } from "../assets/cadcraft-runtime.js";
import { DrawingImportJobs } from "../assets/drawing-import-jobs.js";
import { DrawingImportProgress, DrawingTimingHistory } from "../assets/drawing-import-progress.js";
import { importDrawing } from "../assets/drawing-importer.js";
import {
  decodeBmpToBgra,
  ImageImportError,
  importImage,
  MAX_IMAGE_BYTES,
} from "../assets/image-importer.js";
import {
  type ImageOutputFormat,
  imageHasTransparency,
  renderEditedImage,
} from "../assets/image-output-service.js";
import {
  formatAgentAccessInstructions,
  resolveAgentCliEntry,
} from "../automation/access-instructions.js";
import { runAutomationAi } from "../automation/ai.js";
import { createElectronAuthorizationAttention } from "../automation/authorization-attention-electron.js";
import { AutomationConversations } from "../automation/conversations.js";
import { exportAutomationPatent } from "../automation/export.js";
import { renderAutomationGraphic } from "../automation/graphics.js";
import { AutomationHub, type AutomationHubOptions } from "../automation/hub.js";
import { TransferHandoffStore } from "../automation/transfer-handoff.js";
import { supportsAutomationImportCommit } from "../automation/transfer-import.js";
import { backupFileError } from "../backup/backup-errors.js";
import { BackupService, type DocumentModifiedInfo } from "../backup/backup-service.js";
import {
  isChemicalPreviewError,
  rasterizeChemicalStructureAsset,
  validateChemicalPreviewSvg,
} from "../chemistry/chemical-preview-service.js";
import { readChemicalStructureSource } from "../chemistry/structure-source.js";
import { DataImportJournal } from "../data-transfer/data-import-journal.js";
import {
  DataTransferOperationError,
  getDataTransferOperationGate,
} from "../data-transfer/data-transfer-operation-gate.js";
import { DataTransferQuiescence } from "../data-transfer/data-transfer-quiescence.js";
import { EmptyLibraryInspector } from "../data-transfer/empty-library-inspector.js";
import { FullDataExportService } from "../data-transfer/full-data-export-service.js";
import { FullDataImportService } from "../data-transfer/full-data-import-service.js";
import { ImportStagingValidator } from "../data-transfer/import-staging-validator.js";
import {
  LibraryImportSwapCoordinator,
  LibraryImportSwapError,
} from "../data-transfer/library-import-swap-coordinator.js";
import { PackageReader, TransferSourceHandle } from "../data-transfer/package-reader.js";
import {
  registerDataTransferIpc,
  TransferSelectionRegistry,
} from "../data-transfer/register-data-transfer-ipc.js";
import {
  exportDesignPatentDocx,
  exportDesignPatentPdf,
  renderDesignPatentBriefHtml,
} from "../design-patent/design-patent-exporter.js";
import { EditorResourceAdmissionError } from "../design-patent/editor-operation-pool.js";
import { readPersistedEditorProject } from "../design-patent/editor-project-reader.js";
import { stageEditorProject } from "../design-patent/editor-project-staging.js";
import { prepareDesignEditorSource } from "../design-patent/editor-source.js";
import { registerEditorWorkspaceResources } from "../design-patent/editor-workspace-ipc.js";
import {
  EditorWorkspaceConflictError,
  EditorWorkspaceLeases,
} from "../design-patent/editor-workspace-leases.js";
import { processDesignImage } from "../design-patent/image-processor.js";
import { TemporaryImageBatch } from "../design-patent/temporary-image-batch.js";
import { TemporaryImageFiles } from "../design-patent/temporary-image-files.js";
import { registerTemporaryImageIpc } from "../design-patent/temporary-image-ipc.js";
import { TemporaryImageJobs } from "../design-patent/temporary-image-jobs.js";
import { writeTemporaryImageExclusive } from "../design-patent/temporary-image-output.js";
import createTemporaryImageWorker from "../design-patent/temporary-image-worker?nodeWorker";
import { DocumentRegistry, normalizeDocumentPath } from "../documents/document-registry.js";
import { FileService } from "../documents/file-service.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import { DocxImportSessionService } from "../docx-import/docx-import-session-service.js";
import { DraftService } from "../drafts/draft-service.js";
import { createDocxPackage, DocxExportError, saveDocxToPath } from "../exports/docx-exporter.js";
import { renderFormulaFallback } from "../exports/formula-fallback.js";
import { createPatentDocxPackage, savePatentDocxToPath } from "../exports/patent-docx-exporter.js";
import { loadPatentExportAssets } from "../exports/patent-export-assets.js";
import { createPatentPrintPackage } from "../exports/patent-print-template.js";
import { mapPrintError } from "../exports/print-error.js";
import { printDocumentStore } from "../exports/print-protocol.js";
import { PrintService } from "../exports/print-service.js";
import { renderPrintHtml } from "../exports/print-template.js";
import { toPrinterDescriptors } from "../exports/printer-info.js";
import { buildFlowchartPdfHtml } from "../flowcharts/flowchart-pdf.js";
import { saveIpcReport } from "../ipc-data-center/save-ipc-report.js";
import type { AgreementService } from "../legal/agreement-service.js";
import { openBundledThirdPartyLicenses, openBundledThirdPartyNotices } from "../legal-notices.js";
import { performLegislationAction } from "../legislation.js";
import { LegacyDraftMigrationService } from "../library/legacy-draft-migration.js";
import { LegacyDraftMigrationStateFile } from "../library/legacy-draft-migration-state.js";
import type { LibraryDatabase } from "../library/library-database.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { LibraryService } from "../library/library-service.js";
import {
  importPatdocPayload,
  importPatentPatdocPayload,
  type RegisterLibraryIpcOptions,
  registerLibraryIpcHandlers,
} from "../library/register-library-ipc.js";
import { SelfServiceRecovery } from "../library/self-service-recovery.js";
import { SnapshotTimer } from "../library/snapshot-timer.js";
import type { TrashPurgeScheduler } from "../library/trash-purge-scheduler.js";
import type { SafeLogger } from "../logging/safe-log.js";
import { openOfficialWebsite } from "../official-websites.js";
import { OpenPathAuthorization } from "../open-path-authorization.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import { createHarmonySystem, type HarmonyBridge } from "../platform/harmony-system.js";
import { drawingRuntimeRoot, usesInstalledResources } from "../platform/resource-layout.js";
import { SettingsService } from "../settings/settings-service.js";
import { createStartupService } from "../settings/startup-service.js";
import { inspectStorageFolder } from "../settings/storage-overview.js";
import { createDesktopShortcut } from "../shortcuts/shortcut-service.js";
import type { TutorialLauncher } from "../tutorial/launcher.js";
import type { TutorialSeedService } from "../tutorial/seed.js";
import { tutorialAllowsChannel } from "../tutorial/session.js";
import { softwareUpdateConfig, softwareUpdateTestMode } from "../updates/update-config.js";
import { SoftwareUpdateService } from "../updates/update-service.js";
import type { UsageStatisticsService } from "../usage-statistics/usage-statistics-service.js";
import { MUTATING_IPC_CHANNELS } from "./mutating-channels.js";
import { type OperationContext, OperationCoordinator } from "./operation-coordinator.js";
import {
  type OwnedDialogEvent,
  showOwnedOpenDialog,
  showOwnedSaveDialog,
} from "./owned-native-dialog.js";
import { registerPatentBundleIpc } from "./register-patent-bundle-ipc.js";
import { registerPatentFolderIpc } from "./register-patent-folder-ipc.js";
import { SessionLifecycle } from "./session-lifecycle.js";

const serviceNotConnected: AppResult<never> = {
  ok: false,
  error: normalizeAppError({ code: "INTERNAL", message: "normalized" }),
};

const RendererSnapshotCreateRequestSchema = SnapshotCreateRequestSchema.extend({
  source: z.enum(["manual-save", "manual-create", "patent-close", "application-close"]),
});

type RendererLifecycleOwner = {
  once(event: "destroyed", listener: () => void): unknown;
  isDestroyed?(): boolean;
};

function rendererLifecycleOwner(event: unknown): RendererLifecycleOwner | undefined {
  if (typeof event !== "object" || event === null || !("sender" in event)) return undefined;
  const { sender } = event as { sender: unknown };
  if (typeof sender !== "object" || sender === null || !("once" in sender)) return undefined;
  return typeof sender.once === "function" ? (sender as RendererLifecycleOwner) : undefined;
}

function isTrustedApplicationWindow(event: IpcMainInvokeEvent): boolean {
  if (
    !event.sender ||
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false;
  try {
    // Electron serializes entry URLs; development origins acquire a trailing slash.
    const entry = new URL(process.env.ELECTRON_RENDERER_URL ?? "patent-app://app/index.html").href;
    return event.sender.getURL() === entry;
  } catch {
    return false;
  }
}

function logWithoutBlocking(operation: Promise<boolean> | undefined): void {
  void operation?.catch(() => false);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function templateSlotPreviewAssetIds(
  slot: PatentTemplateEditorSnapshot["catalog"]["invention"]["slots"][number],
): string[] {
  return [slot.claims, slot.description, slot.abstract].flatMap((book) =>
    book
      ? book.content.flatMap((block) =>
          block.type === "chemical-structure" ? [block.previewAssetId] : [],
        )
      : [],
  );
}

async function prepareTemplateEditorSnapshot(
  opened: PatentTemplateEditorSnapshot,
  persistent: PersistentAssetStore | undefined,
): Promise<{
  snapshot: PatentTemplateEditorSnapshot;
  storedAssets: Awaited<ReturnType<PersistentAssetStore["readAsset"]>>[];
}> {
  const snapshot = structuredClone(opened);
  if (!persistent) return { snapshot, storedAssets: [] };
  const storedById = new Map<string, Awaited<ReturnType<PersistentAssetStore["readAsset"]>>>();
  for (const patentType of ["invention", "utility-model"] as const) {
    const group = snapshot.catalog[patentType];
    for (const slot of group.slots) {
      const assetIds = [...new Set(templateSlotPreviewAssetIds(slot))];
      if (assetIds.length === 0) continue;
      try {
        const storedAssets = await Promise.all(
          assetIds.map((assetId) => persistent.readAsset(assetId)),
        );
        for (const stored of storedAssets) storedById.set(stored.descriptor.assetId, stored);
      } catch (error) {
        const code = errorCode(error);
        if (
          code !== "CORRUPT_FILE" &&
          code !== "NOT_FOUND" &&
          !(error instanceof SyntaxError) &&
          !(error instanceof ZodError)
        ) {
          throw error;
        }
        slot.claims = null;
        slot.description = null;
        slot.abstract = null;
        slot.unavailableReason = "模板资源损坏或缺失，请清空后重新填入。";
        if (group.selection.kind === "custom" && group.selection.templateId === slot.templateId) {
          group.selection = { kind: "system" };
        }
      }
    }
  }
  return { snapshot, storedAssets: [...storedById.values()] };
}

export function registerIpcHandlers(
  logger?: SafeLogger,
  openPathAuthorization = new OpenPathAuthorization(),
  libraryIpcOptions?: Omit<RegisterLibraryIpcOptions, "logger" | "readPatentTemplates"> & {
    automationRuntime?: LibraryRuntime;
    dataTransferRuntime?: {
      database: LibraryDatabase;
      libraryRoot: string;
      userDataRoot: string;
      applicationDataRoot: string;
      backgroundScheduler: Pick<TrashPurgeScheduler, "suspend">;
      assets: { waitForIdle(): Promise<{ stagedSessionIds: string[] }> };
      closeRuntime(): Promise<void>;
    };
  },
  startupRecoveryReport?: StartupRecoveryReport,
  startupReadOnly = false,
  authorizeCloseForRelaunch: () => void = () => undefined,
  startupOptions?: {
    settings: SettingsService;
    tutorial?: TutorialSeedService;
    tutorialLauncher?: Pick<TutorialLauncher, "launch">;
    userDataPath?: string;
    onTutorialReady?(): Promise<void>;
    usageStatistics?: UsageStatisticsService;
    agreements?: AgreementService;
    openAutomationAuthorization?(): Promise<void>;
    onCloseToTrayChanged(enabled: boolean): void;
    recoveryLibrary?: {
      sourceRoot: string;
      activate(root: string): Promise<void>;
      restart(): void;
    };
    libraryRelocation?: {
      schedule(parent: string): Promise<string>;
      restart(approved?: boolean): void;
      cancel?(): Promise<void>;
      status?(): Promise<unknown>;
    };
  },
  ipcEndpoint = electronIpcMain,
): () => Promise<void> {
  // A tutorial window owns its handlers; it must never replace the working window's IPC.
  const ipcMain = ipcEndpoint;
  const recoveryLibrary = startupOptions?.recoveryLibrary
    ? new SelfServiceRecovery({
        sourceRoot: startupOptions.recoveryLibrary.sourceRoot,
        activate: startupOptions.recoveryLibrary.activate,
      })
    : undefined;
  let recoveryPreparing = false;
  for (const channel of PRELOAD_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () =>
      startupOptions?.tutorial && !tutorialAllowsChannel(channel)
        ? appFailure("TUTORIAL_RESTRICTED")
        : startupReadOnly && MUTATING_IPC_CHANNELS.has(channel as IpcChannel)
          ? appFailure("READ_ONLY_RECOVERY")
          : !libraryIpcOptions &&
              startupRecoveryReport?.libraryInitializationFailure &&
              (channel === IPC_CHANNELS.patentsList || channel === IPC_CHANNELS.libraryList)
            ? appFailure("LIBRARY_INITIALIZATION_FAILED")
            : serviceNotConnected,
    );
  }

  const operationGate = getDataTransferOperationGate();
  let automation: AutomationHub | undefined;
  let disposeAutomationAttention: (() => void) | undefined;
  let automationStartupError: unknown;
  let automationInitialization: Promise<void> | undefined;
  let assertPolishTransferReady = () => {};
  const register = (channel: string, originalHandler: (...args: unknown[]) => unknown) => {
    const handler = async (...args: unknown[]) => {
      if (startupOptions?.tutorial && !tutorialAllowsChannel(channel))
        return appFailure("TUTORIAL_RESTRICTED");
      const releaseGui: Array<() => void> = [];
      if (automation && MUTATING_IPC_CHANNELS.has(channel as IpcChannel)) {
        const input = args[1];
        const targets: string[] = [];
        if (input && typeof input === "object") {
          const record = input as Record<string, unknown>;
          for (const key of ["patentId", "documentId"])
            if (typeof record[key] === "string") targets.push(record[key]);
          if (typeof record.sessionId === "string") {
            const id = openPatentSessions.get(record.sessionId);
            if (id) targets.push(id);
          }
          if (Array.isArray(record.patents))
            for (const item of record.patents)
              if (item && typeof item.patentId === "string") targets.push(item.patentId);
        }
        for (const id of new Set(targets)) automation.barrier.guardWrite(id);
        for (const id of new Set(targets)) releaseGui.push(automation.beginGuiMutation(id));
      }
      const release =
        (MUTATING_IPC_CHANNELS.has(channel as IpcChannel) &&
          channel !== IPC_CHANNELS.patentsFlush &&
          channel !== IPC_CHANNELS.libraryFlush) ||
        channel.startsWith("exports:") ||
        channel === IPC_CHANNELS.patentsOpen ||
        channel === IPC_CHANNELS.documentsOpenPath
          ? libraryIpcOptions?.contentSearch?.beginOperation()
          : undefined;
      try {
        return await originalHandler(...args);
      } finally {
        release?.();
        for (const finish of releaseGui) finish();
      }
    };
    ipcMain.removeHandler(channel);
    if (!MUTATING_IPC_CHANNELS.has(channel as IpcChannel)) {
      ipcMain.handle(channel, handler);
      return;
    }
    if (
      startupReadOnly &&
      !(
        recoveryLibrary &&
        (channel === IPC_CHANNELS.applicationPrepareRecovery ||
          channel === IPC_CHANNELS.applicationActivateRecovery)
      )
    ) {
      ipcMain.handle(channel, () => appFailure("READ_ONLY_RECOVERY"));
      return;
    }
    const exclusiveOperationKind =
      channel === IPC_CHANNELS.dataTransferExportPackage
        ? "full-data-export"
        : channel === IPC_CHANNELS.dataTransferPrepareImport
          ? "full-data-import"
          : channel === IPC_CHANNELS.dataTransferCommitImport
            ? "library-swap"
            : undefined;
    ipcMain.handle(channel, function (this: unknown, ...args: unknown[]) {
      const operation = exclusiveOperationKind
        ? Promise.resolve(automation?.beforeExclusive()).then(() =>
            operationGate.runExclusive(exclusiveOperationKind, () => {
              assertPolishTransferReady();
              return handler.apply(this, args);
            }),
          )
        : operationGate.runMutation(channel as IpcChannel, () => handler.apply(this, args));
      return operation.catch((error: unknown) => ipcFailure(error, logger));
    });
  };

  const onSearchActivity = (event: Electron.IpcMainEvent) => {
    if (BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame)
      libraryIpcOptions?.contentSearch?.activity();
  };
  if (libraryIpcOptions?.contentSearch)
    ipcMain.on(IPC_CHANNELS.contentSearchActivity, onSearchActivity);
  register(IPC_CHANNELS.contentSearch, async (event, input) => {
    const sender = event as Electron.IpcMainInvokeEvent;
    if (
      !BrowserWindow.fromWebContents(sender.sender) ||
      sender.senderFrame !== sender.sender.mainFrame
    )
      return appFailure("INVALID_INPUT");
    try {
      const contentSearch = libraryIpcOptions?.contentSearch;
      if (!contentSearch) return serviceNotConnected;
      const request = ContentSearchRequestSchema.parse(input);
      await contentSearchInitialization;
      if (request.action === "configure")
        return await operationGate.runMutation(IPC_CHANNELS.contentSearch, async () => {
          await settingsService.update({ contentSearchEnabled: request.enabled });
          return { ok: true, value: await contentSearch.request(request) };
        });
      return { ok: true, value: await contentSearch.request(request) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  const confirmJpegTransparency = async (): Promise<boolean> => {
    const decision = await dialog.showMessageBox({
      type: "warning",
      title: "知产小栈Work",
      message: "JPG 不支持透明背景，透明区域将保存为白色。",
      detail: "是否继续保存？",
      buttons: ["继续保存", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return decision.response === 0;
  };

  let ipcReportSavePending = false;
  register(IPC_CHANNELS.ipcDataSaveReport, async (event, input) => {
    const sender = event as Electron.IpcMainInvokeEvent;
    if (
      !BrowserWindow.fromWebContents(sender.sender) ||
      sender.senderFrame !== sender.sender.mainFrame
    )
      return appFailure("INVALID_INPUT");
    if (ipcReportSavePending) return appFailure("INVALID_INPUT");
    ipcReportSavePending = true;
    try {
      const value = await saveIpcReport(input, async (filename) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "保存预审报告",
          defaultPath: filename,
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        });
        return selection.canceled || !selection.filePath ? null : selection.filePath;
      });
      return { ok: true, value };
    } catch (error) {
      return ipcFailure(error, logger);
    } finally {
      ipcReportSavePending = false;
    }
  });

  const assetStore = libraryIpcOptions
    ? new AssetStore({ persistent: libraryIpcOptions.assetStore })
    : new AssetStore();
  const documentRegistry = new DocumentRegistry();
  const printService = new PrintService(assetStore, {
    createWindow: (options) => new BrowserWindow(options),
    createPrintDocument: (html) => printDocumentStore.publish(html),
  });
  const fileService = new FileService();
  const userDataPath = startupOptions?.userDataPath ?? app.getPath("userData");
  const settingsService =
    startupOptions?.settings ?? new SettingsService(join(userDataPath, "settings.json"));
  const harmony = isHarmonyPlatform(process.platform)
    ? createHarmonySystem(systemPreferences as HarmonyBridge)
    : undefined;
  const startupService = createStartupService(
    app,
    process.platform,
    process.execPath,
    undefined,
    harmony,
  );
  register(IPC_CHANNELS.applicationStartupRead, async () => {
    try {
      return { ok: true, value: await startupService.read() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationStartupUpdate, async (event, input) => {
    try {
      const sender = event as Electron.IpcMainInvokeEvent;
      if (
        !BrowserWindow.fromWebContents(sender.sender) ||
        sender.senderFrame !== sender.sender.mainFrame
      )
        throw new Error("Invalid startup settings request");
      return { ok: true, value: await startupService.update(z.boolean().parse(input)) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  const readSettings = () =>
    startupReadOnly ? settingsService.readReadOnly() : settingsService.read();
  for (const channel of [
    IPC_CHANNELS.tutorialRead,
    IPC_CHANNELS.tutorialReady,
    IPC_CHANNELS.tutorialLaunch,
    IPC_CHANNELS.tutorialPrepare,
  ]) {
    register(channel, async (event, input) => {
      const sender = event as IpcMainInvokeEvent;
      if (
        !sender.sender ||
        !BrowserWindow.fromWebContents(sender.sender) ||
        sender.senderFrame !== sender.sender.mainFrame
      )
        return appFailure("INVALID_INPUT");
      try {
        if (channel === IPC_CHANNELS.tutorialRead)
          return { ok: true, value: startupOptions?.tutorial?.read() ?? null };
        if (channel === IPC_CHANNELS.tutorialReady) {
          if (!startupOptions?.tutorial?.read()) return appFailure("TUTORIAL_RESTRICTED");
          await startupOptions.onTutorialReady?.();
          return { ok: true, value: undefined };
        }
        const lessonId = TutorialLessonIdSchema.parse(input);
        if (channel === IPC_CHANNELS.tutorialPrepare) {
          if (!startupOptions?.tutorial) return appFailure("TUTORIAL_RESTRICTED");
          return { ok: true, value: await startupOptions.tutorial.prepare(lessonId) };
        }
        if (!startupOptions?.tutorialLauncher || startupReadOnly)
          return appFailure("TUTORIAL_RESTRICTED");
        await startupOptions.tutorialLauncher.launch(lessonId);
        return { ok: true, value: undefined };
      } catch (error) {
        return ipcFailure(error, logger);
      }
    });
  }
  for (const channel of [IPC_CHANNELS.agreementsRead, IPC_CHANNELS.agreementsAccept]) {
    register(channel, async (event, input) => {
      const sender = event as IpcMainInvokeEvent;
      if (!isTrustedApplicationWindow(sender)) return appFailure("INVALID_INPUT");
      const service = startupOptions?.agreements;
      if (!service) return serviceNotConnected;
      try {
        const state =
          channel === IPC_CHANNELS.agreementsRead
            ? await service.read()
            : await service.accept(AgreementAcceptSchema.parse(input));
        if (!state.needsConfirmation)
          void readSettings()
            .then((settings) => updates.start(settings.autoCheckUpdates))
            .catch(() => undefined);
        return { ok: true, value: state };
      } catch (error) {
        return ipcFailure(error, logger);
      }
    });
  }
  for (const channel of [IPC_CHANNELS.usageStatisticsRead, IPC_CHANNELS.usageStatisticsChoose]) {
    register(channel, async (event, input) => {
      const sender = event as IpcMainInvokeEvent;
      if (!isTrustedApplicationWindow(sender)) return appFailure("INVALID_INPUT");
      const service = startupOptions?.usageStatistics;
      if (!service) return serviceNotConnected;
      try {
        return {
          ok: true,
          value:
            channel === IPC_CHANNELS.usageStatisticsRead
              ? await service.read()
              : await service.choose(UsageChoiceSchema.parse(input)),
        };
      } catch (error) {
        return ipcFailure(error, logger);
      }
    });
  }
  const updates = new SoftwareUpdateService({
    currentVersion: APPLICATION_VERSION,
    platform: (process.platform as string) === "ohos" ? "openharmony" : process.platform,
    arch: process.arch,
    statePath: join(userDataPath, "software-updates.json"),
    config: softwareUpdateConfig(app.isPackaged),
    ...(!app.isPackaged &&
    softwareUpdateConfig(true).feedUrl &&
    !softwareUpdateTestMode(app.isPackaged)
      ? { unconfiguredMessage: "开发实例不检查正式更新渠道，请在安装版中检查更新。" }
      : {}),
    ...(softwareUpdateTestMode(app.isPackaged) ? { startupDelayMs: 300 } : {}),
    automaticAllowed:
      !startupOptions?.tutorial &&
      !startupReadOnly &&
      (softwareUpdateTestMode(app.isPackaged) ||
        (app.isPackaged && process.env.PATENT_WORKBENCH_TEST !== "1")),
    readEnabled: async () => (await readSettings()).autoCheckUpdates,
    openExternal: (url) => shell.openExternal(url),
    onChanged: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          try {
            window.webContents.send(IPC_CHANNELS.updatesChanged, state);
          } catch {
            /* The window may close between the check and send. */
          }
        }
      }
    },
  });
  for (const channel of [
    IPC_CHANNELS.updatesRead,
    IPC_CHANNELS.updatesStart,
    IPC_CHANNELS.updatesCheck,
    IPC_CHANNELS.updatesDismiss,
    IPC_CHANNELS.updatesOpenDownload,
  ]) {
    register(channel, async (event, input) => {
      const sender = event as IpcMainInvokeEvent;
      if (
        !sender.sender ||
        !BrowserWindow.fromWebContents(sender.sender) ||
        sender.senderFrame !== sender.sender.mainFrame
      )
        return appFailure("INVALID_INPUT");
      try {
        if (
          (channel === IPC_CHANNELS.updatesStart ||
            channel === IPC_CHANNELS.updatesCheck ||
            channel === IPC_CHANNELS.updatesOpenDownload) &&
          (await startupOptions?.agreements?.read())?.needsConfirmation
        ) {
          return channel === IPC_CHANNELS.updatesOpenDownload
            ? appFailure("INVALID_INPUT")
            : { ok: true, value: updates.state() };
        }
        if (channel === IPC_CHANNELS.updatesStart)
          updates.start((await readSettings()).autoCheckUpdates);
        if (channel === IPC_CHANNELS.updatesCheck)
          return { ok: true, value: await updates.check() };
        if (channel === IPC_CHANNELS.updatesDismiss) {
          const request = UpdateDismissSchema.parse(input);
          return { ok: true, value: await updates.dismiss(request.version, request.action) };
        }
        if (channel === IPC_CHANNELS.updatesOpenDownload) {
          await updates.openDownload(StableVersionSchema.parse(input));
          return { ok: true, value: undefined };
        }
        return { ok: true, value: await updates.read() };
      } catch (error) {
        return ipcFailure(error, logger);
      }
    });
  }
  const contentSearchInitialization = libraryIpcOptions?.contentSearch
    ? readSettings()
        .then((settings) =>
          libraryIpcOptions.contentSearch?.request({
            action: "configure",
            enabled: settings.contentSearchEnabled ?? true,
          }),
        )
        .catch(() => undefined)
    : Promise.resolve();
  const aiConnectionGate = new AiConnectionGate(
    async () =>
      isNetworkAiAvailable(process.platform) && (await readSettings()).aiConnectionsEnabled,
  );
  const patentTemplates = libraryIpcOptions?.patentTemplates;
  const patentTemplateInitialization =
    patentTemplates && !startupReadOnly
      ? patentTemplates.initialize(() => settingsService.readForTemplateMigration())
      : Promise.resolve();
  // Observe startup rejection now; callers still await the original promise and fail closed.
  void patentTemplateInitialization.catch((error: unknown) => ipcFailure(error, logger));
  const aiPatents = libraryIpcOptions?.patents;
  const requireAiPatent = startupOptions?.tutorial
    ? undefined
    : aiPatents?.requireActiveReadSession?.bind(aiPatents);
  let releaseAiPolishSession: ((sessionId: string, patentId?: string) => void) | undefined;
  let automationCredentials: AiCredentialVault | undefined;
  let automationModelProbe: AutomationHubOptions["probeModel"];
  let automationAi: AutomationHubOptions["runAi"];
  let automationConversations: AutomationConversations | undefined;
  let automationTransfer: AutomationHubOptions["transfer"];
  let automationTransferImport: AutomationHubOptions["transferImport"];
  if (requireAiPatent) {
    const aiCredentialVault = new AiCredentialVault(userDataPath, safeStorage);
    const uploadConsent = new AiUploadConsent(userDataPath);
    const askUpload = async (origin: string) => {
      const choice = await dialog.showMessageBox({
        type: "question",
        title: "AI 内容发送确认",
        message: "允许向此 AI 服务发送请求内容？",
        detail: `服务地址：${origin}\n纠错会发送所选正文；小栈 AI 助手会发送当前选择的文档范围、提问和相关对话上下文。连接测试会发送测试内容。密钥仅发送给该服务用于认证。请确认有权发送这些内容，并了解服务提供商的隐私条款。\n此选择对该服务地址生效，更换地址会再次询问。你可在“设置 → AI 使用与隐私”关闭所有 AI 连接。`,
        buttons: ["取消", "允许发送"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return choice.response === 1;
    };
    automationCredentials = aiCredentialVault;
    const postJson = createHttpsJsonClient();
    const postSse = createHttpsSseClient();
    const aiProvider = new OpenAiCompatibleProvider(
      (url, request) =>
        aiConnectionGate.run(request.signal, async (signal) => {
          await uploadConsent.ensure(url, askUpload, signal);
          signal.throwIfAborted();
          return postJson(url, { ...request, signal });
        }),
      (url, request, onData) =>
        aiConnectionGate.run(request.signal, async (signal) => {
          await uploadConsent.ensure(url, askUpload, signal);
          signal.throwIfAborted();
          return postSse(url, { ...request, signal }, onData);
        }),
      (aiCorrection) => {
        void logger?.log("info", { event: "ai.correction_response", aiCorrection });
      },
    );
    automationAi = (command, patent, payload, context) =>
      runAutomationAi(
        {
          readSettings: async () => (await readSettings()).aiCorrection,
          connectionsEnabled: async () =>
            isNetworkAiAvailable(process.platform) && (await readSettings()).aiConnectionsEnabled,
          vault: aiCredentialVault,
          provider: aiProvider,
        },
        command,
        patent,
        payload,
        context,
      );
    const getJson = createHttpsJsonGetter();
    const aiModelDiscovery = new AiModelDiscoveryService((url, request) =>
      aiConnectionGate.run(request.signal, (signal) => getJson(url, { ...request, signal })),
    );
    automationModelProbe = async (action, profileId, signal, assertAuthorized, beginRequest) => {
      assertAuthorized();
      const settings = await readSettings();
      if (!isNetworkAiAvailable(process.platform) || !settings.aiConnectionsEnabled)
        throw new AutomationError("AI_DISABLED", "软件 AI 连接已关闭。");
      const profile = settings.aiCorrection.profiles.find((item) => item.profileId === profileId);
      if (!profile) throw new AutomationError("NOT_FOUND", "找不到要测试的 AI 模型。");
      const run = async (apiKey: string) => {
        assertAuthorized();
        signal.throwIfAborted();
        beginRequest();
        if (action === "discover")
          return aiModelDiscovery.discover({
            baseUrl: profile.baseUrl,
            apiKey,
            timeoutMs: settings.aiCorrection.timeoutMs,
            signal,
          });
        await aiProvider.correct({
          providerId: profile.providerId,
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey,
          timeoutMs: settings.aiCorrection.timeoutMs,
          thinkingEnabled: true,
          signal,
          scopeKind: "current-book",
          segments: [{ segmentId: "connection-test", bookKind: "description", text: "测试" }],
        });
        return { profileId, connected: true };
      };
      const result =
        profile.providerId === "ollama"
          ? await run("ollama")
          : await aiCredentialVault.withApiKey(profileId, run);
      assertAuthorized();
      return result;
    };
    const aiEventRouter = new AiCorrectionEventRouter();
    const textPolishEventRouter = new TextPolishEventRouter();
    const textPolishConversationEventRouter = new TextPolishConversationEventRouter();
    const aiOwnerTokens = new WeakMap<WebContents, string>();
    const ownerTokenFor = (sender: WebContents): string => {
      const existing = aiOwnerTokens.get(sender);
      if (existing) return existing;
      const token = randomUUID();
      aiOwnerTokens.set(sender, token);
      return token;
    };
    const aiOwnersWithLifecycle = new WeakSet<WebContents>();
    const patentCorrectionService = new PatentCorrectionService({
      readSettings: async () => (await readSettings()).aiCorrection,
      vault: aiCredentialVault,
      patents: {
        requireActiveReadSession: requireAiPatent,
      },
      provider: aiProvider,
      emit: (event) => aiEventRouter.emit(event),
      randomUUID,
    });
    const polishHistory = new TextPolishHistoryStore(join(userDataPath, "text-polish-history"));
    const patentPolishService = new PatentPolishService({
      history: polishHistory,
      readSettings: async () => (await readSettings()).aiCorrection,
      vault: aiCredentialVault,
      patents: {
        requireActiveReadSession: (sessionId, patentId) =>
          automationConversations?.capture(sessionId, patentId) ??
          requireAiPatent(sessionId, patentId),
      },
      provider: aiProvider,
      emit: (event, ownerToken) => {
        automationConversations?.observe(event, ownerToken);
        if ("conversationId" in event) {
          textPolishConversationEventRouter.emit(event, ownerToken ?? "");
        } else {
          textPolishEventRouter.emit(event);
        }
      },
    });
    automationConversations = new AutomationConversations(
      patentPolishService,
      polishHistory,
      async () =>
        isNetworkAiAvailable(process.platform) && (await readSettings()).aiConnectionsEnabled,
    );
    releaseAiPolishSession = (sessionId, patentId) =>
      patentPolishService.releaseSession(sessionId, patentId);
    assertPolishTransferReady = () => {
      try {
        patentPolishService.assertReadyForDataTransfer();
      } catch (error) {
        if ((error as { code?: string }).code === "BUSY") {
          throw new AppOperationError({
            code: "OPERATION_IN_PROGRESS",
            message: "小栈AI助手正在思考",
          });
        }
        throw error;
      }
    };
    const bindAiOwnerLifecycle = (sender: WebContents) => {
      if (aiOwnersWithLifecycle.has(sender)) return;
      aiOwnersWithLifecycle.add(sender);
      aiEventRouter.bindLifecycle(sender, (jobId) => patentCorrectionService.cancel(jobId));
      sender.once("destroyed", () => {
        for (const jobId of textPolishEventRouter.releaseTarget(sender)) {
          patentPolishService.cancel(jobId);
        }
        textPolishConversationEventRouter.releaseTarget(sender);
        patentPolishService.releaseOwner(ownerTokenFor(sender));
      });
    };
    registerAiCorrectionIpc(register, {
      confirmCredentialReset: async (event) => {
        const owner = BrowserWindow.fromWebContents((event as OwnedDialogEvent).sender);
        if (!owner || owner.isDestroyed()) return false;
        const choice = await dialog.showMessageBox(owner, {
          type: "warning",
          title: "重置不可用的 AI 密钥",
          message: "保存新密钥并重置不可用的密钥存储？",
          detail:
            "仅当原存储无法读取时重置。原文件会保留安全副本；其他模型的密钥需要重新输入。文档和模型配置不受影响。如果只是钥匙串暂时被锁定，请取消并解锁后重试。",
          buttons: ["取消", "重置并保存"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return choice.response === 1 && !owner.isDestroyed();
      },
      connectionsEnabled: async () =>
        isNetworkAiAvailable(process.platform) && (await readSettings()).aiConnectionsEnabled,
      readSettings: async () => (await readSettings()).aiCorrection,
      updateSettings: async (settings) =>
        (await settingsService.update({ aiCorrection: settings })).aiCorrection,
      vault: aiCredentialVault,
      correction: {
        start: async (request, event, ensureConnection) => {
          const sender = (event as { sender: WebContents }).sender;
          aiEventRouter.bind(request.jobId, sender);
          bindAiOwnerLifecycle(sender);
          try {
            return await patentCorrectionService.start(request, ensureConnection);
          } catch (error) {
            aiEventRouter.unbind(request.jobId);
            throw error;
          }
        },
        cancel: (jobId, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return aiEventRouter.owns(jobId, sender) && patentCorrectionService.cancel(jobId);
        },
      },
      polish: {
        workspace: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          const ownerToken = ownerTokenFor(sender);
          textPolishConversationEventRouter.bindOwner(ownerToken, sender);
          bindAiOwnerLifecycle(sender);
          return patentPolishService.workspace(ownerToken, request);
        },
        start: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          textPolishEventRouter.bind(request.jobId, sender);
          bindAiOwnerLifecycle(sender);
          try {
            return await patentPolishService.start(request);
          } catch (error) {
            textPolishEventRouter.unbind(request.jobId);
            throw error;
          }
        },
        cancel: (jobId, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return textPolishEventRouter.owns(jobId, sender) && patentPolishService.cancel(jobId);
        },
        startConversation: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          const ownerToken = ownerTokenFor(sender);
          textPolishConversationEventRouter.bindOwner(ownerToken, sender);
          bindAiOwnerLifecycle(sender);
          return await patentPolishService.startConversation(ownerToken, request);
        },
        sendConversation: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return await patentPolishService.sendConversation(ownerTokenFor(sender), request);
        },
        cancelConversation: (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return patentPolishService.cancelConversation(ownerTokenFor(sender), request);
        },
        resetConversation: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return await patentPolishService.resetConversation(ownerTokenFor(sender), request);
        },
        snapshotConversation: async (request, event) => {
          const sender = (event as { sender: WebContents }).sender;
          return await patentPolishService.snapshotConversation(ownerTokenFor(sender), request);
        },
      },
      testConnection: async (profileId) => {
        const settings = (await readSettings()).aiCorrection;
        const profile = settings.profiles.find((candidate) => candidate.profileId === profileId);
        if (!profile) {
          throw new AppOperationError({
            code: "INVALID_INPUT",
            message: "找不到要测试的 AI 模型。",
          });
        }
        const testProvider = async (apiKey: string) => {
          await aiProvider.correct({
            providerId: profile.providerId,
            baseUrl: profile.baseUrl,
            model: profile.model,
            apiKey,
            timeoutMs: settings.timeoutMs,
            thinkingEnabled: true,
            signal: new AbortController().signal,
            scopeKind: "current-book",
            segments: [{ segmentId: "connection-test", bookKind: "description", text: "测试" }],
          });
        };
        if (profile.providerId === "ollama") await testProvider("ollama");
        else await aiCredentialVault.withApiKey(profile.profileId, testProvider);
      },
      discoverModels: async ({ baseUrl, apiKey, timeoutMs }) =>
        await aiModelDiscovery.discover({
          baseUrl,
          apiKey,
          timeoutMs,
          signal: new AbortController().signal,
        }),
      openExternal: async (url) => await shell.openExternal(url),
    });
  }
  const draftService = new DraftService(join(userDataPath, "drafts"));
  const legacyDraftMigrationState = new LegacyDraftMigrationStateFile(
    join(userDataPath, "legacy-draft-migration.json"),
  );
  const openedDocuments = new Map<
    string,
    Pick<PatdocPayload, "document" | "editorState"> & { path: string }
  >();
  const sessions = new SessionLifecycle();
  const templateEditorSessions = new Set<string>();
  const retireTemplateEditorSession = async (sessionId: string): Promise<void> => {
    const retired = sessions.retire(sessionId);
    if (!retired) return;
    templateEditorSessions.delete(sessionId);
    try {
      await assetStore.discardAllPersistentStages(sessionId);
    } finally {
      assetStore.destroySession(sessionId);
      patentTemplates?.closeEditor({ sessionId });
    }
  };
  const editorWorkspaceLeases = new EditorWorkspaceLeases();
  const temporaryImageJobs = new TemporaryImageJobs(createTemporaryImageWorker);
  const temporaryImageFiles = new TemporaryImageFiles({
    choose: async (name, format) => {
      const extensions =
        format === "jpeg" ? ["jpg", "jpeg"] : format === "tiff" ? ["tif", "tiff"] : [format];
      const selection = await dialog.showSaveDialog({
        title: "导出编辑后的图片",
        defaultPath: name,
        filters: [{ name: `${format.toUpperCase()} 图片`, extensions }],
      });
      return selection.canceled ? null : (selection.filePath ?? null);
    },
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    confirmOverwrite: async (path) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "覆盖图片",
        message: "目标图片已存在，是否覆盖？",
        detail: path,
        buttons: ["取消", "覆盖"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    encode: (bytes, options) =>
      temporaryImageJobs.encode({ bytes: Uint8Array.from(bytes), options, suggestedName: "image" }),
    encodePsd: (input) => temporaryImageJobs.encodePsd(input),
    writeAtomic: async (path, bytes) => {
      await writeFileAtomic(path, Buffer.from(bytes));
    },
  });
  const temporaryImageBatch = new TemporaryImageBatch({
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog({
        title: "选择批量导出目录",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    encode: (bytes, options) =>
      temporaryImageJobs.encode({ bytes: Uint8Array.from(bytes), options, suggestedName: "image" }),
    encodePsd: (input) => temporaryImageJobs.encodePsd(input),
    writeExclusive: writeTemporaryImageExclusive,
  });
  registerTemporaryImageIpc(
    register,
    temporaryImageJobs,
    temporaryImageFiles,
    (error) => {
      if (error instanceof EditorResourceAdmissionError)
        return appFailure("INVALID_INPUT", { message: error.message });
      if (error instanceof ZodError) return appFailure("INVALID_INPUT");
      if (error instanceof Error && !("code" in error))
        return appFailure("INVALID_INPUT", {
          message: error.message.slice(0, 500) || "图片处理失败。",
        });
      return ipcFailure(error, logger);
    },
    temporaryImageBatch,
  );
  const operations = new OperationCoordinator();
  const bmpToPng = async (bytes: Uint8Array) => {
    const decoded = decodeBmpToBgra(bytes);
    const image = nativeImage.createFromBitmap(Buffer.from(decoded.pixels), {
      width: decoded.width,
      height: decoded.height,
    });
    if (image.isEmpty()) throw new Error("BMP 图片无法解码");
    return Uint8Array.from(image.toPNG());
  };

  const importAndStore = async (request: unknown) => {
    try {
      const validated = ImportAssetRequestSchema.parse(request);
      sessions.requireActive(validated.sessionId);
      const stored = await importImage(
        { originalName: validated.originalName, bytes: validated.bytes },
        { bmpToPng },
      );
      if (templateEditorSessions.has(validated.sessionId)) {
        const [imported] = await assetStore.putPersistentManyStaged(validated.sessionId, [stored]);
        if (!imported) throw new Error("默认模板资源暂存失败。");
        return { ok: true, value: imported };
      }
      return { ok: true, value: await assetStore.putPersistent(validated.sessionId, stored) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  };

  register(IPC_CHANNELS.clipboardReadText, async () => {
    try {
      await harmony?.requireClipboardAccess();
      return { ok: true, value: clipboard.readText() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.clipboardPaste, async (event) => {
    try {
      await harmony?.requireClipboardAccess();
      const sender = (event as Electron.IpcMainInvokeEvent).sender;
      if (sender.isDestroyed()) return appFailure("CANCELLED");
      sender.paste();
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.clipboardReadImage, async () => {
    try {
      await harmony?.requireClipboardAccess();
      const image = clipboard.readImage();
      if (image.isEmpty()) return { ok: true, value: null };
      const { width, height } = image.getSize(1);
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 10000 ||
        height > 10000 ||
        width * height > 40000000
      ) {
        throw new Error("剪贴板图片尺寸超过安全范围。");
      }
      const bytes = new Uint8Array(image.toPNG({ scaleFactor: 1 }));
      return { ok: true, value: ClipboardImageSchema.parse({ bytes, width, height }) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.clipboardWriteImage, async (_event, input) => {
    try {
      await harmony?.requireClipboardAccess();
      const validated = ClipboardImageSchema.parse(input);
      validateEditorBinaryHeader(validated.bytes, "png", validated);
      const image = nativeImage.createFromBuffer(Buffer.from(validated.bytes));
      if (image.isEmpty()) throw new Error("剪贴板图片无法解码。");
      const size = image.getSize(1);
      if (size.width !== validated.width || size.height !== validated.height)
        throw new Error("剪贴板图片实际尺寸不一致。");
      clipboard.writeImage(image);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.clipboardWriteText, (_event, textInput) => {
    try {
      const request = ClipboardTextWriteRequestSchema.parse(textInput);
      if (typeof request === "string") clipboard.writeText(request);
      else if (request.style === "formatted-draft")
        clipboard.write(richDraftClipboardFormats(request.paragraphs));
      else clipboard.write(redDraftClipboardFormats(request.text));
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  const importAndStageMany = async (request: unknown) => {
    try {
      const validated = ImportAssetBatchRequestSchema.parse(request);
      sessions.requireActive(validated.sessionId);
      const stored: Awaited<ReturnType<typeof loadImageFile>>[] = [];
      for (const image of validated.images) {
        stored.push(
          await importImage({ originalName: image.originalName, bytes: image.bytes }, { bmpToPng }),
        );
      }
      return {
        ok: true,
        value: await assetStore.putPersistentManyStaged(
          validated.sessionId,
          stored,
          validated.operationId,
        ),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  };

  const importImageFile = async (sessionId: string, filePath: string) => {
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_IMAGE_BYTES) {
      throw new ImageImportError("TOO_LARGE", "图片不能超过 50 MiB。");
    }
    return importAndStore({
      sessionId,
      originalName: basename(filePath),
      declaredMediaType: null,
      bytes: Uint8Array.from(await readFile(filePath)),
    });
  };

  const loadImageFile = async (filePath: string) => {
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_IMAGE_BYTES) {
      throw new ImageImportError("TOO_LARGE", "图片不能超过 50 MiB。");
    }
    return importImage(
      { originalName: basename(filePath), bytes: Uint8Array.from(await readFile(filePath)) },
      { bmpToPng },
    );
  };

  const openPathImpl = async (path: string) => {
    const existingSessionId = documentRegistry.findSessionByPath(path);
    if (existingSessionId) {
      sessions.requireActive(existingSessionId);
      const opened = openedDocuments.get(existingSessionId);
      if (opened) {
        return {
          ok: true,
          value: {
            sessionId: existingSessionId,
            path: opened.path,
            displayName: basename(opened.path),
            document: structuredClone(opened.document),
            editorState: structuredClone(opened.editorState),
          },
        };
      }
    }

    const sessionId = randomUUID();
    const reservation = documentRegistry.reserve(sessionId, path);
    try {
      const result = await fileService.openDocument(path);
      if (!result.ok) {
        reservation.rollback();
        return result;
      }
      assetStore.createSession(sessionId);
      sessions.activate(sessionId, result.value.document.documentId);
      for (const asset of result.value.assets) assetStore.adopt(sessionId, asset);
      reservation.commit();
      openedDocuments.set(sessionId, {
        path,
        document: structuredClone(result.value.document),
        editorState: structuredClone(result.value.editorState),
      });
      logWithoutBlocking(logger?.log("info", { event: "document.opened", path }));
      return {
        ok: true,
        value: {
          sessionId,
          path,
          displayName: basename(path),
          document: result.value.document,
          editorState: result.value.editorState,
        },
      };
    } catch (error) {
      reservation.rollback();
      assetStore.destroySession(sessionId);
      sessions.retire(sessionId);
      openedDocuments.delete(sessionId);
      throw error;
    }
  };
  const openPathsInFlight = new Map<string, ReturnType<typeof openPathImpl>>();
  const openPath = async (pathInput: unknown) => {
    let key: string | undefined;
    let operation: ReturnType<typeof openPathImpl> | undefined;
    try {
      const path = PatdocPathSchema.parse(pathInput);
      key = normalizeDocumentPath(path);
      const existingOperation = openPathsInFlight.get(key);
      if (existingOperation) return existingOperation;
      operation = openPathImpl(path);
      openPathsInFlight.set(key, operation);
      return await operation;
    } catch (error) {
      return ipcFailure(error, logger, "document.open_failed");
    } finally {
      if (key && operation && openPathsInFlight.get(key) === operation) {
        openPathsInFlight.delete(key);
      }
    }
  };

  const saveToPath = async (
    path: string,
    request: SaveDocumentRequest,
    operation: OperationContext,
  ) => {
    let reservation: ReturnType<DocumentRegistry["reserve"]> | undefined;
    try {
      if (operation.signal.aborted) return appFailure("CANCELLED");
      sessions.requireActive(request.sessionId, request.document.documentId);
      reservation = documentRegistry.reserve(request.sessionId, path);
      const result = await fileService.saveDocument(path, {
        document: request.document,
        settings: {},
        editorState: request.editorState,
        assets: assetStore.list(request.sessionId),
      });
      if (!result.ok) {
        reservation.rollback();
        logWithoutBlocking(
          logger?.log("error", {
            event: "document.save_failed",
            errorCode: result.error.code,
            path,
          }),
        );
        return result;
      }
      reservation.commit();
      openedDocuments.set(request.sessionId, {
        path: result.value.path,
        document: structuredClone(request.document),
        editorState: structuredClone(request.editorState),
      });
      await draftService.delete(request.document.documentId).catch(() => undefined);
      logWithoutBlocking(logger?.log("info", { event: "document.saved", path: result.value.path }));
      return {
        ok: true,
        value: { ...result.value, sessionId: request.sessionId },
      };
    } catch (error) {
      reservation?.rollback();
      return ipcFailure(error, logger, "document.save_failed", path);
    }
  };

  register(IPC_CHANNELS.documentsActivate, (_event, requestInput) => {
    try {
      const request = ActivateDocumentSessionRequestSchema.parse(requestInput);
      sessions.activate(request.sessionId, request.documentId);
      assetStore.createSession(request.sessionId);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.documentsOpenDialog, async (event) => {
    try {
      const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        title: `打开${APPLICATION_DOCUMENT_TYPE_NAME}`,
        properties: ["openFile"],
        filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
      });
      const path = selection.filePaths[0];
      if (selection.canceled || !path) return { ok: true, value: null };

      return openPath(path);
    } catch (error) {
      return ipcFailure(error, logger, "document.open_failed");
    }
  });
  register(IPC_CHANNELS.documentsOpenPath, async (_event, pathInput) => {
    try {
      const path = PatdocPathSchema.parse(pathInput);
      if (!openPathAuthorization.consume(path)) {
        throw new AppOperationError({ code: "NO_PERMISSION", message: "normalized" });
      }
      return await openPath(path);
    } catch (error) {
      return ipcFailure(error, logger, "document.open_failed");
    }
  });

  register(IPC_CHANNELS.documentsSave, async (event, requestInput) => {
    try {
      const request = SaveDocumentRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.document.documentId);
      return await operations.run(request.sessionId, "save", async (operation) => {
        const registeredPath = documentRegistry.getPath(request.sessionId);
        if (registeredPath) return saveToPath(registeredPath, request, operation);
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: `保存${APPLICATION_DOCUMENT_TYPE_NAME}`,
          defaultPath: safePatdocName(request.document.title),
          filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return appFailure("CANCELLED");
        }
        return saveToPath(ensurePatdocExtension(selection.filePath), request, operation);
      });
    } catch (error) {
      return ipcFailure(error, logger, "document.save_failed");
    }
  });

  register(IPC_CHANNELS.documentsSaveAs, async (event, requestInput) => {
    try {
      const request = SaveDocumentRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.document.documentId);
      return await operations.run(request.sessionId, "save", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: `${APPLICATION_DOCUMENT_TYPE_NAME}另存为`,
          defaultPath: safePatdocName(request.document.title),
          filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        return saveToPath(ensurePatdocExtension(selection.filePath), request, operation);
      });
    } catch (error) {
      return ipcFailure(error, logger, "document.save_failed");
    }
  });

  register(IPC_CHANNELS.settingsRead, async () => {
    try {
      return { ok: true, value: await readSettings() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationStorageOverview, async () => {
    try {
      const settings = await readSettings();
      const [library, backup] = await Promise.all([
        inspectStorageFolder(libraryIpcOptions?.dataTransferRuntime?.libraryRoot ?? null),
        inspectStorageFolder(settings.backup.folder),
      ]);
      return { ok: true, value: { library, backup } };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  let choosingLibraryLocation = false;
  register(IPC_CHANNELS.applicationRelocateLibrary, async (event) => {
    if (choosingLibraryLocation) return appFailure("OPERATION_IN_PROGRESS");
    if (!startupOptions?.libraryRelocation) return notReady();
    choosingLibraryLocation = true;
    try {
      const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        title: "选择文档库的新位置",
        properties: ["openDirectory", "createDirectory"],
      });
      const parent = selection.filePaths[0];
      if (selection.canceled || !parent) return { ok: true, value: false };
      const owner = BrowserWindow.fromWebContents((event as OwnedDialogEvent).sender);
      if (!owner) throw new Error("找不到主窗口");
      const answer = await dialog.showMessageBox(owner, {
        type: "question",
        title: "迁移文档库",
        message: "保存文档后迁移并重启？",
        detail: `新位置：${parent}\n将在这里新建独立文档库目录。迁移完成后保留原库作为安全副本。迁移期间请勿关闭电脑或断开磁盘。`,
        buttons: ["迁移并重启", "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) return { ok: true, value: false };
      await startupOptions.libraryRelocation.schedule(parent);
      setImmediate(() => startupOptions.libraryRelocation?.restart());
      return { ok: true, value: true };
    } catch (error) {
      return ipcFailure(error, logger);
    } finally {
      choosingLibraryLocation = false;
    }
  });
  register(IPC_CHANNELS.applicationOpenStorageFolder, async (_event, input) => {
    try {
      const kind = StorageFolderKindSchema.parse(input);
      const path =
        kind === "library"
          ? libraryIpcOptions?.dataTransferRuntime?.libraryRoot
          : (await readSettings()).backup.folder;
      if (!path || !(await lstat(path)).isDirectory())
        throw new Error("该文件夹尚未配置或已不可用。");
      const error = await shell.openPath(path);
      if (error) throw new Error("无法打开文件夹，请确认文件夹存在且可以访问。");
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.settingsUpdate, async (_event, patchInput) => {
    try {
      const patch = AppSettingsPatchSchema.parse(patchInput);
      const saved = await settingsService.update(patch);
      if (patch.autoCheckUpdates !== undefined) updates.setEnabled(saved.autoCheckUpdates);
      if (patch.closeToTray !== undefined) startupOptions?.onCloseToTrayChanged(saved.closeToTray);
      if (patch.aiConnectionsEnabled === false) aiConnectionGate.cancelAll();
      return {
        ok: true,
        value: saved,
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  // --- Backup Service (singleton) ---
  let backupService: BackupService | undefined;
  let backupServiceInitialization: Promise<void> | undefined;
  let disposeSnapshotTimer: (() => Promise<void>) | undefined;
  let snapshotTimer: SnapshotTimer | undefined;
  const openPatentSessions = new Map<string, string>();
  const designPatentSessions = new Set<string>();
  const openSnapshotPatentIds = () => [
    ...new Set(
      [...openPatentSessions]
        .filter(([sessionId]) => !designPatentSessions.has(sessionId))
        .map(([, patentId]) => patentId),
    ),
  ];
  const patentSessionOwners = new Map<string, RendererLifecycleOwner>();
  const ownerPatentSessions = new Map<RendererLifecycleOwner, Set<string>>();
  if (!isAgentCliAvailable(process.platform)) {
    register(IPC_CHANNELS.automationControl, async () => ({
      ok: false,
      error: { code: "INVALID_INPUT", message: "鸿蒙版暂未开放 Agent CLI。" },
    }));
  } else if (libraryIpcOptions?.automationRuntime && !startupOptions?.tutorial) {
    const runtime = libraryIpcOptions.automationRuntime;
    const automationHome = process.env.ZXW_HOME ?? join(app.getPath("appData"), "zxw");
    const mainWindow = () =>
      BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.getTitle() === APPLICATION_NAME,
      );
    const attention = createElectronAuthorizationAttention(mainWindow, () => {
      if (startupOptions?.openAutomationAuthorization) {
        void startupOptions.openAutomationAuthorization().catch(() => {});
      } else {
        const window = mainWindow();
        if (window?.isMinimized()) window.restore();
        window?.show();
        window?.focus();
        app.focus();
      }
    });
    const updateAttention = () => attention.update(automation?.state().pendingPairs ?? []);
    app.on("browser-window-focus", updateAttention);
    app.on("browser-window-blur", updateAttention);
    disposeAutomationAttention = () => {
      attention.dispose();
      app.removeListener("browser-window-focus", updateAttention);
      app.removeListener("browser-window-blur", updateAttention);
    };
    const broadcastAutomation = (event: AutomationEvent) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.automationEvent, event);
      }
      if (event.type === "stateChanged") updateAttention();
    };
    automation = new AutomationHub({
      drawingRuntime: drawingRuntimeRoot(
        app.isPackaged,
        process.platform,
        process.resourcesPath,
        fileURLToPath(new URL("../..", import.meta.url)),
      ),
      runtime,
      home: automationHome,
      accessInstructions: async (instanceId) =>
        formatAgentAccessInstructions({
          instanceId,
          home: automationHome,
          platform: process.platform,
          cliPath: await resolveAgentCliEntry({
            isPackaged: app.isPackaged,
            appPath: app.getAppPath(),
            resourcesPath: process.resourcesPath,
            platform: process.platform,
          }),
        }),
      chooseWorkspace: async (kind, directory, clientLabel) => {
        const window = mainWindow();
        if (!window || window.isDestroyed())
          throw new AutomationError("APP_NOT_RUNNING", "请打开软件后选择位置。");
        const result = await dialog.showOpenDialog(window, {
          title: `${clientLabel}：${kind === "import" ? "选择待导入材料所在文件夹" : "选择导出文件保存位置"}`,
          ...(directory ? { defaultPath: directory } : {}),
          properties: ["openDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      version: APPLICATION_VERSION,
      label: `${app.getName()} ${basename(userDataPath)}`,
      participants: (patentId) =>
        [...openPatentSessions.entries()]
          .filter(([, id]) => id === patentId)
          .flatMap(([sessionId]) => {
            const owner = patentSessionOwners.get(sessionId) as WebContents | undefined;
            return owner && typeof owner.id === "number" && !owner.isDestroyed()
              ? [
                  {
                    sessionId,
                    ownerId: owner.id,
                    send: (event: AutomationEvent) => {
                      if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.automationEvent, event);
                    },
                  },
                ]
              : [];
          }),
      broadcast: broadcastAutomation,
      settings: settingsService,
      credentials: automationCredentials,
      runAi: automationAi,
      conversations: automationConversations,
      transfer: {
        inspect: async () => {
          if (!automationTransfer) throw new Error("完整数据迁移服务不可用");
          return automationTransfer.inspect();
        },
        exportPackage: async (request) => {
          if (!automationTransfer) throw new Error("完整数据迁移服务不可用");
          return automationTransfer.exportPackage(request);
        },
      },
      relocation: startupOptions?.libraryRelocation
        ? {
            schedule: (parent) => startupOptions!.libraryRelocation!.schedule(parent),
            cancel: async () => {
              await startupOptions!.libraryRelocation!.cancel?.();
            },
            assertReady: () => {
              if (
                sessions.hasActiveSessions ||
                openPatentSessions.size ||
                templateEditorSessions.size
              )
                throw new AutomationError(
                  "EDITOR_OPEN",
                  "请先保存并关闭编辑中的文档，再迁移文档库。",
                );
              assertPolishTransferReady();
            },
            restart: () => startupOptions!.libraryRelocation!.restart(true),
          }
        : undefined,
      probeModel: (...args) => {
        if (!automationModelProbe)
          throw new AutomationError("UNAVAILABLE", "AI 配置测试服务不可用。");
        return automationModelProbe(...args);
      },
      legacyDrafts: {
        list: () => draftService.list(),
        open: (id) => draftService.open(id),
        isImported: (id) => legacyDraftMigrationState.isImported(id),
      },
      transferImport: {
        supportsCommit: supportsAutomationImportCommit(process.platform),
        prepare: (...args) => {
          if (!automationTransferImport) throw new Error("完整包导入服务不可用");
          return automationTransferImport.prepare(...args);
        },
        discard: (...args) => {
          if (!automationTransferImport) throw new Error("完整包导入服务不可用");
          return automationTransferImport.discard(...args);
        },
        schedule: (...args) => {
          if (!automationTransferImport) throw new Error("完整包导入服务不可用");
          return automationTransferImport.schedule(...args);
        },
        commit: (...args) => {
          if (!automationTransferImport) throw new Error("完整包导入服务不可用");
          return automationTransferImport.commit(...args);
        },
        fail: (...args) => {
          if (!automationTransferImport) throw new Error("完整包导入服务不可用");
          return automationTransferImport.fail(...args);
        },
      },
      renderGraphic: renderAutomationGraphic,
      backup: {
        capture: async (...args) => getBackupService().capture(...args),
        status: async (...args) => {
          return getBackupService().status(...args);
        },
        list: async (...args) => {
          return getBackupService().list(...args);
        },
        describe: async (...args) => {
          return getBackupService().describe(...args);
        },
        runGuarded: async (...args) => {
          const service = getBackupService();
          await backupServiceInitialization;
          return service.runGuarded(...args);
        },
        delete: async (...args) => {
          const service = getBackupService();
          await backupServiceInitialization;
          return service.delete(...args);
        },
        configure: async (...args) => {
          const service = getBackupService();
          await backupServiceInitialization;
          return service.configure(...args);
        },
      },
      onSnapshotChanged: async () => {
        await snapshotTimer?.restartAutomaticClock();
      },
      printing: {
        printers: async () => {
          const window = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
          if (!window) throw new AutomationError("UNAVAILABLE", "打印机查询窗口不可用。");
          return toPrinterDescriptors(await window.webContents.getPrintersAsync());
        },
        submit: async (...args) => {
          try {
            await printService.printHtmlConfigured(...args);
          } finally {
            printService.releaseSession(args[0]);
          }
        },
      },
      renderPdf: async (html, sessionId) => {
        try {
          return await printService.createHtmlPdf(sessionId, html);
        } finally {
          printService.releaseSession(sessionId);
        }
      },
      onSettingsChanged: (saved, patch) => {
        if (patch.autoCheckUpdates !== undefined) updates.setEnabled(saved.autoCheckUpdates);
        if (patch.aiConnectionsEnabled === false) aiConnectionGate.cancelAll();
        if (patch.closeToTray !== undefined)
          startupOptions?.onCloseToTrayChanged(saved.closeToTray);
      },
      exportPatent: (patent, payload, context) =>
        exportAutomationPatent(
          runtime,
          async (html, sessionId) => {
            try {
              return await printService.createHtmlPdf(sessionId, html);
            } finally {
              printService.releaseSession(sessionId);
            }
          },
          patent,
          payload,
          context,
        ),
      manual: () =>
        readFile(
          app.isPackaged
            ? join(process.resourcesPath, "cli/manual.md")
            : fileURLToPath(new URL("../cli/manual.md", import.meta.url)),
          "utf8",
        ),
    });
    const hub = automation;
    automationInitialization = Promise.resolve(patentTemplateInitialization)
      .then(() => hub.initialize())
      .catch((error: unknown) => {
        automationStartupError = error;
        logWithoutBlocking(
          logger?.log("error", { event: "app.error", errorCode: "AUTOMATION_START_FAILED" }),
        );
      });
    register(IPC_CHANNELS.automationControl, async (event, input) => {
      try {
        const owned = event as IpcMainInvokeEvent;
        if (
          !BrowserWindow.fromWebContents(owned.sender) ||
          owned.senderFrame !== owned.sender.mainFrame
        )
          return appFailure("INVALID_INPUT");
        await automationInitialization;
        if (automationStartupError)
          throw new AutomationError(
            "AUTOMATION_START_FAILED",
            "本地 agent 入口启动失败，请检查配置目录权限。",
          );
        const request = AutomationUiRequestSchema.parse(input);
        if (request.action === "chooseDirectory") {
          const selected = await showOwnedOpenDialog(event as OwnedDialogEvent, {
            title: request.kind === "import" ? "授权素材导入目录" : "授权导出目录",
            properties: ["openDirectory"],
          });
          return { ok: true, value: selected.canceled ? null : (selected.filePaths[0] ?? null) };
        }
        return { ok: true, value: await hub.control(request, owned.sender.id) };
      } catch (error) {
        if (error instanceof AutomationError)
          return { ok: false, error: { code: "INVALID_INPUT", message: error.message } };
        return ipcFailure(error, logger);
      }
    });
  }
  let snapshotSuspendable: Pick<SnapshotTimer, "suspend"> | undefined;
  let disposeDataTransfer: (() => Promise<void>) | undefined;

  function getBackupService(): BackupService {
    if (!backupService && libraryIpcOptions?.patents) {
      backupService = createBackupService(settingsService, {
        ...(libraryIpcOptions.contentSearch
          ? { contentSearch: libraryIpcOptions.contentSearch }
          : {}),
        library: libraryIpcOptions.library,
        patents: libraryIpcOptions.patents,
        fileService: libraryIpcOptions.fileService,
        assetStore: libraryIpcOptions.assetStore,
        flowcharts: libraryIpcOptions.flowcharts,
      });
      backupServiceInitialization = backupService.initialize();
    }
    if (!backupService) throw new Error("Backup service not available");
    return backupService;
  }

  if (libraryIpcOptions?.patents && !startupOptions?.tutorial) {
    getBackupService();
  }

  register(IPC_CHANNELS.backupSelectFolder, async (event) => {
    try {
      const result = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        properties: ["openDirectory", "createDirectory"],
        title: "选择备份文件夹",
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: true, value: null };
      }
      return { ok: true, value: result.filePaths[0] ?? null };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupStatus, async () => {
    if (!libraryIpcOptions) return notReady();
    try {
      return { ok: true, value: await getBackupService().status() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupConfigure, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      const value = await getBackupService().configure(BackupConfigureRequestSchema.parse(input));
      return { ok: true, value };
    } catch (error) {
      const described = backupFileError(error);
      if (described) {
        ipcFailure(new AppOperationError(described), logger);
        return { ok: false, error: described };
      }
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupList, async () => {
    if (!libraryIpcOptions) return notReady();
    try {
      return { ok: true, value: await getBackupService().list() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupRestore, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      const fileName = z.string().min(1).parse(input);
      return { ok: true, value: await getBackupService().restore(fileName) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupDelete, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      const fileName = z.string().min(1).parse(input);
      await getBackupService().delete(fileName);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupEnsureCurrent, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      return {
        ok: true,
        value: await getBackupService().ensureCurrent(
          BackupTargetSchema.parse(input),
          "patent-close",
        ),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupFinalize, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      z.object({}).strict().parse(input);
      return { ok: true, value: await getBackupService().finalize() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupOperationStatus, async () => {
    if (!libraryIpcOptions) return notReady();
    try {
      return { ok: true, value: getBackupService().operationStatus() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.backupCancelFinalization, async (_event, input) => {
    if (!libraryIpcOptions) return notReady();
    try {
      z.object({}).strict().parse(input);
      getBackupService().requestFinalizationCancel();
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.applicationCreateDesktopShortcut, () => {
    try {
      if (!createDesktopShortcut()) {
        throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationOpenOfficialWebsite, async (_event, id) => {
    try {
      await openOfficialWebsite(id);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationLegislation, async (_event, request) => {
    try {
      await performLegislationAction(request);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationOpenThirdPartyNotices, async () => {
    try {
      const applicationRoot = usesInstalledResources(app.isPackaged, process.platform)
        ? process.resourcesPath
        : app.getAppPath();
      await openBundledThirdPartyNotices(applicationRoot, (path) => shell.openPath(path));
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationOpenThirdPartyLicensesFolder, async () => {
    try {
      const applicationRoot = usesInstalledResources(app.isPackaged, process.platform)
        ? process.resourcesPath
        : app.getAppPath();
      await openBundledThirdPartyLicenses(applicationRoot, (path) => shell.openPath(path));
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  if (startupRecoveryReport) {
    register(IPC_CHANNELS.applicationGetStartupRecoveryReport, () => ({
      ok: true,
      value: startupRecoveryReport,
    }));
  }
  const assertRecoveryAllowed = (event: unknown) => {
    const owned = event as IpcMainInvokeEvent;
    if (
      !BrowserWindow.fromWebContents(owned.sender) ||
      owned.senderFrame !== owned.sender.mainFrame
    )
      throw new AppOperationError({ code: "INVALID_INPUT", message: "Invalid recovery caller" });
    if (!recoveryLibrary || startupRecoveryReport?.mode !== "read-only")
      throw new AppOperationError({
        code: "READ_ONLY_RECOVERY",
        message: "Recovery library unavailable",
      });
    return recoveryLibrary;
  };
  register(IPC_CHANNELS.applicationPrepareRecovery, async (event, input) => {
    try {
      const service = assertRecoveryAllowed(event);
      if (recoveryPreparing) return appFailure("OPERATION_IN_PROGRESS");
      recoveryPreparing = true;
      try {
        const source = RecoverySourceSchema.parse(input);
        let payload: PatentPatdocPayload;
        if (source.kind === "snapshot") {
          if (!libraryIpcOptions?.snapshots)
            throw new Error("当前文档库无法读取快照，请选择 PATDOC 备份文件。");
          const snapshot = await libraryIpcOptions.snapshots.open(source.patentId, source.revision);
          payload = {
            patent: snapshot.patent,
            assets: await Promise.all(
              snapshot.patent.assets.map((asset) =>
                libraryIpcOptions.assetStore.readAsset(asset.assetId),
              ),
            ),
            flowcharts: snapshot.patent.flowchartProjects.length
              ? await libraryIpcOptions.snapshots.readFlowchartArchive(
                  source.patentId,
                  source.revision,
                )
              : [],
          };
        } else {
          let path: string;
          if (source.kind === "backup") {
            const captured = await getBackupService().capture(
              source.fileName,
              (await readSettings()).backup,
            );
            const temporary = await mkdtemp(join(app.getPath("temp"), "patent-recovery-"));
            path = join(temporary, "source.patdoc");
            await writeFile(path, captured.bytes, { flag: "wx", mode: 0o600 });
          } else {
            const backupFolder = (await readSettings()).backup.folder;
            const selected = await showOwnedOpenDialog(event as OwnedDialogEvent, {
              title: "选择可恢复的 PATDOC 备份",
              properties: ["openFile"],
              filters: [{ name: "专利文件", extensions: ["patdoc"] }],
              ...(backupFolder ? { defaultPath: backupFolder } : {}),
            });
            if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
            path = selected.filePaths[0];
          }
          const opened = await new FileService().openPatent(path);
          if (!opened.ok) return opened;
          payload = opened.value;
        }
        const destination = await showOwnedOpenDialog(event as OwnedDialogEvent, {
          title: "选择新恢复库的存放位置（原库保留）",
          properties: ["openDirectory", "createDirectory"],
        });
        if (destination.canceled || !destination.filePaths[0]) return { ok: true, value: null };
        return { ok: true, value: await service.prepare(payload, destination.filePaths[0]) };
      } finally {
        recoveryPreparing = false;
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.applicationActivateRecovery, async (event, input) => {
    try {
      const service = assertRecoveryAllowed(event);
      if (recoveryPreparing) return appFailure("OPERATION_IN_PROGRESS");
      await service.activate(StableIdSchema.parse(input));
      setImmediate(() => startupOptions?.recoveryLibrary?.restart());
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.draftsList, async () => {
    try {
      return { ok: true, value: await draftService.list() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.draftsSave, async (_event, requestInput) => {
    try {
      const request = SaveDraftRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.documentId);
      if (request.document.documentId !== request.documentId) {
        throw new AppOperationError({ code: "INVALID_INPUT", message: "normalized" });
      }
      return await operations.run(request.sessionId, "draft-save", async (operation) => {
        if (operation.signal.aborted) return appFailure("CANCELLED");
        const value = await draftService.save({
          documentId: request.documentId,
          displayName: request.displayName,
          originalPath: request.originalPath,
          payload: {
            document: request.document,
            settings: {},
            editorState: request.editorState,
            assets: assetStore.list(request.sessionId),
          },
        });
        logWithoutBlocking(
          logger?.log("info", { event: "draft.saved", path: request.originalPath ?? undefined }),
        );
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "draft.save_failed");
    }
  });
  register(IPC_CHANNELS.draftsOpen, async (_event, draftIdInput) => {
    try {
      const draftId = StableIdSchema.parse(draftIdInput);
      const summary = (await draftService.list()).find((item) => item.draftId === draftId);
      if (!summary) return appFailure("NOT_FOUND");
      const payload = await draftService.open(draftId);
      const sessionId = randomUUID();
      sessions.activate(sessionId, payload.document.documentId);
      assetStore.createSession(sessionId);
      try {
        for (const asset of payload.assets) assetStore.adopt(sessionId, asset);
        return {
          ok: true,
          value: {
            sessionId,
            path: null,
            displayName: summary.displayName,
            document: payload.document,
            editorState: payload.editorState,
          },
        };
      } catch (error) {
        assetStore.destroySession(sessionId);
        sessions.retire(sessionId);
        throw error;
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.draftsDelete, async (_event, draftIdInput) => {
    try {
      await draftService.delete(StableIdSchema.parse(draftIdInput));
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });

  register(IPC_CHANNELS.assetsImportBytes, (_event, request) => importAndStore(request));
  const drawingImportJobs = new DrawingImportJobs();
  const drawingTimingHistory = new DrawingTimingHistory(
    join(userDataPath, "cad-import-timing-v1.json"),
  );
  register(IPC_CHANNELS.drawingsCancelImport, async (eventInput, input) => {
    try {
      const event = eventInput as IpcMainInvokeEvent;
      if (
        !event.sender ||
        event.senderFrame !== event.sender.mainFrame ||
        !BrowserWindow.fromWebContents(event.sender)
      )
        throw new Error("图纸请求来源无效。");
      const request = DrawingCancelImportSchema.parse(input);
      return {
        ok: true,
        value: drawingImportJobs.cancel(event.sender.id, request.sessionId, request.operationId),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.drawingsImport, async (eventInput, input) => {
    try {
      const event = eventInput as IpcMainInvokeEvent;
      if (
        !event.sender ||
        event.senderFrame !== event.sender.mainFrame ||
        !BrowserWindow.fromWebContents(event.sender)
      )
        throw new Error("图纸请求来源无效。");
      const request = DrawingImportRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const controller = drawingImportJobs.start(
        event.sender.id,
        request.sessionId,
        request.operationId,
      );
      const cancel = () => controller.abort();
      event.sender.once("destroyed", cancel);
      await drawingTimingHistory.ready;
      const progress = new DrawingImportProgress(
        request.bytes.length,
        (value) => {
          if (!event.sender.isDestroyed() && !controller.signal.aborted)
            event.sender.send(IPC_CHANNELS.drawingsImportProgress, {
              ...value,
              sessionId: request.sessionId,
              operationId: request.operationId,
            });
        },
        drawingTimingHistory,
      );
      progress.tick();
      const heartbeat = setInterval(() => progress.tick(), 1000);
      let completed = false;
      try {
        const result = await importDrawing(
          request,
          drawingRuntimeRoot(
            app.isPackaged,
            process.platform,
            process.resourcesPath,
            fileURLToPath(new URL("../..", import.meta.url)),
          ),
          controller.signal,
          (value) => progress.update(value),
        );
        controller.signal.throwIfAborted();
        sessions.requireActive(request.sessionId);
        progress.update({ phase: "store", completed: null, total: null });
        const assets = await assetStore.putPersistentManyStaged(
          request.sessionId,
          result.assets,
          request.operationId,
        );
        completed = true;
        return { ok: true, value: { ...result, assets } };
      } finally {
        clearInterval(heartbeat);
        progress.stop(completed);
        void drawingTimingHistory.save();
        event.sender.removeListener("destroyed", cancel);
        drawingImportJobs.finish(event.sender.id, request.operationId);
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  const cadRuntime = () =>
    join(
      usesInstalledResources(app.isPackaged, process.platform)
        ? process.resourcesPath
        : fileURLToPath(new URL("../..", import.meta.url)),
      "resources",
      "cadcraft",
    );
  function requireCadOwner(eventInput: unknown, sessionId: string) {
    const event = eventInput as IpcMainInvokeEvent;
    const owner = rendererLifecycleOwner(eventInput);
    if (
      !event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !BrowserWindow.fromWebContents(event.sender) ||
      !owner ||
      patentSessionOwners.get(sessionId) !== owner ||
      !openPatentSessions.has(sessionId)
    )
      throw new AppOperationError({ code: "NO_PERMISSION", message: "CAD access denied" });
    sessions.requireActive(sessionId);
    return event;
  }
  register(IPC_CHANNELS.cadPrepare, async (eventInput, input) => {
    try {
      const request = CadPrepareRequestSchema.parse(input);
      const event = requireCadOwner(eventInput, request.sessionId);
      const controller = drawingImportJobs.start(
        event.sender.id,
        request.sessionId,
        request.operationId,
      );
      const cancel = () => controller.abort();
      event.sender.once("destroyed", cancel);
      try {
        const result = await prepareCadAssets(cadRuntime(), request, controller.signal);
        controller.signal.throwIfAborted();
        requireCadOwner(eventInput, request.sessionId);
        const assets = await assetStore.putPersistentManyStaged(
          request.sessionId,
          result.assets,
          request.operationId,
        );
        try {
          controller.signal.throwIfAborted();
          requireCadOwner(eventInput, request.sessionId);
        } catch (error) {
          await assetStore.discardPersistentStages(
            request.sessionId,
            assets.map((asset) => asset.descriptor.assetId),
            request.operationId,
          );
          throw error;
        }
        return { ok: true, value: { ...result, assets } };
      } finally {
        event.sender.removeListener("destroyed", cancel);
        drawingImportJobs.finish(event.sender.id, request.operationId);
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.cadConvert, async (eventInput, input) => {
    try {
      const request = CadConvertRequestSchema.parse(input);
      const event = requireCadOwner(eventInput, request.sessionId);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      event.sender.once("destroyed", cancel);
      try {
        // Validate DXF even when it does not require binary conversion.
        const converted = await runCadCodec(
          cadRuntime(),
          request.format === "dwg" ? "dxf-to-dwg" : "dxf-to-scene",
          request.bytes,
          { signal: controller.signal },
        );
        requireCadOwner(eventInput, request.sessionId);
        return { ok: true, value: request.format === "dwg" ? converted : request.bytes };
      } finally {
        event.sender.removeListener("destroyed", cancel);
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.cadExport, async (eventInput, input) => {
    try {
      const request = CadExportRequestSchema.parse(input);
      const event = requireCadOwner(eventInput, request.sessionId);
      const selected = await showOwnedSaveDialog(event as OwnedDialogEvent, {
        title: "导出可编辑 CAD 图纸",
        defaultPath: `${[...request.name]
          .map((character) =>
            character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character,
          )
          .join("")
          .replace(/\.(?:dwg|dxf)$/iu, "")}.${request.format}`,
        filters: [{ name: `${request.format.toUpperCase()} 图纸`, extensions: [request.format] }],
      });
      if (selected.canceled || !selected.filePath) return { ok: true, value: null };
      const controller = new AbortController();
      const cancel = () => controller.abort();
      event.sender.once("destroyed", cancel);
      try {
        const converted = await runCadCodec(
          cadRuntime(),
          request.format === "dwg" ? "dxf-to-dwg" : "dxf-to-scene",
          request.bytes,
          { signal: controller.signal },
        );
        requireCadOwner(eventInput, request.sessionId);
        const target = selected.filePath.toLowerCase().endsWith(`.${request.format}`)
          ? selected.filePath
          : `${selected.filePath}.${request.format}`;
        await writeExportFile(
          target,
          Buffer.from(request.format === "dwg" ? converted : request.bytes),
        );
        return { ok: true, value: target };
      } finally {
        event.sender.removeListener("destroyed", cancel);
      }
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  const tileReads = new Map<number, number>();
  const tileReadWaiters = new Map<number, Array<() => void>>();
  function requireTileOwner(eventInput: unknown, sessionId: string, assetId: string) {
    const event = eventInput as IpcMainInvokeEvent;
    const owner = rendererLifecycleOwner(eventInput);
    const patentId = openPatentSessions.get(sessionId);
    if (
      !event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !owner ||
      patentSessionOwners.get(sessionId) !== owner ||
      !patentId
    )
      throw new AppOperationError({ code: "NO_PERMISSION", message: "Drawing access denied" });
    const patent = libraryIpcOptions?.patents?.requireActiveReadSession?.(sessionId, patentId);
    if (
      !patent?.drawingProjects.some((p) => p.baseAssetId === assetId) ||
      !patent.assets.some((a) => a.assetId === assetId && a.kind === "drawing-tiles")
    )
      throw new AppOperationError({ code: "NO_PERMISSION", message: "Drawing access denied" });
    return event;
  }
  register(IPC_CHANNELS.drawingsReadTile, async (eventInput, input) => {
    let senderId: number | undefined;
    let entered = false;
    try {
      const request = DrawingTileRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const event = requireTileOwner(eventInput, request.sessionId, request.assetId);
      senderId = event.sender.id;
      if ((tileReads.get(senderId) ?? 0) >= 2) {
        const waiters = tileReadWaiters.get(senderId) ?? [];
        if (waiters.length >= 6) return appFailure("OPERATION_IN_PROGRESS");
        tileReadWaiters.set(senderId, waiters);
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else tileReads.set(senderId, (tileReads.get(senderId) ?? 0) + 1);
      entered = true;
      if (event.sender.isDestroyed()) return appFailure("CANCELLED");
      requireTileOwner(eventInput, request.sessionId, request.assetId);
      sessions.requireActive(request.sessionId);
      const value = await assetStore.readDrawingTile(
        request.sessionId,
        request.assetId,
        request.tileId,
        request.raster,
      );
      if (event.sender.isDestroyed()) return appFailure("CANCELLED");
      sessions.requireActive(request.sessionId);
      requireTileOwner(eventInput, request.sessionId, request.assetId);
      return { ok: true, value };
    } catch (error) {
      return ipcFailure(error, logger);
    } finally {
      if (senderId !== undefined && entered) {
        const next = tileReadWaiters.get(senderId)?.shift();
        if (next) next();
        else {
          tileReadWaiters.delete(senderId);
          const n = (tileReads.get(senderId) ?? 1) - 1;
          if (n) tileReads.set(senderId, n);
          else tileReads.delete(senderId);
        }
      }
    }
  });
  register(IPC_CHANNELS.drawingsReadSource, async (eventInput, input) => {
    try {
      const request = AssetReferenceRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const descriptor = await assetStore.descriptorOrLoad(request.sessionId, request.assetId);
      if (!descriptor) throw new Error("图纸资源不存在。");
      if (descriptor.kind === "design-editor-project") return appFailure("NOT_FOUND");
      if (descriptor.kind === "drawing-tiles") {
        requireTileOwner(eventInput, request.sessionId, request.assetId);
        const index = await assetStore.readDrawingTileIndex(request.sessionId, request.assetId);
        sessions.requireActive(request.sessionId);
        requireTileOwner(eventInput, request.sessionId, request.assetId);
        return {
          ok: true,
          value: Buffer.from(JSON.stringify(index)),
        };
      }
      const asset = await assetStore.getOrLoad(request.sessionId, request.assetId);
      if (!asset) throw new Error("图纸资源不存在。");
      return { ok: true, value: asset.original };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.chemistryRasterizePreview, async (_event, requestInput) => {
    try {
      const parsedRequest = ChemicalPreviewRequestSchema.safeParse(requestInput);
      if (!parsedRequest.success) {
        if (
          typeof requestInput === "object" &&
          requestInput !== null &&
          "svg" in requestInput &&
          typeof requestInput.svg === "string" &&
          Buffer.byteLength(requestInput.svg, "utf8") > MAX_CHEMICAL_PREVIEW_SVG_BYTES
        ) {
          return appFailure("CHEMICAL_PREVIEW_TOO_LARGE");
        }
        return ipcFailure(parsedRequest.error, logger);
      }
      sessions.requireActive(parsedRequest.data.sessionId);
      const stored = await rasterizeChemicalStructureAsset(
        parsedRequest.data.svg,
        parsedRequest.data.source,
        parsedRequest.data.outputWidthMm,
      );
      const imported = await assetStore.putPersistentManyStaged(parsedRequest.data.sessionId, [
        stored,
      ]);
      const item = imported[0];
      if (!item) return appFailure("CHEMICAL_PREVIEW_FAILED");
      return ChemicalPreviewResultSchema.parse({
        ok: true,
        value: { descriptor: item.descriptor, preview: item.preview },
      });
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.chemistryReadStructureSource, async (_event, input) => {
    try {
      const request = AssetReferenceRequestSchema.strict().parse(input);
      sessions.requireActive(request.sessionId);
      const asset = await assetStore.getOrLoad(request.sessionId, request.assetId);
      if (!asset) return appFailure("CORRUPT_FILE");
      if (asset.descriptor.kind !== "chemical-preview") return { ok: true, value: null };
      if (asset.original.byteLength > MAX_CHEMICAL_PREVIEW_SVG_BYTES)
        return appFailure("CORRUPT_FILE");
      let source: ReturnType<typeof readChemicalStructureSource>;
      try {
        source = readChemicalStructureSource(
          validateChemicalPreviewSvg(Buffer.from(asset.original).toString("utf8")),
        );
      } catch {
        return appFailure("CORRUPT_FILE");
      }
      return ChemicalStructureSourceResultSchema.parse({ ok: true, value: source });
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.formulaDrawingsRender, async (_event, requestInput) => {
    try {
      const request = FormulaDrawingRenderRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      const rendered = await renderFormulaFallback(request.latex, request.outputWidthMm);
      return FormulaDrawingRenderResultSchema.parse({
        ok: true,
        value: {
          png: rendered.png,
          widthPx: rendered.widthPx,
          heightPx: rendered.heightPx,
        },
      });
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsImportMany, (_event, request) => importAndStageMany(request));
  register(IPC_CHANNELS.assetsStageReferences, async (_event, requestInput) => {
    try {
      const request = StageAssetReferencesRequestSchema.parse(requestInput);
      sessions.requireActive(request.sourceSessionId);
      sessions.requireActive(request.targetSessionId);
      const assets = [];
      for (const assetId of request.assetIds) {
        const descriptor = await assetStore.descriptorOrLoad(request.sourceSessionId, assetId);
        if (descriptor?.kind === "design-editor-project") return appFailure("NOT_FOUND");
        const asset = await assetStore.getOrLoad(request.sourceSessionId, assetId);
        if (!asset) throw new Error(`图片资源不存在：${assetId}`);
        assets.push(asset);
      }
      return {
        ok: true,
        value: await assetStore.putPersistentManyStaged(
          request.targetSessionId,
          assets,
          request.operationId,
        ),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsDiscardImports, async (_event, requestInput) => {
    try {
      const request = DiscardImportedAssetsRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      await assetStore.discardPersistentStages(
        request.sessionId,
        request.assetIds,
        request.operationId,
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsChooseAndImport, async (event, sessionIdInput) => {
    try {
      const sessionId = SessionIdSchema.parse(sessionIdInput);
      sessions.requireActive(sessionId);
      const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        title: "插入专利附图",
        properties: ["openFile"],
        filters: [{ name: "支持的图片", extensions: ["png", "jpg", "jpeg", "bmp", "tif", "tiff"] }],
      });
      const filePath = selection.filePaths[0];
      if (selection.canceled || !filePath) return { ok: true, value: null };
      return importImageFile(sessionId, filePath);
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsChooseAndImportMany, async (event, sessionIdInput) => {
    try {
      const sessionId = SessionIdSchema.parse(sessionIdInput);
      sessions.requireActive(sessionId);
      const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        title: "插入多张专利附图",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "支持的图片", extensions: ["png", "jpg", "jpeg", "bmp", "tif", "tiff"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { ok: true, value: [] };
      }
      if (selection.filePaths.length > MAX_IMAGE_IMPORT_COUNT) {
        return appFailure("IMAGE_IMPORT_LIMIT");
      }
      const selectedFileStats = await Promise.all(
        selection.filePaths.map((filePath) => stat(filePath)),
      );
      if (
        selectedFileStats.some((fileStats) => fileStats.size > MAX_IMAGE_BYTES) ||
        selectedFileStats.reduce((total, fileStats) => total + fileStats.size, 0) >
          MAX_IMAGE_IMPORT_BATCH_BYTES
      ) {
        return appFailure("IMAGE_IMPORT_LIMIT");
      }
      const stored: Awaited<ReturnType<typeof loadImageFile>>[] = [];
      for (const filePath of selection.filePaths) {
        stored.push(await loadImageFile(filePath));
      }
      const imported = await assetStore.putPersistentManyStaged(sessionId, stored);
      return {
        ok: true,
        value: imported.map((item, index) => ({
          ...item,
          importedName: stored[index]!.descriptor.originalName,
        })),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsChooseDesignFiles, async (_event, sessionIdInput) => {
    try {
      const sessionId = SessionIdSchema.parse(sessionIdInput);
      sessions.requireActive(sessionId);
      const selection = await dialog.showOpenDialog({
        title: "插入多张专利附图",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "支持的图片", extensions: [...DESIGN_IMAGE_EXTENSIONS] }],
      });
      if (selection.canceled) return { ok: true, value: [] };
      if (selection.filePaths.length > 100) throw new Error("一次最多选择100张图片。");
      const files = [];
      let total = 0;
      for (const path of selection.filePaths) {
        const size = (await stat(path)).size;
        total += size;
        if (!size || size > 50 * 1024 ** 2 || total > 128 * 1024 ** 2)
          throw new Error("单张图片限50 MiB，单批限128 MiB，请分批导入。");
        const bytes = Uint8Array.from(await readFile(path));
        files.push({ name: basename(path), bytes });
      }
      return { ok: true, value: files };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsGetPreview, async (_event, request) => {
    try {
      const { sessionId, assetId } = AssetReferenceRequestSchema.parse(request);
      sessions.requireActive(sessionId);
      const descriptor = await assetStore.descriptorOrLoad(sessionId, assetId);
      if (descriptor?.kind === "design-editor-project") return appFailure("NOT_FOUND");
      const preview = await assetStore.previewOrLoad(sessionId, assetId);
      return preview ? { ok: true, value: preview } : appFailure("NOT_FOUND");
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  let latestImageClipboardCopy = 0;
  register(IPC_CHANNELS.assetsCopyImages, async (_event, requestInput) => {
    const copySequence = ++latestImageClipboardCopy;
    try {
      const request = CopyImagesRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      const outputs = [];
      for (const image of request.images) {
        const asset = await assetStore.getOrLoad(request.sessionId, image.assetId);
        if (!asset) throw new Error(`图片资源不存在：${image.assetId}`);
        outputs.push(
          await renderEditedImage(asset.original, {
            rotationDeg: image.rotationDeg,
            format: "png",
          }),
        );
      }
      const native = nativeImage.createFromBuffer(Buffer.from(outputs[0] ?? []));
      if (native.isEmpty()) throw new Error("图片无法写入剪贴板。");
      const imageHtml = outputs.map((bytes, index) => {
        const image = request.images[index];
        const metadata = image?.layout
          ? ` data-patent-image-layout="${image.layout}" data-patent-image-width-mm="${image.widthMm ?? 80}" data-patent-image-alignment="${image.alignment ?? "center"}" data-patent-image-rotation-deg="0"`
          : "";
        const chemicalMetadata = image?.chemicalStructure
          ? ` data-patent-chemical-ket-base64="${Buffer.from(image.chemicalStructure.ketSource, "utf8").toString("base64")}" data-patent-chemical-editor-mode="${image.chemicalStructure.editorMode}" data-patent-chemical-width-mm="${image.chemicalStructure.widthMm}" data-patent-chemical-alignment="${image.chemicalStructure.alignment}"`
          : "";
        return `<img src="data:image/png;base64,${Buffer.from(bytes).toString("base64")}" alt="${image?.label ?? "专利图片"}"${metadata}${chemicalMetadata}>`;
      });
      const html = request.htmlTemplate
        ? imageHtml.reduce(
            (content, image, index) => content.replaceAll(imageClipboardMarker(index), image),
            request.htmlTemplate,
          )
        : imageHtml.join("");
      if (copySequence !== latestImageClipboardCopy) {
        return { ok: true, value: undefined };
      }
      clipboard.write({
        image: native,
        html,
        text: request.text ?? request.images.map((image) => image.label).join("\n"),
      });
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsSaveImage, async (event, requestInput) => {
    try {
      const request = SaveImageRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      const asset = await assetStore.getOrLoad(request.sessionId, request.image.assetId);
      if (!asset) return appFailure("NOT_FOUND");
      const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
        title: "另存为图片",
        defaultPath: `${request.image.label}.${request.format ?? "png"}`,
        filters: [
          { name: "PNG 图片", extensions: ["png"] },
          { name: "JPEG 图片", extensions: ["jpg", "jpeg"] },
          { name: "TIFF 图片", extensions: ["tif", "tiff"] },
        ].filter((filter) => !request.format || filter.extensions.includes(request.format)),
      });
      if (selection.canceled || !selection.filePath) return { ok: true, value: null };
      const extension = extname(selection.filePath).slice(1).toLocaleLowerCase("en-US");
      const format: ImageOutputFormat =
        request.format ??
        (extension === "jpg" || extension === "jpeg"
          ? "jpg"
          : extension === "tif" || extension === "tiff"
            ? "tif"
            : "png");
      if (
        format === "jpg" &&
        (await imageHasTransparency(asset.original)) &&
        !(await confirmJpegTransparency())
      ) {
        return { ok: true, value: null };
      }
      const output =
        request.format === "jpg" &&
        asset.descriptor.mediaType === "image/jpeg" &&
        request.image.rotationDeg === 0
          ? asset.original
          : await renderEditedImage(asset.original, {
              rotationDeg: request.image.rotationDeg,
              format,
            });
      const filePath =
        request.format && ![format, ...(format === "jpg" ? ["jpeg"] : [])].includes(extension)
          ? `${selection.filePath}.${format}`
          : selection.filePath;
      await writeExportFile(filePath, Buffer.from(output));
      return { ok: true, value: filePath };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsSaveImages, async (event, requestInput) => {
    try {
      const request = SaveImagesRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
        title: "选择附图导出文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      const directory = selection.filePaths[0];
      if (selection.canceled || !directory) return { ok: true, value: null };
      const extension = request.format === "jpg" ? "jpg" : request.format === "tif" ? "tif" : "png";
      const targets = request.images.map((image) => join(directory, `${image.label}.${extension}`));
      const collisions: string[] = [];
      for (const target of targets) {
        try {
          await access(target);
          collisions.push(target);
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      }
      let skipExisting = false;
      if (collisions.length > 0) {
        const decision = await dialog.showMessageBox({
          type: "warning",
          title: "知产小栈Work",
          message: `目标文件夹中已有 ${collisions.length} 个同名文件。`,
          detail: "请选择全部覆盖、跳过同名文件或取消导出。",
          buttons: ["全部覆盖", "跳过同名文件", "取消"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (decision.response === 2) return { ok: true, value: null };
        skipExisting = decision.response === 1;
      }
      const collisionSet = new Set(collisions);
      if (request.format === "jpg") {
        let hasTransparency = false;
        for (const [index, image] of request.images.entries()) {
          const target = targets[index];
          if (!target || (skipExisting && collisionSet.has(target))) continue;
          const asset = await assetStore.getOrLoad(request.sessionId, image.assetId);
          if (!asset) throw new Error(`图片资源不存在：${image.assetId}`);
          if (await imageHasTransparency(asset.original)) {
            hasTransparency = true;
            break;
          }
        }
        if (hasTransparency && !(await confirmJpegTransparency())) {
          return { ok: true, value: null };
        }
      }
      const saved: string[] = [];
      for (const [index, image] of request.images.entries()) {
        const target = targets[index];
        if (!target || (skipExisting && collisionSet.has(target))) continue;
        const asset = await assetStore.getOrLoad(request.sessionId, image.assetId);
        if (!asset) throw new Error(`图片资源不存在：${image.assetId}`);
        const output = await renderEditedImage(asset.original, {
          rotationDeg: image.rotationDeg,
          format: request.format,
        });
        await writeExportFile(target, Buffer.from(output));
        saved.push(target);
      }
      return { ok: true, value: saved };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesReadSummary, async () => {
    try {
      if (!patentTemplates) {
        throw new AppOperationError({ code: "NOT_IMPLEMENTED", message: "not implemented" });
      }
      await patentTemplateInitialization;
      return { ok: true, value: patentTemplates.readLauncherSummary() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesReadAuxiliary, async () => {
    try {
      if (!patentTemplates) {
        throw new AppOperationError({ code: "NOT_IMPLEMENTED", message: "not implemented" });
      }
      await patentTemplateInitialization;
      return { ok: true, value: patentTemplates.readAuxiliary() };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesOpenEditor, async (event, input) => {
    try {
      if (!patentTemplates) {
        throw new AppOperationError({ code: "NOT_IMPLEMENTED", message: "not implemented" });
      }
      await patentTemplateInitialization;
      const request = PatentTemplateEditorOpenRequestSchema.parse(input);
      const opened = patentTemplates.openEditor(request);
      let prepared: Awaited<ReturnType<typeof prepareTemplateEditorSnapshot>>;
      try {
        prepared = await prepareTemplateEditorSnapshot(opened, libraryIpcOptions?.assetStore);
      } catch (error) {
        patentTemplates.closeEditor({ sessionId: opened.sessionId });
        throw error;
      }
      const storedAssets = prepared.storedAssets;
      sessions.activate(opened.sessionId, `patent-template:${request.patentType}`);
      assetStore.createSession(opened.sessionId);
      for (const stored of storedAssets) assetStore.adopt(opened.sessionId, stored);
      templateEditorSessions.add(opened.sessionId);
      const owner = rendererLifecycleOwner(event);
      owner?.once("destroyed", () => {
        void retireTemplateEditorSession(opened.sessionId).catch(() => undefined);
      });
      return {
        ok: true,
        value: { ...prepared.snapshot, assets: storedAssets.map((stored) => stored.descriptor) },
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesCaptureCurrent, async (_event, input) => {
    try {
      if (!patentTemplates) {
        throw new AppOperationError({ code: "NOT_IMPLEMENTED", message: "not implemented" });
      }
      await patentTemplateInitialization;
      const request = PatentTemplateCaptureCurrentRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const captured = patentTemplates.capturePatent(request);
      const storedAssets = libraryIpcOptions
        ? await Promise.all(
            [...new Set(captured.referencedChemicalPreviewAssetIds)].map((assetId) =>
              libraryIpcOptions.assetStore.readAsset(assetId),
            ),
          )
        : [];
      for (const stored of storedAssets) assetStore.adopt(request.sessionId, stored);
      return {
        ok: true,
        value: {
          ...captured,
          referencedChemicalPreviewAssets: storedAssets.map((stored) => stored.descriptor),
        },
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesSaveEditor, async (_event, input) => {
    try {
      if (!patentTemplates) {
        throw new AppOperationError({ code: "NOT_IMPLEMENTED", message: "not implemented" });
      }
      await patentTemplateInitialization;
      const request = PatentTemplateEditorSaveRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const saved = await patentTemplates.saveEditor(request);
      const referencedAssetIds = ["invention", "utility-model"].flatMap((patentType) =>
        saved.catalog[patentType as "invention" | "utility-model"].slots.flatMap((slot) =>
          [slot.claims, slot.description, slot.abstract].flatMap((book) =>
            book
              ? book.content.flatMap((block) =>
                  block.type === "chemical-structure" ? [block.previewAssetId] : [],
                )
              : [],
          ),
        ),
      );
      try {
        await assetStore.commitPersistentStages(request.sessionId, referencedAssetIds);
      } catch {
        logWithoutBlocking(logger?.log("error", { event: "app.error", errorCode: "INTERNAL" }));
      }
      try {
        await assetStore.discardAllPersistentStages(request.sessionId);
      } catch {
        logWithoutBlocking(logger?.log("error", { event: "app.error", errorCode: "INTERNAL" }));
      }
      return { ok: true, value: saved };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.patentTemplatesCloseEditor, async (_event, input) => {
    try {
      const request = PatentTemplateEditorCloseRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      await retireTemplateEditorSession(request.sessionId);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsProcessDesignImage, async (_event, requestInput) => {
    try {
      const request = DesignImageProcessRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId);
      const asset = await assetStore.getOrLoad(request.sessionId, request.assetId);
      if (!asset) return appFailure("NOT_FOUND");
      if (
        asset.descriptor.mediaType !== "image/jpeg" &&
        asset.descriptor.mediaType !== "image/png"
      ) {
        return appFailure("INVALID_INPUT", { message: "仅支持处理 JPG、JPEG 或 PNG 图片。" });
      }
      return {
        ok: true,
        value: await processDesignImage(asset.original, request.operations),
      };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsPrepareDesignEditorSource, async (_event, input) => {
    try {
      const request = DesignImageProcessRequestSchema.parse(input);
      sessions.requireActive(request.sessionId);
      const asset = await assetStore.getOrLoad(request.sessionId, request.assetId);
      if (!asset) return appFailure("NOT_FOUND");
      if (asset.descriptor.mediaType !== "image/jpeg" && asset.descriptor.mediaType !== "image/png")
        return appFailure("INVALID_INPUT");
      const value = await prepareDesignEditorSource(asset.original, request.operations);
      sessions.requireActive(request.sessionId);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof EditorResourceAdmissionError)
        return appFailure("INVALID_INPUT", { message: error.message });
      return ipcFailure(error, logger);
    }
  });
  registerEditorWorkspaceResources(register, {
    leases: editorWorkspaceLeases,
    requireActive: (sessionId) => {
      sessions.requireActive(sessionId);
    },
    failure: (error) => {
      if (
        error instanceof EditorResourceAdmissionError ||
        error instanceof EditorWorkspaceConflictError
      )
        return appFailure("INVALID_INPUT", { message: error.message });
      return ipcFailure(error, logger);
    },
  });
  register(IPC_CHANNELS.assetsStageDesignEditorProject, async (_event, input) => {
    try {
      const request = StageDesignEditorProjectRequestSchema.parse(input);
      return {
        ok: true,
        value: await stageEditorProject(request, assetStore, () => {
          sessions.requireActive(request.sessionId);
        }),
      };
    } catch (error) {
      if (error instanceof EditorResourceAdmissionError)
        return appFailure("INVALID_INPUT", { message: error.message });
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.assetsReadDesignEditorProject, async (_event, input) => {
    try {
      const request = AssetReferenceRequestSchema.parse(input);
      const patents = libraryIpcOptions?.patents;
      if (!patents?.requireActiveReadSession) return appFailure("NOT_FOUND");
      const value = await readPersistedEditorProject(request, assetStore, () => {
        const patentId = sessions.requireActive(request.sessionId);
        const patent = patents.requireActiveReadSession!(request.sessionId, patentId);
        if (
          patent.patentType !== "design" ||
          !patent.assets.some(
            (asset) => asset.assetId === request.assetId && asset.kind === "design-editor-project",
          )
        )
          throw new AppOperationError({ code: "NOT_FOUND", message: "normalized" });
      });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof EditorResourceAdmissionError)
        return appFailure("INVALID_INPUT", { message: error.message });
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.exportsDocx, async (event, requestInput) => {
    let outputPath: string | undefined;
    try {
      const request = ExportRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.document.documentId);
      return await operations.run(request.sessionId, "export-docx", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "导出 DOCX 文档",
          defaultPath: createDocxDefaultFilename(request.suggestedName),
          filters: [{ name: "Word 文档", extensions: ["docx"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        outputPath = ensureDocxExtension(selection.filePath);
        const value = await saveDocxToPath(
          outputPath,
          { sessionId: request.sessionId, document: request.document },
          assetStore,
        );
        logWithoutBlocking(logger?.log("info", { event: "export.completed", path: outputPath }));
        return { ok: true, value };
      });
    } catch (error) {
      if (error instanceof DocxExportError) {
        const normalized = normalizeAppError({
          code: "EXPORT_FAILED",
          message: "normalized",
          ...(outputPath ? { outputPath } : {}),
          issues: error.issues.map(publicDocxExportIssue),
        });
        logWithoutBlocking(
          logger?.log("error", {
            event: "export.failed",
            errorCode: normalized.code,
            path: outputPath,
          }),
        );
        return {
          ok: false,
          error: normalized,
        };
      }
      return ipcFailure(error, logger, "export.failed", outputPath);
    }
  });
  register(IPC_CHANNELS.exportsPatentDocx, async (event, requestInput) => {
    let outputPath: string | undefined;
    try {
      const request = PatentDocxExportRequestSchema.parse(requestInput);
      const patentService = libraryIpcOptions?.patents;
      if (!patentService) return serviceNotConnected;
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-patent-docx", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "导出专利 DOCX 文档",
          defaultPath: createDocxDefaultFilename(request.suggestedName),
          filters: [{ name: "Word 文档", extensions: ["docx"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        outputPath = ensureDocxExtension(selection.filePath);
        const patent = await patentService.loadForExport({
          patentId: request.patentId,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
        });
        const value = await savePatentDocxToPath(
          outputPath,
          { ...request, patent },
          await loadPatentExportAssets(assetStore, request.sessionId, patent, request),
        );
        logWithoutBlocking(logger?.log("info", { event: "export.completed", path: outputPath }));
        return { ok: true, value };
      });
    } catch (error) {
      if (error instanceof DocxExportError) {
        const normalized = normalizeAppError({
          code: "EXPORT_FAILED",
          message: "normalized",
          ...(outputPath ? { outputPath } : {}),
          issues: error.issues.map(publicDocxExportIssue),
        });
        logWithoutBlocking(
          logger?.log("error", {
            event: "export.failed",
            errorCode: normalized.code,
            path: outputPath,
          }),
        );
        return { ok: false, error: normalized };
      }
      return ipcFailure(error, logger, "export.failed", outputPath);
    }
  });
  register(IPC_CHANNELS.exportsPatentPdf, async (event, requestInput) => {
    let outputPath: string | undefined;
    try {
      const request = PatentDocxExportRequestSchema.parse(requestInput);
      const patentService = libraryIpcOptions?.patents;
      if (!patentService) return serviceNotConnected;
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-patent-pdf", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "导出专利 PDF 文档",
          defaultPath: `${request.suggestedName}.pdf`,
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        outputPath = ensurePdfExtension(selection.filePath);
        const patent = await patentService.loadForExport({
          patentId: request.patentId,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
        });
        const printPackage = await createPatentPrintPackage({
          ...request,
          patent,
          assets: await loadPatentExportAssets(assetStore, request.sessionId, patent, request),
        });
        const value = await printService.saveHtmlPdf(
          outputPath,
          request.sessionId,
          printPackage.html,
          printPackage.issues,
        );
        logWithoutBlocking(logger?.log("info", { event: "export.completed", path: outputPath }));
        return { ok: true, value };
      });
    } catch (error) {
      if (error instanceof DocxExportError) {
        const normalized = normalizeAppError({
          code: "EXPORT_FAILED",
          message: "normalized",
          ...(outputPath ? { outputPath } : {}),
          issues: error.issues.map((issue) =>
            issue.code === "EXPORT_FAILED" ? { ...issue, message: "PDF 导出失败。" } : issue,
          ),
        });
        logWithoutBlocking(
          logger?.log("error", {
            event: "export.failed",
            errorCode: normalized.code,
            path: outputPath,
          }),
        );
        return { ok: false, error: normalized };
      }
      return ipcFailure(error, logger, "export.failed", outputPath);
    }
  });
  register(IPC_CHANNELS.flowchartsRenderPdf, async (_event, input) => {
    try {
      const request = FlowchartPdfRequestSchema.parse(input);
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-flowchart-pdf", async () => ({
        ok: true as const,
        value: await printService.createHtmlPdf(
          request.sessionId,
          buildFlowchartPdfHtml(request.svgs),
        ),
      }));
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.exportsAuxiliaryDocx, async (_event, requestInput) => {
    let outputPath: string | undefined;
    try {
      const request = AuxiliaryDocumentExportRequestSchema.parse(requestInput);
      const patentService = libraryIpcOptions?.patents;
      if (!patentService) return serviceNotConnected;
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-auxiliary-docx", async (operation) => {
        const selection = await dialog.showSaveDialog({
          title: "导出其他文档 DOCX",
          defaultPath: createDocxDefaultFilename(request.suggestedName),
          filters: [{ name: "Word 文档", extensions: ["docx"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        outputPath = ensureDocxExtension(selection.filePath);
        const patent = await patentService.loadForExport({
          patentId: request.patentId,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
        });
        const value = await saveDocxToPath(
          outputPath,
          {
            sessionId: request.sessionId,
            document: auxiliaryExportDocument(patent, request.auxiliaryDocumentId),
          },
          assetStore,
        );
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed", outputPath);
    }
  });
  register(IPC_CHANNELS.exportsAuxiliaryPdf, async (_event, requestInput) => {
    let outputPath: string | undefined;
    try {
      const request = AuxiliaryDocumentExportRequestSchema.parse(requestInput);
      const patentService = libraryIpcOptions?.patents;
      if (!patentService) return serviceNotConnected;
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-auxiliary-pdf", async (operation) => {
        const selection = await dialog.showSaveDialog({
          title: "导出其他文档 PDF",
          defaultPath: `${request.suggestedName}.pdf`,
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        outputPath = ensurePdfExtension(selection.filePath);
        const patent = await patentService.loadForExport({
          patentId: request.patentId,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
        });
        const value = await printService.savePdf(outputPath, {
          sessionId: request.sessionId,
          document: auxiliaryExportDocument(patent, request.auxiliaryDocumentId),
        });
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed", outputPath);
    }
  });
  // One short-lived, single-use destination per session. Never accept a renderer-provided path.
  register(IPC_CHANNELS.exportsDesignPatent, async (_event, requestInput) => {
    try {
      const request = DesignPatentExportRequestSchema.parse(requestInput);
      const patentService = libraryIpcOptions?.patents;
      if (!patentService) return serviceNotConnected;
      sessions.requireActive(request.sessionId, request.patentId);
      return await operations.run(request.sessionId, "export-design-patent", async (operation) => {
        const patent = await patentService.loadForExport({
          patentId: request.patentId,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
        });
        if (patent.patentType !== "design" || patent.designPatent === null) {
          return appFailure("INVALID_INPUT", { message: "当前文件不是外观设计专利。" });
        }
        const warningCodes = inspectDesignPatent(patent.designPatent).map((issue) => issue.code);
        if (!request.confirmWarnings && warningCodes.length > 0) {
          return appFailure("INVALID_INPUT", { message: "请先确认导出前提示。" });
        }
        const selection = await dialog.showOpenDialog({
          title: "选择外观设计导出位置",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selection.canceled || !selection.filePaths[0] || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        const assetBytes = async (assetId: string) => {
          const asset = await assetStore.getOrLoad(request.sessionId, assetId);
          if (!asset) throw new Error("外观设计图片资源不可用。");
          return asset.original;
        };
        const value =
          request.format === "docx"
            ? await exportDesignPatentDocx({
                patent,
                outputRoot: selection.filePaths[0],
                assetBytes,
                zip: request.zip,
                confirmWarnings: request.confirmWarnings,
              })
            : await exportDesignPatentPdf({
                patent,
                outputRoot: selection.filePaths[0],
                assetBytes,
                zip: request.zip,
                confirmWarnings: request.confirmWarnings,
                createPdf: async (_html, outputPath) => {
                  await printService.saveHtmlPdf(
                    outputPath,
                    request.sessionId,
                    renderDesignPatentBriefHtml(patent),
                  );
                },
              });
        if (!patentService.updateDesignPatent) {
          await rm(value.outputDirectory, { recursive: true, force: true });
          if (value.zipPath) await rm(value.zipPath, { force: true });
          return appFailure("NOT_FOUND", { message: "外观设计保存服务不可用。" });
        }
        const updateDesignPatent = patentService.updateDesignPatent.bind(patentService);
        const exportedAt = new Date().toISOString();
        const designPatent = {
          ...patent.designPatent,
          exports: [
            ...patent.designPatent.exports,
            {
              exportedAt,
              format: request.format,
              outputDirectory: value.outputDirectory,
              documentPath: value.documentPath,
              imagePaths: value.imagePaths,
              zipped: value.zipPath !== null,
              warningCodes,
            },
          ],
        };
        const acknowledgement = await (async () => {
          try {
            return await updateDesignPatent({
              patentId: request.patentId,
              sessionId: request.sessionId,
              expectedRevision: request.expectedRevision,
              designPatent,
              assets: patent.assets,
            });
          } catch (error) {
            await rm(value.outputDirectory, { recursive: true, force: true });
            if (value.zipPath) await rm(value.zipPath, { force: true });
            throw error;
          }
        })();
        const persistedPatent = {
          ...patent,
          revision: acknowledgement.revision,
          modifiedAt: acknowledgement.savedAt,
          designPatent,
        };
        logWithoutBlocking(
          logger?.log("info", { event: "export.completed", path: value.documentPath }),
        );
        return {
          ok: true,
          value: { ...value, patent: persistedPatent, savedAt: acknowledgement.savedAt },
        };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.exportsPreview, async (_event, requestInput) => {
    try {
      const request = PrintPreviewRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.targetId);
      return await operations.run(request.sessionId, "export-preview", async (operation) => {
        if (operation.signal.aborted) return appFailure("CANCELLED");
        const value = await printService.createPreview({
          sessionId: request.sessionId,
          document: request.document,
          layout: request.layout,
          ...(request.documents ? { documents: request.documents } : {}),
          ...(request.figureLabels ? { figureLabels: request.figureLabels } : {}),
          // Library sessions target the patent; legacy sessions target the document itself.
          patentBookLayout: request.targetId !== request.document.documentId,
        });
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.exportsListPrinters, async (event) => {
    try {
      const sender = (event as PrinterIpcEvent).sender;
      if (!sender?.getPrintersAsync) {
        throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
      }
      return { ok: true, value: toPrinterDescriptors(await sender.getPrintersAsync()) };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.exportsOpenPrinterSettings, async () => {
    try {
      if (process.platform === "darwin") {
        const error = await shell.openPath("/System/Library/PreferencePanes/PrintAndScan.prefPane");
        if (error) throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
        return { ok: true, value: undefined };
      }
      if (["openharmony", "ohos"].includes(process.platform)) {
        await dialog
          .showMessageBox({
            type: "info",
            title: "打印机设置",
            buttons: ["打开系统设置", "取消"],
            message: "将在鸿蒙系统设置中管理打印机。",
            detail: "进入打印机/扫描仪页面添加或管理设备。",
          })
          .then(async (result) => {
            if (result.response === 0) await shell.openExternal("settings:");
          });
        return { ok: true, value: undefined };
      }
      if (process.platform !== "win32") {
        throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
      }
      await shell.openExternal("ms-settings:printers");
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.exportsSavePreviewPdf, async (event, requestInput) => {
    try {
      const request = SavePreviewPdfRequestSchema.parse(requestInput);
      const previewSessionId = printService.getPreviewSessionId(request.previewId);
      if (!previewSessionId) return appFailure("NOT_FOUND");
      sessions.requireActive(previewSessionId);
      return await operations.run(previewSessionId, "export-preview-pdf", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "导出预览 PDF 文档",
          defaultPath: `${request.suggestedName}.pdf`,
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        const outputPath = ensurePdfExtension(selection.filePath);
        const value = await printService.savePreviewPdf(outputPath, request.previewId);
        logWithoutBlocking(logger?.log("info", { event: "export.completed", path: outputPath }));
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.exportsDiscardPreview, (_event, previewIdInput) => {
    try {
      const previewId = PreviewIdSchema.parse(previewIdInput);
      const sessionId = printService.getPreviewSessionId(previewId);
      if (!sessionId) return appFailure("NOT_FOUND");
      sessions.requireActive(sessionId);
      printService.discardPreview(previewId);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    }
  });
  register(IPC_CHANNELS.exportsPdf, async (event, requestInput) => {
    try {
      const request = ExportRequestSchema.parse(requestInput);
      sessions.requireActive(request.sessionId, request.document.documentId);
      return await operations.run(request.sessionId, "export-pdf", async (operation) => {
        const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
          title: "导出 PDF 文档",
          defaultPath: `${request.suggestedName}.pdf`,
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
        });
        if (selection.canceled || !selection.filePath || operation.signal.aborted) {
          return { ok: true, value: null };
        }
        const outputPath = ensurePdfExtension(selection.filePath);
        const value = await printService.savePdf(outputPath, {
          sessionId: request.sessionId,
          document: request.document,
        });
        logWithoutBlocking(logger?.log("info", { event: "export.completed", path: outputPath }));
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.exportsPrint, async (event, requestInput) => {
    try {
      const request = DirectPrintRequestSchema.parse(requestInput);
      const previewSessionId = printService.getPreviewSessionId(request.previewId);
      if (!previewSessionId || previewSessionId !== request.sessionId)
        return appFailure("NOT_FOUND");
      sessions.requireActive(request.sessionId);
      const sender = (event as PrinterIpcEvent).sender;
      if (!sender?.getPrintersAsync) {
        throw new AppOperationError({ code: "INTERNAL", message: "normalized" });
      }
      const getPrintersAsync = sender.getPrintersAsync;
      return await operations.run(request.sessionId, "print", async (operation) => {
        if (operation.signal.aborted) return appFailure("CANCELLED");
        const printers = toPrinterDescriptors(await getPrintersAsync());
        await printService.printCached(
          request,
          printers.map((printer) => printer.deviceName),
        );
        return { ok: true, value: undefined };
      });
    } catch (error) {
      return ipcFailure(error, logger, "export.failed");
    }
  });
  register(IPC_CHANNELS.documentsRelease, async (_event, sessionIdInput) => {
    let closingSessionId: string | undefined;
    try {
      const sessionId = SessionIdSchema.parse(sessionIdInput);
      const documentId = sessions.retire(sessionId);
      if (documentId) {
        closingSessionId = sessionId;
        await operations.cancelAndWaitScope(sessionId);
      }
      printService.releaseSession(sessionId);
      editorWorkspaceLeases.releaseSession(sessionId);
      assetStore.destroySession(sessionId);
      documentRegistry.release(sessionId);
      openedDocuments.delete(sessionId);
      return { ok: true, value: undefined };
    } catch (error) {
      return ipcFailure(error, logger);
    } finally {
      if (closingSessionId) operations.finishScopeClose(closingSessionId);
    }
  });

  if (libraryIpcOptions) {
    const createImportedPatent = libraryIpcOptions.patents?.createImported;
    const docxImports = createImportedPatent
      ? new DocxImportSessionService({
          dialog,
          initialImportDirectory: app.getPath("documents"),
          patents: {
            createImported: (input) => createImportedPatent.call(libraryIpcOptions.patents, input),
            appendImportedDocuments: (input) => {
              const append = libraryIpcOptions.patents?.appendImportedDocuments;
              if (!append) throw new Error("DOCX append is unavailable.");
              return append.call(libraryIpcOptions.patents, input);
            },
          },
          assetStore: {
            stageMany: async (sessionId, assets) => {
              const stageMany = libraryIpcOptions.assetStore.stageMany;
              if (!stageMany) throw new Error("DOCX import staging is unavailable.");
              return stageMany.call(libraryIpcOptions.assetStore, sessionId, assets);
            },
            commitStaged: async (sessionId, assetIds) => {
              const commitStaged = libraryIpcOptions.assetStore.commitStaged;
              if (!commitStaged) throw new Error("DOCX import staging is unavailable.");
              await commitStaged.call(libraryIpcOptions.assetStore, sessionId, assetIds);
            },
            discardStaged: async (sessionId, assetIds) => {
              const discardStaged = libraryIpcOptions.assetStore.discardStaged;
              if (!discardStaged) throw new Error("DOCX import staging is unavailable.");
              await discardStaged.call(libraryIpcOptions.assetStore, sessionId, assetIds);
            },
            readPreview: async (assetId) =>
              (await libraryIpcOptions.assetStore.readAsset(assetId)).preview,
          },
        })
      : undefined;
    const retireLibraryRendererSession = async (sessionId: string) => {
      let closingSessionId: string | undefined;
      let retiredPatentId: string | undefined;
      try {
        const patentId = openPatentSessions.get(sessionId);
        if (patentId !== undefined) {
          automation?.barrier.sessionChanged(patentId);
          retiredPatentId = patentId;
          openPatentSessions.delete(sessionId);
          designPatentSessions.delete(sessionId);
          const owner = patentSessionOwners.get(sessionId);
          patentSessionOwners.delete(sessionId);
          if (owner) ownerPatentSessions.get(owner)?.delete(sessionId);
          await snapshotTimer?.openPatentSessionsChanged();
        }
        const documentId = sessions.retire(sessionId);
        if (documentId) {
          closingSessionId = sessionId;
          await operations.cancelAndWaitScope(sessionId);
        }
        printService.releaseSession(sessionId);
        releaseAiPolishSession?.(sessionId, retiredPatentId);
        editorWorkspaceLeases.releaseSession(sessionId);
        await assetStore.discardAllPersistentStages(sessionId);
        assetStore.destroySession(sessionId);
      } finally {
        if (closingSessionId) operations.finishScopeClose(closingSessionId);
      }
    };
    const trackOpenPatentSession = async (
      opened: Parameters<NonNullable<RegisterLibraryIpcOptions["onPatentSessionOpened"]>>[0],
      event: unknown,
    ) => {
      openPatentSessions.set(opened.sessionId, opened.patentId);
      if (opened.patent.patentType === "design") designPatentSessions.add(opened.sessionId);
      automation?.barrier.sessionChanged(opened.patentId);
      const owner = rendererLifecycleOwner(event);
      if (owner) {
        patentSessionOwners.set(opened.sessionId, owner);
        let ownedSessions = ownerPatentSessions.get(owner);
        const firstSessionForOwner = ownedSessions === undefined;
        if (!ownedSessions) {
          ownedSessions = new Set();
          ownerPatentSessions.set(owner, ownedSessions);
        }
        ownedSessions.add(opened.sessionId);
        if (firstSessionForOwner) {
          const releaseDestroyedSessions = () => {
            const destroyedSessions = [...(ownerPatentSessions.get(owner) ?? [])];
            ownerPatentSessions.delete(owner);
            void Promise.allSettled(
              destroyedSessions.map(async (sessionId) => {
                try {
                  await retireLibraryRendererSession(sessionId);
                } finally {
                  await libraryIpcOptions.patents?.release(sessionId);
                }
              }),
            );
          };
          owner.once("destroyed", releaseDestroyedSessions);
          if (owner.isDestroyed?.()) releaseDestroyedSessions();
        }
      }
      await snapshotTimer?.openPatentSessionsChanged();
    };
    registerPatentFolderIpc(register, {
      patents: libraryIpcOptions.patents,
      requireSession: (sessionId, patentId) => {
        sessions.requireActive(sessionId, patentId);
      },
      render: async (patent, sessionId, entry, format, cad) => {
        if (entry.kind === "flowchart") {
          if (!libraryIpcOptions.flowcharts) throw new Error("流程图服务不可用。");
          return libraryIpcOptions.flowcharts.exportBackup(patent.patentId, entry.id);
        }
        if (entry.kind === "drawing") {
          const project = patent.drawingProjects.find((p) => p.projectId === entry.id)!;
          if (project.cad) {
            const compiled = cad.find((c) => c.projectId === entry.id);
            if (!compiled) throw new Error("CAD 图纸尚未生成，请重试。");
            const converted = await runCadCodec(
              cadRuntime(),
              format === "dwg" ? "dxf-to-dwg" : "dxf-to-scene",
              compiled.bytes,
            );
            return format === "dwg" ? converted : compiled.bytes;
          }
          const source = await assetStore.getOrLoad(sessionId, project.sourceAssetId);
          if (!source) throw new Error("图纸原件缺失，未导出不完整文件。");
          return source.original;
        }
        if (entry.kind === "book") {
          const bookKind = entry.id as import("../../shared/patent/model.js").PatentBookKind;
          const assets = await loadPatentExportAssets(assetStore, sessionId, patent, {
            mode: "single",
            bookKind,
          });
          if (format === "docx") {
            const output = await createPatentDocxPackage(
              { patent, mode: "single", bookKind },
              assets,
            );
            if (output.issues.some((i) => i.severity === "error"))
              throw new Error("文档包含无法导出的内容，未输出不完整文件。");
            return output.buffer;
          }
          const output = await createPatentPrintPackage({
            patent,
            mode: "single",
            bookKind,
            assets,
          });
          if (output.issues.some((i) => i.severity === "error"))
            throw new Error("文档包含无法导出的内容，未输出不完整文件。");
          return printService.createHtmlPdf(sessionId, output.html);
        }
        const document = auxiliaryExportDocument(patent, entry.id);
        if (format === "docx") {
          const output = await createDocxPackage({ sessionId, document }, assetStore);
          if (output.issues.some((i) => i.severity === "error"))
            throw new Error("文档包含无法导出的内容，未输出不完整文件。");
          return output.buffer;
        }
        const assets = [];
        for (const id of referencedDocumentAssetIds(document)) {
          const asset = await assetStore.getOrLoad(sessionId, id);
          if (!asset) throw new Error("文档资源缺失，未输出不完整文件。");
          assets.push(asset);
        }
        return printService.createHtmlPdf(sessionId, await renderPrintHtml(document, assets));
      },
    });
    registerPatentBundleIpc(
      register,
      libraryIpcOptions,
      async (payload, sessionId, reportIssues) => {
        const printPackage = await createPatentPrintPackage({
          patent: payload.patent,
          assets: payload.assets,
          mode: "combined",
        });
        if (printPackage.issues.some((issue) => issue.severity === "error"))
          throw new Error("PDF 生成失败，未输出不完整文件。");
        reportIssues(printPackage.issues);
        try {
          return await printService.createHtmlPdf(sessionId, printPackage.html);
        } finally {
          printService.releaseSession(sessionId);
        }
      },
    );
    registerLibraryIpcHandlers({
      ...libraryIpcOptions,
      register,
      logger,
      readPatentTemplates: () => readSettings().then((value) => value.patentTemplates),
      awaitPatentTemplatesReady: () => patentTemplateInitialization,
      authorizeOpenPath: (path) => openPathAuthorization.consume(path),
      ...(docxImports ? { docxImports } : {}),
      legacyDraftMigration:
        libraryIpcOptions.legacyDraftMigration ??
        new LegacyDraftMigrationService({
          draftService,
          library: libraryIpcOptions.library,
          assetStore: libraryIpcOptions.assetStore,
          state: {
            isImported: async (id) =>
              automation?.legacyDraftImported(id) ||
              (await legacyDraftMigrationState.isImported(id)),
            markImported: (id, documentId) =>
              legacyDraftMigrationState.markImported(id, documentId),
          },
        }),
      onSessionOpened: async (opened) => {
        sessions.activate(opened.sessionId, opened.document.documentId);
        assetStore.createSession(opened.sessionId, {
          kind: "library-document",
          libraryDocumentId: opened.libraryDocumentId,
        });
        for (const asset of opened.document.assets) {
          const stored = await assetStore.getOrLoad(opened.sessionId, asset.assetId);
          if (!stored) throw new AppOperationError({ code: "NOT_FOUND", message: "normalized" });
        }
      },
      onPatentSessionOpened: async (opened, event) => {
        sessions.activate(opened.sessionId, opened.patentId);
        assetStore.createSession(opened.sessionId, {
          kind: "patent",
          patentId: opened.patentId,
        });
        await trackOpenPatentSession(opened, event);
        // Resource bodies are loaded by the feature or export that consumes them.
        // Keep the complete persisted manifest for undo, snapshots and ownership.
      },
      onPatentFigureEditCommitted: (sessionId, assetIds) =>
        assetStore.commitPersistentStages(sessionId, assetIds),
      onPatentBookEditCommitted: (sessionId, assetIds) =>
        assetStore.commitPersistentStages(sessionId, assetIds),
      onPatentDesignEditCommitted: (sessionId, assetIds) =>
        assetStore.commitPersistentStages(sessionId, assetIds),
      onSessionReleased: retireLibraryRendererSession,
    });

    // --- Snapshot IPC handlers ---
    if (libraryIpcOptions.snapshots) {
      const snapshots = libraryIpcOptions.snapshots;
      const { patents } = libraryIpcOptions;
      if (!patents) throw new Error("Patent service not available");
      const requireWritableSnapshots = () => {
        if (libraryIpcOptions.readOnly) {
          throw new AppOperationError({ code: "READ_ONLY_RECOVERY", message: "read only" });
        }
      };
      let snapshotSettings = DEFAULT_SNAPSHOT_SETTINGS;
      let snapshotSettingsError: string | null = null;
      let snapshotSettingsReadId = 0;
      const readSnapshotSettings = async () => {
        const requestId = ++snapshotSettingsReadId;
        try {
          const settings = (await readSettings()).snapshot;
          if (requestId === snapshotSettingsReadId) {
            snapshotSettings = settings;
            snapshotSettingsError = null;
          }
          return { snapshot: settings };
        } catch (error) {
          if (requestId === snapshotSettingsReadId) {
            snapshotSettingsError = error instanceof Error ? error.message : "快照设置读取失败";
          }
          throw error;
        }
      };

      const activeSnapshotTimer = new SnapshotTimer({
        snapshots: {
          ...(snapshots.prepareClose
            ? { prepareClose: (patentId: string) => snapshots.prepareClose!(patentId, true) }
            : {}),
          lastAutomaticSnapshotAt: () => snapshots.lastAutomaticSnapshotAt(),
          create: async (...args) => {
            const release = libraryIpcOptions.contentSearch?.beginOperation();
            try {
              return await snapshots.create(...args);
            } finally {
              release?.();
            }
          },
          pruneAll: async () => {
            const release = libraryIpcOptions.contentSearch?.beginOperation();
            try {
              return await snapshots.pruneAll();
            } finally {
              release?.();
            }
          },
        },
        listOpenPatentIds: openSnapshotPatentIds,
        readSettings: readSnapshotSettings,
      });
      snapshotTimer = activeSnapshotTimer;
      snapshotSuspendable = activeSnapshotTimer;
      if (!libraryIpcOptions.readOnly && !startupOptions?.tutorial) activeSnapshotTimer.start();
      disposeSnapshotTimer = () => activeSnapshotTimer.shutdown();

      register(IPC_CHANNELS.snapshotStatus, async () => {
        try {
          await readSnapshotSettings();
        } catch {
          // The response below deliberately exposes the failure together with the last
          // trustworthy settings so the renderer never presents a silent disabled state.
        }
        const timerStatus = activeSnapshotTimer.status();
        return {
          ok: true,
          value: {
            enabled: snapshotSettings.enabled,
            intervalMinutes: snapshotSettings.intervalMinutes,
            openPatentCount: openSnapshotPatentIds().length,
            lastCheckAt: timerStatus.lastCheckAt,
            lastAutomaticSnapshotAt: timerStatus.lastAutomaticSnapshotAt,
            nextCheckAt: timerStatus.nextCheckAt,
            lastError: snapshotSettingsError ?? timerStatus.lastError,
          },
        };
      });

      register(IPC_CHANNELS.snapshotConfigure, async (_event, input) => {
        try {
          const settings = SnapshotSettingsSchema.parse(input);
          await settingsService.update({ snapshot: settings } as Parameters<
            SettingsService["update"]
          >[0]);
          ++snapshotSettingsReadId;
          snapshotSettings = settings;
          snapshotSettingsError = null;
          await activeSnapshotTimer.restartAutomaticClock();
          return { ok: true, value: undefined };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotList, async (_event, input) => {
        try {
          const filters =
            z
              .object({
                documentType: z.string().optional(),
                documentId: z.string().optional(),
              })
              .optional()
              .parse(input as unknown) ?? {};

          const result: SnapshotListResult = { entries: [], warnings: [] };

          // Multi-version snapshots are currently implemented for patents only.
          // Do not advertise a library document's live state as a recoverable snapshot.
          if (!filters.documentType || filters.documentType === "patent") {
            const activePatents = (await patents.list("active")).filter(
              (patent) => patent.patentType !== "design",
            );
            const targetIds = filters.documentId
              ? [filters.documentId]
              : activePatents.map((p: { patentId: string }) => p.patentId);
            const displayNames = new Map(
              activePatents.map((patent: { patentId: string; name: string | null }) => [
                patent.patentId,
                patent.name ?? "未命名专利",
              ]),
            );

            for (const patentId of targetIds) {
              try {
                const history = await snapshots.list?.(patentId);
                if (!history) continue;
                for (const snapshot of history) {
                  result.entries.push({
                    documentType: "patent",
                    documentId: patentId,
                    displayName: displayNames.get(patentId) ?? "未命名专利",
                    revision: snapshot.revision,
                    sizeBytes: snapshot.sizeBytes,
                    createdAt: snapshot.createdAt,
                    source: snapshot.source,
                    status: snapshot.status,
                    errorMessage: snapshot.errorMessage,
                    deletable: snapshot.deletable,
                    contentSummary: snapshot.contentSummary,
                  });
                }
              } catch (error) {
                result.warnings.push({
                  documentType: "patent",
                  documentId: patentId,
                  displayName: displayNames.get(patentId) ?? "未命名专利",
                  message: error instanceof Error ? error.message : "快照历史读取失败",
                });
              }
            }
          }

          return { ok: true, value: result };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotPreview, async (_event, input) => {
        try {
          const request = SnapshotContentPreviewRequestSchema.parse(input);
          const preview = await snapshots.preview(request.documentId, request.revision);
          return { ok: true, value: preview };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotPreviewAsset, async (_event, input) => {
        try {
          const request = SnapshotPreviewAssetRequestSchema.parse(input);
          const preview = await snapshots.previewAsset(
            request.documentId,
            request.revision,
            request.assetId,
          );
          return { ok: true, value: preview };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotCreate, async (_event, input) => {
        try {
          requireWritableSnapshots();
          const request = RendererSnapshotCreateRequestSchema.parse(input);
          if (request.documentType !== "patent") return appFailure("NOT_IMPLEMENTED");
          return {
            ok: true,
            value: await snapshots.create(request.documentId, request.source),
          };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotRestore, async (_event, input) => {
        try {
          requireWritableSnapshots();
          const request = SnapshotRestoreRequestSchema.parse(input);
          if (request.documentType === "patent") {
            const snapshot = await snapshots.open(request.documentId, request.revision);
            const patent = snapshot.patent as Parameters<
              typeof importPatentPatdocPayload
            >[3]["patent"];
            const assets = await Promise.all(
              patent.assets.map((asset) => libraryIpcOptions.assetStore.readAsset(asset.assetId)),
            );
            const snapshotTime = `${snapshot.createdAt.slice(0, 16).replace("T", " ")} UTC`;
            const suffix = `（快照恢复 v${snapshot.revision}，${snapshotTime}）`;
            const sourceName = patent.name ?? "未命名专利";
            const restoredName = `${sourceName.slice(0, Math.max(0, 500 - suffix.length))}${suffix}`;
            const flowcharts =
              patent.flowchartProjects.length > 0
                ? await snapshots.readFlowchartArchive(request.documentId, snapshot.revision)
                : [];
            const restored = await importPatentPatdocPayload(
              patents,
              libraryIpcOptions.assetStore,
              async () => (await readSettings()).patentTemplates,
              {
                patent: { ...patent, name: restoredName },
                assets,
                flowcharts,
              },
              libraryIpcOptions.flowcharts,
            );
            let warning: string | undefined;
            try {
              await patents.release(restored.sessionId);
            } catch {
              warning = "恢复副本已经创建，但临时会话未能释放；请重启应用后再管理该副本。";
              logWithoutBlocking(
                logger?.log("error", { event: "app.error", errorCode: "INTERNAL" }),
              );
            }
            return {
              ok: true,
              value: {
                documentType: "patent" as const,
                documentId: restored.patentId,
                displayName: restored.patent.name ?? "未命名专利",
                ...(warning ? { warning } : {}),
              },
            };
          } else {
            // Library document restore: not supported — snapshot data is full patent only
            return appFailure("NOT_IMPLEMENTED");
          }
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });

      register(IPC_CHANNELS.snapshotDelete, async (_event, input) => {
        try {
          requireWritableSnapshots();
          const request = SnapshotRestoreRequestSchema.parse(input);
          if (request.documentType !== "patent") {
            return appFailure("INVALID_INPUT");
          }
          const value = await snapshots.delete(request.documentId, request.revision);
          return { ok: true, value };
        } catch (error) {
          return ipcFailure(error, logger);
        }
      });
    }
  }

  const dataTransferRuntime = libraryIpcOptions?.dataTransferRuntime;
  if (dataTransferRuntime && !startupReadOnly) {
    const inspector = new EmptyLibraryInspector({
      libraryRoot: dataTransferRuntime.libraryRoot,
      userDataRoot: dataTransferRuntime.userDataRoot,
      applicationDataRoot: dataTransferRuntime.applicationDataRoot,
      database: dataTransferRuntime.database,
    });
    const selectionRegistry = new TransferSelectionRegistry({
      libraryRoot: dataTransferRuntime.libraryRoot,
      userDataRoot: dataTransferRuntime.userDataRoot,
      applicationDataRoot: dataTransferRuntime.applicationDataRoot,
    });
    const noOpSuspendable = {
      suspend: async () => async () => undefined,
    };
    const quiescence = new DataTransferQuiescence({
      snapshot: snapshotSuspendable ?? noOpSuspendable,
      backup: backupService ?? noOpSuspendable,
      trash: dataTransferRuntime.backgroundScheduler,
      assets: dataTransferRuntime.assets,
      drafts: {
        waitForIdle: async () => {
          await draftService.waitForIdle();
          assertPolishTransferReady();
        },
      },
    });
    const exportService = new FullDataExportService({
      applicationVersion: app.getVersion(),
      database: dataTransferRuntime.database,
      libraryRoot: dataTransferRuntime.libraryRoot,
      userDataRoot: dataTransferRuntime.userDataRoot,
      workRoot: dataTransferRuntime.applicationDataRoot,
      draftService,
      fileService: libraryIpcOptions.fileService,
      settingsService,
      quiescence,
      gate: {
        runExclusive: async (_operationKind, task, signal) => await task(signal),
      },
    });
    const handoff = new TransferHandoffStore(
      dataTransferRuntime.applicationDataRoot,
      dataTransferRuntime.libraryRoot,
    );
    automationTransfer = {
      inspect: async () => {
        await patentTemplateInitialization;
        return {
          ...(await inspector.inspect()),
          lastImport: await handoff.read(),
          importCommitSupported: supportsAutomationImportCommit(process.platform),
          location: await startupOptions?.libraryRelocation?.status?.(),
          startupRecovery: startupRecoveryReport?.dataImportRecovery,
          summary: await inspectDataTransferSummary(
            dataTransferRuntime.database,
            draftService,
            dataTransferRuntime.libraryRoot,
            dataTransferRuntime.userDataRoot,
          ),
        };
      },
      exportPackage: (request) => exportService.export(request),
    };
    const importService = new FullDataImportService({
      readerFactory: (source) =>
        PackageReader.open(source, { currentImporterVersion: app.getVersion() }),
      libraryRoot: dataTransferRuntime.libraryRoot,
      userDataRoot: dataTransferRuntime.userDataRoot,
      applicationDataRoot: dataTransferRuntime.applicationDataRoot,
      inspector,
      resolveSourceSelection: async (selectionId) => ({
        selectionId,
        sourceHandle: (await selectionRegistry.leaseSource(selectionId)) as TransferSourceHandle,
      }),
      readCurrentSettings: async () => await readSettings(),
    });
    const journal = new DataImportJournal({
      applicationDataRoot: dataTransferRuntime.applicationDataRoot,
      libraryRoot: dataTransferRuntime.libraryRoot,
      userDataRoot: dataTransferRuntime.userDataRoot,
    });
    const stagingValidator = new ImportStagingValidator();
    const commitPreparedImport = async (operationId: string, detach?: () => Promise<void>) => {
      const lease = await importService.takePreparedImportLease(operationId);
      if (!lease) throw new AppOperationError({ code: "NOT_FOUND", message: "normalized" });
      const validatePreparedStaging = async () => {
        const [packageRoot, portableSettingsRoot] = await Promise.all([
          findOwnedPackageExtractionRoot(lease.prepared.libraryStagingCapability.root),
          findOwnedPackageExtractionRoot(lease.prepared.userDataStagingCapability.root),
        ]);
        return await stagingValidator.validate(
          {
            libraryRoot: lease.prepared.stagingLibraryPath,
            userDataRoot: lease.prepared.userDataStagingCapability.root,
            packageRoot,
            portableSettingsRoot,
            legacyDraftsRoot: lease.prepared.stagingDraftsPath,
            ...(lease.prepared.stagingPolishHistoryPath
              ? { polishHistoryRoot: lease.prepared.stagingPolishHistoryPath }
              : {}),
            installed: true,
            installedDatabaseIntegrity: {
              byteLength: Number(lease.prepared.stagingDatabaseIntegrity.size),
              sha256: lease.prepared.stagingDatabaseIntegrity.sha256,
            },
          },
          lease.prepared.manifest,
        );
      };
      await new LibraryImportSwapCoordinator({
        libraryRoot: dataTransferRuntime.libraryRoot,
        userDataRoot: dataTransferRuntime.userDataRoot,
        applicationDataRoot: dataTransferRuntime.applicationDataRoot,
        prepared: lease.prepared,
        lease,
        journal,
        ensureCurrentState: async () => {
          await Promise.all([settingsService.ensurePersisted(), draftService.ensureRoot()]);
        },
        inspectEmptyLibrary: async (options) => await inspector.inspect(options),
        validateStaging: validatePreparedStaging,
        closeRuntime: async () => {
          await detach?.();
          if (!detach) {
            await automationInitialization;
            await automation?.detachDatabaseForImport();
          }
          await dataTransferRuntime.closeRuntime();
        },
      }).commit();
    };
    automationTransferImport = {
      prepare: async (sourcePath, password, operationId, signal, assertSource) => {
        assertSource();
        const reader = await PackageReader.open(sourcePath, {
          currentImporterVersion: app.getVersion(),
        });
        let header: Awaited<ReturnType<PackageReader["readPublicHeader"]>>;
        try {
          assertSource();
          header = await reader.readPublicHeader();
        } finally {
          await reader.close();
        }
        const sourceHandle = await TransferSourceHandle.open(sourcePath);
        try {
          assertSource();
          await sourceHandle.assertStable(signal);
          const selection = await selectionRegistry.registerSource(-1, {
            fileName: basename(sourcePath),
            sourceHandle,
            header,
          });
          return await importService.prepareImport({
            operationId,
            sourceSelectionId: selection.selectionId,
            password,
            signal,
          });
        } finally {
          await selectionRegistry.releaseOwner(-1);
          await sourceHandle.close();
        }
      },
      discard: (id) => importService.retirePreparedImport(id),
      schedule: async (id) => {
        if (!importService.getPreparedImport(id))
          throw new AutomationError("NOT_FOUND", "导入预览已失效。");
        await handoff.write(id, "scheduled");
      },
      fail: async (id) => {
        await handoff.write(id, "failed");
      },
      commit: async (id, detach) => {
        let restartRequired = false;
        try {
          await commitPreparedImport(id, async () => {
            await detach();
            restartRequired = true;
          });
          await handoff.write(id, "restart-validation-pending");
        } catch (error) {
          restartRequired ||= error instanceof LibraryImportSwapError && error.restartRequired;
          await handoff.write(id, restartRequired ? "recovery-required" : "failed");
          if (!restartRequired) throw error;
        } finally {
          if (restartRequired) {
            authorizeCloseForRelaunch();
            app.relaunch();
            app.quit();
          }
        }
      },
    };
    disposeDataTransfer = registerDataTransferIpc({
      register: (channel, handler) => register(channel, handler as (...args: unknown[]) => unknown),
      registry: selectionRegistry,
      services: {
        inspectLibrary: async () => {
          await patentTemplateInitialization;
          const inspection = await inspector.inspect();
          return {
            ...inspection,
            summary: await inspectDataTransferSummary(
              dataTransferRuntime.database,
              draftService,
              dataTransferRuntime.libraryRoot,
              dataTransferRuntime.userDataRoot,
            ),
          };
        },
        chooseExportPath: async (event) => {
          const selection = await showOwnedSaveDialog(event as OwnedDialogEvent, {
            title: "导出完整数据包",
            defaultPath: `知产小栈Work完整数据-${new Date().toISOString().slice(0, 10)}.zxwbackup`,
            filters: [{ name: "知产小栈Work完整数据包", extensions: ["zxwbackup"] }],
          });
          return selection.canceled ? null : (selection.filePath ?? null);
        },
        chooseImportSource: async (event) => {
          const selection = await showOwnedOpenDialog(event as OwnedDialogEvent, {
            title: "选择完整数据包",
            properties: ["openFile"],
            filters: [{ name: "知产小栈Work完整数据包", extensions: ["zxwbackup"] }],
          });
          const sourcePath = selection.filePaths[0];
          if (selection.canceled || !sourcePath) return null;
          const reader = await PackageReader.open(sourcePath, {
            currentImporterVersion: app.getVersion(),
          });
          let header: Awaited<ReturnType<PackageReader["readPublicHeader"]>>;
          try {
            header = await reader.readPublicHeader();
          } finally {
            await reader.close();
          }
          const sourceHandle = await TransferSourceHandle.open(sourcePath);
          return { fileName: basename(sourcePath), sourceHandle, header };
        },
        exportPackage: async (request) => await exportService.export(request),
        prepareImport: async (request) => await importService.prepareImport(request),
        discardImport: async (operationId) =>
          await importService.discardPreparedImport(operationId),
        commitImport: ({ operationId }) => commitPreparedImport(operationId),
      },
      lifecycle: {
        setImmediate: (task) => setImmediate(task),
        reportImportRecoveryFailure: () =>
          dialog.showErrorBox(
            "导入未完成",
            "软件将重新启动，检查并恢复数据。请保留原数据包，重启后查看恢复结果。",
          ),
        authorizeCloseForRelaunch,
        relaunch: () => app.relaunch(),
        quit: () => app.quit(),
      },
    });
  }

  return async () => {
    editorWorkspaceLeases.dispose();
    await updates.close();
    disposeAutomationAttention?.();
    await automationInitialization;
    await automation?.close();
    automationCredentials?.clearSessionCache();
    if (libraryIpcOptions?.contentSearch)
      ipcMain.removeListener(IPC_CHANNELS.contentSearchActivity, onSearchActivity);
    await settleShutdownTasks([
      () => libraryIpcOptions?.contentSearch?.close(),
      ...[...templateEditorSessions].map(
        (sessionId) => () => retireTemplateEditorSession(sessionId),
      ),
      () => disposeDataTransfer?.(),
      () => Promise.resolve(backupServiceInitialization).finally(() => backupService?.shutdown()),
      () => disposeSnapshotTimer?.(),
    ]);
  };
}

async function findOwnedPackageExtractionRoot(ownerRoot: string): Promise<string> {
  const candidates = (await readdir(ownerRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\.package-extract-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          entry.name,
        ),
    )
    .map((entry) => resolve(ownerRoot, entry.name));
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate) {
    throw new AppOperationError({ code: "IMPORT_RECOVERY_REQUIRED", message: "normalized" });
  }
  const info = await lstat(candidate);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    resolve(await realpath(candidate)) !== candidate
  ) {
    throw new AppOperationError({ code: "IMPORT_RECOVERY_REQUIRED", message: "normalized" });
  }
  return candidate;
}

async function inspectDataTransferSummary(
  database: LibraryDatabase,
  drafts: Pick<DraftService, "list">,
  libraryRoot: string,
  userDataRoot: string,
) {
  const count = (sql: string) =>
    database.read((connection) => connection.prepare(sql).get() as { count: number } | undefined)
      ?.count ?? 0;
  const [legacyDrafts, libraryBytes, draftBytes] = await Promise.all([
    drafts.list(),
    regularFileBytes(libraryRoot),
    regularFileBytes(join(userDataRoot, "drafts")),
  ]);
  return {
    activePatents: count("SELECT COUNT(*) AS count FROM patents WHERE deleted_at IS NULL"),
    trashedPatents: count("SELECT COUNT(*) AS count FROM patents WHERE deleted_at IS NOT NULL"),
    documents: count("SELECT COUNT(*) AS count FROM documents"),
    legacyDrafts: legacyDrafts.length,
    snapshots:
      count("SELECT COUNT(*) AS count FROM snapshots") +
      count("SELECT COUNT(*) AS count FROM document_snapshots"),
    assets: count("SELECT COUNT(*) AS count FROM assets"),
    flowchartProjects: count("SELECT COUNT(*) AS count FROM patent_flowcharts"),

    totalBytes: libraryBytes + draftBytes,
  };
}

async function regularFileBytes(root: string): Promise<number> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("Unsafe data transfer summary path");
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Unsafe data transfer summary path");
    bytes += await regularFileBytes(join(root, entry.name));
    if (!Number.isSafeInteger(bytes)) throw new Error("Data transfer summary is too large");
  }
  return bytes;
}

function safePatdocName(title: string): string {
  const safeTitle =
    [...title.replace(/[<>:"/\\|?*]/gu, "_")]
      .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("")
      .trim() || "未命名专利";
  return `${safeTitle}.patdoc`;
}

function ensurePatdocExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").endsWith(".patdoc") ? path : `${path}.patdoc`;
}

function ensureDocxExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").endsWith(".docx") ? path : `${path}.docx`;
}

function ensurePdfExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").endsWith(".pdf") ? path : `${path}.pdf`;
}

type AppFailure = Extract<AppResult<never>, { ok: false }>;

type PrinterIpcEvent = {
  sender?: {
    getPrintersAsync?: () => Promise<unknown[]>;
  };
};

function appFailure(code: AppErrorCode, details: Partial<AppError> = {}): AppFailure {
  return {
    ok: false,
    error: normalizeAppError({ code, message: "normalized", ...details }),
  };
}

function notReady(): AppResult<never> {
  return { ok: false, error: normalizeAppError({ code: "INTERNAL", message: "normalized" }) };
}

async function restorePatentFromBackup(
  payload: Parameters<typeof importPatentPatdocPayload>[3],
  patents: NonNullable<RegisterLibraryIpcOptions["patents"]>,
  assetStore: PersistentAssetStore,
  settingsService: SettingsService,
  flowcharts: RegisterLibraryIpcOptions["flowcharts"],
): Promise<{ documentType: "patent"; documentId: string; displayName: string }> {
  const restored = await importPatentPatdocPayload(
    patents,
    assetStore,
    async () => (await settingsService.read()).patentTemplates,
    {
      ...payload,
      patent: {
        ...payload.patent,
        name: `${(payload.patent.name ?? "未命名专利").slice(0, 495)} (恢复)`,
      },
    },
    flowcharts,
  );
  await patents.release(restored.sessionId).catch(() => {});
  return {
    documentType: "patent",
    documentId: restored.patentId,
    displayName: restored.patent.name ?? "未命名专利",
  };
}

const BackupSourceMetadataSchema = BackupTargetSchema.extend({
  documentType: z.literal("library_document"),
  displayName: z.string().min(1).max(500),
  revision: z.number().int().nonnegative(),
});

function createBackupService(
  settingsService: SettingsService,
  libOpts: {
    contentSearch?: RegisterLibraryIpcOptions["contentSearch"];
    library: Pick<
      LibraryService,
      "list" | "open" | "flush" | "importDocument" | "release" | "rename"
    >;
    patents: NonNullable<RegisterLibraryIpcOptions["patents"]>;
    fileService: Pick<FileService, "openDocument" | "openPatent" | "saveDocument" | "savePatent">;
    assetStore: PersistentAssetStore;
    flowcharts?: RegisterLibraryIpcOptions["flowcharts"];
  },
): BackupService {
  const { library, patents, fileService, assetStore, flowcharts } = libOpts;

  return new BackupService({
    ...(libOpts.contentSearch
      ? {
          beginBackgroundOperation: () =>
            libOpts.contentSearch?.beginOperation() ?? (() => undefined),
        }
      : {}),
    settings: settingsService,
    delegate: {
      async listModified(): Promise<DocumentModifiedInfo[]> {
        const result: DocumentModifiedInfo[] = [];
        const docs = await library.list("active");
        for (const doc of docs) {
          result.push({
            documentType: "library_document",
            documentId: doc.libraryDocumentId,
            displayName: doc.title,
            createdAt: doc.createdAt,
            modifiedAt: doc.modifiedAt,
            revision: doc.revision,
          });
        }
        const pats = await patents.list("active");
        for (const pat of pats) {
          result.push({
            documentType: "patent",
            documentId: pat.patentId,
            displayName: pat.name ?? "未命名专利",
            createdAt: pat.createdAt,
            ...(pat.patentType === "design" ? {} : { patentType: pat.patentType }),
            customer: pat.customer,
            modifiedAt: pat.modifiedAt,
            revision: pat.revision,
          });
        }
        return result;
      },

      async backupOne(info: DocumentModifiedInfo, filePath: string): Promise<void> {
        if (info.documentType === "patent") {
          const patentOpened = await patents.open(info.documentId);
          try {
            await patents.flush(info.documentId, patentOpened.revision);
            const reopened = await patents.open(info.documentId);
            try {
              if (reopened.patent.flowchartProjects.length > 0 && !flowcharts) {
                throw new Error("流程图归档服务不可用，已取消备份以避免数据丢失。");
              }
              const archivedFlowcharts = flowcharts
                ? await Promise.all(
                    reopened.patent.flowchartProjects.map(async (project) => ({
                      projectId: project.projectId,
                      source: await flowcharts.exportBackup(
                        reopened.patent.patentId,
                        project.projectId,
                      ),
                    })),
                  )
                : [];
              const assets = await Promise.all(
                reopened.patent.assets.map((a) => assetStore.readAsset(a.assetId)),
              );
              const result = await fileService.savePatent(filePath, {
                patent: reopened.patent,
                assets,
                flowcharts: archivedFlowcharts,
              });
              if (!result.ok) throw new Error(result.error.message);
              // Verify backup integrity
              const verify = await fileService.openPatent(filePath);
              if (!verify.ok) {
                const retryResult = await fileService.savePatent(filePath, {
                  patent: reopened.patent,
                  assets,
                  flowcharts: archivedFlowcharts,
                });
                if (!retryResult.ok) throw new Error("备份重试写入失败");
                const retriedVerify = await fileService.openPatent(filePath);
                if (!retriedVerify.ok) throw new Error("备份重试校验失败");
              }
            } finally {
              await patents.release(reopened.sessionId).catch(() => {});
            }
          } finally {
            await patents.release(patentOpened.sessionId).catch(() => {});
          }
        } else {
          const docOpened = await library.open(info.documentId);
          try {
            await library.flush(info.documentId, docOpened.revision);
            const reopened = await library.open(info.documentId);
            try {
              const assets = await Promise.all(
                reopened.document.assets.map((a) => assetStore.readAsset(a.assetId)),
              );
              const result = await fileService.saveDocument(filePath, {
                document: reopened.document,
                settings: {
                  backupSource: {
                    documentType: info.documentType,
                    documentId: info.documentId,
                    displayName: reopened.document.title,
                    revision: reopened.revision,
                  },
                },
                editorState: reopened.editorState,
                assets,
              });
              if (!result.ok) throw new Error(result.error.message);
              // Verify backup integrity
              const verify = await fileService.openDocument(filePath);
              if (!verify.ok) {
                const retryResult = await fileService.saveDocument(filePath, {
                  document: reopened.document,
                  settings: {
                    backupSource: {
                      documentType: info.documentType,
                      documentId: info.documentId,
                      displayName: reopened.document.title,
                      revision: reopened.revision,
                    },
                  },
                  editorState: reopened.editorState,
                  assets,
                });
                if (!retryResult.ok) throw new Error("备份重试写入失败");
                const retriedVerify = await fileService.openDocument(filePath);
                if (!retriedVerify.ok) throw new Error("备份重试校验失败");
              }
            } finally {
              await library.release(reopened.sessionId).catch(() => {});
            }
          } finally {
            await library.release(docOpened.sessionId).catch(() => {});
          }
        }
      },

      async inspect(filePath: string) {
        const patentOpened = await fileService.openPatent(filePath);

        if (patentOpened.ok) {
          return {
            documentType: "patent" as const,
            documentId: patentOpened.value.patent.patentId,
            displayName: patentOpened.value.patent.name ?? "未命名专利",
            revision: patentOpened.value.patent.revision,
            createdAt: patentOpened.value.patent.createdAt,
          };
        }
        const documentOpened = await fileService.openDocument(filePath);
        if (documentOpened.ok) {
          const source = BackupSourceMetadataSchema.safeParse(
            documentOpened.value.settings.backupSource,
          );
          if (source.success) {
            return { ...source.data, createdAt: documentOpened.value.document.createdAt };
          }
          return {
            documentType: "library_document" as const,
            documentId: documentOpened.value.document.documentId,
            displayName: documentOpened.value.document.title,
            revision: 0,
            createdAt: documentOpened.value.document.createdAt,
          };
        }
        throw new Error(`无法读取备份文件: ${documentOpened.error.message}`);
      },

      async restoreOne(filePath: string) {
        // FileService validates the archive manifest before returning either payload.
        // A patent payload has a mandatory patent manifest; document archives do not.
        const patentOpened = await fileService.openPatent(filePath);

        if (patentOpened.ok) {
          return await restorePatentFromBackup(
            patentOpened.value,
            patents,
            assetStore,
            settingsService,
            flowcharts,
          );
        }
        const documentOpened = await fileService.openDocument(filePath);
        if (!documentOpened.ok) {
          throw new Error(`无法读取备份文件: ${documentOpened.error.message}`);
        }
        const opened = await importPatdocPayload(
          library as never,
          assetStore,
          documentOpened.value,
        );
        await library.release(opened.sessionId).catch(() => {});
        return {
          documentType: "library_document" as const,
          documentId: opened.libraryDocumentId,
          displayName: opened.document.title,
        };
      },
    },
  });
}

function ipcFailure(
  error: unknown,
  logger?: SafeLogger,
  event:
    | "app.error"
    | "document.open_failed"
    | "document.save_failed"
    | "draft.save_failed"
    | "export.failed" = "app.error",
  path?: string,
): AppResult<never> {
  const printFailure = mapPrintError(error);
  let failure: AppFailure;
  if (printFailure && !printFailure.ok) {
    failure = appFailure(printFailure.error.code);
  } else if (error instanceof AppOperationError) {
    failure = appFailure(error.code);
  } else if (error instanceof DataTransferOperationError) {
    failure = appFailure(error.code, { operationKind: error.operationKind });
  } else if (error instanceof ImageImportError && error.code === "TOO_LARGE") {
    failure = appFailure("IMAGE_IMPORT_LIMIT");
  } else if (error instanceof ZodError || error instanceof ImageImportError) {
    failure = appFailure("INVALID_INPUT");
  } else if (isChemicalPreviewError(error)) {
    const code =
      error.code === "INVALID_SVG"
        ? "INVALID_KETCHER_SVG"
        : error.code === "UNSAFE_SVG"
          ? "UNSAFE_KETCHER_SVG"
          : error.code === "SVG_TOO_LARGE" ||
              error.code === "DIMENSIONS_TOO_LARGE" ||
              error.code === "PNG_TOO_LARGE"
            ? "CHEMICAL_PREVIEW_TOO_LARGE"
            : "CHEMICAL_PREVIEW_FAILED";
    failure = appFailure(code);
  } else {
    const nativeCode = (error as NodeJS.ErrnoException).code;
    if (nativeCode === "CANCELLED") failure = appFailure("CANCELLED");
    else if (nativeCode === "OPERATION_IN_PROGRESS") {
      failure = appFailure("OPERATION_IN_PROGRESS");
    } else if (nativeCode === "REVISION_CONFLICT") failure = appFailure("REVISION_CONFLICT");
    else if (nativeCode === "LIBRARY_LOCKED") failure = appFailure("LIBRARY_LOCKED");
    else if (nativeCode === "INVALID_INPUT") failure = appFailure("INVALID_INPUT");
    else if (nativeCode === "SNAPSHOT_RECOVERY_PROTECTED")
      failure = appFailure("SNAPSHOT_RECOVERY_PROTECTED");
    else if (nativeCode === "CORRUPT_FILE") failure = appFailure("CORRUPT_FILE");
    else if (nativeCode === "NOT_FOUND") failure = appFailure("NOT_FOUND");
    else if (nativeCode === "EACCES" || nativeCode === "EPERM") {
      failure = appFailure("NO_PERMISSION");
    } else if (nativeCode === "EBUSY" || nativeCode === "ETXTBSY") {
      failure = appFailure("FILE_LOCKED");
    } else if (nativeCode === "ENOSPC") failure = appFailure("DISK_FULL");
    else if (nativeCode === "ENOENT") failure = appFailure("NOT_FOUND");
    else failure = appFailure("INTERNAL");
  }
  logWithoutBlocking(logger?.log("error", { event, errorCode: failure.error.code, path }));
  return failure;
}
