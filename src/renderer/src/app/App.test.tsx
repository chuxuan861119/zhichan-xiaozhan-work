import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../../../shared/ai-correction/model";
import { createBlankDocument } from "../../../shared/document/defaults";
import {
  type DraftSummary,
  ExportRequestSchema,
  type ImportedAsset,
  type OpenedLibraryDocument,
  type OpenedPatent,
  type PatentApi,
} from "../../../shared/ipc/contract";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { withPatdocWorkspace } from "../../../shared/patent/continuation";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { CanonicalPatent } from "../../../shared/patent/model";
import type { PatentTemplateEditorSnapshot } from "../../../shared/patent/template-catalog";
import { createFactoryPatentTemplates } from "../../../shared/patent/templates";
import { inspectPatent } from "../../../shared/patent/validation";
import type { PatentInspectionReport } from "../../../shared/patent-inspection/types";
import type { StartupRecoveryReport } from "../../../shared/recovery/startup-recovery";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { type DetailedSearchResult, searchPreparedChunks } from "../editor/find-replace";
import type { FindSearchRequest } from "../editor/find-search-task";
import { dualPaneZoomLimit } from "../patents/dual-pane-zoom-limit";
import { applyInspectionPatch, type InspectionRequest } from "../patents/inspection-protocol";
import * as appDialogs from "../shared/app-dialog";
import { App, resolveCorrectionEditor, resolvePatentCheckEditor } from "./App";
import { EditorCommandBus } from "./command-bus";

// App routing tests exercise the real print controller, not PDF.js workers/canvas.
vi.mock("../exports/pdf-page-renderer", () => ({
  createPdfPageRenderer: () => ({
    open: async () => ({ totalPages: 1 }),
    render: async () => ({
      pageNumber: 1,
      totalPages: 1,
      scale: 1,
      width: 420,
      height: 594,
      viewport: { width: 420, height: 594, scale: 1 },
    }),
    close: () => undefined,
  }),
}));

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom has no Worker; retain the real runner and inspection algorithm while
// emulating only asynchronous message delivery and termination.
class TestInspectionWorker {
  onmessage:
    | ((
        event: MessageEvent<{ id: number; report: PatentInspectionReport } | DetailedSearchResult>,
      ) => void)
    | null = null;
  private patent: CanonicalPatent | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(request: InspectionRequest | FindSearchRequest) {
    const snapshot = structuredClone(request);
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        if ("chunks" in snapshot) {
          this.onmessage?.(
            new MessageEvent("message", {
              data: searchPreparedChunks(snapshot.chunks, snapshot.query, snapshot.options),
            }),
          );
          return;
        }
        this.patent =
          snapshot.patent ??
          (snapshot.patch && this.patent
            ? applyInspectionPatch(this.patent, snapshot.patch)
            : null);
        if (!this.patent) throw new Error("Missing worker snapshot");
        const report = inspectPatent(this.patent, snapshot.mode);
        this.onmessage?.(new MessageEvent("message", { data: { id: snapshot.id, report } }));
      } catch (error) {
        this.onerror?.(new ErrorEvent("error", { error }));
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function openedLibraryDocument(title: string, index = 1): OpenedLibraryDocument {
  const document = createBlankDocument(title);
  document.documentId = testUuid(900 + index);
  return {
    libraryDocumentId: testUuid(100 + index),
    sessionId: testUuid(200 + index),
    revision: 0,
    document,
    editorState: {},
    saveState: "saved",
  };
}

function librarySummary(title: string, index = 1): LibraryDocumentSummary {
  return {
    libraryDocumentId: testUuid(100 + index),
    title,
    snippet: `${title} 摘要`,
    revision: index,
    saveState: "saved",
    createdAt: `2026-08-01T0${index}:00:00.000Z`,
    modifiedAt: `2026-08-01T0${index}:10:00.000Z`,
    deletedAt: null,
    quarantinedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

function patentSummary(name: string | null, index = 1): LibraryPatentSummary {
  return {
    patentId: testUuid(500 + index),
    name,
    customer: null,
    patentType: "utility-model",
    revision: index,
    bookStatuses: {
      claims: "draft",
      description: "draft",
      "description-drawings": "empty",
      abstract: "empty",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: `2026-08-01T0${index}:00:00.000Z`,
    modifiedAt: `2026-08-01T0${index}:10:00.000Z`,
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

function importedPatentImage(
  index: number,
  dimensions: { widthPx: number; heightPx: number } = { widthPx: 120, heightPx: 90 },
): ImportedAsset {
  return {
    descriptor: {
      assetId: testUuid(950 + index),
      kind: "image",
      originalName: `drawing-${index}.png`,
      mediaType: "image/png",
      extension: "png",
      byteLength: 10 + index,
      sha256: index.toString(16).toUpperCase().padStart(64, "0"),
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      previewByteLength: 5,
      previewSha256: (100 + index).toString(16).toUpperCase().padStart(64, "0"),
    },
    preview: Uint8Array.from([137, 80, 78, 71]),
  };
}

function appSettingsFixture(overrides: Partial<typeof DEFAULT_APP_SETTINGS> = {}) {
  return {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    welcomeCompleted: true,
    ...overrides,
  };
}

function patentTemplateEditorSnapshot(): PatentTemplateEditorSnapshot {
  const factory = createFactoryPatentTemplates(() => testUuid(990));
  const updatedAt = "2026-08-28T00:00:00.000Z";
  const slots = (patentType: "invention" | "utility-model") =>
    ([1, 2, 3] as const).map((slotIndex) => ({
      templateId: testUuid((patentType === "invention" ? 1000 : 1100) + slotIndex),
      patentType,
      slotIndex,
      name: `自定义模板 ${slotIndex}`,
      claims: null,
      description: null,
      abstract: null,
      unavailableReason: null,
      revision: 0,
      createdAt: updatedAt,
      updatedAt,
    }));

  return {
    sessionId: testUuid(1200),
    catalog: {
      revision: 0,
      invention: { selection: { kind: "system" }, slots: slots("invention") },
      "utility-model": {
        selection: { kind: "system" },
        slots: slots("utility-model"),
      },
    },
    auxiliary: {
      invention: {
        patentType: "invention",
        figureExplanation: factory.invention.figureExplanation,
        drawingLegend: factory.invention.drawingLegend,
        updatedAt,
      },
      "utility-model": {
        patentType: "utility-model",
        figureExplanation: factory["utility-model"].figureExplanation,
        drawingLegend: factory["utility-model"].drawingLegend,
        updatedAt,
      },
    },
  };
}

function openedPatent(name: string | null, index = 1): OpenedPatent {
  const patent = createBlankPatent({ patentType: "utility-model", name });
  patent.patentId = testUuid(500 + index);
  patent.books.forEach((book, bookIndex) => {
    book.bookId = testUuid(600 + index * 10 + bookIndex);
    book.document.documentId = testUuid(700 + index * 10 + bookIndex);
  });
  return {
    patentId: patent.patentId,
    sessionId: testUuid(800 + index),
    revision: 0,
    patent,
    saveState: "saved",
  };
}

function openedPatentWithPromotionalPhrase(name = "往复式夹具", index = 1): OpenedPatent {
  const opened = openedPatent(name, index);
  const description = opened.patent.books.find((book) => book.kind === "description");
  const paragraph = description?.document.content.find((block) => block.type === "paragraph");
  if (paragraph?.type === "paragraph") {
    paragraph.content = [{ type: "text", text: "世界领先技术", marks: [] }];
  }
  return opened;
}

test("switches books and waits for the target correction editor to register", async () => {
  const commandBus = new EditorCommandBus();
  const activateBook = vi.fn();
  const targetEditor = { isDestroyed: false, on: vi.fn(), off: vi.fn() } as never;
  const pending = resolveCorrectionEditor({
    commandBus,
    patentId: "patent-a",
    sessionId: "session-a",
    activeBookKind: "claims",
    targetBookKind: "description",
    activateBook,
  });
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });

  expect(activateBook).toHaveBeenCalledWith("patent-a", "description");
  await Promise.resolve();
  expect(resolved).toBe(false);

  commandBus.register("session-a:description", targetEditor);
  await expect(pending).resolves.toBe(targetEditor);
});

test("resolves the quick-check target editor and skips drawing books", async () => {
  const commandBus = new EditorCommandBus();
  const switchToBook = vi.fn();
  const targetEditor = { isDestroyed: false, on: vi.fn(), off: vi.fn() } as never;

  await expect(
    resolvePatentCheckEditor({
      commandBus,
      sessionId: "session-a",
      targetBookKind: "description-drawings",
      switchToBook,
    }),
  ).resolves.toBeNull();
  expect(switchToBook).toHaveBeenCalledTimes(1);

  const pending = resolvePatentCheckEditor({
    commandBus,
    sessionId: "session-a",
    targetBookKind: "description",
    switchToBook,
  });
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  commandBus.register("session-a:description", targetEditor);
  await expect(pending).resolves.toBe(targetEditor);
  expect(switchToBook).toHaveBeenCalledTimes(2);
});

const exportDocx = vi.fn();
const exportPatentDocx = vi.fn();
const exportPatentPdf = vi.fn();
const exportAuxiliaryDocx = vi.fn();
const exportAuxiliaryPdf = vi.fn();
const exportPdf = vi.fn();
const previewPdf = vi.fn();
const savePreviewPdf = vi.fn();
const discardPreview = vi.fn();
const printDocument = vi.fn();
const listPrinters = vi.fn();
const openPrinterSettings = vi.fn();
const openDialog = vi.fn();
const libraryList = vi.fn();
const libraryCreate = vi.fn();
const libraryOpen = vi.fn();
const libraryImportPatdoc = vi.fn();
const libraryApplyEdit = vi.fn();
const libraryFlush = vi.fn();
const libraryExportPatdoc = vi.fn();
const libraryRelease = vi.fn();
const libraryListLegacyDrafts = vi.fn();
const libraryImportLegacyDraft = vi.fn();
const libraryMoveToTrash = vi.fn();
const libraryRestore = vi.fn();
const libraryPermanentlyDelete = vi.fn();
const libraryRename = vi.fn();
const readSettings = vi.fn();
const updateSettings = vi.fn();
const createDesktopShortcut = vi.fn();
const getStartupRecoveryReport = vi.fn();
const inspectDataTransferLibrary = vi.fn();
const selectDataTransferImportPackage = vi.fn();
const prepareDataTransferImport = vi.fn();
const commitDataTransferImport = vi.fn();
const getWindowLayoutState = vi.fn();
const maximizeWindow = vi.fn();
function useWideDualViewWindow() {
  // Docking is only expected when the two full pages and rails actually fit.
  const layout = {
    isMaximized: true,
    contentWidth: 2560,
    contentHeight: 1440,
    displayWidthMm: 600,
  };
  getWindowLayoutState.mockResolvedValue({ ok: true, value: layout });
  maximizeWindow.mockResolvedValue({ ok: true, value: layout });
}
const onWindowLayoutStateChanged = vi.fn();
const snapshotCreate = vi.fn();
let windowLayoutListener:
  | ((layout: { isMaximized: boolean; contentWidth: number; contentHeight: number }) => void)
  | null = null;

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  // Saving/restoring editor selection uses browser range geometry, absent in jsdom.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  for (const format of ["zip", "patdoc", "docx"]) {
    localStorage.removeItem(`patent-workbench:import-notice:${format}:v1`);
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("Worker", TestInspectionWorker);
  document.documentElement.classList.remove("patent-book-view-transition");
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => void) => {
      update();
      return { finished: Promise.resolve() } as ViewTransition;
    },
  });
  exportDocx.mockReset().mockResolvedValue({
    ok: true,
    value: {
      format: "docx",
      outputPath: "C:\\exports\\文档 1.docx",
      issues: [],
    },
  });
  exportPatentDocx.mockReset().mockResolvedValue({
    ok: true,
    value: {
      format: "docx",
      outputPath: "C:\\exports\\五书合并导出.docx",
      issues: [],
    },
  });
  exportPatentPdf.mockReset().mockResolvedValue({
    ok: true,
    value: {
      format: "pdf",
      outputPath: "C:\\exports\\五书合并导出.pdf",
      issues: [],
    },
  });
  exportAuxiliaryDocx.mockReset().mockResolvedValue({
    ok: true,
    value: {
      format: "docx",
      outputPath: "C:\\exports\\往复式夹具-实验记录.docx",
      issues: [],
    },
  });
  exportAuxiliaryPdf.mockReset().mockResolvedValue({
    ok: true,
    value: {
      format: "pdf",
      outputPath: "C:\\exports\\往复式夹具-实验记录.pdf",
      issues: [],
    },
  });
  openDialog.mockReset().mockResolvedValue({ ok: true, value: null });
  libraryList.mockReset().mockImplementation(async (scope: "active" | "trash") => ({
    ok: true,
    value:
      scope === "active" ? [librarySummary("传动机构", 2), librarySummary("往复式夹具", 1)] : [],
  }));
  libraryCreate.mockReset().mockResolvedValue({
    ok: true,
    value: openedLibraryDocument("文档 1", 1),
  });
  libraryOpen.mockReset().mockImplementation(async (libraryDocumentId: string) => {
    const index = libraryDocumentId === testUuid(102) ? 2 : 1;
    return {
      ok: true,
      value: openedLibraryDocument(index === 2 ? "传动机构" : "往复式夹具", index),
    };
  });
  libraryImportPatdoc.mockReset().mockResolvedValue({ ok: true, value: null });
  libraryApplyEdit.mockReset().mockImplementation(async (batch) => ({
    ok: true,
    value: {
      libraryDocumentId: batch.libraryDocumentId,
      operationId: batch.operationId,
      revision: batch.targetRevision,
      savedAt: "2026-08-01T08:00:00.000Z",
    },
  }));
  libraryFlush.mockReset().mockImplementation(async (request) => ({
    ok: true,
    value: {
      libraryDocumentId: request.libraryDocumentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-01T08:00:01.000Z",
    },
  }));
  libraryExportPatdoc.mockReset().mockResolvedValue({ ok: true, value: null });
  libraryRelease.mockReset().mockResolvedValue({ ok: true, value: undefined });
  libraryListLegacyDrafts.mockReset().mockResolvedValue({ ok: true, value: [] });
  libraryImportLegacyDraft.mockReset().mockResolvedValue({
    ok: true,
    value: openedLibraryDocument("旧草稿", 4),
  });
  libraryMoveToTrash.mockReset().mockResolvedValue({ ok: true, value: undefined });
  libraryRestore.mockReset().mockResolvedValue({ ok: true, value: undefined });
  libraryPermanentlyDelete.mockReset().mockResolvedValue({ ok: true, value: undefined });
  libraryRename.mockReset().mockImplementation(async (request) => ({
    ok: true,
    value: {
      libraryDocumentId: request.libraryDocumentId,
      operationId: request.operationId,
      revision: request.expectedRevision + 1,
      savedAt: "2026-08-01T08:00:00.000Z",
    },
  }));
  exportPdf.mockReset().mockResolvedValue({
    ok: true,
    value: { format: "pdf", outputPath: "C:\\exports\\文档 1.pdf", issues: [] },
  });
  previewPdf.mockReset().mockResolvedValue({
    ok: true,
    value: {
      previewId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
      bytes: Uint8Array.from([37, 80, 68, 70, 45]),
    },
  });
  savePreviewPdf.mockReset().mockResolvedValue({
    ok: true,
    value: { format: "pdf", outputPath: "C:\\exports\\文档 1.pdf", issues: [] },
  });
  discardPreview.mockReset().mockResolvedValue({ ok: true, value: undefined });
  printDocument.mockReset().mockResolvedValue({ ok: true, value: undefined });
  listPrinters.mockReset().mockResolvedValue({ ok: true, value: [] });
  openPrinterSettings.mockReset().mockResolvedValue({ ok: true, value: undefined });
  readSettings.mockReset().mockResolvedValue({
    ok: true,
    value: appSettingsFixture(),
  });
  updateSettings.mockReset().mockResolvedValue({
    ok: true,
    value: appSettingsFixture(),
  });
  createDesktopShortcut.mockReset().mockResolvedValue({ ok: true, value: undefined });
  getStartupRecoveryReport.mockReset().mockResolvedValue({
    ok: true,
    value: {
      previousShutdown: "clean",
      mode: "read-write",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      dataImportRecovery: "none",
      checkedAt: "2026-08-17T00:00:00.000Z",
    } satisfies StartupRecoveryReport,
  });
  inspectDataTransferLibrary.mockReset().mockResolvedValue({
    ok: true,
    value: {
      empty: true,
      blockers: [],
      summary: {
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 0,
      },
    },
  });
  selectDataTransferImportPackage.mockReset().mockResolvedValue({ ok: true, value: null });
  prepareDataTransferImport.mockReset();
  commitDataTransferImport.mockReset();
  const maximizedLayout = { isMaximized: true, contentWidth: 1920, contentHeight: 900 };
  getWindowLayoutState.mockReset().mockResolvedValue({ ok: true, value: maximizedLayout });
  maximizeWindow.mockReset().mockResolvedValue({ ok: true, value: maximizedLayout });
  windowLayoutListener = null;
  onWindowLayoutStateChanged.mockReset().mockImplementation((listener) => {
    windowLayoutListener = listener;
    return vi.fn();
  });
  snapshotCreate.mockReset().mockResolvedValue({
    ok: true,
    value: {
      outcome: "created",
      revision: 0,
      createdAt: "2026-08-16T08:00:00.000Z",
      source: "manual-save",
    },
  });
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      dataTransfer: {
        inspectLibrary: inspectDataTransferLibrary,
        selectExportDestination: vi.fn(async () => ({ ok: true as const, value: null })),
        exportPackage: vi.fn(),
        selectImportPackage: selectDataTransferImportPackage,
        prepareImport: prepareDataTransferImport,
        commitImport: commitDataTransferImport,
        cancel: vi.fn(async () => ({ ok: true as const, value: undefined })),
        onProgress: vi.fn(() => vi.fn()),
      },
      aiCorrection: {
        getSettings: vi.fn(async () => ({
          ok: true as const,
          value: {
            settings: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
            credentialProfileIds: [],
          },
        })),
        onEvent: vi.fn(() => vi.fn()),
      },
      settings: {
        read: readSettings,
        update: updateSettings,
      },
      patentTemplates: {
        readSummary: vi.fn(async () => ({
          ok: true as const,
          value: {
            invention: { selection: { kind: "system" as const }, selectedTemplateName: null },
            "utility-model": {
              selection: { kind: "system" as const },
              selectedTemplateName: null,
            },
          },
        })),
        openEditor: vi.fn(async () => ({
          ok: true as const,
          value: patentTemplateEditorSnapshot(),
        })),
        captureCurrent: vi.fn(),
        saveEditor: vi.fn(),
        closeEditor: vi.fn(async () => ({ ok: true as const, value: undefined })),
        readAuxiliary: vi.fn(),
      },

      documents: {
        activate: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        openDialog,
        openPath: vi.fn(),
        save: vi.fn(),
        saveAs: vi.fn(),
        release: vi.fn(),
      },
      library: {
        list: libraryList,
        create: libraryCreate,
        open: libraryOpen,
        rename: libraryRename,
        applyEdit: libraryApplyEdit,
        flush: libraryFlush,
        moveToTrash: libraryMoveToTrash,
        restore: libraryRestore,
        permanentlyDelete: libraryPermanentlyDelete,
        purgeExpired: vi.fn(),
        importPatdoc: libraryImportPatdoc,
        exportPatdoc: libraryExportPatdoc,
        emergencyExportPatdoc: vi.fn(),
        listLegacyDrafts: libraryListLegacyDrafts,
        importLegacyDraft: libraryImportLegacyDraft,
        release: libraryRelease,
      },
      assets: {
        chooseAndImport: vi.fn().mockResolvedValue({ ok: true, value: null }),
        chooseAndImportMany: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        importBytes: vi.fn(),
        getPreview: vi.fn(),
      },
      exports: {
        docx: exportDocx,
        patentDocx: exportPatentDocx,
        patentPdf: exportPatentPdf,
        auxiliaryDocx: exportAuxiliaryDocx,
        auxiliaryPdf: exportAuxiliaryPdf,
        pdf: exportPdf,
        preview: previewPdf,
        savePreviewPdf,
        discardPreview,
        listPrinters,
        openPrinterSettings,
        print: printDocument,
      },
      application: {
        createDesktopShortcut,
        getStartupRecoveryReport,
        getWindowLayoutState,
        maximizeWindow,
        onWindowLayoutStateChanged,
        onOpenPath: vi.fn(() => vi.fn()),
        onPrepareClose: vi.fn(() => vi.fn()),
        closeResult: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        forceClose: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
      snapshot: {
        status: vi.fn(),
        configure: vi.fn(),
        list: vi.fn(),
        create: snapshotCreate,
        preview: vi.fn(),
        previewAsset: vi.fn(),
        restore: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as PatentApi,
  });
  vi.spyOn(appDialogs, "showAppAlert")
    .mockClear()
    .mockImplementation(() => undefined);
  vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
  vi.spyOn(appDialogs, "promptAppText").mockImplementation(async (_message, value) =>
    String(value ?? ""),
  );
});

function legacyDraft(name: string): DraftSummary {
  return {
    draftId: "legacy-draft",
    documentId: "legacy-draft",
    displayName: name,
    originalPath: null,
    savedAt: "2026-08-01T02:07:04.000Z",
  };
}

async function createDocumentFromLibrary(user: ReturnType<typeof userEvent.setup>) {
  const buttons = await screen.findAllByRole("button", { name: "新建文档" });
  const button = buttons[buttons.length - 1];
  if (!button) throw new Error("missing new document button");
  await user.click(button);
  await screen.findByRole("tab", { name: /文档 1/u });
}

async function openPatentFromLibrary(
  user: ReturnType<typeof userEvent.setup>,
  patentName = "往复式夹具",
) {
  if (!screen.queryByRole("article", { name: patentName })) {
    for (const group of await screen.findAllByRole("button", { name: /\d{4}年\d{1,2}月/u })) {
      if (group.getAttribute("aria-expanded") === "false") await user.click(group);
    }
  }
  const card = await screen.findByRole("article", { name: patentName });
  await user.click(within(card).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "继续编辑" }));
}

async function dragPatentTabToWorkspace(tab: HTMLElement, pane: "left" | "right") {
  return dragPatentTabToRegion(tab, pane, screen.getByTestId("patent-workspace-drop-region"));
}

/** 内嵌 CAD标号/流程图 独占单屏时，落点区域改为主视图容器而不是被隐藏的标准工作区。 */
async function dragPatentTabToRegion(
  tab: HTMLElement,
  pane: "left" | "right",
  region: HTMLElement,
) {
  region.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 160,
      left: 0,
      top: 160,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 640,
      toJSON: () => ({}),
    }) as DOMRect;
  tab.getBoundingClientRect = () =>
    ({
      x: 120,
      y: 70,
      left: 120,
      top: 70,
      right: 218,
      bottom: 100,
      width: 98,
      height: 30,
      toJSON: () => ({}),
    }) as DOMRect;
  const clientX = pane === "left" ? 300 : 900;
  fireEvent.pointerDown(tab, { pointerId: 41, button: 0, clientX: 150, clientY: 85 });
  fireEvent.pointerMove(window, { pointerId: 41, buttons: 1, clientX, clientY: 400 });
  await screen.findByTestId(`workspace-tab-drop-${pane}`);
  fireEvent.pointerUp(window, { pointerId: 41, clientX, clientY: 400 });
}

function paneTitle(pane: HTMLElement, side: "左" | "右"): string {
  return within(pane).getAllByRole("button", { name: `切换${side}侧文档` })[0]?.textContent ?? "";
}

async function deletePatentFromLibrary(
  user: ReturnType<typeof userEvent.setup>,
  patentName = "往复式夹具",
) {
  const card = await screen.findByRole("article", { name: patentName });
  await user.click(within(card).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除" }));
}

async function chooseToolbarExport(
  user: ReturnType<typeof userEvent.setup>,
  format: "DOCX" | "PDF" | "PATDOC",
) {
  await user.click(await screen.findByRole("button", { name: "导出" }));
  await user.click(
    screen.getByRole("menuitem", {
      name: new RegExp(`^导出(?: ${format}|当前文档（${format}）)$`),
    }),
  );
}

function formatModifiedAt(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

test("starts in the library and opens two selected documents as tabs", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole("heading", { name: "文档库" })).toBeDefined();
  expect(libraryCreate).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "继续编辑 往复式夹具" }));
  await user.click(screen.getByRole("tab", { name: "文档库" }));
  await user.click(screen.getByRole("button", { name: "继续编辑 传动机构" }));

  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(tabs[0]?.textContent).toContain("文档库");
  expect(libraryOpen).toHaveBeenCalledWith(testUuid(101));
  expect(libraryOpen).toHaveBeenCalledWith(testUuid(102));
});

