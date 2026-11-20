import { z } from "zod";
import {
  type ChemicalStructureSource,
  ChemicalStructureSourceSchema,
} from "../chemistry/structure-source.js";
import { CadCheckpointSchema, CadMappingSchema } from "../drawing-markup/cad-state.js";
import type { DrawingImportProgressEvent } from "../drawing-markup/import-progress.js";
import { type DrawingTileRaster, DrawingTileRasterSchema } from "../drawing-markup/tiles.js";
import { type AgreementAccept, type AgreementState, AgreementStateSchema } from "../legal/model.js";
import { type UpdateState, UpdateStateSchema } from "../updates/model.js";
import { type UsageChoice, type UsageState, UsageStateSchema } from "../usage-statistics/model.js";
import type { TemporaryImageApi } from "./temporary-images.js";

export { DrawingImportProgressSchema } from "../drawing-markup/import-progress.js";

import {
  type AiApiKeyRequest,
  type AiCorrectionCancelRequest,
  type AiCorrectionEvent,
  type AiCorrectionProfileRequest,
  type AiCorrectionSettingsState,
  AiCorrectionSettingsStateSchema,
  type AiCorrectionStartRequest,
  type AiCorrectionStartResult,
  AiCorrectionStartResultSchema,
  type AiModelDiscoveryRequest,
  type AiModelDiscoveryResult,
  AiModelDiscoveryResultSchema,
  type AiProviderDocsRequest,
  type AiTextHashRequest,
  Sha256Schema,
} from "../ai-correction/contract.js";
import type { AiCorrectionSettings } from "../ai-correction/model.js";
import {
  type TextPolishCancelRequest,
  type TextPolishConversationCancelRequest,
  type TextPolishConversationEvent,
  type TextPolishConversationOperationResult,
  TextPolishConversationOperationResultSchema,
  type TextPolishConversationResetRequest,
  type TextPolishConversationSendRequest,
  type TextPolishConversationSnapshot,
  type TextPolishConversationSnapshotRequest,
  TextPolishConversationSnapshotSchema,
  type TextPolishConversationStartRequest,
  type TextPolishConversationStartResult,
  TextPolishConversationStartResultSchema,
  type TextPolishEvent,
  type TextPolishStartRequest,
  type TextPolishStartResult,
  TextPolishStartResultSchema,
  type TextPolishWorkspace,
  type TextPolishWorkspaceRequest,
  TextPolishWorkspaceSchema,
} from "../ai-correction/text-polish-contract.js";
import {
  type BackupConfigureRequest,
  BackupConfigureRequestSchema,
  type BackupEntry,
  BackupEntrySchema,
  type BackupMigrationReport,
  BackupMigrationReportSchema,
  type BackupOperationStatus,
  BackupOperationStatusSchema,
  type BackupRestoreResult,
  BackupRestoreResultSchema,
  type BackupRunResult,
  BackupRunResultSchema,
  type BackupSettings,
  BackupSettingsSchema,
  type BackupStatus,
  BackupStatusSchema,
  BackupTargetSchema,
} from "../backup/model.js";
import {
  MAX_CHEMICAL_PREVIEW_PNG_BYTES,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
} from "../chemistry/chemical-preview.js";
import {
  type DataTransferLibraryInspection,
  DataTransferLibraryInspectionSchema,
  type DataTransferProgress,
  type FullDataExportRequest,
  type FullDataExportResult,
  FullDataExportResultSchema,
  type FullDataImportCommitRequest,
  type FullDataImportPrepareRequest,
  type FullDataImportPreview,
  FullDataImportPreviewSchema,
  type TransferDestinationSelection,
  TransferDestinationSelectionSchema,
  type TransferSourceSelection,
  TransferSourceSelectionSchema,
} from "../data-transfer/model.js";
import {
  AssetDescriptorSchema,
  CanonicalDocumentSchema,
  ChemicalPreviewAssetDescriptorSchema,
  ImageRotationSchema,
  MAX_KET_SOURCE_BYTES,
  PageSettingsSchema,
  PatentBookDocumentSchema,
} from "../document/model.js";
import { validatePatentBookDocument } from "../document/validation.js";
import { DrawingProjectsSchema, MAX_DRAWING_INPUT_BYTES } from "../drawing-markup/model.js";
import { DrawingProjectEditsSchema } from "../drawing-markup/project-edits.js";
import {
  createDocxSuggestedName,
  MAX_DOCX_SUGGESTED_NAME_LENGTH,
} from "../exports/docx-filename.js";
import { ExportIssueSchema, type ExportReport } from "../exports/report.js";
import { FLOWCHART_MAX_OBJECTS, FLOWCHART_MAX_SOURCE_XML_BYTES } from "../flowcharts/limits.js";
import { FlowchartProjectDescriptorSchema } from "../flowcharts/model.js";
import type { IpcReportRequest } from "../ipc-data-center.js";
import { LibraryEditBatchSchema } from "../library/edit-operations.js";
import {
  LibraryDocumentIdSchema,
  type LibraryDocumentSummary,
  LibraryDocumentSummarySchema,
  type LibraryEditAck,
  LibraryEditAckSchema,
  LibraryPatentIdSchema,
  type LibraryPatentSummary,
  LibraryPatentSummarySchema,
  LibraryRevisionSchema,
  LibrarySaveStateSchema,
} from "../library/model.js";
import { ClaimsRichParagraphsSchema } from "../patent/claims-rich-text.js";
import { PatdocWorkspaceSchema } from "../patent/continuation.js";
import { DesignEditorMetadataSchema } from "../patent/design-editor-project.js";
import { DesignPatentImageOperationSchema, DesignPatentSchema } from "../patent/design-patent.js";
import { UnlinkedDrawingExplanationSchema } from "../patent/drawing-explanations.js";
import {
  AuxiliaryDocumentSchema,
  CanonicalPatentSchema,
  PATENT_CUSTOMER_MAX_LENGTH,
  PATENT_NAME_MAX_LENGTH,
  PatentBookKindSchema,
  PatentFigureSchema,
  PatentTypeSchema,
} from "../patent/model.js";
import {
  PatentReferenceMarkSchema,
  PatentReferenceMarkSettingsSchema,
} from "../patent/reference-marks.js";
import {
  type PatentTemplateAuxiliaryCatalog,
  PatentTemplateAuxiliaryCatalogSchema,
  type PatentTemplateCaptureCurrentRequest,
  type PatentTemplateCapturedBooks,
  PatentTemplateCapturedBooksSchema,
  type PatentTemplateEditorCloseRequest,
  type PatentTemplateEditorOpenRequest,
  type PatentTemplateEditorSaveRequest,
  type PatentTemplateEditorSnapshot,
  PatentTemplateEditorSnapshotSchema,
  type PatentTemplateLauncherSummary,
  PatentTemplateLauncherSummarySchema,
} from "../patent/template-catalog.js";
import {
  type DirectPrintRequest,
  DirectPrintRequestSchema,
  type PrinterDescriptor,
  PrinterDescriptorSchema,
  type PrintPreviewRequest,
  PrintPreviewRequestSchema,
} from "../printing/model.js";
import {
  type PreparedRecovery,
  PreparedRecoverySchema,
  type RecoverySource,
  RecoverySourceSchema,
} from "../recovery/self-service-recovery.js";
import {
  type StartupRecoveryReport,
  StartupRecoveryReportSchema,
} from "../recovery/startup-recovery.js";
import {
  type AppSettings,
  type AppSettingsPatch,
  AppSettingsPatchSchema,
  AppSettingsSchema,
} from "../settings/model.js";
import {
  type ExplicitSnapshotSource,
  ExplicitSnapshotSourceSchema,
  type SnapshotContentPreview,
  type SnapshotContentPreviewRequest,
  SnapshotContentPreviewRequestSchema,
  SnapshotContentPreviewSchema,
  type SnapshotCreateRequest,
  SnapshotCreateRequestSchema,
  type SnapshotCreationResult,
  SnapshotCreationResultSchema,
  type SnapshotDeletionResult,
  SnapshotDeletionResultSchema,
  type SnapshotEntry,
  SnapshotEntrySchema,
  type SnapshotListResult,
  SnapshotListResultSchema,
  type SnapshotPreviewAssetRequest,
  SnapshotPreviewAssetRequestSchema,
  type SnapshotRestoreRequest,
  SnapshotRestoreRequestSchema,
  type SnapshotSettings,
  SnapshotSettingsSchema,
  type SnapshotSource,
  SnapshotSourceSchema,
  type SnapshotStatus,
  SnapshotStatusSchema,
} from "../snapshot/model.js";
import {
  type JsonObject,
  JsonObjectSchema,
  type JsonValue,
  JsonValueSchema,
  SessionIdSchema,
  StableIdSchema,
} from "./primitives.js";
import { RendererFailureLocationSchema } from "./renderer-failure-location.js";
import { AppErrorSchema, type AppResult, appResultSchema } from "./result.js";
export const PatentFormattingResultSchema = appResultSchema(z.array(PatentBookKindSchema).max(5));

