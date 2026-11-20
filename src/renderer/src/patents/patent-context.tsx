import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { AssetDescriptor, PatentBookDocument } from "../../../shared/document/model";
import { fitDocumentTables } from "../../../shared/document/table-page-fit";
import { drawingAssetIds } from "../../../shared/drawing-markup/cad-state";
import type { DrawingProjectEdits } from "../../../shared/drawing-markup/project-edits";
import { createDocxSuggestedName } from "../../../shared/exports/docx-filename";
import type {
  DocxImportCommitRequest,
  FlowchartOpenedProject,
  FlowchartSaveRequest,
  PatentApi,
  PatentCreateRequest,
  SavedDocument,
} from "../../../shared/ipc/contract";
import type { JsonObject } from "../../../shared/ipc/primitives";
import type { AppError, AppResult } from "../../../shared/ipc/result";
import { moveAuxiliaryDocument as reorderAuxiliaryDocuments } from "../../../shared/patent/auxiliary-management";
import type { PatdocWorkspace } from "../../../shared/patent/continuation";
import { descriptionInventionTitle } from "../../../shared/patent/description";
import { fitInsertedFigures } from "../../../shared/patent/figure-insertion-size";
import type { DesignPatent } from "../../../shared/patent/design-patent";
import type {
  AuxiliaryDocument,
  CanonicalPatent,
  PatentBookKind,
  PatentFigure,
  PatentType,
} from "../../../shared/patent/model";
import { isPatentBookAvailable, PATENT_NAME_MAX_LENGTH } from "../../../shared/patent/model";
import type { ReferenceMarkMutationPlan } from "../../../shared/patent/reference-mark-operations";
import { createPatentTerminologyBookEdits } from "../../../shared/patent/terminology";
import {
  applyPageMarginsToPage,
  DEFAULT_PAGE_MARGINS,
  type PageMargins,
} from "../../../shared/settings/page-margins";
import type {
  ExplicitSnapshotSource,
  SnapshotCreationResult,
} from "../../../shared/snapshot/model";
import { useApplicationCloseParticipant } from "../app/application-close-coordinator";
import { MotionPresence } from "../app/motion-presence";
import { rendererSaveRecovery } from "../app/renderer-save-recovery";
import {
  BackupRuntimeCoordinator,
  requestPatentCloseBackup,
} from "../backup/backup-runtime-coordinator";
import { confirmAppAction } from "../shared/app-dialog";
import { showApplicationError } from "../shared/error-dialog";
import { type OperationFeedback, OperationFeedbackOverlay } from "../shared/operation-feedback";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { selectDocxImportInitialTarget } from "./docx-import-initial-target";
import {
  captureDescriptionDrawingState,
  DescriptionDrawingHistoryManager,
} from "./history/description-drawing-history";
import {
  createPatentSession,
  createPatentState,
  type PatentSession,
  type PatentState,
  patentReducer,
} from "./patent-reducer";
import {
  PatentSaveCoordinator,
  type PatentSaveCoordinatorSnapshot,
} from "./patent-save-coordinator";
import { matchesReferenceMarkPlanBase } from "./reference-marks/reference-mark-plan-guard";
import {
  type ReferenceHistoryBookKind,
  ReferenceMarkUndoManager,
} from "./reference-marks/reference-mark-undo-manager";
import {
  type SnapshotCloseDecision,
  SnapshotCloseFailureDialog,
} from "./snapshot-close-failure-dialog";

type PatentContextValue = {
  isAutomationReadOnly(patentId: string): boolean;
  automationEditorEpoch(patentId: string): number;
  getReferenceMarkPatentSnapshot(patentId: string): CanonicalPatent | null;
  state: PatentState;
  hasOpenPatents(): boolean;
  activeSession: PatentSession | null;
  flowcharts: PatentApi["flowcharts"];
  newPatent(request: PatentCreateRequest): Promise<PatentSession | null>;
  openPatent(patentId: string): Promise<PatentSession | null>;
  importPatdoc(): Promise<PatentSession | null>;
  commitDocxImport(request: DocxImportCommitRequest): Promise<PatentSession | null>;
  exportActivePatdoc(
    suggestedName?: string,
    workspace?: PatdocWorkspace,
  ): Promise<SavedDocument | null>;
  activatePatent(patentId: string): void;
  activateBook(patentId: string, bookKind: PatentBookKind): void;
  activateAuxiliaryDocument(patentId: string, auxiliaryDocumentId: string): void;
  createAuxiliaryDocument(patentId: string, document: AuxiliaryDocument): Promise<boolean>;
  updateAuxiliaryDocument(
    patentId: string,
    auxiliaryDocumentId: string,
    document: PatentBookDocument,
    editorState?: JsonObject,
    assets?: AssetDescriptor[],
  ): void;
  renameAuxiliaryDocument(
    patentId: string,
    auxiliaryDocumentId: string,
    title: string,
  ): Promise<boolean>;
  deleteAuxiliaryDocument(patentId: string, auxiliaryDocumentId: string): Promise<boolean>;
  moveAuxiliaryDocument(
    patentId: string,
    auxiliaryDocumentId: string,
    direction: "up" | "down",
  ): Promise<boolean>;
  updateBookDocument(
    patentId: string,
    bookKind: PatentBookKind,
    document: PatentBookDocument,
    editorState?: JsonObject,
    assets?: AssetDescriptor[],
  ): void;
  updatePatentFigures(
    patentId: string,
    figures: PatentFigure[],
    abstractDrawingFigureId: string | null,
    assets: AssetDescriptor[],
    history?: {
      ownerBookKind: "description-drawings";
      label: string;
    },
    drawingProjects?: CanonicalPatent["drawingProjects"],
    drawingProjectEdits?: DrawingProjectEdits,
    preserveReplacementWidths?: boolean,
    naturalSizeFigureIds?: readonly string[],
  ): void;
  appendImportedPatentFigures(
    patentId: string,
    importedFigures: PatentFigure[],
    importedAssets: AssetDescriptor[],
    historyLabel: "导入附图" | "粘贴附图",
  ): void;
  updateDesignPatent(patentId: string, designPatent: DesignPatent, assets: AssetDescriptor[]): void;
  prepareDesignPatentExport(patentId: string): Promise<number | null>;
  adoptDesignPatentExport(patentId: string, patent: CanonicalPatent, savedAt: string): boolean;
  updatePatentSettings(
    patentId: string,
    request: {
      name?: string | null;
      customer?: string | null | undefined;
      patentType: PatentType;
      terminologyReplacementRequested?: boolean;
      closeIfOpened?: boolean;
    },
  ): Promise<boolean>;
  setDrawingBooksEnabled(patentId: string, enabled: boolean): Promise<boolean>;
  applyReferenceMarkPlan(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    plan: ReferenceMarkMutationPlan,
  ): boolean;
  canUndoReferenceMarkOperation(patentId: string, ownerBookKind: ReferenceHistoryBookKind): boolean;
  undoReferenceMarkOperation(patentId: string, ownerBookKind: ReferenceHistoryBookKind): boolean;
  canRedoReferenceMarkOperation(patentId: string, ownerBookKind: ReferenceHistoryBookKind): boolean;
  redoReferenceMarkOperation(patentId: string, ownerBookKind: ReferenceHistoryBookKind): boolean;
  discardReferenceMarkRedo(patentId: string, bookKind: PatentBookKind): void;
  canUndoDescriptionDrawing(patentId: string): boolean;
  undoDescriptionDrawing(patentId: string): boolean;
  canRedoDescriptionDrawing(patentId: string): boolean;
  redoDescriptionDrawing(patentId: string): boolean;
  applyPageMargins(margins: PageMargins): void;
  saveFlowchartSource(
    patentId: string,
    input: Omit<FlowchartSaveRequest, "patentId" | "expectedPatentRevision">,
  ): Promise<AppResult<FlowchartOpenedProject>>;
  saveActivePatent(): Promise<boolean>;
  persistActivePatent(): Promise<boolean>;
  preparePatentSnapshot(patentId: string): Promise<boolean>;

  prepareActivePatentExport(): Promise<{
    patentId: string;
    sessionId: string;
    expectedRevision: number;
    suggestedName: string;
  } | null>;
  preparePatentExport(
    patentId: string,
  ): ReturnType<PatentContextValue["prepareActivePatentExport"]>;
  prepareActiveAiCorrection(): Promise<{
    patentId: string;
    sessionId: string;
    expectedRevision: number;
  } | null>;
  requestClose(patentId: string): void;
  closePatent(
    patentId: string,
    options?: { allowDiscardOnSaveFailure?: boolean },
  ): Promise<boolean>;
};

const PatentContext = createContext<PatentContextValue | null>(null);

type PatentProviderProps = PropsWithChildren<{
  onAutoTitlePersisted?(patentId: string): void;
  onExternalPatentOpened?(): void;
}>;

function appError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as AppError;
  }
  return { code: "INTERNAL", message: "Local patent operation failed" };
}