test("offers copy-first legacy draft migration from the library screen", async () => {
  const user = userEvent.setup();
  libraryListLegacyDrafts.mockResolvedValue({
    ok: true,
    value: [legacyDraft("未命名-20260801-020704")],
  });
  render(<App />);

  const dialog = await screen.findByRole("dialog", { name: "旧草稿迁移" });
  expect(within(dialog).getByText("未命名-20260801-020704")).toBeDefined();
  await user.click(within(dialog).getByRole("button", { name: "导入选中的旧草稿" }));

  expect(libraryImportLegacyDraft).toHaveBeenCalledWith("legacy-draft");
  expect(await screen.findByRole("tab", { name: /旧草稿/u })).toBeDefined();
});

test("renders the five-level workbench shell", async () => {
  render(<App />);
  expect(await screen.findByTestId("app-shell")).toBeDefined();
  expect(screen.getByRole("tablist", { name: "打开的文档" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "文档库" })).toBeDefined();
  expect(screen.getByRole("navigation", { name: "主菜单" })).toBeDefined();
  expect(screen.queryByRole("toolbar", { name: "常用工具" })).toBeNull();
  expect(screen.getByRole("main", { name: "文档库" })).toBeDefined();
  expect(screen.queryByText("持续保存已开启")).toBeNull();
});

test.each([50, 90, 125, 200])(
  "starts at 100 percent despite a saved zoom of %s",
  async (savedZoom) => {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    readSettings.mockResolvedValue({
      ok: true,
      value: appSettingsFixture({ zoomPercent: savedZoom }),
    });
    render(<App />);
    await screen.findByRole("main", { name: "专利库" });
    await openPatentFromLibrary(user);
    expect(screen.getByRole("button", { name: "缩放 100%，点击重置" })).toBeDefined();
  },
);

test("late startup settings cannot overwrite a zoom already chosen in this session", async () => {
  let finishRead!: (result: { ok: true; value: typeof DEFAULT_APP_SETTINGS }) => void;
  const pendingRead = new Promise((resolve) => {
    finishRead = resolve;
  });
  readSettings.mockReturnValue(pendingRead);
  render(<App />);
  await waitFor(() => expect(readSettings).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "缩放 100%，点击重置" })).toBeDefined();
  fireEvent.keyDown(window, { key: "=", ctrlKey: true });
  expect(screen.getByRole("button", { name: "缩放 110%，点击重置" })).toBeDefined();
  await act(async () => {
    finishRead({ ok: true, value: appSettingsFixture({ zoomPercent: 125 }) });
  });
  expect(screen.getByRole("button", { name: "缩放 110%，点击重置" })).toBeDefined();
});

test.each(["ready", "failed", "cancelled"] as const)(
  "restores explicit PATDOC pane zooms with %s window preparation",
  async (outcome) => {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    const opened = openedPatent("往复式夹具", 1);
    opened.patent = withPatdocWorkspace(opened.patent, {
      version: 1,
      activeBookKind: "description",
      zoomPercent: 110,
      columns: false,
      columnZoomPercent: 100,
      dual: {
        left: { bookKind: "claims", zoomPercent: 65 },
        right: { bookKind: "description", zoomPercent: 75 },
        activePane: "right",
      },
      books: [],
      aiCorrectionOpen: false,
      assistantOpen: false,
    });
    window.patentApi.patents.open = vi.fn(async () => ({ ok: true as const, value: opened }));
    const windowPreparation =
      deferred<Awaited<ReturnType<PatentApi["application"]["maximizeWindow"]>>>();
    if (outcome !== "ready") maximizeWindow.mockReturnValue(windowPreparation.promise);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("patent-editor-workspace") ? 1000 : 0;
      });
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("patent-page-zoom-frame") ? 794 : 0;
      });
    const app = render(<App />);
    try {
      await openPatentFromLibrary(user);
      await waitFor(() => expect(maximizeWindow).toHaveBeenCalledOnce());
      if (outcome === "failed") {
        await act(async () =>
          windowPreparation.resolve({
            ok: false,
            error: { code: "INTERNAL", message: "Window preparation failed" },
          }),
        );
        expect(appDialogs.showAppAlert).toHaveBeenCalled();
        expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
        return;
      }
      if (outcome === "cancelled") {
        await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
        await act(async () =>
          windowPreparation.resolve({
            ok: true,
            value: { isMaximized: true, contentWidth: 1920, contentHeight: 900 },
          }),
        );
        expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
        expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
        return;
      }
      const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
      await waitFor(() => {
        expect(
          within(workspace)
            .getByRole("region", { name: "左侧文档" })
            .getAttribute("data-dual-zoom"),
        ).toBe("65");
        expect(
          within(workspace)
            .getByRole("region", { name: "右侧文档" })
            .getAttribute("data-dual-zoom"),
        ).toBe("75");
      });
    } finally {
      app.unmount();
      clientWidth.mockRestore();
      offsetWidth.mockRestore();
    }
  },
);

test("executes view commands from the main menu", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("app-shell");

  await user.click(screen.getByRole("button", { name: "视图" }));
  await user.click(screen.getByRole("menuitem", { name: "放大" }));

  expect(screen.getByRole("button", { name: "缩放 110%，点击重置" })).toBeDefined();
});

test("blocks page-level select-all while preserving text-editor select-all", async () => {
  render(<App />);
  await screen.findByTestId("app-shell");

  const dispatchKey = (target: EventTarget, overrides: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...overrides,
    });
    target.dispatchEvent(event);
    return event;
  };
  const button = document.createElement("button");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const textInput = document.createElement("input");
  textInput.type = "text";
  const textarea = document.createElement("textarea");
  const contentEditable = document.createElement("div");
  contentEditable.setAttribute("contenteditable", "true");
  const mathField = document.createElement("math-field");
  const customEditor = document.createElement("div");
  customEditor.dataset.selectAllScope = "text";
  document.body.append(
    button,
    checkbox,
    textInput,
    textarea,
    contentEditable,
    mathField,
    customEditor,
  );

  expect(dispatchKey(document.body).defaultPrevented).toBe(true);
  expect(dispatchKey(button).defaultPrevented).toBe(true);
  expect(dispatchKey(checkbox).defaultPrevented).toBe(true);
  expect(dispatchKey(textInput).defaultPrevented).toBe(false);
  expect(dispatchKey(textarea).defaultPrevented).toBe(false);
  expect(dispatchKey(contentEditable).defaultPrevented).toBe(false);
  expect(dispatchKey(mathField).defaultPrevented).toBe(false);
  expect(dispatchKey(customEditor).defaultPrevented).toBe(false);
  expect(dispatchKey(document.body, { ctrlKey: false }).defaultPrevented).toBe(false);
  expect(dispatchKey(document.body, { shiftKey: true }).defaultPrevented).toBe(false);
  expect(dispatchKey(document.body, { isComposing: true }).defaultPrevented).toBe(false);

  const alreadyHandled = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const preventDefault = vi.spyOn(alreadyHandled, "preventDefault");
  alreadyHandled.preventDefault();
  document.body.dispatchEvent(alreadyHandled);
  expect(preventDefault).toHaveBeenCalledOnce();
});

test("opens default template management from the Settings workspace", async () => {
  const user = userEvent.setup();
  render(<App />);

  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });

  const templateLauncher = within(settings).getByRole("region", { name: "默认模板" });
  const openButton = within(templateLauncher).getByRole("button", {
    name: "打开默认模板设置",
  });
  expect(within(templateLauncher).queryByRole("tablist", { name: "专利类型" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "默认模板设置" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();

  await user.click(openButton);

  const templateDialog = await screen.findByRole("dialog", { name: "默认模板设置" });
  expect(within(templateDialog).getByRole("tablist", { name: "专利类型" })).toBeDefined();
  expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();
});

test("keeps the template launcher available after reopening Settings", async () => {
  const user = userEvent.setup();
  render(<App />);

  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  expect(within(settings).getByRole("button", { name: "打开默认模板设置" })).toBeDefined();
  expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();

  const closeButtons = within(settings).getAllByRole("button", { name: "关闭设置" });
  await user.click(closeButtons.at(-1)!);
  expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "设置" }));
  const reopenedSettings = await screen.findByRole("dialog", { name: "设置" });
  expect(within(reopenedSettings).getByRole("button", { name: "打开默认模板设置" })).toBeDefined();
});

test.each([
  ["快照版本", "快照管理器"],
  ["备份文件与恢复", "备份管理器"],
])("opens %s directly from File", async (label, region) => {
  const user = userEvent.setup();
  window.patentApi.backup = {
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  } as unknown as PatentApi["backup"];
  window.patentApi.snapshot = {
    list: vi.fn(async () => ({ ok: true as const, value: { entries: [], warnings: [] } })),
  } as unknown as PatentApi["snapshot"];
  render(<App />);
  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: label }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  expect(within(settings).getByRole("region", { name: region })).toBeDefined();
});

test("requests normal window close from File without directly terminating the app", async () => {
  const user = userEvent.setup();
  const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
  render(<App />);
  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "退出软件" }));
  expect(close).toHaveBeenCalledOnce();
  close.mockRestore();
});

test("keeps every Settings entry inside one dialog", async () => {
  const user = userEvent.setup();
  (window.patentApi as PatentApi).aiCorrection = {
    onEvent: vi.fn(() => vi.fn()),
    getSettings: vi.fn(async () => ({
      ok: true as const,
      value: {
        settings: {
          enabled: false,
          profiles: [],
          activeProfileId: null,
          timeoutMs: 30000,
          maxUploadCharacters: 10000,
        },
        credentialProfileIds: [],
      },
    })),
  } as unknown as PatentApi["aiCorrection"];
  (window.patentApi as PatentApi).backup = {
    status: vi.fn(),
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  } as unknown as PatentApi["backup"];
  (window.patentApi as PatentApi).snapshot = {
    status: vi.fn(),
    list: vi.fn(async () => ({ ok: true as const, value: { entries: [], warnings: [] } })),
  } as unknown as PatentApi["snapshot"];
  render(<App />);

  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });

  await user.click(within(settings).getByRole("button", { name: "页边距" }));
  expect(within(settings).getByRole("region", { name: "页面设置" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "快捷键" }));
  expect(within(settings).getByRole("region", { name: "快捷键设置" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "编辑辅助" }));
  await user.click(within(settings).getByRole("button", { name: "自定义同屏双显" }));
  const customDualView = await screen.findByRole("dialog", { name: "自定义同屏双显" });
  await user.click(within(customDualView).getByRole("button", { name: "取消" }));
  expect(within(settings).getByRole("region", { name: "编辑辅助设置" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "AI 设置（实验功能）" }));
  expect(within(settings).getByRole("region", { name: "AI 设置内容" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "存储与备份" }));
  await user.click(within(settings).getByRole("button", { name: "定时备份" }));
  expect(within(settings).getByRole("region", { name: "数据安全设置" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "备份文件" }));
  expect(within(settings).getByRole("region", { name: "备份管理器" })).toBeDefined();
  await user.click(within(settings).getByRole("button", { name: "快照版本" }));
  expect(within(settings).getByRole("region", { name: "快照管理器" })).toBeDefined();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test.each([0, 3])(
  "does not render the startup recovery notice after a healthy unclean-exit check (%i replayed edits)",
  async (replayedEditCount) => {
    getStartupRecoveryReport.mockResolvedValueOnce({
      ok: true,
      value: {
        previousShutdown: "unclean",
        mode: "read-write",
        replayedEditCount,
        recoveredPatentCount: replayedEditCount > 0 ? 1 : 0,
        quarantinedPatentCount: 0,
        backupCreated: false,
        checkedAt: "2026-08-16T00:00:00.000Z",
      } satisfies StartupRecoveryReport,
    });
    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("app-shell")).toBeDefined();
    expect(getStartupRecoveryReport).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status", { name: "启动恢复状态" })).toBeNull();
    expect(screen.queryByRole("alert", { name: "启动恢复状态" })).toBeNull();
    expect(screen.queryByText("文档恢复检查完成")).toBeNull();
  },
);

test.each([
  { mode: "read-only" as const },
  { quarantinedPatentCount: 1 },
  { historyCleanupPendingCount: 1 },
])(
  "opens unified data safety settings from an unresolved startup recovery notice (%j)",
  async (problem) => {
    const user = userEvent.setup();
    window.patentApi.application.getStartupRecoveryReport = vi.fn(async () => ({
      ok: true as const,
      value: {
        previousShutdown: "unclean" as const,
        mode: "read-write" as const,
        replayedEditCount: 0,
        recoveredPatentCount: 0,
        quarantinedPatentCount: 0,
        backupCreated: false,
        checkedAt: "2026-08-16T00:00:00.000Z",
        ...problem,
      },
    }));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "查看数据安全" }));

    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByRole("region", { name: "数据安全设置" })).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "数据安全设置" })).toBeNull();
  },
);

test("opens only backup settings from the data safety guide", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(await screen.findByRole("button", { name: /去设置|设置定时备份/ }));

  const settings = await screen.findByRole("dialog", { name: "设置" });
  expect(within(settings).getByRole("region", { name: "数据安全设置" })).toBeDefined();
  expect(await within(settings).findByRole("checkbox", { name: "启用定时备份" })).toBeDefined();
  expect(within(settings).queryByRole("checkbox", { name: "启用自动快照" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "数据安全设置" })).toBeNull();
});
test("opens only snapshot settings when the guide asks to enable snapshots", async () => {
  const user = userEvent.setup();
  window.sessionStorage.removeItem("patent-workbench:data-safety-guide-snoozed:v1");
  installPatentTrashTestApi({});
  vi.mocked(window.patentApi.settings.read).mockResolvedValue({
    ok: true,
    value: appSettingsFixture({
      backup: { ...DEFAULT_APP_SETTINGS.backup, enabled: true },
      snapshot: { ...DEFAULT_APP_SETTINGS.snapshot, enabled: false },
    }),
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(await screen.findByRole("button", { name: "设置快照" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  expect(await within(settings).findByRole("checkbox", { name: "启用自动快照" })).toBeDefined();
  expect(within(settings).queryByRole("checkbox", { name: "启用定时备份" })).toBeNull();
});

test("shows a deferred data safety guide again in the next app session", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  window.sessionStorage.removeItem("patent-workbench:data-safety-guide-snoozed:v1");
  const mounted = render(<App />);
  await user.dblClick(await screen.findByRole("article", { name: "往复式夹具" }));
  const guide = await screen.findByRole("status", { name: "数据安全提示" });
  await user.click(within(guide).getByRole("button", { name: "稍后设置" }));
  expect(screen.queryByRole("status", { name: "数据安全提示" })).toBeNull();
  expect(window.sessionStorage.getItem("patent-workbench:data-safety-guide-snoozed:v1")).toBe(
    "true",
  );

  mounted.unmount();
  window.sessionStorage.removeItem("patent-workbench:data-safety-guide-snoozed:v1");
  render(<App />);
  await user.dblClick(await screen.findByRole("article", { name: "往复式夹具" }));
  expect(await screen.findByRole("status", { name: "数据安全提示" })).toBeDefined();
});

test("saves global page settings while a patent library view is active", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "页边距" }));

  expect(await screen.findByText("当前没有打开文档，仍可保存全局页边距。")).toBeDefined();
  expect(within(settings).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
  await user.click(within(settings).getByRole("button", { name: "保存" }));
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ pageMargins: expect.anything() }),
  );
});

test("saves global margins from Settings while a patent library view is active", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "页边距" }));
  const pageMargins = await within(settings).findByRole("region", { name: "页面设置" });
  expect(within(pageMargins).getByText("当前没有打开文档，仍可保存全局页边距。")).toBeDefined();
  expect(within(pageMargins).getByRole("button", { name: "保存" })).toHaveProperty(
    "disabled",
    false,
  );
  updateSettings.mockClear();
  await user.click(within(pageMargins).getByRole("button", { name: "保存" }));
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ pageMargins: expect.anything() }),
  );
});

test("keeps shortcut settings inside the Settings workspace", async () => {
  const user = userEvent.setup();
  render(<App />);

  await screen.findByTestId("app-shell");
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "快捷键" }));
  const shortcutSettings = within(settings).getByRole("region", { name: "快捷键设置" });
  await user.click(within(shortcutSettings).getByRole("button", { name: "设置附图排序快捷键" }));
  fireEvent.keyDown(within(shortcutSettings).getByRole("button", { name: "设置附图排序快捷键" }), {
    code: "F8",
    key: "F8",
  });

  await waitFor(() => {
    expect(updateSettings).toHaveBeenCalledWith({
      shortcuts: expect.objectContaining({ "toggle-drawing-sort": "F8" }),
    });
  });
  expect(within(shortcutSettings).queryByRole("button", { name: "保存" })).toBeNull();
  expect(within(shortcutSettings).queryByRole("button", { name: "取消" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "快捷键设置" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();
});

test("creates the optional desktop shortcut from the Tools menu", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "工具" }));
  await user.click(screen.getByRole("menuitem", { name: "创建桌面快捷方式" }));
  expect(createDesktopShortcut).toHaveBeenCalledOnce();
});

test("opens the full-data migration entry points from the data migration settings page", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "数据迁移" }));

  expect(await screen.findByRole("heading", { name: "数据迁移" })).toBeDefined();
  expect(screen.getByRole("button", { name: "导出完整数据包" })).toBeDefined();
  expect(screen.getByRole("button", { name: "导入完整数据包" })).toBeDefined();
});

test("keeps protection settings free of full migration entry points", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "存储与备份" }));
  await user.click(within(settings).getByRole("button", { name: "定时备份" }));

  expect(await screen.findByRole("region", { name: "数据安全设置" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "完整数据迁移" })).toBeNull();
  expect(screen.queryByRole("button", { name: "导出完整数据包" })).toBeNull();
  expect(screen.queryByRole("button", { name: "导入完整数据包" })).toBeNull();
});

test("new installations open the library without an automatic migration prompt", async () => {
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  libraryList.mockResolvedValue({ ok: true, value: [] });
  render(<App />);

  await waitFor(() => expect(readSettings).toHaveBeenCalled());
  await waitFor(() => expect(getStartupRecoveryReport).toHaveBeenCalledOnce());
  expect(await screen.findByRole("tab", { name: "文档库" })).toBeDefined();
  expect(inspectDataTransferLibrary).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "已有完整数据包？从旧电脑恢复" })).toBeNull();
});

test("completes first-run state without a welcome prompt when a patent editor opens", async () => {
  const user = userEvent.setup();
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  installPatentTrashTestApi({});
  render(<App />);

  expect(await screen.findByRole("tab", { name: "专利库" })).toBeDefined();

  await openPatentFromLibrary(user);

  expect(await screen.findByRole("main", { name: "专利编辑区" })).toBeDefined();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "已有完整数据包？从旧电脑恢复" })).toBeNull(),
  );
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ welcomeCompleted: true }));
});

test("does not offer first-run recovery after the welcome has been completed", async () => {
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: true }),
  });
  render(<App />);

  await waitFor(() => expect(readSettings).toHaveBeenCalled());
  await waitFor(() => expect(getStartupRecoveryReport).toHaveBeenCalledOnce());
  expect(inspectDataTransferLibrary).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: /欢迎使用/u })).toBeNull();
});

test("does not duplicate editor toolbar actions in the library management view", async () => {
  render(<App />);

  const libraryHeading = await screen.findByRole("heading", { name: "文档库" });
  const libraryHeader = libraryHeading.closest("header");

  expect(libraryHeader).not.toBeNull();
  if (!libraryHeader) throw new Error("文档库标题必须位于管理页头部。");

  expect(screen.queryByRole("toolbar", { name: "常用工具" })).toBeNull();
  expect(within(libraryHeader).getByRole("button", { name: "新建文档" })).toBeDefined();
  expect(within(libraryHeader).getByRole("button", { name: "导入 PATDOC" })).toBeDefined();
});

test("blocks application close during a manually opened import commit and restart pending", async () => {
  const user = userEvent.setup();
  const committed = deferred<Awaited<ReturnType<PatentApi["dataTransfer"]["commitImport"]>>>();
  const prepareCloseListeners: Array<(token: string) => void> = [];
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  libraryList.mockResolvedValue({ ok: true, value: [] });
  selectDataTransferImportPackage.mockResolvedValue({
    ok: true,
    value: {
      selectionId: "welcome-source-selection",
      fileName: "虚构首次恢复数据.zxwbackup",
      sizeBytes: 128,
      packageFormatVersion: 2,
      minimumImporterVersion: "0.1.0",
      passwordHint: null,
    },
  });
  prepareDataTransferImport.mockImplementation(async (request) => ({
    ok: true,
    value: {
      operationId: request.operationId,
      packageId: "00000000-0000-4000-8000-000000000944",
      exportedAt: "2026-08-17T00:00:00.000Z",
      summary: {
        activePatents: 1,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 64,
      },
      packageVerified: true,
      versionCompatible: true,
      targetLibraryEmpty: true,
      settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
    },
  }));
  commitDataTransferImport.mockImplementation(() => committed.promise);
  window.patentApi.application.onPrepareClose = vi.fn((listener) => {
    prepareCloseListeners.push(listener);
    return vi.fn();
  });
  window.patentApi.application.closeResult = closeResult;
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "设置" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "设置" })).getByRole("button", {
      name: "数据迁移",
    }),
  );
  await user.click(await screen.findByRole("button", { name: "导入完整数据包" }));
  const wizard = await screen.findByRole("dialog", { name: "完整数据迁移" });
  await user.click(within(wizard).getByRole("button", { name: "导入完整数据包" }));
  await user.click(await within(wizard).findByRole("button", { name: "下一步" }));
  await user.click(within(wizard).getByRole("button", { name: "浏览数据包" }));
  await within(wizard).findByText("虚构首次恢复数据.zxwbackup");
  await user.click(within(wizard).getByRole("button", { name: "下一步" }));
  await user.type(await within(wizard).findByLabelText("迁移密码"), "虚构首次恢复密码十二字符9!");
  await user.click(within(wizard).getByRole("button", { name: "验证数据包" }));
  await user.click(
    await within(wizard).findByRole("checkbox", {
      name: "我确认当前专利库为空，并同意导入后重新启动",
    }),
  );
  await user.click(within(wizard).getByRole("button", { name: "导入并重新启动" }));

  prepareCloseListeners[0]?.("welcome-import-commit-token");
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({
      token: "welcome-import-commit-token",
      proceed: false,
    }),
  );

  committed.resolve({ ok: true, value: { restartPending: true } });
  await within(wizard).findByText("正在安全切换并重新启动");
  prepareCloseListeners[0]?.("welcome-import-restart-token");
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({
      token: "welcome-import-restart-token",
      proceed: false,
    }),
  );
});

test("does not automatically inspect or offer migration for an existing library", async () => {
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  inspectDataTransferLibrary.mockResolvedValueOnce({
    ok: true,
    value: {
      empty: false,
      blockers: [{ kind: "patents", count: 1 }],
      summary: {
        activePatents: 1,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 0,
        flowchartProjects: 0,

        totalBytes: 64,
      },
    },
  });
  render(<App />);

  await waitFor(() => expect(readSettings).toHaveBeenCalled());
  await waitFor(() => expect(getStartupRecoveryReport).toHaveBeenCalledOnce());
  expect(inspectDataTransferLibrary).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: /欢迎使用/u })).toBeNull();
  expect(screen.queryByRole("button", { name: "已有完整数据包？从旧电脑恢复" })).toBeNull();
});

test("reports a completed import only from an authoritative recovered startup report", async () => {
  const user = userEvent.setup();
  window.localStorage.removeItem("patent-workbench:post-import-safety-reminder:v1");
  window.sessionStorage.removeItem("patent-workbench:post-import-safety-reminder-deferred:v1");
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  getStartupRecoveryReport.mockResolvedValueOnce({
    ok: true,
    value: {
      previousShutdown: "clean",
      mode: "read-write",
      replayedEditCount: 0,
      recoveredPatentCount: 3,
      quarantinedPatentCount: 0,
      backupCreated: false,
      dataImportRecovery: "recovered",
      checkedAt: "2026-08-17T00:00:00.000Z",
    } satisfies StartupRecoveryReport,
  });
  const mounted = render(<App />);

  const guide = await screen.findByRole("status", { name: "完整数据迁移完成" });
  expect(guide.textContent).toContain("完整专利库和可移植设置已恢复");
  expect(guide.textContent).not.toContain("已恢复 3 项专利");
  expect(guide.textContent).toContain("二次完整性验证通过");
  expect(screen.queryByRole("heading", { name: /欢迎使用/u })).toBeNull();
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ welcomeCompleted: true }));

  await user.click(within(guide).getByRole("button", { name: "稍后设置" }));
  expect(screen.queryByRole("status", { name: "完整迁移数据安全提示" })).toBeNull();
  expect(window.localStorage.getItem("patent-workbench:post-import-safety-reminder:v1")).toBe(
    "pending",
  );

  mounted.unmount();
  window.sessionStorage.removeItem("patent-workbench:post-import-safety-reminder-deferred:v1");
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: true }),
  });
  render(<App />);
  const reminder = await screen.findByRole("status", { name: "完整迁移数据安全提示" });
  await user.click(within(reminder).getByRole("button", { name: "知道了" }));
  expect(window.localStorage.getItem("patent-workbench:post-import-safety-reminder:v1")).toBeNull();
});

