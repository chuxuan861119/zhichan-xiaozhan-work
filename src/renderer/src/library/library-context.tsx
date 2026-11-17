import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { DraftSummary, OpenedLibraryDocument } from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import {
  animateVisibleDocumentStructureRulerEntries,
  visibleDocumentStructureRulers,
} from "../patents/document-structure-ruler-motion";
import { showApplicationError } from "../shared/error-dialog";
import { prefersReducedMotion } from "../shared/motion-preference";

type LibraryView = "library" | "editor" | "trash";

type LibraryContextValue = {
  view: LibraryView;
  activeDocuments: LibraryDocumentSummary[];
  activePatents: LibraryPatentSummary[];
  trashDocuments: LibraryDocumentSummary[];
  trashPatents: LibraryPatentSummary[];
  legacyDrafts: DraftSummary[];
  activeLoading: boolean;
  activeError: AppError | null;
  trashLoading: boolean;
  trashError: AppError | null;
  legacyMigrationDismissed: boolean;
  setView(view: LibraryView): void;
  refreshActive(): Promise<boolean>;
  refreshTrash(): Promise<void>;
  refreshLegacyDrafts(): Promise<void>;
  dismissLegacyMigration(): void;
  importLegacyDraft(draftId: string): Promise<OpenedLibraryDocument | null>;
  renameDocument(document: LibraryDocumentSummary, title: string): Promise<boolean>;
  moveToTrash(document: LibraryDocumentSummary): Promise<boolean>;
  movePatentToTrash(patent: LibraryPatentSummary): Promise<boolean>;
  recoverPatent(patent: LibraryPatentSummary): Promise<boolean>;
  restoreDocument(document: LibraryDocumentSummary): Promise<boolean>;
  restorePatent(patent: LibraryPatentSummary): Promise<boolean>;
  permanentlyDeleteDocument(document: LibraryDocumentSummary): Promise<boolean>;
  permanentlyDeletePatent(patent: LibraryPatentSummary): Promise<boolean>;
};

const LibraryContext = createContext<LibraryContextValue | null>(null);

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

function sortByModifiedAtDescending(documents: LibraryDocumentSummary[]): LibraryDocumentSummary[] {
  return documents
    .slice()
    .sort((first, second) => Date.parse(second.modifiedAt) - Date.parse(first.modifiedAt));
}

function sortPatentsByModifiedAtDescending(
  patents: LibraryPatentSummary[],
): LibraryPatentSummary[] {
  return patents
    .slice()
    .sort((first, second) => Date.parse(second.modifiedAt) - Date.parse(first.modifiedAt));
}