function mergeAssetSnapshots(
  current: readonly AssetDescriptor[],
  incoming: readonly AssetDescriptor[],
): AssetDescriptor[] {
  const assets = new Map(current.map((asset) => [asset.assetId, structuredClone(asset)]));
  for (const asset of incoming) assets.set(asset.assetId, structuredClone(asset));
  return [...assets.values()];
}

export function PatentProvider({
  children,
  onAutoTitlePersisted,
  onExternalPatentOpened,
}: PatentProviderProps) {
  const [state, dispatch] = useReducer(patentReducer, createPatentState());
  const [pageMargins, setPageMargins] = useState<PageMargins>(() =>
    structuredClone(DEFAULT_PAGE_MARGINS),
  );
  const [manualSnapshotError, setManualSnapshotError] = useState<string | null>(null);
  const [manualSaveFeedback, setManualSaveFeedback] = useState<OperationFeedback | null>(null);
  const [closeSnapshotError, setCloseSnapshotError] = useState<string | null>(null);
  const [closeSnapshotFailureId, setCloseSnapshotFailureId] = useState(0);
  const [closeSnapshotWarning, setCloseSnapshotWarning] = useState(false);
  const closeSnapshotDecision = useRef<((decision: SnapshotCloseDecision) => void) | null>(null);
  const closingPatentOperations = useRef(new Map<string, Promise<boolean>>());
  const [closingPatentIds, setClosingPatentIds] = useState<ReadonlySet<string>>(new Set());
  const applicationCloseRunning = useRef(false);
  const queues = useRef(new Map<string, PatentSaveCoordinator>());
  const automationLocks = useRef(
    new Map<
      string,
      { token: string; unsafe: boolean; adopted: boolean; releaseRequested?: boolean }
    >(),
  );
  const closeForAutomation = useRef<
    ((patentId: string, options: { allowDiscardOnSaveFailure: boolean }) => Promise<boolean>) | null
  >(null);
  const [automationViews, setAutomationViews] = useState<
    Record<string, { readOnly: boolean; epoch: number }>
  >({});
  const compositionActive = useRef(false);
  const isAutomationReadOnly = useCallback(
    (patentId: string) => automationLocks.current.has(patentId) || closingPatentIds.has(patentId),
    [closingPatentIds],
  );
  const automationEditorEpoch = useCallback(
    (patentId: string) => automationViews[patentId]?.epoch ?? 0,
    [automationViews],
  );
  const referenceUndo = useRef(new ReferenceMarkUndoManager());
  const descriptionDrawingHistory = useRef(new DescriptionDrawingHistoryManager());
  const stateRef = useRef(state);
  stateRef.current = state;
  const hasOpenPatents = useCallback(() => stateRef.current.sessions.length > 0, []);

  useEffect(() => {
    const settingsApi = window.patentApi?.settings;
    if (!settingsApi?.read) return;
    void settingsApi
      .read()
      .then((result) => {
        if (result.ok) setPageMargins(result.value.pageMargins);
        else showApplicationError(result.error);
      })
      .catch((error) => showApplicationError(appError(error)));
  }, []);

  const activeSession =
    state.sessions.find((session) => session.patentId === state.activePatentId) ??
    state.sessions[0] ??
    null;

  const releaseSession = useCallback(async (sessionId: string) => {
    try {
      const result = await window.patentApi.patents.release(sessionId);
      if (!result.ok) {
        showApplicationError(result.error);
        return false;
      }
      return true;
    } catch (error) {
      showApplicationError(appError(error));
      return false;
    }
  }, []);

  const syncQueuedModel = useCallback((snapshot: PatentSaveCoordinatorSnapshot) => {
    dispatch({ type: "SESSION_MODEL_QUEUED", snapshot });
  }, []);

  const syncSaveStatus = useCallback((snapshot: PatentSaveCoordinatorSnapshot) => {
    dispatch({ type: "SESSION_SAVE_STATUS_CHANGED", snapshot });
    if (snapshot.saveError) showApplicationError(snapshot.saveError);
  }, []);

  const syncPersistedMutation = useCallback((snapshot: PatentSaveCoordinatorSnapshot) => {
    const session = stateRef.current.sessions.find(
      (candidate) => candidate.patentId === snapshot.patentId,
    );
    const patent =
      session && isPatentBookAvailable(snapshot.patent, session.activeBookKind)
        ? { ...snapshot.patent, activeBookKind: session.activeBookKind }
        : snapshot.patent;
    const action = {
      type: "SESSION_PERSISTED_PATENT_ADOPTED",
      snapshot: { ...snapshot, patent },
    } as const;
    stateRef.current = patentReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const syncAutoTitlePersisted = useCallback(
    (snapshot: PatentSaveCoordinatorSnapshot) => {
      onAutoTitlePersisted?.(snapshot.patentId);
    },
    [onAutoTitlePersisted],
  );

  const ensureQueue = useCallback(
    (session: PatentSession): PatentSaveCoordinator => {
      const existing = queues.current.get(session.patentId);
      if (existing) return existing;
      const queue = new PatentSaveCoordinator({
        patentId: session.patentId,
        sessionId: session.sessionId,
        initialPatent: session.patent,
        applyBookEdit: (request) => window.patentApi.patents.applyBookEdit(request),
        applyAuxiliaryDocumentEdit: (request) => {
          const applyEdit = window.patentApi.patents.applyAuxiliaryDocumentEdit;
          return applyEdit
            ? applyEdit(request)
            : Promise.resolve({
                ok: false as const,
                error: { code: "INTERNAL", message: "当前版本无法保存其他文档。" },
              });
        },
        applyFigureEdit: (request) => window.patentApi.patents.applyFigureEdit(request),
        updateSettings: (request) => window.patentApi.patents.updateSettings(request),
        updateDesignPatent: (request) =>
          window.patentApi.patents.updateDesignPatent?.(request) ??
          Promise.resolve({
            ok: false,
            error: { code: "NOT_FOUND", message: "外观设计保存服务不可用。" },
          }),
        flush: (request) => window.patentApi.patents.flush(request),
        saveFlowchart: (request) => window.patentApi.flowcharts.save(request),
        onQueued: syncQueuedModel,
        onConfirmed: syncSaveStatus,
        onAutoTitlePersisted: syncAutoTitlePersisted,
        onFailed: syncSaveStatus,
        onRetrying: syncSaveStatus,
        onMutationConfirmed: syncPersistedMutation,
      });
      queues.current.set(session.patentId, queue);
      return queue;
    },
    [syncAutoTitlePersisted, syncQueuedModel, syncSaveStatus, syncPersistedMutation],
  );

  const installOpenedPatent = useCallback(
    async (opened: Parameters<typeof createPatentSession>[0]) => {
      const existing = stateRef.current.sessions.find(
        (session) => session.patentId === opened.patentId,
      );
      if (existing) {
        await releaseSession(opened.sessionId);
        dispatch({ type: "ACTIVATE_PATENT", patentId: existing.patentId });
        return existing;
      }
      const session = createPatentSession(opened);
      const syncedSession: PatentSession = {
        ...session,
        patent: {
          ...session.patent,
          books: session.patent.books.map((book) => ({
            ...book,
            document: {
              ...book.document,
              page: applyPageMarginsToPage(book.document.page, pageMargins),
            },
          })),
        },
      };
      ensureQueue(syncedSession);
      const action = { type: "OPEN_PATENT", session: syncedSession } as const;
      // Reserve the visible session synchronously; concurrent opens must release their duplicate.
      stateRef.current = patentReducer(stateRef.current, action);
      dispatch(action);
      return syncedSession;
    },
    [ensureQueue, pageMargins, releaseSession],
  );

  useLayoutEffect(
    () => () => {
      for (const queue of queues.current.values()) {
        if (queue.snapshot().aggregateSaveState === "saved") {
          queue.dispose();
          continue;
        }
        rendererSaveRecovery.retain(queue, async () => {
          await queue.retry();
          if (!(await queue.drainAndVerify())) throw new Error("专利保存未完成");
          queue.dispose();
        });
      }
    },
    [],
  );

  const newPatent = useCallback(
    async (request: PatentCreateRequest) => {
      try {
        const result = await window.patentApi.patents.create(request);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        return await installOpenedPatent({
          ...result.value,
          patent: { ...result.value.patent, activeBookKind: "claims" },
        });
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [installOpenedPatent],
  );

  const openPatent = useCallback(
    async (patentId: string) => {
      try {
        // Reopening must not reuse a session that the pending close will release.
        // Read only after its final save/snapshot, including a cancelled close.
        const pendingClose = closingPatentOperations.current.get(patentId);
        if (pendingClose) await pendingClose;
        const result = await window.patentApi.patents.open(patentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        return await installOpenedPatent(result.value);
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [installOpenedPatent],
  );

  const importPatdoc = useCallback(async () => {
    try {
      const result = await window.patentApi.patents.importPatdoc();
      if (!result.ok) {
        showApplicationError(result.error);
        return null;
      }
      if (!result.value) return null;
      return await installOpenedPatent(result.value);
    } catch (error) {
      showApplicationError(appError(error));
      return null;
    }
  }, [installOpenedPatent]);

  const commitDocxImport = useCallback(
    async (request: DocxImportCommitRequest) => {
      try {
        const commit = window.patentApi.patents.commitDocxImport;
        if (!commit) return null;
        if (request.appendTo) {
          const destination = request.appendTo;
          const existing = stateRef.current.sessions.find(
            (candidate) =>
              candidate.patentId === destination.patentId &&
              candidate.sessionId === destination.sessionId,
          );
          if (!existing) throw new Error("原专利已关闭，请重新打开专利后导入。");
          const queue = ensureQueue(existing);
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          const before = queue.snapshot();
          const existingIds = new Set(
            before.patent.auxiliaryDocuments.map((document) => document.auxiliaryDocumentId),
          );
          const result = await commit({
            ...request,
            appendTo: { ...destination, expectedRevision: before.persistedRevision },
          });
          if (!result.ok) {
            showApplicationError(result.error);
            return null;
          }
          if (result.value.patent.revision > queue.snapshot().persistedRevision) {
            const snapshot = queue.adoptPersistedPatent(
              result.value.patent,
              result.value.patent.modifiedAt,
            );
            dispatch({ type: "SESSION_PERSISTED_PATENT_ADOPTED", snapshot });
          }
          const firstNew = result.value.patent.auxiliaryDocuments.find(
            (document) => !existingIds.has(document.auxiliaryDocumentId),
          );
          if (firstNew)
            dispatch({
              type: "ACTIVATE_AUXILIARY_DOCUMENT",
              patentId: existing.patentId,
              auxiliaryDocumentId: firstNew.auxiliaryDocumentId,
            });
          return {
            ...createPatentSession(result.value),
            activeAuxiliaryDocumentId:
              firstNew?.auxiliaryDocumentId ?? existing.activeAuxiliaryDocumentId,
          };
        }
        const result = await commit(request);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        const initialTarget = selectDocxImportInitialTarget(result.value.patent.docxImportReport);
        const session = await installOpenedPatent(result.value);
        if (session && initialTarget?.kind === "book") {
          dispatch({
            type: "ACTIVATE_BOOK",
            patentId: session.patentId,
            bookKind: initialTarget.bookKind,
          });
        } else if (session && initialTarget?.kind === "auxiliary") {
          dispatch({
            type: "ACTIVATE_AUXILIARY_DOCUMENT",
            patentId: session.patentId,
            auxiliaryDocumentId: initialTarget.auxiliaryDocumentId,
          });
        }
        return session;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [ensureQueue, installOpenedPatent],
  );

  const openPatentPath = useCallback(
    async (path: string) => {
      try {
        const result = await window.patentApi.patents.openPath(path);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        const session = await installOpenedPatent(result.value);
        if (session) {
          dispatch({ type: "ACTIVATE_BOOK", patentId: session.patentId, bookKind: "description" });
          onExternalPatentOpened?.();
        }
        return session;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [installOpenedPatent, onExternalPatentOpened],
  );

  useEffect(() => {
    const onOpenPath = window.patentApi.application?.onOpenPath;
    if (!onOpenPath) return;
    return onOpenPath((path) => void openPatentPath(path));
  }, [openPatentPath]);

  const updateAutomationView = useCallback((patentId: string, readOnly: boolean, reset = false) => {
    setAutomationViews((current) => ({
      ...current,
      [patentId]: { readOnly, epoch: (current[patentId]?.epoch ?? 0) + (reset ? 1 : 0) },
    }));
  }, []);

  useEffect(() => {
    const begin = () => {
      compositionActive.current = true;
    };
    const end = () => {
      compositionActive.current = false;
    };
    document.addEventListener("compositionstart", begin, true);
    document.addEventListener("compositionend", end, true);
    return () => {
      document.removeEventListener("compositionstart", begin, true);
      document.removeEventListener("compositionend", end, true);
    };
  }, []);

  useEffect(() => {
    const automation = window.patentApi.automation;
    if (!automation) return;
    let alive = true;
    const isVisible = (element: Element): boolean => {
      for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true")
          return false;
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    };
    const unsafeEditor = () =>
      compositionActive.current ||
      Array.from(
        document.querySelectorAll(
          ".formula-dialog, .other-formula-dialog, .chemical-structure-dialog, .embedded-drawing-pane, .embedded-flowchart-pane, math-field",
        ),
      ).some(
        (element) =>
          isVisible(element) &&
          (element.tagName !== "MATH-FIELD" || element.contains(document.activeElement)),
      );
    const unsubscribe = automation.onEvent((event) => {
      if (event.type === "libraryChanged") {
        void (async () => {
          for (const patentId of event.createdPatentIds ?? []) {
            if (!alive) return;
            const session = await openPatent(patentId);
            if (alive && session) onExternalPatentOpened?.();
          }
        })();
        return;
      }
      if (event.type === "show") {
        void openPatent(event.patentId).then((session) => {
          if (alive && session) onExternalPatentOpened?.();
        });
        return;
      }
      if (event.type === "close") {
        const session = stateRef.current.sessions.find(
          (entry) => entry.patentId === event.patentId,
        );
        if (!session || session.sessionId !== event.sessionId) return;
        void (async () => {
          let ok = false;
          try {
            if (!unsafeEditor() && !automationLocks.current.has(event.patentId))
              ok =
                (await closeForAutomation.current?.(event.patentId, {
                  allowDiscardOnSaveFailure: false,
                })) ?? false;
          } catch {
            /* Keep the editor open when saving or closing fails. */
          }
          if (alive)
            await automation
              .control({ action: "closeAck", token: event.token, sessionId: event.sessionId, ok })
              .catch(() => undefined);
        })();
        return;
      }
      if (event.type !== "barrier") return;
      const queue = queues.current.get(event.patentId);
      if (!queue) return;
      const lock = automationLocks.current.get(event.patentId);
      if (event.phase === "release") {
        if (!lock || lock.token !== event.token) return;
        if (event.committed && !lock.adopted) {
          lock.unsafe = true;
          updateAutomationView(event.patentId, true);
        }
        if (lock.unsafe) {
          lock.releaseRequested = true;
          return;
        }
        queue.releaseFreeze(event.token);
        automationLocks.current.delete(event.patentId);
        flushSync(() => updateAutomationView(event.patentId, false));
        return;
      }
      const phase = event.phase;
      const ack = async (ok: boolean) => {
        const status = queue.automationStatus();
        try {
          const result = await automation.control({
            action: "barrierAck",
            token: event.token,
            sessionId: queue.sessionId,
            phase,
            ok,
            dirty: status.dirty,
            revision: queue.snapshot().persistedRevision,
          });
          if (phase === "adopt") {
            const current = automationLocks.current.get(event.patentId);
            if (current && current.token === event.token) {
              current.unsafe = !result.ok || !current.adopted;
              if (!current.unsafe && current.releaseRequested) {
                queue.releaseFreeze(event.token);
                automationLocks.current.delete(event.patentId);
                updateAutomationView(event.patentId, false);
              } else updateAutomationView(event.patentId, true);
            }
          }
        } catch {
          if (phase === "adopt") {
            const current = automationLocks.current.get(event.patentId);
            if (current && current.token === event.token) {
              current.unsafe = true;
              updateAutomationView(event.patentId, true);
            }
          }
        }
      };
      if (phase === "probe") {
        void ack(!unsafeEditor() && !lock);
        return;
      }
      if (phase === "drain") {
        if (unsafeEditor() || !queue.freeze(event.token)) {
          void ack(false);
          return;
        }
        automationLocks.current.set(event.patentId, {
          token: event.token,
          unsafe: false,
          adopted: false,
        });
        flushSync(() => updateAutomationView(event.patentId, true));
        void queue.drainAndVerify().then((ok) => {
          if (alive && automationLocks.current.get(event.patentId)?.token === event.token)
            void ack(ok && !queue.automationStatus().dirty);
        });
        return;
      }
      if (!lock || lock.token !== event.token) {
        void ack(false);
        return;
      }
      // Keep an uncertain adoption read-only even if the main process times out and releases.
      lock.unsafe = true;
      try {
        if (!event.patent || queue.automationStatus().dirty) throw new Error("保存队列尚未排空");
        const active = stateRef.current.sessions.find(
          (session) => session.patentId === event.patentId,
        );
        const adopted =
          active && isPatentBookAvailable(event.patent, active.activeBookKind)
            ? { ...event.patent, activeBookKind: active.activeBookKind }
            : event.patent;
        const snapshot = queue.adoptPersistedPatent(adopted, event.patent.modifiedAt);
        referenceUndo.current.invalidate(event.patentId);
        descriptionDrawingHistory.current.invalidate(event.patentId);
        const action = { type: "SESSION_PERSISTED_PATENT_ADOPTED", snapshot } as const;
        stateRef.current = patentReducer(stateRef.current, action);
        flushSync(() => {
          dispatch(action);
          updateAutomationView(event.patentId, true, true);
        });
        lock.adopted = true;
        void ack(true);
      } catch {
        updateAutomationView(event.patentId, true);
        void ack(false);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [openPatent, onExternalPatentOpened, updateAutomationView]);

  const resyncAutomationPatent = useCallback(
    async (patentId: string) => {
      const queue = queues.current.get(patentId);
      const lock = automationLocks.current.get(patentId);
      if (!queue || !lock || queue.automationStatus().dirty) return;
      try {
        const result = await window.patentApi.automation?.control({ action: "resync", patentId });
        if (!result?.ok) return;
        const persisted = result.value as CanonicalPatent;
        const active = stateRef.current.sessions.find((session) => session.patentId === patentId);
        const patent =
          active && isPatentBookAvailable(persisted, active.activeBookKind)
            ? { ...persisted, activeBookKind: active.activeBookKind }
            : persisted;
        if (queue.automationStatus().dirty || automationLocks.current.get(patentId) !== lock)
          return;
        const snapshot =
          patent.revision === queue.snapshot().persistedRevision
            ? queue.snapshot()
            : queue.adoptPersistedPatent(patent, patent.modifiedAt);
        referenceUndo.current.invalidate(patentId);
        descriptionDrawingHistory.current.invalidate(patentId);
        const action = { type: "SESSION_PERSISTED_PATENT_ADOPTED", snapshot } as const;
        stateRef.current = patentReducer(stateRef.current, action);
        queue.releaseFreeze(lock.token);
        automationLocks.current.delete(patentId);
        dispatch(action);
        updateAutomationView(patentId, false, true);
      } catch {
        showApplicationError({
          code: "INTERNAL",
          message: "无法重新同步已保存版本，请保持只读并重试。",
        });
      }
    },
    [updateAutomationView],
  );

  const activatePatent = useCallback((patentId: string) => {
    dispatch({ type: "ACTIVATE_PATENT", patentId });
  }, []);

  const activateBook = useCallback((patentId: string, bookKind: PatentBookKind) => {
    dispatch({ type: "ACTIVATE_BOOK", patentId, bookKind });
  }, []);

  const activateAuxiliaryDocument = useCallback((patentId: string, auxiliaryDocumentId: string) => {
    dispatch({ type: "ACTIVATE_AUXILIARY_DOCUMENT", patentId, auxiliaryDocumentId });
  }, []);

  const applyAuxiliaryMutation = useCallback(
    async (
      patentId: string,
      mutate: (
        session: PatentSession,
        queue: PatentSaveCoordinator,
      ) => Promise<AppResult<{ patentId: string; revision: number; savedAt: string }>>,
      update: (patent: CanonicalPatent, revision: number, savedAt: string) => CanonicalPatent,
    ): Promise<boolean> => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return false;
      const queue = ensureQueue(session);
      try {
        await queue.flush();
        if (queue.automationStatus().frozen)
          throw new Error("本地 agent 正在同步专利，请稍后重试。");
        const result = await mutate(session, queue);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        const patent = update(queue.snapshot().patent, result.value.revision, result.value.savedAt);
        const snapshot = queue.adoptPersistedPatent(patent, result.value.savedAt);
        dispatch({ type: "SESSION_PERSISTED_PATENT_ADOPTED", snapshot });
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue],
  );

  const createAuxiliaryDocument = useCallback(
    async (patentId: string, document: AuxiliaryDocument): Promise<boolean> => {
      const api = window.patentApi.patents.createAuxiliaryDocument;
      if (!api) {
        showApplicationError({ code: "INTERNAL", message: "当前版本无法新建其他文档。" });
        return false;
      }
      return applyAuxiliaryMutation(
        patentId,
        (session, queue) =>
          api({
            patentId,
            sessionId: session.sessionId,
            expectedRevision: queue.snapshot().persistedRevision,
            document,
          }),
        (patent, revision, savedAt) => ({
          ...patent,
          revision,
          modifiedAt: savedAt,
          auxiliaryDocuments: [
            ...patent.auxiliaryDocuments,
            { ...structuredClone(document), localRevision: revision, persistedRevision: revision },
          ],
        }),
      );
    },
    [applyAuxiliaryMutation],
  );

  const updateAuxiliaryDocument = useCallback(
    (
      patentId: string,
      auxiliaryDocumentId: string,
      document: PatentBookDocument,
      editorState: JsonObject = {},
      assets: AssetDescriptor[] = [],
    ) => {
      if (automationLocks.current.has(patentId)) return;
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return;
      const queue = ensureQueue(session);
      queue.enqueueAuxiliaryDocumentEdit(
        auxiliaryDocumentId,
        document,
        editorState,
        mergeAssetSnapshots(queue.snapshot().patent.assets, assets),
      );
    },
    [ensureQueue],
  );

  const renameAuxiliaryDocument = useCallback(
    async (patentId: string, auxiliaryDocumentId: string, title: string): Promise<boolean> => {
      const api = window.patentApi.patents.renameAuxiliaryDocument;
      if (!api) {
        showApplicationError({ code: "INTERNAL", message: "当前版本无法重命名其他文档。" });
        return false;
      }
      const normalizedTitle = title.trim();
      return applyAuxiliaryMutation(
        patentId,
        (session, queue) =>
          api({
            patentId,
            sessionId: session.sessionId,
            expectedRevision: queue.snapshot().persistedRevision,
            auxiliaryDocumentId,
            title: normalizedTitle,
          }),
        (patent, revision, savedAt) => ({
          ...patent,
          revision,
          modifiedAt: savedAt,
          auxiliaryDocuments: patent.auxiliaryDocuments.map((document) =>
            document.auxiliaryDocumentId === auxiliaryDocumentId
              ? {
                  ...document,
                  title: normalizedTitle,
                  document: { ...document.document, title: normalizedTitle, modifiedAt: savedAt },
                  localRevision: revision,
                  persistedRevision: revision,
                }
              : document,
          ),
        }),
      );
    },
    [applyAuxiliaryMutation],
  );

  const moveAuxiliaryDocument = useCallback(
    async (patentId: string, auxiliaryDocumentId: string, direction: "up" | "down") => {
      const api = window.patentApi.patents.moveAuxiliaryDocument;
      if (!api) return false;
      return applyAuxiliaryMutation(
        patentId,
        (session, queue) =>
          api({
            patentId,
            sessionId: session.sessionId,
            expectedRevision: queue.snapshot().persistedRevision,
            auxiliaryDocumentId,
            direction,
          }),
        (patent, revision, savedAt) => ({
          ...patent,
          revision,
          modifiedAt: savedAt,
          auxiliaryDocuments: reorderAuxiliaryDocuments(
            patent.auxiliaryDocuments,
            auxiliaryDocumentId,
            direction,
          ),
        }),
      );
    },
    [applyAuxiliaryMutation],
  );

  const deleteAuxiliaryDocument = useCallback(
    async (patentId: string, auxiliaryDocumentId: string): Promise<boolean> => {
      const api = window.patentApi.patents.deleteAuxiliaryDocument;
      if (!api) {
        showApplicationError({ code: "INTERNAL", message: "当前版本无法删除其他文档。" });
        return false;
      }
      return applyAuxiliaryMutation(
        patentId,
        async (session, queue) => {
          const expectedRevision = queue.snapshot().persistedRevision;
          const recovery = await window.patentApi.snapshot.create({
            documentType: "patent",
            documentId: patentId,
            source: "manual-create",
          });
          if (!recovery.ok) return recovery;
          if (recovery.value.revision !== expectedRevision)
            return {
              ok: false as const,
              error: {
                code: "REVISION_CONFLICT" as const,
                message: "文档内容已变化，请重新删除。",
              },
            };
          return api({
            patentId,
            sessionId: session.sessionId,
            expectedRevision,
            auxiliaryDocumentId,
          });
        },
        (patent, revision, savedAt) => ({
          ...patent,
          revision,
          modifiedAt: savedAt,
          auxiliaryDocuments: patent.auxiliaryDocuments.filter(
            (document) => document.auxiliaryDocumentId !== auxiliaryDocumentId,
          ),
        }),
      );
    },
    [applyAuxiliaryMutation],
  );

  const updateBookDocument = useCallback(
    (
      patentId: string,
      bookKind: PatentBookKind,
      document: PatentBookDocument,
      editorState: JsonObject = {},
      assets: AssetDescriptor[] = [],
    ) => {
      if (automationLocks.current.has(patentId)) return;
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return;
      const queue = ensureQueue(session);
      queue.enqueueBookEdit(
        bookKind,
        document,
        editorState,
        mergeAssetSnapshots(queue.snapshot().patent.assets, assets),
      );
      if (bookKind !== "description" || queue.snapshot().patent.name) return;
      const name = descriptionInventionTitle(document);
      if (!name || name.length > PATENT_NAME_MAX_LENGTH) return;
      queue.enqueueSettings({
        name,
        patentType: queue.snapshot().patent.patentType,
        autoTitleRecognition: true,
      });
    },
    [ensureQueue],
  );

  const updateDesignPatent = useCallback(
    (patentId: string, designPatent: DesignPatent, assets: AssetDescriptor[]) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (session?.patent.patentType !== "design") return;
      ensureQueue(session).enqueueDesignPatent(designPatent, assets);
    },
    [ensureQueue],
  );

  const prepareDesignPatentExport = useCallback(
    async (patentId: string) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return null;
      const queue = ensureQueue(session);
      try {
        await queue.flush();
        return queue.snapshot().persistedRevision;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [ensureQueue],
  );

  const adoptDesignPatentExport = useCallback(
    (patentId: string, patent: CanonicalPatent, savedAt: string) => {
      const queue = queues.current.get(patentId);
      if (!queue) return false;
      try {
        const snapshot = queue.adoptPersistedPatent(patent, savedAt);
        const action = { type: "SESSION_PERSISTED_PATENT_ADOPTED", snapshot } as const;
        stateRef.current = patentReducer(stateRef.current, action);
        dispatch(action);
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [],
  );

  const updatePatentFigures = useCallback(
    (
      patentId: string,
      figures: PatentFigure[],
      abstractDrawingFigureId: string | null,
      assets: AssetDescriptor[],
      history?: {
        ownerBookKind: "description-drawings";
        label: string;
      },
      drawingProjects?: CanonicalPatent["drawingProjects"],
      drawingProjectEdits?: DrawingProjectEdits,
      preserveReplacementWidths = false,
      naturalSizeFigureIds: readonly string[] = [],
    ) => {
      if (automationLocks.current.has(patentId)) return;
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return;
      const queue = ensureQueue(session);
      const before = history ? captureDescriptionDrawingState(queue.snapshot().patent) : null;
      const snapshot = queue.enqueueFigureEdit({
        figures: fitInsertedFigures(
          queue.snapshot().patent,
          figures,
          assets,
          preserveReplacementWidths,
          naturalSizeFigureIds,
        ),
        abstractDrawingFigureId,
        // Importing identical generated bytes can reuse an asset ID already present in this snapshot.
        assets: mergeAssetSnapshots([], assets),
        ...(drawingProjectEdits
          ? { drawingProjectEdits }
          : drawingProjects === undefined
            ? {}
            : { drawingProjects }),
      });
      if (history && before) {
        referenceUndo.current.discardRedoForEdit(patentId, "description-drawings");
        descriptionDrawingHistory.current.record({
          patentId,
          label: history.label,
          before,
          after: captureDescriptionDrawingState(snapshot.patent),
        });
      }
    },
    [ensureQueue],
  );

  const appendImportedPatentFigures = useCallback(
    (
      patentId: string,
      importedFigures: PatentFigure[],
      importedAssets: AssetDescriptor[],
      historyLabel: "导入附图" | "粘贴附图",
    ) => {
      if (automationLocks.current.has(patentId)) return;
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session || importedFigures.length === 0) return;
      const queue = ensureQueue(session);
      const current = queue.snapshot().patent;
      const before = captureDescriptionDrawingState(current);
      const snapshot = queue.enqueueFigureEdit({
        figures: fitInsertedFigures(
          current,
          [...current.figures, ...structuredClone(importedFigures)],
          importedAssets,
        ),
        abstractDrawingFigureId: current.abstractDrawingFigureId,
        assets: mergeAssetSnapshots(current.assets, importedAssets),
      });
      descriptionDrawingHistory.current.record({
        patentId,
        label: historyLabel,
        before,
        after: captureDescriptionDrawingState(snapshot.patent),
      });
      referenceUndo.current.discardRedoForEdit(patentId, "description-drawings");
    },
    [ensureQueue],
  );

  const drawingHistoryTarget = useCallback((patentId: string, direction: "undo" | "redo") => {
    if (automationLocks.current.has(patentId)) return null;
    const queue = queues.current.get(patentId);
    if (!queue) return null;
    const current = queue.snapshot().patent;
    const drawingOrder = descriptionDrawingHistory.current.order(patentId, current, direction);
    const referenceOrder = referenceUndo.current.order(
      patentId,
      "description-drawings",
      current,
      direction,
    );
    return referenceOrder > drawingOrder ? "reference" : drawingOrder ? "drawing" : null;
  }, []);

  const canUndoDescriptionDrawing = useCallback(
    (patentId: string) => drawingHistoryTarget(patentId, "undo") !== null,
    [drawingHistoryTarget],
  );
  const canRedoDescriptionDrawing = useCallback(
    (patentId: string) => drawingHistoryTarget(patentId, "redo") !== null,
    [drawingHistoryTarget],
  );
  const executeDrawingHistory = useCallback(
    (patentId: string, direction: "undo" | "redo") => {
      if (automationLocks.current.has(patentId)) return false;
      const queue = queues.current.get(patentId);
      if (!queue) return false;
      const target = drawingHistoryTarget(patentId, direction);
      if (target === "reference") {
        const manager = referenceUndo.current;
        const transition =
          direction === "undo"
            ? manager.takeUndo(patentId, "description-drawings", queue.snapshot().patent)
            : manager.takeRedo(patentId, "description-drawings", queue.snapshot().patent);
        if (!transition) return false;
        queue.enqueueReferenceMarkTransaction(transition.edit);
        return direction === "undo"
          ? manager.commitUndo(transition)
          : manager.commitRedo(transition);
      }
      if (target !== "drawing") return false;
      const manager = descriptionDrawingHistory.current;
      const transition =
        direction === "undo"
          ? manager.takeUndo(patentId, queue.snapshot().patent)
          : manager.takeRedo(patentId, queue.snapshot().patent);
      if (!transition) return false;
      queue.enqueueFigureEdit(transition.edit);
      return direction === "undo"
        ? manager.commitUndo(patentId, transition)
        : manager.commitRedo(patentId, transition);
    },
    [drawingHistoryTarget],
  );
  const undoDescriptionDrawing = useCallback(
    (patentId: string) => executeDrawingHistory(patentId, "undo"),
    [executeDrawingHistory],
  );
  const redoDescriptionDrawing = useCallback(
    (patentId: string) => executeDrawingHistory(patentId, "redo"),
    [executeDrawingHistory],
  );

  const drainPatent = useCallback(
    async (session: PatentSession) => {
      const queue = ensureQueue(session);
      try {
        if (queue.snapshot().aggregateSaveState === "failed") await queue.retry();
        return await queue.drainAndVerify();
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue],
  );

  const createExplicitSnapshot = useCallback(
    async (patentId: string, source: ExplicitSnapshotSource): Promise<SnapshotCreationResult> => {
      const result = await window.patentApi.snapshot.create({
        documentType: "patent",
        documentId: patentId,
        source,
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    [],
  );

  const requestCloseSnapshotDecision = useCallback((error: AppError) => {
    if (closeSnapshotDecision.current) return Promise.resolve("cancel" as const);
    return new Promise<SnapshotCloseDecision>((resolve) => {
      closeSnapshotDecision.current = resolve;
      setCloseSnapshotFailureId((current) => current + 1);
      setCloseSnapshotError(error.message);
    });
  }, []);

  const decideCloseSnapshotFailure = useCallback((decision: SnapshotCloseDecision) => {
    const resolve = closeSnapshotDecision.current as (decision: SnapshotCloseDecision) => void;
    closeSnapshotDecision.current = null;
    flushSync(() => setCloseSnapshotError(null));
    resolve(decision);
  }, []);

  const createCloseSnapshot = useCallback(
    async (patentId: string, source: "patent-close" | "application-close") => {
      for (;;) {
        try {
          await createExplicitSnapshot(patentId, source);
          return true;
        } catch (error) {
          const decision = await requestCloseSnapshotDecision(appError(error));
          if (decision === "retry") continue;
          if (decision === "cancel") return false;
          setCloseSnapshotWarning(true);
          return true;
        }
      }
    },
    [createExplicitSnapshot, requestCloseSnapshotDecision],
  );

  const updatePatentSettings = useCallback(
    async (
      patentId: string,
      request: {
        name?: string | null;
        customer?: string | null | undefined;
        patentType: PatentType;
        terminologyReplacementRequested?: boolean;
        closeIfOpened?: boolean;
      },
    ) => {
      if (automationLocks.current.has(patentId)) return false;
      const existingSession = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      const openedForSettings = !existingSession;
      const previousActivePatentId = stateRef.current.activePatentId;
      const session = existingSession ?? (await openPatent(patentId));
      if (!session) return false;
      const finishSettings = async (saved: boolean) => {
        if (!saved || !openedForSettings || !request.closeIfOpened) return saved;
        if (!(await releaseSession(session.sessionId))) return false;
        queues.current.get(session.patentId)?.dispose();
        queues.current.delete(session.patentId);
        automationLocks.current.delete(session.patentId);
        setAutomationViews((current) => ({
          ...current,
          [session.patentId]: { readOnly: false, epoch: current[session.patentId]?.epoch ?? 0 },
        }));
        referenceUndo.current.invalidate(patentId);
        descriptionDrawingHistory.current.invalidate(patentId);
        requestPatentCloseBackup(patentId);
        const restoreActive =
          stateRef.current.activePatentId === patentId && previousActivePatentId;
        const closeAction = { type: "CLOSE_PATENT", patentId } as const;
        stateRef.current = patentReducer(stateRef.current, closeAction);
        dispatch(closeAction);
        if (restoreActive) {
          const action = { type: "ACTIVATE_PATENT", patentId: previousActivePatentId } as const;
          stateRef.current = patentReducer(stateRef.current, action);
          dispatch(action);
        }
        return true;
      };
      const queue = ensureQueue(session);
      if (request.patentType === "utility-model" && !queue.snapshot().patent.drawingBooksEnabled) {
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          const persisted = queue.snapshot();
          if (!persisted.patent.drawingBooksEnabled) {
            const result = await queue.runPersistedMutation(
              (expectedRevision) =>
                window.patentApi.patents.setDrawingBooksEnabled({
                  patentId,
                  sessionId: session.sessionId,
                  expectedRevision,
                  enabled: true,
                  settings: {
                    name: request.name !== undefined ? request.name : persisted.patent.name,
                    customer:
                      request.customer !== undefined ? request.customer : persisted.patent.customer,
                    patentType: request.patentType,
                    terminologyReplacementRequested:
                      request.terminologyReplacementRequested ?? false,
                  },
                }),
              (saved) => ({ patent: saved.patent, savedAt: saved.savedAt }),
            );
            if (!result.ok) {
              showApplicationError(result.error);
              return false;
            }
            referenceUndo.current.invalidate(patentId);
            descriptionDrawingHistory.current.invalidate(patentId);
            return finishSettings(true);
          }
        } catch (error) {
          showApplicationError(appError(error));
          return false;
        }
      }
      const bookEdits = request.terminologyReplacementRequested
        ? createPatentTerminologyBookEdits(queue.snapshot().patent, request.patentType)
        : [];
      queue.enqueueSettings({
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.customer !== undefined ? { customer: request.customer } : {}),
        patentType: request.patentType,
        ...(bookEdits.length > 0 ? { bookEdits } : {}),
      });
      try {
        await queue.flush();
        if (queue.automationStatus().frozen)
          throw new Error("本地 agent 正在同步专利，请稍后重试。");
        return finishSettings(true);
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue, openPatent, releaseSession],
  );

  const setDrawingBooksEnabled = useCallback(
    async (patentId: string, enabled: boolean) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return false;
      const queue = ensureQueue(session);
      try {
        await queue.flush();
        if (queue.automationStatus().frozen)
          throw new Error("本地 agent 正在同步专利，请稍后重试。");
        const result = await queue.runPersistedMutation(
          (expectedRevision) =>
            window.patentApi.patents.setDrawingBooksEnabled({
              patentId,
              sessionId: session.sessionId,
              expectedRevision,
              enabled,
            }),
          (saved) => ({ patent: saved.patent, savedAt: saved.savedAt }),
        );
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        referenceUndo.current.invalidate(patentId);
        descriptionDrawingHistory.current.invalidate(patentId);
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue],
  );

  const saveActivePatent = useCallback(async () => {
    setManualSaveFeedback(null);
    if (!activeSession) return false;
    if (!(await drainPatent(activeSession))) return false;
    setManualSnapshotError(null);
    try {
      const snapshot = await createExplicitSnapshot(activeSession.patentId, "manual-save");
      setManualSaveFeedback({
        tone: "success",
        title:
          snapshot.outcome === "created" ? "已保存，并成功创建快照" : "已保存，当前版本已有快照",
      });
      return true;
    } catch (error) {
      const detail = appError(error).message.replace(/[。.!！?？]+$/u, "");
      setManualSnapshotError(`正文已经保存，但“手动保存”快照创建失败：${detail}。请重试。`);
      return false;
    }
  }, [activeSession, createExplicitSnapshot, drainPatent]);

  const persistActivePatent = useCallback(async () => {
    if (!activeSession) return false;
    return drainPatent(activeSession);
  }, [activeSession, drainPatent]);

  const preparePatentSnapshot = useCallback(
    async (patentId: string) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      // Unopened patents have no pending renderer edits; snapshot creation validates saved data.
      return session ? drainPatent(session) : true;
    },
    [drainPatent],
  );

  const getReferenceMarkPatentSnapshot = useCallback(
    (patentId: string) => queues.current.get(patentId)?.snapshot().patent ?? null,
    [],
  );

  const applyReferenceMarkPlan = useCallback(
    (
      patentId: string,
      ownerBookKind: ReferenceHistoryBookKind,
      plan: ReferenceMarkMutationPlan,
    ) => {
      if (automationLocks.current.has(patentId)) return false;
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) return false;
      const queue = ensureQueue(session);
      if (!matchesReferenceMarkPlanBase(queue.snapshot().patent, plan.before)) return false;
      const bookEdits = plan.after.books
        .filter(
          (book, index) =>
            JSON.stringify(book.document) !== JSON.stringify(plan.before.books[index]?.document),
        )
        .map((book) => ({
          bookKind: book.kind,
          document: book.document,
          editorState: book.editorState,
        }));
      queue.enqueueReferenceMarkTransaction({
        referenceMarks: plan.after.referenceMarks,
        referenceMarkSettings: plan.after.referenceMarkSettings,
        bookEdits,
      });
      if (plan.recordHistory) {
        if (ownerBookKind === "description-drawings")
          descriptionDrawingHistory.current.discardRedo(patentId);
        referenceUndo.current.record({
          patentId,
          ownerBookKind: plan.historyBookKind ?? ownerBookKind,
          before: plan.before,
          after: plan.after,
        });
      }
      return true;
    },
    [ensureQueue],
  );

  const canUndoReferenceMarkOperation = useCallback(
    (patentId: string, ownerBookKind: ReferenceHistoryBookKind) => {
      const queue = queues.current.get(patentId);
      return queue
        ? referenceUndo.current.canUndo(patentId, ownerBookKind, queue.snapshot().patent)
        : false;
    },
    [],
  );

  const discardReferenceMarkRedo = useCallback((patentId: string, bookKind: PatentBookKind) => {
    referenceUndo.current.discardRedoForEdit(patentId, bookKind);
  }, []);

  const canRedoReferenceMarkOperation = useCallback(
    (patentId: string, ownerBookKind: ReferenceHistoryBookKind) => {
      const queue = queues.current.get(patentId);
      return queue
        ? referenceUndo.current.canRedo(patentId, ownerBookKind, queue.snapshot().patent)
        : false;
    },
    [],
  );

  const undoReferenceMarkOperation = useCallback(
    (patentId: string, ownerBookKind: ReferenceHistoryBookKind) => {
      if (automationLocks.current.has(patentId)) return false;
      const queue = queues.current.get(patentId);
      if (!queue) return false;
      const transition = referenceUndo.current.takeUndo(
        patentId,
        ownerBookKind,
        queue.snapshot().patent,
      );
      if (!transition) return false;
      queue.enqueueReferenceMarkTransaction(transition.edit);
      return referenceUndo.current.commitUndo(transition);
    },
    [],
  );

  const redoReferenceMarkOperation = useCallback(
    (patentId: string, ownerBookKind: ReferenceHistoryBookKind) => {
      if (automationLocks.current.has(patentId)) return false;
      const queue = queues.current.get(patentId);
      if (!queue) return false;
      const transition = referenceUndo.current.takeRedo(
        patentId,
        ownerBookKind,
        queue.snapshot().patent,
      );
      if (!transition) return false;
      queue.enqueueReferenceMarkTransaction(transition.edit);
      return referenceUndo.current.commitRedo(transition);
    },
    [],
  );

  const applyPageMargins = useCallback(
    (margins: PageMargins) => {
      if (automationLocks.current.size > 0) {
        showApplicationError({
          code: "REVISION_CONFLICT",
          message: "本地 agent 正在同步专利，请稍后修改页边距。",
        });
        return;
      }
      if (
        stateRef.current.sessions.some((session) =>
          session.patent.books.some(
            (book) =>
              !fitDocumentTables(
                book.document,
                applyPageMarginsToPage(book.document.page, margins),
              ),
          ),
        )
      ) {
        showApplicationError({
          code: "INVALID_INPUT",
          message: "页边距无法容纳表格，请减小左右页边距或减少表格列数。文档未改变。",
        });
        return;
      }
      setPageMargins(margins);
      for (const session of stateRef.current.sessions) {
        const bookEdits = session.patent.books
          .map((book) => {
            const nextPage = applyPageMarginsToPage(book.document.page, margins);
            const fitted = fitDocumentTables(book.document, nextPage);
            if (!fitted) return null;
            if (
              nextPage.marginTopMm === book.document.page.marginTopMm &&
              nextPage.marginRightMm === book.document.page.marginRightMm &&
              nextPage.marginBottomMm === book.document.page.marginBottomMm &&
              nextPage.marginLeftMm === book.document.page.marginLeftMm
            ) {
              return null;
            }
            return {
              bookKind: book.kind,
              document: fitted,
              editorState: book.editorState,
            };
          })
          .filter((edit): edit is NonNullable<typeof edit> => edit !== null);
        if (bookEdits.length === 0) continue;
        ensureQueue(session).enqueueTransaction(bookEdits);
      }
    },
    [ensureQueue],
  );

  const preparePatentExport = useCallback(
    async (patentId: string) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session || !(await drainPatent(session))) return null;
      const snapshot = ensureQueue(session).snapshot();
      return {
        patentId: session.patentId,
        sessionId: session.sessionId,
        expectedRevision: snapshot.persistedRevision,
        suggestedName: createDocxSuggestedName(snapshot.patent.name ?? "未命名专利"),
      };
    },
    [drainPatent, ensureQueue],
  );

  const prepareActivePatentExport = useCallback(async () => {
    return activeSession ? preparePatentExport(activeSession.patentId) : null;
  }, [activeSession, preparePatentExport]);

  const prepareActiveAiCorrection = useCallback(async () => {
    if (!activeSession || !(await drainPatent(activeSession))) return null;
    const snapshot = ensureQueue(activeSession).snapshot();
    return {
      patentId: activeSession.patentId,
      sessionId: activeSession.sessionId,
      expectedRevision: snapshot.persistedRevision,
    };
  }, [activeSession, drainPatent, ensureQueue]);

  const exportActivePatdoc = useCallback(
    async (suggestedName?: string, workspace?: PatdocWorkspace) => {
      if (!activeSession || !(await drainPatent(activeSession))) return null;
      try {
        const snapshot = ensureQueue(activeSession).snapshot();
        const result = await window.patentApi.patents.exportPatdoc({
          ...(workspace ? { workspace } : {}),
          patentId: activeSession.patentId,
          expectedRevision: snapshot.persistedRevision,
          suggestedName: createDocxSuggestedName(
            suggestedName ?? snapshot.patent.name ?? "未命名专利",
          ),
        });
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        return result.value;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [activeSession, drainPatent, ensureQueue],
  );

  const closePatent = useCallback(
    async (patentId: string, options: { allowDiscardOnSaveFailure?: boolean } = {}) => {
      const pendingOperation = closingPatentOperations.current.get(patentId);
      if (pendingOperation) return pendingOperation;
      if (applicationCloseRunning.current) return false;
      // Render the existing read-only boundary before awaiting persistence. Late
      // editor/composition callbacks are still accepted and drained below.
      flushSync(() => setClosingPatentIds((ids) => new Set(ids).add(patentId)));
      const closeToken = `close:${patentId}`;
      const operation = Promise.resolve().then(async () => {
        const session = stateRef.current.sessions.find(
          (candidate) => candidate.patentId === patentId,
        );
        if (!session) return true;
        const queue = ensureQueue(session);
        const current = queue.snapshot().patent;
        const liveFigureAssets = new Set(current.figures.map((figure) => figure.assetId));
        for (const project of current.drawingProjects) {
          for (const assetId of drawingAssetIds(project)) liveFigureAssets.add(assetId);
        }
        const prunedAssets = current.assets.filter(
          (asset) =>
            asset.kind !== "vector-image" ||
            liveFigureAssets.has(asset.assetId) ||
            current.books.some((book) => JSON.stringify(book.document).includes(asset.assetId)) ||
            current.auxiliaryDocuments.some((document) =>
              JSON.stringify(document.document).includes(asset.assetId),
            ),
        );
        if (prunedAssets.length !== current.assets.length) {
          queue.enqueueFigureEdit({
            figures: current.figures,
            abstractDrawingFigureId: current.abstractDrawingFigureId,
            assets: prunedAssets,
          });
        }
        let persisted = await drainPatent(session);
        for (;;) {
          const snapshotRevision = queue.snapshot().localRevision;
          if (!persisted) {
            if (options.allowDiscardOnSaveFailure === false) return false;
            if (
              !(await confirmAppAction(
                "保存仍然失败。是否放弃本次未保存的修改并关闭专利？已成功保存的内容不会丢失。",
              ))
            ) {
              return false;
            }
          }
          if (persisted) {
            if (options.allowDiscardOnSaveFailure === false) {
              // Agent requests must fail safely instead of waiting for a GUI retry/skip decision.
              try {
                await createExplicitSnapshot(patentId, "patent-close");
              } catch {
                return false;
              }
            } else if (!(await createCloseSnapshot(patentId, "patent-close"))) return false;
          }
          if (
            persisted &&
            (queue.automationStatus().dirty || queue.snapshot().localRevision !== snapshotRevision)
          ) {
            persisted = await drainPatent(session);
            continue;
          }
          break;
        }
        // No await between the final revision check and freezing new writes.
        if (!queue.freeze(closeToken)) return false;
        if (!(await releaseSession(session.sessionId))) return false;
        queue.dispose();
        queues.current.delete(session.patentId);
        automationLocks.current.delete(session.patentId);
        setAutomationViews((current) => ({
          ...current,
          [session.patentId]: { readOnly: false, epoch: current[session.patentId]?.epoch ?? 0 },
        }));
        referenceUndo.current.invalidate(patentId);
        descriptionDrawingHistory.current.invalidate(patentId);
        requestPatentCloseBackup(patentId);
        const closeAction = { type: "CLOSE_PATENT", patentId } as const;
        stateRef.current = patentReducer(stateRef.current, closeAction);
        dispatch(closeAction);
        return true;
      });
      closingPatentOperations.current.set(patentId, operation);
      try {
        return await operation;
      } finally {
        queues.current.get(patentId)?.releaseFreeze(closeToken);
        setClosingPatentIds((ids) => {
          const next = new Set(ids);
          next.delete(patentId);
          return next;
        });
        if (closingPatentOperations.current.get(patentId) === operation) {
          closingPatentOperations.current.delete(patentId);
        }
      }
    },
    [createCloseSnapshot, createExplicitSnapshot, drainPatent, ensureQueue, releaseSession],
  );

  closeForAutomation.current = closePatent;

  const requestClose = useCallback(
    (patentId: string) => {
      void closePatent(patentId);
    },
    [closePatent],
  );

  const flushAllForApplicationClose = useCallback(async () => {
    if (applicationCloseRunning.current || closingPatentOperations.current.size > 0) return false;
    applicationCloseRunning.current = true;
    try {
      for (;;) {
        const sessions = [...stateRef.current.sessions];
        for (const session of sessions) {
          if (!(await drainPatent(session))) return false;
        }
        const revisions = new Map(
          sessions.map((session) => [
            session.patentId,
            ensureQueue(session).snapshot().localRevision,
          ]),
        );
        for (const session of sessions) {
          if (!(await createCloseSnapshot(session.patentId, "application-close"))) return false;
        }
        // Snapshot creation yields to late composition/import callbacks. Re-drain
        // all books until the snapshot and persisted revisions describe the same state.
        if (
          stateRef.current.sessions.length === sessions.length &&
          stateRef.current.sessions.every((session) => {
            const queue = ensureQueue(session);
            return (
              revisions.get(session.patentId) === queue.snapshot().localRevision &&
              !queue.automationStatus().dirty
            );
          })
        )
          return true;
      }
    } finally {
      applicationCloseRunning.current = false;
    }
  }, [createCloseSnapshot, drainPatent, ensureQueue]);

  useApplicationCloseParticipant("patents", flushAllForApplicationClose, "aggregate");

  const saveFlowchartSource = useCallback(
    async (
      patentId: string,
      input: Omit<FlowchartSaveRequest, "patentId" | "expectedPatentRevision">,
    ): Promise<AppResult<FlowchartOpenedProject>> => {
      if (automationLocks.current.has(patentId))
        return {
          ok: false,
          error: { code: "REVISION_CONFLICT", message: "本地 agent 正在同步专利，请稍后重试。" },
        };
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.patentId === patentId,
      );
      if (!session) {
        return { ok: false, error: { code: "NOT_FOUND", message: "未找到已打开的专利。" } };
      }
      const queue = ensureQueue(session);
      queue.enqueueFlowchartSource(input);
      try {
        await queue.flush();
        if (queue.automationStatus().frozen)
          throw new Error("本地 agent 正在同步专利，请稍后重试。");
        const snapshot = queue.snapshot();
        const project = snapshot.patent.flowchartProjects.find(
          (candidate) => candidate.projectId === input.projectId,
        );
        if (!project) {
          return { ok: false, error: { code: "INTERNAL", message: "流程图保存结果不完整。" } };
        }
        return {
          ok: true,
          value: {
            project,
            source: Uint8Array.from(input.source),
            patentRevision: snapshot.persistedRevision,
          },
        };
      } catch (error) {
        return { ok: false, error: appError(error) };
      }
    },
    [ensureQueue],
  );

  const flowcharts = useMemo<PatentApi["flowcharts"]>(() => {
    const sessionFor = (patentId: string) =>
      stateRef.current.sessions.find((candidate) => candidate.patentId === patentId);
    const missingSession = () =>
      ({ ok: false, error: { code: "NOT_FOUND", message: "未找到已打开的专利。" } }) as const;
    return {
      list: (patentId) => window.patentApi.flowcharts.list(patentId),
      load: (request) => window.patentApi.flowcharts.load(request),
      exportBackup: (request) => window.patentApi.flowcharts.exportBackup(request),
      renderPreview: (request) => window.patentApi.flowcharts.renderPreview(request),
      commitPreview: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.commitPreview({
                ...request,
                sessionId: session.sessionId,
                expectedPatentRevision,
              }),
            (saved) => ({ patent: saved.patent, savedAt: saved.savedAt }),
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
      save: (request) =>
        saveFlowchartSource(request.patentId, {
          projectId: request.projectId,
          expectedProjectRevision: request.expectedProjectRevision,
          source: request.source,
          pageCount: request.pageCount,
          lastPageId: request.lastPageId,
        }),
      create: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.create({ ...request, expectedPatentRevision }),
            (saved, patent) => ({
              patent: {
                ...patent,
                revision: saved.patentRevision,
                flowchartProjects: [
                  ...patent.flowchartProjects.filter(
                    (item) => item.projectId !== saved.project.projectId,
                  ),
                  saved.project,
                ],
              },
              savedAt: saved.project.modifiedAt,
            }),
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
      importFile: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.importFile({ ...request, expectedPatentRevision }),
            (saved, patent) =>
              saved
                ? {
                    patent: {
                      ...patent,
                      revision: saved.patentRevision,
                      flowchartProjects: [
                        ...patent.flowchartProjects.filter(
                          (item) => item.projectId !== saved.project.projectId,
                        ),
                        saved.project,
                      ],
                    },
                    savedAt: saved.project.modifiedAt,
                  }
                : null,
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
      rename: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.rename({ ...request, expectedPatentRevision }),
            (saved, patent) => ({
              patent: {
                ...patent,
                revision: saved.patentRevision,
                flowchartProjects: patent.flowchartProjects.map((item) =>
                  item.projectId === saved.project.projectId ? saved.project : item,
                ),
              },
              savedAt: saved.project.modifiedAt,
            }),
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
      duplicate: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.duplicate({ ...request, expectedPatentRevision }),
            (saved, patent) => ({
              patent: {
                ...patent,
                revision: saved.patentRevision,
                flowchartProjects: [...patent.flowchartProjects, saved.project],
              },
              savedAt: saved.project.modifiedAt,
            }),
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
      delete: async (request) => {
        const session = sessionFor(request.patentId);
        if (!session) return missingSession();
        const queue = ensureQueue(session);
        try {
          await queue.flush();
          if (queue.automationStatus().frozen)
            throw new Error("本地 agent 正在同步专利，请稍后重试。");
          return await queue.runPersistedMutation(
            (expectedPatentRevision) =>
              window.patentApi.flowcharts.delete({ ...request, expectedPatentRevision }),
            (saved, patent) => ({
              patent: {
                ...patent,
                revision: saved.patentRevision,
                flowchartProjects: patent.flowchartProjects.filter(
                  (item) => item.projectId !== request.projectId,
                ),
                figures: patent.figures.map((figure) => {
                  if (figure.flowchartLink?.projectId !== request.projectId) return figure;
                  const { flowchartLink: _removed, ...detachedFigure } = figure;
                  return detachedFigure;
                }),
              },
              savedAt: new Date().toISOString(),
            }),
          );
        } catch (error) {
          return { ok: false, error: appError(error) };
        }
      },
    };
  }, [ensureQueue, saveFlowchartSource]);

  const value = useMemo<PatentContextValue>(
    () => ({
      state,
      hasOpenPatents,
      isAutomationReadOnly,
      automationEditorEpoch,
      activeSession,
      flowcharts,
      newPatent,
      openPatent,
      importPatdoc,
      commitDocxImport,
      exportActivePatdoc,
      activatePatent,
      activateBook,
      activateAuxiliaryDocument,
      createAuxiliaryDocument,
      updateAuxiliaryDocument,
      renameAuxiliaryDocument,
      deleteAuxiliaryDocument,
      moveAuxiliaryDocument,
      updateBookDocument,
      updatePatentFigures,
      appendImportedPatentFigures,
      updateDesignPatent,
      prepareDesignPatentExport,
      adoptDesignPatentExport,
      updatePatentSettings,
      setDrawingBooksEnabled,
      applyReferenceMarkPlan,
      getReferenceMarkPatentSnapshot,
      canUndoReferenceMarkOperation,
      discardReferenceMarkRedo,
      undoReferenceMarkOperation,
      canRedoReferenceMarkOperation,
      redoReferenceMarkOperation,
      canUndoDescriptionDrawing,
      undoDescriptionDrawing,
      canRedoDescriptionDrawing,
      redoDescriptionDrawing,
      applyPageMargins,
      saveFlowchartSource,
      saveActivePatent,
      persistActivePatent,
      preparePatentSnapshot,

      prepareActivePatentExport,
      preparePatentExport,
      prepareActiveAiCorrection,
      requestClose,
      closePatent,
    }),
    [
      state,
      hasOpenPatents,
      isAutomationReadOnly,
      automationEditorEpoch,
      activeSession,
      flowcharts,
      newPatent,
      openPatent,
      importPatdoc,
      commitDocxImport,
      exportActivePatdoc,
      activatePatent,
      activateBook,
      activateAuxiliaryDocument,
      createAuxiliaryDocument,
      updateAuxiliaryDocument,
      renameAuxiliaryDocument,
      deleteAuxiliaryDocument,
      moveAuxiliaryDocument,
      updateBookDocument,
      updatePatentFigures,
      appendImportedPatentFigures,
      updateDesignPatent,
      prepareDesignPatentExport,
      adoptDesignPatentExport,
      updatePatentSettings,
      setDrawingBooksEnabled,
      applyReferenceMarkPlan,
      getReferenceMarkPatentSnapshot,
      canUndoReferenceMarkOperation,
      discardReferenceMarkRedo,
      undoReferenceMarkOperation,
      canRedoReferenceMarkOperation,
      redoReferenceMarkOperation,
      canUndoDescriptionDrawing,
      undoDescriptionDrawing,
      canRedoDescriptionDrawing,
      redoDescriptionDrawing,
      applyPageMargins,
      saveFlowchartSource,
      saveActivePatent,
      persistActivePatent,
      preparePatentSnapshot,

      prepareActivePatentExport,
      preparePatentExport,
      prepareActiveAiCorrection,
      requestClose,
      closePatent,
    ],
  );

  return (
    <PatentContext.Provider value={value}>
      {children}
      {Object.entries(automationViews)
        .filter(([, view]) => view.readOnly)
        .map(([patentId]) => (
          <div role="status" key={patentId}>
            本地 agent 正在同步专利；当前文档暂时只读。
            {automationLocks.current.get(patentId)?.unsafe ? (
              <button type="button" onClick={() => void resyncAutomationPatent(patentId)}>
                重新同步已保存版本
              </button>
            ) : null}
          </div>
        ))}
      {!window.patentApi.tutorial?.isSession && (
        <BackupRuntimeCoordinator
          targets={state.sessions.map((session) => ({
            patentId: session.patentId,
            revision: session.persistedRevision,
          }))}
        />
      )}
      <MotionPresence>
        {manualSaveFeedback ? (
          <OperationFeedbackOverlay
            feedback={manualSaveFeedback}
            onClose={() => setManualSaveFeedback(null)}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {manualSnapshotError ? (
          <StandardDialog
            open
            title="手动保存快照创建失败"
            size="s"
            dialogRole="alertdialog"
            onCancel={() => setManualSnapshotError(null)}
            footer={
              <button
                type="button"
                className="primary-button"
                onClick={() => setManualSnapshotError(null)}
              >
                知道了
              </button>
            }
          >
            <p className="standard-dialog__danger-message">{manualSnapshotError}</p>
          </StandardDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {closeSnapshotError ? (
          <SnapshotCloseFailureDialog
            key={closeSnapshotFailureId}
            errorMessage={closeSnapshotError}
            onDecision={decideCloseSnapshotFailure}
          />
        ) : null}
      </MotionPresence>
      <SpatialPresence>
        {closeSnapshotWarning ? (
          <div role="alert">
            正文及编辑内容已经安全保存，但本次关闭恢复点未能创建。
            <button type="button" onClick={() => setCloseSnapshotWarning(false)}>
              关闭提示
            </button>
          </div>
        ) : null}
      </SpatialPresence>
    </PatentContext.Provider>
  );
}

export function usePatents(): PatentContextValue {
  const value = useContext(PatentContext);
  if (!value) throw new Error("usePatents must be used inside PatentProvider");
  return value;
}

export function usePatentAutomationSession(sessionId?: string): {
  readOnly: boolean;
  epoch: number;
} {
  const context = useContext(PatentContext);
  const session = context?.state.sessions.find((candidate) => candidate.sessionId === sessionId);
  return session && context
    ? {
        readOnly: context.isAutomationReadOnly(session.patentId),
        epoch: context.automationEditorEpoch(session.patentId),
      }
    : { readOnly: false, epoch: 0 };
}
