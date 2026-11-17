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
import type { CanonicalDocument } from "../../../shared/document/model";
import { fitDocumentTables } from "../../../shared/document/table-page-fit";
import type {
  OpenedDocument,
  OpenedLibraryDocument,
  PatentApi,
  SavedDocument,
} from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import {
  type AppSettings,
  type AppSettingsPatch,
  DEFAULT_APP_SETTINGS,
} from "../../../shared/settings/model";
import { applyPageMarginsToPage, type PageMargins } from "../../../shared/settings/page-margins";
import { useApplicationCloseParticipant } from "../app/application-close-coordinator";
import { rendererSaveRecovery } from "../app/renderer-save-recovery";
import { showApplicationError } from "../shared/error-dialog";
import { type DocumentSession, type DocumentState, documentReducer } from "./document-reducer";
import { DocumentSaveQueue, type DocumentSaveQueueSnapshot } from "./document-save-queue";

type DocumentContextValue = {
  state: DocumentState;
  activeSession: DocumentSession | null;
  pendingCloseSession: DocumentSession | null;
  settings: AppSettings;
  settingsReady: boolean;
  newDocument(): Promise<DocumentSession | null>;
  adoptOpenedLibraryDocument(opened: OpenedLibraryDocument): Promise<DocumentSession | null>;
  openLibraryDocument(libraryDocumentId: string): Promise<DocumentSession | null>;
  openDocument(path?: string): Promise<DocumentSession | null>;
  saveActiveDocument(): Promise<boolean>;
  saveActiveDocumentAs(): Promise<SavedDocument | null>;
  updateAppSettings(patch: AppSettingsPatch): Promise<AppSettings | null>;
  applyPageMargins(margins: PageMargins): void;
  refreshSettings(): Promise<void>;
  renameOpenDocument(libraryDocumentId: string, title: string): Promise<boolean | null>;
  completeWelcome(): Promise<AppSettings | null>;
  activateDocument(sessionId: string): void;
  requestClose(sessionId: string): Promise<number | null>;
  closeLibraryDocument(libraryDocumentId: string): Promise<void>;
  reorderDocuments(fromIndex: number, toIndex: number): void;
  updateDocumentModel(sessionId: string, model: CanonicalDocument): void;
  updateTextCounts(sessionId: string, counts: DocumentSession["textCounts"]): void;
  savePendingClose(): Promise<void>;
  discardPendingClose(): void;
  cancelPendingClose(): void;
};

const DocumentContext = createContext<DocumentContextValue | null>(null);
const EMPTY_DOCUMENT_STATE: DocumentState = { sessions: [], activeSessionId: "" };

function selectionFromEditorState(
  editorState: Record<string, unknown>,
): DocumentSession["selection"] {
  const selection = editorState.selection;
  return typeof selection === "object" &&
    selection !== null &&
    !Array.isArray(selection) &&
    typeof (selection as { from?: unknown }).from === "number" &&
    typeof (selection as { to?: unknown }).to === "number"
    ? {
        from: (selection as { from: number }).from,
        to: (selection as { to: number }).to,
      }
    : null;
}

function scrollTopFromEditorState(editorState: Record<string, unknown>): number {
  return typeof editorState.scrollTop === "number" ? editorState.scrollTop : 0;
}

function sessionFromOpenedLibraryDocument(opened: OpenedLibraryDocument): DocumentSession {
  return {
    sessionId: opened.sessionId,
    libraryDocumentId: opened.libraryDocumentId,
    model: opened.document,
    saveState: opened.saveState,
    localRevision: opened.revision,
    persistedRevision: opened.revision,
    lastSavedAt: null,
    saveError: null,
    selection: selectionFromEditorState(opened.editorState),
    scrollTop: scrollTopFromEditorState(opened.editorState),
    textCounts: { chineseCharacters: 0, totalCharacters: 0, selectedCharacters: 0 },
  };
}

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
  return { code: "INTERNAL", message: "normalized" };
}