export const IPC_CHANNELS = {
  patentsExportFolder: "patents:export-folder",
  tutorialRead: "tutorial:read",
  tutorialReady: "tutorial:ready",
  tutorialLaunch: "tutorial:launch",
  tutorialPrepare: "tutorial:prepare",
  automationControl: "automation:control",
  automationEvent: "automation:event",
  contentSearch: "content-search:request",
  contentSearchActivity: "content-search:activity",
  chemistryRasterizePreview: "chemistry:rasterize-preview",
  chemistryReadStructureSource: "chemistry:read-structure-source",
  formulaDrawingsRender: "formula-drawings:render",
  clipboardReadText: "clipboard:read-text",
  clipboardPaste: "clipboard:paste",
  clipboardReadImage: "clipboard:read-image",
  clipboardWriteImage: "clipboard:write-image",
  clipboardWriteText: "clipboard:write-text",
  ipcDataSaveReport: "ipc-data:save-report",
  documentsActivate: "documents:activate",
  documentsOpenDialog: "documents:open-dialog",
  documentsOpenPath: "documents:open-path",
  documentsSave: "documents:save",
  documentsSaveAs: "documents:save-as",
  documentsRelease: "documents:release",
  assetsChooseAndImport: "assets:choose-and-import",
  assetsChooseAndImportMany: "assets:choose-and-import-many",
  assetsChooseDesignFiles: "assets:choose-design-files",
  assetsImportBytes: "assets:import-bytes",
  drawingsImport: "drawings:import",
  drawingsImportProgress: "drawings:import-progress",
  drawingsCancelImport: "drawings:cancel-import",
  drawingsReadSource: "drawings:read-source",
  cadPrepare: "cad:prepare",
  cadConvert: "cad:convert",
  cadExport: "cad:export",
  drawingsReadTile: "drawings:read-tile",
  assetsImportMany: "assets:import-many",
  assetsStageReferences: "assets:stage-references",
  assetsDiscardImports: "assets:discard-imports",
  assetsGetPreview: "assets:get-preview",
  assetsCopyImages: "assets:copy-images",
  assetsSaveImage: "assets:save-image",
  assetsSaveImages: "assets:save-images",
  assetsProcessDesignImage: "assets:process-design-image",
  assetsPrepareDesignEditorSource: "assets:prepare-design-editor-source",
  assetsStageDesignEditorProject: "assets:stage-design-editor-project",
  assetsReadDesignEditorProject: "assets:read-design-editor-project",
  assetsAcquireDesignEditorWorkspace: "assets:acquire-design-editor-workspace",
  assetsReleaseDesignEditorWorkspace: "assets:release-design-editor-workspace",
  imageEditorDecodeRaster: "image-editor:decode-raster",
  imageEditorExportRaster: "image-editor:export-raster",
  imageEditorDecodePsd: "image-editor:decode-psd",
  imageEditorExportPsd: "image-editor:export-psd",
  imageEditorBeginBatch: "image-editor:begin-batch",
  imageEditorWriteBatchRaster: "image-editor:write-batch-raster",
  imageEditorWriteBatchPsd: "image-editor:write-batch-psd",
  imageEditorFinishBatch: "image-editor:finish-batch",
  draftsList: "drafts:list",
  draftsSave: "drafts:save",
  draftsOpen: "drafts:open",
  draftsDelete: "drafts:delete",
  patentsList: "patents:list",
  patentsGetLibraryPreview: "patents:get-library-preview",
  patentsCreate: "patents:create",
  patentsOpen: "patents:open",
  patentsOpenPath: "patents:open-path",
  patentsRecover: "patents:recover",
  patentsUpdateSettings: "patents:update-settings",
  patentsUpdateDesignPatent: "patents:update-design-patent",
  patentsSetDrawingBooksEnabled: "patents:set-drawing-books-enabled",
  patentsApplyBookEdit: "patents:apply-book-edit",
  patentsCreateAuxiliaryDocument: "patents:create-auxiliary-document",
  patentsApplyAuxiliaryDocumentEdit: "patents:apply-auxiliary-document-edit",
  patentsRenameAuxiliaryDocument: "patents:rename-auxiliary-document",
  patentsDeleteAuxiliaryDocument: "patents:delete-auxiliary-document",
  patentsMoveAuxiliaryDocument: "patents:move-auxiliary-document",
  patentsApplyFigureEdit: "patents:apply-figure-edit",
  patentsFlush: "patents:flush",
  patentsInspectResources: "patents:inspect-resources",
  patentsCancelResourceInspection: "patents:cancel-resource-inspection",
  patentsPrepareDocxImport: "patents:prepare-docx-import",
  patentsGetDocxImportPreviewAsset: "patents:get-docx-import-preview-asset",
  patentsUpdateDocxImport: "patents:update-docx-import",
  patentsCommitDocxImport: "patents:commit-docx-import",
  patentsCancelDocxImport: "patents:cancel-docx-import",
  patentsImportPatdoc: "patents:import-patdoc",
  patentsExportPatdoc: "patents:export-patdoc",
  patentsExportBundle: "patents:export-bundle",
  patentsImportBundle: "patents:import-bundle",
  patentsTrash: "patents:trash",
  patentsRestore: "patents:restore",
  patentsPermanentDelete: "patents:permanent-delete",
  patentsPurge: "patents:purge",
  patentsRelease: "patents:release",
  patentTemplatesReadSummary: "patent-templates:read-summary",
  patentTemplatesReadAuxiliary: "patent-templates:read-auxiliary",
  patentTemplatesOpenEditor: "patent-templates:open-editor",
  patentTemplatesCaptureCurrent: "patent-templates:capture-current",
  patentTemplatesSaveEditor: "patent-templates:save-editor",
  patentTemplatesCloseEditor: "patent-templates:close-editor",
  flowchartsList: "flowcharts:list",
  flowchartsCreate: "flowcharts:create",
  flowchartsImport: "flowcharts:import",
  flowchartsLoad: "flowcharts:load",
  flowchartsSave: "flowcharts:save",
  flowchartsRename: "flowcharts:rename",
  flowchartsDuplicate: "flowcharts:duplicate",
  flowchartsDelete: "flowcharts:delete",
  flowchartsExportBackup: "flowcharts:export-backup",
  flowchartsRenderPreview: "flowcharts:render-preview",
  flowchartsRenderPdf: "flowcharts:render-pdf",
  flowchartsCommitPreview: "flowcharts:commit-preview",
  libraryList: "library:list",
  libraryCreate: "library:create",
  libraryOpen: "library:open",
  libraryRename: "library:rename",
  libraryApplyEdit: "library:apply-edit",
  libraryFlush: "library:flush",
  libraryTrash: "library:trash",
  libraryRestore: "library:restore",
  libraryPermanentDelete: "library:permanent-delete",
  libraryPurge: "library:purge",
  libraryImportPatdoc: "library:import-patdoc",
  libraryExportPatdoc: "library:export-patdoc",
  libraryEmergencyExportPatdoc: "library:emergency-export-patdoc",
  libraryLegacyDrafts: "library:legacy-drafts",
  libraryImportLegacyDraft: "library:import-legacy-draft",
  libraryRelease: "library:release",
  settingsRead: "settings:read",
  settingsUpdate: "settings:update",
  aiCorrectionGetSettings: "ai-correction:get-settings",
  aiCorrectionHashText: "ai-correction:hash-text",
  aiCorrectionUpdateSettings: "ai-correction:update-settings",
  aiCorrectionSetApiKey: "ai-correction:set-api-key",
  aiCorrectionClearApiKey: "ai-correction:clear-api-key",
  aiCorrectionTestConnection: "ai-correction:test-connection",
  aiCorrectionDiscoverModels: "ai-correction:discover-models",
  aiCorrectionOpenProviderDocs: "ai-correction:open-provider-docs",
  aiCorrectionStart: "ai-correction:start",
  aiCorrectionCancel: "ai-correction:cancel",
  aiCorrectionEvent: "ai-correction:event",
  textPolishStart: "text-polish:start",
  textPolishCancel: "text-polish:cancel",
  textPolishEvent: "text-polish:event",
  textPolishConversationStart: "text-polish:conversation-start",
  textPolishConversationSend: "text-polish:conversation-send",
  textPolishConversationCancel: "text-polish:conversation-cancel",
  textPolishConversationReset: "text-polish:conversation-reset",
  textPolishConversationSnapshot: "text-polish:conversation-snapshot",
  textPolishWorkspace: "text-polish:workspace",
  textPolishConversationEvent: "text-polish:conversation-event",
  exportsDocx: "exports:docx",
  exportsPatentDocx: "exports:patent-docx",
  exportsPatentPdf: "exports:patent-pdf",
  exportsAuxiliaryDocx: "exports:auxiliary-docx",
  exportsAuxiliaryPdf: "exports:auxiliary-pdf",
  exportsDesignPatent: "exports:design-patent",
  exportsPdf: "exports:pdf",
  exportsPreview: "exports:preview",
  exportsSavePreviewPdf: "exports:save-preview-pdf",
  exportsDiscardPreview: "exports:discard-preview",
  exportsListPrinters: "exports:list-printers",
  exportsOpenPrinterSettings: "exports:open-printer-settings",
  exportsPrint: "exports:print",
  agreementsRead: "agreements:read",
  agreementsAccept: "agreements:accept",
  usageStatisticsRead: "usage-statistics:read",
  usageStatisticsChoose: "usage-statistics:choose",
  usageStatisticsChanged: "usage-statistics:changed",
  updatesRead: "updates:read",
  updatesStart: "updates:start",
  updatesCheck: "updates:check",
  updatesDismiss: "updates:dismiss",
  updatesOpenDownload: "updates:open-download",
  updatesChanged: "updates:changed",
  applicationCreateDesktopShortcut: "application:create-desktop-shortcut",
  applicationStorageOverview: "application:storage-overview",
  applicationRelocateLibrary: "application:relocate-library",
  applicationOpenStorageFolder: "application:open-storage-folder",
  applicationOpenOfficialWebsite: "application:open-official-website",
  applicationLegislation: "application:legislation",
  applicationOpenThirdPartyNotices: "application:open-third-party-notices",
  applicationOpenThirdPartyLicensesFolder: "application:open-third-party-licenses-folder",
  applicationGetWindowLayoutState: "application:get-window-layout-state",
  applicationPrepareRecovery: "application:prepare-recovery",
  applicationActivateRecovery: "application:activate-recovery",
  applicationGetStartupRecoveryReport: "application:get-startup-recovery-report",
  applicationMaximizeWindow: "application:maximize-window",
  applicationDualColumnWindow: "application:dual-column-window",
  applicationWindowLayoutChanged: "application:window-layout-changed",
  applicationPrepareClose: "application:prepare-close",
  applicationBackgroundSave: "application:background-save",
  applicationBackgroundSaveResult: "application:background-save-result",
  applicationTraySettings: "application:tray-settings",
  applicationStartupRead: "application:startup-read",
  applicationStartupUpdate: "application:startup-update",
  applicationCloseResult: "application:close-result",
  applicationCloseHeartbeat: "application:close-heartbeat",
  applicationRequestQuit: "application:request-quit",
  applicationForceClose: "application:force-close",
  applicationReloadRenderer: "application:reload-renderer",
  applicationReportRendererFailure: "application:report-renderer-failure",
  applicationOpenPath: "open-path",
  menuCommand: "menu:command",
  backupStatus: "backup:status",
  backupConfigure: "backup:configure",
  backupList: "backup:list",
  backupRestore: "backup:restore",
  backupDelete: "backup:delete",
  backupSelectFolder: "backup:select-folder",
  backupEnsureCurrent: "backup:ensure-current",
  backupFinalize: "backup:finalize",
  backupOperationStatus: "backup:operation-status",
  backupCancelFinalization: "backup:cancel-finalization",
  snapshotStatus: "snapshot:status",
  snapshotConfigure: "snapshot:configure",
  snapshotList: "snapshot:list",
  snapshotCreate: "snapshot:create",
  snapshotRestore: "snapshot:restore",
  snapshotDelete: "snapshot:delete",
  snapshotPreview: "snapshot:preview",
  snapshotPreviewAsset: "snapshot:preview-asset",
  dataTransferInspectLibrary: "data-transfer:inspect-library",
  dataTransferSelectExportDestination: "data-transfer:select-export-destination",
  dataTransferExportPackage: "data-transfer:export-package",
  dataTransferSelectImportPackage: "data-transfer:select-import-package",
  dataTransferPrepareImport: "data-transfer:prepare-import",
  dataTransferCommitImport: "data-transfer:commit-import",
  dataTransferCancel: "data-transfer:cancel",
  dataTransferProgress: "data-transfer:progress",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const PRELOAD_INVOKE_CHANNELS = [
  IPC_CHANNELS.tutorialRead,
  IPC_CHANNELS.tutorialReady,
  IPC_CHANNELS.tutorialLaunch,
  IPC_CHANNELS.tutorialPrepare,
  IPC_CHANNELS.applicationPrepareRecovery,
  IPC_CHANNELS.applicationActivateRecovery,
  IPC_CHANNELS.automationControl,
  IPC_CHANNELS.contentSearch,
  IPC_CHANNELS.applicationBackgroundSaveResult,
  IPC_CHANNELS.applicationStartupRead,
  IPC_CHANNELS.applicationStartupUpdate,

  IPC_CHANNELS.chemistryRasterizePreview,
  IPC_CHANNELS.chemistryReadStructureSource,
  IPC_CHANNELS.formulaDrawingsRender,
  IPC_CHANNELS.clipboardReadText,
  IPC_CHANNELS.clipboardPaste,
  IPC_CHANNELS.clipboardReadImage,
  IPC_CHANNELS.clipboardWriteImage,
  IPC_CHANNELS.clipboardWriteText,
  IPC_CHANNELS.ipcDataSaveReport,
  IPC_CHANNELS.documentsActivate,
  IPC_CHANNELS.documentsOpenDialog,
  IPC_CHANNELS.documentsOpenPath,
  IPC_CHANNELS.documentsSave,
  IPC_CHANNELS.documentsSaveAs,
  IPC_CHANNELS.documentsRelease,
  IPC_CHANNELS.assetsChooseAndImport,
  IPC_CHANNELS.assetsChooseAndImportMany,
  IPC_CHANNELS.assetsChooseDesignFiles,
  IPC_CHANNELS.assetsImportBytes,
  IPC_CHANNELS.drawingsImport,
  IPC_CHANNELS.drawingsCancelImport,
  IPC_CHANNELS.drawingsReadSource,
  IPC_CHANNELS.cadPrepare,
  IPC_CHANNELS.cadConvert,
  IPC_CHANNELS.cadExport,
  IPC_CHANNELS.drawingsReadTile,
  IPC_CHANNELS.assetsImportMany,
  IPC_CHANNELS.assetsStageReferences,
  IPC_CHANNELS.assetsDiscardImports,
  IPC_CHANNELS.assetsGetPreview,
  IPC_CHANNELS.assetsCopyImages,
  IPC_CHANNELS.assetsSaveImage,
  IPC_CHANNELS.assetsSaveImages,
  IPC_CHANNELS.assetsProcessDesignImage,
  IPC_CHANNELS.assetsPrepareDesignEditorSource,
  IPC_CHANNELS.assetsStageDesignEditorProject,
  IPC_CHANNELS.assetsReadDesignEditorProject,
  IPC_CHANNELS.assetsAcquireDesignEditorWorkspace,
  IPC_CHANNELS.assetsReleaseDesignEditorWorkspace,
  IPC_CHANNELS.imageEditorDecodeRaster,
  IPC_CHANNELS.imageEditorExportRaster,
  IPC_CHANNELS.imageEditorDecodePsd,
  IPC_CHANNELS.imageEditorExportPsd,
  IPC_CHANNELS.imageEditorBeginBatch,
  IPC_CHANNELS.imageEditorWriteBatchRaster,
  IPC_CHANNELS.imageEditorWriteBatchPsd,
  IPC_CHANNELS.imageEditorFinishBatch,
  IPC_CHANNELS.draftsList,
  IPC_CHANNELS.draftsSave,
  IPC_CHANNELS.draftsOpen,
  IPC_CHANNELS.draftsDelete,
  IPC_CHANNELS.patentsList,
  IPC_CHANNELS.patentsExportFolder,
  IPC_CHANNELS.patentsGetLibraryPreview,
  IPC_CHANNELS.patentsCreate,
  IPC_CHANNELS.patentsOpen,
  IPC_CHANNELS.patentsOpenPath,
  IPC_CHANNELS.patentsRecover,
  IPC_CHANNELS.patentsUpdateSettings,
  IPC_CHANNELS.patentsUpdateDesignPatent,
  IPC_CHANNELS.patentsSetDrawingBooksEnabled,
  IPC_CHANNELS.patentsApplyBookEdit,
  IPC_CHANNELS.patentsCreateAuxiliaryDocument,
  IPC_CHANNELS.patentsApplyAuxiliaryDocumentEdit,
  IPC_CHANNELS.patentsRenameAuxiliaryDocument,
  IPC_CHANNELS.patentsDeleteAuxiliaryDocument,
  IPC_CHANNELS.patentsMoveAuxiliaryDocument,
  IPC_CHANNELS.patentsApplyFigureEdit,
  IPC_CHANNELS.patentsFlush,
  IPC_CHANNELS.patentsInspectResources,
  IPC_CHANNELS.patentsCancelResourceInspection,
  IPC_CHANNELS.patentsPrepareDocxImport,
  IPC_CHANNELS.patentsGetDocxImportPreviewAsset,
  IPC_CHANNELS.patentsUpdateDocxImport,
  IPC_CHANNELS.patentsCommitDocxImport,
  IPC_CHANNELS.patentsCancelDocxImport,
  IPC_CHANNELS.patentsImportPatdoc,
  IPC_CHANNELS.patentsExportPatdoc,
  IPC_CHANNELS.patentsExportBundle,
  IPC_CHANNELS.patentsImportBundle,
  IPC_CHANNELS.patentsTrash,
  IPC_CHANNELS.patentsRestore,
  IPC_CHANNELS.patentsPermanentDelete,
  IPC_CHANNELS.patentsPurge,
  IPC_CHANNELS.patentsRelease,
  IPC_CHANNELS.patentTemplatesReadSummary,
  IPC_CHANNELS.patentTemplatesReadAuxiliary,
  IPC_CHANNELS.patentTemplatesOpenEditor,
  IPC_CHANNELS.patentTemplatesCaptureCurrent,
  IPC_CHANNELS.patentTemplatesSaveEditor,
  IPC_CHANNELS.patentTemplatesCloseEditor,
  IPC_CHANNELS.flowchartsList,
  IPC_CHANNELS.flowchartsCreate,
  IPC_CHANNELS.flowchartsImport,
  IPC_CHANNELS.flowchartsLoad,
  IPC_CHANNELS.flowchartsSave,
  IPC_CHANNELS.flowchartsRename,
  IPC_CHANNELS.flowchartsDuplicate,
  IPC_CHANNELS.flowchartsDelete,
  IPC_CHANNELS.flowchartsExportBackup,
  IPC_CHANNELS.flowchartsRenderPreview,
  IPC_CHANNELS.flowchartsRenderPdf,
  IPC_CHANNELS.flowchartsCommitPreview,
  IPC_CHANNELS.libraryList,
  IPC_CHANNELS.libraryCreate,
  IPC_CHANNELS.libraryOpen,
  IPC_CHANNELS.libraryRename,
  IPC_CHANNELS.libraryApplyEdit,
  IPC_CHANNELS.libraryFlush,
  IPC_CHANNELS.libraryTrash,
  IPC_CHANNELS.libraryRestore,
  IPC_CHANNELS.libraryPermanentDelete,
  IPC_CHANNELS.libraryPurge,
  IPC_CHANNELS.libraryImportPatdoc,
  IPC_CHANNELS.libraryExportPatdoc,
  IPC_CHANNELS.libraryEmergencyExportPatdoc,
  IPC_CHANNELS.libraryLegacyDrafts,
  IPC_CHANNELS.libraryImportLegacyDraft,
  IPC_CHANNELS.libraryRelease,
  IPC_CHANNELS.settingsRead,
  IPC_CHANNELS.settingsUpdate,
  IPC_CHANNELS.aiCorrectionHashText,
  IPC_CHANNELS.aiCorrectionGetSettings,
  IPC_CHANNELS.aiCorrectionUpdateSettings,
  IPC_CHANNELS.aiCorrectionSetApiKey,
  IPC_CHANNELS.aiCorrectionClearApiKey,
  IPC_CHANNELS.aiCorrectionTestConnection,
  IPC_CHANNELS.aiCorrectionDiscoverModels,
  IPC_CHANNELS.aiCorrectionOpenProviderDocs,
  IPC_CHANNELS.aiCorrectionStart,
  IPC_CHANNELS.aiCorrectionCancel,
  IPC_CHANNELS.textPolishStart,
  IPC_CHANNELS.textPolishCancel,
  IPC_CHANNELS.textPolishConversationStart,
  IPC_CHANNELS.textPolishConversationSend,
  IPC_CHANNELS.textPolishConversationCancel,
  IPC_CHANNELS.textPolishConversationReset,
  IPC_CHANNELS.textPolishConversationSnapshot,
  IPC_CHANNELS.textPolishWorkspace,
  IPC_CHANNELS.exportsDocx,
  IPC_CHANNELS.exportsPatentDocx,
  IPC_CHANNELS.exportsPatentPdf,
  IPC_CHANNELS.exportsAuxiliaryDocx,
  IPC_CHANNELS.exportsAuxiliaryPdf,
  IPC_CHANNELS.exportsDesignPatent,
  IPC_CHANNELS.exportsPdf,
  IPC_CHANNELS.exportsPreview,
  IPC_CHANNELS.exportsSavePreviewPdf,
  IPC_CHANNELS.exportsDiscardPreview,
  IPC_CHANNELS.exportsListPrinters,
  IPC_CHANNELS.exportsOpenPrinterSettings,
  IPC_CHANNELS.exportsPrint,
  IPC_CHANNELS.agreementsRead,
  IPC_CHANNELS.agreementsAccept,
  IPC_CHANNELS.usageStatisticsRead,
  IPC_CHANNELS.usageStatisticsChoose,
  IPC_CHANNELS.updatesRead,
  IPC_CHANNELS.updatesStart,
  IPC_CHANNELS.updatesCheck,
  IPC_CHANNELS.updatesDismiss,
  IPC_CHANNELS.updatesOpenDownload,
  IPC_CHANNELS.applicationCreateDesktopShortcut,
  IPC_CHANNELS.applicationStorageOverview,
  IPC_CHANNELS.applicationRelocateLibrary,
  IPC_CHANNELS.applicationOpenStorageFolder,
  IPC_CHANNELS.applicationOpenOfficialWebsite,
  IPC_CHANNELS.applicationLegislation,
  IPC_CHANNELS.applicationOpenThirdPartyNotices,
  IPC_CHANNELS.applicationOpenThirdPartyLicensesFolder,
  IPC_CHANNELS.applicationGetWindowLayoutState,
  IPC_CHANNELS.applicationGetStartupRecoveryReport,
  IPC_CHANNELS.applicationMaximizeWindow,
  IPC_CHANNELS.applicationCloseResult,
  IPC_CHANNELS.applicationCloseHeartbeat,
  IPC_CHANNELS.applicationRequestQuit,
  IPC_CHANNELS.applicationForceClose,
  IPC_CHANNELS.applicationReloadRenderer,
  IPC_CHANNELS.applicationReportRendererFailure,
  IPC_CHANNELS.backupStatus,
  IPC_CHANNELS.backupConfigure,
  IPC_CHANNELS.backupList,
  IPC_CHANNELS.backupRestore,
  IPC_CHANNELS.backupDelete,
  IPC_CHANNELS.backupSelectFolder,
  IPC_CHANNELS.backupEnsureCurrent,
  IPC_CHANNELS.backupFinalize,
  IPC_CHANNELS.backupOperationStatus,
  IPC_CHANNELS.backupCancelFinalization,
  IPC_CHANNELS.snapshotStatus,
  IPC_CHANNELS.snapshotConfigure,
  IPC_CHANNELS.snapshotList,
  IPC_CHANNELS.snapshotCreate,
  IPC_CHANNELS.snapshotRestore,
  IPC_CHANNELS.snapshotDelete,
  IPC_CHANNELS.snapshotPreview,
  IPC_CHANNELS.snapshotPreviewAsset,
  IPC_CHANNELS.dataTransferInspectLibrary,
  IPC_CHANNELS.dataTransferSelectExportDestination,
  IPC_CHANNELS.dataTransferExportPackage,
  IPC_CHANNELS.dataTransferSelectImportPackage,
  IPC_CHANNELS.dataTransferPrepareImport,
  IPC_CHANNELS.dataTransferCommitImport,
  IPC_CHANNELS.dataTransferCancel,
] as const satisfies readonly IpcChannel[];

export const PRELOAD_EVENT_CHANNELS = [
  IPC_CHANNELS.usageStatisticsChanged,
  IPC_CHANNELS.automationEvent,
  IPC_CHANNELS.applicationBackgroundSave,
  IPC_CHANNELS.applicationTraySettings,
  IPC_CHANNELS.applicationOpenPath,
  IPC_CHANNELS.applicationPrepareClose,
  IPC_CHANNELS.applicationWindowLayoutChanged,
  IPC_CHANNELS.aiCorrectionEvent,
  IPC_CHANNELS.textPolishEvent,
  IPC_CHANNELS.textPolishConversationEvent,
  IPC_CHANNELS.menuCommand,
  IPC_CHANNELS.dataTransferProgress,
  IPC_CHANNELS.drawingsImportProgress,
] as const satisfies readonly IpcChannel[];

export type PreloadInvokeChannel = (typeof PRELOAD_INVOKE_CHANNELS)[number];

export * from "../ai-correction/contract.js";
export * from "../ai-correction/model.js";
export * from "../ai-correction/text-polish-contract.js";
export { MAX_CHEMICAL_PREVIEW_SVG_BYTES } from "../chemistry/chemical-preview.js";
export * from "../data-transfer/model.js";
export * from "../patent/template-catalog.js";

export const ChemicalPreviewRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    svg: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= MAX_CHEMICAL_PREVIEW_SVG_BYTES,
        "化学结构预览 SVG 不能超过 5 MiB。",
      ),
    source: ChemicalStructureSourceSchema.optional(),
    outputWidthMm: z.number().finite().min(10).max(165).optional(),
  })
  .strict();
