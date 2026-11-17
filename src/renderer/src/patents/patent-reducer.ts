import type { OpenedPatent } from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import type { LibrarySaveState } from "../../../shared/library/model";
import { readPatdocWorkspace } from "../../../shared/patent/continuation";
import {
  type CanonicalPatent,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../../shared/patent/model";
import { inheritDocumentEcho } from "../editor/content-fingerprint";
import type { PatentSaveCoordinatorSnapshot } from "./patent-save-coordinator";

export type PatentSession = {
  sessionId: string;
  patentId: string;
  patent: CanonicalPatent;
  activeBookKind: PatentBookKind;
  activeAuxiliaryDocumentId: string | null;
  bookSaveStates: Record<PatentBookKind, LibrarySaveState>;
  auxiliarySaveStates: Record<string, LibrarySaveState>;
  aggregateSaveState: LibrarySaveState;
  localRevision: number;
  persistedRevision: number;
  lastSavedAt: string | null;
  saveError: AppError | null;
};

export type PatentState = {
  sessions: PatentSession[];
  activePatentId: string;
};

export const PATENT_REDUCER_ACTION_TYPES = [
  "OPEN_PATENT",
  "ACTIVATE_PATENT",
  "ACTIVATE_BOOK",
  "ACTIVATE_AUXILIARY_DOCUMENT",
  "SESSION_MODEL_QUEUED",
  "SESSION_SAVE_STATUS_CHANGED",
  "SESSION_PERSISTED_PATENT_ADOPTED",
  "CLOSE_PATENT",
] as const;

export type PatentAction =
  | { type: "OPEN_PATENT"; session: PatentSession }
  | { type: "ACTIVATE_PATENT"; patentId: string }
  | { type: "ACTIVATE_BOOK"; patentId: string; bookKind: PatentBookKind }
  | {
      type: "ACTIVATE_AUXILIARY_DOCUMENT";
      patentId: string;
      auxiliaryDocumentId: string;
    }
  | { type: "SESSION_MODEL_QUEUED"; snapshot: PatentSaveCoordinatorSnapshot }
  | { type: "SESSION_SAVE_STATUS_CHANGED"; snapshot: PatentSaveCoordinatorSnapshot }
  | { type: "SESSION_PERSISTED_PATENT_ADOPTED"; snapshot: PatentSaveCoordinatorSnapshot }
  | { type: "CLOSE_PATENT"; patentId: string };

export function createPatentState(): PatentState {
  return { sessions: [], activePatentId: "" };
}

export function createPatentSession(opened: OpenedPatent): PatentSession {
  return {
    sessionId: opened.sessionId,
    patentId: opened.patentId,
    patent: structuredClone(opened.patent),
    activeBookKind:
      readPatdocWorkspace(opened.patent)?.activeBookKind ?? opened.patent.activeBookKind,
    activeAuxiliaryDocumentId: null,
    bookSaveStates: createBookSaveStates(opened.saveState),
    auxiliarySaveStates: createAuxiliarySaveStates(opened.patent, opened.saveState),
    aggregateSaveState: opened.saveState,
    localRevision: opened.revision,
    persistedRevision: opened.revision,
    lastSavedAt: null,
    saveError: null,
  };
}

export function patentReducer(state: PatentState, action: PatentAction): PatentState {
  switch (action.type) {
    case "OPEN_PATENT": {
      const existing = state.sessions.find(
        (session) => session.patentId === action.session.patentId,
      );
      if (existing) return { ...state, activePatentId: existing.patentId };

      return {
        sessions: [...state.sessions, action.session],
        activePatentId: action.session.patentId,
      };
    }
    case "ACTIVATE_PATENT":
      return state.sessions.some((session) => session.patentId === action.patentId)
        ? { ...state, activePatentId: action.patentId }
        : state;
    case "ACTIVATE_BOOK":
      return updateSession(state, action.patentId, (session) => {
        if (!PATENT_BOOK_ORDER.includes(action.bookKind)) return session;
        return {
          ...session,
          activeBookKind: action.bookKind,
          activeAuxiliaryDocumentId: null,
          patent: { ...session.patent, activeBookKind: action.bookKind },
        };
      });
    case "ACTIVATE_AUXILIARY_DOCUMENT":
      return updateSession(state, action.patentId, (session) =>
        session.patent.auxiliaryDocuments.some(
          (document) => document.auxiliaryDocumentId === action.auxiliaryDocumentId,
        )
          ? { ...session, activeAuxiliaryDocumentId: action.auxiliaryDocumentId }
          : session,
      );
    case "SESSION_MODEL_QUEUED":
      return updateSession(state, action.snapshot.patentId, (session) => ({
        ...session,
        // The coordinator clones inputs and replaces state immutably. Keep its
        // unchanged books shared rather than cloning all five books on each key.
        patent: action.snapshot.patent,
        bookSaveStates: { ...action.snapshot.bookSaveStates },
        auxiliarySaveStates: {
          ...session.auxiliarySaveStates,
          ...action.snapshot.auxiliarySaveStates,
        },
        aggregateSaveState: action.snapshot.aggregateSaveState,
        localRevision: action.snapshot.localRevision,
        persistedRevision: action.snapshot.persistedRevision,
        lastSavedAt: action.snapshot.lastSavedAt,
        saveError: action.snapshot.saveError,
      }));
    case "SESSION_SAVE_STATUS_CHANGED":
      return updateSession(state, action.snapshot.patentId, (session) => {
        const revisionStateRebased = action.snapshot.revisionStateRebased === true;
        const patent = {
          ...session.patent,
          revision: revisionStateRebased
            ? action.snapshot.patent.revision
            : Math.max(session.patent.revision, action.snapshot.patent.revision),
          flowchartProjects: structuredClone(action.snapshot.patent.flowchartProjects),
          books: session.patent.books.map((book) => {
            const queuedBook = action.snapshot.patent.books.find(
              (candidate) => candidate.kind === book.kind,
            );
            return queuedBook
              ? {
                  ...book,
                  localRevision: Math.max(book.localRevision, queuedBook.localRevision),
                  persistedRevision: Math.max(book.persistedRevision, queuedBook.persistedRevision),
                }
              : book;
          }),
          auxiliaryDocuments: session.patent.auxiliaryDocuments.map((document) => {
            const queued = action.snapshot.patent.auxiliaryDocuments.find(
              (candidate) => candidate.auxiliaryDocumentId === document.auxiliaryDocumentId,
            );
            return queued
              ? {
                  ...document,
                  localRevision: Math.max(document.localRevision, queued.localRevision),
                  persistedRevision: Math.max(document.persistedRevision, queued.persistedRevision),
                }
              : document;
          }),
        };
        const bookSaveStates = Object.fromEntries(
          patent.books.map((book) => {
            const snapshotState = action.snapshot.bookSaveStates[book.kind];
            const state =
              snapshotState === "failed"
                ? "failed"
                : book.localRevision > book.persistedRevision
                  ? "saving"
                  : snapshotState;
            return [book.kind, state];
          }),
        ) as Record<PatentBookKind, LibrarySaveState>;
        const localRevision = revisionStateRebased
          ? action.snapshot.localRevision
          : Math.max(session.localRevision, action.snapshot.localRevision);
        const persistedRevision = Math.max(
          session.persistedRevision,
          action.snapshot.persistedRevision,
        );
        const aggregateSaveState = deriveAggregateSaveState({
          bookSaveStates,
          auxiliarySaveStates: action.snapshot.auxiliarySaveStates ?? session.auxiliarySaveStates,
          localRevision,
          persistedRevision,
        });
        return {
          ...session,
          patent,
          bookSaveStates,
          auxiliarySaveStates: {
            ...session.auxiliarySaveStates,
            ...action.snapshot.auxiliarySaveStates,
          },
          aggregateSaveState: action.snapshot.saveError ? "failed" : aggregateSaveState,
          localRevision,
          persistedRevision,
          lastSavedAt:
            action.snapshot.persistedRevision > session.persistedRevision
              ? action.snapshot.lastSavedAt
              : session.lastSavedAt,
          saveError: action.snapshot.saveError,
        };
      });
    case "SESSION_PERSISTED_PATENT_ADOPTED":
      return updateSession(state, action.snapshot.patentId, (session) => ({
        ...session,
        patent: clonePatentWithDocumentEcho(action.snapshot.patent),
        activeBookKind: action.snapshot.patent.activeBookKind,
        activeAuxiliaryDocumentId:
          session.activeAuxiliaryDocumentId &&
          action.snapshot.patent.auxiliaryDocuments.some(
            (document) => document.auxiliaryDocumentId === session.activeAuxiliaryDocumentId,
          )
            ? session.activeAuxiliaryDocumentId
            : null,
        bookSaveStates: { ...action.snapshot.bookSaveStates },
        auxiliarySaveStates:
          action.snapshot.auxiliarySaveStates ??
          createAuxiliarySaveStates(action.snapshot.patent, "saved"),
        aggregateSaveState: action.snapshot.aggregateSaveState,
        localRevision: action.snapshot.localRevision,
        persistedRevision: action.snapshot.persistedRevision,
        lastSavedAt: action.snapshot.lastSavedAt,
        saveError: action.snapshot.saveError,
      }));
    case "CLOSE_PATENT": {
      const closingIndex = state.sessions.findIndex(
        (session) => session.patentId === action.patentId,
      );
      if (closingIndex < 0) return state;

      const sessions = state.sessions.filter((session) => session.patentId !== action.patentId);
      if (sessions.length === 0) return { sessions: [], activePatentId: "" };
      if (state.activePatentId !== action.patentId) return { ...state, sessions };

      const adjacent = sessions[Math.min(closingIndex, sessions.length - 1)];
      return adjacent ? { sessions, activePatentId: adjacent.patentId } : state;
    }
  }
}

function clonePatentWithDocumentEcho(patent: CanonicalPatent): CanonicalPatent {
  const copy = structuredClone(patent);
  for (const book of copy.books) {
    const original = patent.books.find((candidate) => candidate.kind === book.kind);
    if (original) inheritDocumentEcho(original.document, book.document);
  }
  for (const document of copy.auxiliaryDocuments) {
    const original = patent.auxiliaryDocuments.find(
      (candidate) => candidate.auxiliaryDocumentId === document.auxiliaryDocumentId,
    );
    if (original) inheritDocumentEcho(original.document, document.document);
  }
  return copy;
}

function createBookSaveStates(
  saveState: LibrarySaveState,
): Record<PatentBookKind, LibrarySaveState> {
  return Object.fromEntries(PATENT_BOOK_ORDER.map((kind) => [kind, saveState])) as Record<
    PatentBookKind,
    LibrarySaveState
  >;
}

function createAuxiliarySaveStates(
  patent: CanonicalPatent,
  saveState: LibrarySaveState,
): Record<string, LibrarySaveState> {
  return Object.fromEntries(
    patent.auxiliaryDocuments.map((document) => [document.auxiliaryDocumentId, saveState]),
  );
}

function updateSession(
  state: PatentState,
  patentId: string,
  update: (session: PatentSession) => PatentSession,
): PatentState {
  const index = state.sessions.findIndex((session) => session.patentId === patentId);
  if (index < 0) return state;

  const sessions = state.sessions.slice();
  const session = sessions[index];
  if (!session) return state;
  sessions[index] = update(session);
  return { ...state, sessions };
}

function deriveAggregateSaveState(input: {
  bookSaveStates: Record<PatentBookKind, LibrarySaveState>;
  auxiliarySaveStates: Record<string, LibrarySaveState>;
  localRevision: number;
  persistedRevision: number;
}): LibrarySaveState {
  if (Object.values(input.bookSaveStates).some((saveState) => saveState === "failed")) {
    return "failed";
  }
  if (Object.values(input.auxiliarySaveStates).some((saveState) => saveState === "failed")) {
    return "failed";
  }
  if (
    input.localRevision > input.persistedRevision ||
    Object.values(input.bookSaveStates).some((saveState) => saveState === "saving") ||
    Object.values(input.auxiliarySaveStates).some((saveState) => saveState === "saving")
  ) {
    return "saving";
  }
  return "saved";
}