export function LibraryProvider({ children }: PropsWithChildren) {
  const [view, setViewState] = useState<LibraryView>("library");
  const viewRef = useRef(view);
  const viewRequestRef = useRef(0);
  const activeViewTransitionRef = useRef<ViewTransition | null>(null);
  const activeRulerEntryAnimationsRef = useRef<Animation[]>([]);
  const pendingEditorEntryFrameRef = useRef<number | null>(null);
  const [activeDocuments, setActiveDocuments] = useState<LibraryDocumentSummary[]>([]);
  const [activePatents, setActivePatents] = useState<LibraryPatentSummary[]>([]);
  const [trashDocuments, setTrashDocuments] = useState<LibraryDocumentSummary[]>([]);
  const [trashPatents, setTrashPatents] = useState<LibraryPatentSummary[]>([]);
  const [legacyDrafts, setLegacyDrafts] = useState<DraftSummary[]>([]);
  const [activeLoading, setActiveLoading] = useState(true);
  const [activeError, setActiveError] = useState<AppError | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<AppError | null>(null);
  const [legacyMigrationDismissed, setLegacyMigrationDismissed] = useState(false);

  const setView = useCallback((nextView: LibraryView) => {
    const previousView = viewRef.current;
    if (previousView === nextView) return;
    // Track intent before Chromium invokes the asynchronous snapshot callback.
    // A closed lesson can open its replacement while the library transition is pending.
    viewRef.current = nextView;
    const request = ++viewRequestRef.current;
    activeViewTransitionRef.current?.skipTransition?.();
    activeViewTransitionRef.current = null;

    document.documentElement.classList.remove(
      "library-editor-view-transition",
      "library-editor-function-rail-entry",
      "library-editor-ruler-entry-pending",
      "library-trash-view-transition",
      "library-trash-view-transition-enter",
      "library-trash-view-transition-exit",
    );
    if (pendingEditorEntryFrameRef.current !== null) {
      cancelAnimationFrame(pendingEditorEntryFrameRef.current);
      pendingEditorEntryFrameRef.current = null;
    }
    for (const animation of activeRulerEntryAnimationsRef.current) animation.cancel();
    activeRulerEntryAnimationsRef.current = [];

    const isLibraryEditorSwitch =
      (previousView === "library" && nextView === "editor") ||
      (previousView === "editor" && nextView === "library");
    const isLibraryTrashSwitch =
      (previousView === "library" && nextView === "trash") ||
      (previousView === "trash" && nextView === "library");
    const startViewTransition = document.startViewTransition;
    if (
      (!isLibraryEditorSwitch && !isLibraryTrashSwitch) ||
      typeof startViewTransition !== "function" ||
      prefersReducedMotion()
    ) {
      viewRef.current = nextView;
      setViewState(nextView);
      return;
    }

    if (isLibraryEditorSwitch) {
      document.documentElement.classList.add("library-editor-view-transition");
      if (previousView === "library" && nextView === "editor") {
        document.documentElement.classList.add("library-editor-ruler-entry-pending");
      }
    } else {
      document.documentElement.classList.add(
        "library-trash-view-transition",
        nextView === "trash"
          ? "library-trash-view-transition-enter"
          : "library-trash-view-transition-exit",
      );
    }
    try {
      const transition = startViewTransition.call(document, () => {
        if (request !== viewRequestRef.current) return;
        flushSync(() => setViewState(nextView));
      });
      activeViewTransitionRef.current = transition;
      // Skipping a superseded/hidden transition rejects ready independently of finished.
      void transition.ready?.catch(() => undefined);
      void transition.finished
        .catch(() => undefined)
        .finally(() => {
          if (activeViewTransitionRef.current !== transition) return;
          activeViewTransitionRef.current = null;
          if (previousView === "library" && nextView === "editor" && viewRef.current === "editor") {
            let remainingFrames = 4;
            const startEditorEntryMotion = () => {
              pendingEditorEntryFrameRef.current = null;
              if (viewRef.current !== "editor") {
                document.documentElement.classList.remove(
                  "library-editor-view-transition",
                  "library-editor-ruler-entry-pending",
                );
                return;
              }
              if (visibleDocumentStructureRulers().length === 0 && remainingFrames > 0) {
                remainingFrames -= 1;
                pendingEditorEntryFrameRef.current = requestAnimationFrame(startEditorEntryMotion);
                return;
              }
              activeRulerEntryAnimationsRef.current = animateVisibleDocumentStructureRulerEntries();
              document.documentElement.classList.add("library-editor-function-rail-entry");
              document.documentElement.classList.remove(
                "library-editor-view-transition",
                "library-editor-ruler-entry-pending",
              );
            };
            pendingEditorEntryFrameRef.current = requestAnimationFrame(startEditorEntryMotion);
          } else {
            document.documentElement.classList.remove(
              "library-editor-view-transition",
              "library-trash-view-transition",
              "library-trash-view-transition-enter",
              "library-trash-view-transition-exit",
            );
          }
        });
    } catch {
      document.documentElement.classList.remove(
        "library-editor-view-transition",
        "library-editor-ruler-entry-pending",
        "library-trash-view-transition",
        "library-trash-view-transition-enter",
        "library-trash-view-transition-exit",
      );
      viewRef.current = nextView;
      setViewState(nextView);
    }
  }, []);

  useEffect(
    () => () => {
      if (pendingEditorEntryFrameRef.current !== null) {
        cancelAnimationFrame(pendingEditorEntryFrameRef.current);
        pendingEditorEntryFrameRef.current = null;
      }
      for (const animation of activeRulerEntryAnimationsRef.current) animation.cancel();
      activeRulerEntryAnimationsRef.current = [];
      document.documentElement.classList.remove(
        "library-editor-view-transition",
        "library-editor-function-rail-entry",
        "library-editor-ruler-entry-pending",
        "library-trash-view-transition",
        "library-trash-view-transition-enter",
        "library-trash-view-transition-exit",
      );
    },
    [],
  );

  const refreshActive = useCallback(async () => {
    setActiveLoading(true);
    try {
      const patentsApi = (
        window.patentApi as typeof window.patentApi & { patents?: typeof window.patentApi.patents }
      ).patents;
      if (patentsApi) {
        setActiveDocuments([]);
        const patentResult = await patentsApi.list("active");
        if (patentResult.ok) {
          setActivePatents(sortPatentsByModifiedAtDescending(patentResult.value));
          setActiveError(null);
          return true;
        }
        setActiveError(patentResult.error);
        return false;
      } else {
        setActivePatents([]);
        const result = await window.patentApi.library.list("active");
        if (result.ok) {
          setActiveDocuments(sortByModifiedAtDescending(result.value));
          setActiveError(null);
          return true;
        }
        setActiveError(result.error);
        return false;
      }
    } catch (error) {
      setActiveError(appError(error));
      return false;
    } finally {
      setActiveLoading(false);
    }
  }, []);

  const refreshTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const patentsApi = (
        window.patentApi as typeof window.patentApi & { patents?: typeof window.patentApi.patents }
      ).patents;
      if (patentsApi) {
        setTrashDocuments([]);
        const patentResult = await patentsApi.list("trash");
        if (patentResult.ok) {
          setTrashPatents(sortPatentsByModifiedAtDescending(patentResult.value));
          setTrashError(null);
        } else setTrashError(patentResult.error);
      } else {
        setTrashPatents([]);
        const result = await window.patentApi.library.list("trash");
        if (result.ok) {
          setTrashDocuments(sortByModifiedAtDescending(result.value));
          setTrashError(null);
        } else setTrashError(result.error);
      }
    } catch (error) {
      setTrashError(appError(error));
    } finally {
      setTrashLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshActive();
  }, [refreshActive]);

  useEffect(
    () =>
      window.patentApi.automation?.onEvent((event) => {
        if (event.type !== "libraryChanged") return;
        void refreshActive();
        void refreshTrash();
      }),
    [refreshActive, refreshTrash],
  );

  const refreshLegacyDrafts = useCallback(async () => {
    const patentsApi = (
      window.patentApi as typeof window.patentApi & { patents?: typeof window.patentApi.patents }
    ).patents;
    if (patentsApi) {
      setLegacyDrafts([]);
      return;
    }
    const listLegacyDrafts = window.patentApi.library.listLegacyDrafts;
    if (!listLegacyDrafts) return;
    try {
      const result = await listLegacyDrafts();
      if (result.ok) setLegacyDrafts(result.value);
      else showApplicationError(result.error);
    } catch (error) {
      showApplicationError(appError(error));
    }
  }, []);

  useEffect(() => {
    void refreshLegacyDrafts();
  }, [refreshLegacyDrafts]);

  const renameDocument = useCallback(
    async (document: LibraryDocumentSummary, title: string) => {
      try {
        const requestRename = (candidate: LibraryDocumentSummary) =>
          window.patentApi.library.rename({
            libraryDocumentId: candidate.libraryDocumentId,
            operationId: crypto.randomUUID(),
            expectedRevision: candidate.revision,
            title,
          });
        let result = await requestRename(document);
        if (!result.ok && result.error.code === "REVISION_CONFLICT") {
          const refreshed = await window.patentApi.library.list("active");
          if (!refreshed.ok) {
            showApplicationError(refreshed.error);
            return false;
          }
          const active = sortByModifiedAtDescending(refreshed.value);
          setActiveDocuments(active);
          const latest = active.find(
            (candidate) => candidate.libraryDocumentId === document.libraryDocumentId,
          );
          if (!latest) {
            showApplicationError({ code: "NOT_FOUND", message: "Document not found" });
            return false;
          }
          result = await requestRename(latest);
        }
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive],
  );

  const moveToTrash = useCallback(
    async (document: LibraryDocumentSummary) => {
      try {
        const result = await window.patentApi.library.moveToTrash(document.libraryDocumentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive, refreshTrash],
  );

  const movePatentToTrash = useCallback(
    async (patent: LibraryPatentSummary) => {
      try {
        const result = await window.patentApi.patents.moveToTrash(patent.patentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive, refreshTrash],
  );

  const restoreDocument = useCallback(
    async (document: LibraryDocumentSummary) => {
      try {
        const result = await window.patentApi.library.restore(document.libraryDocumentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive, refreshTrash],
  );

  const recoverPatent = useCallback(
    async (patent: LibraryPatentSummary) => {
      try {
        const result = await window.patentApi.patents.recover(patent.patentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive],
  );

  const permanentlyDeleteDocument = useCallback(
    async (document: LibraryDocumentSummary) => {
      try {
        const result = await window.patentApi.library.permanentlyDelete(document.libraryDocumentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshTrash],
  );

  const restorePatent = useCallback(
    async (patent: LibraryPatentSummary) => {
      try {
        const result = await window.patentApi.patents.restore(patent.patentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshActive();
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshActive, refreshTrash],
  );

  const permanentlyDeletePatent = useCallback(
    async (patent: LibraryPatentSummary) => {
      try {
        const result = await window.patentApi.patents.permanentlyDelete(patent.patentId);
        if (!result.ok) {
          showApplicationError(result.error);
          return false;
        }
        await refreshTrash();
        return true;
      } catch (error) {
        showApplicationError(appError(error));
        return false;
      }
    },
    [refreshTrash],
  );

  const importLegacyDraft = useCallback(
    async (draftId: string) => {
      try {
        const result = await window.patentApi.library.importLegacyDraft(draftId);
        if (!result.ok) {
          showApplicationError(result.error);
          return null;
        }
        await refreshActive();
        await refreshLegacyDrafts();
        return result.value;
      } catch (error) {
        showApplicationError(appError(error));
        return null;
      }
    },
    [refreshActive, refreshLegacyDrafts],
  );

  const value = useMemo<LibraryContextValue>(
    () => ({
      view,
      activeDocuments,
      activePatents,
      trashDocuments,
      trashPatents,
      legacyDrafts,
      activeLoading,
      activeError,
      trashLoading,
      trashError,
      legacyMigrationDismissed,
      setView,
      refreshActive,
      refreshTrash,
      refreshLegacyDrafts,
      dismissLegacyMigration: () => setLegacyMigrationDismissed(true),
      importLegacyDraft,
      renameDocument,
      moveToTrash,
      movePatentToTrash,
      recoverPatent,
      restoreDocument,
      restorePatent,
      permanentlyDeleteDocument,
      permanentlyDeletePatent,
    }),
    [
      view,
      activeDocuments,
      activePatents,
      trashDocuments,
      trashPatents,
      legacyDrafts,
      activeLoading,
      activeError,
      trashLoading,
      trashError,
      legacyMigrationDismissed,
      setView,
      refreshActive,
      refreshTrash,
      refreshLegacyDrafts,
      importLegacyDraft,
      renameDocument,
      moveToTrash,
      movePatentToTrash,
      recoverPatent,
      restoreDocument,
      restorePatent,
      permanentlyDeleteDocument,
      permanentlyDeletePatent,
    ],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary must be used inside LibraryProvider");
  return value;
}