export type ChemicalPreviewRequest = z.infer<typeof ChemicalPreviewRequestSchema>;
export const ChemicalStructureSourceResultSchema = appResultSchema(
  ChemicalStructureSourceSchema.nullable(),
);

export const ImportedChemicalPreviewSchema = z
  .object({
    descriptor: ChemicalPreviewAssetDescriptorSchema,
    preview: z
      .instanceof(Uint8Array)
      .refine(
        (value) => value.byteLength > 0 && value.byteLength <= MAX_CHEMICAL_PREVIEW_PNG_BYTES,
      ),
  })
  .strict();
export type ImportedChemicalPreview = z.infer<typeof ImportedChemicalPreviewSchema>;
export const ChemicalPreviewResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ImportedChemicalPreviewSchema }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema.strict() }).strict(),
]);

export const FormulaDrawingRenderRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    latex: z.string().trim().min(1).max(100_000),
    outputWidthMm: z.number().finite().min(10).max(165).optional(),
  })
  .strict();
export type FormulaDrawingRenderRequest = z.infer<typeof FormulaDrawingRenderRequestSchema>;

export const FormulaDrawingRenderPreviewSchema = z
  .object({
    png: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0),
    widthPx: z.number().int().positive().max(4096),
    heightPx: z.number().int().positive().max(4096),
  })
  .strict();
export type FormulaDrawingRenderPreview = z.infer<typeof FormulaDrawingRenderPreviewSchema>;
export const FormulaDrawingRenderResultSchema = appResultSchema(FormulaDrawingRenderPreviewSchema);

export const ActivateDocumentSessionRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    documentId: StableIdSchema,
  })
  .strict();
export type ActivateDocumentSessionRequest = z.infer<typeof ActivateDocumentSessionRequestSchema>;
const LocalPathSchema = z.string().min(1).max(32_767);
export const PatdocPathSchema = LocalPathSchema.refine(
  (path) => path.toLocaleLowerCase("en-US").endsWith(".patdoc"),
  "只能打开 .patdoc 文档。",
);
export const SaveDocumentRequestSchema = z.object({
  sessionId: SessionIdSchema,
  document: CanonicalDocumentSchema,
  editorState: JsonObjectSchema,
});
export type SaveDocumentRequest = z.infer<typeof SaveDocumentRequestSchema>;

export const SavedDocumentSchema = z.object({
  sessionId: SessionIdSchema,
  path: LocalPathSchema,
  displayName: z.string().trim().min(1).max(255),
  savedAt: z.string().datetime(),
  previousVersionRetained: z.boolean().optional(),
});
export type SavedDocument = z.infer<typeof SavedDocumentSchema>;

export const OpenedDocumentSchema = z.object({
  sessionId: SessionIdSchema,
  path: LocalPathSchema.nullable(),
  displayName: z.string().trim().min(1).max(255),
  document: CanonicalDocumentSchema,
  editorState: JsonObjectSchema,
});
export type OpenedDocument = z.infer<typeof OpenedDocumentSchema>;

export const ImportAssetRequestSchema = z.object({
  sessionId: SessionIdSchema,
  originalName: z.string().trim().min(1).max(255),
  declaredMediaType: z.string().trim().max(100).nullable(),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 50 * 1024 * 1024),
});
export type ImportAssetRequest = z.infer<typeof ImportAssetRequestSchema>;

export const ImportAssetInputSchema = ImportAssetRequestSchema.omit({ sessionId: true }).strict();
export type ImportAssetInput = z.infer<typeof ImportAssetInputSchema>;

export const MAX_IMAGE_IMPORT_COUNT = 100;
export const MAX_IMAGE_IMPORT_BATCH_BYTES = 250 * 1024 * 1024;

export const ImportAssetBatchRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    operationId: z.string().uuid(),
    images: z.array(ImportAssetInputSchema).min(1).max(MAX_IMAGE_IMPORT_COUNT),
  })
  .strict()
  .refine(
    (request) =>
      request.images.reduce((total, image) => total + image.bytes.byteLength, 0) <=
      MAX_IMAGE_IMPORT_BATCH_BYTES,
    "一批图片的总大小不能超过 250 MiB。",
  );
export type ImportAssetBatchRequest = z.infer<typeof ImportAssetBatchRequestSchema>;

export const ImportedAssetSchema = z.object({
  descriptor: AssetDescriptorSchema,
  preview: z.instanceof(Uint8Array),
  // Per-import name; content-addressed storage may retain an earlier descriptor name.
  importedName: z.string().min(1).max(1024).optional(),
});
export type ImportedAsset = z.infer<typeof ImportedAssetSchema>;

export const DrawingImportRequestSchema = ImportAssetRequestSchema.extend({
  bytes: z.instanceof(Uint8Array).refine((bytes) => {
    const dwg = bytes[0] === 65 && bytes[1] === 67 && bytes[2] === 49 && bytes[3] === 48;
    return bytes.byteLength <= (dwg ? MAX_DRAWING_INPUT_BYTES : 50 * 1024 * 1024);
  }, "DWG 图纸不能超过 100 MiB，其他图纸不能超过 50 MiB。"),
  operationId: z.string().uuid(),
  preview: z
    .instanceof(Uint8Array)
    .refine((v) => v.byteLength <= 10 * 1024 * 1024)
    .optional(),
}).strict();
export const DrawingCancelImportSchema = z
  .object({ sessionId: SessionIdSchema, operationId: z.string().uuid() })
  .strict();
export const DrawingCancelImportResultSchema = appResultSchema(z.boolean());
export const DrawingImportValueSchema = z.object({
  assets: z.array(ImportedAssetSchema).min(1).max(2),
  sourceKind: z.enum(["dwg", "pdf", "image"]),
  warnings: z.array(z.string()),
});
export type DrawingImportValue = z.infer<typeof DrawingImportValueSchema>;
export const DrawingImportResultSchema = appResultSchema(DrawingImportValueSchema);

