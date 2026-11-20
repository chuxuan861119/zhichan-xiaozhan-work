import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { APP_ERROR_PRESENTATIONS } from "../../shared/ipc/result.js";

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown | Promise<unknown>
  >();
  return {
    handlers,
    ownerWindow: {},
    sender: {},
    fromWebContents: vi.fn(),
    readText: vi.fn(() => "clipboard remains available"),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => join(tmpdir(), "patent-workbench-mutation-gate-test"),
    getVersion: () => "0.1.0",
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
  },
  clipboard: {
    readText: electron.readText,
    writeText: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: electron.showSaveDialog,
  },
  ipcMain: {
    removeHandler: (channel: string) => electron.handlers.delete(channel),
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => unknown | Promise<unknown>,
    ) => electron.handlers.set(channel, handler),
  },
  nativeImage: {
    createFromBitmap: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
  },
  safeStorage: {},
  shell: {
    openExternal: vi.fn(),
    writeShortcutLink: vi.fn(() => true),
  },
}));

import { IPC_CHANNELS, type IpcChannel } from "../../shared/ipc/contract.js";
import { getDataTransferOperationGate } from "../data-transfer/data-transfer-operation-gate.js";
import { registerLibraryIpcHandlers } from "../library/register-library-ipc.js";
import { MUTATING_IPC_CHANNELS } from "./mutating-channels.js";
import { registerIpcHandlers } from "./register-ipc.js";

const expectedMutatingChannels = [
  IPC_CHANNELS.cadPrepare,
  IPC_CHANNELS.applicationPrepareRecovery,
  IPC_CHANNELS.applicationActivateRecovery,
  IPC_CHANNELS.drawingsImport,
  IPC_CHANNELS.applicationRelocateLibrary,
  IPC_CHANNELS.applicationStartupUpdate,

  IPC_CHANNELS.chemistryRasterizePreview,
  IPC_CHANNELS.clipboardPaste,
  IPC_CHANNELS.documentsSave,
  IPC_CHANNELS.documentsSaveAs,
  IPC_CHANNELS.assetsChooseAndImport,
  IPC_CHANNELS.assetsChooseAndImportMany,
  IPC_CHANNELS.assetsImportBytes,
  IPC_CHANNELS.assetsImportMany,
  IPC_CHANNELS.assetsStageDesignEditorProject,
  IPC_CHANNELS.assetsStageReferences,
  IPC_CHANNELS.assetsDiscardImports,
  IPC_CHANNELS.draftsSave,
  IPC_CHANNELS.draftsDelete,
  IPC_CHANNELS.patentsCreate,
  IPC_CHANNELS.patentsOpenPath,
  IPC_CHANNELS.patentsRecover,
  IPC_CHANNELS.patentsUpdateSettings,
  IPC_CHANNELS.patentsUpdateDesignPatent,
  IPC_CHANNELS.exportsDesignPatent,
  IPC_CHANNELS.patentsSetDrawingBooksEnabled,
  IPC_CHANNELS.patentsApplyBookEdit,
  IPC_CHANNELS.patentsCreateAuxiliaryDocument,
  IPC_CHANNELS.patentsApplyAuxiliaryDocumentEdit,
  IPC_CHANNELS.patentsRenameAuxiliaryDocument,
  IPC_CHANNELS.patentsMoveAuxiliaryDocument,
  IPC_CHANNELS.patentsDeleteAuxiliaryDocument,
  IPC_CHANNELS.patentsApplyFigureEdit,
  IPC_CHANNELS.patentsFlush,
  IPC_CHANNELS.patentsPrepareDocxImport,
  IPC_CHANNELS.patentsUpdateDocxImport,
  IPC_CHANNELS.patentsCommitDocxImport,
  IPC_CHANNELS.patentsCancelDocxImport,
  IPC_CHANNELS.patentsImportPatdoc,
  IPC_CHANNELS.patentsExportPatdoc,
  IPC_CHANNELS.patentsExportBundle,
  IPC_CHANNELS.patentsExportFolder,
  IPC_CHANNELS.patentsImportBundle,
  IPC_CHANNELS.patentsTrash,
  IPC_CHANNELS.patentsRestore,
  IPC_CHANNELS.patentsPermanentDelete,
  IPC_CHANNELS.patentsPurge,
  IPC_CHANNELS.patentTemplatesSaveEditor,
  IPC_CHANNELS.flowchartsCreate,
  IPC_CHANNELS.flowchartsImport,
  IPC_CHANNELS.flowchartsSave,
  IPC_CHANNELS.flowchartsRename,
  IPC_CHANNELS.flowchartsDuplicate,
  IPC_CHANNELS.flowchartsDelete,
  IPC_CHANNELS.flowchartsCommitPreview,
  IPC_CHANNELS.libraryCreate,
  IPC_CHANNELS.libraryRename,
  IPC_CHANNELS.libraryApplyEdit,
  IPC_CHANNELS.libraryFlush,
  IPC_CHANNELS.libraryTrash,
  IPC_CHANNELS.libraryRestore,
  IPC_CHANNELS.libraryPermanentDelete,
  IPC_CHANNELS.libraryPurge,
  IPC_CHANNELS.libraryImportPatdoc,
  IPC_CHANNELS.libraryExportPatdoc,
  IPC_CHANNELS.libraryImportLegacyDraft,
  IPC_CHANNELS.settingsUpdate,
  IPC_CHANNELS.aiCorrectionUpdateSettings,
  IPC_CHANNELS.textPolishConversationStart,
  IPC_CHANNELS.textPolishConversationSend,
  IPC_CHANNELS.textPolishConversationCancel,
  IPC_CHANNELS.textPolishConversationReset,
  IPC_CHANNELS.textPolishWorkspace,
  IPC_CHANNELS.backupConfigure,
  IPC_CHANNELS.backupRestore,
  IPC_CHANNELS.backupEnsureCurrent,
  IPC_CHANNELS.backupFinalize,
  IPC_CHANNELS.backupCancelFinalization,
  IPC_CHANNELS.snapshotConfigure,
  IPC_CHANNELS.snapshotCreate,
  IPC_CHANNELS.snapshotRestore,
  IPC_CHANNELS.snapshotDelete,
  IPC_CHANNELS.dataTransferExportPackage,
  IPC_CHANNELS.dataTransferPrepareImport,
  IPC_CHANNELS.dataTransferCommitImport,
] as const satisfies readonly IpcChannel[];

