import { contextBridge, ipcRenderer } from "electron";
import { type ZodType, z } from "zod";
import { TextPolishWorkspaceRequestSchema } from "../shared/ai-correction/text-polish-contract.js";
import { type AutomationEvent, AutomationUiRequestSchema } from "../shared/automation/protocol.js";
import {
  ActivateDocumentSessionRequestSchema,
  AgreementStateResultSchema,
  AiApiKeyRequestSchema,
  AiCorrectionCancelRequestSchema,
  type AiCorrectionEvent,
  AiCorrectionEventSchema,
  AiCorrectionProfileRequestSchema,
  AiCorrectionSettingsRequestSchema,
  AiCorrectionSettingsStateResultSchema,
  AiCorrectionStartRequestSchema,
  AiCorrectionStartResultResultSchema,
  AiModelDiscoveryRequestSchema,
  AiModelDiscoveryResultResultSchema,
  AiProviderDocsRequestSchema,
  AiTextHashRequestSchema,
  AppSettingsPatchSchema,
  AppSettingsResultSchema,
  AssetReferenceRequestSchema,
  AuxiliaryDocumentExportRequestSchema,
  BackupConfigureRequestSchema,
  BackupConfigureResultSchema,
  BackupEntryListResultSchema,
  BackupOperationStatusResultSchema,
  BackupRestoreResultResultSchema,
  BackupRunResultResultSchema,
  BackupStatusResultSchema,
  BackupTargetSchema,
  CadConvertRequestSchema,
  CadExportRequestSchema,
  CadPreparedResultSchema,
  CadPrepareRequestSchema,
  ChemicalPreviewRequestSchema,
  ChemicalPreviewResultSchema,
  ChemicalStructureSourceResultSchema,
  ClipboardImageResultSchema,
  ClipboardImageSchema,
  ClipboardTextResultSchema,
  ClipboardTextWriteRequestSchema,
  CloseResultRequestSchema,
  CloseTokenSchema,
  CopyImagesRequestSchema,
  DataTransferLibraryInspectionResultSchema,
  DataTransferOperationIdSchema,
  DataTransferProgressSchema,
  DesignEditorProjectDataResultSchema,
  DesignEditorSourceResultSchema,
  DesignEditorWorkspaceLeaseResultSchema,
  DesignEditorWorkspaceReleaseSchema,
  DesignEditorWorkspaceRequestSchema,
  DesignFileSelectionResultSchema,
  DesignImageProcessAppResultSchema,
  DesignImageProcessRequestSchema,
  DesignPatentExportDestinationResultSchema,
  DesignPatentExportDestinationRequestSchema,
  DesignPatentExportRequestSchema,
  DirectPrintRequestSchema,
  DiscardImportedAssetsRequestSchema,
  DocxImportCancelRequestSchema,
  DocxImportCommitRequestSchema,
  DocxImportPrepareRequestSchema,
  DocxImportPreviewResultSchema,
  DocxImportUpdateRequestSchema,
  DraftListResultSchema,
  DraftSummaryResultSchema,
  DrawingCancelImportResultSchema,
  DrawingCancelImportSchema,
  DrawingImportProgressSchema,
  DrawingImportRequestSchema,
  DrawingImportResultSchema,
  DrawingTileRequestSchema,
  DualColumnWindowRequestSchema,
  ExportRequestSchema,
  FlowchartBackupResultSchema,
  FlowchartCommitPreviewRequestSchema,
  FlowchartCommitPreviewResultResultSchema,
  FlowchartCreateRequestSchema,
  FlowchartDeleteRequestSchema,
  FlowchartDeleteResultResultSchema,
  FlowchartDuplicateRequestSchema,
  FlowchartImportRequestSchema,
  FlowchartLoadRequestSchema,
  FlowchartOpenedProjectResultSchema,
  FlowchartPdfRequestSchema,
  FlowchartProjectListResultSchema,
  FlowchartRenameRequestSchema,
  FlowchartRenderPreviewRequestSchema,
  FlowchartRenderPreviewResultSchema,
  FlowchartSaveRequestSchema,
  FormulaDrawingRenderRequestSchema,
  FormulaDrawingRenderResultSchema,
  FullDataExportRequestSchema,
  FullDataExportResultResultSchema,
  FullDataImportCommitRequestSchema,
  FullDataImportCommitResultSchema,
  FullDataImportPrepareRequestSchema,
  FullDataImportPreviewResultSchema,
  ImportAssetBatchRequestSchema,
  ImportAssetRequestSchema,
  ImportedAssetListResultSchema,
  ImportedAssetResultSchema,
  IPC_CHANNELS,
  LibraryDocumentIdSchema,
  LibraryDocumentListResultSchema,
  LibraryEditAckResultSchema,
  LibraryEditBatchSchema,
  LibraryEmergencyExportPatdocRequestSchema,
  LibraryExportPatdocRequestSchema,
  LibraryFlushRequestSchema,
  LibraryFlushResultResultSchema,
  LibraryPatentIdSchema,
  LibraryPurgeResultResultSchema,
  LibraryRelocationResultSchema,
  LibraryRenameRequestSchema,
  LibraryScopeSchema,
  MenuCommandSchema,
  NullableDesignPatentExportReportResultSchema,
  NullableDocxImportPreviewResultSchema,
  NullableExportReportResultSchema,
  NullableFlowchartOpenedProjectResultSchema,
  NullableImportedAssetResultSchema,
  NullableLocalPathListResultSchema,
  NullableLocalPathResultSchema,
  NullableOpenedDocumentResultSchema,
  NullableOpenedLibraryDocumentResultSchema,
  NullableOpenedPatentResultSchema,
  NullableSavedDocumentLibraryResultSchema,
  NullableSavedDocumentResultSchema,
  NullableStringResultSchema,
  NullableTransferDestinationSelectionResultSchema,
  NullableTransferSourceSelectionResultSchema,
  OpenedDocumentResultSchema,
  OpenedLibraryDocumentResultSchema,
  OpenedPatentResultSchema,
  PatdocPathSchema,
  PatentAggregateEditResultResultSchema,
  type PatentApi,
  PatentApplyAuxiliaryDocumentEditRequestSchema,
  PatentApplyBookEditRequestSchema,
  PatentApplyFigureEditRequestSchema,
  PatentCreateAuxiliaryDocumentRequestSchema,
  PatentCreateRequestSchema,
  PatentDeleteAuxiliaryDocumentRequestSchema,
  PatentDocxExportRequestSchema,
  PatentEditAckResultSchema,
  PatentExportPatdocRequestSchema,
  PatentFlushRequestSchema,
  PatentFlushResultResultSchema,
  PatentFormattingResultSchema,
  PatentListResultSchema,
  PatentMoveAuxiliaryDocumentRequestSchema,
  PatentPurgeResultResultSchema,
  PatentRecoveryResultResultSchema,
  PatentRenameAuxiliaryDocumentRequestSchema,
  PatentResourceInspectionCancelSchema,
  PatentResourceInspectionRequestSchema,
  PatentResourceInspectionResultSchema,
  PatentSetDrawingBooksRequestSchema,
  PatentTemplateAuxiliaryCatalogResultSchema,
  PatentTemplateCaptureCurrentRequestSchema,
  PatentTemplateCapturedBooksResultSchema,
  PatentTemplateEditorCloseRequestSchema,
  PatentTemplateEditorOpenRequestSchema,
  PatentTemplateEditorSaveRequestSchema,
  PatentTemplateEditorSnapshotResultSchema,
  PatentTemplateLauncherSummaryResultSchema,
  PatentUpdateDesignPatentRequestSchema,
  PatentUpdateSettingsRequestSchema,
  PreparedRecoveryResultSchema,
  PreviewBytesResultSchema,
  PreviewIdSchema,
  PrinterDescriptorsResultSchema,
  PrintPreviewRequestSchema,
  PrintPreviewResultSchema,
  RecoverySourceSchema,
  RendererFailureReportSchema,
  SaveDocumentRequestSchema,
  SaveDraftRequestSchema,
  SavedDocumentResultSchema,
  SaveImageRequestSchema,
  SaveImagesRequestSchema,
  SavePreviewPdfRequestSchema,
  SessionIdSchema,
  Sha256ResultResultSchema,
  SnapshotContentPreviewRequestSchema,
  SnapshotContentPreviewResultSchema,
  SnapshotCreateRequestSchema,
  SnapshotCreationResultResultSchema,
  SnapshotDeletionResultResultSchema,
  SnapshotEntryListResultSchema,
  SnapshotPreviewAssetRequestSchema,
  SnapshotPreviewAssetResultSchema,
  SnapshotRestoreRequestSchema,
  SnapshotSettingsSchema,
  SnapshotStatusResultSchema,
  StableIdSchema,
  StageAssetReferencesRequestSchema,
  StageDesignEditorProjectRequestSchema,
  StartupRecoveryReportResultSchema,
  StorageFolderKindSchema,
  StorageOverviewResultSchema,
  TextPolishCancelRequestSchema,
  TextPolishConversationCancelRequestSchema,
  type TextPolishConversationEvent,
  TextPolishConversationEventSchema,
  TextPolishConversationOperationResultResultSchema,
  TextPolishConversationResetRequestSchema,
  TextPolishConversationSendRequestSchema,
  TextPolishConversationSnapshotRequestSchema,
  TextPolishConversationSnapshotResultSchema,
  TextPolishConversationStartRequestSchema,
  TextPolishConversationStartResultResultSchema,
  type TextPolishEvent,
  TextPolishEventSchema,
  TextPolishStartRequestSchema,
  TextPolishStartResultResultSchema,
  TextPolishWorkspaceResultSchema,
  UpdateStateResultSchema,
  UsageStateResultSchema,
  VoidResultSchema,
  type WindowLayoutState,
  WindowLayoutStateResultSchema,
  WindowLayoutStateSchema,
} from "../shared/ipc/contract.js";
import { PatentBundleExportSchema, PatentBundleResultSchema } from "../shared/ipc/patent-bundle.js";
import { appResultSchema } from "../shared/ipc/result.js";
import {
  TemporaryBatchBeginResultSchema,
  TemporaryBatchBeginSchema,
  TemporaryBatchPsdSchema,
  TemporaryBatchRasterSchema,
  TemporaryBatchTokenSchema,
  TemporaryExportResultSchema,
  TemporaryPsdDecodeSchema,
  TemporaryPsdExportSchema,
  TemporaryPsdResultSchema,
  TemporaryRasterDecodeSchema,
  TemporaryRasterExportSchema,
  TemporaryRasterResultSchema,
} from "../shared/ipc/temporary-images.js";
import { IpcReportRequestSchema } from "../shared/ipc-data-center.js";
import { AgreementAcceptSchema } from "../shared/legal/model.js";
import { LegislationActionSchema } from "../shared/legislation.js";
import {
  ContentSearchRequestSchema,
  ContentSearchStateSchema,
} from "../shared/library/content-search.js";
import { OfficialWebsiteIdSchema } from "../shared/official-websites.js";
import { PatentFolderExportRequestSchema } from "../shared/patent/folder.js";
import { BackgroundSaveResultSchema, StartupStateSchema } from "../shared/settings/startup.js";
import {
  TutorialContextResultSchema,
  TutorialLessonIdSchema,
  TutorialPreparedResultSchema,
} from "../shared/tutorial/model.js";
import {
  StableVersionSchema,
  UpdateDismissSchema,
  type UpdateState,
  UpdateStateSchema,
} from "../shared/updates/model.js";
import {
  UsageChoiceSchema,
  type UsageState,
  UsageStateSchema,
} from "../shared/usage-statistics/model.js";