export const CadPrepareRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    operationId: z.string().uuid(),
    originalName: z.string().min(1).max(255),
    format: z.enum(["dwg", "dxf"]),
    preserveFrame: z.boolean().optional(),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_DRAWING_INPUT_BYTES),
    frame: z
      .object({
        mapping: CadMappingSchema,
        width: z.number().finite().positive().max(100000),
        height: z.number().finite().positive().max(100000),
      })
      .strict()
      .optional(),
  })
  .strict();
export const CadPreparedValueSchema = z
  .object({
    assets: z.array(ImportedAssetSchema).min(2).max(3),
    cad: CadCheckpointSchema,
    width: z.number().finite().positive().max(100000),
    height: z.number().finite().positive().max(100000),
  })
  .strict();
export const CadPreparedResultSchema = appResultSchema(CadPreparedValueSchema);
export const CadConvertRequestSchema = CadPrepareRequestSchema.pick({
  sessionId: true,
  bytes: true,
})
  .extend({
    format: z.enum(["dwg", "dxf"]),
  })
  .strict();
export const CadExportRequestSchema = CadConvertRequestSchema.extend({
  name: z.string().trim().min(1).max(200),
});

export const AssetReferenceRequestSchema = z.object({
  sessionId: SessionIdSchema,
  assetId: z.string().uuid(),
});
export type AssetReferenceRequest = z.infer<typeof AssetReferenceRequestSchema>;

export const DesignImageProcessRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    assetId: StableIdSchema,
    operations: z.array(DesignPatentImageOperationSchema).max(100),
  })
  .strict();
export type DesignImageProcessRequest = z.infer<typeof DesignImageProcessRequestSchema>;

export const DesignImageSubjectBoundsSchema = z
  .object({
    leftPx: z.number().int().nonnegative(),
    topPx: z.number().int().nonnegative(),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  })
  .strict();
export const DesignImageProcessResultSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    subjectBounds: DesignImageSubjectBoundsSchema.nullable(),
  })
  .strict();
export type DesignImageProcessResult = z.infer<typeof DesignImageProcessResultSchema>;
export const DesignEditorSourceSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    widthPx: z.number().int().positive().max(10000),
    heightPx: z.number().int().positive().max(10000),
    mediaType: z.literal("image/png"),
    initializedFrom: z.enum(["original", "legacy-recipe"]),
    initialLayerKind: z.enum(["regular", "background"]),
  })
  .strict()
  .refine((value) => value.widthPx * value.heightPx <= 40000000);
export type DesignEditorSource = z.infer<typeof DesignEditorSourceSchema>;
export const DesignEditorSourceResultSchema = appResultSchema(DesignEditorSourceSchema);
export const DesignEditorWorkspaceRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    frameId: z.string().uuid(),
    scope: z.literal("application").optional(),
  })
  .strict();
export const DesignEditorWorkspaceLeaseSchema = DesignEditorWorkspaceRequestSchema.extend({
  leaseId: z.string().uuid(),
  limitBytes: z.number().int().positive().safe(),
}).strict();
export const DesignEditorWorkspaceReleaseSchema = z
  .object({ sessionId: SessionIdSchema, leaseId: z.string().uuid() })
  .strict();
export const DesignEditorWorkspaceLeaseResultSchema = appResultSchema(
  DesignEditorWorkspaceLeaseSchema,
);
export type DesignEditorWorkspaceLease = z.infer<typeof DesignEditorWorkspaceLeaseSchema>;
export const StageDesignEditorProjectRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    project: z
      .object({
        metadata: DesignEditorMetadataSchema,
        psd: z
          .instanceof(Uint8Array)
          .refine((bytes) => bytes.byteLength >= 26 && bytes.byteLength <= 50 * 1024 * 1024),
        backings: z
          .array(
            z
              .object({
                id: z.string().min(1).max(208),
                bytes: z.instanceof(Uint8Array),
              })
              .strict(),
          )
          .max(16),
      })
      .strict()
      .refine(
        (project) =>
          project.psd.byteLength +
            project.backings.reduce((total, asset) => total + asset.bytes.byteLength, 0) <=
          50 * 1024 * 1024,
      ),
    thumbnail: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 4 * 1024 * 1024),
  })
  .strict();
export type StageDesignEditorProjectRequest = z.infer<typeof StageDesignEditorProjectRequestSchema>;
export const DesignEditorProjectDataSchema = StageDesignEditorProjectRequestSchema.shape.project;
export type DesignEditorProjectData = z.infer<typeof DesignEditorProjectDataSchema>;
export const DesignEditorProjectDataResultSchema = appResultSchema(DesignEditorProjectDataSchema);

export const DrawingTileRequestSchema = AssetReferenceRequestSchema.extend({
  tileId: z.string().regex(/^tile-[0-9]{1,4}$/u),
  raster: DrawingTileRasterSchema.optional(),
}).strict();

export const DiscardImportedAssetsRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    operationId: z.string().uuid(),
    assetIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict()
  .refine((request) => new Set(request.assetIds).size === request.assetIds.length, {
    message: "待释放图片资源不能重复。",
    path: ["assetIds"],
  });
export type DiscardImportedAssetsRequest = z.infer<typeof DiscardImportedAssetsRequestSchema>;

export const StageAssetReferencesRequestSchema = z
  .object({
    sourceSessionId: SessionIdSchema,
    targetSessionId: SessionIdSchema,
    operationId: z.string().uuid(),
    assetIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict()
  .refine((request) => new Set(request.assetIds).size === request.assetIds.length, {
    message: "待复制图片资源不能重复。",
    path: ["assetIds"],
  });
export type StageAssetReferencesRequest = z.infer<typeof StageAssetReferencesRequestSchema>;

export const ImageOutputFormatSchema = z.enum(["png", "jpg", "tif"]);
export type ImageOutputFormat = z.infer<typeof ImageOutputFormatSchema>;
const ImageClipboardChemicalStructureSchema = z
  .object({
    ketSource: z
      .string()
      .refine((value) => value.trim().length > 0, "KET 源码不能为空")
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= MAX_KET_SOURCE_BYTES,
        `KET 源码不能超过 ${MAX_KET_SOURCE_BYTES} 字节`,
      ),
    editorMode: z.enum(["molecule", "macromolecule"]),
    widthMm: z.number().min(10).max(165),
    alignment: z.enum(["left", "center", "right"]),
  })
  .strict();
export const ImageExportItemSchema = z
  .object({
    assetId: z.string().uuid(),
    rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    layout: z.enum(["block", "inline"]).optional(),
    widthMm: z.number().min(10).max(165).optional(),
    alignment: z.enum(["left", "center", "right"]).optional(),
    chemicalStructure: ImageClipboardChemicalStructureSchema.optional(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^\\/:*?"<>|]+$/u),
  })
  .strict();
export type ImageExportItem = z.infer<typeof ImageExportItemSchema>;
export const imageClipboardMarker = (index: number): string => `\uE020PIMG${index}\uE021`;
export const CopyImagesRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    images: z.array(ImageExportItemSchema).min(1).max(100),
    htmlTemplate: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    text: z.string().max(1_000_000).optional(),
  })
  .strict();
export type CopyImagesRequest = z.infer<typeof CopyImagesRequestSchema>;
export const SaveImageRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    image: ImageExportItemSchema,
    format: ImageOutputFormatSchema.optional(),
  })
  .strict();
export type SaveImageRequest = z.infer<typeof SaveImageRequestSchema>;
export const SaveImagesRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    images: z.array(ImageExportItemSchema).min(1).max(100),
    format: ImageOutputFormatSchema,
  })
  .strict();
export type SaveImagesRequest = z.infer<typeof SaveImagesRequestSchema>;
export const CloseTokenSchema = z.string().uuid();
export const CloseResultRequestSchema = z
  .object({
    token: CloseTokenSchema,
    proceed: z.boolean(),
  })
  .strict();
export type CloseResultRequest = z.infer<typeof CloseResultRequestSchema>;

export const RendererFailureReportSchema = z
  .object({
    source: z.enum(["react-boundary", "window-error", "unhandled-rejection"]),
    failureKind: z.enum(["type-error", "reference-error", "render-loop", "other"]).optional(),
    locations: z.array(RendererFailureLocationSchema).max(3).optional(),
  })
  .strict();
export type RendererFailureReport = z.infer<typeof RendererFailureReportSchema>;

export const LibraryScopeSchema = z.enum(["active", "trash"]);

export const PatentCreateRequestSchema = z
  .object({
    patentType: PatentTypeSchema,
    name: z.string().trim().min(1).max(PATENT_NAME_MAX_LENGTH).nullable(),
    customer: z.string().trim().min(1).max(PATENT_CUSTOMER_MAX_LENGTH).nullable().optional(),
  })
  .strict();
export type PatentCreateRequest = z.infer<typeof PatentCreateRequestSchema>;

export const DocxImportTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("official-book"),
      bookKind: z.enum([
        "claims",
        "description",
        "description-drawings",
        "abstract",
        "abstract-drawing",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("auxiliary") }).strict(),
]);
export type DocxImportTarget = z.infer<typeof DocxImportTargetSchema>;

export const DocxImportPreviewUnitSchema = z
  .object({
    unitId: z.string().uuid(),
    sourceFileName: z.string().trim().min(1).max(260),
    title: z.string().trim().min(1).max(200),
    target: DocxImportTargetSchema,
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string().trim().min(1).max(500)).max(50),
    document: PatentBookDocumentSchema,
    imageCount: z.number().int().nonnegative().max(100_000),
  })
  .strict();
export type DocxImportPreviewUnit = z.infer<typeof DocxImportPreviewUnitSchema>;

export const DocxImportPreviewWarningSchema = z
  .object({
    warningId: z.string().uuid(),
    unitId: z.string().uuid().nullable(),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    severity: z.enum(["information", "important"]),
  })
  .strict();
export type DocxImportPreviewWarning = z.infer<typeof DocxImportPreviewWarningSchema>;

const DocxImportDestinationSchema = z
  .object({
    patentId: z.string().uuid(),
    sessionId: SessionIdSchema,
  })
  .strict();

export const DocxImportPrepareRequestSchema = z
  .object({
    appendTo: DocxImportDestinationSchema.optional(),
  })
  .strict();
export type DocxImportPrepareRequest = z.infer<typeof DocxImportPrepareRequestSchema>;

export const DocxImportPreviewSchema = z
  .object({
    sessionId: SessionIdSchema,
    units: z.array(DocxImportPreviewUnitSchema).min(1).max(500),
    duplicateOfficialTargets: z.array(PatentBookKindSchema).max(5),
    warnings: z.array(DocxImportPreviewWarningSchema).max(2_000),
    sourceFileNames: z.array(z.string().trim().min(1).max(260)).min(1).max(100),
    appendTo: DocxImportDestinationSchema.optional(),
  })
  .strict();
export type DocxImportPreview = z.infer<typeof DocxImportPreviewSchema>;

export const DocxImportUpdateRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    unitId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    target: DocxImportTargetSchema,
  })
  .strict();
export type DocxImportUpdateRequest = z.infer<typeof DocxImportUpdateRequestSchema>;

export const DocxImportCommitAssignmentSchema = z
  .object({
    unitId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    target: DocxImportTargetSchema,
    drawingOrder: z.array(z.string().uuid()).max(100_000).optional(),
  })
  .strict();

export const DocxImportCommitRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    appendTo: DocxImportDestinationSchema.extend({
      expectedRevision: z.number().int().nonnegative(),
    }).optional(),
    patentType: PatentTypeSchema,
    name: z.string().trim().min(1).max(PATENT_NAME_MAX_LENGTH).nullable(),
    customer: z.string().trim().min(1).max(PATENT_CUSTOMER_MAX_LENGTH).nullable(),
    assignments: z.array(DocxImportCommitAssignmentSchema).min(1).max(500),
    acknowledgedWarningIds: z.array(z.string().uuid()).max(2_000),
  })
  .strict();
export type DocxImportCommitRequest = z.infer<typeof DocxImportCommitRequestSchema>;

export const DocxImportCancelRequestSchema = z.object({ sessionId: SessionIdSchema }).strict();
export type DocxImportCancelRequest = z.infer<typeof DocxImportCancelRequestSchema>;

const FlowchartSourceBytesSchema = z
  .instanceof(Uint8Array)
  .refine(
    (source) => source.byteLength > 0 && source.byteLength <= FLOWCHART_MAX_SOURCE_XML_BYTES,
    "流程图源文件大小无效。",
  );
const FlowchartNameSchema = z.string().trim().min(1).max(200);
const FlowchartPageIdSchema = z.string().min(1).max(500);

export const FlowchartCreateRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    expectedPatentRevision: LibraryRevisionSchema,
    name: FlowchartNameSchema,
    source: FlowchartSourceBytesSchema,
    pageCount: z.number().int().min(1).max(100),
    lastPageId: FlowchartPageIdSchema.nullable(),
  })
  .strict();
export type FlowchartCreateRequest = z.infer<typeof FlowchartCreateRequestSchema>;

export const FlowchartImportRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    expectedPatentRevision: LibraryRevisionSchema,
  })
  .strict();
export type FlowchartImportRequest = z.infer<typeof FlowchartImportRequestSchema>;

export const FlowchartLoadRequestSchema = z
  .object({ patentId: LibraryPatentIdSchema, projectId: z.string().uuid() })
  .strict();
export type FlowchartLoadRequest = z.infer<typeof FlowchartLoadRequestSchema>;

export const FlowchartSaveRequestSchema = FlowchartCreateRequestSchema.omit({ name: true })
  .extend({
    projectId: z.string().uuid(),
    expectedProjectRevision: LibraryRevisionSchema,
  })
  .strict();
export type FlowchartSaveRequest = z.infer<typeof FlowchartSaveRequestSchema>;

export const FlowchartRenameRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    projectId: z.string().uuid(),
    expectedPatentRevision: LibraryRevisionSchema,
    expectedProjectRevision: LibraryRevisionSchema,
    name: FlowchartNameSchema,
  })
  .strict();
