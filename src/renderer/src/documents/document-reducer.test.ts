import {
  createDocumentSession,
  createInitialDocumentState,
  documentReducer,
} from "./document-reducer";

describe("document reducer", () => {
  test("starts with one active untitled document", () => {
    const state = createInitialDocumentState();

    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe(state.sessions[0]?.sessionId);
    expect(state.sessions[0]?.model.title).toBe("文档 1");
    expect(state.sessions[0]?.libraryDocumentId).toBe(state.sessions[0]?.sessionId);
    expect(state.sessions[0]?.saveState).toBe("saved");
    expect(state.sessions[0]?.localRevision).toBe(0);
    expect(state.sessions[0]?.persistedRevision).toBe(0);
  });

  test("creates and activates a unique new session", () => {
    const initial = createInitialDocumentState();
    const nextSession = createDocumentSession("文档 2", "session-2");
    const state = documentReducer(initial, { type: "NEW_DOCUMENT", session: nextSession });

    expect(state.sessions).toHaveLength(2);
    expect(new Set(state.sessions.map((session) => session.sessionId)).size).toBe(2);
    expect(state.activeSessionId).toBe("session-2");
  });

  test("activates one session without changing the others", () => {
    const first = createInitialDocumentState();
    const second = documentReducer(first, {
      type: "NEW_DOCUMENT",
      session: createDocumentSession("文档 2", "session-2"),
    });
    const before = second.sessions;
    const state = documentReducer(second, {
      type: "ACTIVATE_DOCUMENT",
      sessionId: before[0]?.sessionId ?? "",
    });

    expect(state.sessions).toBe(before);
    expect(state.activeSessionId).toBe(before[0]?.sessionId);
  });

  test("marks a queued edit as saving and confirms it only when the matching revision is saved", () => {
    const initial = createInitialDocumentState();
    const sessionId = initial.activeSessionId;
    const initialSession = initial.sessions[0];
    expect(initialSession).toBeDefined();
    if (!initialSession) return;
    const changedModel = { ...initialSession.model, title: "已修改" };
    const queued = documentReducer(initial, {
      type: "EDIT_QUEUED",
      sessionId,
      model: changedModel,
      localRevision: 1,
    });
    const savedAt = "2026-07-31T13:00:00.000Z";
    const staleAck = documentReducer(queued, {
      type: "EDIT_CONFIRMED",
      sessionId,
      persistedRevision: 0,
      savedAt,
    });
    const saved = documentReducer(queued, {
      type: "EDIT_CONFIRMED",
      sessionId,
      persistedRevision: 1,
      savedAt,
    });

    expect(queued.sessions[0]).toMatchObject({
      model: changedModel,
      saveState: "saving",
      localRevision: 1,
      persistedRevision: 0,
    });
    expect(staleAck.sessions[0]).toMatchObject({
      saveState: "saving",
      localRevision: 1,
      persistedRevision: 0,
    });
    expect(saved.sessions[0]).toMatchObject({
      saveState: "saved",
      lastSavedAt: savedAt,
      localRevision: 1,
      persistedRevision: 1,
    });
  });

  test("does not mark later queued edits saved when an older acknowledgement completes", () => {
    const initial = createInitialDocumentState();
    const sessionId = initial.activeSessionId;
    const initialSession = initial.sessions[0];
    expect(initialSession).toBeDefined();
    if (!initialSession) return;
    const firstModel = { ...initialSession.model, title: "第一次" };
    const secondModel = { ...initialSession.model, title: "第二次" };
    const firstEdit = documentReducer(initial, {
      type: "EDIT_QUEUED",
      sessionId,
      model: firstModel,
      localRevision: 1,
    });
    const laterEdit = documentReducer(firstEdit, {
      type: "EDIT_QUEUED",
      sessionId,
      model: secondModel,
      localRevision: 2,
    });
    const completed = documentReducer(laterEdit, {
      type: "EDIT_CONFIRMED",
      sessionId,
      persistedRevision: 1,
      savedAt: "2026-07-31T13:00:00.000Z",
    });

    expect(completed.sessions[0]).toMatchObject({
      model: secondModel,
      saveState: "saving",
      localRevision: 2,
      persistedRevision: 1,
    });
  });

  test("updates queued model only for the addressed document", () => {
    const first = createInitialDocumentState();
    const second = documentReducer(first, {
      type: "NEW_DOCUMENT",
      session: createDocumentSession("文档 2", "session-2"),
    });
    const firstSession = second.sessions[0];
    expect(firstSession).toBeDefined();
    if (!firstSession) return;
    const changedModel = { ...firstSession.model, title: "已修改" };

    const state = documentReducer(second, {
      type: "EDIT_QUEUED",
      sessionId: firstSession.sessionId,
      model: changedModel,
      localRevision: 1,
    });

    expect(state.sessions[0]).toMatchObject({
      model: changedModel,
      saveState: "saving",
      localRevision: 1,
    });
    expect(state.sessions[1]).toBe(second.sessions[1]);
  });

  test("reorders tabs without changing the active session", () => {
    const initial = createInitialDocumentState();
    const second = documentReducer(initial, {
      type: "NEW_DOCUMENT",
      session: createDocumentSession("文档 2", "session-2"),
    });
    const activeSessionId = second.activeSessionId;
    const state = documentReducer(second, { type: "REORDER_DOCUMENTS", fromIndex: 1, toIndex: 0 });

    expect(state.sessions.map((session) => session.sessionId)).toEqual([
      "session-2",
      initial.sessions[0]?.sessionId,
    ]);
    expect(state.activeSessionId).toBe(activeSessionId);
  });

  test("activates the adjacent tab when closing the active document", () => {
    let state = createInitialDocumentState();
    state = documentReducer(state, {
      type: "NEW_DOCUMENT",
      session: createDocumentSession("文档 2", "session-2"),
    });
    state = documentReducer(state, {
      type: "NEW_DOCUMENT",
      session: createDocumentSession("文档 3", "session-3"),
    });

    state = documentReducer(state, { type: "CLOSE_DOCUMENT", sessionId: "session-3" });
    expect(state.activeSessionId).toBe("session-2");
    expect(state.sessions.map((session) => session.sessionId)).not.toContain("session-3");
  });

  test("activates an existing tab when the library document is already open", () => {
    const initial = createInitialDocumentState();
    const existingId = initial.activeSessionId;
    const libraryDocumentId = "00000000-0000-4000-8000-000000000701";
    const initialSession = initial.sessions[0];
    expect(initialSession).toBeDefined();
    if (!initialSession) return;
    const withLibraryId = {
      ...initial,
      sessions: [{ ...initialSession, libraryDocumentId }],
    };
    const duplicate = {
      ...createDocumentSession("重复文档", "duplicate-session"),
      libraryDocumentId,
    };

    const state = documentReducer(withLibraryId, { type: "OPEN_DOCUMENT", session: duplicate });

    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe(existingId);
  });

  test("records failed and retrying save states without changing queued revisions", () => {
    const initial = createInitialDocumentState();
    const sessionId = initial.activeSessionId;
    const error = { code: "DISK_FULL" as const, message: "磁盘空间不足" };
    const failed = documentReducer(initial, { type: "EDIT_FAILED", sessionId, error });
    const retrying = documentReducer(failed, { type: "EDIT_RETRYING", sessionId });

    expect(failed.sessions[0]).toMatchObject({ saveState: "failed", saveError: error });
    expect(retrying.sessions[0]).toMatchObject({ saveState: "saving", saveError: null });
  });
});
