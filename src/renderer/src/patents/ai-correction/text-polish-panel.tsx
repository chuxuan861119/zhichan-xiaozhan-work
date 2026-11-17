import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Expand,
  Eye,
  FileText,
  History,
  Minimize2,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { mixedTextForDisplay } from "../../../../shared/ai-correction/mixed-content";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import { SpatialPresence } from "../../shared/spatial-presence";
import { SpatialPresetDisclosure } from "../../shared/spatial-preset-disclosure";
import { useRetainedTransientVisibility } from "../../shared/transient-function-rail-slot";
import { useSpatialViewMotion } from "../../shared/use-spatial-view-motion";
import { useSurfaceResizeMotion } from "../../shared/use-surface-resize-motion";
import "./text-polish-panel.css";
import type { AiCorrectionPhase } from "../../../../shared/ai-correction/contract";
import { textPolishCapacity } from "../../../../shared/ai-correction/text-polish-capacity";
import type {
  TextPolishConversationMessage,
  TextPolishConversationModel,
  TextPolishConversationSource,
  TextPolishConversationSummary,
  TextPolishInputDraft,
  TextPolishReplacementResult,
  TextPolishResult,
  TextPolishWorkspace,
} from "../../../../shared/ai-correction/text-polish-contract";
import { AiExperimentalNotice } from "../../shared/ai-experimental-notice";
import { DialogCloseIcon } from "../../shared/dialog-close-icon";
import { StandardDialog } from "../../shared/standard-dialog";
import { AiThinkingFeedback, useThinkingActivity } from "./ai-thinking-feedback";
import type { TextPolishSelectionState } from "./text-polish-anchor";
import { type HistoryAction, TextPolishHistory } from "./text-polish-history";
import type { TextPolishStatus } from "./use-text-polish";

const PHASE_LABELS: Record<AiCorrectionPhase, string> = {
  retrying: "未收到正式答案，正在重试（1/1）",
  preparing: "正在准备请求",
  connecting: "正在连接 AI 服务",
  thinking: "正在思考",
  structuring: "正在生成回答",
  summarizing: "正在整理较早对话",
};

const COMMON_REQUIREMENTS = [
  { label: "专业严谨", value: "表达更加专业、严谨，符合专利文书风格。" },
  { label: "精简表达", value: "在保持原意不变的前提下，使表达更加简洁。" },
  { label: "通顺流畅", value: "优化语序和衔接，使文字更加通顺流畅。" },
  { label: "统一术语", value: "统一术语和句式，使全文风格保持一致。" },
  { label: "消除歧义", value: "消除可能的歧义，使技术含义更加明确。" },
] as const;

const QUICK_REQUIREMENTS = ["专业严谨", "精简表达", "解释这段文字", "生成背景技术"];

const BOOK_LABELS = { claims: "权利要求书", description: "说明书", abstract: "说明书摘要" };

