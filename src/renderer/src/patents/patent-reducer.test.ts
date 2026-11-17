import { createBlankBookDocument } from "../../../shared/document/defaults";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PATENT_BOOK_ORDER, type PatentBookKind } from "../../../shared/patent/model";
import {
  createPatentSession,
  createPatentState,
  PATENT_REDUCER_ACTION_TYPES,
  type PatentSession,
  patentReducer,
} from "./patent-reducer";

const patentIds = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
] as const;
const sessionIds = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
] as const;

function openedPatent(index: 0 | 1, activeBookKind: PatentBookKind = "description"): OpenedPatent {
  const patent = {
    ...createBlankPatent({ patentType: "invention", name: `专利 ${index + 1}` }),
    patentId: patentIds[index],
    activeBookKind,
    revision: index,
  };

  return {
    patentId: patent.patentId,
    sessionId: sessionIds[index],
    revision: patent.revision,
    patent,
    saveState: "saved",
  };
}

function claimsText(session: PatentSession): string {
  const claims = session.patent.books.find((book) => book.kind === "claims");
  const paragraph = claims?.document.content[0];
  if (paragraph?.type !== "paragraph") return "";
  const text = paragraph?.content[0];
  return text?.type === "text" ? text.text : "";
}

function sessionWithClaimsText(session: PatentSession, text: string): PatentSession {
  return {
    ...session,
    patent: {
      ...session.patent,
      books: session.patent.books.map((book) =>
        book.kind === "claims"
          ? {
              ...book,
              document: {
                ...book.document,
                content: [
                  {
                    id: "00000000-0000-4000-8000-000000000301",
                    type: "paragraph",
                    attrs: {
                      alignment: "left",
                      paragraphIndentMm: 0,
                      lineSpacing: 1.5,
                      defaultFontFamily: "SimSun",
                      defaultFontSizePt: 12,
                    },
                    content: [{ type: "text", text, marks: [] }],
                  },
                ],
              },
            }
          : book,
      ),
    },
  };
}

