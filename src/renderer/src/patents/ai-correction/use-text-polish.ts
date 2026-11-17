import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCorrectionBookKind,
  AiCorrectionPhase,
} from "../../../../shared/ai-correction/contract";
import type {
  TextPolishConversationEvent,
  TextPolishConversationMessage,
  TextPolishConversationModel,
  TextPolishConversationSnapshot,
  TextPolishConversationSource,
  TextPolishConversationSummary,
  TextPolishInputDraft,
  TextPolishResult,
  TextPolishWorkspace,
  TextPolishWorkspaceRequest,
} from "../../../../shared/ai-correction/text-polish-contract";
import { createSettingsId } from "../../../../shared/settings/model";
import { useEditorSelectionOverlay } from "../../editor/use-editor-selection-overlay";
import { InputDraftSaveQueue } from "./input-draft-save-queue";
import { inspectTextPolishSelection, type TextPolishSelectionState } from "./text-polish-anchor";
import {
  applyConversationEvent,
  applyConversationSnapshot,
  type TextPolishConversationProjection,
} from "./text-polish-conversation-state";

export type TextPolishStatus =
  | "idle"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type TextPolishEntry = {
  reasoningResetRevisions?: Record<string, number>;
  reasoningByTurn?: Record<string, { text: string; truncated: boolean }>;
  patentId: string;
  sessionId: string;
  bookKind: AiCorrectionBookKind;
  status: TextPolishStatus;
  jobId: string | null;
  result: TextPolishResult | null;
  error: string | null;
  phase: AiCorrectionPhase | null;
  reasoning: string;
  reasoningTruncated: boolean;
  conversationId: string | null;
  conversationRevision: number | null;
  messages: TextPolishConversationMessage[];
  expectedPatentRevision: number | null;
  projection: TextPolishConversationProjection | null;
  retryTurnId: string | null;
  source: TextPolishConversationSource | null;
  model: TextPolishConversationModel | null;
  summary: TextPolishConversationSummary | null;
  latestValidDraft: string | null;
};

const MAX_REASONING_CHARACTERS = 20_000;

function entryKey(patentId: string, _bookKind: AiCorrectionBookKind): string {
  return patentId;
}

function emptyEntry(
  patentId: string,
  sessionId: string,
  bookKind: AiCorrectionBookKind,
): TextPolishEntry {
  return {
    patentId,
    sessionId,
    bookKind,
    status: "idle",
    jobId: null,
    result: null,
    error: null,
    phase: null,
    reasoning: "",
    reasoningTruncated: false,
    conversationId: null,
    conversationRevision: null,
    messages: [],
    expectedPatentRevision: null,
    projection: null,
    retryTurnId: null,
    source: null,
    model: null,
    summary: null,
    latestValidDraft: null,
  };
}

function appendReasoning(entry: TextPolishEntry, delta: string): TextPolishEntry {
  const combined = entry.reasoning + delta;
  const reasoning = combined.slice(-MAX_REASONING_CHARACTERS);
  const reasoningTruncated = entry.reasoningTruncated || combined.length > MAX_REASONING_CHARACTERS;
  return {
    ...entry,
    reasoning,
    reasoningTruncated,
    reasoningByTurn: entry.jobId
      ? {
          ...entry.reasoningByTurn,
          [entry.jobId]: { text: reasoning, truncated: reasoningTruncated },
        }
      : (entry.reasoningByTurn ?? {}),
  };
}

function entryFromSnapshot(
  base: TextPolishEntry,
  snapshot: TextPolishConversationSnapshot,
): TextPolishEntry {
  const projection = applyConversationSnapshot(base.projection, snapshot);
  const outcome = projection.lastTurnOutcome;
  const status: TextPolishStatus = projection.activeTurn
    ? "running"
    : outcome?.status === "failed"
      ? "failed"
      : outcome?.status === "cancelled"
        ? "cancelled"
        : "completed";
  const sameActiveTurn = Boolean(
    projection.activeTurn && base.jobId === projection.activeTurn.turnId,
  );
  const reasoningByTurn = { ...base.reasoningByTurn };
  const previousRevision = base.projection?.conversationRevision ?? -1;
  if (snapshot.conversationRevision >= previousRevision) {
    for (const [turnId, incoming] of Object.entries(snapshot.reasoningByTurn ?? {})) {
      if (snapshot.conversationRevision <= (base.reasoningResetRevisions?.[turnId] ?? -1)) continue;
      const local = reasoningByTurn[turnId];
      // A newer revision is authoritative (including retries). At the same revision,
      // keep deltas received after a snapshot was taken rather than shortening them.
      if (
        snapshot.conversationRevision > previousRevision ||
        !local ||
        incoming.text.length >= local.text.length ||
        (incoming.truncated && !local.truncated)
      )
        reasoningByTurn[turnId] = incoming;
    }
  }
  const activeReasoning = projection.activeTurn
    ? reasoningByTurn[projection.activeTurn.turnId]
    : undefined;
  return {
    ...base,
    bookKind: snapshot.bookKind,
    sessionId: snapshot.sessionId,
    reasoningByTurn,
    status,
    jobId: projection.activeTurn?.turnId ?? null,
    error: outcome?.status === "failed" ? outcome.message : null,
    phase:
      projection.activeTurn?.status === "summarizing"
        ? "summarizing"
        : projection.activeTurn
          ? sameActiveTurn
            ? (base.phase ?? "preparing")
            : "preparing"
          : null,
    reasoning: activeReasoning?.text ?? (sameActiveTurn ? base.reasoning : ""),
    reasoningTruncated:
      activeReasoning?.truncated ?? (sameActiveTurn ? base.reasoningTruncated : false),
    conversationId: snapshot.conversationId,
    conversationRevision: projection.conversationRevision,
    messages: [...projection.messages],
    projection,
    retryTurnId:
      outcome?.status === "failed"
        ? outcome.retryable
          ? outcome.turnId
          : null
        : outcome?.status === "cancelled"
          ? outcome.turnId
          : null,
    source: snapshot.source,
    model: snapshot.model,
    summary: projection.summary,
    latestValidDraft:
      snapshot.conversationRevision >= (base.conversationRevision ?? -1)
        ? snapshot.latestValidDraft
        : base.latestValidDraft,
  };
}