export type FlowchartRenameRequest = z.infer<typeof FlowchartRenameRequestSchema>;

export const FlowchartDuplicateRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    projectId: z.string().uuid(),
    expectedPatentRevision: LibraryRevisionSchema,
    name: FlowchartNameSchema,
  })
  .strict();
export type FlowchartDuplicateRequest = z.infer<typeof FlowchartDuplicateRequestSchema>;

export const FlowchartDeleteRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    projectId: z.string().uuid(),
    expectedPatentRevision: LibraryRevisionSchema,
  })
  .strict();
export type FlowchartDeleteRequest = z.infer<typeof FlowchartDeleteRequestSchema>;

export const FlowchartOpenedProjectSchema = z
  .object({
    project: FlowchartProjectDescriptorSchema,
    source: FlowchartSourceBytesSchema,
    patentRevision: LibraryRevisionSchema,
  })
  .strict();
export type FlowchartOpenedProject = z.infer<typeof FlowchartOpenedProjectSchema>;

export const FlowchartDeleteResultSchema = z
  .object({
    patentRevision: LibraryRevisionSchema,
    detachedFigureCount: z.number().int().nonnegative(),
  })
  .strict();

export const FlowchartFigureTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("new"), insertIndex: z.number().int().nonnegative().max(100_000) })
    .strict(),
  z
    .object({
      kind: z.literal("replace"),
      figureId: z.string().uuid(),
      assetId: z.string().uuid(),
    })
    .strict(),
]);
export type FlowchartFigureTarget = z.infer<typeof FlowchartFigureTargetSchema>;

export const FlowchartRenderPreviewRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    projectId: z.string().uuid(),
    expectedProjectRevision: LibraryRevisionSchema,
    expectedSourceSha256: z.string().regex(/^[0-9A-F]{64}$/u),
    pageId: z.string().min(1).max(500),
    exportScope: z.enum(["page", "selection"]),
    selectedCellIds: z.array(z.string().min(1).max(500)).max(FLOWCHART_MAX_OBJECTS),
    borderMm: z.number().min(0).max(20),
    outputWidthMm: z.number().positive().max(165).optional(),
    drawingPage: PageSettingsSchema.optional(),
    rotationDeg: ImageRotationSchema.optional(),
    svg: z.string().max(20 * 1024 * 1024),
    target: FlowchartFigureTargetSchema,
  })
  .strict();
export type FlowchartRenderPreviewRequest = z.infer<typeof FlowchartRenderPreviewRequestSchema>;
export const FlowchartPdfRequestSchema = z
  .object({
    patentId: z.uuid(),
    sessionId: z.uuid(),
    svgs: z
      .array(
        z
          .string()
          .min(1)
          .max(20 * 1024 * 1024),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) =>
      value.svgs.reduce((size, svg) => size + new TextEncoder().encode(svg).byteLength, 0) <=
      40 * 1024 * 1024,
    "绘图 PDF 输入超过 40 MiB 限制。",
  );

export const FlowchartRenderPreviewSchema = z
  .object({
    previewToken: z.string().uuid(),
    outputWidthMm: z.number().positive().max(165),
    preview: z.instanceof(Uint8Array),
    widthPx: z.number().int().positive().max(100_000),
    heightPx: z.number().int().positive().max(100_000),
    warnings: z.array(z.string().min(1).max(500)).max(100),
  })
  .strict();
export type FlowchartRenderPreview = z.infer<typeof FlowchartRenderPreviewSchema>;

export const FlowchartCommitPreviewRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedPatentRevision: LibraryRevisionSchema,
    projectId: z.string().uuid(),
    previewToken: z.string().uuid(),
  })
  .strict();
export type FlowchartCommitPreviewRequest = z.infer<typeof FlowchartCommitPreviewRequestSchema>;

export const FlowchartCommitPreviewResultSchema = z
  .object({ patent: CanonicalPatentSchema, savedAt: z.string().datetime() })
  .strict();

export const OpenedPatentSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: z.string().uuid(),
    revision: LibraryRevisionSchema,
    patent: CanonicalPatentSchema,
    saveState: LibrarySaveStateSchema,
  })
  .strict();
export type OpenedPatent = z.infer<typeof OpenedPatentSchema>;

export const PatentUpdateSettingsRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    expectedRevision: LibraryRevisionSchema,
    name: z.string().trim().min(1).max(PATENT_NAME_MAX_LENGTH).nullable().optional(),
    customer: z.string().trim().max(PATENT_CUSTOMER_MAX_LENGTH).nullable().optional(),
    patentType: PatentTypeSchema,
    referenceMarks: z.array(PatentReferenceMarkSchema).max(100_000).optional(),
    referenceMarkSettings: PatentReferenceMarkSettingsSchema.optional(),
    assets: z.array(AssetDescriptorSchema).max(100_000).optional(),
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
  .strict()
  .superRefine((request, ctx) => {
    if ((request.referenceMarks === undefined) !== (request.referenceMarkSettings === undefined)) {
      ctx.addIssue({ code: "custom", message: "附图标记和同步设置必须同时提交。" });
    }
  });
export type PatentUpdateSettingsRequest = z.infer<typeof PatentUpdateSettingsRequestSchema>;

export const PatentUpdateDesignPatentRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
    designPatent: DesignPatentSchema,
    assets: z.array(AssetDescriptorSchema).max(100_000),
  })
  .strict();
export type PatentUpdateDesignPatentRequest = z.infer<typeof PatentUpdateDesignPatentRequestSchema>;

export const PatentSetDrawingBooksRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
    enabled: z.boolean(),
    settings: z
      .object({
        name: z.string().trim().min(1).max(500).nullable(),
        customer: z.string().trim().max(200).nullable(),
        patentType: PatentTypeSchema,
        terminologyReplacementRequested: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.enabled === false && request.settings?.patentType === "utility-model") {
      ctx.addIssue({
        code: "custom",
        message: "实用新型必须启用说明书附图和摘要附图。",
        path: ["enabled"],
      });
    }
  });
export type PatentSetDrawingBooksRequest = z.infer<typeof PatentSetDrawingBooksRequestSchema>;

export const PatentAggregateEditResultSchema = z
  .object({
    patent: CanonicalPatentSchema,
    savedAt: z.string().datetime(),
    assetIdsForPostCommitGarbageCollection: z.array(z.string().uuid()),
    notice: z.string().nullable(),
  })
  .strict();
export type PatentAggregateEditResult = z.infer<typeof PatentAggregateEditResultSchema>;

export const PatentApplyBookEditRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    bookKind: PatentBookKindSchema,
    expectedRevision: LibraryRevisionSchema,
    document: PatentBookDocumentSchema,
    editorState: JsonObjectSchema,
    assets: z.array(AssetDescriptorSchema).max(100_000),
  })
  .strict()
  .superRefine((request, ctx) => {
    const assetIds = request.assets.map((asset) => asset.assetId);
    const uniqueAssetIds = new Set(assetIds);
    if (uniqueAssetIds.size !== assetIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "书册资源编号重复。",
        path: ["assets"],
      });
      return;
    }
    const validated = validatePatentBookDocument(request.document, uniqueAssetIds, request.assets);
    if (!validated.ok) {
      ctx.addIssue({ code: "custom", message: validated.error.message, path: ["document"] });
    }
  });
export type PatentApplyBookEditRequest = z.infer<typeof PatentApplyBookEditRequestSchema>;

const PatentAuxiliaryDocumentMutationBaseSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
  })
  .strict();

export const PatentCreateAuxiliaryDocumentRequestSchema =
  PatentAuxiliaryDocumentMutationBaseSchema.extend({
    document: AuxiliaryDocumentSchema,
  }).strict();
export type PatentCreateAuxiliaryDocumentRequest = z.infer<
  typeof PatentCreateAuxiliaryDocumentRequestSchema
>;

export const PatentApplyAuxiliaryDocumentEditRequestSchema =
  PatentAuxiliaryDocumentMutationBaseSchema.extend({
    auxiliaryDocumentId: z.string().uuid(),
    document: PatentBookDocumentSchema,
    editorState: JsonObjectSchema,
    assets: z.array(AssetDescriptorSchema).max(100_000),
  })
    .strict()
    .superRefine((request, ctx) => {
      const assetIds = new Set(request.assets.map((asset) => asset.assetId));
      if (assetIds.size !== request.assets.length) {
        ctx.addIssue({ code: "custom", message: "其他文档资源编号重复。", path: ["assets"] });
        return;
      }
      const validated = validatePatentBookDocument(request.document, assetIds, request.assets);
      if (!validated.ok) {
        ctx.addIssue({ code: "custom", message: validated.error.message, path: ["document"] });
      }
    });
export type PatentApplyAuxiliaryDocumentEditRequest = z.infer<
  typeof PatentApplyAuxiliaryDocumentEditRequestSchema
>;

export const PatentMoveAuxiliaryDocumentRequestSchema =
  PatentAuxiliaryDocumentMutationBaseSchema.extend({
    auxiliaryDocumentId: z.string().uuid(),
    direction: z.enum(["up", "down"]),
  }).strict();
export type PatentMoveAuxiliaryDocumentRequest = z.infer<
  typeof PatentMoveAuxiliaryDocumentRequestSchema
>;

export const PatentRenameAuxiliaryDocumentRequestSchema =
  PatentAuxiliaryDocumentMutationBaseSchema.extend({
    auxiliaryDocumentId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
  }).strict();
export type PatentRenameAuxiliaryDocumentRequest = z.infer<
  typeof PatentRenameAuxiliaryDocumentRequestSchema
>;

export const PatentDeleteAuxiliaryDocumentRequestSchema =
  PatentAuxiliaryDocumentMutationBaseSchema.extend({
    auxiliaryDocumentId: z.string().uuid(),
  }).strict();
export type PatentDeleteAuxiliaryDocumentRequest = z.infer<
  typeof PatentDeleteAuxiliaryDocumentRequestSchema
>;

export const PatentDescriptionEditorStateSchema = z
  .object({
    unlinkedFigureExplanations: z.array(UnlinkedDrawingExplanationSchema).max(100_000),
    selection: JsonObjectSchema.optional(),
  })
  .strict();
export type PatentDescriptionEditorState = z.infer<typeof PatentDescriptionEditorStateSchema>;

export const PatentApplyFigureEditRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
    figures: z.array(PatentFigureSchema).max(100_000),
    abstractDrawingFigureId: z.string().uuid().nullable(),
    assets: z.array(AssetDescriptorSchema).max(100_000),
    drawingProjects: DrawingProjectsSchema.optional(),
    drawingProjectEdits: DrawingProjectEditsSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.drawingProjects !== undefined && request.drawingProjectEdits !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "不能同时提交完整图纸和图纸编辑。",
        path: ["drawingProjectEdits"],
      });
    const figureIds = new Set<string>();
    request.figures.forEach((figure, index) => {
      if (figureIds.has(figure.figureId)) {
        ctx.addIssue({
          code: "custom",
          message: "附图编号重复。",
          path: ["figures", index, "figureId"],
        });
      }
      figureIds.add(figure.figureId);
    });

    if (
      request.abstractDrawingFigureId !== null &&
      !request.figures.some((figure) => figure.figureId === request.abstractDrawingFigureId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "摘要附图编号不存在。",
        path: ["abstractDrawingFigureId"],
      });
    }
  });
export type PatentApplyFigureEditRequest = z.infer<typeof PatentApplyFigureEditRequestSchema>;

export const PatentFlushRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    expectedRevision: LibraryRevisionSchema,
  })
  .strict();
export type PatentFlushRequest = z.infer<typeof PatentFlushRequestSchema>;

export const PatentResourceInspectionRequestSchema = PatentFlushRequestSchema.extend({
  sessionId: SessionIdSchema,
  operationId: StableIdSchema,
}).strict();
export const PatentResourceInspectionCancelSchema = z
  .object({ sessionId: SessionIdSchema, operationId: StableIdSchema })
  .strict();
export const PatentResourceInspectionResultSchema = appResultSchema(
  z
    .object({
      patentId: LibraryPatentIdSchema,
      patentRevision: LibraryRevisionSchema,
      assets: z
        .array(
          z
            .object({
              assetId: StableIdSchema,
              status: z.enum(["ok", "missing", "damaged", "unreadable"]),
            })
            .strict(),
        )
        .max(200_000),
    })
    .strict(),
);
export type PatentResourceInspectionRequest = z.infer<typeof PatentResourceInspectionRequestSchema>;
export type PatentResourceInspectionCancel = z.infer<typeof PatentResourceInspectionCancelSchema>;

export const PatentExportPatdocRequestSchema = PatentFlushRequestSchema.extend({
  workspace: PatdocWorkspaceSchema.optional(),
  suggestedName: z.string().trim().min(1).max(MAX_DOCX_SUGGESTED_NAME_LENGTH).optional(),
}).strict();
export type PatentExportPatdocRequest = z.infer<typeof PatentExportPatdocRequestSchema>;

export const PatentFlushResultSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    revision: LibraryRevisionSchema,
    flushedAt: z.string().datetime(),
  })
  .strict();
export type PatentFlushResult = z.infer<typeof PatentFlushResultSchema>;

export const PatentPurgeResultSchema = z
  .object({
    purgedPatentIds: z.array(LibraryPatentIdSchema),
  })
  .strict();
export type PatentPurgeResult = z.infer<typeof PatentPurgeResultSchema>;

export const PatentRecoveryResultSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    backupCreated: z.literal(true),
  })
  .strict();
export type PatentRecoveryResult = z.infer<typeof PatentRecoveryResultSchema>;

export const PatentEditAckSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    revision: LibraryRevisionSchema,
    savedAt: z.string().datetime(),
  })
  .strict();
export type PatentEditAck = z.infer<typeof PatentEditAckSchema>;

export const OpenedLibraryDocumentSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    sessionId: z.string().uuid(),
    revision: LibraryRevisionSchema,
    document: CanonicalDocumentSchema,
    editorState: JsonObjectSchema,
    saveState: LibrarySaveStateSchema,
  })
  .strict();
export type OpenedLibraryDocument = z.infer<typeof OpenedLibraryDocumentSchema>;

export const LibraryRenameRequestSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    operationId: z.string().uuid(),
    expectedRevision: LibraryRevisionSchema,
    title: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => value.trim().length > 0, "标题不能为空。"),
  })
  .strict();
export type LibraryRenameRequest = z.infer<typeof LibraryRenameRequestSchema>;

export const LibraryFlushRequestSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    expectedRevision: LibraryRevisionSchema,
  })
  .strict();
export type LibraryFlushRequest = z.infer<typeof LibraryFlushRequestSchema>;

export const LibraryFlushResultSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    revision: LibraryRevisionSchema,
    flushedAt: z.string().datetime(),
  })
  .strict();
export type LibraryFlushResult = z.infer<typeof LibraryFlushResultSchema>;

export const LibraryPurgeResultSchema = z
  .object({
    purgedDocumentIds: z.array(LibraryDocumentIdSchema),
  })
  .strict();
export type LibraryPurgeResult = z.infer<typeof LibraryPurgeResultSchema>;

export const LibraryExportPatdocRequestSchema = LibraryFlushRequestSchema;
export type LibraryExportPatdocRequest = z.infer<typeof LibraryExportPatdocRequestSchema>;

export const LibraryEmergencyExportPatdocRequestSchema = z
  .object({
    document: CanonicalDocumentSchema,
    editorState: JsonObjectSchema,
  })
  .strict();
export type LibraryEmergencyExportPatdocRequest = z.infer<
  typeof LibraryEmergencyExportPatdocRequestSchema
>;

export const DraftSummarySchema = z.object({
  draftId: StableIdSchema,
  documentId: StableIdSchema,
  displayName: z.string().trim().min(1).max(255),
  originalPath: LocalPathSchema.nullable(),
  savedAt: z.string().datetime(),
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;

export const SaveDraftRequestSchema = SaveDocumentRequestSchema.extend({
  documentId: StableIdSchema,
  originalPath: LocalPathSchema.nullable(),
  displayName: z.string().trim().min(1).max(255),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequestSchema>;

export type {
  LibraryDocumentSummary,
  LibraryEditAck,
  LibraryPatentSummary,
} from "../library/model.js";
export type {
  AppSettings,
  BackupEntry,
  BackupSettings,
  BackupStatus,
  DirectPrintRequest,
  ExplicitSnapshotSource,
  JsonObject,
  JsonValue,
  PrinterDescriptor,
  PrintPreviewRequest,
  SnapshotContentPreview,
  SnapshotContentPreviewRequest,
  SnapshotCreateRequest,
  SnapshotCreationResult,
  SnapshotEntry,
  SnapshotListResult,
  SnapshotPreviewAssetRequest,
  SnapshotRestoreRequest,
  SnapshotSettings,
  SnapshotSource,
  SnapshotStatus,
};
export {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  BackupConfigureRequestSchema,
  BackupEntrySchema,
  BackupSettingsSchema,
  BackupTargetSchema,
  DirectPrintRequestSchema,
  ExplicitSnapshotSourceSchema,
  JsonObjectSchema,
  JsonValueSchema,
  LibraryDocumentIdSchema,
  LibraryDocumentSummarySchema,
  LibraryEditAckSchema,
  LibraryEditBatchSchema,
  LibraryPatentIdSchema,
  PrinterDescriptorSchema,
  PrintPreviewRequestSchema,
  SessionIdSchema,
  SnapshotContentPreviewRequestSchema,
  SnapshotCreateRequestSchema,
  SnapshotCreationResultSchema,
  SnapshotEntrySchema,
  SnapshotPreviewAssetRequestSchema,
  SnapshotRestoreRequestSchema,
  SnapshotSettingsSchema,
  SnapshotSourceSchema,
  StableIdSchema,
};

export const ExportRequestSchema = z.object({
  sessionId: SessionIdSchema,
  document: CanonicalDocumentSchema,
  suggestedName: z.string().trim().min(1).max(MAX_DOCX_SUGGESTED_NAME_LENGTH),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const PatentDocxExportRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      sessionId: SessionIdSchema,
      patentId: LibraryPatentIdSchema,
      expectedRevision: LibraryRevisionSchema,
      mode: z.literal("combined"),
      suggestedName: z.string().trim().min(1).max(MAX_DOCX_SUGGESTED_NAME_LENGTH),
    })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      patentId: LibraryPatentIdSchema,
      expectedRevision: LibraryRevisionSchema,
      mode: z.literal("single"),
      bookKind: PatentBookKindSchema,
      suggestedName: z.string().trim().min(1).max(MAX_DOCX_SUGGESTED_NAME_LENGTH),
    })
    .strict(),
]);
export type PatentDocxExportRequest = z.infer<typeof PatentDocxExportRequestSchema>;

export const AuxiliaryDocumentExportRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    patentId: LibraryPatentIdSchema,
    expectedRevision: LibraryRevisionSchema,
    auxiliaryDocumentId: z.string().uuid(),
    suggestedName: z.string().trim().min(1).max(MAX_DOCX_SUGGESTED_NAME_LENGTH),
  })
  .strict();
export type AuxiliaryDocumentExportRequest = z.infer<typeof AuxiliaryDocumentExportRequestSchema>;

export const DesignPatentExportRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    patentId: LibraryPatentIdSchema,
    expectedRevision: LibraryRevisionSchema,
    format: z.enum(["docx", "pdf"]),
    confirmWarnings: z.boolean(),
    zip: z.boolean(),
  })
  .strict();
export type DesignPatentExportRequest = z.infer<typeof DesignPatentExportRequestSchema>;
export const DesignPatentExportReportSchema = z
  .object({
    outputDirectory: LocalPathSchema,
    documentPath: LocalPathSchema,
    imagePaths: z.array(LocalPathSchema),
    zipPath: LocalPathSchema.nullable(),
    patent: CanonicalPatentSchema,
    savedAt: z.string().datetime(),
  })
  .strict();
export type DesignPatentExportReport = z.infer<typeof DesignPatentExportReportSchema>;

export const PreviewIdSchema = z.string().uuid();
export const PrintPreviewSchema = z
  .object({
    previewId: PreviewIdSchema,
    bytes: z.instanceof(Uint8Array),
  })
  .strict();
export type PrintPreview = z.infer<typeof PrintPreviewSchema>;

const SafeSuggestedNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DOCX_SUGGESTED_NAME_LENGTH)
  .refine((value) => createDocxSuggestedName(value) === value, "建议文件名包含不安全字符。");

export const SavePreviewPdfRequestSchema = z
  .object({
    previewId: PreviewIdSchema,
    suggestedName: SafeSuggestedNameSchema,
  })
  .strict();
export type SavePreviewPdfRequest = z.infer<typeof SavePreviewPdfRequestSchema>;

export const ExportReportSchema: z.ZodType<ExportReport> = z
  .object({
    format: z.enum(["docx", "pdf", "patdoc"]),
    outputPath: LocalPathSchema,
    issues: z.array(ExportIssueSchema),
  })
  .strict();
export type { ExportIssue, ExportReport } from "../exports/report.js";

export const MenuCommandSchema = z.enum([
  "open-settings",
  "new-document",
  "open-document",
  "save-document",
  "save-document-as",
  "export-docx",
  "export-pdf",
  "print-preview",
  "print",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "select-all",
  "find",
  "replace",
  "create-desktop-shortcut",
]);
export type MenuCommand = z.infer<typeof MenuCommandSchema>;

export const DualColumnWindowRequestSchema = z
  .object({
    enabled: z.boolean(),
    pageWidth: z.number().finite().min(300).max(3000),
    preserveBounds: z.boolean().optional(),
  })
  .strict();

export const WindowLayoutStateSchema = z
  .object({
    displayWidthMm: z.number().finite().min(100).max(3000).nullable().optional(),
    isMaximized: z.boolean(),
    contentWidth: z.number().int().nonnegative(),
    contentHeight: z.number().int().nonnegative(),
  })
  .strict();
export type WindowLayoutState = z.infer<typeof WindowLayoutStateSchema>;


export const NullableOpenedDocumentResultSchema = appResultSchema(OpenedDocumentSchema.nullable());
export const OpenedDocumentResultSchema = appResultSchema(OpenedDocumentSchema);
export const SavedDocumentResultSchema = appResultSchema(SavedDocumentSchema);
export const NullableSavedDocumentResultSchema = appResultSchema(SavedDocumentSchema.nullable());
export const AgreementStateResultSchema = appResultSchema(AgreementStateSchema);
export const UsageStateResultSchema = appResultSchema(UsageStateSchema);
export const UpdateStateResultSchema = appResultSchema(UpdateStateSchema);
export const VoidResultSchema = appResultSchema(z.void());
export const StorageFolderKindSchema = z.enum(["library", "backup"]);
const StorageFolderSchema = z
  .object({
    path: z.string().nullable(),
    bytes: z.number().nonnegative().nullable(),
    partial: z.boolean(),
  })
  .strict();
export const StorageOverviewSchema = z
  .object({ library: StorageFolderSchema, backup: StorageFolderSchema })
  .strict();
export const StorageOverviewResultSchema = appResultSchema(StorageOverviewSchema);
export const LibraryRelocationResultSchema = appResultSchema(z.boolean());
export const NullableImportedAssetResultSchema = appResultSchema(ImportedAssetSchema.nullable());
export const ImportedAssetResultSchema = appResultSchema(ImportedAssetSchema);
export const ImportedAssetListResultSchema = appResultSchema(z.array(ImportedAssetSchema));
export const DesignFileSelectionSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(1024),
        bytes: z
          .instanceof(Uint8Array)
          .refine((b) => b.byteLength > 0 && b.byteLength <= 50 * 1024 ** 2),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (files) => files.reduce((sum, file) => sum + file.bytes.byteLength, 0) <= 128 * 1024 ** 2,
  );
export const DesignFileSelectionResultSchema = appResultSchema(DesignFileSelectionSchema);
export const PreviewBytesResultSchema = appResultSchema(z.instanceof(Uint8Array));
export const NullableLocalPathResultSchema = appResultSchema(LocalPathSchema.nullable());
export const NullableLocalPathListResultSchema = appResultSchema(
  z.array(LocalPathSchema).max(100).nullable(),
);
export const FlowchartProjectListResultSchema = appResultSchema(
  z.array(FlowchartProjectDescriptorSchema),
);
export const FlowchartOpenedProjectResultSchema = appResultSchema(FlowchartOpenedProjectSchema);
export const NullableFlowchartOpenedProjectResultSchema = appResultSchema(
  FlowchartOpenedProjectSchema.nullable(),
);
export const FlowchartDeleteResultResultSchema = appResultSchema(FlowchartDeleteResultSchema);
export const FlowchartBackupResultSchema = appResultSchema(FlowchartSourceBytesSchema);
export const FlowchartRenderPreviewResultSchema = appResultSchema(FlowchartRenderPreviewSchema);
export const FlowchartCommitPreviewResultResultSchema = appResultSchema(
  FlowchartCommitPreviewResultSchema,
);
export const DesignImageProcessAppResultSchema = appResultSchema(DesignImageProcessResultSchema);
export const PrintPreviewResultSchema = appResultSchema(PrintPreviewSchema);
export const PrinterDescriptorsResultSchema = appResultSchema(z.array(PrinterDescriptorSchema));
export const DraftListResultSchema = appResultSchema(z.array(DraftSummarySchema));
export const DraftSummaryResultSchema = appResultSchema(DraftSummarySchema);
export const PatentListResultSchema = appResultSchema(z.array(LibraryPatentSummarySchema));
export const PatentSummaryResultSchema = appResultSchema(LibraryPatentSummarySchema);
export const PatentEditAckResultSchema = appResultSchema(PatentEditAckSchema);
export const PatentAggregateEditResultResultSchema = appResultSchema(
  PatentAggregateEditResultSchema,
);
export const OpenedPatentResultSchema = appResultSchema(OpenedPatentSchema);
export const NullableOpenedPatentResultSchema = appResultSchema(OpenedPatentSchema.nullable());
export const DocxImportPreviewResultSchema = appResultSchema(DocxImportPreviewSchema);
export const NullableDocxImportPreviewResultSchema = appResultSchema(
  DocxImportPreviewSchema.nullable(),
);
export const PatentFlushResultResultSchema = appResultSchema(PatentFlushResultSchema);
export const PatentPurgeResultResultSchema = appResultSchema(PatentPurgeResultSchema);
export const PatentRecoveryResultResultSchema = appResultSchema(PatentRecoveryResultSchema);
export const PatentTemplateLauncherSummaryResultSchema = appResultSchema(
  PatentTemplateLauncherSummarySchema,
);
export const PatentTemplateAuxiliaryCatalogResultSchema = appResultSchema(
  PatentTemplateAuxiliaryCatalogSchema,
);
export const PatentTemplateEditorSnapshotResultSchema = appResultSchema(
  PatentTemplateEditorSnapshotSchema,
);
export const PatentTemplateCapturedBooksResultSchema = appResultSchema(
  PatentTemplateCapturedBooksSchema,
);
export const LibraryDocumentListResultSchema = appResultSchema(
  z.array(LibraryDocumentSummarySchema),
);
export const LibraryDocumentSummaryResultSchema = appResultSchema(LibraryDocumentSummarySchema);
export const LibraryEditAckResultSchema = appResultSchema(LibraryEditAckSchema);
export const OpenedLibraryDocumentResultSchema = appResultSchema(OpenedLibraryDocumentSchema);
export const NullableOpenedLibraryDocumentResultSchema = appResultSchema(
  OpenedLibraryDocumentSchema.nullable(),
);
export const LibraryFlushResultResultSchema = appResultSchema(LibraryFlushResultSchema);
export const LibraryPurgeResultResultSchema = appResultSchema(LibraryPurgeResultSchema);
export const AppSettingsResultSchema = appResultSchema(AppSettingsSchema);
export const AiCorrectionSettingsStateResultSchema = appResultSchema(
  AiCorrectionSettingsStateSchema,
);
export const Sha256ResultResultSchema = appResultSchema(Sha256Schema);
export const AiCorrectionStartResultResultSchema = appResultSchema(AiCorrectionStartResultSchema);
export const TextPolishStartResultResultSchema = appResultSchema(TextPolishStartResultSchema);
export const TextPolishConversationStartResultResultSchema = appResultSchema(
  TextPolishConversationStartResultSchema,
);
export const TextPolishConversationOperationResultResultSchema = appResultSchema(
  TextPolishConversationOperationResultSchema,
);
export const TextPolishConversationSnapshotResultSchema = appResultSchema(
  TextPolishConversationSnapshotSchema,
);
export const TextPolishWorkspaceResultSchema = appResultSchema(TextPolishWorkspaceSchema);
export const AiModelDiscoveryResultResultSchema = appResultSchema(AiModelDiscoveryResultSchema);
export const NullableExportReportResultSchema = appResultSchema(ExportReportSchema.nullable());
export const NullableDesignPatentExportReportResultSchema = appResultSchema(
  DesignPatentExportReportSchema.nullable(),
);
export const DesignPatentExportDestinationResultSchema = appResultSchema(
  z.string().uuid().nullable(),
);
export const NullableSavedDocumentLibraryResultSchema = appResultSchema(
  SavedDocumentSchema.nullable(),
);
export const BackupStatusResultSchema = appResultSchema(BackupStatusSchema);
export const BackupConfigureResultSchema = appResultSchema(
  z.union([z.undefined(), BackupMigrationReportSchema]),
);
export const BackupEntryListResultSchema = appResultSchema(z.array(BackupEntrySchema));
export const BackupRestoreResultResultSchema = appResultSchema(BackupRestoreResultSchema);
export const BackupRunResultResultSchema = appResultSchema(BackupRunResultSchema);
export const BackupOperationStatusResultSchema = appResultSchema(BackupOperationStatusSchema);
export const SnapshotStatusResultSchema = appResultSchema(SnapshotStatusSchema);
export const SnapshotEntryListResultSchema = appResultSchema(SnapshotListResultSchema);
export const SnapshotCreationResultResultSchema = appResultSchema(SnapshotCreationResultSchema);
export const SnapshotDeletionResultResultSchema = appResultSchema(SnapshotDeletionResultSchema);
export const SnapshotContentPreviewResultSchema = appResultSchema(SnapshotContentPreviewSchema);
export const SnapshotPreviewAssetResultSchema = appResultSchema(z.instanceof(Uint8Array));
export const NullableStringResultSchema = appResultSchema(z.string().nullable());
export const ClipboardTextSchema = z.string().max(2 * 1024 * 1024);
export const ClipboardTextWriteRequestSchema = z.union([
  ClipboardTextSchema,
  z.object({ text: ClipboardTextSchema, style: z.literal("red-draft") }).strict(),
  z
    .object({ paragraphs: ClaimsRichParagraphsSchema, style: z.literal("formatted-draft") })
    .strict(),
]);
export type ClipboardTextWriteRequest = z.infer<typeof ClipboardTextWriteRequestSchema>;
export const ClipboardTextResultSchema = appResultSchema(ClipboardTextSchema);
export const ClipboardImageSchema = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength > 0 && value.byteLength <= 50 * 1024 * 1024),
    width: z.number().int().positive().max(10000),
    height: z.number().int().positive().max(10000),
  })
  .strict()
  .refine((value) => value.width * value.height <= 40000000);
