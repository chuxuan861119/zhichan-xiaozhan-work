import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentSearchState } from "../../../shared/library/content-search";
import { prefersReducedMotion } from "../shared/motion-preference";
import { SPATIAL_MOTION_TIMING } from "../shared/spatial-motion";
import { StandardDialog } from "../shared/standard-dialog";

type ContentSearchIndexDialogProps = {
  onCancel(): void;
  onComplete(): void;
};

type DialogPhase = "confirm" | "indexing" | "error" | "partial" | "completed";

export function ContentSearchIndexDialog({ onCancel, onComplete }: ContentSearchIndexDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>("confirm");
  const [state, setState] = useState<ContentSearchState | null>(null);
  const [stopping, setStopping] = useState(false);
  const operation = useRef(false);
  const run = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const stopPending = useRef(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  const finishIfComplete = useCallback((next: ContentSearchState) => {
    if (run.current && run.current !== next.runId) {
      setPhase("error");
      return true;
    }
    if (next.running) return false;
    if (next.indexPhase === "cancelled") {
      setPhase("confirm");
      return true;
    }
    if (
      next.error ||
      next.incomplete ||
      next.indexPhase === "partial" ||
      next.indexPhase === "failed"
    ) {
      setPhase((next.indexedCount ?? 0) > 0 ? "partial" : "error");
      return true;
    }
    if (next.indexPhase === "completed" || next.updatedAt) {
      setPhase("completed");
      return true;
    }
    setPhase("error");
    return true;
  }, []);
  useEffect(() => {
    if (phase !== "completed") return;
    const timer = window.setTimeout(
      () => completeRef.current(),
      prefersReducedMotion() ? 0 : SPATIAL_MOTION_TIMING.duration,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  const startIndexing = async () => {
    if (operation.current) return;
    operation.current = true;
    const token = ++epoch.current;
    setPhase("indexing");
    try {
      const result = await window.patentApi.contentSearch?.request({ action: "start" });
      if (!mounted.current || token !== epoch.current) return;
      if (!result?.ok) {
        setPhase("error");
        return;
      }
      setState(result.value);
      run.current = result.value.runId;
      finishIfComplete(result.value);
    } catch {
      if (mounted.current && token === epoch.current) setPhase("error");
    } finally {
      operation.current = false;
    }
  };
  const stopIndexing = async () => {
    if (stopPending.current) return;
    stopPending.current = true;
    epoch.current++;
    setStopping(true);
    try {
      const result = await window.patentApi.contentSearch?.request({ action: "stop" });
      if (!mounted.current) return;
      if (result?.ok) {
        setPhase("confirm");
        onCancel();
      } else setPhase("error");
    } catch {
      if (mounted.current) setPhase("error");
    } finally {
      stopPending.current = false;
      if (mounted.current) setStopping(false);
    }
  };

  useEffect(() => {
    if (phase !== "indexing") return;
    let cancelled = false;
    let polling = false;
    const readStatus = async () => {
      if (polling || operation.current || stopPending.current) return;
      polling = true;
      const token = epoch.current;
      try {
        const result = await window.patentApi.contentSearch?.request({ action: "status" });
        if (cancelled || token !== epoch.current || stopPending.current) return;
        if (!result?.ok) {
          setPhase("error");
          return;
        }
        setState(result.value);
        finishIfComplete(result.value);
      } catch {
        if (!cancelled && token === epoch.current && !stopPending.current) setPhase("error");
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void readStatus(), 300);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [finishIfComplete, phase]);

  const total = Math.max(0, state?.total ?? 0);
  const completed = Math.min(total, Math.max(0, state?.completed ?? 0));
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const indexing = phase === "indexing";

  return (
    <StandardDialog
      open
      portal
      title="建立正文索引"
      size="s"
      showClose={!indexing && phase !== "completed"}
      closeDisabled={stopping || phase === "completed"}
      onCancel={indexing ? () => void stopIndexing() : onCancel}
      footer={
        phase === "confirm" ? (
          <>
            <button type="button" onClick={onCancel}>
              暂不索引
            </button>
            <button type="button" className="primary-button" onClick={() => void startIndexing()}>
              先建立索引
            </button>
          </>
        ) : phase === "error" || phase === "partial" ? (
          <>
            <button type="button" onClick={onCancel}>
              关闭
            </button>
            <button type="button" className="primary-button" onClick={() => void startIndexing()}>
              重试
            </button>
            {phase === "partial" ? (
              <button type="button" onClick={onComplete}>
                搜索已有内容
              </button>
            ) : null}
          </>
        ) : indexing ? (
          <button type="button" disabled={stopping} onClick={() => void stopIndexing()}>
            {stopping ? "正在停止…" : "停止索引"}
          </button>
        ) : null
      }
    >
      {phase === "confirm" ? (
        <div className="content-index-dialog__message">
          <p>专利库正文索引尚未完成或需要更新。建立完成后可以搜索五书正文。</p>
          <p>索引仅在本机处理，不会修改专利内容。</p>
        </div>
      ) : phase === "error" || phase === "partial" ? (
        <p className="content-index-dialog__error" role="alert">
          {phase === "partial"
            ? `部分正文未完成索引${state?.failedCount ? `（${state.failedCount} 项失败）` : ""}，可以重试或搜索已有内容。`
            : "正文索引未完成或状态无法读取，请重试。"}
        </p>
      ) : (
        <div className="content-index-dialog__progress" aria-live="polite">
          <div className="content-index-dialog__progress-heading">
            <strong>
              {phase === "completed"
                ? "索引已完成"
                : state?.paused
                  ? "等待空闲"
                  : "正在建立正文索引"}
            </strong>
            <span>{total > 0 ? `${completed} / ${total}` : "正在准备"}</span>
          </div>
          <div
            className="content-index-dialog__progress-track"
            role="progressbar"
            aria-label="正文索引进度"
            aria-valuemin={0}
            aria-valuemax={total || undefined}
            aria-valuenow={total > 0 ? completed : undefined}
            data-indeterminate={total === 0 || undefined}
          >
            <span style={total > 0 ? { width: `${progress}%` } : undefined} />
          </div>
          <p>索引完成后自动进入正文搜索；停止后保留已完成的索引。</p>
        </div>
      )}
    </StandardDialog>
  );
}