test("prioritizes a read-only recovery warning over a recovered import status", async () => {
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({ welcomeCompleted: false }),
  });
  getStartupRecoveryReport.mockResolvedValueOnce({
    ok: true,
    value: {
      previousShutdown: "unknown",
      mode: "read-only",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      dataImportRecovery: "recovered",
      checkedAt: "2026-08-17T00:00:00.000Z",
    } satisfies StartupRecoveryReport,
  });
  render(<App />);

  expect(await screen.findByRole("alert", { name: "启动恢复状态" })).toBeDefined();
  expect(screen.queryByRole("status", { name: "完整数据迁移完成" })).toBeNull();
  expect(updateSettings).not.toHaveBeenCalledWith({ welcomeCompleted: true });
});

test("keeps manual-safe import recovery free of sensitive names and full paths", async () => {
  getStartupRecoveryReport.mockResolvedValueOnce({
    ok: true,
    value: {
      previousShutdown: "unknown",
      mode: "read-only",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      dataImportRecovery: "manual-safe-recovery",
      checkedAt: "2026-08-17T00:00:00.000Z",
      unsafePatentName: "虚构不应显示的专利名称",
      unsafeFullPath: "D:\\虚构客户目录\\私密专利\\候选库",
    } as StartupRecoveryReport,
  });
  render(<App />);

  const notice = await screen.findByRole("alert", { name: "完整数据迁移需要人工恢复" });
  expect(notice.textContent).toContain("不要删除迁移候选目录");
  expect(notice.textContent).not.toContain("联系技术支持");
  expect(within(notice).getByRole("button", { name: "从备份恢复" })).toBeDefined();
  expect(notice.textContent).not.toContain("虚构不应显示的专利名称");
  expect(notice.textContent).not.toContain("D:\\虚构客户目录");
});

test("opens the self-service backup fallback from protected startup without an editable runtime", async () => {
  getStartupRecoveryReport.mockResolvedValueOnce({
    ok: true,
    value: {
      previousShutdown: "unknown",
      mode: "read-only",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      recoverySourcesUnavailable: true,
      dataImportRecovery: "manual-safe-recovery",
      checkedAt: "2026-10-04T00:00:00.000Z",
    } satisfies StartupRecoveryReport,
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "从备份恢复" }));
  const center = await screen.findByRole("dialog", { name: "文档恢复" });
  expect(within(center).getByText(/无法加载备份列表/)).toBeDefined();
  expect(within(center).getByRole("button", { name: "选择其他 PATDOC 备份" })).toBeDefined();
  expect(center.textContent).not.toContain("技术支持");
});

test("renders manual-safe import recovery inside a contained card with aligned actions", async () => {
  getStartupRecoveryReport.mockResolvedValueOnce({
    ok: true,
    value: {
      previousShutdown: "unknown",
      mode: "read-only",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      dataImportRecovery: "manual-safe-recovery",
      checkedAt: "2026-08-17T00:00:00.000Z",
    } as StartupRecoveryReport,
  });
  render(<App />);

  const notice = await screen.findByRole("alert", { name: "完整数据迁移需要人工恢复" });
  // 受控卡片容器：不再贴边、有明确类名用于布局约束。
  expect(notice.className).toContain("manual-recovery-notice");
  // 任务编号、当前阶段、人工恢复提示与按钮均可用。
  expect(notice.textContent).toContain("任务编号：当前启动恢复任务");
  expect(notice.textContent).toContain("发生阶段：启动后的安全恢复检查");
  const actions = notice.querySelector(".manual-recovery-notice__actions");
  expect(actions).not.toBeNull();
  const dataSafety = screen.getByRole("button", { name: "查看数据安全" });
  expect(actions?.contains(dataSafety)).toBe(true);
});

test("exports the active canonical document and shows its report", async () => {
  const user = userEvent.setup();
  render(<App />);
  await createDocumentFromLibrary(user);

  await chooseToolbarExport(user, "DOCX");

  expect(exportDocx).toHaveBeenCalledWith({
    sessionId: expect.any(String),
    document: expect.objectContaining({ title: "文档 1" }),
    suggestedName: "文档 1",
  });
  expect(await screen.findByRole("dialog", { name: "DOCX 导出成功" })).toBeDefined();
  expect(screen.getByText("C:\\exports\\文档 1.docx")).toBeDefined();
});

test("shows structured export issues when DOCX creation fails", async () => {
  const user = userEvent.setup();
  exportDocx.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "EXPORT_FAILED",
      message: "DOCX 导出失败。",
      outputPath: "C:\\exports\\broken.docx",
      issues: [
        {
          severity: "error",
          code: "MISSING_ASSET",
          nodeId: "00000000-0000-4000-8000-000000000710",
          message: "附图资源不存在。",
        },
      ],
    },
  });
  render(<App />);
  await createDocumentFromLibrary(user);

  await chooseToolbarExport(user, "DOCX");

  expect(await screen.findByRole("dialog", { name: "DOCX 导出失败" })).toBeDefined();
  expect(screen.getByText("附图资源不存在。")).toBeDefined();
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("bounds a valid long document title before validating the DOCX export request", async () => {
  const user = userEvent.setup();
  const longTitle = "长标题".repeat(87);
  libraryImportPatdoc.mockResolvedValueOnce({
    ok: true,
    value: openedLibraryDocument(longTitle, 2),
  });
  exportDocx.mockImplementationOnce(async (request) => {
    ExportRequestSchema.parse(request);
    return {
      ok: true,
      value: { format: "docx", outputPath: "C:\\exports\\long-title.docx", issues: [] },
    };
  });
  render(<App />);

  await user.click(
    (await screen.findAllByRole("button", { name: "导入 PATDOC" }))[0] as HTMLElement,
  );
  await user.click(await screen.findByRole("button", { name: "继续导入" }));
  await screen.findByText(longTitle);
  await chooseToolbarExport(user, "DOCX");

  expect(await screen.findByRole("dialog", { name: "DOCX 导出成功" })).toBeDefined();
  const request = exportDocx.mock.calls[0]?.[0];
  expect(ExportRequestSchema.safeParse(request).success).toBe(true);
  expect(request.suggestedName.length).toBeLessThanOrEqual(250);
  expect(request.suggestedName).not.toMatch(/[<>:"/\\|?*]/u);
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("shows a visible error when the DOCX bridge rejects", async () => {
  const user = userEvent.setup();
  exportDocx.mockRejectedValueOnce(new Error("IPC validation failed"));
  render(<App />);
  await createDocumentFromLibrary(user);

  await chooseToolbarExport(user, "DOCX");

  const dialog = await screen.findByRole("alertdialog", { name: "操作未完成" });
  expect(within(dialog).getByText("本地操作失败。")).toBeDefined();
  expect(within(dialog).getByText("请重试；如果问题持续，请重新启动应用。")).toBeDefined();
  expect(screen.queryByText(/IPC validation failed/u)).toBeNull();
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("shows normalized internal library save errors in the shared modal", async () => {
  const user = userEvent.setup();
  libraryFlush.mockResolvedValueOnce({
    ok: false,
    error: { code: "FILE_LOCKED", message: "raw path C:\\secret\\draft.patdoc" },
  });
  render(<App />);
  await createDocumentFromLibrary(user);

  await user.click((await screen.findAllByRole("button", { name: "保存" }))[0] as HTMLElement);

  const dialog = await screen.findByRole("alertdialog", { name: "操作未完成" });
  expect(within(dialog).getByText("文件正被其他程序占用。")).toBeDefined();
  expect(within(dialog).getByText("请关闭占用程序后重试，或使用另存为。")).toBeDefined();
  expect(screen.queryByText(/secret/u)).toBeNull();
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("saves the exact cached PDF preview token and dismisses the consumed preview", async () => {
  const user = userEvent.setup();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:app-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  render(<App />);
  await createDocumentFromLibrary(user);

  await user.click(await screen.findByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "打印…" }));

  const previewDialog = await screen.findByRole("dialog", { name: "打印中心" });
  expect(previewDialog).toBeDefined();
  const request = expect.objectContaining({
    sessionId: expect.any(String),
    targetId: expect.any(String),
    document: expect.objectContaining({ title: "文档 1" }),
    suggestedName: "文档 1",
  });
  expect(previewPdf).toHaveBeenCalledWith(request);

  await waitFor(() =>
    expect(within(previewDialog).getByRole("button", { name: "导出 PDF" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await user.click(within(previewDialog).getByRole("button", { name: "导出 PDF" }));
  await waitFor(() =>
    expect(savePreviewPdf).toHaveBeenCalledWith({
      previewId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
      suggestedName: "文档 1",
    }),
  );
  expect(exportPdf).not.toHaveBeenCalled();
  expect(printDocument).not.toHaveBeenCalled();
  const report = await screen.findByRole("dialog", { name: "PDF 导出成功" });
  expect(screen.queryByRole("dialog", { name: "打印中心" })).toBeNull();
  await waitFor(() =>
    expect(discardPreview).toHaveBeenCalledWith("5d5c49f1-5f4c-4e70-9326-dd7e17d68a41"),
  );
  await user.click(within(report).getByRole("button", { name: "确认" }));
});

test("discards a cached PDF preview when the user closes it", async () => {
  const user = userEvent.setup();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:app-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  render(<App />);
  await createDocumentFromLibrary(user);

  await user.click(await screen.findByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "打印…" }));
  const previewDialog = await screen.findByRole("dialog", { name: "打印中心" });
  await user.click(within(previewDialog).getByRole("button", { name: "关闭打印中心" }));

  expect(discardPreview).toHaveBeenCalledWith("5d5c49f1-5f4c-4e70-9326-dd7e17d68a41");
});

test("external patdoc import enters the editor, announces success and refreshes the library", async () => {
  const user = userEvent.setup();
  const opened = openedPatent("双击导入专利", 1);
  let imported = false;
  let listener: ((path: string) => void) | undefined;
  const list = vi.fn(async () => ({
    ok: true as const,
    value: imported ? [patentSummary("双击导入专利", 1)] : [],
  }));
  window.patentApi.patents = {
    ...window.patentApi.patents,
    list,
    openPath: vi.fn(async () => {
      imported = true;
      return { ok: true as const, value: opened };
    }),
  };
  window.patentApi.application.onOpenPath = (callback) => {
    listener = callback;
    return () => {};
  };
  render(<App />);
  await screen.findByRole("heading", { name: "专利库" });
  const callsBefore = list.mock.calls.length;
  act(() => listener?.("C:\\test.patdoc"));
  expect(await screen.findByText("已导入成功！")).toBeDefined();
  expect(await screen.findByRole("tab", { name: "双击导入专利" })).toBeDefined();
  expect(await screen.findByRole("tablist", { name: "五书标签栏" })).toBeDefined();
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore));
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  const library = await screen.findByRole("main", { name: "专利库" });
  expect(await within(library).findByText("双击导入专利")).toBeDefined();
});

test("uses patent mode to open full five-book patents when patent APIs are available", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const patentList = vi.fn(async (scope: "active" | "trash") => ({
    ok: true as const,
    value: scope === "active" ? [existing] : [],
  }));
  const patentOpen = vi.fn(async () => ({ ok: true as const, value: opened }));
  const patentCreate = vi.fn(async () => ({ ok: true as const, value: openedPatent(null, 2) }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: patentList,
    create: patentCreate,
    open: patentOpen,
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);

  expect(await screen.findByRole("heading", { name: "专利库" })).toBeDefined();
  expect(screen.queryByRole("toolbar", { name: "常用工具" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "主菜单" })).toBeNull();
  const libraryActions = screen.getByRole("navigation", { name: "专利库辅助功能" });
  expect(within(libraryActions).getByRole("button", { name: "备份与恢复" })).toBeDefined();
  expect(within(libraryActions).getByRole("button", { name: "设置" })).toBeDefined();
  expect(within(libraryActions).getByRole("button", { name: "帮助" })).toBeDefined();
  expect(screen.getByRole("button", { name: "更多" })).toBeDefined();
  expect(screen.getByRole("button", { name: "新建专利" })).toBeDefined();
  expect(screen.getByRole("button", { name: "导入" })).toBeDefined();
  expect(screen.getByRole("button", { name: "回收站" })).toBeDefined();
  expect(screen.queryByRole("tablist", { name: "五书标签栏" })).toBeNull();
  await openPatentFromLibrary(user);

  expect(await screen.findByRole("tab", { name: "往复式夹具" })).toBeDefined();
  const menuBar = screen.getByRole("navigation", { name: "主菜单" });
  const bookTabs = within(menuBar).getByRole("tablist", { name: "五书标签栏" });
  expect(within(bookTabs).getByRole("tab", { name: "权利要求书" })).toBeDefined();
  expect(within(bookTabs).getByRole("tab", { name: "说明书" })).toBeDefined();
  expect(within(bookTabs).getByRole("tab", { name: "说明书附图" })).toBeDefined();
  expect(within(bookTabs).getByRole("tab", { name: "说明书摘要" })).toBeDefined();
  expect(within(bookTabs).getByRole("tab", { name: "摘要附图" })).toBeDefined();
  expect(screen.queryByTestId("patent-color-dot")).toBeNull();
  expect(screen.queryByRole("button", { name: "关闭说明书" })).toBeNull();

  await user.click(within(bookTabs).getByRole("tab", { name: "说明书" }));
  expect(within(bookTabs).getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe(
    "true",
  );

  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  await waitFor(() =>
    expect(
      within(bookTabs).getByRole("tab", { name: "说明书附图" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );

  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(
      within(bookTabs).getByRole("tab", { name: "说明书" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );

  await user.click(within(bookTabs).getByRole("tab", { name: "摘要附图" }));
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  await waitFor(() =>
    expect(
      within(bookTabs).getByRole("tab", { name: "权利要求书" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );

  await user.click(screen.getByRole("tab", { name: "专利库" }));
  expect(screen.queryByRole("tablist", { name: "五书标签栏" })).toBeNull();
  expect(screen.queryByRole("toolbar", { name: "常用工具" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "新建专利" }));
  await user.click(await screen.findByRole("radio", { name: "实用新型" }));
  await user.click(screen.getByRole("button", { name: "创建专利" }));

  expect(patentCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      patentType: "utility-model",
      name: null,
      customer: null,
    }),
  );
});

test("inserts every toolbar-selected image into claims and disables the action for the abstract", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const imported = [importedPatentImage(1), importedPatentImage(2)];
  const chooseAndImportMany = vi.fn(async () => ({ ok: true as const, value: imported }));
  const applyBookEdit = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision + 1,
      savedAt: "2026-09-02T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit,
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  window.patentApi.assets.chooseAndImportMany = chooseAndImportMany;
  window.patentApi.assets.getPreview = vi.fn(async () => ({
    ok: false as const,
    error: { code: "NOT_FOUND" as const, message: "测试中不加载预览" },
  }));

  const { container } = render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "权利要求书" }));

  const insertImage = await screen.findByRole("button", { name: "插入图片" });
  await user.click(insertImage);
  await waitFor(() => expect(chooseAndImportMany).toHaveBeenCalledWith(opened.sessionId));
  await waitFor(() => expect(container.querySelectorAll(".patent-figure")).toHaveLength(2));
  await waitFor(() =>
    expect(
      applyBookEdit.mock.calls.some((call) => {
        const request = call[0] as Parameters<PatentApi["patents"]["applyBookEdit"]>[0];
        return (
          request.bookKind === "claims" &&
          request.document.content.filter((node) => node.type === "figure").length === 2 &&
          request.assets.map((asset) => asset.assetId).join("|") ===
            imported.map(({ descriptor }) => descriptor.assetId).join("|")
        );
      }),
    ).toBe(true),
  );

  await user.click(screen.getByRole("tab", { name: "说明书" }));
  expect(await screen.findByRole("button", { name: "插入图片" })).toBeDefined();
  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  chooseAndImportMany.mockClear();
  chooseAndImportMany.mockResolvedValueOnce({ ok: true, value: [] });
  await user.click(await screen.findByRole("button", { name: "插入图片" }));
  await waitFor(() => expect(chooseAndImportMany).toHaveBeenCalledWith(opened.sessionId));
  await user.click(screen.getByRole("tab", { name: "说明书摘要" }));
  expect(screen.getByRole("button", { name: "插入图片" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "摘要附图" }));
  expect(screen.getByRole("button", { name: "插入图片" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
});

test("drops desktop images on the description drawings tab, appends them, and opens the drawings", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const imported = importedPatentImage(1, { widthPx: 1200, heightPx: 800 });
  const importMany = vi.fn(async () => ({ ok: true as const, value: [imported] }));
  const applyFigureEdit = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision + 1,
      savedAt: "2026-09-03T01:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit,
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  window.patentApi.assets.importMany = importMany;
  window.patentApi.assets.getPreview = vi.fn(async () => ({
    ok: false as const,
    error: { code: "NOT_FOUND" as const, message: "测试中不加载预览" },
  }));

  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  const image = new File([Uint8Array.from([1, 2, 3])], "附图1.png", { type: "image/png" });

  fireEvent.drop(screen.getByRole("tab", { name: "说明书附图" }), {
    dataTransfer: { types: ["Files"], files: [image] },
  });

  await waitFor(() => expect(importMany).toHaveBeenCalledOnce());
  expect(importMany).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: opened.sessionId,
      images: [
        expect.objectContaining({
          originalName: "附图1.png",
          declaredMediaType: "image/png",
        }),
      ],
    }),
  );
  await waitFor(() =>
    expect(
      applyFigureEdit.mock.calls.some((call) => {
        const request = call[0] as Parameters<PatentApi["patents"]["applyFigureEdit"]>[0];
        return (
          request.figures.length === 1 &&
          request.figures[0]?.assetId === imported.descriptor.assetId
        );
      }),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "说明书附图" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
});

test("does not leave a patent open when library settings restore drawing books", async () => {
  const user = userEvent.setup();
  const existing = {
    ...patentSummary("无附图发明", 1),
    patentType: "invention" as const,
    bookStatuses: {
      ...patentSummary("无附图发明", 1).bookStatuses,
      "description-drawings": "unavailable" as const,
      "abstract-drawing": "unavailable" as const,
    },
  };
  const opened = openedPatent("无附图发明", 1);
  opened.patent.patentType = "invention";
  opened.patent.drawingBooksEnabled = false;
  const restored = structuredClone(opened.patent);
  restored.patentType = "utility-model";
  restored.drawingBooksEnabled = true;
  restored.revision = 1;
  const patentOpen = vi.fn(async () => ({ ok: true as const, value: opened }));
  const setDrawingBooksEnabled = vi.fn(async () => ({
    ok: true as const,
    value: {
      patent: restored,
      savedAt: "2026-08-09T08:00:01.000Z",
      assetIdsForPostCommitGarbageCollection: [],
      notice: "已为实用新型恢复说明书附图和摘要附图。",
    },
  }));
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: patentOpen,
    openPath: vi.fn(),
    recover: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled,
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision,
        flushedAt: "2026-08-09T08:00:02.000Z",
      },
    })),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(),
    exportPatdoc: vi.fn(),
    release,
  };

  render(<App />);

  const card = await screen.findByRole("article", { name: "无附图发明" });
  await user.click(within(card).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "设置" }));
  const dialog = await screen.findByRole("dialog", { name: "专利设置" });
  await user.click(within(dialog).getByRole("radio", { name: "实用新型" }));
  await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

  await waitFor(() => expect(setDrawingBooksEnabled).toHaveBeenCalledOnce());
  await waitFor(() => expect(release).toHaveBeenCalledWith(opened.sessionId));
  expect(screen.getByRole("heading", { name: "专利库" })).toBeDefined();
  expect(screen.queryByRole("tab", { name: "无附图发明" })).toBeNull();
});

test("opens the print center for the active patent book in patent mode", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(await screen.findByRole("menuitem", { name: "打印…" }));

  const previewDialog = await screen.findByRole("dialog", { name: "打印中心" });
  expect(previewDialog).toBeDefined();
  expect(previewPdf).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: opened.sessionId,
      targetId: opened.patentId,
      document: expect.objectContaining({
        ...opened.patent.books[1]?.document,
        patentType: "utility-model",
        assets: [],
      }),
      suggestedName: "往复式夹具-说明书",
    }),
  );
});

test("enters the new patent editor without waiting for a library refresh", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("已有专利", 1);
  const created = openedPatent("即时进入", 2);
  let finishRefresh: (() => void) | undefined;
  const pendingRefresh = new Promise<
    Awaited<ReturnType<NonNullable<PatentApi["patents"]>["list"]>>
  >((resolve) => {
    finishRefresh = () =>
      resolve({
        ok: false,
        error: { code: "INTERNAL", message: "读取专利库失败。" },
      });
  });
  const patentList = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: [existing] })
    .mockReturnValueOnce(pendingRefresh);
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: patentList,
    create: vi.fn(async () => ({ ok: true as const, value: created })),
    open: vi.fn(),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);
  await screen.findByRole("heading", { name: "专利库" });
  await user.click(screen.getByRole("button", { name: "新建专利" }));
  await user.type(screen.getByRole("textbox", { name: "专利名称" }), "即时进入");
  await user.click(screen.getByRole("radio", { name: "实用新型" }));
  await user.click(screen.getByRole("button", { name: "创建专利" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建专利" })).toBeNull());
  expect(screen.getByRole("main", { name: "专利编辑区" })).toBeDefined();
  finishRefresh?.();
  await waitFor(() => expect(patentList).toHaveBeenCalledTimes(2));
});

test("routes problem checks from the toolbar and active document rail to the unified panel", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  const workspace = screen.getByRole("main", { name: "专利编辑区" });
  const bookLayout = workspace.querySelector<HTMLElement>(".patent-book-editor-layout");
  expect(workspace.getAttribute("data-patent-text-projection")).toBe(
    bookLayout?.getAttribute("data-patent-text-projection"),
  );
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
  const toggle = within(rail).getByRole("button", { name: "本地检查" });
  expect(toggle.getAttribute("aria-expanded")).toBeNull();
  expect(within(workspace).queryByRole("button", { name: /本地检查/u })).toBeNull();
  expect(within(rail).queryByRole("region", { name: "本地检查结果" })).toBeNull();
  expect(within(workspace).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();

  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  await user.click(within(toolbar).getByRole("button", { name: "本地检查" }));
  expect(within(rail).queryByRole("region", { name: "本地检查结果" })).toBeNull();
  const panel = screen.getByRole("complementary", { name: "本地检查" });
  expect(panel).toBeDefined();
  expect(panel.classList.contains("assistant-side-panel")).toBe(true);
  expect(within(workspace).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();

  await user.click(within(rail).getByRole("button", { name: "AI 纠错" }));
  expect(screen.queryByRole("complementary", { name: "本地检查" })).toBeNull();
  expect(screen.getByRole("complementary", { name: "AI 纠错" })).toBeDefined();

  await user.click(within(rail).getByRole("button", { name: "小栈AI助手" }));
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();
  expect(screen.getByRole("complementary", { name: "小栈AI助手" })).toBeDefined();

  await user.click(toggle);
  expect(screen.queryByRole("complementary", { name: "小栈AI助手" })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();
  expect(screen.getByRole("complementary", { name: "本地检查" })).toBeDefined();
});

test("toggles assistant panels from toolbar with synchronized pressed state", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  const labels = ["本地检查", "AI 纠错", "小栈AI助手"] as const;
  for (const label of labels) {
    const button = within(toolbar).getByRole("button", { name: label });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("is-active")).toBe(true);
    expect(screen.getByRole("complementary", { name: label })).toBeDefined();
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("complementary", { name: label })).toBeNull();
  }
  await user.click(within(toolbar).getByRole("button", { name: labels[0] }));
  await user.click(within(toolbar).getByRole("button", { name: labels[1] }));
  expect(
    within(toolbar).getByRole("button", { name: labels[0] }).getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    within(toolbar).getByRole("button", { name: labels[1] }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("opens quick check on a preparatory state and runs only on 全文检查", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));

  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  await user.click(within(toolbar).getByRole("button", { name: "本地检查" }));

  const panel = screen.getByRole("complementary", { name: "本地检查" });
  expect(within(panel).getByRole("button", { name: "全文检查" })).toBeDefined();
  expect(within(panel).queryByRole("tablist", { name: "本地检查筛选" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "重新检查" })).toBeNull();

  await user.click(within(panel).getByRole("button", { name: "全文检查" }));

  expect(within(panel).queryByRole("button", { name: "全文检查" })).toBeNull();
  expect(await within(panel).findByRole("tablist", { name: "本地检查筛选" })).toBeDefined();
  expect(within(panel).getByRole("button", { name: "重新检查" })).toBeDefined();
  expect(within(panel).getByRole("button", { name: "关闭本地检查" })).toBeDefined();
});

test("locates a quick-check issue by switching book and selecting the offending text", async () => {
  const user = userEvent.setup();
  // ProseMirror's scrollIntoView reads Range client rects; jsdom does not
  // implement them, so provide empty rects for the scroll step only.
  const emptyRect = () => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: emptyRect,
  });
  installPatentTrashTestApi({ firstOpenedOverride: openedPatentWithPromotionalPhrase() });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  await user.click(within(toolbar).getByRole("button", { name: "本地检查" }));

  const panel = screen.getByRole("complementary", { name: "本地检查" });
  await user.click(within(panel).getByRole("button", { name: "全文检查" }));
  await within(panel).findByRole("tablist", { name: "本地检查筛选" });

  await user.click(within(panel).getByRole("button", { name: /待核对/u }));
  const issue = await within(panel).findByRole("listitem", { name: /宣传性表述“世界领先”/u });
  await user.click(within(issue).getByRole("button", { name: "定位文字" }));
  await waitFor(() => expect(window.getSelection()?.toString()).toBe("世界领先"));

  // The report stays open and the target book becomes active. The exact selection
  // itself is asserted by patent-check-locate.test.ts; here we verify the
  // wiring resolved the exact range (no fallback notice was raised).
  expect(screen.getByRole("complementary", { name: "本地检查" })).toBe(panel);
  expect(within(panel).getByRole("listitem", { name: /宣传性表述“世界领先”/u })).toBe(issue);
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("exports without showing or navigating to existing inspection problems", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({ firstOpenedOverride: openedPatentWithPromotionalPhrase() });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: /^权利要求书$/u }));
  await chooseToolbarExport(user, "DOCX");
  const dialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  expect(within(dialog).queryByText(/宣传性表述“世界领先”/u)).toBeNull();
  expect(within(dialog).queryByText(/导出前发现/u)).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "导出" }));
  await waitFor(() => expect(exportPatentDocx).toHaveBeenCalledOnce());
  expect(screen.getByRole("tab", { name: "权利要求书", selected: true })).toBeDefined();
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});

