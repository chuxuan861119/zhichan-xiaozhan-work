import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupRunResult } from "../../../shared/backup/model";
import {
  useApplicationCloseParticipant,
  useApplicationClosing,
} from "../app/application-close-coordinator";
import { MotionPresence } from "../app/motion-presence";
import { StandardDialog } from "../shared/standard-dialog";

const IDLE_BACKUP_DELAY_MS = 20_000;
const EXIT_PROGRESS_DELAY_MS = 1_500;
const EXIT_WITHOUT_WAITING_DELAY_MS = 5_000;
const APPLICATION_CLOSE_ONLY = { reasons: ["application-close"] as const };

export type BackupRuntimeTarget = {
  patentId: string;
  revision: number;
};

type ExitBackupDialog =
  | { kind: "progress"; canExitWithoutWaiting: boolean; stopping: boolean }
  | { kind: "failure"; message: string }
  | null;

type FailureDecision = "retry" | "return" | "exit";

function failedMessage(result: BackupRunResult): string {
  if (result.cancelled) return "备份已在当前文件完成后停止。";
  return result.failures[0]?.message ?? "外部备份未完成。";
}

function isFinished(result: BackupRunResult): boolean {
  return !result.cancelled && result.failures.length === 0;
}

export function requestPatentCloseBackup(patentId: string): void {
  const backup = window.patentApi.backup;
  if (!backup?.ensureCurrent) return;
  void backup.ensureCurrent({ documentType: "patent", documentId: patentId });
}