describe("patent reducer", () => {
  test("reuses the coordinator's immutable queued patent instead of cloning all five books", () => {
    const session = createPatentSession(openedPatent(0));
    const state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });
    const changed = sessionWithClaimsText(session, "新内容");
    const snapshot = { ...changed, localRevision: 1, persistedRevision: 0 };
    const next = patentReducer(state, { type: "SESSION_MODEL_QUEUED", snapshot });
    expect(next.sessions[0]?.patent).toBe(snapshot.patent);
    expect(next.sessions[0]?.patent.books.find((b) => b.kind === "description")).toBe(
      session.patent.books.find((b) => b.kind === "description"),
    );
    expect(claimsText(session)).not.toBe("新内容");
  });

  test("switches exclusively between an official book and an auxiliary document", () => {
    const opened = openedPatent(0);
    opened.patent.auxiliaryDocuments = [
      {
        auxiliaryDocumentId: "00000000-0000-4000-8000-000000000401",
        title: "其他文档 1",
        document: createBlankBookDocument("其他文档 1"),
        editorState: {},
        localRevision: 0,
        persistedRevision: 0,
        sourceFileName: null,
      },
    ];
    const session = createPatentSession(opened);
    let state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });

    state = patentReducer(state, {
      type: "ACTIVATE_AUXILIARY_DOCUMENT",
      patentId: session.patentId,
      auxiliaryDocumentId: "00000000-0000-4000-8000-000000000401",
    });
    expect(state.sessions[0]).toMatchObject({
      activeAuxiliaryDocumentId: "00000000-0000-4000-8000-000000000401",
    });

    state = patentReducer(state, {
      type: "ACTIVATE_BOOK",
      patentId: session.patentId,
      bookKind: "claims",
    });
    expect(state.sessions[0]).toMatchObject({
      activeBookKind: "claims",
      activeAuxiliaryDocumentId: null,
    });
  });

  test("opens multiple patent sessions and preserves the active book per patent", () => {
    let state = createPatentState();
    const first = createPatentSession(openedPatent(0));
    const second = createPatentSession(openedPatent(1, "claims"));

    state = patentReducer(state, { type: "OPEN_PATENT", session: first });
    state = patentReducer(state, { type: "OPEN_PATENT", session: second });
    state = patentReducer(state, {
      type: "ACTIVATE_BOOK",
      patentId: first.patentId,
      bookKind: "abstract",
    });
    state = patentReducer(state, { type: "ACTIVATE_PATENT", patentId: second.patentId });

    expect(state.sessions.map((session) => session.patentId)).toEqual(patentIds);
    expect(state.activePatentId).toBe(second.patentId);
    expect(
      state.sessions.find((session) => session.patentId === first.patentId)?.activeBookKind,
    ).toBe("abstract");
    expect(
      state.sessions.find((session) => session.patentId === second.patentId)?.activeBookKind,
    ).toBe("claims");
  });

  test("exposes only whole-patent close actions, never single-book close actions", () => {
    expect(PATENT_REDUCER_ACTION_TYPES).toContain("CLOSE_PATENT");
    expect(PATENT_REDUCER_ACTION_TYPES).not.toContain("CLOSE_BOOK");
  });

  test("marks the patent saved only after the edited book and aggregate revision are persisted", () => {
    const session = createPatentSession(openedPatent(0));
    let state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });
    const claims = session.patent.books.find((book) => book.kind === "claims");
    expect(claims).toBeDefined();
    if (!claims) return;
    const editedClaims = {
      ...claims.document,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000301",
          type: "paragraph" as const,
          attrs: {
            alignment: "left" as const,
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 12,
          },
          content: [{ type: "text" as const, text: "1. 一种夹具。", marks: [] }],
        },
      ],
    };

    const queuedSnapshot = {
      ...session,
      patent: {
        ...session.patent,
        revision: 1,
        books: session.patent.books.map((book) =>
          book.kind === "claims"
            ? { ...book, document: editedClaims, editorState: { cursor: 1 }, localRevision: 1 }
            : book,
        ),
      },
      bookSaveStates: { ...session.bookSaveStates, claims: "saving" as const },
      aggregateSaveState: "saving" as const,
      localRevision: 1,
      persistedRevision: 0,
      lastSavedAt: null,
      saveError: null,
    };
    state = patentReducer(state, {
      type: "SESSION_MODEL_QUEUED",
      snapshot: queuedSnapshot,
    });
    const queued = state.sessions[0];
    expect(queued).toMatchObject({
      aggregateSaveState: "saving",
      localRevision: 1,
      persistedRevision: 0,
    });
    expect(queued?.bookSaveStates.claims).toBe("saving");

    state = patentReducer(state, {
      type: "SESSION_SAVE_STATUS_CHANGED",
      snapshot: {
        ...queuedSnapshot,
        patent: {
          ...queuedSnapshot.patent,
          books: queuedSnapshot.patent.books.map((book) =>
            book.kind === "claims" ? { ...book, persistedRevision: 1 } : book,
          ),
        },
        bookSaveStates: { ...session.bookSaveStates, claims: "saved" as const },
        aggregateSaveState: "saved",
        persistedRevision: 1,
        lastSavedAt: "2026-08-02T00:00:01.000Z",
      },
    });

    expect(state.sessions[0]).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 1,
      persistedRevision: 1,
      lastSavedAt: "2026-08-02T00:00:01.000Z",
    });
    expect(state.sessions[0]?.bookSaveStates).toEqual(
      Object.fromEntries(PATENT_BOOK_ORDER.map((kind) => [kind, "saved"])),
    );
  });

  test("accepts a settled flowchart no-op snapshot after it was optimistically queued", () => {
    const session = createPatentSession(openedPatent(0));
    let state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });
    const queuedSnapshot = {
      ...session,
      patent: { ...session.patent, revision: 1 },
      aggregateSaveState: "saving" as const,
      localRevision: 1,
      persistedRevision: 0,
    };

    state = patentReducer(state, {
      type: "SESSION_MODEL_QUEUED",
      snapshot: queuedSnapshot,
    });
    state = patentReducer(state, {
      type: "SESSION_SAVE_STATUS_CHANGED",
      snapshot: {
        ...queuedSnapshot,
        patent: { ...queuedSnapshot.patent, revision: 0 },
        aggregateSaveState: "saved",
        revisionStateRebased: true,
        localRevision: 0,
        persistedRevision: 0,
      },
    });

    expect(state.sessions[0]).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 0,
      persistedRevision: 0,
      patent: { revision: 0 },
    });
  });

  test("save status snapshots do not roll back newer queued book text", () => {
    const session = sessionWithClaimsText(createPatentSession(openedPatent(0)), "第一版");
    let state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });
    const firstQueued = {
      ...session,
      patent: {
        ...session.patent,
        revision: 1,
        books: session.patent.books.map((book) =>
          book.kind === "claims"
            ? {
                ...book,
                document:
                  sessionWithClaimsText(session, "第一版已排队").patent.books.find(
                    (candidate) => candidate.kind === "claims",
                  )?.document ?? book.document,
                localRevision: 1,
                persistedRevision: 1,
              }
            : book,
        ),
      },
      bookSaveStates: { ...session.bookSaveStates, claims: "saved" as const },
      aggregateSaveState: "saved" as const,
      localRevision: 1,
      persistedRevision: 1,
      lastSavedAt: "2026-08-02T00:00:01.000Z",
      saveError: null,
    };
    const secondQueued = {
      ...firstQueued,
      patent: {
        ...firstQueued.patent,
        revision: 2,
        books: firstQueued.patent.books.map((book) =>
          book.kind === "claims"
            ? {
                ...book,
                document:
                  sessionWithClaimsText(session, "第二版仍在编辑").patent.books.find(
                    (candidate) => candidate.kind === "claims",
                  )?.document ?? book.document,
                localRevision: 2,
                persistedRevision: 0,
              }
            : book,
        ),
      },
      bookSaveStates: { ...session.bookSaveStates, claims: "saving" as const },
      aggregateSaveState: "saving" as const,
      localRevision: 2,
      persistedRevision: 0,
      lastSavedAt: null,
    };

    state = patentReducer(state, {
      type: "SESSION_MODEL_QUEUED",
      snapshot: secondQueued,
    } as Parameters<typeof patentReducer>[1]);
    state = patentReducer(state, {
      type: "SESSION_SAVE_STATUS_CHANGED",
      snapshot: firstQueued,
    } as Parameters<typeof patentReducer>[1]);

    const updated = state.sessions[0];
    expect(updated ? claimsText(updated) : "").toBe("第二版仍在编辑");
    expect(updated).toMatchObject({
      aggregateSaveState: "saving",
      localRevision: 2,
      persistedRevision: 1,
      lastSavedAt: "2026-08-02T00:00:01.000Z",
    });
    expect(updated?.patent.books.find((book) => book.kind === "claims")?.persistedRevision).toBe(1);
  });

  test("keeps the whole patent open when a book save fails and allows retrying that book", () => {
    const session = createPatentSession(openedPatent(0));
    let state = patentReducer(createPatentState(), { type: "OPEN_PATENT", session });
    const error = { code: "DISK_FULL" as const, message: "磁盘空间不足" };

    state = patentReducer(state, {
      type: "SESSION_SAVE_STATUS_CHANGED",
      snapshot: {
        ...session,
        bookSaveStates: { ...session.bookSaveStates, description: "failed" },
        aggregateSaveState: "failed",
        saveError: error,
      },
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      aggregateSaveState: "failed",
      saveError: error,
    });
    expect(state.sessions[0]?.bookSaveStates.description).toBe("failed");

    state = patentReducer(state, {
      type: "SESSION_SAVE_STATUS_CHANGED",
      snapshot: {
        ...session,
        bookSaveStates: { ...session.bookSaveStates, description: "saving" },
        aggregateSaveState: "saving",
        saveError: null,
      },
    });
    expect(state.sessions[0]).toMatchObject({
      aggregateSaveState: "saving",
      saveError: null,
    });
    expect(state.sessions[0]?.bookSaveStates.description).toBe("saving");
  });
});
