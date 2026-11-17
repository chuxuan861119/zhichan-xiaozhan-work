import { createBlankDocument } from "../../../shared/document/defaults";
import type { CanonicalDocument } from "../../../shared/document/model";
import { randomUuid } from "../../../shared/id";
import type { AppError } from "../../../shared/ipc/result";
import type { LibrarySaveState } from "../../../shared/library/model";

export type DocumentSession = {
  sessionId: string;
  libraryDocumentId: string;
  model: CanonicalDocument;
  saveState: LibrarySaveState;
  localRevision: number;
  persistedRevision: number;
  lastSavedAt: string | null;
  saveError: AppError | null;
  selection: { from: number; to: number } | null;
  scrollTop: number;
  textCounts: {
    chineseCharacters: number;
    totalCharacters: number;
    selectedCharacters: number;
  };
};

export type DocumentState = {
  sessions: DocumentSession[];
  activeSessionId: string;
};

export type DocumentAction =
  | { type: "NEW_DOCUMENT"; session: DocumentSession }
  | { type: "OPEN_DOCUMENT"; session: DocumentSession }
  | { type: "ACTIVATE_DOCUMENT"; sessionId: string }
  | {
      type: "EDIT_QUEUED";
      sessionId: string;
      model: CanonicalDocument;
      localRevision: number;
    }
  | {
      type: "EDIT_CONFIRMED";
      sessionId: string;
      persistedRevision: number;
      savedAt: string;
    }
  | { type: "EDIT_FAILED"; sessionId: string; error: AppError }
  | { type: "EDIT_RETRYING"; sessionId: string }
  | { type: "DOCUMENT_RELOADED"; session: DocumentSession }
  | { type: "REORDER_DOCUMENTS"; fromIndex: number; toIndex: number }
  | {
      type: "UPDATE_TEXT_COUNTS";
      sessionId: string;
      counts: DocumentSession["textCounts"];
    }
  | { type: "CLOSE_DOCUMENT"; sessionId: string };

export function createDocumentSession(
  title: string,
  sessionId: string = randomUuid(),
  libraryDocumentId: string = sessionId,
): DocumentSession {
  return {
    sessionId,
    libraryDocumentId,
    model: createBlankDocument(title),
    saveState: "saved",
    localRevision: 0,
    persistedRevision: 0,
    lastSavedAt: null,
    saveError: null,
    selection: null,
    scrollTop: 0,
    textCounts: { chineseCharacters: 0, totalCharacters: 0, selectedCharacters: 0 },
  };
}

export function createInitialDocumentState(): DocumentState {
  const session = createDocumentSession("文档 1");
  return { sessions: [session], activeSessionId: session.sessionId };
}

function updateSession(
  state: DocumentState,
  sessionId: string,
  update: (session: DocumentSession) => DocumentSession,
): DocumentState {
  const index = state.sessions.findIndex((session) => session.sessionId === sessionId);
  if (index < 0) return state;

  const sessions = state.sessions.slice();
  const current = sessions[index];
  if (!current) return state;
  sessions[index] = update(current);
  return { ...state, sessions };
}

export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case "NEW_DOCUMENT": {
      if (state.sessions.some((session) => session.sessionId === action.session.sessionId)) {
        return { ...state, activeSessionId: action.session.sessionId };
      }
      const existing = state.sessions.find(
        (session) => session.libraryDocumentId === action.session.libraryDocumentId,
      );
      if (existing) return { ...state, activeSessionId: existing.sessionId };
      return {
        sessions: [...state.sessions, action.session],
        activeSessionId: action.session.sessionId,
      };
    }
    case "OPEN_DOCUMENT": {
      return documentReducer(state, { type: "NEW_DOCUMENT", session: action.session });
    }
    case "ACTIVATE_DOCUMENT":
      return state.sessions.some((session) => session.sessionId === action.sessionId)
        ? { ...state, activeSessionId: action.sessionId }
        : state;
    case "EDIT_QUEUED":
      return updateSession(state, action.sessionId, (session) => ({
        ...session,
        model: action.model,
        saveState: session.saveState === "failed" ? "failed" : "saving",
        localRevision: Math.max(session.localRevision, action.localRevision),
      }));
    case "EDIT_CONFIRMED":
      return updateSession(state, action.sessionId, (session) => ({
        ...session,
        persistedRevision:
          action.persistedRevision > session.persistedRevision
            ? action.persistedRevision
            : session.persistedRevision,
        saveState:
          action.persistedRevision >= session.localRevision &&
          action.persistedRevision >= session.persistedRevision
            ? "saved"
            : session.saveState === "failed"
              ? "failed"
              : "saving",
        saveError:
          action.persistedRevision >= session.localRevision &&
          action.persistedRevision >= session.persistedRevision
            ? null
            : session.saveError,
        lastSavedAt:
          action.persistedRevision > session.persistedRevision
            ? action.savedAt
            : session.lastSavedAt,
      }));
    case "EDIT_FAILED":
      return updateSession(state, action.sessionId, (session) => ({
        ...session,
        saveState: "failed",
        saveError: action.error,
      }));
    case "EDIT_RETRYING":
      return updateSession(state, action.sessionId, (session) => ({
        ...session,
        saveState: "saving",
        saveError: null,
      }));
    case "DOCUMENT_RELOADED":
      return updateSession(state, action.session.sessionId, () => action.session);
    case "REORDER_DOCUMENTS": {
      if (
        action.fromIndex < 0 ||
        action.toIndex < 0 ||
        action.fromIndex >= state.sessions.length ||
        action.toIndex >= state.sessions.length ||
        action.fromIndex === action.toIndex
      ) {
        return state;
      }
      const sessions = state.sessions.slice();
      const [moved] = sessions.splice(action.fromIndex, 1);
      if (!moved) return state;
      sessions.splice(action.toIndex, 0, moved);
      return { ...state, sessions };
    }
    case "UPDATE_TEXT_COUNTS":
      return updateSession(state, action.sessionId, (session) => ({
        ...session,
        textCounts: action.counts,
      }));
    case "CLOSE_DOCUMENT": {
      const closingIndex = state.sessions.findIndex(
        (session) => session.sessionId === action.sessionId,
      );
      if (closingIndex < 0) return state;

      const sessions = state.sessions.filter((session) => session.sessionId !== action.sessionId);
      if (sessions.length === 0) return { sessions: [], activeSessionId: "" };
      if (state.activeSessionId !== action.sessionId) return { ...state, sessions };

      const adjacent = sessions[Math.min(closingIndex, sessions.length - 1)];
      return adjacent ? { sessions, activeSessionId: adjacent.sessionId } : state;
    }
  }
}