const readOnlyOrTransferIndependentChannels = [
  // Standalone conversions/exports do not mutate the managed library.
  IPC_CHANNELS.cadConvert,
  IPC_CHANNELS.cadExport,
  IPC_CHANNELS.applicationCloseHeartbeat,
  IPC_CHANNELS.chemistryReadStructureSource,
  // Configure requests use runMutation inside the handler; queries remain available.
  IPC_CHANNELS.contentSearch,
  IPC_CHANNELS.contentSearchActivity,
  IPC_CHANNELS.drawingsReadSource,
  IPC_CHANNELS.drawingsCancelImport,
  IPC_CHANNELS.formulaDrawingsRender,
  IPC_CHANNELS.clipboardReadText,
  IPC_CHANNELS.clipboardWriteText,
  IPC_CHANNELS.backupOperationStatus,
  IPC_CHANNELS.documentsActivate,
  IPC_CHANNELS.documentsOpenDialog,
  IPC_CHANNELS.documentsOpenPath,
  IPC_CHANNELS.documentsRelease,
  IPC_CHANNELS.assetsGetPreview,
  IPC_CHANNELS.assetsProcessDesignImage,
  IPC_CHANNELS.clipboardReadImage,
  IPC_CHANNELS.clipboardWriteImage,
  IPC_CHANNELS.assetsChooseDesignFiles,
  IPC_CHANNELS.assetsPrepareDesignEditorSource,
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
  IPC_CHANNELS.exportsChooseDesignPatentDestination,
  IPC_CHANNELS.assetsCopyImages,
  IPC_CHANNELS.assetsSaveImage,
  IPC_CHANNELS.assetsSaveImages,
  IPC_CHANNELS.draftsList,
  IPC_CHANNELS.draftsOpen,
  IPC_CHANNELS.patentsList,
  IPC_CHANNELS.patentsOpen,
  IPC_CHANNELS.patentsRelease,
  IPC_CHANNELS.patentTemplatesReadSummary,
  IPC_CHANNELS.patentTemplatesReadAuxiliary,
  IPC_CHANNELS.patentTemplatesOpenEditor,
  IPC_CHANNELS.patentTemplatesCaptureCurrent,
  IPC_CHANNELS.patentTemplatesCloseEditor,
  IPC_CHANNELS.flowchartsList,
  IPC_CHANNELS.flowchartsLoad,
  IPC_CHANNELS.flowchartsExportBackup,
  IPC_CHANNELS.flowchartsRenderPreview,
  IPC_CHANNELS.flowchartsRenderPdf,
  IPC_CHANNELS.libraryList,
  IPC_CHANNELS.libraryOpen,
  IPC_CHANNELS.libraryEmergencyExportPatdoc,
  IPC_CHANNELS.libraryLegacyDrafts,
  IPC_CHANNELS.libraryRelease,
  IPC_CHANNELS.settingsRead,
  IPC_CHANNELS.aiCorrectionHashText,
  IPC_CHANNELS.aiCorrectionGetSettings,
  IPC_CHANNELS.aiCorrectionSetApiKey,
  IPC_CHANNELS.aiCorrectionClearApiKey,
  IPC_CHANNELS.aiCorrectionTestConnection,
  IPC_CHANNELS.aiCorrectionDiscoverModels,
  IPC_CHANNELS.aiCorrectionOpenProviderDocs,
  IPC_CHANNELS.aiCorrectionStart,
  IPC_CHANNELS.aiCorrectionCancel,
  IPC_CHANNELS.aiCorrectionEvent,
  IPC_CHANNELS.textPolishStart,
  IPC_CHANNELS.textPolishCancel,
  IPC_CHANNELS.textPolishEvent,
  IPC_CHANNELS.textPolishConversationSnapshot,
  IPC_CHANNELS.textPolishConversationEvent,
  IPC_CHANNELS.exportsDocx,
  IPC_CHANNELS.exportsPatentDocx,
  IPC_CHANNELS.exportsPatentPdf,
  IPC_CHANNELS.exportsAuxiliaryDocx,
  IPC_CHANNELS.exportsAuxiliaryPdf,
  IPC_CHANNELS.exportsPdf,
  IPC_CHANNELS.exportsPreview,
  IPC_CHANNELS.exportsSavePreviewPdf,
  IPC_CHANNELS.exportsDiscardPreview,
  IPC_CHANNELS.exportsListPrinters,
  IPC_CHANNELS.exportsOpenPrinterSettings,
  IPC_CHANNELS.exportsPrint,
  IPC_CHANNELS.applicationCreateDesktopShortcut,
  IPC_CHANNELS.tutorialRead,
  IPC_CHANNELS.tutorialReady,
  IPC_CHANNELS.tutorialLaunch,
  IPC_CHANNELS.tutorialPrepare,
  IPC_CHANNELS.drawingsReadTile,
  IPC_CHANNELS.patentsInspectResources,
  IPC_CHANNELS.patentsCancelResourceInspection,
  IPC_CHANNELS.agreementsRead,
  IPC_CHANNELS.agreementsAccept,
  IPC_CHANNELS.usageStatisticsRead,
  IPC_CHANNELS.usageStatisticsChoose,
  IPC_CHANNELS.usageStatisticsChanged,
  IPC_CHANNELS.updatesRead,
  IPC_CHANNELS.updatesStart,
  IPC_CHANNELS.updatesCheck,
  IPC_CHANNELS.updatesDismiss,
  IPC_CHANNELS.updatesOpenDownload,
  IPC_CHANNELS.updatesChanged,
  IPC_CHANNELS.applicationOpenOfficialWebsite,
  IPC_CHANNELS.applicationLegislation,
  IPC_CHANNELS.applicationOpenThirdPartyNotices,
  IPC_CHANNELS.applicationOpenThirdPartyLicensesFolder,
  IPC_CHANNELS.applicationStorageOverview,
  IPC_CHANNELS.applicationOpenStorageFolder,
  IPC_CHANNELS.applicationGetWindowLayoutState,
  IPC_CHANNELS.applicationGetStartupRecoveryReport,
  IPC_CHANNELS.applicationMaximizeWindow,
  IPC_CHANNELS.applicationWindowLayoutChanged,
  IPC_CHANNELS.applicationPrepareClose,
  IPC_CHANNELS.applicationRequestQuit,
  IPC_CHANNELS.applicationBackgroundSave,
  IPC_CHANNELS.applicationBackgroundSaveResult,
  IPC_CHANNELS.applicationTraySettings,
  IPC_CHANNELS.applicationStartupRead,
  IPC_CHANNELS.applicationCloseResult,
  IPC_CHANNELS.applicationDualColumnWindow,
  IPC_CHANNELS.applicationForceClose,
  IPC_CHANNELS.applicationReloadRenderer,
  IPC_CHANNELS.applicationReportRendererFailure,
  IPC_CHANNELS.applicationOpenPath,
  IPC_CHANNELS.menuCommand,
  IPC_CHANNELS.backupStatus,
  IPC_CHANNELS.backupList,
  IPC_CHANNELS.backupDelete,
  IPC_CHANNELS.backupSelectFolder,
  IPC_CHANNELS.snapshotStatus,
  IPC_CHANNELS.snapshotList,
  IPC_CHANNELS.snapshotPreview,
  IPC_CHANNELS.snapshotPreviewAsset,
  IPC_CHANNELS.dataTransferInspectLibrary,
  IPC_CHANNELS.dataTransferSelectExportDestination,
  IPC_CHANNELS.dataTransferSelectImportPackage,
  IPC_CHANNELS.dataTransferCancel,
  IPC_CHANNELS.dataTransferProgress,
  IPC_CHANNELS.drawingsImportProgress,
  IPC_CHANNELS.patentsGetDocxImportPreviewAsset,
  IPC_CHANNELS.patentsGetLibraryPreview,
  IPC_CHANNELS.ipcDataSaveReport,
  // AutomationHub gates library writes internally; ACK/revoke/cancel must remain available
  // while an existing admitted operation is draining or an exclusive operation is reserved.
  IPC_CHANNELS.automationControl,
  IPC_CHANNELS.automationEvent,
] as const satisfies readonly IpcChannel[];

