import { createHash, randomUUID } from "node:crypto";
import type { AiCorrectionPhase } from "../../shared/ai-correction/contract.js";
import { mixedTextForDisplay } from "../../shared/ai-correction/mixed-content.js";
import type {
  AiCorrectionSettings,
  AiModelProfile,
  AiProviderId,
} from "../../shared/ai-correction/model.js";
import { AiModelProfileSchema, activeAiModel } from "../../shared/ai-correction/model.js";
import { textPolishHistoryCapacity } from "../../shared/ai-correction/text-polish-capacity.js";
import type {
  TextPolishConversationCancelRequest,
  TextPolishConversationEvent,
  TextPolishConversationMessage,
  TextPolishConversationModel,
  TextPolishConversationResetRequest,
  TextPolishConversationSendRequest,
  TextPolishConversationSnapshot,
  TextPolishConversationSnapshotRequest,
  TextPolishConversationSource,
  TextPolishConversationStartRequest,
  TextPolishConversationStartResult,
  TextPolishConversationSummary,
  TextPolishConversationTurnOutcome,
  TextPolishEvent,
  TextPolishStartRequest,
  TextPolishWorkspace,
  TextPolishWorkspaceRequest,
} from "../../shared/ai-correction/text-polish-contract.js";
import {
  TEXT_POLISH_MAX_TURN_COUNT,
  TextPolishConversationModelSchema,
  TextPolishConversationSnapshotSchema,
} from "../../shared/ai-correction/text-polish-contract.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { AiRequestError } from "./https-json-client.js";
import {
  ContextWindowExceededError,
  IncompatibleModelError,
  IncompleteModelOutputError,
} from "./openai-compatible-provider.js";
import { buildPatentPolishSelection } from "./patent-context-builder.js";
import { PatentCorrectionServiceError } from "./patent-correction-service.js";
import {
  buildTextPolishContext,
  estimateTextPolishContextCharacters,
  splitTextPolishSummaryMessages,
  TextPolishContextError,
  type TextPolishContextPackage,
  validateTextPolishConversationSummary,
} from "./text-polish-context.js";
import type { TextPolishHistoryStore } from "./text-polish-history-store.js";
import { DEFAULT_TEXT_POLISH_REQUIREMENT } from "./text-polish-prompt.js";

const MAX_POLISH_CHARACTERS = 20_000;
const THINKING_TIMEOUT_MS = 600_000;
const MAX_CONVERSATION_REQUEST_RECEIPTS = 256;

type ConversationRequestReceipt = {
  operation: "start" | "send";
  turnId: string;
};

type ConversationState = {
  historySaveFailed?: boolean;
  reasoningByTurn?: TextPolishConversationSnapshot["reasoningByTurn"];
  ownerToken: string;
  identity: {
    conversationId: string;
    patentId: string;
    sessionId: string;
    bookKind: TextPolishStartRequest["scope"]["bookKind"];
  };
  source: TextPolishConversationSource;
  model: TextPolishConversationModel;
  profileId: string;
  revision: number;
  messages: TextPolishConversationMessage[];
  latestValidDraft: string | null;
  summary: TextPolishConversationSummary | null;
  activeTurn: TextPolishConversationSnapshot["activeTurn"];
  lastTurnOutcome: TextPolishConversationTurnOutcome | null;
  controller: AbortController | null;
  requestResults: Map<string, ConversationRequestReceipt>;
};

function rememberRequest(
  conversation: ConversationState,
  clientRequestId: string,
  receipt: ConversationRequestReceipt,
): void {
  conversation.requestResults.set(clientRequestId, receipt);
  while (conversation.requestResults.size > MAX_CONVERSATION_REQUEST_RECEIPTS) {
    const oldest = conversation.requestResults.keys().next().value;
    if (oldest === undefined) return;
    conversation.requestResults.delete(oldest);
  }
}

function conversationKey(patentId: string, sessionId: string, _bookKind: string): string {
  return `${patentId}\u0000${sessionId}`;
}

function sameModel(model: TextPolishConversationModel, profile: AiModelProfile): boolean {
  return (
    model.profileId === profile.profileId &&
    model.providerId === profile.providerId &&
    model.baseUrl === profile.baseUrl &&
    model.model === profile.model
  );
}

function modelFromProfile(profile: AiModelProfile): TextPolishConversationModel {
  return TextPolishConversationModelSchema.parse({
    profileId: profile.profileId,
    providerId: profile.providerId,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    model: profile.model,
  });
}

