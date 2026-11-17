import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { dialog, ipcMain } from "electron";
import { ZodError, type ZodType } from "zod";
import { APPLICATION_DOCUMENT_TYPE_NAME } from "../../shared/branding.js";
import { remapAssetIds } from "../../shared/document/asset-references.js";
import { defaultDocumentFont } from "../../shared/document/font-policy.js";
import {
  AssetReferenceRequestSchema,
  DocxImportCancelRequestSchema,
  DocxImportCommitRequestSchema,
  DocxImportPrepareRequestSchema,
  DocxImportUpdateRequestSchema,
  FlowchartCommitPreviewRequestSchema,
  FlowchartCreateRequestSchema,
  FlowchartDeleteRequestSchema,
  FlowchartDuplicateRequestSchema,
  FlowchartImportRequestSchema,
  FlowchartLoadRequestSchema,
  FlowchartRenameRequestSchema,
  FlowchartRenderPreviewRequestSchema,
  FlowchartSaveRequestSchema,
  IPC_CHANNELS,
  type IpcChannel,
  LibraryDocumentIdSchema,
  LibraryEditBatchSchema,
  LibraryEmergencyExportPatdocRequestSchema,
  LibraryExportPatdocRequestSchema,
  LibraryFlushRequestSchema,
  LibraryPatentIdSchema,
  LibraryRenameRequestSchema,
  LibraryScopeSchema,
  PatdocPathSchema,
  PatentApplyBookEditRequestSchema,
  PatentApplyFigureEditRequestSchema,
  PatentCreateRequestSchema,
  PatentExportPatdocRequestSchema,
  PatentFlushRequestSchema,
  PatentResourceInspectionCancelSchema,
  PatentResourceInspectionRequestSchema,
  PatentSetDrawingBooksRequestSchema,
  PatentUpdateSettingsRequestSchema,
  type SavedDocument,
  SessionIdSchema,
  StableIdSchema,
} from "../../shared/ipc/contract.js";
import { type AppErrorCode, type AppResult, normalizeAppError } from "../../shared/ipc/result.js";
import { withPatdocWorkspace } from "../../shared/patent/continuation.js";
import type { PatentType } from "../../shared/patent/model.js";
import {
  createFactoryPatentTemplates,
  type PatentTemplateSettings,
} from "../../shared/patent/templates.js";
import type { PersistentAssetStore, StoredAsset } from "../assets/asset-store.js";
import type { FileService, SavedPatdoc } from "../documents/file-service.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import { portablePatdocPayload } from "../documents/patdoc-transfer-scope.js";
import { DocxImportSessionError } from "../docx-import/docx-import-session-service.js";
import { FlowchartImportError } from "../flowcharts/flowchart-import-service.js";
import { FlowchartRenderError } from "../flowcharts/flowchart-render-service.js";
import type { FlowchartService } from "../flowcharts/flowchart-service.js";
import { SvgSanitizerError } from "../flowcharts/svg-sanitizer.js";
import { MUTATING_IPC_CHANNELS } from "../ipc/mutating-channels.js";
import {
  type OwnedDialogApi,
  type OwnedDialogEvent,
  showOwnedOpenDialog,
  showOwnedSaveDialog,
} from "../ipc/owned-native-dialog.js";
import type { SafeLogger } from "../logging/safe-log.js";
import type { LibraryService, OpenedLibraryDocument } from "./library-service.js";
import type { OpenedPatent, PatentService } from "./patent-service.js";
import type { PatentTemplateService } from "./patent-template-service.js";
import type { SnapshotService } from "./snapshot-service.js";

type RegisterHandler = (
  channel: string,
  handler: (event: unknown, input?: unknown) => unknown | Promise<unknown>,
) => void;