export function BackupRuntimeCoordinator({
  targets,
}: Readonly<{ targets: BackupRuntimeTarget[] }>) {
  const closing = useApplicationClosing();
  const [dialog, setDialog] = useState<ExitBackupDialog>(null);
  const [writingBackup, setWritingBackup] = useState(false);
  const [canReturn, setCanReturn] = useState(false);
  const [returning, setReturning] = useState(false);
  const showingProgress = dialog?.kind === "progress";
  useEffect(() => {
    if (!showingProgress) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await window.patentApi.backup?.operationStatus?.();
        if (active)
          setWritingBackup(Boolean(result?.ok && result.value.currentDisplayName !== null));
      } catch {
        // Finalization reports failures; a status read must not interrupt it.
      }
      if (active) timer = setTimeout(() => void poll(), 300);
    };
    setWritingBackup(false);
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [showingProgress]);
  const targetsRef = useRef(new Map<string, number>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const exitRequestedRef = useRef(false);
  const returnRequestedRef = useRef(false);
  const failureDecisionRef = useRef<((decision: FailureDecision) => void) | null>(null);

  const clearIdleTimer = useCallback((patentId: string) => {
    const timer = timersRef.current.get(patentId);
    if (timer !== undefined) clearTimeout(timer);
    timersRef.current.delete(patentId);
  }, []);

  useEffect(() => {
    if (closing) {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      targetsRef.current.clear();
      return;
    }
    const incoming = new Map(targets.map((target) => [target.patentId, target.revision]));
    for (const patentId of targetsRef.current.keys()) {
      if (!incoming.has(patentId)) clearIdleTimer(patentId);
    }
    for (const [patentId, revision] of incoming) {
      const previousRevision = targetsRef.current.get(patentId);
      if (previousRevision === revision) continue;
      clearIdleTimer(patentId);
      timersRef.current.set(
        patentId,
        setTimeout(() => {
          timersRef.current.delete(patentId);
          const backup = window.patentApi.backup;
          if (backup?.ensureCurrent) {
            void backup.ensureCurrent({ documentType: "patent", documentId: patentId });
          }
        }, IDLE_BACKUP_DELAY_MS),
      );
    }
    targetsRef.current = incoming;
  }, [clearIdleTimer, targets, closing]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  const waitForFailureDecision = useCallback(
    () =>
      new Promise<FailureDecision>((resolve) => {
        failureDecisionRef.current = resolve;
      }),
    [],
  );

  const finalizeBackup = useCallback(async (): Promise<boolean> => {
    const backup = window.patentApi.backup;
    if (!backup?.finalize) return true;
    exitRequestedRef.current = false;
    returnRequestedRef.current = false;
    setReturning(false);
    let shouldRetry = true;
    while (shouldRetry) {
      shouldRetry = false;
      let showProgressTimer: ReturnType<typeof setTimeout> | undefined;
      let allowExitTimer: ReturnType<typeof setTimeout> | undefined;
      let allowReturnTimer: ReturnType<typeof setTimeout> | undefined;
      setCanReturn(false);
      const clearProgressTimers = () => {
        if (showProgressTimer !== undefined) clearTimeout(showProgressTimer);
        if (allowExitTimer !== undefined) clearTimeout(allowExitTimer);
        if (allowReturnTimer !== undefined) clearTimeout(allowReturnTimer);
      };
      try {
        showProgressTimer = setTimeout(() => {
          setDialog({ kind: "progress", canExitWithoutWaiting: false, stopping: false });
        }, EXIT_PROGRESS_DELAY_MS);
        allowExitTimer = setTimeout(() => {
          setDialog((current) =>
            current?.kind === "progress" ? { ...current, canExitWithoutWaiting: true } : current,
          );
        }, EXIT_WITHOUT_WAITING_DELAY_MS);
        allowReturnTimer = setTimeout(() => setCanReturn(true), 8_000);
        const response = await backup.finalize().finally(clearProgressTimers);
        if (returnRequestedRef.current) {
          setDialog(null);
          return false;
        }
        if (exitRequestedRef.current) return true;
        if (!response.ok) {
          setDialog({ kind: "failure", message: response.error.message });
        } else if (isFinished(response.value)) {
          setDialog(null);
          return true;
        } else {
          setDialog({ kind: "failure", message: failedMessage(response.value) });
        }

        const decision = await waitForFailureDecision();
        failureDecisionRef.current = null;
        if (decision === "exit") return true;
        if (decision === "return") return false;
        shouldRetry = true;
      } catch {
        if (returnRequestedRef.current) {
          setDialog(null);
          return false;
        }
        if (exitRequestedRef.current) return true;
        setDialog({ kind: "failure", message: "无法完成外部备份，请稍后重试。" });
        const decision = await waitForFailureDecision();
        failureDecisionRef.current = null;
        if (decision === "exit") return true;
        if (decision === "return") return false;
        shouldRetry = true;
      } finally {
        clearProgressTimers();
      }
    }
    return false;
  }, [waitForFailureDecision]);

  useApplicationCloseParticipant(
    "final-incremental-backup",
    finalizeBackup,
    "backup",
    APPLICATION_CLOSE_ONLY,
  );

  const exitWithoutWaiting = useCallback(async () => {
    exitRequestedRef.current = true;
    setDialog({ kind: "progress", canExitWithoutWaiting: false, stopping: true });
    try {
      const backup = window.patentApi.backup;
      if (backup?.cancelFinalization) await backup.cancelFinalization();
    } catch {
      // The active finalization continues to its safe file boundary even if this IPC call fails.
    }
  }, []);

  const decideFailure = useCallback((decision: FailureDecision) => {
    setDialog(null);
    failureDecisionRef.current?.(decision);
  }, []);

  const returnToApplication = useCallback(async () => {
    returnRequestedRef.current = true;
    setReturning(true);
    setDialog({ kind: "progress", canExitWithoutWaiting: false, stopping: true });
    try {
      await window.patentApi.backup?.cancelFinalization?.();
    } catch {
      // Wait for the ongoing operation; never unlock editing during a file write.
    }
  }, []);

  return (
    <MotionPresence>
      {dialog?.kind === "progress" ? (
        <StandardDialog
          open
          title={
            returning
              ? "正在返回软件"
              : dialog.stopping
                ? "正在安全停止备份"
                : writingBackup
                  ? "正在补齐备份"
                  : "正在检查备份"
          }
          size="s"
          onCancel={() => undefined}
          closeDisabled
          footer={
            <>
              {canReturn && !dialog.stopping ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void returnToApplication()}
                >
                  返回软件
                </button>
              ) : null}
              {dialog.canExitWithoutWaiting ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void exitWithoutWaiting()}
                >
                  退出但不等待备份
                </button>
              ) : null}
            </>
          }
        >
          <div role="status" aria-label="正在完成退出备份">
            <p className="backup-exit-dialog__message">
              {returning
                ? "当前文件完成后返回软件，本地修改已保存。"
                : dialog.stopping
                  ? "当前文件完成后将退出，已完成的备份不会损坏。"
                  : writingBackup
                    ? "正在备份尚未进入外部备份的已保存内容。"
                    : "正在确认已保存内容的备份状态，没有新修改时不会重复生成备份。"}
            </p>
          </div>
        </StandardDialog>
      ) : dialog?.kind === "failure" ? (
        <StandardDialog
          open
          title="退出备份未完成"
          size="s"
          onCancel={() => decideFailure("return")}
          footer={
            <>
              <button
                type="button"
                onClick={() => decideFailure("return")}
                className="secondary-button"
              >
                返回
              </button>
              <button
                type="button"
                onClick={() => decideFailure("exit")}
                className="secondary-button"
              >
                退出但不等待备份
              </button>
              <button
                type="button"
                onClick={() => decideFailure("retry")}
                className="primary-button"
              >
                重试备份
              </button>
            </>
          }
        >
          <p className="backup-exit-dialog__message">专利库内容已保存，但外部备份未完成。</p>
          <p className="backup-exit-dialog__message backup-exit-dialog__message--danger">
            {dialog.message}
          </p>
        </StandardDialog>
      ) : null}
    </MotionPresence>
  );
}