test("opens AI model settings from the AI correction panel", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  window.patentApi.aiCorrection = {
    getSettings: vi.fn(async () => ({
      ok: true as const,
      value: {
        settings: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
        credentialProfileIds: [],
      },
    })),
    onEvent: vi.fn(() => vi.fn()),
  } as unknown as PatentApi["aiCorrection"];
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
  await user.click(within(rail).getByRole("button", { name: "AI 纠错" }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));

  const settings = screen.getByRole("dialog", { name: "设置" });
  expect(within(settings).getByRole("region", { name: "AI 设置内容" })).toBeDefined();
  expect(within(settings).getByRole("checkbox", { name: "允许连接 AI 服务" })).toBeDefined();
});

test("hides AI correction outside the patent editor and restores it on return", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
  await user.click(within(rail).getByRole("button", { name: "AI 纠错" }));
  expect(screen.getByRole("complementary", { name: "AI 纠错" })).toBeDefined();

  await user.click(screen.getByRole("tab", { name: "专利库" }));
  expect(await screen.findByRole("main", { name: "专利库" })).toBeDefined();
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();

  await user.click(screen.getByRole("tab", { name: "往复式夹具" }));
  expect(await screen.findByRole("complementary", { name: "AI 纠错" })).toBeDefined();
});

test("hides AI correction in non-text patent workspaces and restores it on return", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
  await user.click(within(rail).getByRole("button", { name: "AI 纠错" }));

  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  expect(screen.getByRole("complementary", { name: "AI 纠错" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  expect(await screen.findByRole("main", { name: "流程图编辑工作区" })).toBeDefined();
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "关闭流程图" }));
  expect(await screen.findByRole("complementary", { name: "AI 纠错" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  fireEvent.pointerDown(rightPane);
  expect(screen.queryByRole("complementary", { name: "AI 纠错" })).toBeNull();
  fireEvent.pointerDown(leftPane);
  expect(screen.getByRole("complementary", { name: "AI 纠错" })).toBeDefined();
});

test("imports specification drawings when Electron does not expose crypto.randomUUID", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const chooseAndImportMany = vi.fn(async () => ({
    ok: true as const,
    value: [
      importedPatentImage(1, { widthPx: 1200, heightPx: 800 }),
      importedPatentImage(2, { widthPx: 800, heightPx: 1600 }),
    ],
  }));
  const applyFigureEdit = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision + 1,
      savedAt: "2026-08-02T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-02T08:00:00.000Z",
      },
    })),
    applyFigureEdit,
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  window.patentApi.assets.chooseAndImportMany = chooseAndImportMany;
  const auxiliary = structuredClone(appSettingsFixture().patentTemplates["utility-model"]);
  auxiliary.figureExplanation.content = [
    { type: "text", text: "自定义图{{figureNumber}}说明。", marks: [] },
  ];
  const readAuxiliary = vi.fn(async () => ({
    ok: true as const,
    value: {
      invention: {
        patentType: "invention" as const,
        figureExplanation: structuredClone(
          appSettingsFixture().patentTemplates.invention.figureExplanation,
        ),
        drawingLegend: structuredClone(
          appSettingsFixture().patentTemplates.invention.drawingLegend,
        ),
        updatedAt: "2026-08-28T12:00:00.000Z",
      },
      "utility-model": {
        patentType: "utility-model" as const,
        figureExplanation: auxiliary.figureExplanation,
        drawingLegend: auxiliary.drawingLegend,
        updatedAt: "2026-08-28T12:00:00.000Z",
      },
    },
  }));
  window.patentApi.patentTemplates = {
    readAuxiliary,
  } as unknown as PatentApi["patentTemplates"];

  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const originalRandomUuid = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    await user.click(screen.getByRole("button", { name: "导入图片" }));
    await waitFor(() => expect(applyFigureEdit).toHaveBeenCalledOnce());
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUuid,
    });
  }
  expect(applyFigureEdit).toHaveBeenCalledWith(
    expect.objectContaining({
      patentId: opened.patentId,
      figures: [
        expect.objectContaining({
          assetId: importedPatentImage(1).descriptor.assetId,
          widthMm: 146.6,
        }),
        expect.objectContaining({
          assetId: importedPatentImage(2).descriptor.assetId,
          widthMm: 100,
        }),
      ],
    }),
  );
  expect(applyFigureEdit.mock.calls[0]?.[0]).not.toHaveProperty("descriptionEdit");
  expect(readAuxiliary).not.toHaveBeenCalled();

  expect(screen.getByRole("article", { name: "图1" })).toBeDefined();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "撤销" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
  await user.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(applyFigureEdit).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("article", { name: "图1" })).toBeNull();
  expect(applyFigureEdit.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({
      figures: [],
      abstractDrawingFigureId: null,
    }),
  );
  expect(applyFigureEdit.mock.calls[1]?.[0]).not.toHaveProperty("descriptionEdit");

  await user.click(screen.getByRole("button", { name: "重做" }));
  await waitFor(() => expect(applyFigureEdit).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("article", { name: "图1" })).toBeDefined();
});

test("routes PATDOC import and export through the patent aggregate", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const imported = openedPatent("导入案件", 3);
  imported.patent = withPatdocWorkspace(imported.patent, {
    version: 1,
    activeBookKind: "description",
    zoomPercent: 110,
    columns: false,
    columnZoomPercent: 100,
    books: [{ bookKind: "description", scrollTop: 0, selection: { from: 1, to: 1 } }],
    aiCorrectionOpen: false,
    assistantOpen: false,
  });
  const importPatdoc = vi.fn(async () => ({ ok: true as const, value: imported }));
  const exportBundle = vi.fn(async () => ({ ok: true as const, value: null }));
  const exportPatdoc = vi.fn(async () => ({
    ok: true as const,
    value: {
      sessionId: imported.sessionId,
      path: "C:\\exports\\导入案件.patdoc",
      displayName: "导入案件.patdoc",
      savedAt: "2026-08-02T08:00:00.000Z",
      previousVersionRetained: false,
    },
  }));
  const flush = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-02T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    importPatdoc,
    exportPatdoc,
    exportBundle,
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);
  const library = await screen.findByRole("main", { name: "专利库" });
  await user.click(within(library).getByRole("button", { name: "导入" }));
  await user.click(screen.getByRole("menuitem", { name: "导入 PATDOC" }));
  expect(importPatdoc).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "继续导入" }));
  expect(importPatdoc).toHaveBeenCalledOnce();
  expect(await screen.findByRole("tab", { name: "导入案件" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "导出 PATDOC" }));
  const activeExportDialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  await user.click(within(activeExportDialog).getByRole("button", { name: "导出" }));
  await waitFor(() =>
    expect(exportPatdoc).toHaveBeenCalledWith({
      patentId: imported.patentId,
      expectedRevision: imported.revision,
      suggestedName: "导入案件（新型）",
      workspace: expect.objectContaining({
        version: 1,
        activeBookKind: "description",
        zoomPercent: 110,
        books: expect.any(Array),
      }),
    }),
  );
  const activeExportReport = await screen.findByRole("dialog", { name: "PATDOC 导出成功" });
  await user.click(within(activeExportReport).getByRole("button", { name: "确认" }));

  await user.click(screen.getByRole("tab", { name: "专利库" }));
  const patentLibrary = screen.getByRole("main", { name: "专利库" });
  const patentCard = within(patentLibrary).getByRole("article", { name: "往复式夹具" });
  await user.click(within(patentCard).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "导出" }));
  const exportDialog = await screen.findByRole("dialog", { name: "导出专利" });
  await user.click(within(exportDialog).getByRole("radio", { name: "PATDOC" }));
  await user.click(within(exportDialog).getByRole("button", { name: "导出" }));
  await waitFor(() =>
    expect(exportBundle).toHaveBeenCalledWith({
      format: "patdoc",
      patents: [{ patentId: existing.patentId, expectedRevision: existing.revision }],
    }),
  );
});

test("opens DOCX import from the editor toolbar and keeps the editor on cancellation", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  const prepareDocxImport = vi.fn(async () => ({ ok: true as const, value: null }));
  (window.patentApi as PatentApi).patents = {
    ...window.patentApi.patents,
    prepareDocxImport,
  };
  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  await user.click(within(toolbar).getByRole("button", { name: "导入文件" }));
  expect(prepareDocxImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("menuitem", { name: "导入 DOCX" }));
  expect(prepareDocxImport).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "继续导入" }));
  await waitFor(() => expect(prepareDocxImport).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "正在处理文件" })).toBeNull());
  expect(screen.getByRole("toolbar", { name: "常用工具" })).toBeDefined();
  expect(screen.queryByRole("menu", { name: "选择导入格式" })).toBeNull();
});

test("shows DOCX reading status and rejects a duplicate import while parsing", async () => {
  const user = userEvent.setup();
  const prepared =
    deferred<Awaited<ReturnType<NonNullable<PatentApi["patents"]["prepareDocxImport"]>>>>();
  const prepareDocxImport = vi.fn(() => prepared.promise);
  (window.patentApi as PatentApi).patents = {
    prepareDocxImport,
  } as unknown as PatentApi["patents"];

  render(<App />);
  const library = await screen.findByRole("main", { name: "专利库" });
  await user.click(within(library).getByRole("button", { name: "导入" }));
  const importItem = screen.getByRole("menuitem", { name: "导入 DOCX" });
  fireEvent.click(importItem);
  fireEvent.click(importItem);
  await user.click(await screen.findByRole("button", { name: "继续导入" }));

  expect((await screen.findByRole("dialog", { name: "正在处理文件" })).textContent).toContain(
    "正在读取并识别 DOCX…",
  );
  expect(prepareDocxImport).toHaveBeenCalledOnce();

  prepared.resolve({ ok: true, value: null });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "正在处理文件" })).toBeNull());
});

test.each([
  { format: "DOCX" as const, api: exportDocx, message: "正在生成并保存 DOCX…" },
  { format: "PDF" as const, api: exportPdf, message: "正在生成并保存 PDF…" },
])("shows and locks the $format export operation", async ({ format, api, message }) => {
  const user = userEvent.setup();
  const pending = deferred<Awaited<ReturnType<typeof api>>>();
  api.mockImplementationOnce(() => pending.promise);

  render(<App />);
  await createDocumentFromLibrary(user);
  await user.click(await screen.findByRole("button", { name: "导出" }));
  const exportItem = screen.getByRole("menuitem", { name: `导出 ${format}` });
  fireEvent.click(exportItem);
  fireEvent.click(exportItem);

  expect((await screen.findByRole("dialog", { name: "正在处理文件" })).textContent).toContain(
    message,
  );
  expect(api).toHaveBeenCalledOnce();

  pending.resolve({
    ok: true,
    value: {
      format: format.toLowerCase() as "docx" | "pdf",
      outputPath: `C:\\exports\\文档 1.${format.toLowerCase()}`,
      issues: [],
    },
  });
  expect(await screen.findByRole("dialog", { name: `${format} 导出成功` })).toBeDefined();
});

test("shows and locks PATDOC export, then reports the saved path", async () => {
  const user = userEvent.setup();
  const imported = openedPatent("导入案件", 3);
  const pending = deferred<Awaited<ReturnType<PatentApi["patents"]["exportPatdoc"]>>>();
  const exportPatdoc = vi.fn(() => pending.promise);
  (window.patentApi as PatentApi).patents = {
    ...(window.patentApi as PatentApi).patents,
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: imported })),
    exportPatdoc,
    flush: vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision,
        flushedAt: "2026-09-02T00:00:00.000Z",
      },
    })),
  };

  render(<App />);
  const library = await screen.findByRole("main", { name: "专利库" });
  await user.click(within(library).getByRole("button", { name: "导入" }));
  await user.click(screen.getByRole("menuitem", { name: "导入 PATDOC" }));
  await user.click(await screen.findByRole("button", { name: "继续导入" }));
  await screen.findByRole("tab", { name: "导入案件" });
  await user.click(screen.getByRole("button", { name: "文件" }));
  const exportItem = screen.getByRole("menuitem", { name: "导出 PATDOC" });
  fireEvent.click(exportItem);
  fireEvent.click(exportItem);

  const exportDialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  const confirmExport = within(exportDialog).getByRole("button", { name: "导出" });
  fireEvent.click(confirmExport);
  fireEvent.click(confirmExport);

  expect((await screen.findByRole("dialog", { name: "正在处理文件" })).textContent).toContain(
    "正在生成并保存 PATDOC…",
  );
  expect(exportPatdoc).toHaveBeenCalledOnce();

  pending.resolve({
    ok: true,
    value: {
      sessionId: imported.sessionId,
      path: "C:\\exports\\导入案件.patdoc",
      displayName: "导入案件.patdoc",
      savedAt: "2026-09-02T00:00:00.000Z",
      previousVersionRetained: false,
    },
  });
  const report = await screen.findByRole("dialog", { name: "PATDOC 导出成功" });
  expect(within(report).getByText("C:\\exports\\导入案件.patdoc")).toBeDefined();
  await user.click(within(report).getByRole("button", { name: "确认" }));

  exportPatdoc.mockResolvedValueOnce({ ok: true, value: null });
  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "导出 PATDOC" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "导出专利文档" })).getByRole("button", {
      name: "导出",
    }),
  );
  await waitFor(() => expect(exportPatdoc).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog", { name: "PATDOC 导出成功" })).toBeNull();
});

test("imports a bundle in the library without opening document or DOCX preview", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  const importBundle = vi.fn(async () => ({ ok: true as const, value: { count: 2 } }));
  window.patentApi.patents.importBundle = importBundle;
  render(<App />);
  const library = await screen.findByRole("main", { name: "专利库" });
  await user.click(within(library).getByRole("button", { name: "导入" }));
  await user.click(screen.getByRole("menuitem", { name: "导入专利压缩包" }));
  const notice = await screen.findByRole("dialog", { name: "压缩包导入须知" });
  expect(importBundle).not.toHaveBeenCalled();
  await user.click(within(notice).getByRole("button", { name: "继续导入" }));
  await waitFor(() => expect(importBundle).toHaveBeenCalledOnce());
  await screen.findByText("已成功导入 2 项专利。");
  expect(screen.getByRole("main", { name: "专利库" })).toBeDefined();
  expect(window.patentApi.patents.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("main", { name: "专利编辑区" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: /DOCX.*导入/u })).toBeNull();
});

test.each(["PATDOC", "DOCX", "PDF"])(
  "blocks library %s export when an opened patent cannot be saved",
  async (format) => {
    const user = userEvent.setup();
    const { existing } = installPatentTrashTestApi({
      flushResult: { ok: false, error: { code: "INTERNAL", message: "保存失败测试" } },
    });
    render(<App />);
    await user.dblClick(await screen.findByRole("article", { name: existing.name! }));
    await screen.findByRole("tab", { name: existing.name! });
    await user.click(screen.getByRole("tab", { name: "专利库" }));
    const card = screen.getByRole("article", { name: existing.name! });
    await user.click(within(card).getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "导出" }));
    const dialog = await screen.findByRole("dialog", { name: "导出专利" });
    await user.click(within(dialog).getByRole("radio", { name: format }));
    await user.click(within(dialog).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(window.patentApi.patents.flush).toHaveBeenCalled());
    expect(window.patentApi.patents.exportPatdoc).not.toHaveBeenCalled();
    expect(exportPatentDocx).not.toHaveBeenCalled();
    expect(exportPatentPdf).not.toHaveBeenCalled();
  },
);

test("editing library settings preserves a closed patent's tab state", async () => {
  const user = userEvent.setup();
  const { existing } = installPatentTrashTestApi({});
  vi.mocked(window.patentApi.patents.updateSettings).mockImplementation(async (request) => ({
    ok: true,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision + 1,
      savedAt: "2026-09-05T00:00:00.000Z",
    },
  }));
  render(<App />);
  const card = await screen.findByRole("article", { name: existing.name! });
  await user.click(within(card).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "设置" }));
  const dialog = await screen.findByRole("dialog", { name: "专利设置" });
  await user.type(within(dialog).getByRole("textbox", { name: "专利名称" }), "修改");
  await user.click(within(dialog).getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "专利设置" })).toBeNull());
  expect(screen.queryByRole("tab", { name: /往复式夹具/ })).toBeNull();
  expect(window.patentApi.patents.release).toHaveBeenCalled();
});

function installPatentTrashTestApi(options: {
  flushResult?: Awaited<ReturnType<PatentApi["patents"]["flush"]>>;
  moveResult?: Awaited<ReturnType<PatentApi["patents"]["moveToTrash"]>>;
  additionalPatent?: Readonly<{
    summary: LibraryPatentSummary;
    opened: OpenedPatent;
  }>;
  firstOpenedOverride?: OpenedPatent;
}) {
  const existing = patentSummary("往复式夹具", 1);
  const firstOpened = options.firstOpenedOverride ?? openedPatent("往复式夹具", 1);
  const reopened = { ...openedPatent("往复式夹具", 1), sessionId: testUuid(899) };
  let trashed = false;
  const list = vi.fn<PatentApi["patents"]["list"]>(async (scope) => ({
    ok: true as const,
    value:
      scope === "active"
        ? trashed
          ? []
          : options.additionalPatent
            ? [existing, options.additionalPatent.summary]
            : [existing]
        : trashed
          ? [{ ...existing, deletedAt: "2026-08-02T08:00:00.000Z" }]
          : [],
  }));
  const open = vi
    .fn()
    .mockResolvedValueOnce({ ok: true as const, value: firstOpened })
    .mockResolvedValueOnce({
      ok: true as const,
      value: options.additionalPatent?.opened ?? reopened,
    });
  const flush = vi.fn(
    async (request) =>
      options.flushResult ?? {
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-02T08:00:00.000Z",
        },
      },
  );
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const moveToTrash = vi.fn(async () => {
    const result = options.moveResult ?? ({ ok: true as const, value: undefined } as const);
    if (result.ok) trashed = true;
    return result;
  });
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list,
    create: vi.fn(),
    open,
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    moveToTrash,
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release,
  };
  const flowchartList = vi.fn(async () => ({ ok: true as const, value: [] }));
  const flowchartProject = {
    projectId: testUuid(950),
    name: `${existing.name}-流程图1`,
    revision: 0,
    pageCount: 1,
    lastPageId: "page-1",
    sourceSha256: "A".repeat(64),
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: "2026-08-12T00:00:00.000Z",
  };
  const flowchartCreate = vi.fn(async () => ({
    ok: true as const,
    value: {
      project: flowchartProject,
      source: new TextEncoder().encode(
        '<mxfile><diagram id="page-1" name="第1页"><mxGraphModel/></diagram></mxfile>',
      ),
      patentRevision: firstOpened.patent.revision + 1,
    },
  }));
  const flowchartSave = vi.fn(async () => ({
    ok: true as const,
    value: {
      project: {
        ...flowchartProject,
        revision: flowchartProject.revision + 1,
        modifiedAt: "2026-08-12T00:01:00.000Z",
      },
      source: new TextEncoder().encode(
        '<mxfile><diagram id="page-1" name="第1页"><mxGraphModel/></diagram></mxfile>',
      ),
      patentRevision: firstOpened.patent.revision + 2,
    },
  }));
  window.patentApi.flowcharts = {
    list: flowchartList,
    create: flowchartCreate,
    importFile: vi.fn(),
    load: vi.fn(),
    save: flowchartSave,
    rename: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
    exportBackup: vi.fn(),
    renderPreview: vi.fn(),
    commitPreview: vi.fn(),
  } as unknown as PatentApi["flowcharts"];

  return {
    existing,
    firstOpened,
    flush,
    release,
    moveToTrash,
    open,
    list,
    flowchartList,
    flowchartCreate,
    flowchartSave,
  };
}

test("patent folder opens from the library, exports selected files and navigates to the selected book", async () => {
  const user = userEvent.setup();
  const { firstOpened } = installPatentTrashTestApi({});
  const exportFolder = vi.fn(async () => ({ok: true as const, value: null}));
  window.patentApi.patents.exportFolder = exportFolder;
  render(<App />);
  const card = await screen.findByRole("article", {name: "往复式夹具"});
  await user.click(within(card).getByRole("button", {name: "更多操作"}));
  await user.click(screen.getByRole("menuitem", {name: "打开文件夹"}));
  const folder = await screen.findByRole("dialog", {name: "往复式夹具"});
  await user.click(within(folder).getByRole("option", {name: /说明书摘要/u}));
  await user.selectOptions(within(folder).getByLabelText("导出格式"), "pdf");
  await user.click(within(folder).getByRole("button", {name: "导出所选"}));
  await waitFor(() => expect(exportFolder).toHaveBeenCalledWith({patentId: firstOpened.patentId, sessionId: firstOpened.sessionId, expectedRevision: firstOpened.revision, items: [{key: "book:abstract", format: "pdf"}], cad: []}));
  expect(within(folder).queryByText(/已成功导出/u)).toBeNull();
  await user.dblClick(within(folder).getByRole("option", {name: /说明书摘要/u}));
  await waitFor(() => expect(screen.queryByRole("dialog", {name: "往复式夹具"})).toBeNull());
  await waitFor(() => expect(screen.getByRole("tab", {name: "说明书摘要"}).getAttribute("aria-selected")).toBe("true"));
});

