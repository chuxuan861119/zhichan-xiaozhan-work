import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  FileText,
  LocateFixed,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AiCorrectionIssue,
  AiCorrectionPhase,
} from "../../../../shared/ai-correction/contract";
import { AiExperimentalNotice } from "../../shared/ai-experimental-notice";
import { DialogCloseIcon } from "../../shared/dialog-close-icon";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import { SpatialPresence } from "../../shared/spatial-presence";
import { SpatialView } from "../../shared/spatial-view";
import { useRetainedTransientVisibility } from "../../shared/transient-function-rail-slot";
import { AiThinkingFeedback, useThinkingActivity } from "./ai-thinking-feedback";
import "./ai-correction-panel.css";
import { AI_CORRECTION_PROMPT_VERSION } from "../../../../shared/ai-correction/prompt-version";
import { replacementSafetyReason } from "../../../../shared/ai-correction/replacement-policy";

function canReplace(issue: AiCorrectionIssue): boolean {
  return (
    issue.applicability === "replace" &&
    issue.risk !== "high" &&
    issue.replacement !== null &&
    replacementSafetyReason(issue.anchor.originalText, issue.replacement) === null
  );
}

function ReasoningArchive({ text, truncated }: { text: string; truncated: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  if (!text) return null;
  return (
    <section className="ai-thinking-archive" aria-label="思考过程记录">
      <div className="ai-thinking-archive__actions">
        <button
          type="button"
          aria-label={expanded ? "折叠思考过程" : "展开思考过程"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} 思考过程
        </button>
        <button
          type="button"
          className="ai-icon-button"
          aria-label="复制思考过程"
          title="复制思考过程"
          onClick={() => {
            void (async () => {
              try {
                const result = await window.patentApi.clipboard.writeText(text);
                setNotice(result.ok ? "已复制思考过程" : result.error.message);
              } catch {
                setNotice("复制失败，请展开后手动选择文字复制。");
              }
            })();
          }}
        >
          <Copy size={14} />
        </button>
      </div>
      {notice ? <small role="status">{notice}</small> : null}
      <SpatialCollapse open={expanded}>
        <div className="ai-thinking-archive__text" data-selectable-tool-text>
          {truncated ? <small>内容超过记录容量，较早内容未保留。</small> : null}
          {text.length > 20_000 ? (
            <small>显示最近 20000 字符，可通过复制按钮复制全部已保留内容。</small>
          ) : null}
          <pre>{text.slice(-20_000)}</pre>
        </div>
      </SpatialCollapse>
    </section>
  );
}

export type AiCorrectionPanelStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

const CATEGORY_LABELS: Record<AiCorrectionIssue["category"], string> = {
  spelling: "错字",
  grammar: "语病",
  punctuation: "标点",
  terminology: "术语",
  compliance: "规范",
  consistency: "内容一致性",
};

const PHASE_LABELS: Record<AiCorrectionPhase, string> = {
  retrying: "未收到正式答案，正在重试（1/1）",
  preparing: "正在准备检查内容",
  connecting: "正在连接 AI 服务",
  thinking: "正在思考",
  structuring: "正在生成纠错结果",
  summarizing: "正在整理较早对话",
};

export function AiCorrectionPanel({
  open,
  taskKey = "correction",
  hidden = false,
  status,
  issues,
  error = null,
  selectionAvailable = false,
  modelConfigured = true,
  phase = null,
  reasoning = "",
  reasoningTruncated = false,
  resultLimitReached = false,
  discardedIssueCount = 0,
  reportedIssueCount = issues.length,
  progress = null,
  bookKind,
  resultScope,
  checkedAt,
  checkedRevision,
  contentChanged = false,
  modelName,
  connectionDisabled = false,
  onStart,
  onRestart = () => undefined,
  onCancel,
  onClose,
  onOpenSettings,
  onLocate,
  onAccept,
  onBatchAccept,
}: {
  open: boolean;
  taskKey?: string;
  hidden?: boolean;
  status: AiCorrectionPanelStatus;
  issues: readonly AiCorrectionIssue[];
  error?: string | null;
  selectionAvailable?: boolean;
  modelConfigured?: boolean;
  phase?: AiCorrectionPhase | null;
  reasoning?: string;
  reasoningTruncated?: boolean;
  resultLimitReached?: boolean;
  discardedIssueCount?: number;
  reportedIssueCount?: number;
  progress?: { completed: number; total: number } | null;
  bookKind?: AiCorrectionIssue["anchor"]["bookKind"];
  resultScope?: "selection" | "current-book" | undefined;
  checkedAt?: string | undefined;
  checkedRevision?: number | undefined;
  contentChanged?: boolean;
  modelName?: string | undefined;
  connectionDisabled?: boolean;
  onStart(scope: "selection" | "current-book"): void;
  onRestart?(): void;
  onCancel(): void;
  onClose(): void;
  onOpenSettings(): void;
  onLocate(issue: AiCorrectionIssue): void;
  onAccept(issue: AiCorrectionIssue): void;
  onBatchAccept(issues: readonly AiCorrectionIssue[]): void;
}) {
  const visible = useRetainedTransientVisibility(open);
  const [scope, setScope] = useState<"selection" | "current-book">("current-book");
  const [selectedByTask, setSelectedByTask] = useState<Record<string, Set<string>>>({});
  const [ignoredByTask, setIgnoredByTask] = useState<Record<string, Set<string>>>({});
  const selected = selectedByTask[taskKey] ?? new Set<string>();
  const ignored = ignoredByTask[taskKey] ?? new Set<string>();
  const setSelected = (update: (current: Set<string>) => Set<string>) =>
    setSelectedByTask((current) => ({
      ...current,
      [taskKey]: update(current[taskKey] ?? new Set()),
    }));
  const setIgnored = (update: (current: Set<string>) => Set<string>) =>
    setIgnoredByTask((current) => ({
      ...current,
      [taskKey]: update(current[taskKey] ?? new Set()),
    }));
  const activity = useThinkingActivity(
    status === "starting" || status === "running" || status === "stopping",
    taskKey,
    phase,
    reasoning,
  );

  const visibleIssues = issues.filter((issue) => !ignored.has(issue.issueId));
  const ignoredCount = issues.length - visibleIssues.length;
  const acceptedCount = Math.max(0, reportedIssueCount - issues.length);
  const partialResults =
    (status === "failed" || status === "cancelled") &&
    (reportedIssueCount > 0 || (progress?.completed ?? 0) > 0);
  const runningLabel = PHASE_LABELS[phase ?? "preparing"];
  const bookLabel =
    bookKind === "claims"
      ? "权利要求书"
      : bookKind === "description"
        ? "说明书"
        : bookKind === "abstract"
          ? "说明书摘要"
          : "当前文档";
  const batch = useMemo(
    () => visibleIssues.filter((issue) => selected.has(issue.issueId) && canReplace(issue)),
    [selected, visibleIssues],
  );
  if (!visible) return null;

  return (
    <aside
      className="assistant-side-panel ai-correction-panel"
      aria-label="AI 纠错"
      hidden={hidden}
      data-motion={open ? "enter" : "exit"}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
    >
      <header className="assistant-side-panel__header ai-correction-panel__header">
        <div className="assistant-side-panel__header-title">
          <h2>AI 纠错</h2>
          <AiExperimentalNotice feature="AI 纠错" />
        </div>
        <div className="assistant-side-panel__header-actions">
          <button
            type="button"
            className="ai-icon-button"
            aria-label="模型配置"
            title="模型配置"
            onClick={onOpenSettings}
          >
            <Settings2 size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ai-icon-button dialog-close-button dialog-close-control"
            aria-label="关闭 AI 纠错"
            title="关闭 AI 纠错"
            onClick={onClose}
          >
            <DialogCloseIcon />
          </button>
        </div>
      </header>

      <SpatialView viewKey={status}>
        {status === "idle" ||
        ((status === "failed" || status === "cancelled") && !partialResults) ? (
          <div className="assistant-side-panel__body ai-correction-launch">
            <h3>检查范围</h3>
            <div className="ai-scope-options">
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: The native radio retains keyboard activation; this handler covers the full label without moving editor focus. */}
              <label
                className={scope === "current-book" ? "is-selected" : ""}
                onClick={() => setScope("current-book")}
              >
                <input
                  type="radio"
                  name="ai-scope"
                  checked={scope === "current-book"}
                  onChange={() => setScope("current-book")}
                />
                <span>
                  <strong>当前文档</strong>
                  <small>检查当前打开的文字文档</small>
                </span>
              </label>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard interaction is handled by the contained native radio. */}
              <label
                className={scope === "selection" ? "is-selected" : ""}
                onClick={() => {
                  if (selectionAvailable) setScope("selection");
                }}
              >
                <input
                  type="radio"
                  name="ai-scope"
                  disabled={!selectionAvailable}
                  checked={scope === "selection"}
                  onChange={() => setScope("selection")}
                />
                <span>
                  <strong>选中文字</strong>
                  <small>{selectionAvailable ? "只检查当前选区" : "请先在正文中选择文字"}</small>
                </span>
              </label>
            </div>
            <p className="ai-document-context">
              <FileText size={13} aria-hidden="true" />
              {bookLabel} ·{" "}
              {scope === "selection"
                ? selectionAvailable
                  ? "已选中文字"
                  : "请重新选择文字"
                : "当前文档"}
            </p>
            {!modelConfigured ? (
              <div className="ai-model-required" role="status">
                <Cpu size={18} aria-hidden="true" />
                <div>
                  <strong>{connectionDisabled ? "AI 连接已关闭" : "模型或密钥尚未就绪"}</strong>
                  <span>
                    请先
                    <button type="button" onClick={onOpenSettings}>
                      {connectionDisabled ? "开启 AI 连接" : "配置模型"}
                    </button>
                    后再开始检查
                  </span>
                </div>
              </div>
            ) : null}
            {
              <SpatialPresence>
                {error ? (
                  <div role="alert" className="ai-form-error">
                    <strong>暂时未能完成检查</strong>
                    <p>{error}</p>
                  </div>
                ) : null}
              </SpatialPresence>
            }
            {status === "failed" || status === "cancelled" ? (
              <ReasoningArchive key={status} text={reasoning} truncated={reasoningTruncated} />
            ) : null}
            <button
              type="button"
              className="ai-primary-action"
              disabled={!modelConfigured || (scope === "selection" && !selectionAvailable)}
              onClick={() => onStart(scope)}
            >
              {status === "failed" ? (
                <RotateCcw size={15} aria-hidden="true" />
              ) : (
                <Sparkles size={15} aria-hidden="true" />
              )}
              {status === "failed" ? "重新思考" : "开始思考"}
            </button>
            <p className="ai-launch-note">仅发送所选范围内的正文至已配置的 AI 服务</p>
          </div>
        ) : null}
      </SpatialView>

      <SpatialView viewKey={status}>
        {status === "running" || status === "starting" || status === "stopping" ? (
          <div className="assistant-side-panel__body ai-correction-running is-thinking">
            <AiThinkingFeedback
              key={`${taskKey}:${activity.started}`}
              label={status === "stopping" ? "正在停止…" : runningLabel}
              text={reasoning}
              truncated={reasoningTruncated}
              activity={activity}
            />
            {
              <SpatialPresence>
                {error ? (
                  <p role="alert" className="ai-form-error">
                    {error}
                  </p>
                ) : null}
              </SpatialPresence>
            }
            <div className="ai-correction-stop-row">
              <span aria-live="polite">
                {bookLabel}
                {progress && progress.total > 1
                  ? ` · 已检查 ${progress.completed}/${progress.total} 批`
                  : ""}
              </span>
              <button
                type="button"
                className="ai-stop-action"
                onClick={onCancel}
                disabled={status === "stopping"}
              >
                <Square size={12} aria-hidden="true" />
                {status === "stopping" ? "正在停止…" : "停止思考"}
              </button>
            </div>
          </div>
        ) : null}
      </SpatialView>

      <SpatialView viewKey={status}>
        {
          <SpatialPresence>
            {status === "completed" || partialResults ? (
              <div className="assistant-side-panel__body ai-correction-results">
                <div className="ai-correction-results-heading">
                  <div className="ai-results-summary">
                    <span>
                      <strong>{visibleIssues.length}</strong> 项建议
                    </span>
                    <button
                      type="button"
                      className="ai-icon-button"
                      aria-label="重新检查"
                      title="重新检查"
                      onClick={onRestart}
                    >
                      <RotateCcw size={17} aria-hidden="true" />
                    </button>
                  </div>
                  <p className="ai-correction-result-context">
                    {bookLabel} · {partialResults ? "部分检查结果" : "检查完成"}
                    {resultScope
                      ? ` · ${resultScope === "selection" ? "选中文字" : "当前文档"}`
                      : ""}
                  </p>
                  {checkedAt ? (
                    <p
                      className="ai-correction-result-context"
                      title={`提示词版本 ${AI_CORRECTION_PROMPT_VERSION} · 文档修订 ${checkedRevision ?? "未知"}`}
                    >
                      {modelName ?? "已配置模型"} · {new Date(checkedAt).toLocaleString()}
                    </p>
                  ) : null}
                  {
                    <SpatialPresence>
                      {contentChanged ? (
                        <p className="ai-correction-result-context">
                          正文已有修改，定位和接受时将逐项核对原文。
                        </p>
                      ) : null}
                    </SpatialPresence>
                  }
                  {
                    <SpatialPresence>
                      {acceptedCount > 0 || ignoredCount > 0 ? (
                        <p className="ai-correction-result-context">
                          已接受 {acceptedCount} 项，已忽略 {ignoredCount} 项。
                        </p>
                      ) : null}
                    </SpatialPresence>
                  }
                </div>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The independently scrolling results must be keyboard-scrollable. */}
                <section className="ai-correction-result-list" aria-label="纠错建议" tabIndex={0}>
                  <ReasoningArchive
                    key={`${taskKey}:${status}`}
                    text={reasoning}
                    truncated={reasoningTruncated}
                  />
                  {
                    <SpatialPresence>
                      {ignoredCount > 0 ? (
                        <button
                          type="button"
                          className="ai-icon-button"
                          title="恢复已忽略建议"
                          aria-label="恢复已忽略建议"
                          onClick={() => setIgnored(() => new Set())}
                        >
                          <RotateCcw size={15} />
                        </button>
                      ) : null}
                    </SpatialPresence>
                  }
                  {
                    <SpatialPresence>
                      {partialResults ? (
                        <p role="alert" className="ai-result-limit-notice">
                          检查未完成，已保留完成部分的结果。
                          {progress
                            ? `已完成 ${progress.completed}/${progress.total} 个部分。`
                            : ""}
                          {error ?? "任务已停止。"}
                        </p>
                      ) : null}
                    </SpatialPresence>
                  }
                  {
                    <SpatialPresence>
                      {resultLimitReached ? (
                        <p className="ai-result-limit-notice" role="status">
                          本次结果已达到单个分块上限，可能仍有未报告的问题。
                        </p>
                      ) : null}
                    </SpatialPresence>
                  }
                  {
                    <SpatialPresence>
                      {discardedIssueCount > 0 ? (
                        <p className="ai-result-limit-notice" role="status">
                          另有 {discardedIssueCount} 项模型结果因格式或定位无效而未显示。
                        </p>
                      ) : null}
                    </SpatialPresence>
                  }
                  {
                    <SpatialPresence>
                      {visibleIssues.length === 0 ? (
                        <div className="ai-correction-empty-state">
                          {partialResults ||
                          discardedIssueCount > 0 ||
                          resultLimitReached ? null : (
                            <span className="ai-correction-empty-icon">
                              <ShieldCheck size={24} strokeWidth={1.5} aria-hidden="true" />
                            </span>
                          )}
                          <p className="ai-empty-result">
                            {reportedIssueCount > 0
                              ? ignoredCount === reportedIssueCount
                                ? "建议已全部忽略。"
                                : "建议已全部处理。"
                              : partialResults
                                ? "已完成部分暂无可显示的建议，其余内容尚未完成检查。"
                                : discardedIssueCount > 0
                                  ? "没有可安全显示的建议，请缩小范围或重新检查。"
                                  : "当前范围未发现可报告的问题。"}
                          </p>
                          {!partialResults && discardedIssueCount === 0 ? (
                            <small>AI 结果供参考，仍建议人工复核。</small>
                          ) : null}
                        </div>
                      ) : (
                        visibleIssues.map((issue, index) => {
                          const replaceable = canReplace(issue);
                          return (
                            <article
                              className={`ai-issue-card risk-${issue.risk}`}
                              key={issue.issueId}
                              aria-label={`第 ${index + 1} 项`}
                            >
                              <div className="ai-issue-card__meta">
                                <span className="ai-issue-number" aria-hidden="true">
                                  {index + 1}
                                </span>
                                {replaceable ? (
                                  <input
                                    aria-label={`选择${issue.anchor.originalText}`}
                                    type="checkbox"
                                    checked={selected.has(issue.issueId)}
                                    onChange={(event) =>
                                      setSelected((current) => {
                                        const next = new Set(current);
                                        if (event.target.checked) next.add(issue.issueId);
                                        else next.delete(issue.issueId);
                                        return next;
                                      })
                                    }
                                  />
                                ) : null}
                                <span>{CATEGORY_LABELS[issue.category]}</span>
                                <em>
                                  {issue.risk === "high"
                                    ? "需人工核对"
                                    : issue.risk === "medium"
                                      ? "中风险"
                                      : "低风险"}
                                </em>
                              </div>
                              {!replaceable ? (
                                <blockquote className="ai-issue-anchor-text">
                                  {issue.anchor.originalText}
                                </blockquote>
                              ) : (
                                <div className="ai-issue-change">
                                  <del>{issue.anchor.originalText}</del>
                                  {issue.replacement !== null ? (
                                    <>
                                      <ArrowRight size={13} aria-hidden="true" />
                                      <ins>{issue.replacement || "删除"}</ins>
                                    </>
                                  ) : null}
                                </div>
                              )}
                              <p>{issue.explanation}</p>
                              {!replaceable && issue.replacement !== null ? (
                                <p>
                                  {replacementSafetyReason(
                                    issue.anchor.originalText,
                                    issue.replacement,
                                  )}
                                </p>
                              ) : null}
                              <footer>
                                <span className="ai-issue-document">
                                  {issue.anchor.bookKind === "claims"
                                    ? "权利要求书"
                                    : issue.anchor.bookKind === "abstract"
                                      ? "说明书摘要"
                                      : "说明书"}
                                </span>
                                <button
                                  type="button"
                                  className="ai-icon-button"
                                  aria-label="定位"
                                  title="定位原文"
                                  onClick={() => onLocate(issue)}
                                >
                                  <LocateFixed size={15} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className="ai-icon-button"
                                  aria-label="忽略"
                                  title="忽略建议"
                                  onClick={() =>
                                    setIgnored((current) => new Set(current).add(issue.issueId))
                                  }
                                >
                                  <X size={15} aria-hidden="true" />
                                </button>
                                {replaceable ? (
                                  <button
                                    type="button"
                                    className="ai-icon-button is-primary"
                                    aria-label="接受"
                                    title="接受建议"
                                    onClick={() => onAccept(issue)}
                                  >
                                    <Check size={15} aria-hidden="true" />
                                  </button>
                                ) : null}
                              </footer>
                            </article>
                          );
                        })
                      )}
                    </SpatialPresence>
                  }
                </section>
                <footer className="ai-correction-results-footer">
                  <span>已选择 {batch.length} 项</span>
                  <button
                    type="button"
                    className="ai-batch-action"
                    disabled={batch.length === 0}
                    onClick={() => onBatchAccept(batch)}
                  >
                    <CheckCheck size={14} aria-hidden="true" />
                    接受所选
                  </button>
                </footer>
              </div>
            ) : null}
          </SpatialPresence>
        }
      </SpatialView>
    </aside>
  );
}