export type ClipboardImage = z.infer<typeof ClipboardImageSchema>;
export const ClipboardImageResultSchema = appResultSchema(ClipboardImageSchema.nullable());
export const WindowLayoutStateResultSchema = appResultSchema(WindowLayoutStateSchema);
export { RecoverySourceSchema };
export const PreparedRecoveryResultSchema = appResultSchema(PreparedRecoverySchema.nullable());
export const StartupRecoveryReportResultSchema = appResultSchema(StartupRecoveryReportSchema);
export const DataTransferLibraryInspectionResultSchema = appResultSchema(
  DataTransferLibraryInspectionSchema,
);
export const NullableTransferDestinationSelectionResultSchema = appResultSchema(
  TransferDestinationSelectionSchema.nullable(),
);
export const FullDataExportResultResultSchema = appResultSchema(FullDataExportResultSchema);
export const NullableTransferSourceSelectionResultSchema = appResultSchema(
  TransferSourceSelectionSchema.nullable(),
);
export const FullDataImportPreviewResultSchema = appResultSchema(FullDataImportPreviewSchema);
export const FullDataImportCommitResultSchema = appResultSchema(
  z
    .object({ restartPending: z.literal(true) })
    .strict()
    .readonly(),
);

export interface PatentApi {
  tutorial?: {
    isSession: boolean;
    ready(): Promise<AppResult<void>>;
    read(): Promise<AppResult<import("../tutorial/model.js").TutorialContext | null>>;
    launch(lessonId: import("../tutorial/model.js").TutorialLessonId): Promise<AppResult<void>>;
    prepare(
      lessonId: import("../tutorial/model.js").TutorialLessonId,
    ): Promise<AppResult<import("../tutorial/model.js").TutorialContext>>;
  };
  agreements?: {
    read(): Promise<AppResult<AgreementState>>;
    accept(request: AgreementAccept): Promise<AppResult<AgreementState>>;
  };
  usageStatistics?: {
    read(): Promise<AppResult<UsageState>>;
    choose(choice: UsageChoice): Promise<AppResult<UsageState>>;
    onChanged(listener: (state: UsageState) => void): () => void;
  };
  updates?: {
    read(): Promise<AppResult<UpdateState>>;
    start(): Promise<AppResult<UpdateState>>;
    check(): Promise<AppResult<UpdateState>>;
    dismiss(request: {
      version: string;
      action: "later" | "skip";
    }): Promise<AppResult<UpdateState>>;
    openDownload(version: string): Promise<AppResult<void>>;
    onChanged(listener: (state: UpdateState) => void): () => void;
  };
  automation?: {
    control(
      request: import("../automation/protocol.js").AutomationUiRequest,
    ): Promise<AppResult<unknown>>;
    onEvent(
      listener: (event: import("../automation/protocol.js").AutomationEvent) => void,
    ): () => void;
  };
  contentSearch?: {
    request(
      request: import("../library/content-search.js").ContentSearchRequest,
    ): Promise<AppResult<import("../library/content-search.js").ContentSearchState>>;
    activity(): void;
  };
  ipcDataCenter?: { saveReport(request: IpcReportRequest): Promise<AppResult<string | null>> };
  dataTransfer: {
    inspectLibrary(): Promise<AppResult<DataTransferLibraryInspection>>;
    selectExportDestination(): Promise<AppResult<TransferDestinationSelection | null>>;
    exportPackage(request: FullDataExportRequest): Promise<AppResult<FullDataExportResult>>;
    selectImportPackage(): Promise<AppResult<TransferSourceSelection | null>>;
    prepareImport(request: FullDataImportPrepareRequest): Promise<AppResult<FullDataImportPreview>>;
    commitImport(
      request: FullDataImportCommitRequest,
    ): Promise<AppResult<{ restartPending: true }>>;
    cancel(operationId: string): Promise<AppResult<void>>;
    onProgress(listener: (progress: DataTransferProgress) => void): () => void;
  };