test.each(["text", "CAD标号", "插入流程图"])(
  "body search opens its result book instead of an already-open %s workspace",
  async (previous) => {
    const user = userEvent.setup();
    const { firstOpened } = installPatentTrashTestApi({});
    window.patentApi.contentSearch = {
      activity: vi.fn(),
      request: vi.fn(async () => ({
        ok: true as const,
        value: {
          enabled: true,
          running: false,
          completed: 1,
          total: 1,
          updatedAt: "2026-11-03T00:00:00Z",
          error: false,
          incomplete: false,
          indexPhase: "completed" as const,
          indexedCount: 1,
          indexVersion: "index-1",
          sourceVersion: "source-1",
          hits: [
            {
              patentId: firstOpened.patentId,
              books: [{ kind: "abstract" as const, count: 1, snippets: ["搜索目标文字"] }],
            },
          ],
        },
      })),
    };
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("tab", { name: "权利要求书" }));
    if (previous !== "text") await user.click(screen.getByRole("button", { name: previous }));
    await user.click(screen.getByRole("tab", { name: "专利库" }));
    const library = await screen.findByRole("main", { name: "专利库" });
    await user.click(within(library).getByRole("checkbox", { name: "搜索正文" }));
    await user.type(within(library).getByRole("searchbox"), "搜索目标");
    await user.click(await screen.findByRole("button", { name: "说明书摘要：搜索目标文字" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "说明书摘要" }).getAttribute("aria-selected")).toBe("true"),
    );
    expect(screen.queryByRole("main", { name: "流程图编辑工作区" })).toBeNull();
    expect(screen.queryByRole("region", { name: "CAD标号" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "编辑 说明书摘要" })).toBeDefined();
  },
);

test("returns to the patent library and highlights a restored snapshot clone", async () => {
  const user = userEvent.setup();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const { existing, list, open } = installPatentTrashTestApi({});
  const restoredDocumentId = testUuid(929);
  const restoredSummary = {
    ...patentSummary("往复式夹具（快照恢复 v4）", 429),
    modifiedAt: "2026-08-16T01:03:00.000Z",
  };
  (window.patentApi as PatentApi).snapshot = {
    status: vi.fn(),
    configure: vi.fn(),
    create: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 4,
        createdAt: "2026-08-16T01:02:03.000Z",
        source: "manual-create" as const,
      },
    })),
    preview: vi.fn(),
    previewAsset: vi.fn(),
    list: vi.fn(async () => ({
      ok: true as const,
      value: {
        entries: [
          {
            documentType: "patent" as const,
            documentId: testUuid(501),
            displayName: "往复式夹具",
            revision: 4,
            sizeBytes: 2048,
            createdAt: "2026-08-16T01:02:03.000Z",
            source: "manual-create" as const,
            status: "healthy" as const,
            errorMessage: null,
            deletable: true,
            contentSummary: null,
          },
        ],
        warnings: [],
      },
    })),
    restore: vi.fn(async () => ({
      ok: true as const,
      value: {
        documentType: "patent" as const,
        documentId: restoredDocumentId,
        displayName: restoredSummary.name ?? "恢复副本",
      },
    })),
    delete: vi.fn(),
  };
  render(<App />);

  expect(await screen.findByRole("article", { name: "往复式夹具" })).toBeDefined();
  await user.click(await screen.findByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "存储与备份" }));
  await user.click(within(settings).getByRole("button", { name: "快照版本" }));
  const snapshotManager = within(settings).getByRole("region", { name: "快照管理器" });
  await user.click(
    within(snapshotManager).getByRole("button", { name: /打开“往复式夹具”的快照历史/ }),
  );
  await user.click(within(snapshotManager).getByRole("button", { name: "恢复 v4" }));
  list.mockResolvedValueOnce({ ok: true as const, value: [existing, restoredSummary] });
  await user.click(within(settings).getByRole("button", { name: "确认恢复" }));

  await waitFor(() => expect(window.patentApi.snapshot.restore).toHaveBeenCalledOnce());

  const library = await screen.findByRole("main", { name: "专利库" });
  const restoredCard = await within(library).findByRole("article", {
    name: "往复式夹具（快照恢复 v4）",
  });
  expect(screen.queryByRole("dialog", { name: "快照管理器" })).toBeNull();
  await waitFor(() => expect(restoredCard.className).toContain("is-snapshot-restore-highlight"));
  expect(open).not.toHaveBeenCalledWith(restoredDocumentId);
  expect(screen.queryByRole("tab", { name: /快照恢复 v4/ })).toBeNull();
});

test("keeps snapshot management open when the restored clone cannot be refreshed", async () => {
  const user = userEvent.setup();
  const { existing, list, open } = installPatentTrashTestApi({});
  const restoredDocumentId = testUuid(929);
  (window.patentApi as PatentApi).snapshot = {
    status: vi.fn(),
    configure: vi.fn(),
    create: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 4,
        createdAt: "2026-08-16T01:02:03.000Z",
        source: "manual-create" as const,
      },
    })),
    preview: vi.fn(),
    previewAsset: vi.fn(),
    list: vi.fn(async () => ({
      ok: true as const,
      value: {
        entries: [
          {
            documentType: "patent" as const,
            documentId: existing.patentId,
            displayName: existing.name ?? "未命名专利",
            revision: 4,
            sizeBytes: 2048,
            createdAt: "2026-08-16T01:02:03.000Z",
            source: "manual-create" as const,
            status: "healthy" as const,
            errorMessage: null,
            deletable: true,
            contentSummary: null,
          },
        ],
        warnings: [],
      },
    })),
    restore: vi.fn(async () => ({
      ok: true as const,
      value: {
        documentType: "patent" as const,
        documentId: restoredDocumentId,
        displayName: "往复式夹具（快照恢复 v4）",
      },
    })),
    delete: vi.fn(),
  };

  render(<App />);
  expect(await screen.findByRole("article", { name: "往复式夹具" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  await user.click(within(settings).getByRole("button", { name: "存储与备份" }));
  await user.click(within(settings).getByRole("button", { name: "快照版本" }));
  const snapshotManager = within(settings).getByRole("region", { name: "快照管理器" });
  await user.click(
    within(snapshotManager).getByRole("button", { name: /打开“往复式夹具”的快照历史/ }),
  );
  await user.click(within(snapshotManager).getByRole("button", { name: "恢复 v4" }));
  list.mockResolvedValueOnce({
    ok: false as const,
    error: { code: "INTERNAL", message: "读取专利库失败" },
  });
  await user.click(within(settings).getByRole("button", { name: "确认恢复" }));

  await waitFor(() => expect(window.patentApi.snapshot.restore).toHaveBeenCalledOnce());

  const snapshotManagerDialog = within(settings).getByRole("region", { name: "快照管理器" });
  expect((await within(snapshotManagerDialog).findByRole("alert")).textContent).toContain(
    "恢复副本已创建，但专利库刷新失败",
  );
  expect(open).not.toHaveBeenCalledWith(restoredDocumentId);
  expect(screen.queryByRole("tab", { name: /快照恢复 v4/ })).toBeNull();
});

test("enters dual view with the active book on the left and a picker on the right", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "同屏双显" }));

  expect(maximizeWindow).toHaveBeenCalledOnce();
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  const initialDualZoom = leftPane.getAttribute("data-dual-zoom");
  expect(initialDualZoom).toMatch(/^\d+$/);
  expect(rightPane).toBeDefined();
  expect(within(workspace).getByRole("region", { name: "选择同屏文档" })).toBeDefined();
  expect(within(workspace).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();

  await user.click(within(rightPane).getByRole("button", { name: "权利要求书" }));
  expect(rightPane.getAttribute("data-dual-zoom")).toBe(initialDualZoom);
});

test("a second dual-view click cancels pending native preparation and permits a later entry", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  const pending = deferred<Awaited<ReturnType<PatentApi["application"]["maximizeWindow"]>>>();
  const originalResult = await maximizeWindow();
  maximizeWindow.mockClear();
  maximizeWindow.mockImplementationOnce(() => pending.promise);
  const toggle = screen.getByRole("button", { name: "同屏双显" });
  await user.click(toggle);
  await user.click(toggle);
  await act(async () => pending.resolve(originalResult));
  await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  await user.click(toggle);
  expect(await screen.findByRole("region", { name: "同屏双文档工作区" })).toBeDefined();
});

test("drags another five-book tab into single view and keeps the current document opposite", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "权利要求书" }), "left");

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · 权利要求书");
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · 说明书");
  expect(leftPane.getAttribute("data-active")).toBe("true");
  expect(screen.getByRole("tab", { name: "权利要求书" }).getAttribute("aria-selected")).toBe(
    "true",
  );
});

test("drags the current five-book tab to its requested side and opens a picker opposite", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "说明书" }), "right");

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  expect(within(leftPane).getByRole("region", { name: "选择同屏文档" })).toBeDefined();
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · 说明书");
  expect(rightPane.getAttribute("data-active")).toBe("true");
});

test("drags a background patent tab using that patent's last active book", async () => {
  const user = userEvent.setup();
  const additionalPatent = {
    summary: patentSummary("回收工艺", 2),
    opened: openedPatent("回收工艺", 2),
  };
  installPatentTrashTestApi({ additionalPatent });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await openPatentFromLibrary(user, "回收工艺");
  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "往复式夹具" }), "left");

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · 权利要求书");
  expect(paneTitle(rightPane, "右")).toBe("回收工艺 · 说明书");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "往复式夹具" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
});

test("replaces a dual pane and swaps panes when the dragged book is already opposite", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "说明书摘要" }), "left");

  let workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  let leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  let rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  await waitFor(() => expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · 说明书摘要"));
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · 说明书");

  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "说明书" }), "left");
  workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  await waitFor(() => expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · 说明书"));
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · 说明书摘要");
  expect(leftPane.getAttribute("data-active")).toBe("true");
});

test("keeps the target pane zoom when a dragged book replaces its document", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  await user.click(leftPane);
  await user.click(screen.getByRole("button", { name: "放大" }));
  const zoomBeforeReplacement = leftPane.getAttribute("data-dual-zoom");

  await dragPatentTabToWorkspace(screen.getByRole("tab", { name: "说明书摘要" }), "left");

  await waitFor(() => {
    const replacedLeftPane = within(workspace).getByRole("region", { name: "左侧文档" });
    expect(paneTitle(replacedLeftPane, "左")).toBe("往复式夹具 · 说明书摘要");
    expect(replacedLeftPane.getAttribute("data-dual-zoom")).toBe(zoomBeforeReplacement);
  });
});

test("retains registered editor selections before swapping panes from the header button", async () => {
  const user = userEvent.setup();
  const retainSelections = vi.spyOn(
    EditorCommandBus.prototype,
    "retainRegisteredSelectionsForNextRegistration",
  );
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  retainSelections.mockClear();

  await user.click(screen.getByRole("button", { name: "交换左右文档" }));

  expect(retainSelections).toHaveBeenCalledOnce();
});

test("cancels a tab drag released in the toolbar instead of changing the layout", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  const tab = screen.getByRole("tab", { name: "权利要求书" });
  const workspace = screen.getByTestId("patent-workspace-drop-region");
  workspace.getBoundingClientRect = () =>
    ({ left: 0, top: 160, right: 1200, bottom: 800, width: 1200, height: 640 }) as DOMRect;
  fireEvent.pointerDown(tab, { pointerId: 42, button: 0, clientX: 150, clientY: 85 });
  fireEvent.pointerMove(window, { pointerId: 42, buttons: 1, clientX: 300, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 42, clientX: 300, clientY: 100 });

  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
});

test("keeps the initial right-pane picker available from its header", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  const rightPane = within(
    await screen.findByRole("region", { name: "同屏双文档工作区" }),
  ).getByRole("region", { name: "右侧文档" });
  await user.click(
    within(rightPane).getAllByRole("button", { name: "切换右侧文档" })[1] as HTMLButtonElement,
  );

  expect(
    within(screen.getByRole("dialog", { name: "切换右侧文档" })).getByRole("region", {
      name: "选择同屏文档",
    }),
  ).toBeDefined();
});

test("keeps the initial body picker flow when opening another patent", async () => {
  const user = userEvent.setup();
  const additionalPatent = {
    summary: patentSummary("回收工艺", 2),
    opened: openedPatent("回收工艺", 2),
  };
  installPatentTrashTestApi({ additionalPatent });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  const rightPane = within(
    await screen.findByRole("region", { name: "同屏双文档工作区" }),
  ).getByRole("region", { name: "右侧文档" });
  await user.click(within(rightPane).getByRole("button", { name: "打开其他专利……" }));
  const libraryDialog = screen.getByRole("dialog", { name: "打开其他专利" });
  await user.click(await within(libraryDialog).findByRole("button", { name: "回收工艺" }));
  await user.click(within(libraryDialog).getByRole("button", { name: "打开所选专利" }));

  expect(
    within(rightPane).getByRole("button", { name: "回收工艺" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(within(rightPane).getByRole("list", { name: "回收工艺的文档" })).toBeDefined();
});

test("switches the right document from its header without replacing the pane with a picker", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  const switchTriggers = within(rightPane).getAllByRole("button", { name: "切换右侧文档" });
  await user.click(switchTriggers[1] as HTMLButtonElement);

  const switcher = screen.getByRole("dialog", { name: "切换右侧文档" });
  expect(within(switcher).queryByRole("button", { name: "权利要求书" })).toBeNull();
  expect(within(switcher).queryByRole("button", { name: "说明书" })).toBeNull();
  expect(within(switcher).getByRole("button", { name: "切换到另一侧的权利要求书" })).toBeDefined();
  await user.click(within(switcher).getByRole("button", { name: "说明书摘要" }));

  expect(within(rightPane).getByRole("textbox", { name: "编辑 说明书摘要" })).toBeDefined();
  expect(within(rightPane).queryByRole("region", { name: "选择同屏文档" })).toBeNull();
});

test("opens the existing patent library flow for the pane header switcher", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));

  const rightPane = within(
    await screen.findByRole("region", { name: "同屏双文档工作区" }),
  ).getByRole("region", { name: "右侧文档" });
  await user.click(
    within(rightPane).getAllByRole("button", { name: "切换右侧文档" })[1] as HTMLButtonElement,
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "切换右侧文档" })).getByRole("button", {
      name: "打开其他专利……",
    }),
  );

  expect(screen.getByRole("dialog", { name: "打开其他专利" })).toBeDefined();
});

test("keeps the pane document while opening another patent and switches only after choosing a book", async () => {
  const user = userEvent.setup();
  const additionalPatent = {
    summary: patentSummary("回收工艺", 2),
    opened: openedPatent("回收工艺", 2),
  };
  installPatentTrashTestApi({ additionalPatent });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  await user.click(
    within(rightPane).getAllByRole("button", { name: "切换右侧文档" })[1] as HTMLButtonElement,
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "切换右侧文档" })).getByRole("button", {
      name: "打开其他专利……",
    }),
  );
  const libraryDialog = screen.getByRole("dialog", { name: "打开其他专利" });
  await user.click(await within(libraryDialog).findByRole("button", { name: "回收工艺" }));
  await user.click(within(libraryDialog).getByRole("button", { name: "打开所选专利" }));

  expect(within(rightPane).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
  const switcher = await screen.findByRole("dialog", { name: "切换右侧文档" });
  expect(
    within(switcher).getByRole("button", { name: "回收工艺" }).getAttribute("aria-pressed"),
  ).toBe("true");
  const books = within(switcher).getByRole("list", { name: "回收工艺的文档" });
  await user.click(within(books).getByRole("button", { name: "权利要求书" }));

  expect(within(rightPane).getByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
  expect(within(rightPane).queryByRole("textbox", { name: "编辑 说明书" })).toBeNull();
});

test("resets an externally selected switcher patent when the header popup is reopened", async () => {
  const user = userEvent.setup();
  const additionalPatent = {
    summary: patentSummary("回收工艺", 2),
    opened: openedPatent("回收工艺", 2),
  };
  installPatentTrashTestApi({ additionalPatent });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const rightPane = within(
    await screen.findByRole("region", { name: "同屏双文档工作区" }),
  ).getByRole("region", { name: "右侧文档" });
  const dropdown = within(rightPane).getAllByRole("button", {
    name: "切换右侧文档",
  })[1] as HTMLButtonElement;
  await user.click(dropdown);
  await user.click(
    within(screen.getByRole("dialog", { name: "切换右侧文档" })).getByRole("button", {
      name: "打开其他专利……",
    }),
  );
  const libraryDialog = screen.getByRole("dialog", { name: "打开其他专利" });
  await user.click(await within(libraryDialog).findByRole("button", { name: "回收工艺" }));
  await user.click(within(libraryDialog).getByRole("button", { name: "打开所选专利" }));
  const switcher = await screen.findByRole("dialog", { name: "切换右侧文档" });
  expect(within(switcher).getByRole("list", { name: "回收工艺的文档" })).toBeDefined();

  await user.click(dropdown);
  await user.click(dropdown);

  const reopened = screen.getByRole("dialog", { name: "切换右侧文档" });
  expect(within(reopened).getByRole("list", { name: "往复式夹具的文档" })).toBeDefined();
  expect(within(rightPane).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
});

test("closes the left pane and keeps the right document in single mode", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  await user.click(screen.getByRole("button", { name: "关闭左侧文档" }));

  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
});

test("closes the right pane and keeps the left document in single mode", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  await user.click(screen.getByRole("button", { name: "关闭右侧文档" }));

  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
});

test("双击未激活窗格标题栏后以该文档退出双屏", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  fireEvent.pointerDown(rightPane);
  await waitFor(() => expect(rightPane.getAttribute("data-active")).toBe("true"));
  await user.click(screen.getByRole("button", { name: "放大" }));
  const rightZoom = Number(rightPane.getAttribute("data-dual-zoom"));
  fireEvent.pointerDown(leftPane);
  await waitFor(() => expect(leftPane.getAttribute("data-active")).toBe("true"));
  expect(rightPane.getAttribute("data-active")).toBe("false");

  fireEvent.doubleClick(rightPane.querySelector("header") as HTMLElement);

  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull(),
  );
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
  expect(
    screen.getByRole("button", { name: `缩放 ${DEFAULT_APP_SETTINGS.zoomPercent}%，点击重置` }),
  ).toBeDefined();
});

test("animates the main content when moving from the patent library into the editor", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;

  try {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
    render(<App />);

    await openPatentFromLibrary(user);

    await waitFor(() =>
      expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], {
        duration: 260,
        easing: "ease-in-out",
      }),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("opens trash as a modal without replacing the patent library", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "回收站" });
  const library = screen.getByRole("heading", { name: /专利库/ });
  await user.click(trigger);
  expect(await screen.findByRole("dialog", { name: "回收站" })).toBeDefined();
  expect(screen.getByRole("heading", { name: /专利库/ })).toBe(library);
  await user.click(screen.getByRole("button", { name: "关闭回收站" }));
  expect(screen.queryByRole("dialog", { name: "回收站" })).toBeNull();
  expect(screen.getByRole("heading", { name: /专利库/ })).toBe(library);
});

test("does not stack the fallback content motion onto the native library-editor crossfade", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;

  try {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    render(<App />);

    await openPatentFromLibrary(user);

    expect(animate).not.toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], {
      duration: 260,
      easing: "ease-in-out",
    });
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test.each(["CAD标号", "插入流程图"])("does not double animate %s closing to the library", async (tool) => {
  const originalAnimate = HTMLElement.prototype.animate;
  const stageAnimations = vi.fn();
  HTMLElement.prototype.animate = function (...args) {
    if (this.classList.contains("app-view-transition-stage")) stageAnimations(...args);
    return { cancel: vi.fn(), finished: Promise.resolve() } as unknown as Animation;
  };
  try {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("button", { name: tool }));
    stageAnimations.mockClear();
    await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
    await screen.findByRole("heading", { name: "专利库" });
    expect(stageAnimations).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("uses one two-phase workspace transition when entering dual view", async () => {
  vi.setSystemTime(new Date("2026-08-02T23:59:59Z"));
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  try {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    animate.mockClear();

    await user.click(screen.getByRole("button", { name: "同屏双显" }));

    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(-5px)" },
      ],
      { duration: 200, easing: "ease-in-out", fill: "forwards" },
    );
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: "translateY(7px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 200, easing: "ease-in-out", fill: "forwards" },
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    vi.useRealTimers();
  }
});

test("restores a background document selection when that document is added to dual view", async () => {
  const user = userEvent.setup();
  const registerEditor = vi.spyOn(EditorCommandBus.prototype, "register");
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  let backgroundEditor = registerEditor.mock.calls.find(([editorId]) =>
    editorId.endsWith(":claims"),
  )?.[1];
  await waitFor(() => {
    backgroundEditor = registerEditor.mock.calls.find(([editorId]) =>
      editorId.endsWith(":claims"),
    )?.[1];
    expect(backgroundEditor).toBeDefined();
  });
  if (!backgroundEditor) throw new Error("权利要求书编辑器未注册。");
  act(() => {
    backgroundEditor?.commands.setTextSelection({ from: 2, to: 7 });
  });

  await user.click(screen.getByRole("tab", { name: "说明书" }));
  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  await user.click(within(workspace).getByRole("button", { name: "权利要求书" }));

  let replacementEditor = registerEditor.mock.calls
    .filter(([editorId]) => editorId.endsWith(":claims"))
    .at(-1)?.[1];
  await waitFor(() => {
    replacementEditor = registerEditor.mock.calls
      .filter(([editorId]) => editorId.endsWith(":claims"))
      .at(-1)?.[1];
    expect(replacementEditor).toBe(backgroundEditor);
  });
  expect(replacementEditor?.state.selection).toMatchObject({ from: 2, to: 7, empty: false });
  registerEditor.mockRestore();
});

test("uses the reverse two-phase workspace transition when returning to single view", async () => {
  vi.setSystemTime(new Date("2026-08-02T23:59:59Z"));
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  try {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("button", { name: "同屏双显" }));
    animate.mockClear();

    await user.click(screen.getByRole("button", { name: "同屏双显" }));

    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(7px)" },
      ],
      { duration: 200, easing: "ease-in-out", fill: "forwards" },
    );
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: "translateY(-5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 200, easing: "ease-in-out", fill: "forwards" },
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    vi.useRealTimers();
  }
});

test("opens a fixed claims and description pair without preserving the current book", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书摘要" }));
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));

  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  expect(within(workspace).getByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
  expect(within(workspace).getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
  expect(within(workspace).queryByRole("textbox", { name: "编辑 说明书摘要" })).toBeNull();
});

test("enters dual-document mode at 1280px with constrained function rails", async () => {
  const user = userEvent.setup();
  const narrowLayout = { isMaximized: true, contentWidth: 1280, contentHeight: 800 };
  getWindowLayoutState.mockResolvedValue({ ok: true, value: narrowLayout });
  maximizeWindow.mockResolvedValue({ ok: true, value: narrowLayout });
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "同屏双显" }));

  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
  expect(await screen.findByRole("region", { name: "同屏双文档工作区" })).toBeDefined();
  expect(screen.getAllByRole("button", { name: "展开功能栏" })).toHaveLength(1);
});

test("keeps a pinned single-document function rail when switching books", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  await user.click(screen.getByRole("button", { name: "固定" }));
  expect(screen.getByRole("button", { name: "取消固定" })).toBeDefined();

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  expect(await screen.findByRole("button", { name: "取消固定" })).toBeDefined();
});

test("recreates normal docked pane rails without overlay controls after re-entering dual view", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  useWideDualViewWindow();
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  expect(
    within(leftPane).getByRole("complementary", { name: "权利要求书全局功能栏" }),
  ).toBeDefined();
  expect(within(leftPane).queryByRole("button", { name: "固定" })).toBeNull();
  expect(within(leftPane).queryByRole("button", { name: "收起功能栏" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));

  const reopened = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const reopenedLeft = within(reopened).getByRole("region", { name: "左侧文档" });
  const reopenedRight = within(reopened).getByRole("region", { name: "右侧文档" });
  expect(within(reopenedLeft).queryByRole("button", { name: "固定" })).toBeNull();
  expect(within(reopenedRight).queryByRole("button", { name: "固定" })).toBeNull();
  expect(within(reopenedLeft).queryByRole("button", { name: "收起功能栏" })).toBeNull();
  expect(within(reopenedRight).queryByRole("button", { name: "收起功能栏" })).toBeNull();
});

test("returns to the active document when a dual-view window is restored", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  fireEvent.pointerDown(rightPane);
  const zoom = Number(rightPane.getAttribute("data-dual-zoom"));

  act(() => {
    windowLayoutListener?.({ isMaximized: false, contentWidth: 1280, contentHeight: 720 });
  });

  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull(),
  );
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
  expect(
    screen.getByRole("button", { name: `缩放 ${DEFAULT_APP_SETTINGS.zoomPercent}%，点击重置` }),
  ).toBeDefined();
});