const usageListeners = new Set<(state: UsageState) => void>();
ipcRenderer.on(IPC_CHANNELS.usageStatisticsChanged, (_event, input: unknown) => {
  const parsed = UsageStateSchema.safeParse(input);
  if (parsed.success) for (const listener of usageListeners) listener(parsed.data);
});
const updateListeners = new Set<(state: UpdateState) => void>();
ipcRenderer.on(IPC_CHANNELS.updatesChanged, (_event, input: unknown) => {
  const parsed = UpdateStateSchema.safeParse(input);
  if (parsed.success) for (const listener of updateListeners) listener(parsed.data);
});
const openPathListeners = new Set<(path: string) => void>();
const pendingOpenPaths: string[] = [];
const prepareCloseListeners = new Set<(token: string) => void>();
const pendingCloseTokens: string[] = [];
const backgroundSaveListeners = new Set<(token: string) => void>();
let pendingBackgroundSave: string | null = null;
const traySettingsListeners = new Set<() => void>();
let pendingTraySettings = false;
ipcRenderer.on(IPC_CHANNELS.applicationBackgroundSave, (_event, value: unknown) => {
  const parsed = CloseTokenSchema.safeParse(value);
  if (!parsed.success) return;
  if (!backgroundSaveListeners.size) pendingBackgroundSave = parsed.data;
  for (const listener of backgroundSaveListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.applicationTraySettings, () => {
  if (!traySettingsListeners.size) pendingTraySettings = true;
  for (const listener of traySettingsListeners) listener();
});
const drawingImportProgressListeners = new Set<
  (event: z.infer<typeof DrawingImportProgressSchema>) => void
>();
ipcRenderer.on(IPC_CHANNELS.drawingsImportProgress, (_event, value: unknown) => {
  const parsed = DrawingImportProgressSchema.safeParse(value);
  if (parsed.success) for (const listener of drawingImportProgressListeners) listener(parsed.data);
});

const windowLayoutListeners = new Set<(state: WindowLayoutState) => void>();
const aiCorrectionListeners = new Set<(event: AiCorrectionEvent) => void>();
const textPolishListeners = new Set<(event: TextPolishEvent) => void>();
const textPolishConversationListeners = new Set<(event: TextPolishConversationEvent) => void>();
const dataTransferProgressListeners = new Set<
  (event: z.infer<typeof DataTransferProgressSchema>) => void
>();
ipcRenderer.on(IPC_CHANNELS.applicationOpenPath, (_event, value: unknown) => {
  const parsed = PatdocPathSchema.safeParse(value);
  if (!parsed.success) return;
  if (openPathListeners.size === 0) {
    pendingOpenPaths.push(parsed.data);
    return;
  }
  for (const listener of openPathListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.applicationPrepareClose, (_event, value: unknown) => {
  const parsed = CloseTokenSchema.safeParse(value);
  if (!parsed.success) return;
  if (prepareCloseListeners.size === 0) {
    pendingCloseTokens.push(parsed.data);
    return;
  }
  for (const listener of prepareCloseListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.applicationWindowLayoutChanged, (_event, value: unknown) => {
  const parsed = WindowLayoutStateSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of windowLayoutListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.aiCorrectionEvent, (_event, value: unknown) => {
  const parsed = AiCorrectionEventSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of aiCorrectionListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.textPolishEvent, (_event, value: unknown) => {
  const parsed = TextPolishEventSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of textPolishListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.textPolishConversationEvent, (_event, value: unknown) => {
  const parsed = TextPolishConversationEventSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of textPolishConversationListeners) listener(parsed.data);
});
ipcRenderer.on(IPC_CHANNELS.dataTransferProgress, (_event, value: unknown) => {
  const parsed = DataTransferProgressSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of dataTransferProgressListeners) listener(parsed.data);
});

async function invokeWithoutInput<Output>(
  channel: string,
  outputSchema: ZodType<Output>,
): Promise<Output> {
  return outputSchema.parse(await ipcRenderer.invoke(channel));
}

async function invokeWithInput<Output>(
  channel: string,
  inputSchema: ZodType,
  outputSchema: ZodType<Output>,
  input: unknown,
): Promise<Output> {
  const validatedInput = inputSchema.parse(input);
  return outputSchema.parse(await ipcRenderer.invoke(channel, validatedInput));
}

const invokeDocxExport: PatentApi["exports"]["docx"] = (request) =>
  invokeWithInput(
    IPC_CHANNELS.exportsDocx,
    ExportRequestSchema,
    NullableExportReportResultSchema,
    request,
  );

const api: PatentApi = {
  tutorial: {
    isSession: process.argv.includes("--tool-tutorial-renderer"),
    ready: () => invokeWithoutInput(IPC_CHANNELS.tutorialReady, VoidResultSchema),
    read: () => invokeWithoutInput(IPC_CHANNELS.tutorialRead, TutorialContextResultSchema),
    launch: (lessonId) =>
      invokeWithInput(
        IPC_CHANNELS.tutorialLaunch,
        TutorialLessonIdSchema,
        VoidResultSchema,
        lessonId,
      ),
    prepare: (lessonId) =>
      invokeWithInput(
        IPC_CHANNELS.tutorialPrepare,
        TutorialLessonIdSchema,
        TutorialPreparedResultSchema,
        lessonId,
      ),
  },
  agreements: {
    read: () => invokeWithoutInput(IPC_CHANNELS.agreementsRead, AgreementStateResultSchema),
    accept: (request) =>
      invokeWithInput(
        IPC_CHANNELS.agreementsAccept,
        AgreementAcceptSchema,
        AgreementStateResultSchema,
        request,
      ),
  },
  usageStatistics: {
    read: () => invokeWithoutInput(IPC_CHANNELS.usageStatisticsRead, UsageStateResultSchema),
    choose: (choice) =>
      invokeWithInput(
        IPC_CHANNELS.usageStatisticsChoose,
        UsageChoiceSchema,
        UsageStateResultSchema,
        choice,
      ),
    onChanged: (listener) => {
      usageListeners.add(listener);
      return () => {
        usageListeners.delete(listener);
      };
    },
  },
  updates: {
    read: () => invokeWithoutInput(IPC_CHANNELS.updatesRead, UpdateStateResultSchema),
    start: () => invokeWithoutInput(IPC_CHANNELS.updatesStart, UpdateStateResultSchema),
    check: () => invokeWithoutInput(IPC_CHANNELS.updatesCheck, UpdateStateResultSchema),
    dismiss: (request) =>
      invokeWithInput(
        IPC_CHANNELS.updatesDismiss,
        UpdateDismissSchema,
        UpdateStateResultSchema,
        request,
      ),
    openDownload: (version) =>
      invokeWithInput(
        IPC_CHANNELS.updatesOpenDownload,
        StableVersionSchema,
        VoidResultSchema,
        version,
      ),
    onChanged: (listener) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    },
  },
  automation: {
    control: (request) =>
      invokeWithInput(
        IPC_CHANNELS.automationControl,
        AutomationUiRequestSchema,
        appResultSchema(z.unknown()),
        request,
      ),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AutomationEvent) => {
        if (
          value &&
          ["stateChanged", "libraryChanged", "barrier", "show", "close"].includes(value.type)
        )
          listener(value);
      };
      ipcRenderer.on(IPC_CHANNELS.automationEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.automationEvent, handler);
    },
  },
  contentSearch: {
    request: (request) =>
      invokeWithInput(
        IPC_CHANNELS.contentSearch,
        ContentSearchRequestSchema,
        appResultSchema(ContentSearchStateSchema),
        request,
      ),
    activity: () => ipcRenderer.send(IPC_CHANNELS.contentSearchActivity),
  },
  dataTransfer: {
    inspectLibrary: () =>
      invokeWithoutInput(
        IPC_CHANNELS.dataTransferInspectLibrary,
        DataTransferLibraryInspectionResultSchema,
      ),
    selectExportDestination: () =>
      invokeWithoutInput(
        IPC_CHANNELS.dataTransferSelectExportDestination,
        NullableTransferDestinationSelectionResultSchema,
      ),
    exportPackage: (request) =>
      invokeWithInput(
        IPC_CHANNELS.dataTransferExportPackage,
        FullDataExportRequestSchema,
        FullDataExportResultResultSchema,
        request,
      ),
    selectImportPackage: () =>
      invokeWithoutInput(
        IPC_CHANNELS.dataTransferSelectImportPackage,
        NullableTransferSourceSelectionResultSchema,
      ),
    prepareImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.dataTransferPrepareImport,
        FullDataImportPrepareRequestSchema,
        FullDataImportPreviewResultSchema,
        request,
      ),
    commitImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.dataTransferCommitImport,
        FullDataImportCommitRequestSchema,
        FullDataImportCommitResultSchema,
        request,
      ),
    cancel: (operationId) =>
      invokeWithInput(
        IPC_CHANNELS.dataTransferCancel,
        DataTransferOperationIdSchema,
        VoidResultSchema,
        operationId,
      ),
    onProgress: (listener) => {
      dataTransferProgressListeners.add(listener);
      return () => dataTransferProgressListeners.delete(listener);
    },
  },

  imageEditor: {
    beginBatch: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorBeginBatch,
        TemporaryBatchBeginSchema,
        TemporaryBatchBeginResultSchema,
        request,
      ),
    writeBatchRaster: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorWriteBatchRaster,
        TemporaryBatchRasterSchema,
        TemporaryExportResultSchema,
        request,
      ),
    writeBatchPsd: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorWriteBatchPsd,
        TemporaryBatchPsdSchema,
        TemporaryExportResultSchema,
        request,
      ),
    finishBatch: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorFinishBatch,
        TemporaryBatchTokenSchema,
        VoidResultSchema,
        request,
      ),
    decodePsd: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorDecodePsd,
        TemporaryPsdDecodeSchema,
        TemporaryPsdResultSchema,
        request,
      ),
    exportPsd: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorExportPsd,
        TemporaryPsdExportSchema,
        TemporaryExportResultSchema,
        request,
      ),
    decodeRaster: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorDecodeRaster,
        TemporaryRasterDecodeSchema,
        TemporaryRasterResultSchema,
        request,
      ),
    exportRaster: (request) =>
      invokeWithInput(
        IPC_CHANNELS.imageEditorExportRaster,
        TemporaryRasterExportSchema,
        TemporaryExportResultSchema,
        request,
      ),
  },
  chemistry: {
    readStructureSource: (request) =>
      invokeWithInput(
        IPC_CHANNELS.chemistryReadStructureSource,
        AssetReferenceRequestSchema,
        ChemicalStructureSourceResultSchema,
        request,
      ),
    rasterizePreview: (request) =>
      invokeWithInput(
        IPC_CHANNELS.chemistryRasterizePreview,
        ChemicalPreviewRequestSchema,
        ChemicalPreviewResultSchema,
        request,
      ),
  },
  formulaDrawings: {
    render: (request) =>
      invokeWithInput(
        IPC_CHANNELS.formulaDrawingsRender,
        FormulaDrawingRenderRequestSchema,
        FormulaDrawingRenderResultSchema,
        request,
      ),
  },
  ipcDataCenter: {
    saveReport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.ipcDataSaveReport,
        IpcReportRequestSchema,
        NullableStringResultSchema,
        request,
      ),
  },
  clipboard: {
    paste: () => invokeWithoutInput(IPC_CHANNELS.clipboardPaste, VoidResultSchema),
    writeImage: (image) =>
      invokeWithInput(
        IPC_CHANNELS.clipboardWriteImage,
        ClipboardImageSchema,
        VoidResultSchema,
        image,
      ),
    readImage: () =>
      invokeWithoutInput(IPC_CHANNELS.clipboardReadImage, ClipboardImageResultSchema),
    readText: () => invokeWithoutInput(IPC_CHANNELS.clipboardReadText, ClipboardTextResultSchema),
    writeText: (text) =>
      invokeWithInput(
        IPC_CHANNELS.clipboardWriteText,
        ClipboardTextWriteRequestSchema,
        VoidResultSchema,
        text,
      ),
  },
  documents: {
    activate: (request) =>
      invokeWithInput(
        IPC_CHANNELS.documentsActivate,
        ActivateDocumentSessionRequestSchema,
        VoidResultSchema,
        request,
      ),
    openDialog: () =>
      invokeWithoutInput(IPC_CHANNELS.documentsOpenDialog, NullableOpenedDocumentResultSchema),
    openPath: (path) =>
      invokeWithInput(
        IPC_CHANNELS.documentsOpenPath,
        PatdocPathSchema,
        OpenedDocumentResultSchema,
        path,
      ),
    save: (request) =>
      invokeWithInput(
        IPC_CHANNELS.documentsSave,
        SaveDocumentRequestSchema,
        SavedDocumentResultSchema,
        request,
      ),
    saveAs: (request) =>
      invokeWithInput(
        IPC_CHANNELS.documentsSaveAs,
        SaveDocumentRequestSchema,
        NullableSavedDocumentResultSchema,
        request,
      ),
    release: (sessionId) =>
      invokeWithInput(IPC_CHANNELS.documentsRelease, SessionIdSchema, VoidResultSchema, sessionId),
  },
  assets: {
    prepareCad: (request) =>
      invokeWithInput(
        IPC_CHANNELS.cadPrepare,
        CadPrepareRequestSchema,
        CadPreparedResultSchema,
        request,
      ),
    convertCad: (request) =>
      invokeWithInput(
        IPC_CHANNELS.cadConvert,
        CadConvertRequestSchema,
        PreviewBytesResultSchema,
        request,
      ),
    exportCad: (request) =>
      invokeWithInput(
        IPC_CHANNELS.cadExport,
        CadExportRequestSchema,
        NullableLocalPathResultSchema,
        request,
      ),
    onDrawingImportProgress: (listener) => {
      drawingImportProgressListeners.add(listener);
      return () => {
        drawingImportProgressListeners.delete(listener);
      };
    },
    acquireDesignEditorWorkspace: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsAcquireDesignEditorWorkspace,
        DesignEditorWorkspaceRequestSchema,
        DesignEditorWorkspaceLeaseResultSchema,
        request,
      ),
    releaseDesignEditorWorkspace: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsReleaseDesignEditorWorkspace,
        DesignEditorWorkspaceReleaseSchema,
        VoidResultSchema,
        request,
      ),
    readDesignEditorProject: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsReadDesignEditorProject,
        AssetReferenceRequestSchema,
        DesignEditorProjectDataResultSchema,
        request,
      ),
    stageDesignEditorProject: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsStageDesignEditorProject,
        StageDesignEditorProjectRequestSchema,
        ImportedAssetResultSchema,
        request,
      ),
    prepareDesignEditorSource: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsPrepareDesignEditorSource,
        DesignImageProcessRequestSchema,
        DesignEditorSourceResultSchema,
        request,
      ),
    chooseAndImport: (sessionId) =>
      invokeWithInput(
        IPC_CHANNELS.assetsChooseAndImport,
        SessionIdSchema,
        NullableImportedAssetResultSchema,
        sessionId,
      ),
    chooseAndImportMany: (sessionId) =>
      invokeWithInput(
        IPC_CHANNELS.assetsChooseAndImportMany,
        SessionIdSchema,
        ImportedAssetListResultSchema,
        sessionId,
      ),
    chooseDesignFiles: (sessionId) =>
      invokeWithInput(
        IPC_CHANNELS.assetsChooseDesignFiles,
        SessionIdSchema,
        DesignFileSelectionResultSchema,
        sessionId,
      ),
    importBytes: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsImportBytes,
        ImportAssetRequestSchema,
        ImportedAssetResultSchema,
        request,
      ),
    importDrawing: (request) =>
      invokeWithInput(
        IPC_CHANNELS.drawingsImport,
        DrawingImportRequestSchema,
        DrawingImportResultSchema,
        request,
      ),
    cancelDrawingImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.drawingsCancelImport,
        DrawingCancelImportSchema,
        DrawingCancelImportResultSchema,
        request,
      ),
    readDrawingTile: (sessionId, assetId, tileId, raster) =>
      invokeWithInput(
        IPC_CHANNELS.drawingsReadTile,
        DrawingTileRequestSchema,
        PreviewBytesResultSchema,
        { sessionId, assetId, tileId, ...(raster ? { raster } : {}) },
      ),
    readDrawingSource: (sessionId, assetId) =>
      invokeWithInput(
        IPC_CHANNELS.drawingsReadSource,
        AssetReferenceRequestSchema,
        PreviewBytesResultSchema,
        { sessionId, assetId },
      ),
    importMany: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsImportMany,
        ImportAssetBatchRequestSchema,
        ImportedAssetListResultSchema,
        request,
      ),
    stageReferences: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsStageReferences,
        StageAssetReferencesRequestSchema,
        ImportedAssetListResultSchema,
        request,
      ),
    discardImports: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsDiscardImports,
        DiscardImportedAssetsRequestSchema,
        VoidResultSchema,
        request,
      ),
    getPreview: (sessionId, assetId) =>
      invokeWithInput(
        IPC_CHANNELS.assetsGetPreview,
        AssetReferenceRequestSchema,
        PreviewBytesResultSchema,
        { sessionId, assetId },
      ),
    copyImages: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsCopyImages,
        CopyImagesRequestSchema,
        VoidResultSchema,
        request,
      ),
    saveImage: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsSaveImage,
        SaveImageRequestSchema,
        NullableLocalPathResultSchema,
        request,
      ),
    saveImages: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsSaveImages,
        SaveImagesRequestSchema,
        NullableLocalPathListResultSchema,
        request,
      ),
    processDesignImage: (request) =>
      invokeWithInput(
        IPC_CHANNELS.assetsProcessDesignImage,
        DesignImageProcessRequestSchema,
        DesignImageProcessAppResultSchema,
        request,
      ),
  },
  drafts: {
    list: () => invokeWithoutInput(IPC_CHANNELS.draftsList, DraftListResultSchema),
    save: (request) =>
      invokeWithInput(
        IPC_CHANNELS.draftsSave,
        SaveDraftRequestSchema,
        DraftSummaryResultSchema,
        request,
      ),
    open: (draftId) =>
      invokeWithInput(IPC_CHANNELS.draftsOpen, StableIdSchema, OpenedDocumentResultSchema, draftId),
    delete: (draftId) =>
      invokeWithInput(IPC_CHANNELS.draftsDelete, StableIdSchema, VoidResultSchema, draftId),
  },
  patents: {
    list: (scope) =>
      invokeWithInput(IPC_CHANNELS.patentsList, LibraryScopeSchema, PatentListResultSchema, scope),
    getLibraryPreview: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsGetLibraryPreview,
        LibraryPatentIdSchema,
        PreviewBytesResultSchema,
        patentId,
      ),
    create: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsCreate,
        PatentCreateRequestSchema,
        OpenedPatentResultSchema,
        request,
      ),
    open: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsOpen,
        LibraryPatentIdSchema,
        OpenedPatentResultSchema,
        patentId,
      ),
    openPath: (path) =>
      invokeWithInput(
        IPC_CHANNELS.patentsOpenPath,
        PatdocPathSchema,
        OpenedPatentResultSchema,
        path,
      ),
    recover: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsRecover,
        LibraryPatentIdSchema,
        PatentRecoveryResultResultSchema,
        patentId,
      ),
    updateSettings: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsUpdateSettings,
        PatentUpdateSettingsRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    updateDesignPatent: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsUpdateDesignPatent,
        PatentUpdateDesignPatentRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    setDrawingBooksEnabled: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsSetDrawingBooksEnabled,
        PatentSetDrawingBooksRequestSchema,
        PatentAggregateEditResultResultSchema,
        request,
      ),
    applyBookEdit: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsApplyBookEdit,
        PatentApplyBookEditRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    createAuxiliaryDocument: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsCreateAuxiliaryDocument,
        PatentCreateAuxiliaryDocumentRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    applyAuxiliaryDocumentEdit: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsApplyAuxiliaryDocumentEdit,
        PatentApplyAuxiliaryDocumentEditRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    renameAuxiliaryDocument: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsRenameAuxiliaryDocument,
        PatentRenameAuxiliaryDocumentRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    moveAuxiliaryDocument: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsMoveAuxiliaryDocument,
        PatentMoveAuxiliaryDocumentRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    deleteAuxiliaryDocument: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsDeleteAuxiliaryDocument,
        PatentDeleteAuxiliaryDocumentRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    applyFigureEdit: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsApplyFigureEdit,
        PatentApplyFigureEditRequestSchema,
        PatentEditAckResultSchema,
        request,
      ),
    flush: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsFlush,
        PatentFlushRequestSchema,
        PatentFlushResultResultSchema,
        request,
      ),
    inspectResources: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsInspectResources,
        PatentResourceInspectionRequestSchema,
        PatentResourceInspectionResultSchema,
        request,
      ),
    cancelResourceInspection: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsCancelResourceInspection,
        PatentResourceInspectionCancelSchema,
        VoidResultSchema,
        request,
      ),
    prepareDocxImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsPrepareDocxImport,
        DocxImportPrepareRequestSchema,
        NullableDocxImportPreviewResultSchema,
        request ?? {},
      ),
    getDocxImportPreviewAsset: (sessionId, assetId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsGetDocxImportPreviewAsset,
        AssetReferenceRequestSchema,
        PreviewBytesResultSchema,
        { sessionId, assetId },
      ),
    updateDocxImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsUpdateDocxImport,
        DocxImportUpdateRequestSchema,
        DocxImportPreviewResultSchema,
        request,
      ),
    commitDocxImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsCommitDocxImport,
        DocxImportCommitRequestSchema,
        OpenedPatentResultSchema,
        request,
      ),
    cancelDocxImport: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsCancelDocxImport,
        DocxImportCancelRequestSchema,
        VoidResultSchema,
        request,
      ),
    importPatdoc: () =>
      invokeWithoutInput(IPC_CHANNELS.patentsImportPatdoc, NullableOpenedPatentResultSchema),
    exportFolder: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsExportFolder,
        PatentFolderExportRequestSchema,
        NullableStringResultSchema,
        request,
      ),
    exportBundle: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsExportBundle,
        PatentBundleExportSchema,
        PatentBundleResultSchema,
        request,
      ),
    importBundle: () =>
      invokeWithoutInput(IPC_CHANNELS.patentsImportBundle, PatentBundleResultSchema),
    exportPatdoc: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentsExportPatdoc,
        PatentExportPatdocRequestSchema,
        NullableSavedDocumentLibraryResultSchema,
        request,
      ),
    moveToTrash: (patentId) =>
      invokeWithInput(IPC_CHANNELS.patentsTrash, LibraryPatentIdSchema, VoidResultSchema, patentId),
    restore: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsRestore,
        LibraryPatentIdSchema,
        VoidResultSchema,
        patentId,
      ),
    permanentlyDelete: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.patentsPermanentDelete,
        LibraryPatentIdSchema,
        VoidResultSchema,
        patentId,
      ),
    purgeExpired: () =>
      invokeWithoutInput(IPC_CHANNELS.patentsPurge, PatentPurgeResultResultSchema),
    release: (sessionId) =>
      invokeWithInput(IPC_CHANNELS.patentsRelease, SessionIdSchema, VoidResultSchema, sessionId),
  },
  patentTemplates: {
    readSummary: () =>
      invokeWithoutInput(
        IPC_CHANNELS.patentTemplatesReadSummary,
        PatentTemplateLauncherSummaryResultSchema,
      ),
    readAuxiliary: () =>
      invokeWithoutInput(
        IPC_CHANNELS.patentTemplatesReadAuxiliary,
        PatentTemplateAuxiliaryCatalogResultSchema,
      ),
    openEditor: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentTemplatesOpenEditor,
        PatentTemplateEditorOpenRequestSchema,
        PatentTemplateEditorSnapshotResultSchema,
        request,
      ),
    captureCurrent: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentTemplatesCaptureCurrent,
        PatentTemplateCaptureCurrentRequestSchema,
        PatentTemplateCapturedBooksResultSchema,
        request,
      ),
    saveEditor: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentTemplatesSaveEditor,
        PatentTemplateEditorSaveRequestSchema,
        PatentTemplateEditorSnapshotResultSchema,
        request,
      ),
    closeEditor: (request) =>
      invokeWithInput(
        IPC_CHANNELS.patentTemplatesCloseEditor,
        PatentTemplateEditorCloseRequestSchema,
        VoidResultSchema,
        request,
      ),
  },
  flowcharts: {
    list: (patentId) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsList,
        LibraryPatentIdSchema,
        FlowchartProjectListResultSchema,
        patentId,
      ),
    create: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsCreate,
        FlowchartCreateRequestSchema,
        FlowchartOpenedProjectResultSchema,
        request,
      ),
    importFile: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsImport,
        FlowchartImportRequestSchema,
        NullableFlowchartOpenedProjectResultSchema,
        request,
      ),
    load: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsLoad,
        FlowchartLoadRequestSchema,
        FlowchartOpenedProjectResultSchema,
        request,
      ),
    save: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsSave,
        FlowchartSaveRequestSchema,
        FlowchartOpenedProjectResultSchema,
        request,
      ),
    rename: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsRename,
        FlowchartRenameRequestSchema,
        FlowchartOpenedProjectResultSchema,
        request,
      ),
    duplicate: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsDuplicate,
        FlowchartDuplicateRequestSchema,
        FlowchartOpenedProjectResultSchema,
        request,
      ),
    delete: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsDelete,
        FlowchartDeleteRequestSchema,
        FlowchartDeleteResultResultSchema,
        request,
      ),
    exportBackup: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsExportBackup,
        FlowchartLoadRequestSchema,
        FlowchartBackupResultSchema,
        request,
      ),
    renderPreview: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsRenderPreview,
        FlowchartRenderPreviewRequestSchema,
        FlowchartRenderPreviewResultSchema,
        request,
      ),
    commitPreview: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsCommitPreview,
        FlowchartCommitPreviewRequestSchema,
        FlowchartCommitPreviewResultResultSchema,
        request,
      ),
  },
  library: {
    list: (scope) =>
      invokeWithInput(
        IPC_CHANNELS.libraryList,
        LibraryScopeSchema,
        LibraryDocumentListResultSchema,
        scope,
      ),
    create: () => invokeWithoutInput(IPC_CHANNELS.libraryCreate, OpenedLibraryDocumentResultSchema),
    open: (libraryDocumentId) =>
      invokeWithInput(
        IPC_CHANNELS.libraryOpen,
        LibraryDocumentIdSchema,
        OpenedLibraryDocumentResultSchema,
        libraryDocumentId,
      ),
    rename: (request) =>
      invokeWithInput(
        IPC_CHANNELS.libraryRename,
        LibraryRenameRequestSchema,
        LibraryEditAckResultSchema,
        request,
      ),
    applyEdit: (batch) =>
      invokeWithInput(
        IPC_CHANNELS.libraryApplyEdit,
        LibraryEditBatchSchema,
        LibraryEditAckResultSchema,
        batch,
      ),
    flush: (request) =>
      invokeWithInput(
        IPC_CHANNELS.libraryFlush,
        LibraryFlushRequestSchema,
        LibraryFlushResultResultSchema,
        request,
      ),
    moveToTrash: (libraryDocumentId) =>
      invokeWithInput(
        IPC_CHANNELS.libraryTrash,
        LibraryDocumentIdSchema,
        VoidResultSchema,
        libraryDocumentId,
      ),
    restore: (libraryDocumentId) =>
      invokeWithInput(
        IPC_CHANNELS.libraryRestore,
        LibraryDocumentIdSchema,
        VoidResultSchema,
        libraryDocumentId,
      ),
    permanentlyDelete: (libraryDocumentId) =>
      invokeWithInput(
        IPC_CHANNELS.libraryPermanentDelete,
        LibraryDocumentIdSchema,
        VoidResultSchema,
        libraryDocumentId,
      ),
    purgeExpired: () =>
      invokeWithoutInput(IPC_CHANNELS.libraryPurge, LibraryPurgeResultResultSchema),
    importPatdoc: () =>
      invokeWithoutInput(
        IPC_CHANNELS.libraryImportPatdoc,
        NullableOpenedLibraryDocumentResultSchema,
      ),
    exportPatdoc: (request) =>
      invokeWithInput(
        IPC_CHANNELS.libraryExportPatdoc,
        LibraryExportPatdocRequestSchema,
        NullableSavedDocumentLibraryResultSchema,
        request,
      ),
    emergencyExportPatdoc: (request) =>
      invokeWithInput(
        IPC_CHANNELS.libraryEmergencyExportPatdoc,
        LibraryEmergencyExportPatdocRequestSchema,
        NullableSavedDocumentLibraryResultSchema,
        request,
      ),
    listLegacyDrafts: () =>
      invokeWithoutInput(IPC_CHANNELS.libraryLegacyDrafts, DraftListResultSchema),
    importLegacyDraft: (draftId) =>
      invokeWithInput(
        IPC_CHANNELS.libraryImportLegacyDraft,
        StableIdSchema,
        OpenedLibraryDocumentResultSchema,
        draftId,
      ),
    release: (sessionId) =>
      invokeWithInput(IPC_CHANNELS.libraryRelease, SessionIdSchema, VoidResultSchema, sessionId),
  },
  settings: {
    read: () => invokeWithoutInput(IPC_CHANNELS.settingsRead, AppSettingsResultSchema),
    update: (patch) =>
      invokeWithInput(
        IPC_CHANNELS.settingsUpdate,
        AppSettingsPatchSchema,
        AppSettingsResultSchema,
        patch,
      ),
  },
  aiCorrection: {
    hashText: (text) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionHashText,
        AiTextHashRequestSchema,
        Sha256ResultResultSchema,
        text,
      ),
    getSettings: () =>
      invokeWithoutInput(
        IPC_CHANNELS.aiCorrectionGetSettings,
        AiCorrectionSettingsStateResultSchema,
      ),
    updateSettings: (settings) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionUpdateSettings,
        AiCorrectionSettingsRequestSchema,
        AiCorrectionSettingsStateResultSchema,
        settings,
      ),
    setApiKey: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionSetApiKey,
        AiApiKeyRequestSchema,
        AiCorrectionSettingsStateResultSchema,
        request,
      ),
    clearApiKey: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionClearApiKey,
        AiCorrectionProfileRequestSchema,
        AiCorrectionSettingsStateResultSchema,
        request,
      ),
    testConnection: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionTestConnection,
        AiCorrectionProfileRequestSchema,
        VoidResultSchema,
        request,
      ),
    discoverModels: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionDiscoverModels,
        AiModelDiscoveryRequestSchema,
        AiModelDiscoveryResultResultSchema,
        request,
      ),
    openProviderDocs: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionOpenProviderDocs,
        AiProviderDocsRequestSchema,
        VoidResultSchema,
        request,
      ),
    start: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionStart,
        AiCorrectionStartRequestSchema,
        AiCorrectionStartResultResultSchema,
        request,
      ),
    cancel: (request) =>
      invokeWithInput(
        IPC_CHANNELS.aiCorrectionCancel,
        AiCorrectionCancelRequestSchema,
        VoidResultSchema,
        request,
      ),
    onEvent: (listener) => {
      aiCorrectionListeners.add(listener);
      return () => aiCorrectionListeners.delete(listener);
    },
    polish: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishStart,
        TextPolishStartRequestSchema,
        TextPolishStartResultResultSchema,
        request,
      ),
    cancelPolish: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishCancel,
        TextPolishCancelRequestSchema,
        VoidResultSchema,
        request,
      ),
    onPolishEvent: (listener) => {
      textPolishListeners.add(listener);
      return () => textPolishListeners.delete(listener);
    },
    startConversation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishConversationStart,
        TextPolishConversationStartRequestSchema,
        TextPolishConversationStartResultResultSchema,
        request,
      ),
    sendConversation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishConversationSend,
        TextPolishConversationSendRequestSchema,
        TextPolishConversationOperationResultResultSchema,
        request,
      ),
    cancelConversation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishConversationCancel,
        TextPolishConversationCancelRequestSchema,
        VoidResultSchema,
        request,
      ),
    resetConversation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishConversationReset,
        TextPolishConversationResetRequestSchema,
        TextPolishConversationOperationResultResultSchema,
        request,
      ),
    snapshotConversation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishConversationSnapshot,
        TextPolishConversationSnapshotRequestSchema,
        TextPolishConversationSnapshotResultSchema,
        request,
      ),
    polishWorkspace: (request) =>
      invokeWithInput(
        IPC_CHANNELS.textPolishWorkspace,
        TextPolishWorkspaceRequestSchema,
        TextPolishWorkspaceResultSchema,
        request,
      ),
    onConversationEvent: (listener) => {
      textPolishConversationListeners.add(listener);
      return () => textPolishConversationListeners.delete(listener);
    },
  },
  exports: {
    flowchartPdf: (request) =>
      invokeWithInput(
        IPC_CHANNELS.flowchartsRenderPdf,
        FlowchartPdfRequestSchema,
        FlowchartBackupResultSchema,
        request,
      ),
    docx: invokeDocxExport,
    patentDocx: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsPatentDocx,
        PatentDocxExportRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    patentPdf: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsPatentPdf,
        PatentDocxExportRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    auxiliaryDocx: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsAuxiliaryDocx,
        AuxiliaryDocumentExportRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    auxiliaryPdf: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsAuxiliaryPdf,
        AuxiliaryDocumentExportRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    chooseDesignPatentDestination: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsChooseDesignPatentDestination,
        DesignPatentExportDestinationRequestSchema,
        DesignPatentExportDestinationResultSchema,
        request,
      ),
    designPatent: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsDesignPatent,
        DesignPatentExportRequestSchema,
        NullableDesignPatentExportReportResultSchema,
        request,
      ),
    pdf: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsPdf,
        ExportRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    preview: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsPreview,
        PrintPreviewRequestSchema,
        PrintPreviewResultSchema,
        request,
      ),
    savePreviewPdf: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsSavePreviewPdf,
        SavePreviewPdfRequestSchema,
        NullableExportReportResultSchema,
        request,
      ),
    discardPreview: (previewId) =>
      invokeWithInput(
        IPC_CHANNELS.exportsDiscardPreview,
        PreviewIdSchema,
        VoidResultSchema,
        previewId,
      ),
    listPrinters: () =>
      invokeWithoutInput(IPC_CHANNELS.exportsListPrinters, PrinterDescriptorsResultSchema),
    openPrinterSettings: () =>
      invokeWithoutInput(IPC_CHANNELS.exportsOpenPrinterSettings, VoidResultSchema),
    print: (request) =>
      invokeWithInput(
        IPC_CHANNELS.exportsPrint,
        DirectPrintRequestSchema,
        VoidResultSchema,
        request,
      ),
  },
  application: {
    relocateLibrary: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationRelocateLibrary, LibraryRelocationResultSchema),
    storageOverview: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationStorageOverview, StorageOverviewResultSchema),
    openStorageFolder: (kind) =>
      invokeWithInput(
        IPC_CHANNELS.applicationOpenStorageFolder,
        StorageFolderKindSchema,
        VoidResultSchema,
        kind,
      ),
    createDesktopShortcut: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationCreateDesktopShortcut, VoidResultSchema),
    openOfficialWebsite: (id) =>
      invokeWithInput(
        IPC_CHANNELS.applicationOpenOfficialWebsite,
        OfficialWebsiteIdSchema,
        VoidResultSchema,
        id,
      ),
    legislation: (request) =>
      invokeWithInput(
        IPC_CHANNELS.applicationLegislation,
        LegislationActionSchema,
        VoidResultSchema,
        request,
      ),
    openThirdPartyNotices: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationOpenThirdPartyNotices, VoidResultSchema),
    openThirdPartyLicensesFolder: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationOpenThirdPartyLicensesFolder, VoidResultSchema),
    getWindowLayoutState: () =>
      invokeWithoutInput(
        IPC_CHANNELS.applicationGetWindowLayoutState,
        WindowLayoutStateResultSchema,
      ),
    prepareRecovery: (source) =>
      invokeWithInput(
        IPC_CHANNELS.applicationPrepareRecovery,
        RecoverySourceSchema,
        PreparedRecoveryResultSchema,
        source,
      ),
    activateRecovery: (token) =>
      invokeWithInput(
        IPC_CHANNELS.applicationActivateRecovery,
        StableIdSchema,
        VoidResultSchema,
        token,
      ),
    getStartupRecoveryReport: () =>
      invokeWithoutInput(
        IPC_CHANNELS.applicationGetStartupRecoveryReport,
        StartupRecoveryReportResultSchema,
      ),
    maximizeWindow: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationMaximizeWindow, WindowLayoutStateResultSchema),
    setDualColumnWindow: (input) =>
      invokeWithInput(
        IPC_CHANNELS.applicationDualColumnWindow,
        DualColumnWindowRequestSchema,
        WindowLayoutStateResultSchema,
        input,
      ),
    onWindowLayoutStateChanged: (listener) => {
      windowLayoutListeners.add(listener);
      return () => windowLayoutListeners.delete(listener);
    },
    onOpenPath: (listener) => {
      openPathListeners.add(listener);
      for (const path of pendingOpenPaths.splice(0)) listener(path);
      return () => openPathListeners.delete(listener);
    },
    onPrepareClose: (listener) => {
      prepareCloseListeners.add(listener);
      for (const token of pendingCloseTokens.splice(0)) listener(token);
      return () => prepareCloseListeners.delete(listener);
    },
    onBackgroundSave: (listener) => {
      backgroundSaveListeners.add(listener);
      if (pendingBackgroundSave) {
        const token = pendingBackgroundSave;
        pendingBackgroundSave = null;
        listener(token);
      }
      return () => {
        backgroundSaveListeners.delete(listener);
      };
    },
    backgroundSaveResult: (request) =>
      invokeWithInput(
        IPC_CHANNELS.applicationBackgroundSaveResult,
        BackgroundSaveResultSchema,
        VoidResultSchema,
        request,
      ),
    onTraySettings: (listener) => {
      traySettingsListeners.add(listener);
      if (pendingTraySettings) {
        pendingTraySettings = false;
        listener();
      }
      return () => {
        traySettingsListeners.delete(listener);
      };
    },
    readStartup: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationStartupRead, appResultSchema(StartupStateSchema)),
    updateStartup: (enabled) =>
      invokeWithInput(
        IPC_CHANNELS.applicationStartupUpdate,
        z.boolean(),
        appResultSchema(StartupStateSchema),
        enabled,
      ),
    closeResult: (request) =>
      invokeWithInput(
        IPC_CHANNELS.applicationCloseResult,
        CloseResultRequestSchema,
        VoidResultSchema,
        request,
      ),
    closeHeartbeat: (token) =>
      invokeWithInput(
        IPC_CHANNELS.applicationCloseHeartbeat,
        CloseTokenSchema,
        VoidResultSchema,
        token,
      ),
    requestQuit: () => invokeWithoutInput(IPC_CHANNELS.applicationRequestQuit, VoidResultSchema),
    forceClose: () => invokeWithoutInput(IPC_CHANNELS.applicationForceClose, VoidResultSchema),
    reloadRenderer: () =>
      invokeWithoutInput(IPC_CHANNELS.applicationReloadRenderer, VoidResultSchema),
    reportRendererFailure: (request) =>
      invokeWithInput(
        IPC_CHANNELS.applicationReportRendererFailure,
        RendererFailureReportSchema,
        VoidResultSchema,
        request,
      ),
  },
  backup: {
    status: () => invokeWithoutInput(IPC_CHANNELS.backupStatus, BackupStatusResultSchema),
    configure: (settings) =>
      invokeWithInput(
        IPC_CHANNELS.backupConfigure,
        BackupConfigureRequestSchema,
        BackupConfigureResultSchema,
        settings,
      ),
    list: () => invokeWithoutInput(IPC_CHANNELS.backupList, BackupEntryListResultSchema),
    restore: (fileName) =>
      invokeWithInput(
        IPC_CHANNELS.backupRestore,
        z.string().min(1),
        BackupRestoreResultResultSchema,
        fileName,
      ),
    delete: (fileName) =>
      invokeWithInput(IPC_CHANNELS.backupDelete, z.string().min(1), VoidResultSchema, fileName),
    selectFolder: () =>
      invokeWithoutInput(IPC_CHANNELS.backupSelectFolder, NullableStringResultSchema),
    ensureCurrent: (target) =>
      invokeWithInput(
        IPC_CHANNELS.backupEnsureCurrent,
        BackupTargetSchema,
        BackupRunResultResultSchema,
        target,
      ),
    finalize: () =>
      invokeWithInput(
        IPC_CHANNELS.backupFinalize,
        z.object({}).strict(),
        BackupRunResultResultSchema,
        {},
      ),
    operationStatus: () =>
      invokeWithoutInput(IPC_CHANNELS.backupOperationStatus, BackupOperationStatusResultSchema),
    cancelFinalization: () =>
      invokeWithInput(
        IPC_CHANNELS.backupCancelFinalization,
        z.object({}).strict(),
        VoidResultSchema,
        {},
      ),
  },
  snapshot: {
    status: () => invokeWithoutInput(IPC_CHANNELS.snapshotStatus, SnapshotStatusResultSchema),
    configure: (settings) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotConfigure,
        SnapshotSettingsSchema,
        VoidResultSchema,
        settings,
      ),
    list: (documentType, documentId) => {
      const input: Record<string, string> = {};
      if (documentType) input.documentType = documentType;
      if (documentId) input.documentId = documentId;
      return invokeWithInput(
        IPC_CHANNELS.snapshotList,
        z.object({ documentType: z.string().optional(), documentId: z.string().optional() }),
        SnapshotEntryListResultSchema,
        Object.keys(input).length > 0 ? input : {},
      );
    },
    create: (request) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotCreate,
        SnapshotCreateRequestSchema,
        SnapshotCreationResultResultSchema,
        request,
      ),
    preview: (request) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotPreview,
        SnapshotContentPreviewRequestSchema,
        SnapshotContentPreviewResultSchema,
        request,
      ),
    previewAsset: (request) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotPreviewAsset,
        SnapshotPreviewAssetRequestSchema,
        SnapshotPreviewAssetResultSchema,
        request,
      ),
    restore: (request) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotRestore,
        SnapshotRestoreRequestSchema,
        BackupRestoreResultResultSchema,
        request,
      ),
    delete: (request) =>
      invokeWithInput(
        IPC_CHANNELS.snapshotDelete,
        SnapshotRestoreRequestSchema,
        SnapshotDeletionResultResultSchema,
        request,
      ),
  },
  menu: {
    onCommand: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = MenuCommandSchema.safeParse(value);
        if (parsed.success) {
          listener(parsed.data);
        }
      };

      ipcRenderer.on(IPC_CHANNELS.menuCommand, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.menuCommand, handler);
    },
  },
};

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("patentApi", api);
  contextBridge.exposeInMainWorld("documentFontPlatform", process.platform);
}