function sorted(channels: Iterable<IpcChannel>): IpcChannel[] {
  return [...channels].sort();
}

async function invoke(channel: IpcChannel, input?: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  expect(handler, `missing IPC handler: ${channel}`).toBeTypeOf("function");
  electron.fromWebContents.mockReturnValue(electron.ownerWindow);
  return handler?.call({ marker: "electron-ipc-this" }, { sender: electron.sender }, input);
}

test("classifies every IPC channel exactly once with an explicit semantic allowlist", () => {
  expect(sorted(MUTATING_IPC_CHANNELS)).toEqual(sorted(expectedMutatingChannels));
  expect(
    expectedMutatingChannels.filter((channel) =>
      readOnlyOrTransferIndependentChannels.includes(channel as never),
    ),
  ).toEqual([]);
  expect(sorted([...expectedMutatingChannels, ...readOnlyOrTransferIndependentChannels])).toEqual(
    sorted(Object.values(IPC_CHANNELS)),
  );
});

test("the root register gates both root and library mutations but leaves reads available", async () => {
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ sensitive: "must not run" })),
  };
  registerIpcHandlers(undefined, undefined, {
    library,
    fileService: {},
    assetStore: {},
  } as never);

  const gate = getDataTransferOperationGate();
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exclusive = gate.runExclusive("full-data-export", async () => {
    markStarted();
    await hold;
  });
  await started;

  try {
    const secret = "D:\\clients\\secret-client-name.patdoc";
    const rootMutation = await invoke(IPC_CHANNELS.draftsDelete, secret);
    const libraryMutation = await invoke(IPC_CHANNELS.libraryCreate, { name: secret });

    expect(rootMutation).toMatchObject({
      ok: false,
      error: {
        code: "OPERATION_IN_PROGRESS",
        message: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.message,
        nextAction: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.nextAction,
        operationKind: "full-data-export",
      },
    });
    expect(libraryMutation).toMatchObject({
      ok: false,
      error: {
        code: "OPERATION_IN_PROGRESS",
        message: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.message,
        nextAction: APP_ERROR_PRESENTATIONS.OPERATION_IN_PROGRESS.nextAction,
        operationKind: "full-data-export",
      },
    });
    for (const result of [rootMutation, libraryMutation]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "OPERATION_IN_PROGRESS" },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("secret-client-name");
      expect(JSON.stringify(result)).not.toContain(IPC_CHANNELS.draftsDelete);
      expect(JSON.stringify(result)).not.toContain(IPC_CHANNELS.libraryCreate);
      expect(JSON.stringify(result)).not.toContain("DataTransferOperationError");
      expect(JSON.stringify(result)).not.toContain(".ts:");
    }
    expect(library.create).not.toHaveBeenCalled();
    await expect(invoke(IPC_CHANNELS.clipboardReadText)).resolves.toEqual({
      ok: true,
      value: "clipboard remains available",
    });
    await expect(invoke(IPC_CHANNELS.libraryList, "active")).resolves.toEqual({
      ok: true,
      value: [],
    });
  } finally {
    release();
    await exclusive;
  }
});