function combinedRequirement(text: string, selected: readonly string[]) {
  return [
    text.trim(),
    ...COMMON_REQUIREMENTS.filter((item) => selected.includes(item.label)).map(
      (item) => item.value,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

// Async actions keep writing to the patent/chat that initiated them, even after a switch.
function useScopedState<T>(key: string, initial: T) {
  const [values, setValues] = useState<Record<string, T>>({});
  const setValue = useCallback(
    (value: SetStateAction<T>) => {
      setValues((current) => ({
        ...current,
        [key]:
          typeof value === "function"
            ? (value as (previous: T) => T)(current[key] ?? initial)
            : value,
      }));
    },
    [key, initial],
  );
  return [values[key] ?? initial, setValue] as const;
}

export function TextPolishPanel({
  open,
  hidden = false,
  status,
  selection,
  result,
  error = null,
  modelConfigured = true,
  configuredModelName,
  configuredModel,
  onChangeModel,
  phase = null,
  summaryBatch = null,
  reasoning = "",
  reasoningTruncated = false,
  reasoningByTurn = {},
  conversationId = null,
  documentKey = "default",
  messages = [],
  source = null,
  model = null,
  summary = null,
  latestValidDraft = null,
  canRetry = false,
  inputDraft,
  onInputDraftChange,
  history = [],
  onOpenHistory,
  onRefreshHistory,
  onManageHistory,
  maxUploadCharacters = 50_000,
  historyLoading = false,
  storageError = null,
  onRecoverHistory,
  historyRecoveryAvailable = false,
  onStart,
  onSend,
  onRetry,
  onReset,
  onCancel,
  onClose,
  onOpenSettings,
  onApplyResult,
  onCopyText = async () => false,
}: {
  open: boolean;
  hidden?: boolean;
  status: TextPolishStatus;
  selection: TextPolishSelectionState;
  result: TextPolishResult | null;
  error?: string | null;
  modelConfigured?: boolean;
  configuredModelName?: string | undefined;
  configuredModel?: TextPolishConversationModel | null;
  onChangeModel?(model: TextPolishConversationModel): Promise<void>;
  phase?: AiCorrectionPhase | null;
  summaryBatch?: number | null;
  reasoning?: string;
  reasoningTruncated?: boolean;
  reasoningByTurn?: Record<string, { text: string; truncated: boolean }>;
  conversationId?: string | null;
  documentKey?: string;
  messages?: TextPolishConversationMessage[];
  source?: TextPolishConversationSource | null;
  model?: TextPolishConversationModel | null;
  summary?: TextPolishConversationSummary | null;
  latestValidDraft?: string | null;
  canRetry?: boolean;
  inputDraft?: TextPolishInputDraft;
  onInputDraftChange?(draft: TextPolishInputDraft): void;
  history?: TextPolishWorkspace["history"];
  onOpenHistory?(id: string): Promise<void>;
  onRefreshHistory?(): Promise<void>;
  onManageHistory?(
    action: HistoryAction | "continue-new",
    id: string,
    value?: string,
  ): Promise<void>;
  maxUploadCharacters?: number;
  historyLoading?: boolean;
  storageError?: string | null;
  onRecoverHistory?: (conversationId?: string) => Promise<void>;
  historyRecoveryAvailable?: boolean;
  onStart(requirement: string): void;
  onSend?(instruction: string, referenceText?: string): Promise<boolean>;
  onRetry?(): Promise<boolean>;
  onReset?(): Promise<void>;
  onCancel(): void;
  onClose(): void;
  onOpenSettings(): void;
  onApplyResult?(result: TextPolishReplacementResult): void;
  onCopyText?(text: string): boolean | Promise<boolean>;
}) {
  const visible = useRetainedTransientVisibility(open);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [localPresets, setPresets] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useSurfaceResizeMotion(panelRef, expanded, { anchored: true });
  const [historyVisible, setHistoryVisible] = useScopedState(documentKey, false);
  const [historyBusy, setHistoryBusy] = useScopedState(documentKey, false);
  const [historyError, setHistoryError] = useScopedState<string | null>(documentKey, null);
  useEffect(() => {
    if (!historyVisible || hidden || !open || !onRefreshHistory) return;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void onRefreshHistory()
        .catch((error) => setHistoryError(error instanceof Error ? error.message : "历史刷新失败"))
        .finally(() => {
          pending = false;
        });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [historyVisible, hidden, open, onRefreshHistory, setHistoryError]);
  const modelChanged = Boolean(
    conversationId &&
      model &&
      configuredModel &&
      (model.profileId !== configuredModel.profileId ||
        model.providerId !== configuredModel.providerId ||
        model.baseUrl !== configuredModel.baseUrl ||
        model.model !== configuredModel.model),
  );
  const modelBlocked = modelChanged || !modelConfigured;
  const draftRefs = useRef<Record<string, TextPolishInputDraft | undefined>>({});
  const [launchPreview, setLaunchPreview] = useState<string | null>(null);
  const [readers, setReaders] = useState<
    Record<string, { messageId: string | null; original: boolean } | undefined>
  >({});
  const launchKey = `launch:${documentKey}`;
  const conversationKey = `conversation:${conversationId ?? documentKey}`;
  const currentDraftKey = conversationId ? conversationKey : launchKey;
  const [inputError, setInputError] = useScopedState<string | null>(currentDraftKey, null);
  const [continuation, setContinuation] = useScopedState<string | null>(currentDraftKey, null);
  const [continuationBusy, setContinuationBusy] = useScopedState(currentDraftKey, false);
  const [continuationError, setContinuationError] = useScopedState<string | null>(
    currentDraftKey,
    null,
  );
  draftRefs.current[currentDraftKey] = inputDraft;
  const [localReferences, setLocalReferences] = useState<Record<string, string>>({});
  const referenceText = inputDraft?.referenceText ?? localReferences[conversationKey] ?? "";
  const setReferenceText = (text: string) => {
    if (text.length > 20_000) {
      setInputError("参考文字超过 20000 字符，未写入；已有内容已保留。");
      return;
    }
    setInputError(null);
    if (inputDraft && onInputDraftChange)
      onInputDraftChange({ ...inputDraft, referenceText: text });
    else setLocalReferences((current) => ({ ...current, [conversationKey]: text }));
  };
  const presets = inputDraft
    ? { ...localPresets, [currentDraftKey]: inputDraft.presets }
    : localPresets;
  const requirement = (!conversationId ? inputDraft?.text : undefined) ?? drafts[launchKey] ?? "";
  const conversationInstruction =
    (conversationId ? inputDraft?.text : undefined) ?? drafts[conversationKey] ?? "";
  const launchRequest = combinedRequirement(requirement, presets[launchKey] ?? []);
  const conversationRequest = combinedRequirement(
    conversationInstruction,
    presets[conversationKey] ?? [],
  );
  const reader = readers[conversationKey];
  const readerMessage = messages.find((message) => message.messageId === reader?.messageId);
  const displayText = (text: string) =>
    (source?.kind === "selection" && source.anchor.formatVersion === 2) ||
    (result && "anchor" in result && result.anchor.formatVersion === 2)
      ? mixedTextForDisplay(text)
      : text;
  const rawReaderText =
    reader?.original && source
      ? source.kind === "selection"
        ? source.anchor.originalText
        : source.requirement
      : readerMessage?.role === "assistant" && readerMessage.reply.kind === "revision"
        ? readerMessage.reply.revisedText
        : "";
  const readerText = displayText(rawReaderText);
  const fillPreset = (key: string, text: string) => {
    const previous = combinedRequirement(
      inputDraft?.text ?? drafts[key] ?? "",
      inputDraft?.presets ?? localPresets[key] ?? [],
    );
    if (previous.split("\n").includes(text)) return;
    text = [previous, text].filter(Boolean).join("\n");
    if (text.length > 2_000) {
      setInputError("本次内容超过 2000 字符，未写入；原草稿已保留，请精简或分段添加。");
      return;
    }
    setInputError(null);
    if (inputDraft && onInputDraftChange) {
      onInputDraftChange({ ...inputDraft, text, presets: [] });
    } else {
      setDrafts((current) => ({ ...current, [key]: text }));
      setPresets((current) => ({ ...current, [key]: [] }));
    }
  };
  const setRequirement = (value: string | ((current: string) => string)) => {
    const next = typeof value === "function" ? value(requirement) : value;
    if (next.length > 2_000) {
      setInputError("本次内容超过 2000 字符，未写入；原草稿已保留，请精简或分段粘贴。");
      return;
    }
    setInputError(null);
    if (inputDraft && onInputDraftChange) {
      onInputDraftChange({
        ...inputDraft,
        text: typeof value === "function" ? value(inputDraft.text) : value,
      });
      return;
    }
    setDrafts((current) => ({
      ...current,
      [launchKey]: typeof value === "function" ? value(current[launchKey] ?? "") : value,
    }));
  };
  const setConversationInstruction = (value: string | ((current: string) => string)) => {
    const next = typeof value === "function" ? value(conversationInstruction) : value;
    if (next.length > 2_000) {
      setInputError("本次内容超过 2000 字符，未写入；原草稿已保留，请精简或分段粘贴。");
      return;
    }
    setInputError(null);
    if (inputDraft && onInputDraftChange) {
      onInputDraftChange({
        ...inputDraft,
        text: typeof value === "function" ? value(inputDraft.text) : value,
      });
      return;
    }
    setDrafts((current) => ({
      ...current,
      [conversationKey]:
        typeof value === "function" ? value(current[conversationKey] ?? "") : value,
    }));
  };
  const [resetError, setResetError] = useState<{ key: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useScopedState(conversationKey, false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
  const [summaryExpanded, setSummaryExpanded] = useScopedState(conversationKey, false);
  const [hasNewReply, setHasNewReply] = useScopedState(conversationKey, false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const positions = useRef<
    Record<string, { top: number; follow: boolean; lastId: string | undefined }>
  >({});
  const scrollKey = `${conversationKey}:${reader ? `${reader.messageId}:${reader.original}` : "log"}`;
  useSpatialViewMotion(messagesRef, scrollKey);
  const restored = useRef(false);
  const observedMessages = useRef<Record<string, string | undefined>>({});
  const lastMessageId = messages.at(-1)?.messageId;
  const followMessages = useRef(true);
  const thinkingTaskKey = `${conversationKey}:${messages.filter((message) => message.role === "user").at(-1)?.turnId ?? "legacy"}`;
  const activity = useThinkingActivity(
    status === "running" || status === "preparing",
    thinkingTaskKey,
    phase,
    reasoning,
  );
  const liveTranscriptActivity =
    status === "running" ? `${phase ?? "preparing"}:${thinkingTaskKey}` : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: restore only on navigation; message arrivals use the separate effect below.
  useLayoutEffect(() => {
    if (!open || hidden) return;
    const element = messagesRef.current;
    if (!element) return;
    const saved = positions.current[scrollKey];
    element.scrollTop = saved?.top ?? 0;
    followMessages.current = saved?.follow ?? true;
    restored.current = Boolean(saved);
    setHasNewReply(Boolean(saved && saved.lastId !== lastMessageId));
  }, [scrollKey, open, hidden]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element || !open || hidden || reader || messages.length === 0) return;
    if (restored.current) {
      restored.current = false;
      observedMessages.current[conversationKey] = lastMessageId;
      return;
    }
    if (observedMessages.current[conversationKey] === lastMessageId) return;
    observedMessages.current[conversationKey] = lastMessageId;
    if (followMessages.current) {
      const latest = messages.at(-1);
      const target =
        latest?.role === "assistant"
          ? element.querySelector<HTMLElement>(`[data-message-id="${latest.messageId}"]`)
          : null;
      element.scrollTo?.({
        top: target ? target.offsetTop : element.scrollHeight,
        behavior: "auto",
      });
      setHasNewReply(false);
    } else {
      setHasNewReply(true);
    }
  }, [messages, open, hidden, reader, conversationKey, lastMessageId, setHasNewReply]);

  useEffect(() => {
    if (!liveTranscriptActivity || !open || hidden || reader) return;
    const element = messagesRef.current;
    if (!element || !followMessages.current) return;
    element.scrollTo?.({ top: element.scrollHeight, behavior: "auto" });
  }, [liveTranscriptActivity, open, hidden, reader]);

  if (!visible) return null;
  const conversationMode = Boolean(conversationId);
  const launchVisible =
    !conversationMode &&
    !historyVisible &&
    !historyLoading &&
    (status === "idle" || status === "preparing" || status === "failed" || status === "cancelled");
  const runningLabel =
    phase === "connecting" && model?.providerId !== "deepseek"
      ? "正在等待模型回复"
      : `${PHASE_LABELS[phase ?? "preparing"]}${phase === "summarizing" && summaryBatch ? ` · 第 ${summaryBatch} 批` : ""}`;
  const isGeneration = selection.status === "empty";

  const canStart =
    launchRequest.length <= 2_000 &&
    (selection.status === "ready" || (isGeneration && launchRequest.length > 0));
  const openReader = (messageId: string | null, original: boolean) => {
    const element = messagesRef.current;
    if (element)
      positions.current[scrollKey] = {
        top: element.scrollTop,
        follow: followMessages.current,
        lastId: lastMessageId,
      };
    setReaders((current) => ({ ...current, [conversationKey]: { messageId, original } }));
  };
  const submitConversationInstruction = async () => {
    const value = conversationRequest;
    if (
      !value ||
      value.length > 2_000 ||
      !onSend ||
      submitting ||
      status === "running" ||
      modelBlocked ||
      historyBusy
    )
      return;
    followMessages.current = true;
    setHasNewReply(false);
    setSubmitting(true);
    try {
      if (await (referenceText ? onSend(value, referenceText) : onSend(value))) {
        const latestDraft = draftRefs.current[conversationKey];
        if (
          inputDraft &&
          onInputDraftChange &&
          latestDraft?.text === inputDraft.text &&
          latestDraft.referenceText === inputDraft.referenceText &&
          JSON.stringify(latestDraft.presets) === JSON.stringify(inputDraft.presets)
        )
          onInputDraftChange({ text: "", presets: [] });
        setDrafts((current) =>
          current[conversationKey]?.trim() === conversationInstruction.trim()
            ? { ...current, [conversationKey]: "" }
            : current,
        );
        setPresets((current) => ({ ...current, [conversationKey]: [] }));
        setLocalReferences((current) =>
          current[conversationKey] === referenceText
            ? { ...current, [conversationKey]: "" }
            : current,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };
  const copyMessage = async (messageId: string, text: string) => {
    setCopiedMessageId(null);
    setCopyErrors((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
    try {
      if ((await onCopyText(displayText(text))) === false) throw new Error("复制失败");
      setCopiedMessageId(messageId);
    } catch {
      setCopyErrors((current) => ({ ...current, [messageId]: "复制失败，请稍后重试。" }));
    }
  };
  const latestDraft =
    latestValidDraft ??
    messages.reduce(
      (draft, message) =>
        message.role === "assistant" && message.reply.kind === "revision"
          ? message.reply.revisedText
          : draft,
      "",
    );
  const capacity = textPolishCapacity(
    source,
    messages,
    latestDraft,
    conversationRequest,
    maxUploadCharacters,
    referenceText,
  );

  return (
    <aside
      ref={panelRef}
      className={`assistant-side-panel ai-correction-panel text-polish-panel${expanded ? " is-expanded" : ""}`}
      aria-label="小栈AI助手"
      hidden={hidden}
      data-motion={open ? "enter" : "exit"}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
    >
      <header className="assistant-side-panel__header ai-correction-panel__header">
        <div className="assistant-side-panel__header-title">
          <span
            className="ai-kicker"
            title={model ? `本对话固定使用：${model.displayName}` : undefined}
          >
            {model?.displayName ?? configuredModelName ?? "智能辅助"}
          </span>
          <h2>小栈AI助手</h2>
          <AiExperimentalNotice feature="小栈AI助手" />
        </div>
        <div className="assistant-side-panel__header-actions">
          <button
            type="button"
            className="polish-icon-action"
            aria-label={expanded ? "收起小栈AI助手面板" : "展开小栈AI助手面板"}
            title={expanded ? "收起面板" : "展开面板"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={17} /> : <Expand size={17} />}
          </button>
          {onOpenHistory ? (
            <button
              type="button"
              className="polish-icon-action"
              aria-label="历史对话"
              title="历史对话"
              aria-expanded={historyVisible}
              disabled={historyBusy || historyLoading}
              onClick={async () => {
                if (historyVisible) {
                  setHistoryVisible(false);
                  return;
                }
                setHistoryBusy(true);
                setHistoryError(null);
                try {
                  await onRefreshHistory?.();
                  setHistoryVisible(true);
                } catch (error) {
                  setHistoryError(error instanceof Error ? error.message : "历史读取失败");
                } finally {
                  setHistoryBusy(false);
                }
              }}
            >
              <History size={17} />
            </button>
          ) : null}
          {onReset ? (
            <button
              type="button"
              className="polish-icon-action"
              aria-label="新对话"
              title="新对话"
              disabled={
                status === "preparing" ||
                (status === "running" && !conversationId) ||
                submitting ||
                historyBusy ||
                historyLoading
              }
              onClick={async () => {
                setHistoryBusy(true);
                try {
                  await onReset();
                  setHistoryVisible(false);
                  setResetError(null);
                } catch (error) {
                  setResetError({
                    key: conversationKey,
                    message: error instanceof Error ? error.message : "新建对话失败，请重试。",
                  });
                } finally {
                  setHistoryBusy(false);
                }
              }}
            >
              <SquarePen size={17} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="ai-icon-button"
            aria-label="小栈AI助手设置"
            title="小栈AI助手设置"
            onClick={onOpenSettings}
          >
            <Settings2 size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ai-icon-button dialog-close-button dialog-close-control"
            aria-label="关闭小栈AI助手"
            title="关闭小栈AI助手"
            onClick={onClose}
          >
            <DialogCloseIcon />
          </button>
        </div>
      </header>

      <SpatialPresence>
        {conversationId && modelBlocked ? (
          <div className="polish-storage-message" role="status">
            {configuredModel && modelChanged ? (
              <>
                <strong>模型配置已变化</strong>
                <p>
                  {model?.displayName}（{model?.model}） → {configuredModel.displayName}（
                  {configuredModel.model}）
                </p>
                <p>确认后保留历史、参考来源和草稿。后续发送将使用新配置，不会自动发送当前输入。</p>
                {configuredModel.providerId === "deepseek" ? (
                  <button
                    type="button"
                    disabled={
                      historyBusy ||
                      historyLoading ||
                      submitting ||
                      status === "preparing" ||
                      status === "running" ||
                      !onChangeModel
                    }
                    onClick={async () => {
                      if (!onChangeModel) return;
                      setHistoryBusy(true);
                      try {
                        await onChangeModel(configuredModel);
                        setHistoryError(null);
                      } catch (error) {
                        setHistoryError(
                          error instanceof Error ? error.message : "切换失败，原对话已保留。",
                        );
                      } finally {
                        setHistoryBusy(false);
                      }
                    }}
                  >
                    确认使用新配置继续
                  </button>
                ) : (
                  <p>目前仅支持 DeepSeek，请在模型设置中选择受支持的配置。</p>
                )}
              </>
            ) : (
              <p>尚未配置模型，历史和草稿仍保留。</p>
            )}
            <button type="button" onClick={onOpenSettings}>
              配置模型
            </button>
          </div>
        ) : null}
      </SpatialPresence>

      <SpatialPresence>
        {storageError || historyError ? (
          <p role="alert" className="ai-form-error polish-storage-message">
            {historyError ?? storageError}
            {storageError && historyRecoveryAvailable && onRecoverHistory ? (
              <button
                type="button"
                disabled={historyBusy || status === "preparing" || status === "running"}
                title="保留异常原文件并重试恢复，不删除历史对话"
                onClick={async () => {
                  setHistoryBusy(true);
                  try {
                    await onRecoverHistory();
                    setHistoryError(null);
                  } catch (error) {
                    setHistoryError(
                      error instanceof Error ? error.message : "恢复失败，请稍后重试。",
                    );
                  } finally {
                    setHistoryBusy(false);
                  }
                }}
              >
                保留异常文件并恢复
              </button>
            ) : null}
          </p>
        ) : null}
      </SpatialPresence>
      <SpatialPresence>
        {historyLoading ? (
          <p role="status" className="polish-storage-message">
            正在恢复历史对话与草稿…
          </p>
        ) : null}
      </SpatialPresence>
      <SpatialPresence>
        {history.some((item) => item.error) ? (
          <p role="status" className="polish-storage-message">
            部分历史对话无法读取，现有文件未作更改；其他对话和新对话仍可使用。
          </p>
        ) : null}
      </SpatialPresence>
      {historyVisible ? (
        <section
          className="polish-history assistant-side-panel__body spatial-view"
          aria-label="历史对话列表"
        >
          <div className="polish-history__heading">
            <h3>历史对话</h3>
            <button
              type="button"
              className="polish-icon-action"
              aria-label="返回当前对话"
              title="返回当前对话"
              onClick={() => setHistoryVisible(false)}
            >
              <ArrowLeft size={17} />
            </button>
          </div>
          <TextPolishHistory
            key={documentKey}
            items={history}
            currentId={conversationId}
            busy={
              historyBusy ||
              historyLoading ||
              submitting ||
              status === "preparing" ||
              (status === "running" && !conversationId)
            }
            onOpen={async (id) => {
              await onOpenHistory?.(id);
              setHistoryVisible(false);
            }}
            {...(onManageHistory ? { onManage: onManageHistory } : {})}
            {...(onRecoverHistory ? { onRecover: onRecoverHistory } : {})}
          />
          {status === "running" ? <p>切换对话不会停止正在进行的思考。</p> : null}
        </section>
      ) : null}
      {launchVisible ? (
        <div className="assistant-side-panel__body text-polish-launch spatial-view">
          {!modelConfigured ? (
            <div className="ai-model-required" role="status">
              <strong>尚未配置模型</strong>
              <span>
                请先
                <button type="button" onClick={onOpenSettings}>
                  配置模型
                </button>
                后再开始润色
              </span>
            </div>
          ) : null}
          <section className={`text-polish-selection polish-launch-source is-${selection.status}`}>
            {selection.status === "ready" ? (
              <>
                <span>选择文字：</span>
                <button
                  type="button"
                  className="polish-source-link polish-selection-status"
                  aria-label="预览选中文字"
                  title="预览选中文字"
                  aria-expanded={launchPreview === documentKey}
                  onClick={() =>
                    setLaunchPreview(launchPreview === documentKey ? null : documentKey)
                  }
                >
                  {BOOK_LABELS[selection.scope.bookKind]} · 已选中 {selection.characterCount} 字
                </button>
                <SpatialCollapse open={launchPreview === documentKey}>
                  <p className="polish-selection-preview">
                    {selection.scope.formatVersion === 2
                      ? "已选择混合内容，修改文字时保留公式、表格与列表结构。"
                      : selection.text}
                  </p>
                </SpatialCollapse>
              </>
            ) : selection.status === "invalid" ? (
              <>
                <strong>选区暂不可用</strong>
                <span>{selection.message}</span>
              </>
            ) : (
              <>
                <span>选择文字：</span>
                <span className="polish-selection-status">未选中文字</span>
              </>
            )}
          </section>
          <section className="polish-welcome" aria-label="新对话">
            <Sparkles size={27} strokeWidth={1.2} aria-hidden="true" />
            <h3>从一个想法，到一段好文字。</h3>
            <p>选中文字进行润色，或直接聊聊你的撰写需求。</p>
            <div className="polish-starters">
              {[
                ["整理背景技术", "请帮我整理背景技术"],
                ["解释技术内容", "请解释这段技术内容"],
                ["生成说明书摘要", "请帮我生成说明书摘要"],
              ].map(([label, prompt]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    fillPreset(launchKey, prompt ?? "");
                    document.getElementById("text-polish-requirement")?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
          <div className="text-polish-requirement">
            <div className="text-polish-requirement__heading">
              <label htmlFor="text-polish-requirement">
                {isGeneration ? "生成需求" : "润色需求"}
              </label>
              <span>{launchRequest.length}/2000</span>
            </div>
            <textarea
              id="text-polish-requirement"
              aria-label={isGeneration ? "生成需求" : "润色需求"}
              value={requirement}
              placeholder="描述你的想法..."
              onChange={(event) => setRequirement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                event.currentTarget
                  .closest(".text-polish-requirement")
                  ?.querySelector<HTMLButtonElement>(".polish-launch-actions button")
                  ?.click();
              }}
            />
            {inputError ? (
              <p role="alert" className="ai-form-error">
                {inputError}
              </p>
            ) : null}
            <SpatialPresetDisclosure
              className="polish-preset-disclosure polish-launch-presets"
              summary={
                <>
                  常用需求
                  <ChevronDown size={13} aria-hidden="true" />
                </>
              }
            >
              <fieldset className="text-polish-presets">
                <legend className="polish-sr-only">常用需求</legend>
                <div className="text-polish-presets__options">
                  {QUICK_REQUIREMENTS.map((label) => (
                    <button
                      key={label}
                      type="button"
                      title={label}
                      onClick={(event) => {
                        fillPreset(launchKey, label);
                        event.currentTarget
                          .closest(".text-polish-requirement")
                          ?.querySelector("textarea")
                          ?.focus();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
            </SpatialPresetDisclosure>
            <div className="polish-launch-actions">
              <button
                type="button"
                className="ai-primary-action"
                aria-label={
                  status === "preparing"
                    ? "正在保存并准备…"
                    : isGeneration
                      ? "开始生成"
                      : "开始润色"
                }
                title={
                  status === "preparing"
                    ? "正在保存并准备…"
                    : isGeneration
                      ? "开始生成"
                      : "开始润色"
                }
                disabled={
                  !modelConfigured ||
                  !canStart ||
                  status === "preparing" ||
                  historyLoading ||
                  historyBusy ||
                  Boolean(storageError)
                }
                onClick={() => onStart(launchRequest)}
              >
                <ArrowUp size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <SpatialPresence>
            {error ? (
              <p role="alert" className="ai-form-error">
                {error}
              </p>
            ) : null}
          </SpatialPresence>
          <SpatialPresence>
            {launchRequest.length > 2_000 ? (
              <p role="alert" className="ai-form-error">
                需求合计超过 2000 字符，请精简文字或取消部分常用需求。
              </p>
            ) : null}
          </SpatialPresence>
        </div>
      ) : null}

      {conversationMode && !historyVisible ? (
        <div className="assistant-side-panel__body text-polish-conversation spatial-view">
          <SpatialPresence>
            {resetError?.key === conversationKey ? (
              <p className="ai-form-error" role="alert">
                {resetError.message}
              </p>
            ) : null}
          </SpatialPresence>
          <div className="polish-conversation-meta">
            {model ? (
              <span title={`本对话固定使用：${model.displayName}`}>
                本对话固定使用：{model.displayName}
              </span>
            ) : (
              <span>连续润色</span>
            )}
            <span
              title="对话与输入草稿保存在本机，关闭专利或重启后可恢复。"
              className="polish-session-note"
            >
              本机保存
            </span>
          </div>
          {source && !reader ? (
            <section
              className="text-polish-selection text-polish-conversation__source"
              aria-label="本对话来源"
            >
              {source.kind === "selection" ? (
                <div className="text-polish-conversation__source-heading">
                  <div>
                    <strong>
                      {BOOK_LABELS[source.anchor.bookKind]} · {source.anchor.originalText.length}{" "}
                      字符 · {source.anchor.blocks.length} 段
                    </strong>
                    <span>参考首次选中文字；后续选区不会自动发送</span>
                  </div>
                  <button
                    type="button"
                    className="polish-icon-action"
                    aria-label="查看原文"
                    title="查看原文"
                    onClick={() => openReader(null, true)}
                  >
                    <Eye size={17} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <div className="text-polish-conversation__source-heading">
                  <strong className="polish-theme-preview">生成主题 · {source.requirement}</strong>
                  <button
                    type="button"
                    className="polish-icon-action"
                    aria-label="查看需求"
                    title="查看需求"
                    onClick={() => openReader(null, true)}
                  >
                    <FileText size={17} aria-hidden="true" />
                  </button>
                </div>
              )}
            </section>
          ) : null}
          <SpatialPresence>
            {reader ? (
              <div className="polish-reader-toolbar">
                <button
                  type="button"
                  className="polish-icon-action"
                  aria-label="返回对话"
                  title="返回对话"
                  onClick={() =>
                    setReaders((current) => ({ ...current, [conversationKey]: undefined }))
                  }
                >
                  <ArrowLeft size={17} aria-hidden="true" />
                </button>
                {source?.kind === "selection" && !reader.original ? (
                  <button
                    type="button"
                    className="polish-icon-action"
                    aria-label="查看原文"
                    title="查看原文"
                    onClick={() => openReader(reader.messageId, true)}
                  >
                    <Eye size={17} aria-hidden="true" />
                  </button>
                ) : null}
                {reader.original && reader.messageId ? (
                  <button
                    type="button"
                    className="polish-icon-action"
                    aria-label="查看润色稿"
                    title="查看润色稿"
                    onClick={() => openReader(reader.messageId, false)}
                  >
                    <FileText size={17} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </SpatialPresence>
          <div
            className="text-polish-conversation__messages"
            role="log"
            aria-label="连续对话记录"
            ref={messagesRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              followMessages.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 32;
              if (followMessages.current) setHasNewReply(false);
              if (open && !hidden)
                positions.current[scrollKey] = {
                  top: element.scrollTop,
                  follow: followMessages.current,
                  lastId: lastMessageId,
                };
            }}
          >
            {reader ? (
              <section className="polish-full-text" aria-label="完整文本">
                <h3>
                  {reader.original
                    ? source?.kind === "generation"
                      ? "生成需求"
                      : "原文"
                    : "润色稿"}
                </h3>
                <p>{readerText}</p>
              </section>
            ) : (
              messages.map((message) => (
                <article
                  key={message.messageId}
                  data-message-id={message.messageId}
                  className={`text-polish-conversation__message is-${message.role}`}
                >
                  {message.role === "assistant" && reasoningByTurn[message.turnId]?.text ? (
                    <details className="polish-completed-reasoning spatial-disclosure">
                      <summary>思考过程</summary>
                      <button
                        type="button"
                        className="polish-icon-action"
                        aria-label="复制思考过程"
                        title="复制思考过程"
                        onClick={() =>
                          void copyMessage(
                            `reasoning:${message.turnId}`,
                            reasoningByTurn[message.turnId]?.text ?? "",
                          )
                        }
                      >
                        <Copy size={14} />
                      </button>
                      {
                        <SpatialPresence>
                          {copiedMessageId === `reasoning:${message.turnId}` ? (
                            <small role="status">已复制思考过程</small>
                          ) : null}
                        </SpatialPresence>
                      }
                      {
                        <SpatialPresence>
                          {copyErrors[`reasoning:${message.turnId}`] ? (
                            <small role="alert">{copyErrors[`reasoning:${message.turnId}`]}</small>
                          ) : null}
                        </SpatialPresence>
                      }
                      {
                        <SpatialPresence>
                          {reasoningByTurn[message.turnId]?.truncated ? (
                            <small>已省略较早内容</small>
                          ) : null}
                        </SpatialPresence>
                      }
                      <pre>{reasoningByTurn[message.turnId]?.text}</pre>
                    </details>
                  ) : null}
                  <strong className="polish-sr-only">
                    {message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "系统"}
                  </strong>
                  {message.role === "user" ? (
                    <>
                      <p>{message.text}</p>
                      {message.referenceText ? (
                        <details className="spatial-disclosure">
                          <summary>参考文字 · {message.referenceText.length} 字符</summary>
                          <p>{message.referenceText}</p>
                        </details>
                      ) : null}
                    </>
                  ) : message.role === "assistant" ? (
                    <>
                      <p>{message.reply.message}</p>
                      {message.reply.kind === "revision" ? (
                        <section aria-label="润色稿">
                          <strong>润色稿</strong>
                          <p>{displayText(message.reply.revisedText)}</p>
                          {source?.kind === "selection" &&
                          source.anchor.formatVersion === 2 &&
                          onApplyResult ? (
                            <>
                              <details className="spatial-disclosure">
                                <summary>查看修改对比</summary>
                                <p>原文：{displayText(source.anchor.originalText)}</p>
                                <p>修改稿：{displayText(message.reply.revisedText)}</p>
                              </details>
                              <button
                                type="button"
                                disabled={status === "running"}
                                onClick={() => {
                                  if (message.reply.kind === "revision")
                                    onApplyResult({
                                      anchor: source.anchor,
                                      polishedText: message.reply.revisedText,
                                    });
                                }}
                              >
                                采纳文字修改
                              </button>
                            </>
                          ) : null}
                        </section>
                      ) : null}
                      <div className="text-polish-conversation__message-actions">
                        {message.reply.kind === "revision" ? (
                          <button
                            type="button"
                            className="polish-icon-action"
                            aria-label="查看完整润色稿"
                            title="查看完整润色稿"
                            onClick={() => openReader(message.messageId, false)}
                          >
                            <Expand size={17} aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="polish-icon-action"
                          aria-label={copiedMessageId === message.messageId ? "已复制" : "复制"}
                          title={copiedMessageId === message.messageId ? "已复制" : "复制"}
                          onClick={() => {
                            void copyMessage(
                              message.messageId,
                              message.reply.kind === "revision"
                                ? message.reply.revisedText
                                : message.reply.message,
                            );
                          }}
                        >
                          {copiedMessageId === message.messageId ? (
                            <Check size={17} aria-hidden="true" />
                          ) : (
                            <Copy size={17} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      {
                        <SpatialPresence>
                          {copyErrors[message.messageId] ? (
                            <p role="alert">{copyErrors[message.messageId]}</p>
                          ) : null}
                        </SpatialPresence>
                      }
                    </>
                  ) : (
                    <>
                      <p>{message.text}</p>
                      {summary && message.summaryId === summary.summaryId ? (
                        <button
                          type="button"
                          className="polish-icon-action"
                          aria-label={summaryExpanded ? "收起摘要" : "查看摘要"}
                          title={summaryExpanded ? "收起摘要" : "查看摘要"}
                          onClick={() => setSummaryExpanded((current) => !current)}
                        >
                          {summaryExpanded ? (
                            <ChevronUp size={17} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={17} aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                    </>
                  )}
                </article>
              ))
            )}
            {status === "running" && !reader ? (
              <AiThinkingFeedback
                key={`${thinkingTaskKey}:${activity.started}`}
                label={runningLabel}
                text={reasoning}
                truncated={reasoningTruncated}
                activity={activity}
                onCopy={onCopyText}
              />
            ) : null}
            {summary ? (
              <SpatialCollapse key={conversationKey} open={summaryExpanded}>
                <section aria-label="对话摘要">
                  {summary.items.map((item) => (
                    <article key={`${item.kind}:${item.sourceMessageIds.join(":")}`}>
                      <p>{item.text}</p>
                      <small>依据：{item.evidenceQuotes.join("；")}</small>
                    </article>
                  ))}
                </section>
              </SpatialCollapse>
            ) : null}
          </div>
          <SpatialPresence>
            {hasNewReply ? (
              <button
                type="button"
                className="ai-secondary-action"
                onClick={() => {
                  followMessages.current = true;
                  messagesRef.current?.scrollTo?.({
                    top:
                      messagesRef.current.querySelector<HTMLElement>(
                        `[data-message-id="${lastMessageId}"]`,
                      )?.offsetTop ?? 0,
                    behavior: "auto",
                  });
                  setHasNewReply(false);
                }}
              >
                有新回复
              </button>
            ) : null}
          </SpatialPresence>
          <fieldset className="polish-composer" aria-label="对话操作">
            <SpatialPresence>
              {error ? (
                <p role="alert" className="ai-form-error">
                  {error}
                </p>
              ) : null}
            </SpatialPresence>
            {
              <SpatialPresence>
                {status === "cancelled" ? (
                  <p role="status" className="text-polish-conversation__status">
                    本轮已停止。你可以重试本轮，或输入新的要求继续对话。
                  </p>
                ) : null}
              </SpatialPresence>
            }
            {!reader ? (
              <>
                {latestDraft && messages.length === 0 ? (
                  <details className="polish-carried-context spatial-disclosure">
                    <summary>已携带约定和最新稿 · 尚未发送</summary>
                    <pre>{displayText(latestDraft)}</pre>
                  </details>
                ) : null}
                <details className="polish-reference spatial-disclosure">
                  <summary>
                    参考文字{referenceText ? ` · ${referenceText.length}/20000` : "（可选）"}
                  </summary>
                  <p>仅发送主动添加的文字；不占用下方要求的字符额度。</p>
                  <textarea
                    aria-label="本轮参考文字"
                    rows={4}
                    value={referenceText}
                    onChange={(event) => setReferenceText(event.target.value)}
                    placeholder="粘贴参考文字，或添加当前选区"
                  />
                  {selection.status === "ready" ? (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() =>
                        setReferenceText(
                          [
                            referenceText,
                            selection.scope.formatVersion === 2
                              ? mixedTextForDisplay(selection.text)
                              : selection.text,
                          ]
                            .filter(Boolean)
                            .join("\n"),
                        )
                      }
                    >
                      添加选中文字
                    </button>
                  ) : null}
                  {referenceText ? (
                    <button
                      type="button"
                      className="polish-icon-action"
                      aria-label="移除参考文字"
                      title="移除参考文字"
                      onClick={() => setReferenceText("")}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                </details>
                <details
                  className="polish-capacity spatial-disclosure"
                  open={capacity.warning || undefined}
                >
                  <summary>{capacity.warning ? "对话接近容量边界" : "对话容量与参考材料"}</summary>
                  <p>
                    已进行 {capacity.turns}/100 轮；材料与要求估计{" "}
                    {capacity.estimatedCharacters.toLocaleString()} 字符，上传上限{" "}
                    {maxUploadCharacters.toLocaleString()}
                    。实际发送量受历史压缩影响，自动压缩不是无限续聊。
                  </p>
                  <p>
                    选区最多 20000 字符，每轮要求最多 2000 字符。重新选中文字不会自动加入本对话。
                  </p>
                  {onManageHistory && conversationId ? (
                    <button
                      type="button"
                      disabled={status === "running" || submitting || continuationBusy}
                      onClick={() => {
                        setContinuationError(null);
                        setContinuation(
                          [
                            ...(summary?.items.map((item) => item.text) ?? []),
                            ...messages
                              .slice(
                                summary?.coveredThroughMessageId
                                  ? messages.findIndex(
                                      (message) =>
                                        message.messageId === summary.coveredThroughMessageId,
                                    ) + 1
                                  : 0,
                              )
                              .filter((message) => message.role === "user")
                              .map((message) => message.text),
                          ].join("\n") ||
                            (source?.kind === "generation"
                              ? source.requirement
                              : "请填写后续需要保留的术语、约定与目标。"),
                        );
                      }}
                    >
                      携带约定开启新对话
                    </button>
                  ) : null}
                </details>
                <SpatialPresetDisclosure
                  className="polish-preset-disclosure"
                  summary={
                    <>
                      常用需求
                      <ChevronDown size={13} aria-hidden="true" />
                    </>
                  }
                >
                  <fieldset className="text-polish-presets">
                    <legend className="polish-sr-only">常用需求</legend>
                    <div className="text-polish-presets__options">
                      {QUICK_REQUIREMENTS.map((label) => (
                        <button
                          key={label}
                          type="button"
                          disabled={submitting}
                          title={label}
                          onClick={(event) => {
                            fillPreset(conversationKey, label);
                            event.currentTarget
                              .closest(".polish-composer")
                              ?.querySelector("textarea")
                              ?.focus();
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </SpatialPresetDisclosure>
                <textarea
                  aria-label="继续对话"
                  value={conversationInstruction}
                  disabled={submitting}
                  placeholder="描述你的想法..."
                  onChange={(event) => setConversationInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                      return;
                    if (status === "running") return;
                    event.preventDefault();
                    void submitConversationInstruction();
                  }}
                />
                <div className="polish-input-caption">
                  <small>{conversationRequest.length}/2000</small>
                  {status === "running" ? <small>可先写下一轮问题，完成后再发送</small> : null}
                </div>
                {inputError ? (
                  <p role="alert" className="ai-form-error">
                    {inputError}
                  </p>
                ) : null}
                <SpatialPresence>
                  {conversationRequest.length > 2_000 ? (
                    <p role="alert" className="ai-form-error">
                      需求合计超过 2000 字符，请精简文字或取消部分常用需求。
                    </p>
                  ) : null}
                </SpatialPresence>
              </>
            ) : null}
            <div className="text-polish-conversation__actions">
              {status === "running" ? (
                <button
                  type="button"
                  className="ai-stop-action"
                  aria-label="停止本轮"
                  title="停止思考"
                  onClick={onCancel}
                >
                  <Square size={15} aria-hidden="true" />
                </button>
              ) : !reader ? (
                <>
                  {
                    <SpatialPresence>
                      {(status === "failed" || status === "cancelled") && canRetry && onRetry ? (
                        <button
                          type="button"
                          className="ai-secondary-action"
                          aria-label="重试本轮"
                          title="重试本轮"
                          disabled={modelBlocked || historyBusy}
                          onClick={() => void onRetry()}
                        >
                          <RotateCcw size={17} aria-hidden="true" />
                        </button>
                      ) : null}
                    </SpatialPresence>
                  }
                  <button
                    type="button"
                    className="ai-primary-action"
                    aria-label={submitting ? "发送中" : "发送"}
                    title={submitting ? "发送中" : "发送"}
                    disabled={
                      !conversationRequest ||
                      conversationRequest.length > 2_000 ||
                      !onSend ||
                      modelBlocked ||
                      historyBusy ||
                      submitting
                    }
                    onClick={() => void submitConversationInstruction()}
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="polish-icon-action"
                  aria-label={
                    copiedMessageId === `reader:${reader.messageId}:${reader.original}`
                      ? "已复制"
                      : reader.original
                        ? source?.kind === "generation"
                          ? "复制需求"
                          : "复制原文"
                        : "复制润色稿"
                  }
                  title={
                    copiedMessageId === `reader:${reader.messageId}:${reader.original}`
                      ? "已复制"
                      : reader.original
                        ? source?.kind === "generation"
                          ? "复制需求"
                          : "复制原文"
                        : "复制润色稿"
                  }
                  onClick={() =>
                    void copyMessage(`reader:${reader.messageId}:${reader.original}`, readerText)
                  }
                >
                  {copiedMessageId === `reader:${reader.messageId}:${reader.original}` ? (
                    <Check size={17} aria-hidden="true" />
                  ) : (
                    <Copy size={17} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
            {
              <SpatialPresence>
                {reader && copyErrors[`reader:${reader.messageId}:${reader.original}`] ? (
                  <p role="alert">{copyErrors[`reader:${reader.messageId}:${reader.original}`]}</p>
                ) : null}
              </SpatialPresence>
            }
          </fieldset>
        </div>
      ) : null}

      {status === "running" && !conversationMode ? (
        <div className="assistant-side-panel__body ai-correction-running is-thinking">
          <AiThinkingFeedback
            key={`${thinkingTaskKey}:${activity.started}`}
            label={runningLabel}
            text={reasoning}
            truncated={reasoningTruncated}
            activity={activity}
            onCopy={onCopyText}
          />
          <button type="button" className="ai-stop-action" onClick={onCancel}>
            停止思考
          </button>
        </div>
      ) : null}

      {status === "completed" && result ? (
        <div className="assistant-side-panel__body text-polish-result">
          <div>
            <span>{"generatedText" in result ? "生成结果" : "润色结果"}</span>
            <pre>
              {displayText("generatedText" in result ? result.generatedText : result.polishedText)}
            </pre>
          </div>
          <SpatialPresence>
            {error || copyErrors.legacy ? (
              <p role="alert" className="ai-form-error">
                {error || copyErrors.legacy}
              </p>
            ) : null}
          </SpatialPresence>
          <footer>
            <button
              type="button"
              className="polish-icon-action"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <X size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="polish-icon-action"
              aria-label={
                copiedMessageId === "legacy"
                  ? "已复制"
                  : "generatedText" in result
                    ? "复制文案"
                    : "复制润色稿"
              }
              title={
                copiedMessageId === "legacy"
                  ? "已复制"
                  : "generatedText" in result
                    ? "复制文案"
                    : "复制润色稿"
              }
              onClick={() =>
                void copyMessage(
                  "legacy",
                  "generatedText" in result ? result.generatedText : result.polishedText,
                )
              }
            >
              {copiedMessageId === "legacy" ? (
                <Check size={17} aria-hidden="true" />
              ) : (
                <Copy size={17} aria-hidden="true" />
              )}
            </button>
          </footer>
        </div>
      ) : null}
      {continuation !== null && open && !hidden ? (
        <StandardDialog
          open
          title="衔接到新对话"
          size="m"
          portal
          closeDisabled={continuationBusy}
          onCancel={() => {
            if (!continuationBusy) setContinuation(null);
          }}
          footer={
            <>
              <button
                type="button"
                disabled={continuationBusy}
                onClick={() => setContinuation(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  continuationBusy ||
                  !continuation.trim() ||
                  continuation.length > 2000 ||
                  status === "running"
                }
                onClick={async () => {
                  if (!conversationId || !onManageHistory) return;
                  setContinuationBusy(true);
                  setContinuationError(null);
                  try {
                    await onManageHistory("continue-new", conversationId, continuation.trim());
                    setContinuation(null);
                  } catch (error) {
                    setContinuationError(
                      error instanceof Error ? error.message : "衔接失败，旧对话已保留。",
                    );
                  } finally {
                    setContinuationBusy(false);
                  }
                }}
              >
                {continuationBusy ? "正在创建…" : "确认并新建"}
              </button>
            </>
          }
        >
          <p>
            旧对话完整保留。新对话仅携带以下约定{latestDraft ? "及最新稿" : ""}
            ，不会携带完整原文、全部历史或思考过程，也不会立即请求 AI。
          </p>
          <label>
            请审阅并精简要保留的约定
            <textarea
              className="polish-continuation-input"
              aria-label="衔接约定"
              value={continuation}
              disabled={continuationBusy}
              onChange={(event) => setContinuation(event.target.value)}
            />
          </label>
          <p>
            {continuation.length}/2000{" "}
            {continuation.length > 2000 ? "请精简后再继续，内容未截断。" : ""}
          </p>
          {latestDraft ? (
            <details>
              <summary>将携带的最新稿（{latestDraft.length} 字符）</summary>
              <pre className="polish-carried-draft">{displayText(latestDraft)}</pre>
            </details>
          ) : null}
          {continuationError ? (
            <p role="alert" className="ai-form-error">
              {continuationError}
            </p>
          ) : null}
        </StandardDialog>
      ) : null}
    </aside>
  );
}