export type RegisterLibraryIpcOptions = {
  contentSearch?: import("../search/content-search-service.js").ContentSearchService;
  library: Pick<
    LibraryService,
    | "list"
    | "create"
    | "open"
    | "rename"
    | "applyEdit"
    | "flush"
    | "moveToTrash"
    | "restore"
    | "permanentlyDelete"
    | "purgeExpired"
    | "importDocument"
    | "replaceInitialDocument"
    | "release"
  >;
  patents?: Pick<
    PatentService,
    | "list"
    | "create"
    | "open"
    | "updateSettings"
    | "setDrawingBooksEnabled"
    | "applyBookEdit"
    | "applyFigureEdit"
    | "flush"
    | "loadForExport"
    | "moveToTrash"
    | "restore"
    | "permanentlyDelete"
    | "purgeExpired"
    | "release"
  > &
    Partial<
      Pick<
        PatentService,
        | "getLibraryPreview"
        | "hasImportedBundle"
        | "importBundle"
        | "requireActiveReadSession"
        | "inspectResources"
        | "cancelResourceInspection"
        | "loadSavedPatent"
        | "createAuxiliaryDocument"
        | "restorePatdocAttachments"
        | "restorePatdocHistory"
        | "appendImportedDocuments"
        | "applyAuxiliaryDocumentEdit"
        | "renameAuxiliaryDocument"
        | "deleteAuxiliaryDocument"
        | "moveAuxiliaryDocument"
        | "createImported"
      >
    >;
  patentTemplates?: Pick<
    PatentTemplateService,
    | "initialize"
    | "readSummary"
    | "readLauncherSummary"
    | "readAuxiliary"
    | "openEditor"
    | "capturePatent"
    | "saveEditor"
    | "closeEditor"
    | "resolveCreationSource"
  >;
  awaitPatentTemplatesReady?: () => Promise<void>;
  flowcharts?: Pick<
    FlowchartService,
    | "list"
    | "create"
    | "importExternal"
    | "load"
    | "save"
    | "rename"
    | "duplicate"
    | "delete"
    | "exportBackup"
    | "renderPreview"
    | "commitPreview"
  >;
  recovery?: {
    retryPatent(patentId: string): Promise<{ patentId: string; backupCreated: true }>;
  };
  fileService: Pick<FileService, "openDocument" | "saveDocument" | "openPatent" | "savePatent">;
  assetStore: PersistentAssetStore;
  snapshots?: Pick<
    SnapshotService,
    | "readFlowchartArchive"
    | "create"
    | "pruneAll"
    | "lastAutomaticSnapshotAt"
    | "open"
    | "list"
    | "delete"
    | "preview"
    | "previewAsset"
  > &
    Partial<Pick<SnapshotService, "prepareClose">>;
  readPatentTemplates(): Promise<PatentTemplateSettings>;
  legacyDraftMigration?: {
    listCandidates(): Promise<unknown[]>;
    importDraftResult(draftId: string): Promise<AppResult<OpenedLibraryDocument>>;
  };
  readOnly?: boolean;
  register?: RegisterHandler;
  dialog?: OwnedDialogApi;
  logger?: SafeLogger | undefined;
  onSessionOpened?(opened: OpenedLibraryDocument): Promise<void> | void;
  onPatentSessionOpened?(opened: OpenedPatent, event: unknown): Promise<void> | void;
  onPatentFigureEditCommitted?(
    sessionId: string,
    assetIds: readonly string[],
  ): Promise<void> | void;
  onPatentBookEditCommitted?(sessionId: string, assetIds: readonly string[]): Promise<void> | void;
  onSessionReleased?(sessionId: string): Promise<void> | void;
  authorizeOpenPath?(path: string): boolean;
  docxImports?: {
    prepare(
      ownerId: string,
      request?: import("../../shared/ipc/contract.js").DocxImportPrepareRequest,
    ): Promise<import("../../shared/ipc/contract.js").DocxImportPreview | null>;
    previewAsset(ownerId: string, sessionId: string, assetId: string): Promise<Uint8Array>;
    update(
      ownerId: string,
      request: import("../../shared/ipc/contract.js").DocxImportUpdateRequest,
    ): Promise<import("../../shared/ipc/contract.js").DocxImportPreview>;
    commit(
      ownerId: string,
      request: import("../../shared/ipc/contract.js").DocxImportCommitRequest,
    ): Promise<OpenedPatent>;
    cancel(
      ownerId: string,
      request: import("../../shared/ipc/contract.js").DocxImportCancelRequest,
    ): Promise<void>;
  };
};

type AppFailure = Extract<AppResult<never>, { ok: false }>;

function appFailure(code: AppErrorCode): AppFailure {
  return {
    ok: false,
    error: normalizeAppError({ code, message: "normalized" }),
  };
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function ipcFailure(error: unknown): AppFailure {
  if (error instanceof DocxImportSessionError) {
    if (error.code === "SESSION_NOT_FOUND" || error.code === "ASSET_NOT_FOUND") {
      return appFailure("NOT_FOUND");
    }
    if (error.code === "UNRECOGNIZED_DOCUMENT") return appFailure("DOCX_UNRECOGNIZED");
    if (error.code === "DUPLICATE_OFFICIAL_TARGET") return appFailure("DOCX_DUPLICATE_BOOK");
    if (error.code === "SESSION_FORBIDDEN") return appFailure("NO_PERMISSION");
    return appFailure("INVALID_INPUT");
  }

  if (error instanceof ZodError) return appFailure("INVALID_INPUT");
  if (error instanceof FlowchartImportError) {
    return appFailure(
      error.code === "CORRUPT_FILE" ||
        error.code === "UNSAFE_XML" ||
        error.code === "REMOTE_RESOURCE"
        ? "CORRUPT_FILE"
        : "INVALID_INPUT",
    );
  }
  if (error instanceof FlowchartRenderError) {
    if (error.code === "RENDER_BUSY") return appFailure("OPERATION_IN_PROGRESS");
    return appFailure(
      error.code === "PREVIEW_EXPIRED" ||
        error.code === "STALE_SOURCE" ||
        error.code === "STALE_TARGET"
        ? "REVISION_CONFLICT"
        : "INVALID_INPUT",
    );
  }
  if (error instanceof SvgSanitizerError) return appFailure("INVALID_INPUT");
  const code = nativeErrorCode(error);
  if (code === "PATDOC_CAPACITY_LIMIT" || code === "PATDOC_HISTORY_INCOMPLETE")
    return appFailure(code);
  if (code === "REVISION_CONFLICT") return appFailure("REVISION_CONFLICT");
  if (code === "LIBRARY_LOCKED") return appFailure("LIBRARY_LOCKED");
  if (code === "NOT_FOUND") return appFailure("NOT_FOUND");
  if (code === "INVALID_INPUT") return appFailure("INVALID_INPUT");
  if (code === "CORRUPT_FILE") return appFailure("CORRUPT_FILE");
  if (code === "READ_ONLY_RECOVERY") return appFailure("READ_ONLY_RECOVERY");
  if (code === "EACCES" || code === "EPERM") return appFailure("NO_PERMISSION");
  if (code === "EBUSY" || code === "ETXTBSY") return appFailure("FILE_LOCKED");
  if (code === "ENOSPC") return appFailure("DISK_FULL");
  return appFailure("INTERNAL");
}

function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  return schema.parse(input);
}