test("the root register gates data-transfer mutations through the global operation gate", async () => {
  const root = join(tmpdir(), "patent-workbench-data-transfer-gate-test");
  const dispose = registerIpcHandlers(undefined, undefined, {
    library: {},
    fileService: {},
    assetStore: {},
    dataTransferRuntime: {
      database: {},
      libraryRoot: join(root, "library"),
      userDataRoot: join(root, "user-data"),
      applicationDataRoot: join(root, "application-data"),
      accountProtector: {
        isAvailable: () => true,
        protect: (value: Uint8Array) => value,
        unprotect: (value: Uint8Array) => value,
      },
      backgroundScheduler: { suspend: async () => async () => undefined },
      assets: { waitForIdle: async () => ({ stagedSessionIds: [] }) },
      closeRuntime: async () => undefined,
    },
  } as never);
  const gate = getDataTransferOperationGate();
  const exclusiveSpy = vi.spyOn(gate, "runExclusive");
  await expect(invoke(IPC_CHANNELS.dataTransferCommitImport, {})).resolves.toMatchObject({
    ok: false,
  });
  expect(exclusiveSpy).toHaveBeenCalledWith("library-swap", expect.any(Function));
  exclusiveSpy.mockRestore();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const exclusive = gate.runExclusive("library-swap", async () => {
    started();
    await held;
  });
  await didStart;

  try {
    await expect(invoke(IPC_CHANNELS.dataTransferExportPackage, {})).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_IN_PROGRESS", operationKind: "library-swap" },
    });
  } finally {
    release();
    await exclusive;
    await dispose();
  }
});

