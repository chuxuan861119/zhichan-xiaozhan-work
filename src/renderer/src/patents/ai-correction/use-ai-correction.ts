import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCorrectionBookKind,
  AiCorrectionPhase,
  AiCorrectionScope,
} from "../../../../shared/ai-correction/contract";
import { createSettingsId } from "../../../../shared/settings/model";
import type { AiCorrectionPanelStatus } from "./ai-correction-panel";
import {
  type AiCorrectionSessionEntries,
  appendReasoning,
  entryKey,
  selectVisibleEntry,
  upsertEntry,
} from "./ai-correction-session-store";
import { startCorrectionAnchorTracking } from "./correction-anchor";
import { inspectMixedSelection } from "./mixed-selection";
import { inspectTextPolishSelection } from "./text-polish-anchor";

async function selectionScope(
  editor: Editor,
  bookKind: AiCorrectionBookKind,
): Promise<AiCorrectionScope> {
  if (editor.state.selection.empty) throw new Error("请选择需要纠错的内容。");
  const plain = inspectTextPolishSelection(editor, bookKind);
  if (plain.status === "ready" && plain.scope.formatVersion !== 2) {
    const hash = await window.patentApi.aiCorrection.hashText(plain.text);
    if (!hash.ok) throw new Error(hash.error.message);
    return { ...plain.scope, selectedTextHash: hash.value };
  }
  const selected = inspectMixedSelection(editor);
  if (!selected.spans.length) throw new Error("当前选区没有可检查的内容。");
  const hash = await window.patentApi.aiCorrection.hashText(selected.text);
  if (!hash.ok) throw new Error(hash.error.message);
  return {
    kind: "selection",
    formatVersion: 2,
    bookKind,
    blocks: selected.spans,
    selectedTextHash: hash.value,
  };
}