function requireNoInput(input: unknown): void {
  if (input !== undefined) throw new ZodError([]);
}

function rendererOwnerId(event: unknown): string {
  if (
    typeof event !== "object" ||
    event === null ||
    !("sender" in event) ||
    typeof event.sender !== "object" ||
    event.sender === null ||
    !("id" in event.sender) ||
    typeof event.sender.id !== "number"
  ) {
    throw new Error("Renderer identity is unavailable.");
  }
  return String(event.sender.id);
}

function ensurePatdocExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").endsWith(".patdoc") ? path : `${path}.patdoc`;
}

function safePatentFileName(name: string | null): string {
  const safe = [...(name ?? "未命名专利").replace(/[<>:"/\\|?*]/gu, "_")]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim();
  return `${safe || "未命名专利"}.patdoc`;
}

function resolvedCreationTemplates(
  options: Pick<RegisterLibraryIpcOptions, "patentTemplates">,
  patentType: PatentType,
): { templates: PatentTemplateSettings; templateAssetIds: string[] } {
  const source = options.patentTemplates?.resolveCreationSource(patentType);
  if (!source) throw new Error("Patent template catalog is unavailable.");
  const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
  templates.enabled = source.kind !== "blank";
  templates[patentType] = structuredClone(source.templates);
  // Only newly instantiated system templates adopt the platform default.
  // Custom templates and imported/existing documents retain their font names.
  if (source.kind === "system") {
    for (const kind of ["claims", "description", "abstract"] as const) {
      const book = templates[patentType][kind];
      for (const node of book.content) {
        if (node.type === "paragraph" || node.type === "heading")
          node.attrs.defaultFontFamily = defaultDocumentFont(process.platform);
      }
    }
  }
  return {
    templates,
    templateAssetIds: [...source.assetIds],
  };
}

function savedDocument(saved: SavedPatdoc, sessionId: string): SavedDocument {
  return { ...saved, sessionId };
}

async function logWithoutBlocking(operation: Promise<boolean> | undefined): Promise<void> {
  await operation?.catch(() => false);
}

async function ignoreReleaseFailure(operation: void | Promise<void>): Promise<void> {
  await Promise.resolve(operation).catch(() => undefined);
}

function uniqueAssetDescriptors(
  assets: readonly StoredAsset["descriptor"][],
): StoredAsset["descriptor"][] {
  const assetIds = new Set<string>();
  return assets.flatMap((asset) => {
    if (assetIds.has(asset.assetId)) return [];
    assetIds.add(asset.assetId);
    return [structuredClone(asset)];
  });
}

function remapImportedAssets(
  payload: PatdocPayload,
  installedAssets: Array<{ originalAssetId: string; descriptor: StoredAsset["descriptor"] }>,
): PatdocPayload["document"] {
  const assetIdMap = new Map(
    installedAssets.map((asset) => [asset.originalAssetId, asset.descriptor.assetId]),
  );
  const descriptorMap = new Map(
    installedAssets.map((asset) => [asset.originalAssetId, asset.descriptor]),
  );
  const document = remapAssetIds(payload.document, assetIdMap);
  document.assets = uniqueAssetDescriptors(
    payload.document.assets.map((asset) => descriptorMap.get(asset.assetId) ?? asset),
  );
  return document;
}

export async function importPatdocPayload(
  library: RegisterLibraryIpcOptions["library"],
  assetStore: PersistentAssetStore,
  payload: PatdocPayload,
): Promise<OpenedLibraryDocument> {
  const opened =
    payload.assets.length === 0
      ? await library.importDocument(payload.document, undefined, payload.editorState)
      : await library.create(payload.document.title);
  if (payload.assets.length === 0) return opened;
  try {
    const installedAssets = [];
    for (const asset of payload.assets) {
      const installed = await assetStore.install(
        { kind: "library-document", libraryDocumentId: opened.libraryDocumentId },
        asset,
      );
      installedAssets.push({
        originalAssetId: asset.descriptor.assetId,
        descriptor: installed.descriptor,
      });
    }
    const replaced = await library.replaceInitialDocument(
      opened.libraryDocumentId,
      remapImportedAssets(payload, installedAssets),
      remapAssetIds(
        payload.editorState,
        new Map(installedAssets.map((asset) => [asset.originalAssetId, asset.descriptor.assetId])),
      ),
    );
    await ignoreReleaseFailure(library.release(opened.sessionId));
    return replaced;
  } catch (error) {
    await ignoreReleaseFailure(library.release(opened.sessionId));
    await Promise.resolve(library.moveToTrash(opened.libraryDocumentId)).catch(() => undefined);
    await Promise.resolve(library.permanentlyDelete(opened.libraryDocumentId)).catch(
      () => undefined,
    );
    throw error;
  }
}

function remapPatentFlowchartIds(
  patent: PatentPatdocPayload["patent"],
  replacements: ReadonlyMap<string, { projectId: string; revision: number; sourceSha256: string }>,
): PatentPatdocPayload["patent"] {
  return {
    ...patent,
    figures: patent.figures.map((figure) => ({
      ...figure,
      flowchartLink: figure.flowchartLink
        ? (() => {
            const replacement = replacements.get(figure.flowchartLink.projectId);
            return replacement
              ? {
                  ...figure.flowchartLink,
                  projectId: replacement.projectId,
                  exportedProjectRevision: replacement.revision,
                  exportedSourceSha256: figure.flowchartLink.exportedSourceSha256,
                }
              : figure.flowchartLink;
          })()
        : undefined,
    })),
  };
}

export async function importPatentPatdocPayload(
  patents: NonNullable<RegisterLibraryIpcOptions["patents"]>,
  assetStore: PersistentAssetStore,
  readPatentTemplates: RegisterLibraryIpcOptions["readPatentTemplates"],
  payload: PatentPatdocPayload,
  flowcharts?: Pick<FlowchartService, "create">,
): Promise<OpenedPatent> {
  payload = portablePatdocPayload(payload);
  const shell = await patents.create({
    patentType: payload.patent.patentType,
    name: payload.patent.name,
    templates: await readPatentTemplates(),
  });
  try {
    let initialRevision = shell.revision;
    if (!payload.patent.drawingBooksEnabled) {
      const disabled = await patents.setDrawingBooksEnabled({
        patentId: shell.patentId,
        sessionId: shell.sessionId,
        expectedRevision: initialRevision,
        enabled: false,
      });
      initialRevision = disabled.patent.revision;
    }
    const replacements = new Map<string, string>();
    const descriptors = new Map<string, StoredAsset["descriptor"]>();
    for (const asset of payload.assets) {
      const installed = await assetStore.install(
        { kind: "patent", patentId: shell.patentId },
        asset,
      );
      replacements.set(asset.descriptor.assetId, installed.descriptor.assetId);
      descriptors.set(asset.descriptor.assetId, installed.descriptor);
    }
    const remapped = remapAssetIds(payload.patent, replacements);
    remapped.assets = uniqueAssetDescriptors(
      payload.patent.assets.map((asset) => descriptors.get(asset.assetId) ?? asset),
    );
    const settings = await patents.updateSettings({
      patentId: shell.patentId,
      expectedRevision: initialRevision,
      name: remapped.name,
      customer: remapped.customer,
      patentType: remapped.patentType,
      bookEdits: remapped.books.map((book) => ({
        bookKind: book.kind,
        document: book.document,
        editorState: book.editorState,
      })),
      assets: remapped.assets,
      referenceMarks: [...remapped.referenceMarks].sort(
        (left, right) => left.number - right.number,
      ),
      referenceMarkSettings: remapped.referenceMarkSettings,
    });
    let currentRevision = settings.revision;
    if (remapped.auxiliaryDocuments.length > 0 || remapped.docxImportReport !== null) {
      if (!patents.restorePatdocAttachments) {
        throw new Error("文档附件恢复服务不可用，已取消导入以避免丢失内容。");
      }
      const attachments = await patents.restorePatdocAttachments({
        patentId: shell.patentId,
        sessionId: shell.sessionId,
        expectedRevision: currentRevision,
        documents: remapped.auxiliaryDocuments,
        report: remapped.docxImportReport,
      });
      currentRevision = attachments.revision;
    }
    const flowchartIdReplacements = new Map<
      string,
      { projectId: string; revision: number; sourceSha256: string }
    >();
    const archivedSources = new Map(
      (payload.flowcharts ?? []).map((flowchart) => [flowchart.projectId, flowchart.source]),
    );
    if (remapped.flowchartProjects.length > 0 && !flowcharts) {
      throw Object.assign(new Error("流程图服务不可用，无法导入流程图源文件。"), {
        code: "INTERNAL",
      });
    }
    for (const project of remapped.flowchartProjects) {
      const source = archivedSources.get(project.projectId);
      if (!source || !flowcharts) {
        throw Object.assign(new Error("PATDOC 缺少流程图源文件。"), {
          code: "RESOURCE_MISMATCH",
        });
      }
      const imported = await flowcharts.create({
        patentId: shell.patentId,
        expectedPatentRevision: currentRevision,
        name: project.name,
        source,
        pageCount: project.pageCount,
        lastPageId: project.lastPageId,
      });
      flowchartIdReplacements.set(project.projectId, {
        projectId: imported.project.projectId,
        revision: imported.project.revision,
        sourceSha256: imported.project.sourceSha256,
      });
      currentRevision = imported.patentRevision;
    }
    const remappedWithFlowcharts = remapPatentFlowchartIds(remapped, flowchartIdReplacements);

    const figures =
      remappedWithFlowcharts.figures.length === 0 &&
      remappedWithFlowcharts.drawingProjects.length === 0
        ? { revision: currentRevision }
        : await patents.applyFigureEdit({
            patentId: shell.patentId,
            sessionId: shell.sessionId,
            expectedRevision: currentRevision,
            figures: remappedWithFlowcharts.figures,
            drawingProjects: remappedWithFlowcharts.drawingProjects,
            abstractDrawingFigureId: remappedWithFlowcharts.abstractDrawingFigureId,
            assets: remappedWithFlowcharts.assets,
          });
    const finalRevision = figures.revision;
    await patents.release(shell.sessionId);
    const opened = await patents.open(shell.patentId);
    if (opened.revision !== finalRevision) {
      throw Object.assign(new Error("Imported patent revision mismatch."), {
        code: "REVISION_CONFLICT",
      });
    }
    return opened;
  } catch (error) {
    await ignoreReleaseFailure(patents.release(shell.sessionId));
    await Promise.resolve(patents.moveToTrash(shell.patentId)).catch(() => undefined);
    // Failed imports remain in trash under the same recovery protection as other patents.
    throw error;
  }
}

export function registerLibraryIpcHandlers(options: RegisterLibraryIpcOptions): void {
  const register =
    options.register ??
    ((channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    });
  const selectedDialog = options.dialog ?? dialog;
  const readOnly = options.readOnly ?? false;

  const route = (
    channel: IpcChannel,
    handler: (input: unknown, event: unknown) => Promise<AppResult<unknown>> | AppResult<unknown>,
  ) => {
    register(channel, async (event, input) => {
      try {
        if (
          readOnly &&
          MUTATING_IPC_CHANNELS.has(channel) &&
          // These patent routes only verify saved revisions or write an external copy.
          // Keep their operation-gate classification so exports cannot race a library swap.
          channel !== IPC_CHANNELS.patentsFlush &&
          channel !== IPC_CHANNELS.patentsExportPatdoc
        ) {
          return appFailure("READ_ONLY_RECOVERY");
        }
        return await handler(input, event);
      } catch (error) {
        return ipcFailure(error);
      }
    });
  };

  route(IPC_CHANNELS.libraryList, async (input) => ({
    ok: true,
    value: await options.library.list(parseInput(LibraryScopeSchema, input)),
  }));
  if (options.patents) {
    route(IPC_CHANNELS.patentsInspectResources, async (input) => {
      if (!options.patents?.inspectResources) return appFailure("INTERNAL");
      return {
        ok: true,
        value: await options.patents.inspectResources(
          parseInput(PatentResourceInspectionRequestSchema, input),
        ),
      };
    });
    route(IPC_CHANNELS.patentsCancelResourceInspection, (input) => {
      options.patents?.cancelResourceInspection?.(
        parseInput(PatentResourceInspectionCancelSchema, input),
      );
      return { ok: true, value: undefined };
    });
    route(IPC_CHANNELS.patentsList, async (input) => ({
      ok: true,
      value: await options.patents?.list(parseInput(LibraryScopeSchema, input)),
    }));
    route(IPC_CHANNELS.patentsGetLibraryPreview, async (input) => {
      const getLibraryPreview = options.patents?.getLibraryPreview;
      if (!getLibraryPreview) return appFailure("INTERNAL");
      return {
        ok: true,
        value: await getLibraryPreview.call(
          options.patents,
          parseInput(LibraryPatentIdSchema, input),
        ),
      };
    });
    route(IPC_CHANNELS.patentsCreate, async (input, event) => {
      const request = parseInput(PatentCreateRequestSchema, input);
      await options.awaitPatentTemplatesReady?.();
      const resolved = resolvedCreationTemplates(options, request.patentType);
      const opened = await options.patents?.create({
        patentType: request.patentType,
        name: request.name,
        ...(request.customer !== undefined ? { customer: request.customer } : {}),
        templates: resolved.templates,
        ...(resolved.templateAssetIds.length > 0
          ? { templateAssetIds: resolved.templateAssetIds }
          : {}),
      });
      if (!opened) return appFailure("INTERNAL");
      await options.onPatentSessionOpened?.(opened, event);
      return { ok: true, value: opened };
    });
    route(IPC_CHANNELS.patentsOpen, async (input, event) => {
      const opened = await options.patents?.open(parseInput(LibraryPatentIdSchema, input));
      if (!opened) return appFailure("INTERNAL");
      await options.onPatentSessionOpened?.(opened, event);
      return { ok: true, value: opened };
    });
    route(IPC_CHANNELS.patentsOpenPath, async (input, event) => {
      const path = parseInput(PatdocPathSchema, input);
      if (!options.authorizeOpenPath?.(path)) return appFailure("NO_PERMISSION");
      const payload = await options.fileService.openPatent(path);
      if (!payload.ok) return payload;
      const patentService = options.patents;
      if (!patentService) return appFailure("INTERNAL");
      const imported = await importPatentPatdocPayload(
        patentService,
        options.assetStore,
        options.readPatentTemplates,
        payload.value,
        options.flowcharts,
      );
      await options.onPatentSessionOpened?.(imported, event);
      return { ok: true, value: imported };
    });
    route(IPC_CHANNELS.patentsRecover, async (input) => {
      if (!options.recovery) return appFailure("INTERNAL");
      return {
        ok: true,
        value: await options.recovery.retryPatent(parseInput(LibraryPatentIdSchema, input)),
      };
    });
    route(IPC_CHANNELS.patentsImportPatdoc, async (input, event) => {
      requireNoInput(input);
      const selection = await showOwnedOpenDialog(
        event as OwnedDialogEvent,
        {
          title: `导入${APPLICATION_DOCUMENT_TYPE_NAME}`,
          properties: ["openFile"],
          filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
        },
        selectedDialog,
      );
      const path = selection.filePaths[0];
      if (selection.canceled || !path) return { ok: true, value: null };
      const payload = await options.fileService.openPatent(path);
      if (!payload.ok) return payload;
      const patentService = options.patents;
      if (!patentService) return appFailure("INTERNAL");
      const imported = await importPatentPatdocPayload(
        patentService,
        options.assetStore,
        options.readPatentTemplates,
        payload.value,
        options.flowcharts,
      );
      await options.onPatentSessionOpened?.(imported, event);
      await logWithoutBlocking(
        options.logger?.log("info", {
          event: "patent.imported",
          patentId: imported.patentId,
          revision: imported.revision,
          path,
        }),
      );
      return { ok: true, value: imported };
    });
    route(IPC_CHANNELS.patentsExportPatdoc, async (input, event) => {
      const request = parseInput(PatentExportPatdocRequestSchema, input);
      await options.patents?.flush(request.patentId, request.expectedRevision);
      const opened = await options.patents?.open(request.patentId);
      if (!opened) return appFailure("INTERNAL");
      try {
        const selection = await showOwnedSaveDialog(
          event as OwnedDialogEvent,
          {
            title: `导出${APPLICATION_DOCUMENT_TYPE_NAME}`,
            defaultPath: safePatentFileName(request.suggestedName ?? opened.patent.name),
            filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
          },
          selectedDialog,
        );
        if (selection.canceled || !selection.filePath) return { ok: true, value: null };
        const assets = await Promise.all(
          opened.patent.assets.map((asset) => options.assetStore.readAsset(asset.assetId)),
        );

        if (opened.patent.flowchartProjects.length > 0 && !options.flowcharts) {
          throw new Error("流程图归档服务不可用，已取消导出以避免数据丢失。");
        }
        const flowcharts = options.flowcharts
          ? await Promise.all(
              opened.patent.flowchartProjects.map(async (project) => ({
                projectId: project.projectId,
                source: await options.flowcharts?.exportBackup(
                  opened.patent.patentId,
                  project.projectId,
                ),
              })),
            )
          : [];
        await options.patents?.flush(request.patentId, request.expectedRevision);
        const result = await options.fileService.savePatent(
          ensurePatdocExtension(selection.filePath),
          {
            patent: request.workspace
              ? withPatdocWorkspace(opened.patent, request.workspace)
              : opened.patent,
            assets,
            flowcharts: flowcharts.map((flowchart) => ({
              projectId: flowchart.projectId,
              source: flowchart.source as Uint8Array,
            })),
          },
        );
        if (!result.ok) return result;
        return { ok: true, value: savedDocument(result.value, opened.sessionId) };
      } finally {
        await ignoreReleaseFailure(options.patents?.release(opened.sessionId));
      }
    });
    route(IPC_CHANNELS.patentsUpdateSettings, async (input) => ({
      ok: true,
      value: await options.patents?.updateSettings(
        parseInput(PatentUpdateSettingsRequestSchema, input),
      ),
    }));
    route(IPC_CHANNELS.patentsSetDrawingBooksEnabled, async (input) => ({
      ok: true,
      value: await options.patents?.setDrawingBooksEnabled(
        parseInput(PatentSetDrawingBooksRequestSchema, input),
      ),
    }));
    route(IPC_CHANNELS.patentsApplyBookEdit, async (input) => {
      const request = parseInput(PatentApplyBookEditRequestSchema, input);
      const value = await options.patents?.applyBookEdit(request);
      await options.onPatentBookEditCommitted?.(
        request.sessionId,
        request.assets.map((asset) => asset.assetId),
      );
      return { ok: true, value };
    });
    for (const channel of [
      IPC_CHANNELS.patentsCreateAuxiliaryDocument,
      IPC_CHANNELS.patentsApplyAuxiliaryDocumentEdit,
      IPC_CHANNELS.patentsRenameAuxiliaryDocument,
      IPC_CHANNELS.patentsMoveAuxiliaryDocument,
      IPC_CHANNELS.patentsDeleteAuxiliaryDocument,
    ])
      route(channel, async () => ({
        ok: false,
        error: { code: "INVALID_INPUT", message: "其他文档功能已移除。" },
      }));
    route(IPC_CHANNELS.patentsApplyFigureEdit, async (input) => {
      const request = parseInput(PatentApplyFigureEditRequestSchema, input);
      const assetIds = request.assets.map((asset) => asset.assetId);
      // Do not discard stages on failure: the renderer save queue retries this exact edit.
      // Session release and startup reconciliation collect abandoned stages.
      const value = await options.patents?.applyFigureEdit(request);
      await options.onPatentFigureEditCommitted?.(request.sessionId, assetIds);
      return { ok: true, value };
    });
    route(IPC_CHANNELS.patentsFlush, async (input) => {
      const request = parseInput(PatentFlushRequestSchema, input);
      return {
        ok: true,
        value: await options.patents?.flush(request.patentId, request.expectedRevision),
      };
    });
    route(IPC_CHANNELS.patentsPrepareDocxImport, async (input, event) => {
      if (!options.docxImports) return appFailure("INTERNAL");
      const request = parseInput(DocxImportPrepareRequestSchema, input ?? {});
      return {
        ok: true,
        value: await options.docxImports.prepare(rendererOwnerId(event), request),
      };
    });
    route(IPC_CHANNELS.patentsGetDocxImportPreviewAsset, async (input, event) => {
      if (!options.docxImports) return appFailure("INTERNAL");
      const { sessionId, assetId } = parseInput(AssetReferenceRequestSchema, input);
      return {
        ok: true,
        value: await options.docxImports.previewAsset(rendererOwnerId(event), sessionId, assetId),
      };
    });
    route(IPC_CHANNELS.patentsUpdateDocxImport, async (input, event) => {
      if (!options.docxImports) return appFailure("INTERNAL");
      return {
        ok: true,
        value: await options.docxImports.update(
          rendererOwnerId(event),
          parseInput(DocxImportUpdateRequestSchema, input),
        ),
      };
    });
    route(IPC_CHANNELS.patentsCommitDocxImport, async (input, event) => {
      if (!options.docxImports) return appFailure("INTERNAL");
      const request = parseInput(DocxImportCommitRequestSchema, input);
      const opened = await options.docxImports.commit(rendererOwnerId(event), request);
      if (!request.appendTo) await options.onPatentSessionOpened?.(opened, event);
      return { ok: true, value: opened };
    });
    route(IPC_CHANNELS.patentsCancelDocxImport, async (input, event) => {
      if (!options.docxImports) return appFailure("INTERNAL");
      await options.docxImports.cancel(
        rendererOwnerId(event),
        parseInput(DocxImportCancelRequestSchema, input),
      );
      return { ok: true, value: undefined };
    });
    route(IPC_CHANNELS.patentsTrash, async (input) => {
      await options.patents?.moveToTrash(parseInput(LibraryPatentIdSchema, input));
      return { ok: true, value: undefined };
    });
    route(IPC_CHANNELS.patentsRestore, async (input) => {
      await options.patents?.restore(parseInput(LibraryPatentIdSchema, input));
      return { ok: true, value: undefined };
    });
    route(IPC_CHANNELS.patentsPermanentDelete, async (input) => {
      await options.patents?.permanentlyDelete(parseInput(LibraryPatentIdSchema, input));
      return { ok: true, value: undefined };
    });
    route(IPC_CHANNELS.patentsPurge, async (input) => {
      requireNoInput(input);
      return { ok: true, value: await options.patents?.purgeExpired() };
    });
    route(IPC_CHANNELS.patentsRelease, async (input) => {
      const sessionId = parseInput(SessionIdSchema, input);
      await options.onSessionReleased?.(sessionId);
      await options.patents?.release(sessionId);
      return { ok: true, value: undefined };
    });
  }
  if (options.flowcharts) {
    route(IPC_CHANNELS.flowchartsList, async (input) => ({
      ok: true,
      value: options.flowcharts?.list(parseInput(LibraryPatentIdSchema, input)),
    }));
    route(IPC_CHANNELS.flowchartsCreate, async (input) => ({
      ok: true,
      value: await options.flowcharts?.create(parseInput(FlowchartCreateRequestSchema, input)),
    }));
    route(IPC_CHANNELS.flowchartsImport, async (input, event) => {
      const request = parseInput(FlowchartImportRequestSchema, input);
      const selected = await showOwnedOpenDialog(
        event as OwnedDialogEvent,
        {
          title: "导入流程图",
          properties: ["openFile"],
          filters: [
            {
              name: "流程图和图片",
              extensions: ["drawio", "xml", "svg", "png", "jpg", "jpeg", "webp"],
            },
          ],
        },
        selectedDialog,
      );
      const path = selected.filePaths[0];
      if (selected.canceled || !path) return { ok: true, value: null };
      return {
        ok: true,
        value: await options.flowcharts?.importExternal({
          ...request,
          fileName: basename(path),
          bytes: await readFile(path),
        }),
      };
    });
    route(IPC_CHANNELS.flowchartsLoad, async (input) => {
      const request = parseInput(FlowchartLoadRequestSchema, input);
      return { ok: true, value: options.flowcharts?.load(request.patentId, request.projectId) };
    });
    route(IPC_CHANNELS.flowchartsSave, async (input) => ({
      ok: true,
      value: await options.flowcharts?.save(parseInput(FlowchartSaveRequestSchema, input)),
    }));
    route(IPC_CHANNELS.flowchartsRename, async (input) => ({
      ok: true,
      value: await options.flowcharts?.rename(parseInput(FlowchartRenameRequestSchema, input)),
    }));
    route(IPC_CHANNELS.flowchartsDuplicate, async (input) => ({
      ok: true,
      value: await options.flowcharts?.duplicate(
        parseInput(FlowchartDuplicateRequestSchema, input),
      ),
    }));
    route(IPC_CHANNELS.flowchartsDelete, async (input) => ({
      ok: true,
      value: await options.flowcharts?.delete(parseInput(FlowchartDeleteRequestSchema, input)),
    }));
    route(IPC_CHANNELS.flowchartsExportBackup, async (input) => {
      const request = parseInput(FlowchartLoadRequestSchema, input);
      return {
        ok: true,
        value: options.flowcharts?.exportBackup(request.patentId, request.projectId),
      };
    });
    route(IPC_CHANNELS.flowchartsRenderPreview, async (input) => ({
      ok: true,
      value: await options.flowcharts?.renderPreview(
        parseInput(FlowchartRenderPreviewRequestSchema, input),
      ),
    }));
    route(IPC_CHANNELS.flowchartsCommitPreview, async (input) => ({
      ok: true,
      value: await options.flowcharts?.commitPreview(
        parseInput(FlowchartCommitPreviewRequestSchema, input),
      ),
    }));
  }
  route(IPC_CHANNELS.libraryCreate, async (input) => {
    requireNoInput(input);
    const opened = await options.library.create();
    await options.onSessionOpened?.(opened);
    return { ok: true, value: opened };
  });
  route(IPC_CHANNELS.libraryOpen, async (input) => {
    const opened = await options.library.open(parseInput(LibraryDocumentIdSchema, input));
    await options.onSessionOpened?.(opened);
    return { ok: true, value: opened };
  });
  route(IPC_CHANNELS.libraryRename, async (input) => ({
    ok: true,
    value: await options.library.rename(parseInput(LibraryRenameRequestSchema, input)),
  }));
  route(IPC_CHANNELS.libraryApplyEdit, async (input) => ({
    ok: true,
    value: await options.library.applyEdit(parseInput(LibraryEditBatchSchema, input)),
  }));
  route(IPC_CHANNELS.libraryFlush, async (input) => {
    const request = parseInput(LibraryFlushRequestSchema, input);
    return {
      ok: true,
      value: await options.library.flush(request.libraryDocumentId, request.expectedRevision),
    };
  });
  route(IPC_CHANNELS.libraryTrash, async (input) => {
    await options.library.moveToTrash(parseInput(LibraryDocumentIdSchema, input));
    return { ok: true, value: undefined };
  });
  route(IPC_CHANNELS.libraryRestore, async (input) => {
    await options.library.restore(parseInput(LibraryDocumentIdSchema, input));
    return { ok: true, value: undefined };
  });
  route(IPC_CHANNELS.libraryPermanentDelete, async (input) => {
    await options.library.permanentlyDelete(parseInput(LibraryDocumentIdSchema, input));
    return { ok: true, value: undefined };
  });
  route(IPC_CHANNELS.libraryPurge, async (input) => {
    requireNoInput(input);
    return { ok: true, value: await options.library.purgeExpired() };
  });
  route(IPC_CHANNELS.libraryImportPatdoc, async (input, event) => {
    requireNoInput(input);
    const selection = await showOwnedOpenDialog(
      event as OwnedDialogEvent,
      {
        title: `导入${APPLICATION_DOCUMENT_TYPE_NAME}`,
        properties: ["openFile"],
        filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
      },
      selectedDialog,
    );
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return { ok: true, value: null };
    const opened = await options.fileService.openDocument(path);
    if (!opened.ok) return opened;
    const imported = await importPatdocPayload(options.library, options.assetStore, opened.value);
    await options.onSessionOpened?.(imported);
    await logWithoutBlocking(
      options.logger?.log("info", {
        event: "library.imported",
        libraryDocumentId: imported.libraryDocumentId,
        revision: imported.revision,
        path,
      }),
    );
    return { ok: true, value: imported };
  });
  route(IPC_CHANNELS.libraryExportPatdoc, async (input, event) => {
    const request = parseInput(LibraryExportPatdocRequestSchema, input);
    await options.library.flush(request.libraryDocumentId, request.expectedRevision);
    const opened = await options.library.open(request.libraryDocumentId);
    try {
      const selection = await showOwnedSaveDialog(
        event as OwnedDialogEvent,
        {
          title: `导出${APPLICATION_DOCUMENT_TYPE_NAME}`,
          defaultPath: `${opened.document.title}.patdoc`,
          filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
        },
        selectedDialog,
      );
      if (selection.canceled || !selection.filePath) return { ok: true, value: null };
      const assets = await Promise.all(
        opened.document.assets.map((asset) => options.assetStore.readAsset(asset.assetId)),
      );
      const result = await options.fileService.saveDocument(
        ensurePatdocExtension(selection.filePath),
        {
          document: opened.document,
          settings: {},
          editorState: opened.editorState,
          assets,
        },
      );
      if (!result.ok) return result;
      await logWithoutBlocking(
        options.logger?.log("info", {
          event: "library.edit_saved",
          libraryDocumentId: opened.libraryDocumentId,
          revision: opened.revision,
          path: result.value.path,
        }),
      );
      return { ok: true, value: savedDocument(result.value, opened.sessionId) };
    } finally {
      await ignoreReleaseFailure(options.library.release(opened.sessionId));
    }
  });
  route(IPC_CHANNELS.libraryEmergencyExportPatdoc, async (input, event) => {
    const request = parseInput(LibraryEmergencyExportPatdocRequestSchema, input);
    const selection = await showOwnedSaveDialog(
      event as OwnedDialogEvent,
      {
        title: `紧急导出${APPLICATION_DOCUMENT_TYPE_NAME}`,
        defaultPath: `${request.document.title}.patdoc`,
        filters: [{ name: APPLICATION_DOCUMENT_TYPE_NAME, extensions: ["patdoc"] }],
      },
      selectedDialog,
    );
    if (selection.canceled || !selection.filePath) return { ok: true, value: null };
    const assets = await Promise.all(
      request.document.assets.map((asset) => options.assetStore.readAsset(asset.assetId)),
    );
    const result = await options.fileService.saveDocument(
      ensurePatdocExtension(selection.filePath),
      {
        document: request.document,
        settings: {},
        editorState: request.editorState,
        assets,
      },
    );
    if (!result.ok) return result;
    return { ok: true, value: savedDocument(result.value, request.document.documentId) };
  });
  route(IPC_CHANNELS.libraryLegacyDrafts, async (input) => {
    requireNoInput(input);
    return { ok: true, value: await (options.legacyDraftMigration?.listCandidates() ?? []) };
  });
  route(IPC_CHANNELS.libraryImportLegacyDraft, async (input) => {
    const draftId = parseInput(StableIdSchema, input);
    if (!options.legacyDraftMigration) return appFailure("NOT_FOUND");
    const result = await options.legacyDraftMigration.importDraftResult(draftId);
    if (result.ok) await options.onSessionOpened?.(result.value);
    return result;
  });
  route(IPC_CHANNELS.libraryRelease, async (input) => {
    const sessionId = parseInput(SessionIdSchema, input);
    await options.onSessionReleased?.(sessionId);
    await options.library.release(sessionId);
    return { ok: true, value: undefined };
  });
}