test("a non-gate operation conflict does not fabricate a transfer operation kind", async () => {
  registerIpcHandlers();
  const document = createBlankDocument("ordinary operation conflict");
  const sessionId = "00000000-0000-4000-8000-000000000991";
  await invoke(IPC_CHANNELS.documentsActivate, { sessionId, documentId: document.documentId });

  let resolveDialog!: (value: { canceled: boolean; filePath: undefined }) => void;
  electron.showSaveDialog.mockImplementationOnce(
    async () =>
      await new Promise((resolve) => {
        resolveDialog = resolve;
      }),
  );
  const firstSave = invoke(IPC_CHANNELS.documentsSave, { sessionId, document, editorState: {} });
  await vi.waitFor(() => expect(electron.showSaveDialog).toHaveBeenCalledOnce());

  const overlap = await invoke(IPC_CHANNELS.documentsSave, {
    sessionId,
    document,
    editorState: {},
  });
  expect(overlap).toMatchObject({
    ok: false,
    error: { code: "OPERATION_IN_PROGRESS" },
  });
  expect(overlap).not.toHaveProperty("error.operationKind");

  resolveDialog({ canceled: true, filePath: undefined });
  await expect(firstSave).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});

test("read-only recovery reuses the unified mutation set", async () => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown | Promise<unknown>
  >();
  const flowcharts = { create: vi.fn() };
  registerLibraryIpcHandlers({
    register: (channel, handler) => handlers.set(channel, handler),
    readOnly: true,
    library: { list: vi.fn() } as never,
    flowcharts: flowcharts as never,
    fileService: {} as never,
    assetStore: {} as never,
    readPatentTemplates: vi.fn(),
  });

  const handler = handlers.get(IPC_CHANNELS.flowchartsCreate);
  await expect(handler?.({}, { sensitive: "not parsed" })).resolves.toMatchObject({
    ok: false,
    error: { code: "READ_ONLY_RECOVERY" },
  });
  expect(flowcharts.create).not.toHaveBeenCalled();
});