export function useTextPolish({
  patentId,
  sessionId,
  openSessionIds,
  bookKind,
  editor,
  keepSelectionHighlight = false,
  prepare,
}: {
  patentId: string | null;
  sessionId: string | null;
  openSessionIds: readonly string[];
  bookKind: AiCorrectionBookKind;
  editor: Editor | null;
  keepSelectionHighlight?: boolean;
  prepare(): Promise<{
    patentId: string;
    sessionId: string;
    expectedRevision: number;
  } | null>;
}) {
  const [entries, setEntries] = useState<Record<string, TextPolishEntry>>({});
  const reasoningUpdates = useRef<
    Array<(value: Record<string, TextPolishEntry>) => Record<string, TextPolishEntry>>
  >([]);
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushReasoning = useCallback(() => {
    if (reasoningTimer.current !== undefined) clearTimeout(reasoningTimer.current);
    reasoningTimer.current = undefined;
    const updates = reasoningUpdates.current.splice(0);
    if (updates.length)
      setEntries((value) => updates.reduce((current, update) => update(current), value));
  }, []);
  const publishEventEntries = useCallback(
    (
      update: (value: Record<string, TextPolishEntry>) => Record<string, TextPolishEntry>,
      reasoning: boolean,
    ) => {
      if (!reasoning) {
        flushReasoning();
        setEntries(update);
        return;
      }
      reasoningUpdates.current.push(update);
      if (reasoningTimer.current === undefined)
        reasoningTimer.current = setTimeout(flushReasoning, 40);
    },
    [flushReasoning],
  );
  useEffect(
    () => () => {
      if (reasoningTimer.current !== undefined) clearTimeout(reasoningTimer.current);
      reasoningTimer.current = undefined;
      reasoningUpdates.current = [];
    },
    [],
  );
  // Async acknowledgements may outlive a closed patent. Reopening has a new session ID.
  const liveSessions = useRef(new Set<string>());
  liveSessions.current = new Set(openSessionIds);
  if (sessionId) liveSessions.current.add(sessionId);
  const starting = useRef(new Set<string>());
  const sending = useRef(new Set<string>());
  const workspaceOperations = useRef(new Set<string>());
  const [startingKeys, setStartingKeys] = useState<ReadonlySet<string>>(new Set());
  const operationKey = sessionId ?? patentId ?? "draft";
  const [workspaces, setWorkspaces] = useState<Record<string, TextPolishWorkspace>>({});
  const [drafts, setDrafts] = useState<Record<string, TextPolishInputDraft>>({});
  const [storageErrors, setStorageErrors] = useState<Record<string, string | null>>({});
  const [draftErrors, setDraftErrors] = useState<Record<string, string | null>>({});
  const [resetRecoverySessions, setResetRecoverySessions] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [loadedSessions, setLoadedSessions] = useState<ReadonlySet<string>>(new Set());
  const draftWrites = useRef<Record<string, number>>({});
  const editedDrafts = useRef<Record<string, TextPolishInputDraft>>({});
  const [selection, setSelection] = useState<TextPolishSelectionState>(() =>
    inspectTextPolishSelection(editor, bookKind),
  );
  const jobs = useRef(new Map<string, string>());
  const conversations = useRef(new Map<string, string>());
  const snapshotRefreshes = useRef(new Set<string>());
  const queuedSnapshotRefreshes = useRef(new Set<string>());

  useEditorSelectionOverlay({
    editor,
    enabled: keepSelectionHighlight && selection.status === "ready",
    tone: "active",
  });

  useEffect(() => {
    let observedDoc: Editor["state"]["doc"] | undefined;
    let observedSelection: Editor["state"]["selection"] | undefined;
    const update = () => {
      if (editor && !editor.isDestroyed) {
        const state = editor.state;
        if (state.doc === observedDoc && observedSelection?.eq(state.selection)) return;
        observedDoc = state.doc;
        observedSelection = state.selection;
      }
      const next = inspectTextPolishSelection(editor, bookKind);
      setSelection((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    update();
    if (!editor || editor.isDestroyed) return undefined;
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [bookKind, editor]);

  useEffect(() => {
    const api = window.patentApi.aiCorrection;
    if (!api?.onPolishEvent) return undefined;
    return api.onPolishEvent((event) => {
      const key = jobs.current.get(event.jobId);
      if (!key || event.type === "started") return;
      publishEventEntries((current) => {
        const entry = current[key];
        if (!entry || entry.jobId !== event.jobId) return current;
        if (event.type === "phase") return { ...current, [key]: { ...entry, phase: event.phase } };
        if (event.type === "reasoning") {
          return { ...current, [key]: appendReasoning(entry, event.delta) };
        }
        jobs.current.delete(event.jobId);
        if (event.type === "polish-completed") {
          return {
            ...current,
            [key]: {
              ...entry,
              status: "completed",
              jobId: null,
              result: event.result,
              error: null,
              phase: null,
              reasoning: "",
              reasoningTruncated: false,
            },
          };
        }
        if (event.type === "failed") {
          return {
            ...current,
            [key]: {
              ...entry,
              status: "failed",
              jobId: null,
              error: event.message,
              phase: null,
              reasoning: "",
              reasoningTruncated: false,
            },
          };
        }
        return {
          ...current,
          [key]: {
            ...entry,
            status: "cancelled",
            jobId: null,
            phase: null,
            reasoning: "",
            reasoningTruncated: false,
          },
        };
      }, event.type === "reasoning");
    });
  }, [publishEventEntries]);

  useEffect(() => {
    const api = window.patentApi.aiCorrection;
    if (!api?.onConversationEvent) return undefined;
    const refreshSnapshot = (key: string, entry: TextPolishEntry, conversationId: string): void => {
      if (snapshotRefreshes.current.has(conversationId)) {
        queuedSnapshotRefreshes.current.add(conversationId);
        return;
      }
      snapshotRefreshes.current.add(conversationId);
      void api
        .snapshotConversation({
          conversationId,
          patentId: entry.patentId,
          sessionId: entry.sessionId,
          bookKind: entry.bookKind,
        })
        .then((result) => {
          if (!result.ok) throw new Error(result.error.message);
          flushReasoning();
          setEntries((latest) => {
            const latestEntry = latest[key];
            if (
              !latestEntry ||
              latestEntry.sessionId !== entry.sessionId ||
              latestEntry.conversationId !== conversationId ||
              result.value.conversationId !== conversationId
            )
              return latest;
            return { ...latest, [key]: entryFromSnapshot(latestEntry, result.value) };
          });
        })
        .catch(() => {
          setEntries((latest) => {
            const latestEntry = latest[key];
            if (
              !latestEntry ||
              latestEntry.sessionId !== entry.sessionId ||
              latestEntry.conversationId !== conversationId ||
              latestEntry.conversationRevision !== entry.conversationRevision
            )
              return latest;
            return {
              ...latest,
              [key]: {
                ...latestEntry,
                error: "对话状态同步失败，请点击“历史对话”重新同步。不会重新发送 AI 请求。",
              },
            };
          });
        })
        .finally(() => {
          snapshotRefreshes.current.delete(conversationId);
          if (queuedSnapshotRefreshes.current.delete(conversationId)) {
            refreshSnapshot(key, entry, conversationId);
          }
        });
    };
    return api.onConversationEvent((event: TextPolishConversationEvent) => {
      const key = conversations.current.get(event.conversationId);
      if (!key) return;
      publishEventEntries((current) => {
        const entry = current[key];
        if (!entry || entry.conversationId !== event.conversationId) return current;
        const baseProjection =
          entry.projection ??
          ({
            conversationId: entry.conversationId,
            conversationRevision: entry.conversationRevision ?? 0,
            messages: entry.messages,
            summary: null,
            activeTurn: null,
            lastTurnOutcome: null,
          } satisfies TextPolishConversationProjection);
        const application = applyConversationEvent(baseProjection, event);
        if (application.kind === "gap") {
          refreshSnapshot(key, entry, event.conversationId);
          return current;
        }
        if (application.kind === "ignored") return current;
        const projection = application.projection;
        const revision = projection.conversationRevision;
        if (event.type === "message") {
          return {
            ...current,
            [key]: {
              ...entry,
              conversationRevision: revision,
              messages: projection.messages,
              projection,
              status: event.message.role === "assistant" ? "completed" : "running",
              jobId: projection.activeTurn?.turnId ?? null,
              error: null,
              phase: event.message.role === "assistant" ? null : entry.phase,
              reasoning: event.message.role === "assistant" ? "" : entry.reasoning,
              reasoningTruncated:
                event.message.role === "assistant" ? false : entry.reasoningTruncated,
              retryTurnId: event.message.role === "assistant" ? null : entry.retryTurnId,
              summary: projection.summary,
              latestValidDraft:
                event.message.role === "assistant" && event.message.reply.kind === "revision"
                  ? event.message.reply.revisedText
                  : entry.latestValidDraft,
            },
          };
        }
        if (event.type === "summary") {
          return {
            ...current,
            [key]: {
              ...entry,
              conversationRevision: revision,
              messages: projection.messages,
              summary: projection.summary,
              projection,
            },
          };
        }
        if (event.type === "phase") {
          return {
            ...current,
            [key]: {
              ...entry,
              status: "running",
              jobId: event.turnId,
              conversationRevision: revision,
              projection,
              phase: event.phase,
            },
          };
        }
        if (event.type === "reasoning") {
          return {
            ...current,
            [key]: appendReasoning(
              { ...entry, conversationRevision: revision, projection },
              event.delta,
            ),
          };
        }
        if (event.type === "turn-failed") {
          return {
            ...current,
            [key]: {
              ...entry,
              status: "failed",
              jobId: null,
              conversationRevision: revision,
              projection,
              error: event.message,
              phase: null,
              reasoning: "",
              reasoningTruncated: false,
              retryTurnId: event.retryable ? event.turnId : null,
            },
          };
        }
        return {
          ...current,
          [key]: {
            ...entry,
            status: "cancelled",
            jobId: null,
            conversationRevision: revision,
            projection,
            phase: null,
            reasoning: "",
            reasoningTruncated: false,
            retryTurnId: event.turnId,
          },
        };
      }, event.type === "reasoning");
    });
  }, [publishEventEntries, flushReasoning]);

  useEffect(() => {
    const open = new Set(openSessionIds);
    if (sessionId) open.add(sessionId);
    setEntries((current) => {
      const closed = Object.entries(current).filter(([, entry]) => !open.has(entry.sessionId));
      if (closed.length === 0) return current;
      for (const [, entry] of closed) {
        if (entry.status === "running" && entry.jobId) {
          void window.patentApi.aiCorrection.cancelPolish({ jobId: entry.jobId });
        }
        if (entry.jobId) jobs.current.delete(entry.jobId);
        if (entry.conversationId) conversations.current.delete(entry.conversationId);
      }
      return Object.fromEntries(
        Object.entries(current).filter(([, entry]) => open.has(entry.sessionId)),
      );
    });
  }, [openSessionIds, sessionId]);

  const key = patentId ? entryKey(patentId, bookKind) : null;
  const candidateEntry = key ? (entries[key] ?? null) : null;
  const activeEntry = candidateEntry?.sessionId === sessionId ? candidateEntry : null;
  const draftKey = `${patentId}:${activeEntry?.conversationId ?? "new"}`;
  const inputDraft = drafts[draftKey] ?? { text: "", presets: [] };
  const storageAvailable = typeof window.patentApi.aiCorrection.polishWorkspace === "function";
  const historyLoading =
    storageAvailable &&
    Boolean(sessionId && !loadedSessions.has(sessionId)) &&
    !(patentId && storageErrors[patentId]);

  const installWorkspace = useCallback(
    (value: TextPolishWorkspace, id: string, session: string) => {
      if (!liveSessions.current.has(session)) return false;
      const snapshot = value.snapshot;
      if (snapshot) conversations.current.set(snapshot.conversationId, id);
      flushReasoning();
      setEntries((current) => {
        const latest = current[id];
        const base =
          latest?.sessionId === session && latest.conversationId === snapshot?.conversationId
            ? latest
            : emptyEntry(id, session, snapshot?.bookKind ?? "description");
        return { ...current, [id]: snapshot ? entryFromSnapshot(base, snapshot) : base };
      });
      setWorkspaces((current) => ({ ...current, [id]: value }));
      const restoredDraftKey = `${id}:${snapshot?.conversationId ?? "new"}`;
      // Locally edited input stays authoritative even if a read races its save acknowledgement.
      setDrafts((current) => ({
        ...current,
        [restoredDraftKey]: draftWrites.current[restoredDraftKey]
          ? (current[restoredDraftKey] ?? value.draft)
          : value.draft,
      }));
      setStorageErrors((current) => ({ ...current, [id]: null }));
      return true;
    },
    [flushReasoning],
  );

  useEffect(() => {
    if (!patentId || !sessionId || !storageAvailable || loadedSessions.has(sessionId)) return;
    let disposed = false;
    void window.patentApi.aiCorrection
      .polishWorkspace({ patentId, sessionId, action: "load", conversationId: null })
      .then((result) => {
        if (disposed) return;
        if (result.ok) {
          installWorkspace(result.value, patentId, sessionId);
          setLoadedSessions((current) => new Set([...current, sessionId]));
        } else setStorageErrors((current) => ({ ...current, [patentId]: result.error.message }));
      })
      .catch(() => {
        if (!disposed)
          setStorageErrors((current) => ({
            ...current,
            [patentId]: "历史对话恢复失败，请重新打开专利重试。",
          }));
      });
    return () => {
      disposed = true;
    };
  }, [patentId, sessionId, storageAvailable, installWorkspace, loadedSessions]);

  const draftQueue = useRef(new InputDraftSaveQueue());
  const flushAllInputDrafts = useCallback(() => draftQueue.current.flush(), []);
  const flushPatentDrafts = useCallback(
    (id: string) => draftQueue.current.flush((key) => key.startsWith(`${id}:`)),
    [],
  );
  const flushInputDrafts = useCallback(
    () => draftQueue.current.flush((key) => key === draftKey),
    [draftKey],
  );
  useEffect(() => {
    // Tab switches preserve the previous patent's draft without releasing its session.
    if (!sessionId) return;
    return () => {
      if (patentId) void flushPatentDrafts(patentId);
    };
  }, [sessionId, patentId, flushPatentDrafts]);

  const persistInputDraft = useCallback(
    (
      draft: TextPolishInputDraft,
      patentId: string | null,
      sessionId: string | null,
      conversationId: string | null,
    ) => {
      const draftKey = `${patentId}:${conversationId ?? "new"}`;
      editedDrafts.current[draftKey] = draft;
      setDrafts((current) => ({ ...current, [draftKey]: draft }));
      const sequence = (draftWrites.current[draftKey] ?? 0) + 1;
      draftWrites.current[draftKey] = sequence;
      if (!patentId || !sessionId || !storageAvailable) return;
      const api = window.patentApi.aiCorrection;
      draftQueue.current.enqueue(draftKey, async () => {
        let error: string | null = null;
        try {
          const result = await api.polishWorkspace({
            patentId,
            sessionId,
            action: "draft",
            conversationId,
            draft,
          });
          if (!result.ok) error = result.error.message;
        } catch {
          error = "输入草稿保存失败，请先复制保留。";
        }
        if (draftWrites.current[draftKey] === sequence)
          setDraftErrors((current) => ({ ...current, [draftKey]: error }));
        return error === null;
      });
    },
    [storageAvailable],
  );

  const saveInputDraft = useCallback(
    (draft: TextPolishInputDraft) =>
      persistInputDraft(draft, patentId, sessionId, activeEntry?.conversationId ?? null),
    [persistInputDraft, patentId, sessionId, activeEntry?.conversationId],
  );

  const openHistory = useCallback(
    async (conversationId: string) => {
      if (!patentId || !sessionId) return;
      if (
        workspaceOperations.current.has(operationKey) ||
        starting.current.has(operationKey) ||
        (activeEntry?.status === "running" && !activeEntry.conversationId) ||
        (activeEntry?.conversationId && sending.current.has(activeEntry.conversationId))
      )
        return;
      workspaceOperations.current.add(operationKey);
      try {
        const result = await window.patentApi.aiCorrection.polishWorkspace({
          patentId,
          sessionId,
          action: "open",
          conversationId,
        });
        if (!liveSessions.current.has(sessionId)) return;
        if (!result.ok) throw new Error(result.error.message);
        installWorkspace(result.value, patentId, sessionId);
      } finally {
        workspaceOperations.current.delete(operationKey);
      }
    },
    [patentId, sessionId, installWorkspace, operationKey, activeEntry],
  );

  const refreshHistory = useCallback(async () => {
    if (!patentId || !sessionId || !storageAvailable) return;
    const result = await window.patentApi.aiCorrection.polishWorkspace({
      patentId,
      sessionId,
      action: "load",
      conversationId: null,
    });
    if (!liveSessions.current.has(sessionId)) return;
    if (!result.ok) throw new Error(result.error.message);
    setWorkspaces((current) => ({ ...current, [patentId]: result.value }));
    const snapshot = result.value.snapshot;
    if (snapshot) {
      flushReasoning();
      setEntries((current) => {
        const latest = current[patentId];
        if (
          !latest ||
          latest.sessionId !== sessionId ||
          latest.conversationId !== snapshot.conversationId ||
          (latest.conversationRevision ?? 0) > snapshot.conversationRevision
        )
          return current;
        return { ...current, [patentId]: entryFromSnapshot(latest, snapshot) };
      });
    }
  }, [patentId, sessionId, storageAvailable, flushReasoning]);

  const manageHistory = useCallback(
    async (
      action: "rename" | "delete" | "stop" | "continue-new",
      conversationId: string,
      value?: string,
    ) => {
      if (!patentId || !sessionId || workspaceOperations.current.has(operationKey))
        throw new Error("请等待当前操作完成。");
      workspaceOperations.current.add(operationKey);
      try {
        if (action !== "stop" && !(await flushInputDrafts()))
          throw new Error("草稿尚未保存，请先复制保留后重试。");
        if (
          action === "delete" &&
          !(await draftQueue.current.flush((key) => key === `${patentId}:${conversationId}`))
        )
          throw new Error("待删除对话的草稿尚未保存，请先复制保留后重试。");
        const request: TextPolishWorkspaceRequest = {
          patentId,
          sessionId,
          action,
          conversationId,
          ...(action === "rename" ? { title: value } : {}),
          ...(action === "continue-new"
            ? {
                continuation: value,
                expectedConversationRevision: activeEntry?.conversationRevision ?? 0,
              }
            : {}),
        };
        const result = await window.patentApi.aiCorrection.polishWorkspace(request);
        if (!liveSessions.current.has(sessionId)) return;
        if (!result.ok) throw new Error(result.error.message);
        if (action === "stop") {
          // Terminal events update the live conversation; never replace unsaved input.
          setWorkspaces((current) => ({
            ...current,
            [patentId]: {
              ...result.value,
              draft: current[patentId]?.draft ?? result.value.draft,
              history: (current[patentId]?.history ?? []).map((item) =>
                item.conversationId === conversationId
                  ? { ...item, status: "cancelled" as const }
                  : item,
              ),
            },
          }));
          return;
        }
        if (action === "delete") {
          conversations.current.delete(conversationId);
          delete editedDrafts.current[`${patentId}:${conversationId}`];
          delete draftWrites.current[`${patentId}:${conversationId}`];
        }
        installWorkspace(result.value, patentId, sessionId);
      } finally {
        workspaceOperations.current.delete(operationKey);
      }
    },
    [
      patentId,
      sessionId,
      operationKey,
      flushInputDrafts,
      activeEntry?.conversationRevision,
      installWorkspace,
    ],
  );

  const recoverHistory = useCallback(
    async (conversationId?: string) => {
      if (!patentId || !sessionId || !storageAvailable) return;
      // A normal save error must not reload an older disk draft over unsent input.
      if (!conversationId && loadedSessions.has(sessionId) && !resetRecoverySessions.has(sessionId))
        return;
      if (
        workspaceOperations.current.has(operationKey) ||
        starting.current.has(operationKey) ||
        activeEntry?.status === "running" ||
        (activeEntry?.conversationId && sending.current.has(activeEntry.conversationId))
      )
        return;
      workspaceOperations.current.add(operationKey);
      try {
        const result = await window.patentApi.aiCorrection.polishWorkspace({
          patentId,
          sessionId,
          action: "recover",
          conversationId: conversationId ?? null,
        });
        if (!liveSessions.current.has(sessionId)) return;
        if (!result.ok) throw new Error(result.error.message);
        if (!installWorkspace(result.value, patentId, sessionId)) return;
        setResetRecoverySessions((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
        const restoredConversationId = result.value.snapshot?.conversationId ?? null;
        const editedDraft = editedDrafts.current[`${patentId}:${restoredConversationId ?? "new"}`];
        if (editedDraft)
          persistInputDraft(editedDraft, patentId, sessionId, restoredConversationId);
        await flushInputDrafts();
        setLoadedSessions((current) => new Set([...current, sessionId]));
      } finally {
        workspaceOperations.current.delete(operationKey);
      }
    },
    [
      patentId,
      sessionId,
      storageAvailable,
      installWorkspace,
      loadedSessions,
      resetRecoverySessions,
      operationKey,
      activeEntry,
      persistInputDraft,
      flushInputDrafts,
    ],
  );

  const changeModel = useCallback(
    async (targetModel: TextPolishConversationModel) => {
      if (
        !patentId ||
        !sessionId ||
        !storageAvailable ||
        historyLoading ||
        workspaceOperations.current.has(operationKey) ||
        starting.current.has(operationKey) ||
        activeEntry?.status === "preparing" ||
        activeEntry?.status === "running" ||
        !activeEntry?.conversationId ||
        activeEntry.conversationRevision === null ||
        sending.current.has(activeEntry.conversationId)
      )
        return;
      sending.current.add(activeEntry.conversationId);
      workspaceOperations.current.add(operationKey);
      try {
        if (!(await flushInputDrafts())) throw new Error("输入草稿保存失败，请重试后再继续。");
        const result = await window.patentApi.aiCorrection.polishWorkspace({
          patentId,
          sessionId,
          action: "change-model",
          conversationId: activeEntry.conversationId,
          expectedConversationRevision: activeEntry.conversationRevision,
          targetModel,
        });
        if (!liveSessions.current.has(sessionId)) return;
        if (!result.ok) throw new Error(result.error.message);
        installWorkspace(result.value, patentId, sessionId);
      } finally {
        sending.current.delete(activeEntry.conversationId);
        workspaceOperations.current.delete(operationKey);
      }
    },
    [
      patentId,
      sessionId,
      storageAvailable,
      historyLoading,
      operationKey,
      activeEntry,
      installWorkspace,
      flushInputDrafts,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation triggers a read; the captured revision only guards late failures, not a new read on every event.
  useEffect(() => {
    const api = window.patentApi.aiCorrection;
    if (!key || !activeEntry?.conversationId || typeof api.snapshotConversation !== "function") {
      return undefined;
    }
    let cancelled = false;
    void api
      .snapshotConversation({
        conversationId: activeEntry.conversationId,
        patentId: activeEntry.patentId,
        sessionId: activeEntry.sessionId,
        bookKind,
      })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error.message);
        // Apply already-received deltas before merging the authoritative snapshot.
        flushReasoning();
        setEntries((current) => {
          const latest = key ? current[key] : null;
          if (!latest || latest.conversationId !== result.value.conversationId) return current;
          return { ...current, [key]: entryFromSnapshot(latest, result.value) };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setEntries((current) => {
          const latest = current[key];
          if (
            !latest ||
            latest.conversationId !== activeEntry.conversationId ||
            latest.conversationRevision !== activeEntry.conversationRevision
          )
            return current;
          return {
            ...current,
            [key]: {
              ...latest,
              error: "对话状态同步失败，请点击“历史对话”重新同步。不会重新发送 AI 请求。",
            },
          };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeEntry?.conversationId,
    activeEntry?.patentId,
    activeEntry?.sessionId,
    bookKind,
    key,
    flushReasoning,
  ]);

  const start = useCallback(
    async (requirement: string) => {
      const currentSelection = inspectTextPolishSelection(editor, bookKind);
      if (currentSelection.status === "invalid") throw new Error(currentSelection.message);
      const trimmedRequirement = requirement.trim();
      if (currentSelection.status === "empty" && !trimmedRequirement) {
        throw new Error("未选中正文时，请填写生成需求。");
      }
      if (
        workspaceOperations.current.has(operationKey) ||
        starting.current.has(operationKey) ||
        activeEntry?.conversationId ||
        activeEntry?.status === "running"
      )
        return;
      starting.current.add(operationKey);
      const submittedDraftSequence = draftWrites.current[draftKey] ?? 0;
      const clearAcceptedDraft = () => {
        if ((draftWrites.current[draftKey] ?? 0) === submittedDraftSequence)
          saveInputDraft({ text: "", presets: [] });
      };
      setStartingKeys(new Set(starting.current));
      try {
        if (!(await flushInputDrafts())) throw new Error("输入草稿保存失败，请重试后再继续。");
        const prepared = await prepare();
        if (!prepared) throw new Error("保存当前专利失败，未启动小栈AI助手。");
        if (!liveSessions.current.has(prepared.sessionId)) return;
        const currentKey = entryKey(prepared.patentId, bookKind);
        const jobId = createSettingsId();
        jobs.current.set(jobId, currentKey);
        const pending: TextPolishEntry = {
          patentId: prepared.patentId,
          sessionId: prepared.sessionId,
          bookKind,
          status: "running",
          jobId,
          result: null,
          error: null,
          phase: "preparing",
          reasoning: "",
          reasoningTruncated: false,
          conversationId: null,
          reasoningByTurn: {},
          conversationRevision: null,
          messages: [],
          expectedPatentRevision: prepared.expectedRevision,
          projection: null,
          retryTurnId: null,
          source: null,
          model: null,
          summary: null,
          latestValidDraft: null,
        };
        setEntries((current) => ({ ...current, [currentKey]: pending }));
        const fail = (message: string) => {
          jobs.current.delete(jobId);
          if (!liveSessions.current.has(prepared.sessionId)) return;
          setEntries((current) => ({
            ...current,
            [currentKey]: {
              ...pending,
              status: "failed",
              jobId: null,
              error: message,
              phase: null,
            },
          }));
        };
        try {
          const scope =
            currentSelection.status === "ready"
              ? await (async () => {
                  const hash = await window.patentApi.aiCorrection.hashText(currentSelection.text);
                  if (!hash.ok) throw new Error(hash.error.message);
                  return { ...currentSelection.scope, selectedTextHash: hash.value };
                })()
              : { kind: "generation" as const, bookKind };
          if (!liveSessions.current.has(prepared.sessionId)) return;
          if (typeof window.patentApi.aiCorrection.startConversation === "function") {
            const conversation = await window.patentApi.aiCorrection.startConversation({
              patentId: prepared.patentId,
              sessionId: prepared.sessionId,
              expectedPatentRevision: prepared.expectedRevision,
              clientRequestId: jobId,
              scope,
              instruction: trimmedRequirement,
              uploadConfirmed: true,
            });
            if (!liveSessions.current.has(prepared.sessionId)) return;
            if (!conversation.ok) {
              fail(conversation.error.message);
              return;
            }
            conversations.current.set(conversation.value.conversationId, currentKey);
            flushReasoning();
            if ((draftWrites.current[draftKey] ?? 0) !== submittedDraftSequence) {
              const editedDraft = editedDrafts.current[draftKey];
              if (editedDraft)
                persistInputDraft(
                  editedDraft,
                  prepared.patentId,
                  prepared.sessionId,
                  conversation.value.conversationId,
                );
            }
            setEntries((current) => ({
              ...current,
              [currentKey]: {
                ...entryFromSnapshot(pending, conversation.value.snapshot),
              },
            }));
            clearAcceptedDraft();
            return;
          }
          const result = await window.patentApi.aiCorrection.polish({
            ...prepared,
            jobId,
            scope,
            requirement: trimmedRequirement,
            uploadConfirmed: true,
          });
          if (!result.ok) {
            fail(result.error.message);
            return;
          }
          if (result.value.jobId !== jobId) {
            const message = "小栈AI助手任务标识不一致。";
            fail(message);
            throw new Error(message);
          }
          clearAcceptedDraft();
        } catch (error) {
          const message = error instanceof Error ? error.message : "小栈AI助手启动失败。";
          fail(message);
          throw error;
        }
      } finally {
        starting.current.delete(operationKey);
        setStartingKeys(new Set(starting.current));
      }
    },
    [
      activeEntry,
      bookKind,
      editor,
      operationKey,
      prepare,
      draftKey,
      saveInputDraft,
      flushInputDrafts,
      persistInputDraft,
      flushReasoning,
    ],
  );

  const cancel = useCallback(async () => {
    if (
      activeEntry?.conversationId &&
      activeEntry.conversationRevision !== null &&
      activeEntry.jobId
    ) {
      const result = await window.patentApi.aiCorrection.cancelConversation({
        identity: {
          conversationId: activeEntry.conversationId,
          patentId: activeEntry.patentId,
          sessionId: activeEntry.sessionId,
          bookKind: activeEntry.bookKind,
        },
        turnId: activeEntry.jobId,
      });
      if (!result.ok) throw new Error(result.error.message);
      return;
    }
    if (!activeEntry?.jobId) return;
    await window.patentApi.aiCorrection.cancelPolish({ jobId: activeEntry.jobId });
  }, [activeEntry]);

  const send = useCallback(
    async (instruction: string, referenceText?: string): Promise<boolean> => {
      const entry = activeEntry;
      if (!entry?.conversationId || entry.conversationRevision === null) {
        return false;
      }
      if (
        entry.status === "running" ||
        sending.current.has(entry.conversationId) ||
        workspaceOperations.current.has(operationKey)
      )
        return false;
      sending.current.add(entry.conversationId);
      try {
        if (!(await flushInputDrafts())) throw new Error("输入草稿保存失败，请重试后再继续。");
        const result = await window.patentApi.aiCorrection.sendConversation({
          identity: {
            conversationId: entry.conversationId,
            patentId: entry.patentId,
            sessionId: entry.sessionId,
            bookKind: entry.bookKind,
          },
          expectedConversationRevision: entry.conversationRevision,
          clientRequestId: createSettingsId(),
          kind: "new",
          instruction: instruction.trim(),
          ...(referenceText ? { referenceText } : {}),
        });
        if (!result.ok) {
          setEntries((current) => {
            const key = entryKey(entry.patentId, entry.bookKind);
            const latest = current[key];
            if (
              !latest ||
              latest.sessionId !== entry.sessionId ||
              latest.conversationId !== entry.conversationId ||
              (latest.conversationRevision ?? 0) > (entry.conversationRevision ?? 0)
            )
              return current;
            return {
              ...current,
              [key]: {
                ...latest,
                status: "failed",
                error: result.error.message,
                retryTurnId: null,
              },
            };
          });
          return false;
        }
        const snapshot = result.value.snapshot;
        flushReasoning();
        setEntries((current) => {
          const key = entryKey(entry.patentId, entry.bookKind);
          const latest = current[key];
          if (
            !latest ||
            latest.sessionId !== entry.sessionId ||
            latest.conversationId !== entry.conversationId
          )
            return current;
          return { ...current, [key]: entryFromSnapshot(latest, snapshot) };
        });
        return true;
      } finally {
        sending.current.delete(entry.conversationId);
      }
    },
    [activeEntry, operationKey, flushInputDrafts, flushReasoning],
  );

  const retry = useCallback(async (): Promise<boolean> => {
    const entry = activeEntry;
    const lastMessage = entry?.messages.at(-1);
    const turnId = entry?.retryTurnId ?? (lastMessage?.role === "user" ? lastMessage.turnId : null);
    if (!entry?.conversationId || entry.conversationRevision === null || !turnId) {
      return false;
    }
    if (
      entry.status === "running" ||
      sending.current.has(entry.conversationId) ||
      workspaceOperations.current.has(operationKey)
    )
      return false;
    sending.current.add(entry.conversationId);
    const restoreRejectedRetry = (message: string) => {
      setEntries((current) => {
        const key = entryKey(entry.patentId, entry.bookKind);
        const latest = current[key];
        if (
          !latest ||
          latest.sessionId !== entry.sessionId ||
          latest.conversationId !== entry.conversationId ||
          (latest.conversationRevision ?? 0) > (entry.conversationRevision ?? 0)
        )
          return current;
        return {
          ...current,
          [key]: {
            ...latest,
            status: "failed",
            error: message,
            reasoning: entry.reasoning,
            reasoningTruncated: entry.reasoningTruncated,
            reasoningByTurn: entry.reasoningByTurn ?? {},
            reasoningResetRevisions: entry.reasoningResetRevisions ?? {},
          },
        };
      });
    };
    setEntries((current) => {
      const key = entryKey(entry.patentId, entry.bookKind);
      const latest = current[key];
      if (!latest || latest.conversationId !== entry.conversationId) return current;
      return {
        ...current,
        [key]: {
          ...latest,
          reasoning: "",
          reasoningTruncated: false,
          reasoningResetRevisions: {
            ...latest.reasoningResetRevisions,
            [turnId]: entry.conversationRevision ?? 0,
          },
          reasoningByTurn: { ...latest.reasoningByTurn, [turnId]: { text: "", truncated: false } },
        },
      };
    });
    try {
      const result = await window.patentApi.aiCorrection.sendConversation({
        identity: {
          conversationId: entry.conversationId,
          patentId: entry.patentId,
          sessionId: entry.sessionId,
          bookKind: entry.bookKind,
        },
        expectedConversationRevision: entry.conversationRevision,
        clientRequestId: createSettingsId(),
        kind: "retry",
        turnId,
      });
      if (!result.ok) {
        restoreRejectedRetry(result.error.message);
        return false;
      }
      const snapshot = result.value.snapshot;
      flushReasoning();
      setEntries((current) => {
        const key = entryKey(entry.patentId, entry.bookKind);
        const latest = current[key];
        if (
          !latest ||
          latest.sessionId !== entry.sessionId ||
          latest.conversationId !== entry.conversationId
        )
          return current;
        return { ...current, [key]: entryFromSnapshot(latest, snapshot) };
      });
      return true;
    } catch (error) {
      restoreRejectedRetry(error instanceof Error ? error.message : "重试失败，请稍后重试。");
      return false;
    } finally {
      sending.current.delete(entry.conversationId);
    }
  }, [activeEntry, operationKey, flushReasoning]);

  const reset = useCallback(async () => {
    if (!key) return;
    if (
      workspaceOperations.current.has(operationKey) ||
      (activeEntry?.conversationId && sending.current.has(activeEntry.conversationId)) ||
      starting.current.has(operationKey) ||
      activeEntry?.status === "preparing" ||
      (activeEntry?.status === "running" && !activeEntry.conversationId)
    )
      return;
    workspaceOperations.current.add(operationKey);
    try {
      if (!(await flushInputDrafts())) throw new Error("输入草稿保存失败，请重试后再继续。");
      if (activeEntry?.conversationId && activeEntry.conversationRevision !== null) {
        const result = await window.patentApi.aiCorrection.resetConversation({
          identity: {
            conversationId: activeEntry.conversationId,
            patentId: activeEntry.patentId,
            sessionId: activeEntry.sessionId,
            bookKind: activeEntry.bookKind,
          },
          expectedConversationRevision: activeEntry.conversationRevision,
        });
        if (!liveSessions.current.has(activeEntry.sessionId)) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        conversations.current.delete(activeEntry.conversationId);
        setEntries((current) => ({
          ...current,
          [key]: emptyEntry(activeEntry.patentId, activeEntry.sessionId, activeEntry.bookKind),
        }));
        if (storageAvailable && patentId && sessionId) {
          try {
            const restored = await window.patentApi.aiCorrection.polishWorkspace({
              patentId,
              sessionId,
              action: "open",
              conversationId: null,
            });
            if (!restored.ok) throw new Error(restored.error.message);
            installWorkspace(restored.value, patentId, sessionId);
          } catch (error) {
            if (!liveSessions.current.has(sessionId)) return;
            const newDraftKey = `${patentId}:new`;
            draftWrites.current[newDraftKey] = (draftWrites.current[newDraftKey] ?? 0) + 1;
            setDrafts((current) => ({
              ...current,
              [newDraftKey]: current[newDraftKey] ?? { text: "", presets: [] },
            }));
            setStorageErrors((current) => ({
              ...current,
              [patentId]: error instanceof Error ? error.message : "新对话读取失败，请重试。",
            }));
            setResetRecoverySessions((current) => new Set([...current, sessionId]));
            throw error;
          }
          return;
        }
        setEntries((current) => ({
          ...current,
          [key]: {
            ...activeEntry,
            status: "idle",
            reasoningByTurn: {},
            result: null,
            error: null,
            phase: null,
            reasoning: "",
            reasoningTruncated: false,
            conversationId: null,
            conversationRevision: null,
            messages: [],
            projection: null,
            retryTurnId: null,
            source: null,
            model: null,
            summary: null,
          },
        }));
        return;
      }
      setEntries((current) => {
        const entry = current[key];
        return entry
          ? {
              ...current,
              [key]: {
                ...entry,
                status: "idle",
                result: null,
                error: null,
                phase: null,
                reasoning: "",
                reasoningTruncated: false,
                conversationId: null,
                reasoningByTurn: {},
                conversationRevision: null,
                messages: [],
                projection: null,
                retryTurnId: null,
                source: null,
                model: null,
                summary: null,
              },
            }
          : current;
      });
    } finally {
      workspaceOperations.current.delete(operationKey);
    }
  }, [
    activeEntry,
    key,
    storageAvailable,
    patentId,
    sessionId,
    installWorkspace,
    operationKey,
    flushInputDrafts,
  ]);

  return useMemo(
    () => ({
      inputDraft,
      saveInputDraft,
      flushInputDrafts: flushAllInputDrafts,
      flushPatentDrafts,
      history: (patentId ? workspaces[patentId]?.history : null) ?? [],
      openHistory,
      refreshHistory,
      manageHistory,
      recoverHistory,
      changeModel,
      historyRecoveryAvailable: Boolean(
        sessionId && (!loadedSessions.has(sessionId) || resetRecoverySessions.has(sessionId)),
      ),
      historyLoading,
      storageError: draftErrors[draftKey] ?? (patentId ? (storageErrors[patentId] ?? null) : null),
      selection,
      status: startingKeys.has(operationKey)
        ? ("preparing" as const)
        : (activeEntry?.status ?? ("idle" as const)),
      result: activeEntry?.result ?? null,
      error: activeEntry?.error ?? null,
      phase: activeEntry?.phase ?? null,
      summaryBatch: activeEntry?.projection?.activeTurn?.summaryBatch ?? null,
      reasoning: activeEntry?.reasoning ?? "",
      reasoningByTurn: activeEntry?.reasoningByTurn ?? {},
      reasoningTruncated: activeEntry?.reasoningTruncated ?? false,
      conversationId: activeEntry?.conversationId ?? null,
      conversationRevision: activeEntry?.conversationRevision ?? null,
      messages: activeEntry?.messages ?? [],
      source: activeEntry?.source ?? null,
      model: activeEntry?.model ?? null,
      summary: activeEntry?.summary ?? null,
      latestValidDraft: activeEntry?.latestValidDraft ?? null,
      canRetry: Boolean(activeEntry?.retryTurnId),
      start,
      send,
      retry,
      cancel,
      reset,
    }),
    [
      activeEntry,
      cancel,
      operationKey,
      reset,
      retry,
      selection,
      send,
      start,
      startingKeys,
      inputDraft,
      saveInputDraft,
      flushAllInputDrafts,
      flushPatentDrafts,
      patentId,
      workspaces,
      openHistory,
      refreshHistory,
      manageHistory,
      recoverHistory,
      changeModel,
      sessionId,
      loadedSessions,
      historyLoading,
      storageErrors,
      draftErrors,
      draftKey,
      resetRecoverySessions,
    ],
  );
}