type Provider = {
  polish(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    mode: "selection" | "generation";
    selectedText?: string;
    requirement: string;
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<string>;
  converseTextPolish?(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    source: TextPolishConversationSource;
    messages: readonly TextPolishConversationMessage[];
    summary: TextPolishConversationSummary | null;
    latestValidDraft: string | null;
    instruction: string;
    referenceText?: string;
    maxUploadCharacters?: number;
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<
    import("../../shared/ai-correction/text-polish-contract.js").TextPolishAssistantReply
  >;
  summarizeTextPolishConversation?(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    messages: readonly TextPolishConversationMessage[];
    coveredThroughMessageId: string | null;
    previousSummary?: TextPolishConversationSummary | null;
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<{
    coveredThroughMessageId: string | null;
    items: TextPolishConversationSummary["items"];
  }>;
};

type Vault = {
  hasApiKey(profileId: string): Promise<boolean>;
  withApiKey<T>(profileId: string, use: (apiKey: string) => Promise<T>): Promise<T>;
};

export class PatentPolishService {
  readonly #jobs = new Map<
    string,
    {
      sessionId: string;
      bookKind: TextPolishStartRequest["scope"]["bookKind"];
      controller: AbortController;
    }
  >();
  readonly #conversations = new Map<string, ConversationState>();
  // Viewing a different conversation must not dispose its background task.
  readonly #liveConversations = new Map<string, ConversationState>();

  constructor(
    private readonly dependencies: {
      history?: TextPolishHistoryStore;
      readSettings(): Promise<AiCorrectionSettings>;
      vault: Vault;
      patents: { requireActiveReadSession(sessionId: string, patentId: string): CanonicalPatent };
      provider: Provider;
      emit(event: TextPolishEvent | TextPolishConversationEvent, ownerToken?: string): void;
    },
  ) {}

  async workspace(
    ownerToken: string,
    request: TextPolishWorkspaceRequest,
  ): Promise<TextPolishWorkspace> {
    this.dependencies.patents.requireActiveReadSession(request.sessionId, request.patentId);
    const store = this.dependencies.history;
    if (!store) throw new Error("小栈AI助手历史保存尚未接入。");
    if (request.action !== "draft" && request.action !== "stop") {
      await store.waitForDraftWrites(request.patentId);
      this.dependencies.patents.requireActiveReadSession(request.sessionId, request.patentId);
    }
    let listedHistory =
      request.action === "draft" || request.action === "stop"
        ? []
        : await store.list(request.patentId);
    this.dependencies.patents.requireActiveReadSession(request.sessionId, request.patentId);
    const history = (): TextPolishWorkspace["history"] =>
      listedHistory.map((item) => {
        const live = this.#liveConversations.get(item.conversationId);
        return live
          ? {
              ...item,
              status: live.activeTurn ? "running" : (live.lastTurnOutcome?.status ?? "idle"),
            }
          : item;
      });
    const key = conversationKey(request.patentId, request.sessionId, "");
    let current = this.#conversations.get(key);
    const unavailableHistory: TextPolishWorkspace["history"] = [];
    if (current && current.ownerToken !== ownerToken)
      throw new PatentCorrectionServiceError("NOT_FOUND", "当前对话不属于此窗口。");
    if (["draft", "recover", "rename", "delete", "stop", "continue-new"].includes(request.action)) {
      // Recovery also touches the shared active pointer. Check ownership before
      // saving drafts or moving unreadable files, not only when opening afterwards.
      for (const live of this.#liveConversations.values()) {
        if (
          live.identity.patentId === request.patentId &&
          (request.action === "recover" ||
            live.identity.conversationId === request.conversationId) &&
          (live.ownerToken !== ownerToken || live.identity.sessionId !== request.sessionId)
        )
          throw new PatentCorrectionServiceError("NOT_FOUND", "当前对话不属于此窗口或专利。");
      }
    }
    if (["rename", "delete", "stop", "continue-new"].includes(request.action)) {
      const id = request.conversationId;
      if (!id) throw new Error("请选择对话。");
      const live = this.#liveConversations.get(id);
      if (
        live &&
        (live.ownerToken !== ownerToken ||
          live.identity.patentId !== request.patentId ||
          live.identity.sessionId !== request.sessionId)
      )
        throw new PatentCorrectionServiceError("NOT_FOUND", "当前对话不属于此窗口或专利。");
      const saved = live ? this.#snapshot(live) : store.snapshot(request.patentId, id);
      if (!saved) throw new Error("未找到历史对话。");
      // Prepare fallible response reads before changing persistent history.
      const responseDraft =
        request.action === "continue-new" || request.action === "stop"
          ? { text: "", presets: [] }
          : store.draft(
              request.patentId,
              request.action === "delete" && current?.identity.conversationId === id
                ? null
                : (current?.identity.conversationId ?? null),
            );
      if (request.action === "stop") {
        if (live?.activeTurn)
          this.cancelConversation(ownerToken, {
            identity: live.identity,
            turnId: live.activeTurn.turnId,
          });
      } else {
        if (live?.activeTurn)
          throw new PatentCorrectionServiceError("BUSY", "请先停止思考，再管理此对话。");
        if (request.action === "rename") {
          if (!request.title) throw new Error("请输入对话名称。");
          const title = request.title;
          store.rename(request.patentId, id, title);
          listedHistory = listedHistory.map((item) =>
            item.conversationId === id ? { ...item, title } : item,
          );
        } else if (request.action === "delete") {
          store.remove(request.patentId, id);
          this.#liveConversations.delete(id);
          if (current?.identity.conversationId === id) {
            this.#conversations.delete(key);
            current = undefined;
          }
          listedHistory = listedHistory.filter((item) => item.conversationId !== id);
        } else {
          if (
            !current ||
            current.identity.conversationId !== id ||
            current.revision !== request.expectedConversationRevision
          )
            throw new PatentCorrectionServiceError(
              "REVISION_CONFLICT",
              "对话状态已变化，请重新确认衔接内容。",
            );
          if (!request.continuation?.trim()) throw new Error("请填写需要携带的约定。");
          const next: ConversationState = {
            ownerToken,
            identity: { ...current.identity, conversationId: randomUUID() },
            source: {
              kind: "generation",
              requirement: request.continuation,
              bookKind: current.identity.bookKind,
            },
            model: current.model,
            profileId: current.profileId,
            revision: 0,
            messages: [],
            latestValidDraft:
              current.latestValidDraft &&
              current.source.kind === "selection" &&
              current.source.anchor.formatVersion === 2
                ? mixedTextForDisplay(current.latestValidDraft)
                : current.latestValidDraft,
            summary: null,
            activeTurn: null,
            lastTurnOutcome: null,
            controller: null,
            requestResults: new Map(),
          };
          this.#save(next);
          store.rename(request.patentId, next.identity.conversationId, "衔接对话");
          store.activate(request.patentId, next.identity.conversationId);
          this.#liveConversations.set(next.identity.conversationId, next);
          this.#conversations.set(key, next);
          current = next;
          listedHistory.unshift({
            conversationId: next.identity.conversationId,
            title: "衔接对话",
            updatedAt: new Date().toISOString(),
            status: "idle",
          });
        }
      }
      return {
        snapshot: current ? this.#snapshot(current) : null,
        draft: responseDraft,
        history: history(),
      };
    }
    if (request.action === "recover") {
      if (
        current?.activeTurn ||
        (request.conversationId && this.#liveConversations.get(request.conversationId)?.activeTurn)
      )
        throw new PatentCorrectionServiceError("BUSY", "请先停止思考，再恢复历史状态。");
      store.recoverState(
        request.patentId,
        request.conversationId ?? current?.identity.conversationId,
      );
    }
    if (request.action === "change-model") {
      const selected = current;
      if (!selected || selected.identity.conversationId !== request.conversationId)
        throw new PatentCorrectionServiceError("NOT_FOUND", "请先打开需要继续的历史对话。");
      if (selected.activeTurn)
        throw new PatentCorrectionServiceError("BUSY", "请先停止思考，再切换模型配置。");
      if (selected.revision !== request.expectedConversationRevision)
        throw new PatentCorrectionServiceError("REVISION_CONFLICT", "对话状态已更新，请重新确认。");
      const profile = activeAiModel(await this.dependencies.readSettings());
      if (!profile || !request.targetModel || !sameModel(request.targetModel, profile))
        throw new PatentCorrectionServiceError(
          "MODEL_CHANGED",
          "模型配置再次变化，请重新确认当前配置。",
        );
      if (profile.providerId !== "deepseek")
        throw new PatentCorrectionServiceError(
          "AI_PROVIDER_UNAVAILABLE",
          "当前仅支持切换到 DeepSeek 配置继续对话。",
        );
      if (!(await this.dependencies.vault.hasApiKey(profile.profileId)))
        throw new PatentCorrectionServiceError("AI_CREDENTIAL_UNAVAILABLE", "请先配置 API Key。");
      // Awaiting credentials/settings must not let a concurrent send or switch bypass the guard.
      const latest = activeAiModel(await this.dependencies.readSettings());
      if (
        current !== this.#conversations.get(key) ||
        selected.activeTurn ||
        selected.revision !== request.expectedConversationRevision
      )
        throw new PatentCorrectionServiceError("REVISION_CONFLICT", "对话状态已更新，请重新确认。");
      if (!latest || !sameModel(request.targetModel, latest))
        throw new PatentCorrectionServiceError(
          "MODEL_CHANGED",
          "模型配置再次变化，请重新确认当前配置。",
        );
      const previous = {
        model: selected.model,
        profileId: selected.profileId,
        revision: selected.revision,
      };
      // Prepare response data before committing the model, so a read failure cannot
      // leave the caller on an old revision after the model has already changed.
      const draft = store.draft(request.patentId, selected.identity.conversationId);
      const entries = history();
      selected.model = modelFromProfile(latest);
      selected.profileId = latest.profileId;
      selected.revision++;
      try {
        this.#save(selected);
      } catch (error) {
        Object.assign(selected, previous);
        throw error;
      }
      return { snapshot: this.#snapshot(selected), draft, history: entries };
    }
    if (request.action === "draft") {
      if (!request.draft) throw new Error("缺少输入草稿。");
      if (request.conversationId && !store.snapshot(request.patentId, request.conversationId))
        throw new Error("未找到草稿所属对话。");
      await store.saveDraftAsync(request.patentId, request.conversationId, request.draft);
      return { snapshot: null, draft: request.draft, history: [] };
    } else {
      let id =
        request.action === "open"
          ? request.conversationId
          : (current?.identity.conversationId ?? store.active(request.patentId));
      if (id !== current?.identity.conversationId) {
        if (current?.historySaveFailed) this.#save(current);
        const live = id ? this.#liveConversations.get(id) : undefined;
        if (
          live &&
          (live.ownerToken !== ownerToken ||
            live.identity.patentId !== request.patentId ||
            live.identity.sessionId !== request.sessionId)
        )
          throw new PatentCorrectionServiceError("NOT_FOUND", "当前对话不属于此窗口或专利。");
        let saved: TextPolishConversationSnapshot | null = null;
        if (id) {
          try {
            saved = live ? this.#snapshot(live) : store.snapshot(request.patentId, id);
          } catch (error) {
            if (request.action === "open") throw error;
            // Keep damaged records untouched; loading the workspace can still offer a new dialogue.
            id = null;
          }
        }
        if (id && !saved) {
          if (request.action === "open") throw new Error("未找到历史对话，原记录未作更改。");
          unavailableHistory.push({
            conversationId: id,
            title: "无法读取的历史对话",
            updatedAt: "",
            error: "上次活动对话的记录文件缺失，其他记录未作更改。",
          });
          id = null;
        }
        // Validate recoverable state before replacing the currently visible conversation.
        store.active(request.patentId);
        const draft = store.draft(request.patentId, id);
        const entries = [...history(), ...unavailableHistory];
        let next: ConversationState | undefined = live;
        if (saved && !live) {
          next = {
            ownerToken,
            identity: {
              conversationId: saved.conversationId,
              patentId: request.patentId,
              sessionId: request.sessionId,
              bookKind: saved.bookKind,
            },
            source: saved.source,
            model: saved.model,
            profileId: saved.model.profileId,
            revision: saved.conversationRevision + (saved.activeTurn ? 1 : 0),
            messages: saved.messages,
            latestValidDraft: saved.latestValidDraft,
            summary: saved.summary,
            activeTurn: null,
            lastTurnOutcome: saved.activeTurn
              ? { status: "cancelled", turnId: saved.activeTurn.turnId }
              : saved.lastTurnOutcome,
            reasoningByTurn: saved.reasoningByTurn,
            controller: null,
            requestResults: new Map(),
          };
        }
        const snapshot = next ? this.#snapshot(next) : null;
        // Commit the active pointer only after all response data is readable.
        // Failed reads/writes must leave both the renderer and main on the old conversation.
        store.activate(request.patentId, id);
        if (next) {
          this.#conversations.set(key, next);
          this.#liveConversations.set(next.identity.conversationId, next);
        } else this.#conversations.delete(key);
        return { snapshot, draft, history: entries };
      }
    }
    const activeId = current?.identity.conversationId ?? null;
    return {
      snapshot: current ? this.#snapshot(current) : null,
      draft: store.draft(request.patentId, activeId),
      history: [...history(), ...unavailableHistory],
    };
  }

  #save(conversation: ConversationState) {
    try {
      this.dependencies.history?.save(this.#snapshot(conversation));
      conversation.historySaveFailed = false;
    } catch (error) {
      conversation.historySaveFailed = true;
      throw error;
    }
  }

  #releaseConversation(conversation: ConversationState) {
    const turn = conversation.activeTurn;
    conversation.controller?.abort();
    if (turn) {
      conversation.activeTurn = null;
      conversation.lastTurnOutcome = { status: "cancelled", turnId: turn.turnId };
      conversation.revision += 1;
    }
    if (turn || conversation.historySaveFailed) this.#save(conversation);
  }

  async startConversation(
    ownerToken: string,
    request: TextPolishConversationStartRequest,
  ): Promise<TextPolishConversationStartResult> {
    const settings = await this.dependencies.readSettings();
    const profile = await this.#requireProfile(settings, null, true);
    const key = conversationKey(request.patentId, request.sessionId, request.scope.bookKind);
    // A delayed start acknowledgement may be retried after the user switches chats.
    const accepted = [...this.#liveConversations.values()].find(
      (item) =>
        item.ownerToken === ownerToken &&
        item.identity.patentId === request.patentId &&
        item.identity.sessionId === request.sessionId &&
        item.requestResults.get(request.clientRequestId)?.operation === "start",
    );
    const receipt = accepted?.requestResults.get(request.clientRequestId);
    if (accepted && receipt)
      return {
        conversationId: accepted.identity.conversationId,
        turnId: receipt.turnId,
        snapshot: this.#snapshot(accepted),
      };
    const existing = this.#conversations.get(key);
    if (existing) {
      if (existing.ownerToken !== ownerToken) {
        throw new PatentCorrectionServiceError("NOT_FOUND", "未找到当前专利书册的连续对话。\n");
      }
      const previous = existing.requestResults.get(request.clientRequestId);
      if (previous?.operation === "start") {
        return {
          conversationId: existing.identity.conversationId,
          turnId: previous.turnId,
          snapshot: structuredClone(this.#snapshot(existing)),
        };
      }
      throw new PatentCorrectionServiceError("CONVERSATION_EXISTS", "当前专利已经有连续对话。\n");
    }
    const patent = this.dependencies.patents.requireActiveReadSession(
      request.sessionId,
      request.patentId,
    );
    if (patent.revision !== request.expectedPatentRevision) {
      throw new PatentCorrectionServiceError(
        "REVISION_CONFLICT",
        "专利内容已变化，请重新选择后开始连续对话。",
      );
    }
    const instruction = request.instruction.trim() || DEFAULT_TEXT_POLISH_REQUIREMENT;
    const source: TextPolishConversationSource =
      request.scope.kind === "selection"
        ? (() => {
            const selection = buildPatentPolishSelection(
              patent,
              request.scope,
              Math.min(settings.maxUploadCharacters, MAX_POLISH_CHARACTERS),
            );
            return {
              kind: "selection",
              anchor: {
                bookKind: request.scope.bookKind,
                blocks: selection.blocks,
                ...(selection.formatVersion ? { formatVersion: selection.formatVersion } : {}),
                originalText: selection.text,
                originalTextHash: createHash("sha256").update(selection.text).digest("hex"),
              },
            };
          })()
        : { kind: "generation", requirement: instruction, bookKind: request.scope.bookKind };
    const conversation: ConversationState = {
      ownerToken,
      identity: {
        conversationId: randomUUID(),
        patentId: request.patentId,
        sessionId: request.sessionId,
        bookKind: request.scope.bookKind,
      },
      source,
      model: modelFromProfile(profile),
      profileId: profile.profileId,
      revision: 0,
      messages: [],
      latestValidDraft: null,
      summary: null,
      activeTurn: null,
      lastTurnOutcome: null,
      controller: null,
      requestResults: new Map(),
    };
    this.#conversations.set(key, conversation);
    this.#liveConversations.set(conversation.identity.conversationId, conversation);
    let turnId: string;
    try {
      turnId = this.#appendUserTurn(conversation, request.clientRequestId, instruction);
    } catch (error) {
      this.#conversations.delete(key);
      this.#liveConversations.delete(conversation.identity.conversationId);
      throw error;
    }
    const snapshot = this.#snapshot(conversation);
    const result = { conversationId: conversation.identity.conversationId, turnId, snapshot };
    rememberRequest(conversation, request.clientRequestId, { operation: "start", turnId });
    void this.#runConversationTurn(conversation, turnId, instruction);
    return structuredClone(result);
  }

  async sendConversation(
    ownerToken: string,
    request: TextPolishConversationSendRequest,
  ): Promise<{ snapshot: TextPolishConversationSnapshot }> {
    const conversation = this.#requireConversation(ownerToken, request.identity);
    const previous = conversation.requestResults.get(request.clientRequestId);
    if (previous?.operation === "send") {
      return { snapshot: structuredClone(this.#snapshot(conversation)) };
    }
    if (conversation.activeTurn) {
      throw new PatentCorrectionServiceError("BUSY", "当前对话仍在等待 AI 回复。请先停止本轮。\n");
    }
    if (conversation.revision !== request.expectedConversationRevision) {
      throw new PatentCorrectionServiceError(
        "REVISION_CONFLICT",
        "对话状态已更新，请刷新当前对话后重试。",
      );
    }
    let turnId: string;
    let instruction: string;
    if (
      !textPolishHistoryCapacity(
        conversation.messages,
        conversation.latestValidDraft ?? "",
        request.kind === "new" ? request.instruction + (request.referenceText ?? "") : "",
      ).canSend
    ) {
      throw new PatentCorrectionServiceError(
        "CONTEXT_CAPACITY_EXCEEDED",
        "对话历史容量不足以保存下一轮完整回复，请携带约定开启新对话。已有内容已保留。",
      );
    }
    if (request.kind === "new") {
      instruction = request.instruction.trim();
      const userTurns = conversation.messages.filter((message) => message.role === "user").length;
      if (userTurns >= TEXT_POLISH_MAX_TURN_COUNT) {
        throw new PatentCorrectionServiceError(
          "CONTEXT_CAPACITY_EXCEEDED",
          "对话已达到 100 轮上限，请新建对话。",
        );
      }
      turnId = randomUUID();
      this.#appendUserTurn(
        conversation,
        request.clientRequestId,
        instruction,
        turnId,
        request.referenceText,
      );
    } else {
      const userMessage = conversation.messages.find(
        (message): message is Extract<TextPolishConversationMessage, { role: "user" }> =>
          message.role === "user" && message.turnId === request.turnId,
      );
      if (
        !userMessage ||
        conversation.messages.some(
          (message) => message.role === "assistant" && message.turnId === request.turnId,
        )
      ) {
        throw new PatentCorrectionServiceError("INVALID_REQUEST", "只能重试未完成的对话轮次。\n");
      }
      turnId = request.turnId;
      instruction = userMessage.text;
      const previousReasoning = conversation.reasoningByTurn;
      const previousOutcome = conversation.lastTurnOutcome;
      conversation.reasoningByTurn = {
        ...conversation.reasoningByTurn,
        [turnId]: { text: "", truncated: false },
      };
      conversation.activeTurn = {
        turnId,
        clientRequestId: request.clientRequestId,
        instruction,
        status: "preparing",
      };
      conversation.lastTurnOutcome = null;
      conversation.revision += 1;
      try {
        this.#save(conversation);
      } catch (error) {
        conversation.reasoningByTurn = previousReasoning;
        conversation.activeTurn = null;
        conversation.lastTurnOutcome = previousOutcome;
        conversation.revision -= 1;
        throw error;
      }
    }
    const snapshot = this.#snapshot(conversation);
    const result = { snapshot };
    rememberRequest(conversation, request.clientRequestId, { operation: "send", turnId });
    void this.#runConversationTurn(conversation, turnId, instruction);
    return structuredClone(result);
  }

  cancelConversation(ownerToken: string, request: TextPolishConversationCancelRequest): boolean {
    const conversation = this.#requireConversation(ownerToken, request.identity);
    if (!conversation.activeTurn || conversation.activeTurn.turnId !== request.turnId) return false;
    conversation.controller?.abort();
    return true;
  }

  async resetConversation(
    ownerToken: string,
    request: TextPolishConversationResetRequest,
  ): Promise<{ snapshot: TextPolishConversationSnapshot }> {
    const conversation = this.#requireConversation(ownerToken, request.identity);
    const key = conversationKey(
      conversation.identity.patentId,
      conversation.identity.sessionId,
      "",
    );
    // New chat only changes the viewing pointer; streaming revisions need not match.
    if (this.#conversations.get(key) !== conversation) {
      throw new PatentCorrectionServiceError(
        "REVISION_CONFLICT",
        "对话状态已更新，请刷新后重试。\n",
      );
    }
    const snapshot = this.#snapshot(conversation);
    this.#save(conversation);
    this.dependencies.history?.activate(conversation.identity.patentId, null);
    this.#conversations.delete(
      conversationKey(
        conversation.identity.patentId,
        conversation.identity.sessionId,
        conversation.identity.bookKind,
      ),
    );
    return { snapshot };
  }

  async snapshotConversation(
    ownerToken: string,
    request: TextPolishConversationSnapshotRequest,
  ): Promise<TextPolishConversationSnapshot> {
    const conversation = request.conversationId
      ? this.#liveConversations.get(request.conversationId)
      : this.#conversations.get(
          conversationKey(request.patentId, request.sessionId, request.bookKind),
        );
    if (
      !conversation ||
      conversation.ownerToken !== ownerToken ||
      conversation.identity.patentId !== request.patentId ||
      conversation.identity.sessionId !== request.sessionId
    ) {
      throw new PatentCorrectionServiceError("NOT_FOUND", "未找到当前专利书册的连续对话。\n");
    }
    return this.#snapshot(conversation);
  }

  assertReadyForDataTransfer(): void {
    if (
      this.#jobs.size > 0 ||
      [...this.#liveConversations.values()].some((item) => item.activeTurn)
    ) {
      throw new PatentCorrectionServiceError(
        "BUSY",
        "小栈AI助手正在思考，请等待完成或停止思考后再迁移数据。",
      );
    }
    for (const conversation of this.#liveConversations.values()) {
      if (conversation.historySaveFailed) this.#save(conversation);
    }
  }

  releaseSession(sessionId: string, patentId?: string): void {
    for (const [id, conversation] of this.#liveConversations) {
      if (
        conversation.identity.sessionId === sessionId &&
        (!patentId || conversation.identity.patentId === patentId)
      ) {
        this.#releaseConversation(conversation);
        this.#liveConversations.delete(id);
        this.#conversations.delete(conversationKey(conversation.identity.patentId, sessionId, ""));
      }
    }
  }

  releaseOwner(ownerToken: string): void {
    for (const [id, conversation] of this.#liveConversations) {
      if (conversation.ownerToken === ownerToken) {
        try {
          this.#releaseConversation(conversation);
        } catch {
          console.warn("小栈AI助手关闭时保存失败，已保留上次成功保存的记录。");
        }
        this.#liveConversations.delete(id);
        this.#conversations.delete(
          conversationKey(conversation.identity.patentId, conversation.identity.sessionId, ""),
        );
      }
    }
  }

  #requireConversation(
    ownerToken: string,
    identity: TextPolishConversationSendRequest["identity"],
  ): ConversationState {
    const conversation = this.#liveConversations.get(identity.conversationId);
    if (
      !conversation ||
      conversation.ownerToken !== ownerToken ||
      conversation.identity.patentId !== identity.patentId ||
      conversation.identity.sessionId !== identity.sessionId ||
      conversation.identity.conversationId !== identity.conversationId
    ) {
      throw new PatentCorrectionServiceError("NOT_FOUND", "未找到当前专利书册的连续对话。\n");
    }
    return conversation;
  }

  async #requireProfile(
    settings: AiCorrectionSettings,
    conversation: ConversationState | null,
    starting: boolean,
  ): Promise<AiModelProfile> {
    const profile = conversation
      ? (settings.profiles.find((candidate) => candidate.profileId === conversation.profileId) ??
        null)
      : activeAiModel(settings);
    if (!profile || !AiModelProfileSchema.safeParse(profile).success) {
      throw new PatentCorrectionServiceError(
        starting ? "AI_DISABLED" : "MODEL_CHANGED",
        starting
          ? "请先选择用于小栈AI助手的模型。"
          : "当前模型配置已变化，请在面板确认使用新配置继续对话。",
      );
    }
    if (conversation && !sameModel(conversation.model, profile)) {
      throw new PatentCorrectionServiceError(
        "MODEL_CHANGED",
        "当前模型配置已变化，请在面板确认使用新配置继续对话。",
      );
    }
    if (
      profile.providerId !== "ollama" &&
      !(await this.dependencies.vault.hasApiKey(profile.profileId))
    ) {
      throw new PatentCorrectionServiceError("AI_CREDENTIAL_UNAVAILABLE", "请先配置 API Key。\n");
    }
    return profile;
  }

  #appendUserTurn(
    conversation: ConversationState,
    clientRequestId: string,
    instruction: string,
    requestedTurnId: string = randomUUID(),
    referenceText?: string,
  ): string {
    const message: TextPolishConversationMessage = {
      role: "user",
      messageId: randomUUID(),
      turnId: requestedTurnId,
      text: instruction,
      ...(referenceText ? { referenceText } : {}),
    };
    const previousMessages = conversation.messages;
    const previousActiveTurn = conversation.activeTurn;
    const previousLastTurnOutcome = conversation.lastTurnOutcome;
    conversation.messages = [...previousMessages, message];
    conversation.activeTurn = {
      turnId: requestedTurnId,
      clientRequestId,
      instruction,
      status: "preparing",
    };
    conversation.lastTurnOutcome = null;
    conversation.revision += 1;
    const store = this.dependencies.history;
    let previousActiveId: string | null = null;
    let activationChanged = false;
    try {
      this.#snapshot(conversation);
      if (
        store &&
        this.#conversations.get(
          conversationKey(conversation.identity.patentId, conversation.identity.sessionId, ""),
        ) === conversation
      ) {
        previousActiveId = store.active(conversation.identity.patentId);
        if (previousActiveId !== conversation.identity.conversationId) {
          // Fail before storing a running turn when the viewing pointer cannot be written.
          store.activate(conversation.identity.patentId, conversation.identity.conversationId);
          activationChanged = true;
        }
      }
      this.#save(conversation);
    } catch (error) {
      conversation.messages = previousMessages;
      conversation.activeTurn = previousActiveTurn;
      conversation.lastTurnOutcome = previousLastTurnOutcome;
      conversation.revision -= 1;
      if (activationChanged) {
        try {
          store?.activate(conversation.identity.patentId, previousActiveId);
        } catch {
          // No AI request has started. The missing-history recovery path handles this pointer.
          throw new Error(
            "新对话保存失败，活动记录未能恢复。请检查磁盘空间与目录权限后重新打开专利。",
            { cause: error },
          );
        }
      }
      if (error instanceof Error && /上限|超过/iu.test(error.message)) {
        throw new PatentCorrectionServiceError(
          "CONTEXT_CAPACITY_EXCEEDED",
          "对话内容已达到内存上限，请新建对话。\n",
        );
      }
      throw error;
    }
    this.#emitConversation({
      type: "message",
      conversationId: conversation.identity.conversationId,
      conversationRevision: conversation.revision,
      message,
    });
    return requestedTurnId;
  }

  #snapshot(conversation: ConversationState): TextPolishConversationSnapshot {
    return TextPolishConversationSnapshotSchema.parse({
      conversationId: conversation.identity.conversationId,
      patentId: conversation.identity.patentId,
      sessionId: conversation.identity.sessionId,
      bookKind: conversation.identity.bookKind,
      conversationRevision: conversation.revision,
      source: conversation.source,
      model: conversation.model,
      messages: conversation.messages,
      latestValidDraft: conversation.latestValidDraft,
      summary: conversation.summary,
      activeTurn: conversation.activeTurn,
      lastTurnOutcome: conversation.lastTurnOutcome,
      ...(conversation.reasoningByTurn ? { reasoningByTurn: conversation.reasoningByTurn } : {}),
    });
  }

  #emitConversation(event: TextPolishConversationEvent): void {
    const conversation = this.#liveConversations.get(event.conversationId);
    this.dependencies.emit(event, conversation?.ownerToken ?? "");
  }

  #emitPhase(
    conversation: ConversationState,
    turnId: string,
    phase: AiCorrectionPhase,
    summaryBatch?: number,
  ): void {
    if (!conversation.activeTurn || conversation.activeTurn.turnId !== turnId) return;
    const { summaryBatch: _previousBatch, ...activeTurn } = conversation.activeTurn;
    conversation.activeTurn = {
      ...activeTurn,
      ...(phase === "summarizing" && summaryBatch ? { summaryBatch } : {}),
      status:
        phase === "summarizing" ? "summarizing" : phase === "preparing" ? "preparing" : "running",
    };
    conversation.revision += 1;
    this.#emitConversation({
      type: "phase",
      conversationId: conversation.identity.conversationId,
      conversationRevision: conversation.revision,
      turnId,
      phase,
      ...(phase === "summarizing" && summaryBatch ? { summaryBatch } : {}),
    });
  }

  #emitReasoning(conversation: ConversationState, turnId: string, delta: string): void {
    if (!conversation.activeTurn || conversation.activeTurn.turnId !== turnId) return;
    const previous = conversation.reasoningByTurn?.[turnId];
    const combined = (previous?.text ?? "") + delta;
    conversation.reasoningByTurn = {
      ...conversation.reasoningByTurn,
      [turnId]: {
        text: combined.slice(-20_000),
        truncated: Boolean(previous?.truncated || combined.length > 20_000),
      },
    };
    this.#emitConversation({
      type: "reasoning",
      conversationId: conversation.identity.conversationId,
      conversationRevision: conversation.revision,
      turnId,
      delta,
    });
  }

  async #runConversationTurn(
    conversation: ConversationState,
    turnId: string,
    instruction: string,
  ): Promise<void> {
    const controller = new AbortController();
    conversation.controller = controller;
    try {
      this.#emitPhase(conversation, turnId, "preparing");
      const settings = await this.dependencies.readSettings();
      const profile = { ...(await this.#requireProfile(settings, conversation, false)) };
      // A turn may make several summary/retry requests. Keep its credential paired
      // with the same endpoint, never reread a replacement profile's key mid-turn.
      const apiKey = await this.#withConversationApiKey(profile, controller.signal, async (key) => {
        const current = (await this.dependencies.readSettings()).profiles.find(
          (candidate) => candidate.profileId === profile.profileId,
        );
        if (!current || !sameModel(profile, current)) {
          throw new PatentCorrectionServiceError(
            "MODEL_CHANGED",
            "当前模型配置已变化，请在面板确认使用新配置继续对话。",
          );
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        return key;
      });
      const provider = this.dependencies.provider;
      const converseTextPolish = provider.converseTextPolish;
      const summarizeTextPolishConversation = provider.summarizeTextPolishConversation;
      if (!converseTextPolish || !summarizeTextPolishConversation) {
        throw new PatentCorrectionServiceError(
          "AI_PROVIDER_UNAVAILABLE",
          "当前 AI 提供商暂不支持连续文字对话。\n",
        );
      }

      const currentUser = conversation.messages.find(
        (message) => message.role === "user" && message.turnId === turnId,
      );
      const referenceText = currentUser?.role === "user" ? currentUser.referenceText : undefined;
      let summaryBatch = 0;
      const runSummaryIfNeeded = async (overflowContext?: TextPolishContextPackage) => {
        let stagedSummary = conversation.summary;
        for (let pass = 0; pass <= TEXT_POLISH_MAX_TURN_COUNT; pass++) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const contextResult = buildTextPolishContext({
            source: conversation.source,
            messages: conversation.messages,
            summary: stagedSummary,
            latestValidDraft: conversation.latestValidDraft,
            instruction,
            ...(referenceText ? { referenceText } : {}),
            activeTurnId: turnId,
            maxUploadCharacters: settings.maxUploadCharacters,
            ...(overflowContext
              ? {
                  recentTurnCount: 1,
                  forceSummary: pass === 0,
                }
              : {}),
          });
          if (contextResult.kind === "ready") {
            if (
              overflowContext &&
              estimateTextPolishContextCharacters(contextResult.context) >=
                estimateTextPolishContextCharacters(overflowContext)
            ) {
              throw new PatentCorrectionServiceError(
                "CONTEXT_CAPACITY_EXCEEDED",
                "整理后仍无法缩小上下文，原对话已保留，请缩短任务或新建对话。",
              );
            }
            if (stagedSummary !== conversation.summary && stagedSummary) {
              const message: TextPolishConversationMessage = {
                role: "system",
                messageId: randomUUID(),
                code: "context-compacted",
                summaryId: stagedSummary.summaryId,
                text: "已整理较早的对话内容",
              };
              conversation.summary = stagedSummary;
              conversation.messages = [...conversation.messages, message];
              conversation.revision += 1;
              this.#emitConversation({
                type: "summary",
                conversationId: conversation.identity.conversationId,
                conversationRevision: conversation.revision,
                summary: stagedSummary,
                message,
              });
            }
            return contextResult.context;
          }
          if (contextResult.kind === "upload-limit-exceeded") {
            throw new PatentCorrectionServiceError(
              "CONTEXT_CAPACITY_EXCEEDED",
              contextResult.message,
            );
          }
          if (contextResult.kind === "capacity-failure") {
            throw new PatentCorrectionServiceError(
              "CONTEXT_CAPACITY_EXCEEDED",
              contextResult.message,
            );
          }
          let pending = contextResult.summaryMessages;
          while (pending.length) {
            if (controller.signal.aborted) throw controller.signal.reason;
            const summaryCharacters =
              stagedSummary?.items.reduce(
                (size, item) => size + item.text.length + item.evidenceQuotes.join("").length,
                0,
              ) ?? 0;
            const budget = Math.min(12_000, settings.maxUploadCharacters - summaryCharacters);
            if (budget < 2)
              throw new PatentCorrectionServiceError(
                "CONTEXT_CAPACITY_EXCEEDED",
                "现有摘要与本轮整理内容超过上传上限，原对话已保留。",
              );
            const [batch, ...remaining] = splitTextPolishSummaryMessages(pending, budget);
            if (!batch) break;
            summaryBatch++;
            this.#emitPhase(conversation, turnId, "summarizing", summaryBatch);
            pending = remaining.flat();
            const coveredThroughMessageId =
              batch.at(-1)?.messageId ?? contextResult.coveredThroughMessageId;
            const summaryOutput = await summarizeTextPolishConversation.call(provider, {
              providerId: profile.providerId,
              baseUrl: profile.baseUrl,
              model: profile.model,
              apiKey,
              timeoutMs: THINKING_TIMEOUT_MS,
              thinkingEnabled: true,
              signal: controller.signal,
              messages: batch,
              coveredThroughMessageId,
              previousSummary: stagedSummary,
              onPhase: () => this.#emitPhase(conversation, turnId, "summarizing", summaryBatch),
              onReasoningDelta: (delta) => this.#emitReasoning(conversation, turnId, delta),
            });
            if (controller.signal.aborted) throw controller.signal.reason;
            if (summaryOutput.coveredThroughMessageId !== coveredThroughMessageId) {
              throw new PatentCorrectionServiceError(
                "SUMMARY_FAILED",
                "AI 没有返回可验证的摘要范围。\n",
              );
            }
            const nextSummary: TextPolishConversationSummary = {
              summaryId: randomUUID(),
              coveredThroughMessageId: summaryOutput.coveredThroughMessageId,
              items: summaryOutput.items,
            };
            const allowedIds = new Set([
              ...batch.map((message) => message.messageId),
              ...(stagedSummary?.items.flatMap((item) => item.sourceMessageIds) ?? []),
            ]);
            if (
              nextSummary.items.some((item) =>
                item.sourceMessageIds.some((id) => !allowedIds.has(id)),
              )
            ) {
              throw new TextPolishContextError(
                "INVALID_SUMMARY",
                "AI 摘要引用超出本次整理范围，原摘要已保留，可重试。",
              );
            }
            stagedSummary = validateTextPolishConversationSummary(
              nextSummary,
              conversation.messages,
            );
          }
        }
        throw new PatentCorrectionServiceError(
          "CONTEXT_CAPACITY_EXCEEDED",
          "对话整理未能收敛，原摘要已保留，请新建对话。",
        );
      };

      let context = await runSummaryIfNeeded();
      let retriedAfterOverflow = false;
      let reply: import("../../shared/ai-correction/text-polish-contract.js").TextPolishAssistantReply;
      while (true) {
        try {
          this.#emitPhase(conversation, turnId, "connecting");
          if (controller.signal.aborted) throw controller.signal.reason;
          reply = await converseTextPolish.call(provider, {
            providerId: profile.providerId,
            baseUrl: profile.baseUrl,
            model: profile.model,
            apiKey,
            timeoutMs: THINKING_TIMEOUT_MS,
            thinkingEnabled: true,
            signal: controller.signal,
            source: context.source,
            messages: context.messages,
            summary: context.summary,
            latestValidDraft: context.latestValidDraft,
            instruction: context.instruction,
            ...(context.referenceText ? { referenceText: context.referenceText } : {}),
            maxUploadCharacters: settings.maxUploadCharacters,
            onPhase: (phase) => this.#emitPhase(conversation, turnId, phase),
            onReasoningDelta: (delta) => this.#emitReasoning(conversation, turnId, delta),
          });
          break;
        } catch (error) {
          if (!(error instanceof ContextWindowExceededError) || retriedAfterOverflow) throw error;
          retriedAfterOverflow = true;
          context = await runSummaryIfNeeded(context);
        }
      }
      if (conversation.controller !== controller) return;
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("cancelled");
      const assistantMessage: TextPolishConversationMessage = {
        role: "assistant",
        messageId: randomUUID(),
        turnId,
        reply,
      };
      const previousMessages = conversation.messages;
      const previousDraft = conversation.latestValidDraft;
      const previousActiveTurn = conversation.activeTurn;
      conversation.messages = [...previousMessages, assistantMessage];
      if (reply.kind === "revision") conversation.latestValidDraft = reply.revisedText;
      conversation.activeTurn = null;
      conversation.lastTurnOutcome = { status: "completed", turnId };
      conversation.controller = null;
      conversation.revision += 1;
      try {
        this.#snapshot(conversation);
      } catch (error) {
        conversation.messages = previousMessages;
        conversation.latestValidDraft = previousDraft;
        conversation.activeTurn = previousActiveTurn;
        conversation.lastTurnOutcome = null;
        conversation.controller = controller;
        conversation.revision -= 1;
        throw error;
      }
      this.#emitConversation({
        type: "message",
        conversationId: conversation.identity.conversationId,
        conversationRevision: conversation.revision,
        message: assistantMessage,
      });
      try {
        this.#save(conversation);
      } catch {
        throw new PatentCorrectionServiceError(
          "HISTORY_SAVE_FAILED",
          "回复已生成，但历史保存失败。请先复制保留内容，并检查磁盘空间与目录权限。",
        );
      }
    } catch (error) {
      if (this.#liveConversations.get(conversation.identity.conversationId) !== conversation)
        return;
      if (controller.signal.aborted) {
        conversation.activeTurn = null;
        conversation.lastTurnOutcome = { status: "cancelled", turnId };
        conversation.controller = null;
        conversation.revision += 1;
        this.#emitConversation({
          type: "turn-cancelled",
          conversationId: conversation.identity.conversationId,
          conversationRevision: conversation.revision,
          turnId,
        });
        return;
      }
      conversation.activeTurn = null;
      conversation.controller = null;
      conversation.revision += 1;
      const message =
        error instanceof TextPolishContextError ||
        error instanceof PatentCorrectionServiceError ||
        error instanceof AiRequestError ||
        error instanceof ContextWindowExceededError ||
        error instanceof IncompatibleModelError ||
        error instanceof IncompleteModelOutputError
          ? error.message.slice(0, 500)
          : "AI 回复失败，请重试或新建对话。";
      const retryable = !(
        error instanceof IncompatibleModelError ||
        error instanceof ContextWindowExceededError ||
        (error instanceof TextPolishContextError && error.code !== "INVALID_SUMMARY") ||
        (error instanceof PatentCorrectionServiceError &&
          [
            "MODEL_CHANGED",
            "CONTEXT_CAPACITY_EXCEEDED",
            "INVALID_REQUEST",
            "AI_PROVIDER_UNAVAILABLE",
            "HISTORY_SAVE_FAILED",
          ].includes(error.code))
      );
      conversation.lastTurnOutcome = { status: "failed", turnId, message, retryable };
      this.#emitConversation({
        type: "turn-failed",
        conversationId: conversation.identity.conversationId,
        conversationRevision: conversation.revision,
        turnId,
        message,
        retryable,
      });
    } finally {
      if (conversation.controller === controller) conversation.controller = null;
      if (
        this.dependencies.history &&
        conversation.lastTurnOutcome?.status !== "completed" &&
        this.#liveConversations.get(conversation.identity.conversationId) === conversation
      ) {
        try {
          this.#save(conversation);
        } catch {
          conversation.revision += 1;
          const message = "对话保存失败，请先复制保留内容，并检查磁盘空间与目录权限。";
          conversation.lastTurnOutcome = { status: "failed", turnId, message, retryable: false };
          this.#emitConversation({
            type: "turn-failed",
            conversationId: conversation.identity.conversationId,
            conversationRevision: conversation.revision,
            turnId,
            message,
            retryable: false,
          });
        }
      }
    }
  }

  async #withConversationApiKey<T>(
    profile: AiModelProfile,
    signal: AbortSignal,
    use: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw signal.reason;
    return profile.providerId === "ollama"
      ? await use("ollama")
      : await this.dependencies.vault.withApiKey(profile.profileId, use);
  }

  async start(request: TextPolishStartRequest): Promise<{ jobId: string }> {
    const settings = await this.dependencies.readSettings();
    const profile = activeAiModel(settings);
    if (!profile) {
      throw new PatentCorrectionServiceError("AI_DISABLED", "请先选择用于小栈AI助手的模型。");
    }
    if (
      profile.providerId !== "ollama" &&
      !(await this.dependencies.vault.hasApiKey(profile.profileId))
    ) {
      throw new PatentCorrectionServiceError("AI_CREDENTIAL_UNAVAILABLE", "请先配置 API Key。");
    }
    if (
      [...this.#jobs.values()].some(
        (job) => job.sessionId === request.sessionId && job.bookKind === request.scope.bookKind,
      )
    ) {
      throw new PatentCorrectionServiceError("BUSY", "当前文档已有小栈AI助手任务运行中。");
    }
    const patent = this.dependencies.patents.requireActiveReadSession(
      request.sessionId,
      request.patentId,
    );
    if (patent.revision !== request.expectedRevision) {
      throw new PatentCorrectionServiceError(
        "REVISION_CONFLICT",
        "专利内容已变化，请重新选择后润色。",
      );
    }
    const selection =
      request.scope.kind === "selection"
        ? buildPatentPolishSelection(
            patent,
            request.scope,
            Math.min(settings.maxUploadCharacters, MAX_POLISH_CHARACTERS),
          )
        : null;
    if (this.#jobs.has(request.jobId)) {
      throw new PatentCorrectionServiceError("BUSY", "该小栈AI助手任务已在运行中。");
    }
    const controller = new AbortController();
    this.#jobs.set(request.jobId, {
      sessionId: request.sessionId,
      bookKind: request.scope.bookKind,
      controller,
    });
    this.dependencies.emit({ type: "started", jobId: request.jobId });
    void this.#run({ request, profile, selection, controller });
    return { jobId: request.jobId };
  }

  cancel(jobId: string): boolean {
    const job = this.#jobs.get(jobId);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  async #run(input: {
    request: TextPolishStartRequest;
    profile: AiModelProfile;
    selection: ReturnType<typeof buildPatentPolishSelection> | null;
    controller: AbortController;
  }): Promise<void> {
    const { jobId } = input.request;
    try {
      this.dependencies.emit({ type: "phase", jobId, phase: "preparing" });
      let lastPhase: AiCorrectionPhase | null = null;
      const emitPhase = (phase: AiCorrectionPhase) => {
        if (phase === lastPhase) return;
        lastPhase = phase;
        this.dependencies.emit({ type: "phase", jobId, phase });
      };
      const polish = async (apiKey: string) => {
        emitPhase("connecting");
        return await this.dependencies.provider.polish({
          providerId: input.profile.providerId,
          baseUrl: input.profile.baseUrl,
          model: input.profile.model,
          apiKey,
          timeoutMs: THINKING_TIMEOUT_MS,
          thinkingEnabled: true,
          signal: input.controller.signal,
          mode: input.request.scope.kind,
          ...(input.selection ? { selectedText: input.selection.text } : {}),
          requirement: input.request.requirement,
          onPhase: emitPhase,
          onReasoningDelta: (delta) => this.dependencies.emit({ type: "reasoning", jobId, delta }),
        });
      };
      const polishedText =
        input.profile.providerId === "ollama"
          ? await polish("ollama")
          : await this.dependencies.vault.withApiKey(input.profile.profileId, polish);
      if (input.controller.signal.aborted) {
        this.dependencies.emit({ type: "cancelled", jobId });
        return;
      }
      emitPhase("structuring");
      if (input.request.scope.kind === "selection" && !input.selection) {
        throw new Error("小栈AI助手选区未准备完成。");
      }
      const result =
        input.request.scope.kind === "generation"
          ? { kind: "generated" as const, generatedText: polishedText }
          : (() => {
              const selection = input.selection;
              if (!selection) throw new Error("小栈AI助手选区未准备完成。");
              return {
                anchor: {
                  bookKind: input.request.scope.bookKind,
                  blocks: selection.blocks,
                  ...(selection.formatVersion ? { formatVersion: selection.formatVersion } : {}),
                  originalText: selection.text,
                  originalTextHash: createHash("sha256").update(selection.text).digest("hex"),
                },
                polishedText,
              };
            })();
      this.dependencies.emit({
        type: "polish-completed",
        jobId,
        result,
      });
    } catch (error) {
      this.dependencies.emit(
        input.controller.signal.aborted
          ? { type: "cancelled", jobId }
          : {
              type: "failed",
              jobId,
              message: error instanceof Error ? error.message.slice(0, 500) : "小栈AI助手失败。",
            },
      );
    } finally {
      const current = this.#jobs.get(jobId);
      if (current?.controller === input.controller) this.#jobs.delete(jobId);
    }
  }
}