test("keeps the find and replace session across the three text patent books", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  await user.click(screen.getByRole("button", { name: "替换" }));
  await user.type(screen.getByRole("textbox", { name: "查找内容" }), "技术领域");
  await user.type(screen.getByRole("textbox", { name: "替换为" }), "电芯");
  await user.click(screen.getByRole("checkbox", { name: "区分大小写" }));

  await user.click(screen.getByRole("tab", { name: "说明书" }));
  expect(screen.getByRole("search", { name: "查找和替换" })).toBeDefined();
  const descriptionEditor = screen.getByRole("textbox", { name: "编辑 说明书" });
  await waitFor(() => expect(document.activeElement).toBe(descriptionEditor));
  expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
    "技术领域",
  );
  expect((screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement).value).toBe("电芯");
  expect((screen.getByRole("checkbox", { name: "区分大小写" }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(await screen.findByText("0/2")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "下一个" }));
  await waitFor(() => expect(screen.getByText("1/2")).toBeDefined());
  await waitFor(() => expect(document.activeElement).toBe(descriptionEditor));
  expect(window.getSelection()?.toString()).toBe("技术领域");

  await user.clear(screen.getByRole("textbox", { name: "查找内容" }));
  await user.type(screen.getByRole("textbox", { name: "查找内容" }), "公开了一种");

  await user.click(screen.getByRole("tab", { name: "说明书摘要" }));
  expect(screen.getByRole("search", { name: "查找和替换" })).toBeDefined();
  expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
    "公开了一种",
  );
  expect((screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement).value).toBe("电芯");
  expect((screen.getByRole("checkbox", { name: "区分大小写" }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(await screen.findByText("0/1")).toBeDefined();
});

test("hides find and replace for drawing books and restores it on return", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "查找" }));
  await user.type(screen.getByRole("textbox", { name: "查找内容" }), "冷却机构");

  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  await waitFor(() => expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull());
  await user.click(screen.getByRole("tab", { name: "摘要附图" }));
  await waitFor(() => expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull());

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  expect(screen.getByRole("search", { name: "查找和替换" })).toBeDefined();
  expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
    "冷却机构",
  );
});

test.each(["查找", "替换"] as const)(
  "fills the selected keyword when opening %s from the toolbar",
  async (mode) => {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    const registerEditor = vi.spyOn(EditorCommandBus.prototype, "register");
    render(<App />);

    await openPatentFromLibrary(user);
    let editor = registerEditor.mock.calls.at(-1)?.[1];
    await waitFor(() => {
      editor = registerEditor.mock.calls.at(-1)?.[1];
      expect(editor).toBeDefined();
    });
    if (!editor) throw new Error("权利要求书编辑器未注册。");
    const selectedEditor = editor;
    const selections: Array<{ from: number; to: number; text: string }> = [];
    selectedEditor.state.doc.descendants((node, position) => {
      if (selections.length > 0 || !node.isText || !node.text?.trim()) return true;
      const text = node.text.slice(0, 4);
      selections.push({ from: position, to: position + text.length, text });
      return false;
    });
    const selection = selections[0];
    if (!selection) throw new Error("测试专利的权利要求书缺少可选文字。");
    act(() => {
      selectedEditor.commands.setTextSelection(selection);
    });

    await user.click(screen.getByRole("button", { name: mode }));

    expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe(
      selection.text,
    );
    registerEditor.mockRestore();
  },
);

test("clears the complete find and replace draft when the panel closes", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "替换" }));
  await user.type(screen.getByRole("textbox", { name: "查找内容" }), "冷却机构");
  await user.type(screen.getByRole("textbox", { name: "替换为" }), "散热机构");
  await user.click(screen.getByRole("checkbox", { name: "区分大小写" }));
  await user.click(screen.getByRole("checkbox", { name: "全字匹配" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "查找方式" }), "regex");

  await user.click(screen.getByRole("button", { name: "关闭查找" }));
  await waitFor(() => expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull());
  await user.click(screen.getByRole("button", { name: "替换" }));

  expect((screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("checkbox", { name: "区分大小写" }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect((screen.getByRole("checkbox", { name: "全字匹配" }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect((screen.getByRole("combobox", { name: "查找方式" }) as HTMLSelectElement).value).toBe(
    "literal",
  );
});

test("toggles the active find mode with its shortcut and switches modes in place", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  const editor = screen.getByRole("textbox", { name: "编辑 说明书" });
  fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
  const query = screen.getByRole("textbox", { name: "查找内容" });

  fireEvent.keyDown(query, { key: "h", ctrlKey: true });
  expect(screen.getByRole("textbox", { name: "替换为" })).toBeDefined();

  fireEvent.keyDown(screen.getByRole("textbox", { name: "替换为" }), {
    key: "h",
    ctrlKey: true,
  });
  await waitFor(() => expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull());
  expect(screen.getByRole("button", { name: "展开功能栏" })).toBeDefined();
});

test("closes find before collapsing the complete function rail", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑 说明书" }), {
    key: "f",
    ctrlKey: true,
  });
  expect(screen.getByRole("search", { name: "查找和替换" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "收起功能栏" }));

  await waitFor(() => expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull());
  expect(screen.getByRole("button", { name: "展开功能栏" })).toBeDefined();
});

test("keeps the find and replace layout isolated inside the patent tools", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "替换" }));
  const panel = screen.getByRole("search", { name: "查找和替换" });

  expect(panel.closest(".patent-book-tools")).toBeNull();
});

test("routes toolbar capabilities to the pane activated by one pointer action", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／图" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });

  expect(screen.getByRole("combobox", { name: "段落样式" })).toBeDefined();
  expect(screen.getByRole("combobox", { name: "段落样式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  fireEvent.pointerDown(rightPane);
  // 附图侧没有正文排版：工具不再消失，而是留在原位置灰。
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "段落样式" }).getAttribute("aria-disabled")).toBe(
      "true",
    ),
  );
  fireEvent.pointerDown(leftPane);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "段落样式" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
});

test("keeps find attached to the pane that opened it and restores that editor bookmark on close", async () => {
  const user = userEvent.setup();
  useWideDualViewWindow();
  const setup = installPatentTrashTestApi({});
  const bookmark = { from: 2, to: 5 };
  const captureSelection = vi
    .spyOn(EditorCommandBus.prototype, "captureSelection")
    .mockReturnValue(bookmark);
  const restoreSelection = vi
    .spyOn(EditorCommandBus.prototype, "restoreSelection")
    .mockReturnValue(true);
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  await user.click(screen.getByRole("button", { name: "查找" }));
  expect(captureSelection).toHaveBeenCalledWith(`${setup.firstOpened.sessionId}:claims`);
  expect(within(leftPane).getByRole("search", { name: "查找和替换" })).toBeDefined();
  expect(within(rightPane).queryByRole("search", { name: "查找和替换" })).toBeNull();

  fireEvent.pointerDown(rightPane);
  await waitFor(() => expect(rightPane.getAttribute("data-active")).toBe("true"));
  expect(within(leftPane).getByRole("search", { name: "查找和替换" })).toBeDefined();
  expect(within(rightPane).queryByRole("search", { name: "查找和替换" })).toBeNull();

  await user.click(within(leftPane).getByRole("button", { name: "关闭查找" }));
  await waitFor(() =>
    expect(restoreSelection).toHaveBeenCalledWith(
      `${setup.firstOpened.sessionId}:claims`,
      bookmark,
    ),
  );
  await waitFor(() =>
    expect(
      within(leftPane).getByRole("complementary", { name: "权利要求书全局功能栏" }),
    ).toBeDefined(),
  );
  expect(within(leftPane).queryByRole("button", { name: "收起功能栏" })).toBeNull();

  fireEvent.pointerDown(rightPane);
  await waitFor(() => expect(rightPane.getAttribute("data-active")).toBe("true"));
  await user.click(screen.getByRole("button", { name: "替换" }));
  expect(within(rightPane).getByRole("textbox", { name: "替换为" })).toBeDefined();
  expect(within(leftPane).queryByRole("search", { name: "查找和替换" })).toBeNull();

  captureSelection.mockRestore();
  restoreSelection.mockRestore();
});

test("does not open find for a pane without a text editor", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／图" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  fireEvent.pointerDown(within(workspace).getByRole("region", { name: "右侧文档" }));
  // 附图侧没有文本编辑器：查找按钮留在工具栏里但不可用，快捷键也不该打开查找栏。
  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  await waitFor(() =>
    expect(
      within(toolbar).getByRole("button", { name: "查找" }).getAttribute("aria-disabled"),
    ).toBe("true"),
  );
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull();
});

test("retargets an editor shortcut but keeps panel mode switches on the current find target", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });

  await user.click(screen.getByRole("button", { name: "查找" }));
  fireEvent.pointerDown(rightPane);
  await waitFor(() => expect(rightPane.getAttribute("data-active")).toBe("true"));
  fireEvent.keyDown(within(rightPane).getByRole("textbox", { name: "编辑 说明书" }), {
    key: "h",
    ctrlKey: true,
  });
  expect(within(leftPane).queryByRole("search", { name: "查找和替换" })).toBeNull();
  expect(within(rightPane).getByRole("textbox", { name: "替换为" })).toBeDefined();

  fireEvent.pointerDown(leftPane);
  await waitFor(() => expect(leftPane.getAttribute("data-active")).toBe("true"));
  await user.click(within(rightPane).getByRole("button", { name: "查找" }));
  expect(within(rightPane).getByRole("search", { name: "查找和替换" })).toBeDefined();
  expect(within(leftPane).queryByRole("search", { name: "查找和替换" })).toBeNull();
});

test("changes only the active pane zoom and restores the single-document zoom on exit", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  const initialLeftZoom = Number(leftPane.getAttribute("data-dual-zoom"));
  const initialRightZoom = Number(rightPane.getAttribute("data-dual-zoom"));

  await user.click(screen.getByRole("button", { name: "放大" }));
  expect(Number(leftPane.getAttribute("data-dual-zoom"))).toBe(initialLeftZoom + 10);
  expect(Number(rightPane.getAttribute("data-dual-zoom"))).toBe(initialRightZoom);

  fireEvent.pointerDown(rightPane);
  await waitFor(() => expect(rightPane.getAttribute("data-active")).toBe("true"));
  await user.click(screen.getByRole("button", { name: "放大" }));
  expect(Number(leftPane.getAttribute("data-dual-zoom"))).toBe(initialLeftZoom + 10);
  expect(Number(rightPane.getAttribute("data-dual-zoom"))).toBe(initialRightZoom + 10);

  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  expect(await screen.findByRole("button", { name: "缩放 100%，点击重置" })).toBeDefined();
});

test("wheel zoom targets an inactive pane while shortcuts still target the active pane", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const left = within(workspace).getByRole("region", { name: "左侧文档" });
  const right = within(workspace).getByRole("region", { name: "右侧文档" });
  fireEvent.pointerDown(right);
  const leftBefore = Number(left.getAttribute("data-dual-zoom"));
  const rightBefore = Number(right.getAttribute("data-dual-zoom"));
  fireEvent.wheel(left.querySelector(".editor-workspace")!, { deltaY: -12, ctrlKey: true });
  await waitFor(() =>
    expect(Number(left.getAttribute("data-dual-zoom"))).toBeGreaterThan(leftBefore),
  );
  expect(Number(right.getAttribute("data-dual-zoom"))).toBe(rightBefore);
  expect(right.getAttribute("data-active")).toBe("true");
  fireEvent.keyDown(window, { key: "=", ctrlKey: true });
  await waitFor(() => expect(Number(right.getAttribute("data-dual-zoom"))).toBe(rightBefore + 10));
});

test("retains manual zoom while it fits and clamps both state and status when a pane shrinks", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  const observers: { callback: () => void; targets: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly targets: Element[] = [];
      readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const leftPane = within(workspace).getByRole("region", { name: "左侧文档" });
  const viewport = leftPane.querySelector<HTMLElement>(".patent-editor-workspace");
  const page = leftPane.querySelector<HTMLElement>(".patent-page-zoom-frame");
  if (!viewport || !page) throw new Error("左侧窗格缺少文档视图");
  const observer = [...observers].reverse().find((entry) => entry.targets.includes(viewport));
  if (!observer) throw new Error("左侧窗格没有接入分栏缩放上限");
  Object.defineProperty(page, "offsetWidth", { configurable: true, value: 820 });
  const setPaneWidth = (width: number) => {
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: width });
  };

  const narrowWidth = 600;
  const wideWidth = 1400;
  // Choosing a scale ends automatic fitting.
  for (let step = 0; step < 4; step += 1) {
    await user.click(screen.getByRole("button", { name: "放大" }));
  }
  const storedZoom = Number(leftPane.getAttribute("data-dual-zoom"));

  setPaneWidth(wideWidth);
  act(() => observer.callback());
  expect(Number(leftPane.getAttribute("data-dual-zoom"))).toBe(storedZoom);
  // A narrower pane clamps at its own compact-control boundary.
  setPaneWidth(narrowWidth);
  act(() => observer.callback());
  const cappedZoom = dualPaneZoomLimit(narrowWidth, 820);
  expect(
    screen.getByRole("button", { name: `缩放 ${Math.round(cappedZoom)}%，点击重置` }),
  ).toBeDefined();
  expect(Number(leftPane.getAttribute("data-dual-zoom"))).toBeCloseTo(cappedZoom);
  expect((screen.getByRole("button", { name: "放大" }) as HTMLButtonElement).disabled).toBe(true);

  setPaneWidth(wideWidth);
  act(() => observer.callback());
  expect(Number(leftPane.getAttribute("data-dual-zoom"))).toBeCloseTo(cappedZoom);
});

test.each(["success", "cancel", "failure", "save-cancel"] as const)(
  "batch trash patents: %s",
  async (outcome) => {
    const user = userEvent.setup();
    const second = {
      ...patentSummary("第二项夹具", 2),
      createdAt: "2026-08-01T00:30:00.000Z",
      modifiedAt: "2026-08-01T00:30:00.000Z",
    };
    const third = {
      ...patentSummary("第三项夹具", 3),
      createdAt: "2026-08-01T00:00:00.000Z",
      modifiedAt: "2026-08-01T00:00:00.000Z",
    };
    const setup = installPatentTrashTestApi({
      additionalPatent: { summary: second, opened: openedPatent("第二项夹具", 2) },
      ...(outcome === "save-cancel"
        ? {
            flushResult: {
              ok: false as const,
              error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
            },
          }
        : {}),
    });
    const removed = new Set<string>();
    setup.list.mockImplementation(async (scope) => ({
      ok: true,
      value: [setup.existing, second, third].filter((p) =>
        scope === "active" ? !removed.has(p.patentId) : removed.has(p.patentId),
      ),
    }));
    window.patentApi.patents.moveToTrash = vi.fn<PatentApi["patents"]["moveToTrash"]>(
      async (id) => {
        if (outcome === "failure" && id === second.patentId)
          return { ok: false, error: { code: "DISK_FULL", message: "磁盘空间不足" } };
        removed.add(id);
        return { ok: true, value: undefined };
      },
    );
    vi.mocked(appDialogs.confirmAppAction).mockResolvedValue(outcome !== "cancel");
    if (outcome === "save-cancel")
      vi.mocked(appDialogs.confirmAppAction).mockResolvedValueOnce(true).mockResolvedValue(false);
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    if (outcome === "success")
      vi.mocked(appDialogs.confirmAppAction).mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveConfirmation = resolve;
          }),
      );
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("tab", { name: "专利库" }));
    const library = screen.getByRole("main", { name: "专利库" });
    await user.click(within(library).getByRole("button", { name: "导出" }));
    expect(within(library).getByRole("button", { name: "批量删除" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(within(library).getByRole("button", { name: "全选当前筛选专利" }));
    await user.click(within(library).getByRole("button", { name: "批量删除" }));
    if (outcome === "success") {
      const busyButton = screen.getByRole("button", { name: "正在删除…" });
      expect(busyButton).toHaveProperty("disabled", true);
      await user.dblClick(busyButton);
      expect(appDialogs.confirmAppAction).toHaveBeenCalledTimes(1);
      await act(async () => resolveConfirmation?.(true));
    }
    await waitFor(() =>
      expect(appDialogs.confirmAppAction).toHaveBeenCalledWith(
        "确定将所选的 3 项专利移入回收站吗？可在回收站恢复。",
      ),
    );
    if (outcome === "save-cancel") {
      await waitFor(() =>
        expect(appDialogs.showAppAlert).toHaveBeenCalledWith(
          "批量删除已停止。已移入回收站 0 项，其余 3 项未删除。",
        ),
      );
      expect(window.patentApi.patents.moveToTrash).not.toHaveBeenCalled();
      expect(setup.release).not.toHaveBeenCalled();
    } else if (outcome === "cancel") {
      expect(window.patentApi.patents.moveToTrash).not.toHaveBeenCalled();
      expect(setup.flush).not.toHaveBeenCalled();
      expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
    } else {
      await waitFor(() =>
        expect(window.patentApi.patents.moveToTrash).toHaveBeenCalledTimes(
          outcome === "success" ? 3 : 2,
        ),
      );
      expect(setup.flush.mock.invocationCallOrder[0]).toBeLessThan(
        setup.release.mock.invocationCallOrder[0] ?? 0,
      );
      expect(setup.release.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(window.patentApi.patents.moveToTrash).mock.invocationCallOrder[0] ?? 0,
      );
      expect(removed.size).toBe(outcome === "success" ? 3 : 1);
      if (outcome === "failure") {
        expect(window.patentApi.patents.moveToTrash).not.toHaveBeenCalledWith(third.patentId);
        expect(appDialogs.showAppAlert).toHaveBeenCalledWith(
          "批量删除已停止。已移入回收站 1 项，其余 2 项未删除。",
        );
      }
      if (outcome === "success")
        await waitFor(() =>
          expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull(),
        );
    }
  },
);

test.each(["success", "cancel", "failure"] as const)(
  "single trash during multi-select: %s",
  async (outcome) => {
    const user = userEvent.setup();
    const second = patentSummary("第二项夹具", 2);
    const setup = installPatentTrashTestApi({
      additionalPatent: { summary: second, opened: openedPatent("第二项夹具", 2) },
    });
    const removed = new Set<string>();
    setup.list.mockImplementation(async (scope) => ({
      ok: true,
      value: [setup.existing, second].filter((p) =>
        scope === "active" ? !removed.has(p.patentId) : removed.has(p.patentId),
      ),
    }));
    window.patentApi.patents.moveToTrash = vi.fn<PatentApi["patents"]["moveToTrash"]>(
      async (id) => {
        if (outcome === "failure")
          return { ok: false, error: { code: "DISK_FULL", message: "磁盘空间不足" } };
        removed.add(id);
        return { ok: true, value: undefined };
      },
    );
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    vi.mocked(appDialogs.confirmAppAction).mockClear();
    vi.mocked(appDialogs.confirmAppAction).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    render(<App />);
    const firstCard = await screen.findByRole("article", { name: "往复式夹具" });
    await user.click(screen.getByRole("button", { name: "导出" }));
    await user.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
    await user.click(within(firstCard).getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("button", { name: "导出所选（2）" })).toHaveProperty("disabled", true);
    const remainingCard = screen.getByRole("article", { name: "第二项夹具" });
    await user.click(within(remainingCard).getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(appDialogs.confirmAppAction).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await act(async () => resolveConfirmation?.(outcome !== "cancel"));
    expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
    const expectedCount = outcome === "success" ? 1 : 2;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `导出所选（${expectedCount}）` })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(screen.getByRole("checkbox", { name: "选择 第二项夹具" })).toHaveProperty(
      "checked",
      true,
    );
    if (outcome === "success") {
      expect(screen.queryByRole("article", { name: "往复式夹具" })).toBeNull();
      expect(window.patentApi.patents.moveToTrash).toHaveBeenCalledExactlyOnceWith(
        setup.existing.patentId,
      );
    } else {
      expect(screen.getByRole("checkbox", { name: "选择 往复式夹具" })).toHaveProperty(
        "checked",
        true,
      );
      if (outcome === "cancel") expect(window.patentApi.patents.moveToTrash).not.toHaveBeenCalled();
    }
  },
);

test("flushes and releases an open patent before moving it to trash", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await deletePatentFromLibrary(user);

  await waitFor(() => expect(setup.moveToTrash).toHaveBeenCalledWith(setup.existing.patentId));
  expect(setup.flush.mock.invocationCallOrder[0]).toBeLessThan(
    setup.release.mock.invocationCallOrder[0] ?? 0,
  );
  expect(setup.release.mock.invocationCallOrder[0]).toBeLessThan(
    setup.moveToTrash.mock.invocationCallOrder[0] ?? 0,
  );
});

test("routes the toolbar save command to the active patent aggregate", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() =>
    expect(setup.flush).toHaveBeenCalledWith({
      patentId: setup.firstOpened.patentId,
      expectedRevision: setup.firstOpened.revision,
    }),
  );
  expect(snapshotCreate).toHaveBeenCalledOnce();
  expect(snapshotCreate).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: setup.firstOpened.patentId,
    source: "manual-save",
  });
  const notice = await screen.findByText("已保存，并成功创建快照");
  expect(notice.closest("[role='status']")?.className).toContain("operation-feedback is-success");
});

test("routes menu Save and Ctrl+S through the same single explicit-save path", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "保存" }));
  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledTimes(1));

  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledTimes(2));
  expect(snapshotCreate).toHaveBeenNthCalledWith(2, {
    documentType: "patent",
    documentId: setup.firstOpened.patentId,
    source: "manual-save",
  });
  expect(await screen.findByText("已保存，并成功创建快照")).toBeDefined();
});

test("manual save feedback waits until the snapshot is successfully created", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  const pendingSnapshot = deferred<Awaited<ReturnType<PatentApi["snapshot"]["create"]>>>();
  snapshotCreate.mockReturnValueOnce(pendingSnapshot.promise);
  render(<App />);
  await openPatentFromLibrary(user);

  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
  expect(screen.queryByText("已保存，并成功创建快照")).toBeNull();

  await act(async () => {
    pendingSnapshot.resolve({
      ok: true,
      value: {
        outcome: "created",
        revision: 0,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "manual-save",
      },
    });
  });
  expect(await screen.findByText("已保存，并成功创建快照")).toBeDefined();
});

test("manual save feedback truthfully reports an existing snapshot", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  snapshotCreate.mockResolvedValueOnce({
    ok: true,
    value: {
      outcome: "already-exists",
      revision: 0,
      createdAt: "2026-08-16T08:00:00.000Z",
      source: "automatic",
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);

  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(await screen.findByText("已保存，当前版本已有快照")).toBeDefined();
  expect(screen.queryByText("已保存，并成功创建快照")).toBeNull();
});

test("manual save feedback never reports snapshot success after a failure", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  snapshotCreate.mockResolvedValueOnce({
    ok: false,
    error: { code: "INTERNAL", message: "快照磁盘空间不足" },
  });
  render(<App />);
  await openPatentFromLibrary(user);

  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(await screen.findByRole("alertdialog", { name: "手动保存快照创建失败" })).toBeDefined();
  expect(screen.queryByText("已保存，并成功创建快照")).toBeNull();
  expect(screen.queryByText("已保存，当前版本已有快照")).toBeNull();
});

test("dropping DWG on a patent document opens CAD markup and imports its bytes", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  const prepareCad = vi.fn(async (_request: unknown) => ({
    ok: false as const,
    error: { code: "INVALID_INPUT" as const, message: "测试转换失败" },
  }));
  window.patentApi.assets.prepareCad = prepareCad as typeof window.patentApi.assets.prepareCad;
  render(<App />);
  await openPatentFromLibrary(user);
  const file = {
    name: "drop.dwg",
    type: "",
    size: 6,
    arrayBuffer: async () => new TextEncoder().encode("AC1032").buffer,
  } as File;
  fireEvent.drop(screen.getByTestId("app-shell"), {
    dataTransfer: { files: [file], types: ["Files"] },
  });
  await screen.findByRole("region", { name: "CAD标号" });
  await waitFor(() => expect(prepareCad).toHaveBeenCalledOnce());
  expect(prepareCad.mock.calls[0]?.[0]).toMatchObject({
    originalName: "drop.dwg",
    format: "dwg",
  });
  const request = prepareCad.mock.calls[0]?.[0] as { bytes: Uint8Array };
  expect(Array.from(request.bytes)).toEqual([65, 67, 49, 48, 51, 50]);
  await screen.findByText("测试转换失败");
});

test("opens CAD markup from the description drawings function rail", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  const tools = await screen.findByRole("group", { name: "说明书附图工具" });
  await user.click(within(tools).getByRole("button", { name: "CAD标号" }));
  expect(screen.getByRole("region", { name: "CAD标号" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("true");
});

test("cycles Ctrl+Tab through books and the open CAD markup tab", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);

  // 打开 CAD 标号工作区，其标签应参与 Ctrl+Tab 循环。
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("true");

  // CAD标号 → 前进一站回到第一本五书（权利要求书）。
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "权利要求书" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
  expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("false");

  // 权利要求书 → 反向一站回到 CAD 标号标签。
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("true"),
  );
  expect(screen.getByRole("tab", { name: "权利要求书" }).getAttribute("aria-selected")).toBe(
    "false",
  );
});