export function DocumentProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(documentReducer, EMPTY_DOCUMENT_STATE);
  const [settings, setSettings] = useState(() => structuredClone(DEFAULT_APP_SETTINGS));
  const [settingsReady, setSettingsReady] = useState(false);
  const queues = useRef(new Map<string, DocumentSaveQueue>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const releaseSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const result = await window.patentApi.library.release(sessionId);
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

  const dispatchQueued = useCallback((snapshot: DocumentSaveQueueSnapshot) => {
    dispatch({
      type: "EDIT_QUEUED",
      sessionId: snapshot.sessionId,
      model: snapshot.model,
      localRevision: snapshot.localRevision,
    });
  }, []);

  const dispatchConfirmed = useCallback((snapshot: DocumentSaveQueueSnapshot) => {
    if (!snapshot.lastSavedAt) return;
    dispatch({
      type: "EDIT_CONFIRMED",
      sessionId: snapshot.sessionId,
      persistedRevision: snapshot.persistedRevision,
      savedAt: snapshot.lastSavedAt,
    });
  }, []);

  const dispatchFailed = useCallback((snapshot: DocumentSaveQueueSnapshot) => {
    if (!snapshot.saveError) return;
    dispatch({ type: "EDIT_FAILED", sessionId: snapshot.sessionId, error: snapshot.saveError });
    showApplicationError(snapshot.saveError);
  }, []);

  const dispatchRetrying = useCallback((snapshot: DocumentSaveQueueSnapshot) => {
    dispatch({ type: "EDIT_RETRYING", sessionId: snapshot.sessionId });
  }, []);

  const ensureQueue = useCallback(
    (session: DocumentSession): DocumentSaveQueue => {
      const existing = queues.current.get(session.sessionId);
      if (existing) return existing;
      const queue = new DocumentSaveQueue({
        libraryDocumentId: session.libraryDocumentId,
        sessionId: session.sessionId,
        initialDocument: session.model,
        initialRevision: session.persistedRevision,
        applyEdit: (batch) => window.patentApi.library.applyEdit(batch),
        flushRevision: (libraryDocumentId, revision) =>
          window.patentApi.library.flush({ libraryDocumentId, expectedRevision: revision }),
        onQueued: dispatchQueued,
        onConfirmed: dispatchConfirmed,
        onFailed: dispatchFailed,
        onRetrying: dispatchRetrying,
      });
      queues.current.set(session.sessionId, queue);
      return queue;
    },
    [dispatchConfirmed, dispatchFailed, dispatchQueued, dispatchRetrying],
  );

  const installOpenedLibraryDocument = useCallback(
    async (opened: OpenedLibraryDocument) => {
      const existing = stateRef.current.sessions.find(
        (session) => session.libraryDocumentId === opened.libraryDocumentId,
      );
      if (existing) {
        await releaseSession(opened.sessionId);
        dispatch({ type: "ACTIVATE_DOCUMENT", sessionId: existing.sessionId });
        return existing;
      }
      const session = sessionFromOpenedLibraryDocument(opened);
      const syncedModel = {
        ...session.model,
        page: applyPageMarginsToPage(session.model.page, settingsRef.current.pageMargins),
      };
      const syncedSession = { ...session, model: syncedModel };
      ensureQueue(syncedSession);
      const action = { type: "OPEN_DOCUMENT", session: syncedSession } as const;
      stateRef.current = documentReducer(stateRef.current, action);
      dispatch(action);
      return syncedSession;
    },
    [ensureQueue, releaseSession],
  );

  useEffect(() => {
    const settingsApi = window.patentApi?.settings;
    if (!settingsApi) return;
    void settingsApi
      .read()
      .then((result) => {
        if (result.ok) setSettings(result.value);
        else showApplicationError(result.error);
      })
      .catch((error) => showApplicationError(appError(error)))
      .finally(() => setSettingsReady(true));
  }, []);

  useLayoutEffect(
    () => () => {
      for (const queue of queues.current.values()) {
        if (queue.snapshot().saveState === "saved") {
          queue.dispose();
          continue;
        }
        rendererSaveRecovery.retain(queue, async () => {
          await queue.retry();
          await queue.flush({ snapshot: true });
          queue.dispose();
        });
      }
    },
    [],
  );

  const activeSession =
    state.sessions.find((session) => session.sessionId === state.activeSessionId) ??
    state.sessions[0] ??
    null;

  const newDocument = useCallback(async () => {
    try {
      const result = await window.patentApi.library.create();
      if (!result.ok) {
        showApplicationError(result.error);
        return null;
      }
      return await installOpenedLibraryDocument(result.value);
    } catch (error) {
      showApplicationError(appError(error));
      return null;
    }
  }, [installOpenedLibraryDocument]);

  const openLibraryDocument = useCallback(
    async (libraryDocumentId: string) => {
      try {
        const result = await window.patentApi.library.open(libraryDocumentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        return await installOpenedLibraryDocument(result.value);
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [installOpenedLibraryDocument],
  );

  const importLegacyOpenedDocument = useCallback(
    async (opened: OpenedDocument) => {
      const created = await window.patentApi.library.create();
      if (!created.ok) {
        showApplicationError(created.error);
        return null;
      }
      const session = await installOpenedLibraryDocument(created.value);
      const queue = ensureQueue(session);
      queue.enqueue(opened.document, {
        selection: opened.editorState.selection ?? null,
        scrollTop:
          typeof opened.editorState.scrollTop === "number" ? opened.editorState.scrollTop : 0,
      });
      return session;
    },
    [ensureQueue, installOpenedLibraryDocument],
  );

  const openDocument = useCallback(
    async (path?: string) => {
      try {
        if (path) {
          const result = await window.patentApi.documents.openPath(path);
          if (!result.ok) {
            showApplicationError(result.error);
            return null;
          }
          return await importLegacyOpenedDocument(result.value);
        }

        const result = await window.patentApi.library.importPatdoc();
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        if (result.value) return await installOpenedLibraryDocument(result.value);
        return null;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [importLegacyOpenedDocument, installOpenedLibraryDocument],
  );

  useEffect(() => {
    const patentApi = (window.patentApi as PatentApi & { patents?: PatentApi["patents"] }).patents;
    if (patentApi && "openPath" in patentApi) return;
    const onOpenPath = window.patentApi.application?.onOpenPath;
    if (!onOpenPath) return;
    return onOpenPath((path) => void openDocument(path));
  }, [openDocument]);

  const flushSession = useCallback(
    async (session: DocumentSession, snapshot: boolean) => {
      const queue = ensureQueue(session);
      try {
        if (queue.snapshot().saveState === "failed") await queue.retry();
        else await queue.flush();
        if (snapshot) await queue.flush({ snapshot: true });
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue],
  );

  const saveActiveDocument = useCallback(async () => {
    if (!activeSession) return false;
    return flushSession(activeSession, true);
  }, [activeSession, flushSession]);

  const saveActiveDocumentAs = useCallback(async () => {
    if (!activeSession) return null;
    if (!(await flushSession(activeSession, false))) return null;
    const queue = ensureQueue(activeSession);
    const snapshot = queue.snapshot();
    try {
      const result = await window.patentApi.library.exportPatdoc({
        libraryDocumentId: activeSession.libraryDocumentId,
        expectedRevision: snapshot.persistedRevision,
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
  }, [activeSession, ensureQueue, flushSession]);

  const renameOpenDocument = useCallback(
    async (libraryDocumentId: string, title: string): Promise<boolean | null> => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.libraryDocumentId === libraryDocumentId,
      );
      if (!session) return null;
      const queue = ensureQueue(session);
      const snapshot = queue.snapshot();
      if (snapshot.model.title === title) return true;
      queue.enqueue(
        { ...snapshot.model, title },
        { selection: session.selection, scrollTop: session.scrollTop },
      );
      try {
        await queue.flush({ snapshot: true });
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [ensureQueue],
  );

  const flushAllSessionsForClose = useCallback(async () => {
    for (const session of stateRef.current.sessions) {
      if (!(await flushSession(session, true))) return false;
    }
    return true;
  }, [flushSession]);

  useApplicationCloseParticipant("documents", flushAllSessionsForClose);

  const updateAppSettings = useCallback(
    async (patch: AppSettingsPatch): Promise<AppSettings | null> => {
      try {
        const result = await window.patentApi.settings.update(patch);
        if (result.ok) {
          setSettings(result.value);
          return result.value;
        }
        showApplicationError(result.error);
      } catch (error) {
        showApplicationError(appError(error));
      }
      return null;
    },
    [],
  );

  const completeWelcome = useCallback(async () => {
    return updateAppSettings({ welcomeCompleted: true });
  }, [updateAppSettings]);

  const applyPageMargins = useCallback(
    (margins: PageMargins) => {
      if (
        stateRef.current.sessions.some(
          (session) =>
            !fitDocumentTables(session.model, applyPageMarginsToPage(session.model.page, margins)),
        )
      ) {
        showApplicationError({
          code: "INVALID_INPUT",
          message: "页边距无法容纳表格，请减小左右页边距或减少表格列数。文档未改变。",
        });
        return;
      }
      setSettings((current) => ({ ...current, pageMargins: margins }));
      for (const session of stateRef.current.sessions) {
        const nextPage = applyPageMarginsToPage(session.model.page, margins);
        const fitted = fitDocumentTables(session.model, nextPage);
        if (!fitted) continue;
        if (
          nextPage.marginTopMm === session.model.page.marginTopMm &&
          nextPage.marginRightMm === session.model.page.marginRightMm &&
          nextPage.marginBottomMm === session.model.page.marginBottomMm &&
          nextPage.marginLeftMm === session.model.page.marginLeftMm
        ) {
          continue;
        }
        ensureQueue(session).enqueue(fitted, {
          selection: session.selection,
          scrollTop: session.scrollTop,
        });
      }
    },
    [ensureQueue],
  );

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.patentApi.settings.read();
      if (result.ok) setSettings(result.value);
      else showApplicationError(result.error);
    } catch (error) {
      showApplicationError(appError(error));
    }
  }, []);

  useEffect(
    () =>
      window.patentApi.automation?.onEvent((event) => {
        if (event.type === "libraryChanged" && event.command?.startsWith("global."))
          void refreshSettings();
      }),
    [refreshSettings],
  );

  const activateDocument = useCallback((sessionId: string) => {
    dispatch({ type: "ACTIVATE_DOCUMENT", sessionId });
  }, []);

  const closeSession = useCallback(
    async (sessionId: string): Promise<number | null> => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (!session) return null;
      if (!(await flushSession(session, false))) return null;
      if (!(await releaseSession(session.sessionId))) return null;
      queues.current.get(session.sessionId)?.dispose();
      queues.current.delete(session.sessionId);
      const remaining = stateRef.current.sessions.filter(
        (candidate) => candidate.sessionId !== sessionId,
      ).length;
      dispatch({ type: "CLOSE_DOCUMENT", sessionId });
      return remaining;
    },
    [flushSession, releaseSession],
  );

  const requestClose = useCallback((sessionId: string) => closeSession(sessionId), [closeSession]);

  const closeLibraryDocument = useCallback(
    async (libraryDocumentId: string) => {
      const sessions = stateRef.current.sessions.filter(
        (session) => session.libraryDocumentId === libraryDocumentId,
      );
      for (const session of sessions) await closeSession(session.sessionId);
    },
    [closeSession],
  );

  const reorderDocuments = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({ type: "REORDER_DOCUMENTS", fromIndex, toIndex });
  }, []);

  const updateDocumentModel = useCallback(
    (sessionId: string, model: CanonicalDocument) => {
      const session = stateRef.current.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (!session) return;
      ensureQueue(session).enqueue(model, {
        selection: session.selection,
        scrollTop: session.scrollTop,
      });
    },
    [ensureQueue],
  );

  const updateTextCounts = useCallback(
    (sessionId: string, counts: DocumentSession["textCounts"]) => {
      dispatch({ type: "UPDATE_TEXT_COUNTS", sessionId, counts });
    },
    [],
  );

  const savePendingClose = useCallback(async () => undefined, []);
  const discardPendingClose = useCallback(() => undefined, []);
  const cancelPendingClose = useCallback(() => undefined, []);

  const value = useMemo<DocumentContextValue>(() => {
    return {
      state,
      activeSession,
      pendingCloseSession: null,
      settings,
      settingsReady,
      newDocument,
      adoptOpenedLibraryDocument: installOpenedLibraryDocument,
      openLibraryDocument,
      openDocument,
      saveActiveDocument,
      saveActiveDocumentAs,
      updateAppSettings,
      applyPageMargins,
      refreshSettings,
      renameOpenDocument,
      completeWelcome,
      activateDocument,
      requestClose,
      closeLibraryDocument,
      reorderDocuments,
      updateDocumentModel,
      updateTextCounts,
      savePendingClose,
      discardPendingClose,
      cancelPendingClose,
    };
  }, [
    state,
    activeSession,
    settings,
    settingsReady,
    newDocument,
    installOpenedLibraryDocument,
    openLibraryDocument,
    openDocument,
    saveActiveDocument,
    saveActiveDocumentAs,
    updateAppSettings,
    applyPageMargins,
    refreshSettings,
    renameOpenDocument,
    completeWelcome,
    activateDocument,
    requestClose,
    closeLibraryDocument,
    reorderDocuments,
    updateDocumentModel,
    updateTextCounts,
    savePendingClose,
    discardPendingClose,
    cancelPendingClose,
  ]);

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocuments(): DocumentContextValue {
  const value = useContext(DocumentContext);
  if (!value) throw new Error("useDocuments must be used inside DocumentProvider");
  return value;
}