export function useAiCorrection({
  patentId,
  sessionId,
  openSessionIds,
  bookKind,
  editor,
  thinkingEnabled,
  modelName,
  prepare,
}: {
  patentId: string | null;
  sessionId: string | null;
  openSessionIds: readonly string[];
  bookKind: AiCorrectionBookKind;
  editor: Editor | null;
  thinkingEnabled: boolean;
  modelName?: string | undefined;
  prepare(): Promise<{ patentId: string; sessionId: string; expectedRevision: number } | null>;
}) {
  const [entries, setEntries] = useState<AiCorrectionSessionEntries>({});
  const jobs = useRef(new Map<string, string>());
  const locks = useRef(new Map<string, string>());
  const tracking = useRef(new Map<string, () => void>());

  useEffect(() => {
    const registered = tracking.current;
    const pendingJobs = jobs.current;
    const pendingLocks = locks.current;
    const api = window.patentApi.aiCorrection;
    return () => {
      for (const jobId of pendingJobs.keys()) {
        void Promise.resolve(api?.cancel({ jobId }))
          .then((result) => {
            if (result && !result.ok)
              console.warn("界面退出时未能停止 AI 纠错，请重启应用后重试。");
          })
          .catch(() => console.warn("界面退出时未能停止 AI 纠错，请重启应用后重试。"));
      }
      pendingJobs.clear();
      pendingLocks.clear();
      for (const dispose of registered.values()) dispose();
      registered.clear();
    };
  }, []);

  useEffect(() => {
    const api = window.patentApi.aiCorrection;
    if (!api) return undefined;
    return api.onEvent((event) => {
      const key = jobs.current.get(event.jobId);
      if (!key || event.type === "started") return;
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
        jobs.current.delete(event.jobId);
        if (locks.current.get(key) === event.jobId) locks.current.delete(key);
      }
      setEntries((current) => {
        const entry = current[key];
        if (!entry || entry.jobId !== event.jobId) return current;
        if (event.type === "partial")
          return upsertEntry(current, key, {
            ...entry,
            issues: event.issues,
            reportedIssueCount: event.issues.length,
            progress: { completed: event.completedChunks, total: event.totalChunks },
            resultLimitReached: event.resultLimitReached,
            discardedIssueCount: event.discardedIssueCount,
          });
        if (event.type === "progress") {
          return upsertEntry(current, key, {
            ...entry,
            progress: { completed: event.completedChunks, total: event.totalChunks },
          });
        }
        if (event.type === "phase") {
          return upsertEntry(current, key, { ...entry, phase: event.phase });
        }
        if (event.type === "reasoning") {
          return upsertEntry(current, key, appendReasoning(entry, event.delta));
        }
        if (event.type === "completed") {
          return upsertEntry(current, key, {
            ...entry,
            status: "completed",
            issues: event.issues,
            reportedIssueCount: event.issues.length,
            resultLimitReached: event.resultLimitReached,
            discardedIssueCount: event.discardedIssueCount ?? 0,
            error: null,
            phase: null,
          });
        }
        if (event.type === "failed") {
          return upsertEntry(current, key, {
            ...entry,
            status: "failed",
            error: event.message,
            phase: null,
          });
        }
        return upsertEntry(current, key, {
          ...entry,
          status: "cancelled",
          phase: null,
        });
      });
    });
  }, []);

  useEffect(() => {
    const open = new Set(openSessionIds);
    if (sessionId) open.add(sessionId);
    setEntries((current) => {
      const closed = Object.entries(current).filter(([, entry]) => !open.has(entry.sessionId));
      if (closed.length === 0) return current;
      for (const [, entry] of closed) {
        if (entry.status === "running" && entry.jobId) {
          void window.patentApi.aiCorrection?.cancel({ jobId: entry.jobId });
        }
        if (entry.jobId) jobs.current.delete(entry.jobId);
        const key = entryKey(entry.patentId, entry.originBookKind);
        if (locks.current.get(key) === entry.jobId) locks.current.delete(key);
        tracking.current.get(key)?.();
        tracking.current.delete(key);
      }
      return Object.fromEntries(
        Object.entries(current).filter(([, entry]) => open.has(entry.sessionId)),
      );
    });
  }, [openSessionIds, sessionId]);

  const selectedEntry = selectVisibleEntry(entries, patentId, bookKind);
  const activeEntry = selectedEntry?.sessionId === sessionId ? selectedEntry : null;
  const activeEntryKey = activeEntry
    ? entryKey(activeEntry.patentId, activeEntry.originBookKind)
    : null;
  const status: AiCorrectionPanelStatus = activeEntry?.status ?? "idle";
  const issues = activeEntry?.issues ?? [];
  const progress = activeEntry?.progress ?? null;
  const error = activeEntry?.error ?? null;
  const phase: AiCorrectionPhase | null = activeEntry?.phase ?? null;
  const reasoning = activeEntry?.reasoning ?? "";
  const reasoningTruncated = activeEntry?.reasoningTruncated ?? false;
  const resultLimitReached = activeEntry?.resultLimitReached ?? false;
  const discardedIssueCount = activeEntry?.discardedIssueCount ?? 0;
  const taskThinkingEnabled =
    activeEntry?.status === "running" ? activeEntry.thinkingEnabled : thinkingEnabled;

  const selectionAvailable = Boolean(editor && !editor.state.selection.empty);
  const start = useCallback(
    async (kind: "selection" | "current-book") => {
      if (!window.patentApi.aiCorrection) {
        throw new Error("当前版本未加载 AI 纠错服务，请重启应用后重试。");
      }
      if (!patentId || !sessionId) throw new Error("请先打开需要检查的专利。");
      const key = entryKey(patentId, bookKind);
      if (locks.current.has(key)) return;
      const jobId = createSettingsId();
      tracking.current.get(key)?.();
      tracking.current.delete(key);
      locks.current.set(key, jobId);
      jobs.current.set(jobId, key);
      setEntries((current) =>
        upsertEntry(current, key, {
          patentId,
          sessionId,
          scope: { kind: "current-book", bookKind },
          originBookKind: bookKind,
          status: "starting",
          jobId,
          issues: [],
          progress: null,
          error: null,
          thinkingEnabled,
          phase: "preparing",
          reasoning: "",
          reasoningTruncated: false,
          resultLimitReached: false,
          discardedIssueCount: 0,
          reportedIssueCount: 0,
          modelName,
        }),
      );
      const failPendingStart = (message: string) => {
        jobs.current.delete(jobId);
        if (locks.current.get(key) === jobId) locks.current.delete(key);
        setEntries((current) => {
          const entry = current[key];
          if (!entry || entry.jobId !== jobId) return current;
          return upsertEntry(current, key, {
            ...entry,
            status: "failed",
            jobId: null,
            error: message,
            phase: null,
            reasoning: "",
            reasoningTruncated: false,
            resultLimitReached: false,
            discardedIssueCount: 0,
          });
        });
      };
      let result: Awaited<ReturnType<typeof window.patentApi.aiCorrection.start>>;
      try {
        let scope: AiCorrectionScope = { kind: "current-book", bookKind };
        if (kind === "selection") {
          if (!editor) throw new Error("当前编辑器尚未就绪。");
          scope = await selectionScope(editor, bookKind);
        }
        if (!jobs.current.has(jobId)) return;
        const prepared = await prepare();
        if (!jobs.current.has(jobId)) return;
        if (!prepared) throw new Error("保存当前专利失败，未启动 AI 纠错。");
        if (prepared.patentId !== patentId || prepared.sessionId !== sessionId)
          throw new Error("专利会话已变化，请重新开始检查。");
        if (editor)
          tracking.current.set(
            key,
            startCorrectionAnchorTracking(
              editor,
              (changedIssues, applied) => {
                setEntries((current) => {
                  const entry = current[key];
                  if (!entry || entry.jobId !== jobId) return current;
                  const ids = new Set(changedIssues.map((issue) => issue.issueId));
                  const remaining = entry.issues.filter((issue) => !ids.has(issue.issueId));
                  return upsertEntry(current, key, {
                    ...entry,
                    issues: applied ? remaining : [...remaining, ...changedIssues],
                  });
                });
              },
              (contentChanged) =>
                setEntries((current) => {
                  const entry = current[key];
                  return entry?.jobId === jobId
                    ? upsertEntry(current, key, { ...entry, contentChanged })
                    : current;
                }),
            ),
          );
        setEntries((current) =>
          current[key]?.jobId === jobId
            ? upsertEntry(current, key, {
                ...current[key],
                scope,
                status: "running",
                checkedAt: new Date().toISOString(),
                checkedRevision: prepared.expectedRevision,
              })
            : current,
        );
        result = await window.patentApi.aiCorrection.start({
          ...prepared,
          jobId,
          scope,
          thinkingEnabled,
          uploadConfirmed: true,
        });
      } catch (error) {
        if (!jobs.current.has(jobId)) return;
        failPendingStart(error instanceof Error ? error.message : "AI 纠错启动失败。");
        throw error;
      }
      if (!result.ok) {
        failPendingStart(result.error.message);
        return;
      }
      if (result.value.jobId !== jobId) {
        const error = new Error("AI 纠错任务标识不一致。");
        failPendingStart(error.message);
        throw error;
      }
      if (!jobs.current.has(jobId) && locks.current.get(key) === jobId) locks.current.delete(key);
    },
    [bookKind, editor, prepare, thinkingEnabled, patentId, sessionId, modelName],
  );

  const cancel = useCallback(async () => {
    if (!activeEntry?.jobId || !activeEntryKey || activeEntry.status === "stopping") return;
    const { jobId } = activeEntry;
    const update = (status: AiCorrectionPanelStatus, error: string | null) =>
      setEntries((current) => {
        const entry = current[activeEntryKey];
        return entry?.jobId === jobId && ["starting", "running", "stopping"].includes(entry.status)
          ? upsertEntry(current, activeEntryKey, { ...entry, status, error })
          : current;
      });
    if (activeEntry.status === "starting") {
      jobs.current.delete(jobId);
      if (locks.current.get(activeEntryKey) === jobId) locks.current.delete(activeEntryKey);
      update("cancelled", null);
      return;
    }
    update("stopping", null);
    try {
      const result = await window.patentApi.aiCorrection.cancel({ jobId });
      if (!result.ok) throw new Error(result.error.message);
    } catch (error) {
      update("running", error instanceof Error ? error.message : "停止请求失败，请重试。");
    }
  }, [activeEntry, activeEntryKey]);

  const removeIssues = useCallback(
    (issueIds: readonly string[]) => {
      if (!activeEntryKey) return;
      setEntries((current) => {
        const entry = current[activeEntryKey];
        return entry
          ? upsertEntry(current, activeEntryKey, {
              ...entry,
              issues: entry.issues.filter((issue) => !issueIds.includes(issue.issueId)),
            })
          : current;
      });
    },
    [activeEntryKey],
  );

  const restart = useCallback(() => {
    if (!activeEntryKey) return;
    setEntries((current) => {
      const entry = current[activeEntryKey];
      return entry
        ? upsertEntry(current, activeEntryKey, {
            ...entry,
            status: "idle",
            progress: null,
            error: null,
            phase: null,
            reasoning: "",
            reasoningTruncated: false,
            resultLimitReached: false,
            discardedIssueCount: 0,
          })
        : current;
    });
  }, [activeEntryKey]);

  return useMemo(
    () => ({
      status,
      issues,
      progress,
      error,
      phase,
      reasoning,
      reasoningTruncated,
      resultLimitReached,
      discardedIssueCount,
      thinkingEnabled: taskThinkingEnabled,
      reportedIssueCount: activeEntry?.reportedIssueCount ?? issues.length,
      selectionAvailable,
      start,
      restart,
      cancel,
      removeIssues,
      resultScope: activeEntry?.scope.kind,
      checkedAt: activeEntry?.checkedAt,
      checkedRevision: activeEntry?.checkedRevision,
      contentChanged: activeEntry?.contentChanged ?? false,
      modelName: activeEntry?.modelName,
    }),
    [
      cancel,
      error,
      issues,
      phase,
      progress,
      reasoning,
      reasoningTruncated,
      resultLimitReached,
      discardedIssueCount,
      removeIssues,
      restart,
      selectionAvailable,
      start,
      status,
      taskThinkingEnabled,
      activeEntry?.reportedIssueCount,
      activeEntry?.scope.kind,
      activeEntry?.checkedAt,
      activeEntry?.checkedRevision,
      activeEntry?.contentChanged,
      activeEntry?.modelName,
    ],
  );
}