test("queues rapid Ctrl+Tab presses so each press advances one document", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  expect(screen.getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe("true");

  // 快速连按两次（不等待上一次切换完成）：说明书 → 说明书附图 → 说明书摘要。
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });

  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "说明书摘要" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
  expect(screen.getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe("false");
});

test("Ctrl+S inside drawing workspace reaches the global manual-save snapshot path once", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  fireEvent.keyDown(screen.getByRole("region", { name: "CAD标号" }), { key: "s", ctrlKey: true });
  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
  expect(snapshotCreate).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: setup.firstOpened.patentId,
    source: "manual-save",
  });
  expect(setup.flush.mock.invocationCallOrder[0]).toBeLessThan(
    snapshotCreate.mock.invocationCallOrder[0] ?? 0,
  );
});

test("Ctrl+S flushes an active embedded flowchart before creating one patent snapshot", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  expect(await screen.findByRole("main", { name: "流程图编辑工作区" })).toBeDefined();

  fireEvent.keyDown(window, { key: "s", ctrlKey: true });

  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
  expect(snapshotCreate).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: setup.firstOpened.patentId,
    source: "manual-save",
  });
});

test("routes an embedded flowchart save action to one manual patent snapshot", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("流程图 iframe 未创建 contentWindow。");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  const configure = await waitFor(() => {
    const message = postMessage.mock.calls
      .map(([candidate]) => candidate)
      .find(
        (candidate): candidate is Record<string, unknown> =>
          typeof candidate === "object" && candidate !== null && candidate.type === "configure",
      );
    if (!message) throw new Error("流程图 iframe 未收到 configure 消息。");
    return message;
  });

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "patent-diagram://editor",
        source: frame.contentWindow,
        data: {
          sessionId: configure.sessionId,
          projectId: configure.projectId,
          projectRevision: configure.projectRevision,
          requestId: "iframe-save",
          type: "toolbar-action",
          action: "save",
          actionId: "toolbar-action-app-save",
        },
      }),
    );
  });

  await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
  expect(snapshotCreate).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: setup.firstOpened.patentId,
    source: "manual-save",
  });
});

test("updates remaining toolbar structural capabilities for the active patent book", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);

  expect(screen.getByRole("button", { name: "插入表格" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "插入数学公式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "插入化学方程式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "插入化学结构式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));

  expect(screen.getByRole("button", { name: "插入表格" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "插入数学公式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "插入化学方程式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "插入化学结构式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
});

test("keeps each visited text editor mounted after switching books", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  const descriptionEditor = screen.getByRole("textbox", { name: "编辑 说明书" });

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  const claimsEditor = screen.getByRole("textbox", { name: "编辑 权利要求书" });
  expect(descriptionEditor.isConnected).toBe(true);

  await user.click(screen.getByRole("tab", { name: "说明书" }));
  expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBe(descriptionEditor);
  expect(claimsEditor.isConnected).toBe(true);

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  expect(screen.getByRole("textbox", { name: "编辑 权利要求书" })).toBe(claimsEditor);
});

test("greys out text editing tools instead of hiding them on both patent drawing books", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  expect(screen.getByRole("combobox", { name: "段落样式" })).toBeDefined();

  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  expect(screen.getByRole("button", { name: "保存" })).toBeDefined();
  expect(screen.getByRole("button", { name: "撤销" }).getAttribute("aria-disabled")).toBe("true");
  // 图标要留在原位、只是置灰：不再从无障碍树里消失。
  for (const name of ["段落样式", "字体", "字号"]) {
    expect(screen.getByRole("combobox", { name }).getAttribute("aria-disabled")).toBe("true");
  }
  for (const name of ["粗体", "插入表格", "查找", "本地检查"]) {
    expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
  }
  expect(screen.getByRole("button", { name: "更多工具" })).toBeDefined();
  const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
  for (const label of ["插入数学公式", "插入物理公式", "插入化学方程式", "插入化学结构式"]) {
    expect(within(toolbar).getAllByRole("button", { name: label })).toHaveLength(1);
    expect(within(toolbar).getByRole("button", { name: label }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  }
  await user.click(within(toolbar).getByRole("button", { name: "插入数学公式" }));
  expect(await screen.findByRole("dialog", { name: "插入数学公式" })).toBeDefined();
  const formulaField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  formulaField.value = "x^2";
  fireEvent.input(formulaField);
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "插入数学公式" })).toBeNull();

  await user.click(within(toolbar).getByRole("button", { name: "插入数学公式" }));
  const reopenedFormulaField = screen.getByRole("textbox", {
    name: "可视公式编辑器",
  }) as HTMLElement & { value: string };
  expect(reopenedFormulaField.value).toBe("x^2");
  await user.click(screen.getByRole("button", { name: "取消" }));

  await user.click(screen.getByRole("tab", { name: "摘要附图" }));
  expect(screen.getByRole("button", { name: "撤销" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("button", { name: "重做" }).getAttribute("title")).toBe(
    "当前没有可重做的操作。\n重做（Ctrl+Y / Ctrl+Shift+Z）",
  );
  expect(screen.getByRole("combobox", { name: "段落样式" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "更多工具" })).toBeDefined();
  expect(screen.getByRole("button", { name: "插入数学公式" }).getAttribute("aria-disabled")).toBe(
    "true",
  );

  await user.click(screen.getByRole("tab", { name: "权利要求书" }));
  expect(screen.getByRole("combobox", { name: "段落样式" })).toBeDefined();
  expect(screen.getByRole("combobox", { name: "段落样式" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
});

test("returns to the patent library after closing the last open patent", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));

  expect(await screen.findByRole("heading", { name: "专利库" })).toBeDefined();
});

test.each([
  { differentPatent: false, sameBatch: false },
  { differentPatent: true, sameBatch: false },
  { differentPatent: true, sameBatch: true },
])(
  "keeps a patent opened during the last patent's pending close visible (different patent: $differentPatent, same batch: $sameBatch)",
  async ({ differentPatent, sameBatch }) => {
    const user = userEvent.setup();
    const name = differentPatent ? "新打开的夹具" : "往复式夹具";
    const setup = installPatentTrashTestApi(
      differentPatent
        ? { additionalPatent: { summary: patentSummary(name, 2), opened: openedPatent(name, 2) } }
        : {},
    );
    const pendingSnapshot = deferred<Awaited<ReturnType<PatentApi["snapshot"]["create"]>>>();
    const pendingOpen = deferred<Awaited<ReturnType<PatentApi["patents"]["open"]>>>();
    if (sameBatch) {
      setup.open
        .mockReset()
        .mockResolvedValueOnce({ ok: true, value: setup.firstOpened })
        .mockReturnValueOnce(pendingOpen.promise);
    }
    snapshotCreate.mockReturnValueOnce(pendingSnapshot.promise);
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
    await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("tab", { name: "专利库" }));
    await openPatentFromLibrary(user, name);
    await act(async () => {
      if (sameBatch) pendingOpen.resolve({ ok: true, value: openedPatent(name, 2) });
      pendingSnapshot.resolve({
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "patent-close",
        },
      });
    });
    await waitFor(() => expect(setup.release).toHaveBeenCalledWith(setup.firstOpened.sessionId));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
      expect(screen.getByRole("tab", { name: "专利库" }).getAttribute("aria-selected")).toBe(
        "false",
      );
    });
    expect(setup.release).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { tool: "CAD标号", cancel: false },
  { tool: "流程图", cancel: false },
  { tool: "CAD标号", cancel: true },
  { tool: "流程图", cancel: true },
])(
  "shows the library while $tool closes safely in the background (cancel: $cancel)",
  async ({ tool, cancel }) => {
    const user = userEvent.setup();
    const setup = installPatentTrashTestApi({});
    const pendingSnapshot = deferred<Awaited<ReturnType<PatentApi["snapshot"]["create"]>>>();
    snapshotCreate.mockReturnValueOnce(pendingSnapshot.promise);
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(
      screen.getByRole("button", {
        name: tool === "流程图" ? "插入流程图" : tool,
      }),
    );
    const regionName = tool === "流程图" ? "流程图编辑工作区" : tool;
    const role = tool === "流程图" ? "main" : "region";
    await screen.findByRole(role, { name: regionName });
    const workspace = screen.getByRole(role, { name: regionName });
    await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
    await waitFor(() => expect(snapshotCreate).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "专利库" })).toBeDefined();
    expect(screen.queryByRole(role, { name: regionName })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "编辑 说明书" })).toBeNull();
    expect(setup.release).not.toHaveBeenCalled();
    expect(workspace.isConnected).toBe(true);
    expect(workspace.closest("[inert]")).not.toBeNull();
    await act(async () => {
      pendingSnapshot.resolve(
        cancel
          ? {
              ok: false,
              error: { code: "INTERNAL", message: "测试快照失败" },
            }
          : {
              ok: true,
              value: {
                outcome: "created",
                revision: 0,
                createdAt: "2026-08-16T08:00:00.000Z",
                source: "patent-close",
              },
            },
      );
    });
    if (cancel) {
      await user.click(await screen.findByRole("button", { name: "取消关闭" }));
      await waitFor(() => expect(workspace.closest("[inert]")).toBeNull());
      expect(screen.getByRole(role, { name: regionName })).toBe(workspace);
      expect(screen.queryByRole("textbox", { name: "编辑 说明书" })).toBeNull();
      expect(setup.release).not.toHaveBeenCalled();
      return;
    }
    await screen.findByRole("heading", { name: "专利库" });
    expect(setup.release).toHaveBeenCalledOnce();
    expect(screen.queryByRole(role, { name: regionName })).toBeNull();
  },
);

test("refreshes the patent library summary after closing the last open patent", async () => {
  const user = userEvent.setup();
  const staleSummary = { ...patentSummary("往复式夹具", 1), revision: 0 };
  const freshSummary = {
    ...staleSummary,
    revision: 1,
    modifiedAt: "2026-08-02T08:10:00.000Z",
  };
  const opened = openedPatent("往复式夹具", 1);
  opened.revision = 1;
  opened.patent.revision = 1;
  const list = vi.fn(async (scope: "active" | "trash") => ({
    ok: true as const,
    value:
      scope === "active" ? (list.mock.calls.length === 1 ? [staleSummary] : [freshSummary]) : [],
  }));
  const flush = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-02T08:10:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list,
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  render(<App />);

  expect(await screen.findByText(formatModifiedAt(staleSummary.modifiedAt))).toBeDefined();
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));

  expect(await screen.findByRole("heading", { name: "专利库" })).toBeDefined();
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.getByText(formatModifiedAt(freshSummary.modifiedAt))).toBeDefined();
});

test("moves an open patent to trash after confirmed discard when its close flush fails", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({
    flushResult: { ok: false, error: { code: "DISK_FULL", message: "磁盘空间不足" } },
  });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await deletePatentFromLibrary(user);

  await waitFor(() => expect(setup.moveToTrash).toHaveBeenCalled());
  expect(setup.flush).toHaveBeenCalled();
  expect(setup.release).toHaveBeenCalled();
  expect(screen.queryByRole("tab", { name: "往复式夹具" })).toBeNull();
});

test("flushes a hidden dirty flowchart before moving its open patent to trash", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("流程图 iframe 未创建 contentWindow。");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  const configure = await waitFor(() => {
    const message = postMessage.mock.calls
      .map(([candidate]) => candidate)
      .find(
        (candidate): candidate is Record<string, unknown> =>
          typeof candidate === "object" && candidate !== null && candidate.type === "configure",
      );
    if (!message) throw new Error("流程图 iframe 未收到 configure 消息。");
    return message;
  });
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "patent-diagram://editor",
        source: frame.contentWindow,
        data: {
          sessionId: configure.sessionId,
          projectId: configure.projectId,
          projectRevision: configure.projectRevision,
          requestId: "dirty-before-trash",
          type: "changed",
        },
      }),
    );
  });

  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await deletePatentFromLibrary(user);
  const saveRequest = await waitFor(() => {
    const message = postMessage.mock.calls
      .map(([candidate]) => candidate)
      .find(
        (candidate): candidate is Record<string, unknown> =>
          typeof candidate === "object" && candidate !== null && candidate.type === "request-save",
      );
    if (!message) throw new Error("关闭专利前未请求保存流程图源文件。");
    return message;
  });
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "patent-diagram://editor",
        source: frame.contentWindow,
        data: {
          sessionId: saveRequest.sessionId,
          projectId: saveRequest.projectId,
          projectRevision: saveRequest.projectRevision,
          requestId: saveRequest.requestId,
          type: "autosave",
          source:
            '<mxfile><diagram id="page-1" name="第1页"><mxGraphModel modified="1"/></diagram></mxfile>',
        },
      }),
    );
  });

  await waitFor(() => expect(setup.moveToTrash).toHaveBeenCalledOnce());
  expect(setup.flowchartSave).toHaveBeenCalledOnce();
  expect(setup.release).toHaveBeenCalledOnce();
  expect(setup.flowchartSave.mock.invocationCallOrder[0]).toBeLessThan(
    setup.release.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

test("reopens an originally open patent when moving it to trash fails after close", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({
    moveResult: { ok: false, error: { code: "INTERNAL", message: "回收失败" } },
  });
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await deletePatentFromLibrary(user);

  await waitFor(() => expect(setup.open).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("main", { name: "专利编辑区" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "往复式夹具" })).toBeDefined();
});

function installPatentTrashViewTestApi() {
  const trashed = {
    ...patentSummary("待恢复夹具", 3),
    deletedAt: "2026-08-02T08:00:00.000Z",
  };
  let visibleInTrash = true;
  const list = vi.fn(async (scope: "active" | "trash") => ({
    ok: true as const,
    value: scope === "trash" && visibleInTrash ? [trashed] : [],
  }));
  const restore = vi.fn(async () => {
    visibleInTrash = false;
    return { ok: true as const, value: undefined };
  });
  const permanentlyDelete = vi.fn(async () => {
    visibleInTrash = false;
    return { ok: true as const, value: undefined };
  });
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list,
    create: vi.fn(),
    open: vi.fn(),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore,
    permanentlyDelete,
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(),
  };
  return { trashed, restore, permanentlyDelete };
}

test("restores a patent from the visible patent trash view", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashViewTestApi();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "回收站" }));
  await user.click(await screen.findByRole("checkbox", { name: "选择 待恢复夹具" }));
  await user.click(screen.getByRole("button", { name: "恢复" }));

  await waitFor(() => expect(setup.restore).toHaveBeenCalledWith(setup.trashed.patentId));
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: "选择 待恢复夹具" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "回收站" })).toBeDefined();
});

test("requires confirmation before permanently deleting a patent from trash", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashViewTestApi();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "回收站" }));
  await user.click(await screen.findByRole("checkbox", { name: "选择 待恢复夹具" }));
  await user.click(screen.getByRole("button", { name: "永久删除" }));

  expect(appDialogs.confirmAppAction).toHaveBeenCalledWith(
    "永久删除“待恢复夹具”？此操作不可恢复。",
  );
  await waitFor(() => expect(setup.permanentlyDelete).toHaveBeenCalledWith(setup.trashed.patentId));
});

function installPatentCloseTestApi(options: {
  flushResult: Awaited<ReturnType<PatentApi["patents"]["flush"]>>;
}) {
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const prepareCloseListeners: Array<(token: string) => void> = [];
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(async () => options.flushResult),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  window.patentApi.application.onPrepareClose = vi.fn((listener) => {
    prepareCloseListeners.push(listener);
    return vi.fn();
  });
  window.patentApi.application.closeResult = closeResult;
  return { closeResult, opened, prepareCloseListeners };
}

test("waits for both save providers and replies once when application close succeeds", async () => {
  const user = userEvent.setup();
  const token = testUuid(901);
  const setup = installPatentCloseTestApi({
    flushResult: {
      ok: true,
      value: {
        patentId: testUuid(501),
        revision: 0,
        flushedAt: "2026-08-02T08:00:00.000Z",
      },
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);

  await act(async () => {
    for (const listener of setup.prepareCloseListeners) listener(token);
  });

  await waitFor(() => expect(setup.closeResult).toHaveBeenCalledWith({ token, proceed: true }));
  expect(setup.closeResult).toHaveBeenCalledTimes(1);
  expect(snapshotCreate).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: setup.opened.patentId,
    source: "application-close",
  });
});

test("does not let an empty legacy provider bypass a patent close failure", async () => {
  const user = userEvent.setup();
  const token = testUuid(902);
  const setup = installPatentCloseTestApi({
    flushResult: {
      ok: false,
      error: { code: "DISK_FULL", message: "磁盘空间不足" },
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);

  await act(async () => {
    for (const listener of setup.prepareCloseListeners) listener(token);
  });

  await waitFor(() => expect(setup.closeResult).toHaveBeenCalledWith({ token, proceed: false }));
  expect(setup.closeResult).toHaveBeenCalledTimes(1);
  expect(setup.closeResult).not.toHaveBeenCalledWith({ token, proceed: true });
});

test("acknowledges a repeated application close token only once", async () => {
  const user = userEvent.setup();
  const token = testUuid(903);
  const setup = installPatentCloseTestApi({
    flushResult: {
      ok: true,
      value: {
        patentId: testUuid(501),
        revision: 0,
        flushedAt: "2026-08-02T08:00:00.000Z",
      },
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);

  await act(async () => {
    for (const listener of setup.prepareCloseListeners) {
      listener(token);
      listener(token);
    }
  });

  await waitFor(() => expect(setup.closeResult).toHaveBeenCalledTimes(1));
  expect(setup.closeResult).toHaveBeenCalledWith({ token, proceed: true });
});

test.each([
  ["CAD标号", "CAD标号", "left", null],
  ["插入流程图", "流程图 / 电路图", "right", "flowchart"],
  ["电路图", "流程图 / 电路图", "left", "circuit"],
] as const)(
  "drags the %s toolbar entry into dual view without opening it first",
  async (label, title, side, mode) => {
    const user = userEvent.setup();
    const setup = installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    const button = screen.getByRole("button", { name: label });
    await dragPatentTabToWorkspace(button, side);
    // Real browsers emit a click after pointer-up on the captured source.
    fireEvent.click(button);

    const workspace = screen.getByTestId("patent-workspace-drop-region");
    const toolPane = await within(workspace).findByRole("region", {
      name: side === "left" ? "左侧文档" : "右侧文档",
    });
    const otherSide = side === "left" ? "right" : "left";
    const bookPane = within(workspace).getByRole("region", {
      name: otherSide === "left" ? "左侧文档" : "右侧文档",
    });
    expect(paneTitle(toolPane, side === "left" ? "左" : "右")).toBe(`往复式夹具 · ${title}`);
    expect(paneTitle(bookPane, otherSide === "left" ? "左" : "右")).toBe("往复式夹具 · 说明书");
    expect(toolPane.getAttribute("data-active")).toBe("true");
    if (mode) {
      const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
      if (!frame.contentWindow) throw new Error("missing flowchart frame");
      const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
      fireEvent.load(frame);
      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "set-editor-mode", mode }),
          "patent-diagram://editor",
        ),
      );
      expect(setup.flowchartCreate).toHaveBeenCalledTimes(1);
      // Re-dropping the same tool swaps panes, rather than creating another editor/project.
      await dragPatentTabToWorkspace(screen.getByRole("button", { name: label }), otherSide);
      await waitFor(() =>
        expect(paneTitle(bookPane, otherSide === "left" ? "左" : "右")).toBe(
          `往复式夹具 · ${title}`,
        ),
      );
      expect(setup.flowchartCreate).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.getByRole("region", { name: "CAD标号" })).toBeDefined();
      expect(setup.flowchartCreate).not.toHaveBeenCalled();
    }
  },
);

test.each(["CAD标号", "插入流程图", "电路图"])(
  "cancels the %s toolbar drag without opening a tool",
  async (label) => {
    const user = userEvent.setup();
    const setup = installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    const button = screen.getByRole("button", { name: label });
    const workspace = screen.getByTestId("patent-workspace-drop-region");
    workspace.getBoundingClientRect = () =>
      ({ left: 0, top: 160, right: 1200, bottom: 800, width: 1200, height: 640 }) as DOMRect;
    fireEvent.pointerDown(button, { pointerId: 41, button: 0, clientX: 150, clientY: 85 });
    fireEvent.pointerMove(window, { pointerId: 41, buttons: 1, clientX: 900, clientY: 400 });
    await screen.findByTestId("workspace-tab-drop-right");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 41, clientX: 900, clientY: 400 });
    fireEvent.click(button);
    expect(screen.queryByRole("tab", { name: "CAD标号" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull();
    expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
    expect(setup.flowchartCreate).not.toHaveBeenCalled();
  },
);

test("does not launch a toolbar tool when dual view cannot be opened", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  maximizeWindow.mockResolvedValue({
    ok: false,
    error: { code: "INTERNAL", message: "窗口不可用" },
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await dragPatentTabToWorkspace(screen.getByRole("button", { name: "电路图" }), "right");
  await waitFor(() =>
    expect(appDialogs.showAppAlert).toHaveBeenCalledWith("无法最大化窗口，请重试。"),
  );
  expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull();
  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  expect(setup.flowchartCreate).not.toHaveBeenCalled();
});

test("accepts a different custom preset during entering motion while deduplicating the same intent", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({
      customDualViewPresets: [
        { leftBookKind: "description", rightBookKind: "drawing-markup" },
        { leftBookKind: "flowchart", rightBookKind: "drawing-markup" },
      ],
    }),
  });
  render(<App />);
  await openPatentFromLibrary(user);
  const originalAnimate = HTMLElement.prototype.animate;
  const entering = deferred<void>();
  let stageAnimations = 0;
  HTMLElement.prototype.animate = function () {
    const isStage = this.classList.contains("app-view-transition-stage");
    if (isStage) stageAnimations += 1;
    const held = isStage && stageAnimations === 2;
    return {
      finished: held ? entering.promise : Promise.resolve(),
      cancel: () => { if (held) entering.resolve(); },
    } as unknown as Animation;
  };
  try {
    await user.click(screen.getByRole("button", { name: "说明书｜CAD标号" }));
    const left = await screen.findByRole("region", { name: "左侧文档" });
    expect(paneTitle(left, "左")).toBe("往复式夹具 · 说明书");
    expect(stageAnimations).toBe(2);
    await user.click(screen.getByRole("button", { name: "说明书｜CAD标号" }));
    expect(stageAnimations).toBe(2);
    await user.click(screen.getByRole("button", { name: "流程图 / 电路图｜CAD标号" }));
    await waitFor(() => expect(paneTitle(left, "左")).toBe("往复式夹具 · 流程图 / 电路图"));
    expect(stageAnimations).toBe(4);
    expect(await screen.findAllByRole("main", { name: "流程图编辑工作区" })).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "CAD标号" })).toHaveLength(1);
  } finally {
    await act(async () => entering.resolve());
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("does not initialize custom preset tools when dual view cannot be opened", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  readSettings.mockResolvedValue({
    ok: true,
    value: appSettingsFixture({
      customDualViewPresets: [{ leftBookKind: "flowchart", rightBookKind: "drawing-markup" }],
    }),
  });
  maximizeWindow.mockResolvedValue({
    ok: false,
    error: { code: "INTERNAL", message: "窗口不可用" },
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "流程图 / 电路图｜CAD标号" }));
  await waitFor(() =>
    expect(appDialogs.showAppAlert).toHaveBeenCalledWith("无法最大化窗口，请重试。"),
  );
  expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "CAD标号" })).toBeNull();
  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
  expect(setup.flowchartCreate).not.toHaveBeenCalled();
});