  imageEditor?: TemporaryImageApi;
  chemistry: {
    rasterizePreview(request: ChemicalPreviewRequest): Promise<AppResult<ImportedChemicalPreview>>;
    readStructureSource(
      request: z.infer<typeof AssetReferenceRequestSchema>,
    ): Promise<AppResult<ChemicalStructureSource | null>>;
  };
  formulaDrawings: {
    render(request: FormulaDrawingRenderRequest): Promise<AppResult<FormulaDrawingRenderPreview>>;
  };
  clipboard: {
    paste(): Promise<AppResult<void>>;
    readText(): Promise<AppResult<string>>;
    writeText(text: ClipboardTextWriteRequest): Promise<AppResult<void>>;
    /** Optional platform capability; only invoke from an explicit paste action. */
    readImage?(): Promise<AppResult<ClipboardImage | null>>;
    writeImage?(image: ClipboardImage): Promise<AppResult<void>>;
    writeText(text: string): Promise<AppResult<void>>;
  };
  documents: {
    activate(request: ActivateDocumentSessionRequest): Promise<AppResult<void>>;
    openDialog(): Promise<AppResult<OpenedDocument | null>>;
    openPath(path: string): Promise<AppResult<OpenedDocument>>;
    save(request: SaveDocumentRequest): Promise<AppResult<SavedDocument>>;
    saveAs(request: SaveDocumentRequest): Promise<AppResult<SavedDocument | null>>;
    release(sessionId: string): Promise<AppResult<void>>;
  };
  assets: {
    prepareCad(
      request: z.infer<typeof CadPrepareRequestSchema>,
    ): Promise<AppResult<z.infer<typeof CadPreparedValueSchema>>>;
    convertCad(request: z.infer<typeof CadConvertRequestSchema>): Promise<AppResult<Uint8Array>>;
    exportCad(request: z.infer<typeof CadExportRequestSchema>): Promise<AppResult<string | null>>;
    onDrawingImportProgress(listener: (event: DrawingImportProgressEvent) => void): () => void;
    importDrawing(
      request: z.infer<typeof DrawingImportRequestSchema>,
    ): Promise<AppResult<DrawingImportValue>>;
    readDrawingTile(
      sessionId: string,
      assetId: string,
      tileId: string,
      raster?: DrawingTileRaster,
    ): Promise<AppResult<Uint8Array>>;
    readDrawingSource(sessionId: string, assetId: string): Promise<AppResult<Uint8Array>>;
    cancelDrawingImport(
      request: z.infer<typeof DrawingCancelImportSchema>,
    ): Promise<AppResult<boolean>>;
    acquireDesignEditorWorkspace?(
      request: z.infer<typeof DesignEditorWorkspaceRequestSchema>,
    ): Promise<AppResult<DesignEditorWorkspaceLease>>;
    releaseDesignEditorWorkspace?(
      request: z.infer<typeof DesignEditorWorkspaceReleaseSchema>,
    ): Promise<AppResult<void>>;
    readDesignEditorProject?(
      request: AssetReferenceRequest,
    ): Promise<AppResult<DesignEditorProjectData>>;
    /** Staging is not a saved-state acknowledgement; commit the case reference separately. */
    stageDesignEditorProject?(
      request: StageDesignEditorProjectRequest,
    ): Promise<AppResult<ImportedAsset>>;
    prepareDesignEditorSource?(
      request: DesignImageProcessRequest,
    ): Promise<AppResult<DesignEditorSource>>;
    chooseAndImport(sessionId: string): Promise<AppResult<ImportedAsset | null>>;
    chooseAndImportMany(sessionId: string): Promise<AppResult<ImportedAsset[]>>;
    chooseDesignFiles?(
      sessionId: string,
    ): Promise<AppResult<Array<{ name: string; bytes: Uint8Array }>>>;
    importBytes(request: ImportAssetRequest): Promise<AppResult<ImportedAsset>>;
    importMany(request: ImportAssetBatchRequest): Promise<AppResult<ImportedAsset[]>>;
    stageReferences(request: StageAssetReferencesRequest): Promise<AppResult<ImportedAsset[]>>;
    discardImports(request: DiscardImportedAssetsRequest): Promise<AppResult<void>>;
    getPreview(sessionId: string, assetId: string): Promise<AppResult<Uint8Array>>;
    copyImages(request: CopyImagesRequest): Promise<AppResult<void>>;
    saveImage(request: SaveImageRequest): Promise<AppResult<string | null>>;
    saveImages(request: SaveImagesRequest): Promise<AppResult<string[] | null>>;
    processDesignImage(
      request: DesignImageProcessRequest,
    ): Promise<AppResult<DesignImageProcessResult>>;
  };
  drafts: {
    list(): Promise<AppResult<DraftSummary[]>>;
    save(request: SaveDraftRequest): Promise<AppResult<DraftSummary>>;
    open(draftId: string): Promise<AppResult<OpenedDocument>>;
    delete(draftId: string): Promise<AppResult<void>>;
  };
  patents: {
    exportFolder?(
      request: import("../patent/folder.js").PatentFolderExportRequest,
    ): Promise<AppResult<string | null>>;
    list(scope: z.infer<typeof LibraryScopeSchema>): Promise<AppResult<LibraryPatentSummary[]>>;
    getLibraryPreview?(patentId: string): Promise<AppResult<Uint8Array>>;
    create(request: PatentCreateRequest): Promise<AppResult<OpenedPatent>>;
    open(patentId: string): Promise<AppResult<OpenedPatent>>;
    openPath(path: string): Promise<AppResult<OpenedPatent>>;
    recover(patentId: string): Promise<AppResult<PatentRecoveryResult>>;
    updateSettings(request: PatentUpdateSettingsRequest): Promise<AppResult<PatentEditAck>>;
    updateDesignPatent?(
      request: PatentUpdateDesignPatentRequest,
    ): Promise<AppResult<PatentEditAck>>;
    setDrawingBooksEnabled(
      request: PatentSetDrawingBooksRequest,
    ): Promise<AppResult<PatentAggregateEditResult>>;
    applyBookEdit(request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>>;
    createAuxiliaryDocument?(
      request: PatentCreateAuxiliaryDocumentRequest,
    ): Promise<AppResult<PatentEditAck>>;
    applyAuxiliaryDocumentEdit?(
      request: PatentApplyAuxiliaryDocumentEditRequest,
    ): Promise<AppResult<PatentEditAck>>;
    renameAuxiliaryDocument?(
      request: PatentRenameAuxiliaryDocumentRequest,
    ): Promise<AppResult<PatentEditAck>>;
    moveAuxiliaryDocument?(
      request: PatentMoveAuxiliaryDocumentRequest,
    ): Promise<AppResult<PatentEditAck>>;
    deleteAuxiliaryDocument?(
      request: PatentDeleteAuxiliaryDocumentRequest,
    ): Promise<AppResult<PatentEditAck>>;
    applyFigureEdit(request: PatentApplyFigureEditRequest): Promise<AppResult<PatentEditAck>>;
    flush(request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>>;
    inspectResources?(
      request: PatentResourceInspectionRequest,
    ): Promise<AppResult<import("../patent-inspection/resource-health.js").ResourceHealthResult>>;
    cancelResourceInspection?(request: PatentResourceInspectionCancel): Promise<AppResult<void>>;
    prepareDocxImport?(
      request?: DocxImportPrepareRequest,
    ): Promise<AppResult<DocxImportPreview | null>>;
    getDocxImportPreviewAsset?(sessionId: string, assetId: string): Promise<AppResult<Uint8Array>>;
    updateDocxImport?(request: DocxImportUpdateRequest): Promise<AppResult<DocxImportPreview>>;
    commitDocxImport?(request: DocxImportCommitRequest): Promise<AppResult<OpenedPatent>>;
    cancelDocxImport?(request: DocxImportCancelRequest): Promise<AppResult<void>>;
    importPatdoc(): Promise<AppResult<OpenedPatent | null>>;
    exportPatdoc(request: PatentExportPatdocRequest): Promise<AppResult<SavedDocument | null>>;
    exportBundle?(
      request: import("./patent-bundle.js").PatentBundleExport,
    ): Promise<import("./patent-bundle.js").PatentBundleResult>;
    importBundle?(): Promise<import("./patent-bundle.js").PatentBundleResult>;
    moveToTrash(patentId: string): Promise<AppResult<void>>;
    restore(patentId: string): Promise<AppResult<void>>;
    permanentlyDelete(patentId: string): Promise<AppResult<void>>;
    purgeExpired(): Promise<AppResult<PatentPurgeResult>>;
    release(sessionId: string): Promise<AppResult<void>>;
  };
  patentTemplates: {
    readSummary(): Promise<AppResult<PatentTemplateLauncherSummary>>;
    readAuxiliary(): Promise<AppResult<PatentTemplateAuxiliaryCatalog>>;
    openEditor(
      request: PatentTemplateEditorOpenRequest,
    ): Promise<AppResult<PatentTemplateEditorSnapshot>>;
    captureCurrent(
      request: PatentTemplateCaptureCurrentRequest,
    ): Promise<AppResult<PatentTemplateCapturedBooks>>;
    saveEditor(
      request: PatentTemplateEditorSaveRequest,
    ): Promise<AppResult<PatentTemplateEditorSnapshot>>;
    closeEditor(request: PatentTemplateEditorCloseRequest): Promise<AppResult<void>>;
  };
  flowcharts: {
    list(patentId: string): Promise<AppResult<z.infer<typeof FlowchartProjectDescriptorSchema>[]>>;
    create(request: FlowchartCreateRequest): Promise<AppResult<FlowchartOpenedProject>>;
    importFile(request: FlowchartImportRequest): Promise<AppResult<FlowchartOpenedProject | null>>;
    load(request: FlowchartLoadRequest): Promise<AppResult<FlowchartOpenedProject>>;
    save(request: FlowchartSaveRequest): Promise<AppResult<FlowchartOpenedProject>>;
    rename(request: FlowchartRenameRequest): Promise<AppResult<FlowchartOpenedProject>>;
    duplicate(request: FlowchartDuplicateRequest): Promise<AppResult<FlowchartOpenedProject>>;
    delete(
      request: FlowchartDeleteRequest,
    ): Promise<AppResult<z.infer<typeof FlowchartDeleteResultSchema>>>;
    exportBackup(request: FlowchartLoadRequest): Promise<AppResult<Uint8Array>>;
    renderPreview(
      request: FlowchartRenderPreviewRequest,
    ): Promise<AppResult<FlowchartRenderPreview>>;
    commitPreview(
      request: FlowchartCommitPreviewRequest,
    ): Promise<AppResult<z.infer<typeof FlowchartCommitPreviewResultSchema>>>;
  };
  library: {
    list(scope: z.infer<typeof LibraryScopeSchema>): Promise<AppResult<LibraryDocumentSummary[]>>;
    create(): Promise<AppResult<OpenedLibraryDocument>>;
    open(libraryDocumentId: string): Promise<AppResult<OpenedLibraryDocument>>;
    rename(request: LibraryRenameRequest): Promise<AppResult<LibraryEditAck>>;
    applyEdit(batch: z.infer<typeof LibraryEditBatchSchema>): Promise<AppResult<LibraryEditAck>>;
    flush(request: LibraryFlushRequest): Promise<AppResult<LibraryFlushResult>>;
    moveToTrash(libraryDocumentId: string): Promise<AppResult<void>>;
    restore(libraryDocumentId: string): Promise<AppResult<void>>;
    permanentlyDelete(libraryDocumentId: string): Promise<AppResult<void>>;
    purgeExpired(): Promise<AppResult<LibraryPurgeResult>>;
    importPatdoc(): Promise<AppResult<OpenedLibraryDocument | null>>;
    exportPatdoc(request: LibraryExportPatdocRequest): Promise<AppResult<SavedDocument | null>>;
    emergencyExportPatdoc(
      request: LibraryEmergencyExportPatdocRequest,
    ): Promise<AppResult<SavedDocument | null>>;
    listLegacyDrafts(): Promise<AppResult<DraftSummary[]>>;
    importLegacyDraft(draftId: string): Promise<AppResult<OpenedLibraryDocument>>;
    release(sessionId: string): Promise<AppResult<void>>;
  };
  settings: {
    read(): Promise<AppResult<AppSettings>>;
    update(patch: AppSettingsPatch): Promise<AppResult<AppSettings>>;
  };
  aiCorrection: {
    hashText(text: AiTextHashRequest): Promise<AppResult<string>>;
    getSettings(): Promise<AppResult<AiCorrectionSettingsState>>;
    updateSettings(settings: AiCorrectionSettings): Promise<AppResult<AiCorrectionSettingsState>>;
    setApiKey(request: AiApiKeyRequest): Promise<AppResult<AiCorrectionSettingsState>>;
    clearApiKey(request: AiCorrectionProfileRequest): Promise<AppResult<AiCorrectionSettingsState>>;
    testConnection(request: AiCorrectionProfileRequest): Promise<AppResult<void>>;
    discoverModels(request: AiModelDiscoveryRequest): Promise<AppResult<AiModelDiscoveryResult>>;
    openProviderDocs(request: AiProviderDocsRequest): Promise<AppResult<void>>;
    start(request: AiCorrectionStartRequest): Promise<AppResult<AiCorrectionStartResult>>;
    cancel(request: AiCorrectionCancelRequest): Promise<AppResult<void>>;
    onEvent(listener: (event: AiCorrectionEvent) => void): () => void;
    polish(request: TextPolishStartRequest): Promise<AppResult<TextPolishStartResult>>;
    cancelPolish(request: TextPolishCancelRequest): Promise<AppResult<void>>;
    onPolishEvent(listener: (event: TextPolishEvent) => void): () => void;
    startConversation(
      request: TextPolishConversationStartRequest,
    ): Promise<AppResult<TextPolishConversationStartResult>>;
    sendConversation(
      request: TextPolishConversationSendRequest,
    ): Promise<AppResult<TextPolishConversationOperationResult>>;
    cancelConversation(request: TextPolishConversationCancelRequest): Promise<AppResult<void>>;
    resetConversation(
      request: TextPolishConversationResetRequest,
    ): Promise<AppResult<TextPolishConversationOperationResult>>;
    snapshotConversation(
      request: TextPolishConversationSnapshotRequest,
    ): Promise<AppResult<TextPolishConversationSnapshot>>;
    polishWorkspace(request: TextPolishWorkspaceRequest): Promise<AppResult<TextPolishWorkspace>>;
    onConversationEvent(listener: (event: TextPolishConversationEvent) => void): () => void;
  };
  exports: {
    flowchartPdf(
      request: z.infer<typeof FlowchartPdfRequestSchema>,
    ): Promise<AppResult<Uint8Array>>;
    docx(request: ExportRequest): Promise<AppResult<ExportReport | null>>;
    patentDocx(request: PatentDocxExportRequest): Promise<AppResult<ExportReport | null>>;
    patentPdf(request: PatentDocxExportRequest): Promise<AppResult<ExportReport | null>>;
    auxiliaryDocx(request: AuxiliaryDocumentExportRequest): Promise<AppResult<ExportReport | null>>;
    auxiliaryPdf(request: AuxiliaryDocumentExportRequest): Promise<AppResult<ExportReport | null>>;
    designPatent(
      request: DesignPatentExportRequest,
    ): Promise<AppResult<DesignPatentExportReport | null>>;
    pdf(request: ExportRequest): Promise<AppResult<ExportReport | null>>;
    preview(request: PrintPreviewRequest): Promise<AppResult<PrintPreview>>;
    savePreviewPdf(request: SavePreviewPdfRequest): Promise<AppResult<ExportReport | null>>;
    discardPreview(previewId: string): Promise<AppResult<void>>;
    listPrinters(): Promise<AppResult<PrinterDescriptor[]>>;
    openPrinterSettings(): Promise<AppResult<void>>;
    print(request: DirectPrintRequest): Promise<AppResult<void>>;
  };
  application: {
    storageOverview(): Promise<AppResult<z.infer<typeof StorageOverviewSchema>>>;
    relocateLibrary(): Promise<AppResult<boolean>>;
    openStorageFolder(kind: z.infer<typeof StorageFolderKindSchema>): Promise<AppResult<void>>;
    createDesktopShortcut(): Promise<AppResult<void>>;
    openOfficialWebsite?(
      id: import("../official-websites.js").OfficialWebsiteId,
    ): Promise<AppResult<void>>;
    legislation?(request: {
      id: import("../legislation.js").LegislationId;
      action: "source" | "save";
    }): Promise<AppResult<void>>;
    openThirdPartyNotices?(): Promise<AppResult<void>>;
    openThirdPartyLicensesFolder?(): Promise<AppResult<void>>;
    getWindowLayoutState(): Promise<AppResult<WindowLayoutState>>;
    prepareRecovery?(source: RecoverySource): Promise<AppResult<PreparedRecovery | null>>;
    activateRecovery?(token: string): Promise<AppResult<void>>;
    getStartupRecoveryReport?(): Promise<AppResult<StartupRecoveryReport>>;
    maximizeWindow(): Promise<AppResult<WindowLayoutState>>;
    setDualColumnWindow(
      input: z.infer<typeof DualColumnWindowRequestSchema>,
    ): Promise<AppResult<WindowLayoutState>>;
    onWindowLayoutStateChanged(listener: (state: WindowLayoutState) => void): () => void;
    onOpenPath(listener: (path: string) => void): () => void;
    onPrepareClose(listener: (token: string) => void): () => void;
    onBackgroundSave?(listener: (token: string) => void): () => void;
    backgroundSaveResult?(request: { token: string; ok: boolean }): Promise<AppResult<void>>;
    onTraySettings?(listener: () => void): () => void;
    readStartup?(): Promise<AppResult<import("../settings/startup.js").StartupState>>;
    updateStartup?(
      enabled: boolean,
    ): Promise<AppResult<import("../settings/startup.js").StartupState>>;
    closeResult(request: CloseResultRequest): Promise<AppResult<void>>;
    closeHeartbeat?(token: string): Promise<AppResult<void>>;
    requestQuit?(): Promise<AppResult<void>>;
    forceClose(): Promise<AppResult<void>>;
    reloadRenderer?(): Promise<AppResult<void>>;
    reportRendererFailure?(request: RendererFailureReport): Promise<AppResult<void>>;
  };
  menu: {
    onCommand(listener: (command: MenuCommand) => void): () => void;
  };
  backup: {
    status(): Promise<AppResult<BackupStatus>>;
    configure(
      settings: BackupConfigureRequest,
    ): Promise<AppResult<undefined | BackupMigrationReport>>;
    list(): Promise<AppResult<BackupEntry[]>>;
    restore(fileName: string): Promise<AppResult<BackupRestoreResult>>;
    delete(fileName: string): Promise<AppResult<void>>;
    selectFolder(): Promise<AppResult<string | null>>;
    ensureCurrent(target: z.infer<typeof BackupTargetSchema>): Promise<AppResult<BackupRunResult>>;
    finalize(): Promise<AppResult<BackupRunResult>>;
    operationStatus(): Promise<AppResult<BackupOperationStatus>>;
    cancelFinalization(): Promise<AppResult<void>>;
  };
  snapshot: {
    status(): Promise<AppResult<SnapshotStatus>>;
    configure(settings: SnapshotSettings): Promise<AppResult<void>>;
    list(documentType?: string, documentId?: string): Promise<AppResult<SnapshotListResult>>;
    create(request: SnapshotCreateRequest): Promise<AppResult<SnapshotCreationResult>>;
    preview(request: SnapshotContentPreviewRequest): Promise<AppResult<SnapshotContentPreview>>;
    previewAsset(request: SnapshotPreviewAssetRequest): Promise<AppResult<Uint8Array>>;
    restore(request: SnapshotRestoreRequest): Promise<AppResult<BackupRestoreResult>>;
    delete(request: SnapshotRestoreRequest): Promise<AppResult<SnapshotDeletionResult>>;
  };
}

export { AiCorrectionSettingsRequestSchema } from "../ai-correction/model.js";