test.each([
  ["description", "flowchart", "说明书", "流程图 / 电路图"],
  ["flowchart", "description", "流程图 / 电路图", "说明书"],
  ["description", "drawing-markup", "说明书", "CAD标号"],
  ["drawing-markup", "description", "CAD标号", "说明书"],
  ["flowchart", "drawing-markup", "流程图 / 电路图", "CAD标号"],
  ["drawing-markup", "flowchart", "CAD标号", "流程图 / 电路图"],
] as const)(
  "activates restored custom preset %s / %s with one host per tool",
  async (leftBookKind, rightBookKind, leftLabel, rightLabel) => {
    const user = userEvent.setup();
    const setup = installPatentTrashTestApi({});
    readSettings.mockResolvedValue({
      ok: true,
      value: appSettingsFixture({ customDualViewPresets: [{ leftBookKind, rightBookKind }] }),
    });
    render(<App />);
    await openPatentFromLibrary(user);
    await user.click(screen.getByRole("button", { name: `${leftLabel}｜${rightLabel}` }));
    const leftPane = await screen.findByRole("region", { name: "左侧文档" });
    const rightPane = screen.getByRole("region", { name: "右侧文档" });
    expect(paneTitle(leftPane, "左")).toBe(`往复式夹具 · ${leftLabel}`);
    expect(paneTitle(rightPane, "右")).toBe(`往复式夹具 · ${rightLabel}`);
    if (leftBookKind === "drawing-markup" || rightBookKind === "drawing-markup") {
      expect(await screen.findAllByRole("region", { name: "CAD标号" })).toHaveLength(1);
    }
    if (leftBookKind === "flowchart" || rightBookKind === "flowchart") {
      expect(await screen.findAllByRole("main", { name: "流程图编辑工作区" })).toHaveLength(1);
      await waitFor(() => expect(setup.flowchartCreate).toHaveBeenCalledOnce());
      expect(setup.flowchartList).toHaveBeenCalledWith(setup.existing.patentId);
    }
  },
);

test("drags book and CAD markup tabs into a split while CAD markup owns the single screen", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);

  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("true");

  // CAD标号 独占单屏时落点容器是被隐藏标准工作区的父级主视图。
  const stage = screen.getByTestId("patent-workspace-drop-region").parentElement;
  if (!stage) throw new Error("missing main view stage");

  // 内嵌 CAD标号 时其它书册标签仍要能拖动进双屏同显，且 CAD标号 要留在另一侧。
  await dragPatentTabToRegion(screen.getByRole("tab", { name: "说明书" }), "right", stage);

  const workspace = screen.getByTestId("patent-workspace-drop-region");
  const leftPane = await within(workspace).findByRole("region", { name: "左侧文档" });
  const rightPane = within(workspace).getByRole("region", { name: "右侧文档" });
  expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · CAD标号");
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · 说明书");

  // CAD标号 标签本身也参与拖动：拖到已经放着 CAD标号 的对侧应交换两栏。
  await dragPatentTabToRegion(screen.getByRole("tab", { name: "CAD标号" }), "right", workspace);

  await waitFor(() => expect(paneTitle(leftPane, "左")).toBe("往复式夹具 · 说明书"));
  expect(paneTitle(rightPane, "右")).toBe("往复式夹具 · CAD标号");
});

test("opens the flowchart as a closable embedded tab for the active patent", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入流程图" }));

  expect(await screen.findByRole("main", { name: "流程图编辑工作区" })).toBeDefined();
  expect(screen.getByTestId("app-shell")).toBeDefined();
  const splitControls = screen.getByRole("group", { name: "同屏双显控制" });
  const flowchartTab = screen.getByRole("tab", { name: "流程图" });
  expect(
    splitControls.compareDocumentPosition(flowchartTab) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(flowchartTab.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe("false");
  expect(screen.queryByRole("button", { name: "返回说明书附图" })).toBeNull();
  expect(screen.queryByRole("toolbar", { name: "常用工具" })).toBeNull();
  expect(setup.flowchartList).toHaveBeenCalledWith(setup.existing.patentId);
  expect(setup.flowchartCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      patentId: setup.existing.patentId,
      name: `${setup.existing.name}-流程图1`,
    }),
  );

  await user.click(screen.getByRole("button", { name: "关闭流程图" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull());
  expect(screen.getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe("true");
});

test("keeps drawing and flowchart tabs independently available while switching books", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  const drawing = screen.getByRole("region", { name: "CAD标号" });
  expect(screen.queryByRole("dialog", { name: "CAD标号" })).toBeNull();
  expect(screen.getByRole("tab", { name: "CAD标号" }).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  expect(await screen.findByRole("main", { name: "流程图编辑工作区" })).toBeDefined();
  expect(drawing.closest("[hidden]")).not.toBeNull();
  await user.click(screen.getByRole("tab", { name: "CAD标号" }));
  expect(drawing.closest("[hidden]")).toBeNull();
  expect(screen.getByRole("tab", { name: "流程图" }).getAttribute("aria-selected")).toBe("false");
  await user.click(screen.getByRole("tab", { name: "流程图" }));
  await user.click(screen.getByRole("button", { name: "关闭流程图" }));
  expect(screen.getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("tab", { name: "CAD标号" }));
  await user.click(screen.getByRole("button", { name: "关闭CAD标号" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "CAD标号" })).toBeNull());
});

test("hides patent-owned tool tabs in the library and restores them in the patent", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await user.dblClick(await screen.findByRole("article", { name: "往复式夹具" }));
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  expect(await screen.findByRole("tab", { name: "流程图" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "CAD标号" })).toBeDefined();

  await user.click(screen.getByRole("tab", { name: "专利库" }));
  expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "CAD标号" })).toBeNull();

  await user.click(screen.getByRole("tab", { name: /往复式夹具/u }));
  expect(screen.getByRole("tab", { name: "流程图" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "CAD标号" })).toBeDefined();
});

test("opens circuit mode from the toolbar action following the drawing tools", async () => {
  const user = userEvent.setup();
  const setup = installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);

  const flowchartButton = screen.getByRole("button", { name: "插入流程图" });
  const cadButton = screen.getByRole("button", { name: "CAD标号" });
  const imageButton = screen.getByRole("button", { name: "插入图片" });
  const circuitButton = screen.getByRole("button", { name: "电路图" });
  expect(screen.getByRole("button", { name: "插入表格" }).nextElementSibling).toBe(imageButton);
  expect(cadButton.nextElementSibling).toBe(flowchartButton);
  expect(flowchartButton.nextElementSibling).toBe(circuitButton);
  await user.click(circuitButton);

  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("流程图 iframe 未创建 contentWindow。");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  await waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-editor-mode", mode: "circuit" }),
      "patent-diagram://editor",
    ),
  );
  expect(setup.flowchartList).toHaveBeenCalledWith(setup.existing.patentId);
});

test("closes an owning flowchart tab before closing and reopening its patent", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  await screen.findByRole("tab", { name: "流程图" });

  await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
  await screen.findByRole("heading", { name: "专利库" });
  await openPatentFromLibrary(user);

  expect(screen.queryByRole("tab", { name: "流程图" })).toBeNull();
  expect(screen.getByRole("main", { name: "专利编辑区" })).toBeDefined();
});

test("explains that a patent is required when the flowchart menu action has none", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "插入" }));
  await user.click(screen.getByRole("menuitem", { name: "插入流程图" }));

  expect(appDialogs.showAppAlert).toHaveBeenCalledWith("请先打开或新建专利后再插入流程图。");
  expect(screen.queryByRole("main", { name: "流程图编辑工作区" })).toBeNull();

  vi.mocked(appDialogs.showAppAlert).mockClear();
  await user.click(screen.getByRole("menuitem", { name: "插入电路图" }));
  expect(appDialogs.showAppAlert).toHaveBeenCalledWith("请先打开或新建专利后再插入电路图。");
});

test.each(["DOCX", "PDF", "PATDOC"] as const)(
  "opens %s export without requesting a document inspection",
  async (format) => {
    const user = userEvent.setup();
    installPatentTrashTestApi({});
    render(<App />);
    await openPatentFromLibrary(user);
    const inspectionRequests = vi.spyOn(TestInspectionWorker.prototype, "postMessage");
    inspectionRequests.mockClear();
    try {
      await chooseToolbarExport(user, format);
      expect(
        inspectionRequests.mock.calls.filter(
          ([request]) => "mode" in request && request.mode === "full",
        ),
      ).toEqual([]);
      const dialog = await screen.findByRole("dialog", { name: "导出专利文档" });
      expect(within(dialog).queryByRole("region", { name: "导出前检查" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "导出" })).toBeDefined();
      expect(
        inspectionRequests.mock.calls.filter(
          ([request]) => "mode" in request && request.mode === "full",
        ),
      ).toEqual([]);
      await user.click(within(dialog).getByRole("button", { name: "取消" }));
      expect(exportPatentDocx).not.toHaveBeenCalled();
      expect(exportPatentPdf).not.toHaveBeenCalled();
    } finally {
      inspectionRequests.mockRestore();
    }
  },
);

test("exports the active patent as a combined DOCX in patent mode", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const flush = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-01T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);

  await openPatentFromLibrary(user);
  await chooseToolbarExport(user, "DOCX");
  const exportDialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  await user.click(within(exportDialog).getByRole("button", { name: /^(?:导出|仍导出草稿)$/u }));

  expect(flush).toHaveBeenCalledWith({
    patentId: opened.patentId,
    expectedRevision: 0,
  });
  expect(exportPatentDocx).toHaveBeenCalledWith({
    sessionId: opened.sessionId,
    patentId: opened.patentId,
    expectedRevision: 0,
    mode: "combined",
    suggestedName: "往复式夹具（新型）",
  });
  expect(exportPatentDocx.mock.calls[0]?.[0]).not.toHaveProperty("patent");
  expect(exportDocx).not.toHaveBeenCalled();
  expect(await screen.findByText("C:\\exports\\五书合并导出.docx")).toBeDefined();
});

test("exports the active patent as a combined PDF in patent mode", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const flush = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-01T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(async () => ({
      ok: true as const,
      value: { patentId: testUuid(501), backupCreated: true as const },
    })),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    exportPatdoc: vi.fn(async () => ({ ok: true as const, value: null })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);

  await openPatentFromLibrary(user);
  await chooseToolbarExport(user, "PDF");
  const exportDialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  const fileNameInput = within(exportDialog).getByRole("textbox", { name: "文件名称" });
  await user.clear(fileNameInput);
  await user.type(fileNameInput, "自定义导出名");
  await user.click(within(exportDialog).getByRole("button", { name: /^(?:导出|仍导出草稿)$/u }));

  expect(flush).toHaveBeenCalledWith({
    patentId: opened.patentId,
    expectedRevision: 0,
  });
  expect(exportPatentPdf).toHaveBeenCalledWith({
    sessionId: opened.sessionId,
    patentId: opened.patentId,
    expectedRevision: 0,
    mode: "combined",
    suggestedName: "自定义导出名",
  });
  expect(exportPatentPdf.mock.calls[0]?.[0]).not.toHaveProperty("patent");
  expect(exportPdf).not.toHaveBeenCalled();
  expect(await screen.findByText("C:\\exports\\五书合并导出.pdf")).toBeDefined();
});

test("hides retired auxiliary documents without removing historical data", async () => {
  const user = userEvent.setup();
  const existing = patentSummary("往复式夹具", 1);
  const opened = openedPatent("往复式夹具", 1);
  const source = opened.patent.books.find((book) => book.kind === "description");
  if (!source) throw new Error("description fixture missing");
  const auxiliaryDocumentId = testUuid(990);
  opened.patent.auxiliaryDocuments.push({
    auxiliaryDocumentId,
    title: "实验记录",
    document: {
      ...structuredClone(source.document),
      documentId: testUuid(991),
      title: "实验记录",
    },
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
    sourceFileName: "实验记录.docx",
  });
  const flush = vi.fn(async (request) => ({
    ok: true as const,
    value: {
      patentId: request.patentId,
      revision: request.expectedRevision,
      flushedAt: "2026-08-01T08:00:00.000Z",
    },
  }));
  (window.patentApi as PatentApi & { patents: PatentApi["patents"] }).patents = {
    list: vi.fn(async (scope: "active" | "trash") => ({
      ok: true as const,
      value: scope === "active" ? [existing] : [],
    })),
    create: vi.fn(),
    open: vi.fn(async () => ({ ok: true as const, value: opened })),
    openPath: vi.fn(),
    recover: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush,
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(),
    importPatdoc: vi.fn(),
    exportPatdoc: vi.fn(),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };

  render(<App />);

  await openPatentFromLibrary(user);
  expect(screen.queryByRole("tab", { name: "实验记录" })).toBeNull();
  expect(screen.queryByRole("button", { name: "新建其他文档" })).toBeNull();
  expect(opened.patent.auxiliaryDocuments[0]?.title).toBe("实验记录");
});

test("exports only the active patent book when single-book export is selected", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);

  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: /^说明书$/ }));
  await chooseToolbarExport(user, "DOCX");
  const exportDialog = await screen.findByRole("dialog", { name: "导出专利文档" });
  await user.selectOptions(
    within(exportDialog).getByRole("combobox", { name: "导出范围" }),
    "single",
  );
  await user.click(within(exportDialog).getByRole("button", { name: /^(?:导出|仍导出草稿)$/u }));

  expect(exportPatentDocx).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "single",
      bookKind: "description",
      suggestedName: "往复式夹具（新型）-说明书",
    }),
  );
});

test("cycles from an active dual book into CAD and back without getting stuck", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  useWideDualViewWindow();
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  await user.click(screen.getByRole("button", { name: "打开常用双文档搭配" }));
  await user.click(screen.getByRole("menuitem", { name: "权／说" }));
  const workspace = await screen.findByRole("region", { name: "同屏双文档工作区" });
  const left = within(workspace).getByRole("region", { name: "左侧文档" });
  fireEvent.pointerDown(left);
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(screen.getByRole("region", { name: "CAD标号" })).toBeDefined());
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  await waitFor(() =>
    expect(within(left).getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined(),
  );
});

test("adapts the single document to window width without rewriting this session's zoom or document text", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  readSettings.mockResolvedValue({ ok: true, value: appSettingsFixture({ zoomPercent: 125 }) });
  const observers: { callback: () => void; targets: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  render(<App />);
  await openPatentFromLibrary(user);
  for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: "=", ctrlKey: true });
  const layout = document.querySelector<HTMLElement>(
    ".patent-editor-workspace .patent-page-with-rail",
  );
  const page = layout?.querySelector<HTMLElement>(":scope > .patent-page-zoom-frame");
  if (!layout || !page) throw new Error("Missing single-document page");
  const text = screen.getByRole("textbox", { name: "编辑 说明书" }).textContent;
  let width = 1800;
  Object.defineProperty(layout, "clientWidth", { configurable: true, get: () => width });
  layout.getBoundingClientRect = () => ({ width }) as DOMRect;
  Object.defineProperty(page, "offsetWidth", { configurable: true, value: 820 });
  layout.style.gridTemplateColumns = "84px 820px 292px";
  await waitFor(() => expect(observers.some((o) => o.targets.includes(layout))).toBe(true));
  const observer = observers.find((o) => o.targets.includes(layout));
  if (!observer) throw new Error("Missing responsive limit observer");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "缩放 130%，点击重置" })).toBeDefined(),
  );
  const hasRail = Boolean(
    layout.querySelector(
      ":scope > .patent-function-rail-measurement-anchor, :scope > .patent-global-function-rail-slot",
    ),
  );
  width = 1000;
  act(() => {
    for (const item of observers.filter((o) => o.targets.includes(layout))) item.callback();
  });
  // Compact controls release width before the document itself has to shrink.
  const cap = Math.floor(((1000 - 28 - (hasRail ? 48 : 0) - 1) / 820) * 100);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "缩放 " + cap + "%，点击重置" })).toBeDefined(),
  );
  width = 1800;
  act(() => {
    for (const item of observers.filter((o) => o.targets.includes(layout))) item.callback();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "缩放 130%，点击重置" })).toBeDefined(),
  );
  expect(screen.getByRole("textbox", { name: "编辑 说明书" }).textContent).toBe(text);
  expect(updateSettings.mock.calls.every(([patch]) => patch.zoomPercent === undefined)).toBe(true);
});

test("restores this session's single zoom after leaving fitted columns", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  readSettings.mockResolvedValue({ ok: true, value: appSettingsFixture({ zoomPercent: 125 }) });
  window.patentApi.application.setDualColumnWindow = vi.fn(async () => ({
    ok: true as const,
    value: { isMaximized: true, contentWidth: 1920, contentHeight: 900 },
  }));
  render(<App />);
  await openPatentFromLibrary(user);
  for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: "=", ctrlKey: true });
  await screen.findByRole("button", { name: "缩放 130%，点击重置" });
  await user.click(screen.getByRole("button", { name: "双列显示" }));
  const columns = document.querySelector<HTMLElement>(".dual-column-layout");
  expect(columns).not.toBeNull();
  columns?.style.setProperty("--column-zoom", "0.65");
  await user.click(screen.getByRole("button", { name: "双列显示" }));
  expect(await screen.findByRole("button", { name: "缩放 130%，点击重置" })).toBeDefined();
  expect(updateSettings.mock.calls.every(([patch]) => patch.zoomPercent === undefined)).toBe(true);
});

test("switches from dual view to columns once when the control is clicked repeatedly", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  let finishWindowChange!: (
    result: Readonly<{
      ok: true;
      value: { isMaximized: boolean; contentWidth: number; contentHeight: number };
    }>,
  ) => void;
  const setDualColumnWindow = vi.fn(
    () =>
      new Promise<{
        ok: true;
        value: { isMaximized: boolean; contentWidth: number; contentHeight: number };
      }>((resolve) => {
        finishWindowChange = resolve;
      }),
  );
  window.patentApi.application.setDualColumnWindow = setDualColumnWindow;
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "同屏双显" }));
  await screen.findByRole("region", { name: "同屏双文档工作区" });

  const columnsToggle = screen.getByRole("button", { name: "双列显示" });
  fireEvent.click(columnsToggle);
  fireEvent.click(columnsToggle);

  expect(setDualColumnWindow).toHaveBeenCalledOnce();
  finishWindowChange({
    ok: true,
    value: { isMaximized: true, contentWidth: 1920, contentHeight: 900 },
  });
  await waitFor(() =>
    expect(document.querySelector<HTMLElement>(".dual-column-layout")).not.toBeNull(),
  );
  expect(screen.queryByRole("region", { name: "同屏双文档工作区" })).toBeNull();
});

test("keeps columns open on a laptop viewport instead of silently exiting after width fitting", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  window.patentApi.application.setDualColumnWindow = vi.fn(async () => ({
    ok: true as const,
    value: { isMaximized: true, contentWidth: 1710, contentHeight: 960 },
  }));
  render(<App />);
  await openPatentFromLibrary(user);
  const root = document.querySelector<HTMLElement>(".patent-drafting-workspace");
  const page = root?.querySelector<HTMLElement>(".patent-page-zoom-frame");
  if (!root || !page) throw new Error("Missing drafting page");
  root.getBoundingClientRect = () => new DOMRect(0, 0, 1671, 800);
  Object.defineProperty(page, "offsetWidth", { configurable: true, value: 794 });
  await user.click(screen.getByRole("button", { name: "双列显示" }));
  await waitFor(() => expect(root.querySelector(".dual-column-layout")).not.toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(root.querySelector(".dual-column-layout")).not.toBeNull();
  expect(screen.getByRole("button", { name: "双列显示" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("closing a patent discards its inspection without an obsolete-result alert", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  await user.click(
    within(screen.getByRole("toolbar", { name: "常用工具" })).getByRole("button", {
      name: "本地检查",
    }),
  );
  await user.click(
    within(screen.getByRole("complementary", { name: "本地检查" })).getByRole("button", {
      name: "全文检查",
    }),
  );
  await screen.findByRole("tablist", { name: "本地检查筛选" });
  vi.mocked(appDialogs.showAppAlert).mockClear();
  await user.click(screen.getByRole("button", { name: "关闭往复式夹具" }));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "本地检查" })).toBeNull());
  expect(appDialogs.showAppAlert).not.toHaveBeenCalledWith(
    "检查结果已过期，请重新打开专利后检查。",
  );
});

test("closing inspection during save preparation ignores the late callback", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({});
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "展开功能栏" }));
  await user.click(
    within(screen.getByRole("toolbar", { name: "常用工具" })).getByRole("button", {
      name: "本地检查",
    }),
  );
  const saved = deferred<Awaited<ReturnType<PatentApi["patents"]["flush"]>>>();
  const flush = vi.spyOn(window.patentApi.patents, "flush").mockImplementation(() => saved.promise);
  const panel = screen.getByRole("complementary", { name: "本地检查" });
  await user.click(within(panel).getByRole("button", { name: "全文检查" }));
  await waitFor(() => expect(flush).toHaveBeenCalled());
  await user.click(within(panel).getByRole("button", { name: "关闭本地检查" }));
  const request = flush.mock.calls[0]![0];
  await act(async () =>
    saved.resolve({
      ok: true,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision,
        flushedAt: new Date().toISOString(),
      },
    }),
  );
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "本地检查" })).toBeNull());
  expect(appDialogs.showAppAlert).not.toHaveBeenCalled();
});
test("keeps CAD and flowchart sessions isolated across patents with only one live flowchart iframe", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({
    additionalPatent: {
      summary: patentSummary("回收工艺", 2),
      opened: openedPatent("回收工艺", 2),
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  const drawingA = screen.getByRole("region", { name: "CAD标号" });
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  const flowA = await screen.findByRole("main", { name: "流程图编辑工作区" });
  await screen.findByTitle("流程图编辑器");
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  await user.dblClick(await screen.findByRole("article", { name: "回收工艺" }));
  expect(screen.queryByRole("tab", { name: "CAD标号" })).toBeNull();
  expect(screen.queryByRole("main", { name: "流程图编辑工作区" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "CAD标号" }));
  expect(screen.getByRole("region", { name: "CAD标号" })).not.toBe(drawingA);
  await user.click(screen.getByRole("tab", { name: "说明书" }));
  await user.click(screen.getByRole("button", { name: "插入流程图" }));
  await waitFor(() =>
    expect(document.querySelectorAll('iframe[title="流程图编辑器"]')).toHaveLength(1),
  );
  expect(screen.getByRole("main", { name: "流程图编辑工作区" })).not.toBe(flowA);
  await user.click(screen.getByRole("tab", { name: "往复式夹具" }));
  await waitFor(() => expect(screen.getByRole("main", { name: "流程图编辑工作区" })).toBe(flowA));
  await waitFor(() =>
    expect(document.querySelectorAll('iframe[title="流程图编辑器"]')).toHaveLength(1),
  );
  await user.click(screen.getByRole("tab", { name: "CAD标号" }));
  expect(screen.getByRole("region", { name: "CAD标号" })).toBe(drawingA);
});

test("keeps drawing-book formula drafts and physics windows owned by each patent", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({
    additionalPatent: {
      summary: patentSummary("回收工艺", 2),
      opened: openedPatent("回收工艺", 2),
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  await user.click(screen.getByRole("button", { name: "插入数学公式" }));
  const fieldA = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  fieldA.value = "a^2";
  fireEvent.input(fieldA);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  expect(screen.queryByRole("dialog", { name: "插入数学公式" })).toBeNull();
  await user.dblClick(await screen.findByRole("article", { name: "回收工艺" }));
  expect(screen.queryByRole("dialog", { name: "插入数学公式" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "说明书附图" }));
  await user.click(screen.getByRole("button", { name: "插入数学公式" }));
  const fieldB = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  expect(fieldB).not.toBe(fieldA);
  expect(fieldB.value ?? fieldB.textContent ?? "").toBe("");
  fieldB.value = "b^2";
  fireEvent.input(fieldB);
  await user.click(screen.getByRole("tab", { name: "往复式夹具" }));
  expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBe(fieldA);
  expect(fieldA.value).toBe("a^2");
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "插入物理公式" }));
  const physicsA = screen.getByRole("dialog", { name: "物理公式" });
  await user.click(screen.getByRole("tab", { name: "回收工艺" }));
  expect(screen.queryByRole("dialog", { name: "物理公式" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBe(fieldB);
  expect(fieldB.value).toBe("b^2");
  await user.click(screen.getByRole("tab", { name: "往复式夹具" }));
  expect(screen.getByRole("dialog", { name: "物理公式" })).toBe(physicsA);
});
test("retains text-book formula drafts when opening a second patent through the library", async () => {
  const user = userEvent.setup();
  installPatentTrashTestApi({
    additionalPatent: {
      summary: patentSummary("回收工艺", 2),
      opened: openedPatent("回收工艺", 2),
    },
  });
  render(<App />);
  await openPatentFromLibrary(user);
  await user.click(screen.getByRole("button", { name: "插入数学公式" }));
  const first = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  first.value = "retained";
  fireEvent.input(first);
  await user.click(screen.getByRole("tab", { name: "专利库" }));
  expect(first.isConnected).toBe(true);
  expect(screen.queryByRole("textbox", { name: "可视公式编辑器" })).toBeNull();
  await user.dblClick(await screen.findByRole("article", { name: "回收工艺" }));
  expect(screen.queryByRole("textbox", { name: "可视公式编辑器" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "往复式夹具" }));
  expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBe(first);
  expect(first.value).toBe("retained");
});
