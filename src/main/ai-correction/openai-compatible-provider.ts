import { z } from "zod";
import {
  AI_CORRECTION_ISSUE_LIMIT,
  type AiCorrectionPhase,
} from "../../shared/ai-correction/contract.js";
import type { AiProviderId } from "../../shared/ai-correction/model.js";
import {
  TEXT_POLISH_MAX_SUMMARY_CHARACTERS,
  type TextPolishAssistantReply,
  TextPolishAssistantReplySchema,
  type TextPolishConversationMessage,
  type TextPolishConversationSource,
  type TextPolishConversationSummary,
  TextPolishRevisionReplySchema,
  TextPolishSummaryItemSchema,
} from "../../shared/ai-correction/text-polish-contract.js";
import { countUnicodeCharacters } from "../../shared/patent/text.js";
import { AiRequestError } from "./https-json-client.js";
import type { PostSse } from "./https-sse-client.js";
import {
  buildCorrectionMessages,
  type CorrectionPromptScopeKind,
  type ProviderSegment,
} from "./prompt.js";
import { locateExactQuote } from "./quote-locator.js";
import {
  type CorrectionResponseDiagnostic,
  diagnosticFinishReason,
} from "./response-diagnostic.js";
import {
  buildTextGenerationMessages,
  buildTextPolishConversationMessages,
  buildTextPolishMessages,
  buildTextPolishSummaryMessages,
} from "./text-polish-prompt.js";

const DEEPSEEK_MAX_OUTPUT_TOKENS = 32_768;

const ProviderIssueSchema = z
  .object({
    segmentId: z.string().min(1).max(128),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    originalText: z.string().min(1).max(4_000),
    category: z.enum([
      "spelling",
      "grammar",
      "punctuation",
      "terminology",
      "compliance",
      "consistency",
    ]),
    risk: z.enum(["low", "medium", "high"]),
    applicability: z.enum(["replace", "analysis-only"]),
    replacement: z.string().min(1).max(4_000).nullable(),
    explanation: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((issue, context) => {
    if (
      issue.category === "consistency" &&
      (issue.risk !== "high" || issue.applicability !== "analysis-only")
    ) {
      context.addIssue({
        code: "custom",
        message: "内容一致性问题只能作为高风险分析项。",
        path: ["applicability"],
      });
    }
    if (issue.endOffset <= issue.startOffset) {
      context.addIssue({ code: "custom", message: "无效偏移。", path: ["endOffset"] });
    }
    if (issue.risk === "high" && issue.applicability !== "analysis-only") {
      context.addIssue({ code: "custom", message: "高风险项不可替换。", path: ["applicability"] });
    }
    if (issue.category === "compliance" && issue.applicability !== "analysis-only") {
      context.addIssue({ code: "custom", message: "规范项不可替换。", path: ["applicability"] });
    }
    if ((issue.applicability === "analysis-only") !== (issue.replacement === null)) {
      context.addIssue({
        code: "custom",
        message: "替换类型与文本不匹配。",
        path: ["replacement"],
      });
    }
  });

// Provider quotes are translated to the existing internal offset contract after exact matching.
const ProviderQuotedIssueSchema = z
  .object({
    ...ProviderIssueSchema.shape,
    contextBefore: z.string().max(64).optional(),
    contextAfter: z.string().max(64).optional(),
    evidence: z
      .array(
        z
          .object({
            segmentId: z.string().min(1).max(128),
            originalText: z.string().min(1).max(120),
          })
          .strict(),
      )
      .length(2)
      .optional(),
  })
  .omit({ startOffset: true, endOffset: true })
  .strict();
const ProviderOutputEnvelopeSchema = z.object({ issues: z.array(z.unknown()) }).strict();
const TextPolishOutputSchema = z.object({ polishedText: z.string().min(1).max(20_000) }).strict();
const TextGenerationOutputSchema = z
  .object({ generatedText: z.string().min(1).max(20_000) })
  .strict();
const ConversationRevisionOutputSchema = TextPolishRevisionReplySchema.extend({
  deliverableType: z.enum(["patent-abstract", "other"]),
});
type ConversationOutput = {
  reply: TextPolishAssistantReply;
  deliverableType: "patent-abstract" | "other" | null;
};
const TextPolishSummaryOutputSchema = z
  .object({
    coveredThroughMessageId: z.uuid().nullable(),
    items: z.array(TextPolishSummaryItemSchema).max(100),
  })
  .strict()
  .superRefine((summary, context) => {
    const text = summary.items.flatMap((item) => [item.text, ...item.evidenceQuotes]).join("");
    if (text.length > TEXT_POLISH_MAX_SUMMARY_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: "摘要内容超过上限。",
        path: ["items"],
      });
    }
  });
const OpenAiResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullable().optional(),
            message: z.object({ content: z.string().nullable() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const OpenAiStreamDeltaSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                reasoning_content: z.string().nullable().optional(),
                content: z.string().nullable().optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type ProviderIssue = z.infer<typeof ProviderIssueSchema>;
export type ProviderCorrectionResult = Readonly<{
  issues: ProviderIssue[];
  rejectedIssueCount: number;
  resultLimitReached: boolean;
}>;

type ProviderOperation = "纠错" | "润色" | "生成" | "连续对话" | "会话摘要";

export class IncompatibleModelError extends Error {
  readonly code = "INCOMPATIBLE_MODEL" as const;
  constructor(operation: ProviderOperation = "纠错") {
    super(`当前模型不兼容结构化${operation}结果。`);
    this.name = "IncompatibleModelError";
  }
}

export class IncompleteModelOutputError extends Error {
  readonly code = "INCOMPLETE_MODEL_OUTPUT" as const;
  constructor(operation: ProviderOperation = "纠错") {
    super(`AI 输出达到长度上限，未能生成完整${operation}结果，请缩小检查范围后重试。`);
    this.name = "IncompleteModelOutputError";
  }
}

export class ContextWindowExceededError extends Error {
  readonly code = "CONTEXT_WINDOW_EXCEEDED" as const;
  constructor() {
    super("AI 会话上下文已达到模型上限，请整理较早对话后重试。");
    this.name = "ContextWindowExceededError";
  }
}

export type PostJson = (
  url: URL,
  request: {
    authorization: string;
    timeoutMs: number;
    signal: AbortSignal;
    body: Record<string, unknown>;
  },
) => Promise<unknown>;

function parseProviderOutput(
  content: string,
  segments: readonly ProviderSegment[],
): ProviderCorrectionResult {
  if (!content.trim())
    throw new AiRequestError("AI 本次未返回纠错结果，请重试；这不代表模型不兼容。");
  try {
    const raw = ProviderOutputEnvelopeSchema.parse(JSON.parse(content)).issues;
    const issues: ProviderIssue[] = [];
    let rejectedIssueCount = 0;
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment.text]));
    for (const candidate of raw) {
      if (issues.length >= AI_CORRECTION_ISSUE_LIMIT) {
        rejectedIssueCount += 1;
        continue;
      }
      const quoted = ProviderQuotedIssueSchema.safeParse(candidate);
      if (!quoted.success) {
        rejectedIssueCount += 1;
        continue;
      }
      const { contextBefore, contextAfter, evidence, ...issue } = quoted.data;
      const text = byId.get(issue.segmentId);
      const range = text === undefined ? null : locateExactQuote(text, quoted.data);
      if (!range) {
        rejectedIssueCount += 1;
        continue;
      }
      if (issue.category === "consistency") {
        const locatedEvidence = evidence?.map((item) => {
          const source = byId.get(item.segmentId);
          const location = source === undefined ? null : locateExactQuote(source, item);
          return location && { ...location, segmentId: item.segmentId };
        });
        const [first, second] = locatedEvidence ?? [];
        if (
          !first ||
          !second ||
          (first.segmentId === second.segmentId &&
            first.startOffset < second.endOffset &&
            second.startOffset < first.endOffset) ||
          !locatedEvidence?.some(
            (item) =>
              item?.segmentId === issue.segmentId &&
              item.startOffset <= range.startOffset &&
              item.endOffset >= range.endOffset,
          ) ||
          !evidence
        ) {
          rejectedIssueCount += 1;
          continue;
        }
        issue.explanation = `${issue.explanation.slice(0, 700)} 原文证据：${evidence.map((item) => `“${item.originalText}”`).join("；")}。`;
      } else if (evidence) {
        rejectedIssueCount += 1;
        continue;
      }
      const parsed = ProviderIssueSchema.safeParse({ ...issue, ...range });
      if (parsed.success) issues.push(parsed.data);
      else rejectedIssueCount += 1;
    }
    return {
      issues,
      rejectedIssueCount,
      resultLimitReached: raw.length >= AI_CORRECTION_ISSUE_LIMIT,
    };
  } catch {
    throw new AiRequestError("本次纠错结果格式不正确，未应用任何修改，请重试。");
  }
}

function parseTextPolishOutput(content: string): string {
  if (!content.trim()) throw new AiRequestError("AI 本轮未返回润色内容，请重试本轮。");
  try {
    if (!content || content.trimStart().startsWith("```")) throw new IncompatibleModelError("润色");
    return TextPolishOutputSchema.parse(JSON.parse(content)).polishedText;
  } catch (error) {
    if (error instanceof IncompatibleModelError) throw error;
    throw new IncompatibleModelError("润色");
  }
}

function parseTextGenerationOutput(content: string): string {
  if (!content.trim()) throw new AiRequestError("AI 本轮未返回生成内容，请重试。");
  try {
    if (!content || content.trimStart().startsWith("```")) throw new IncompatibleModelError("生成");
    return TextGenerationOutputSchema.parse(JSON.parse(content)).generatedText;
  } catch (error) {
    if (error instanceof IncompatibleModelError) throw error;
    throw new IncompatibleModelError("生成");
  }
}

function parseConversationOutput(content: string): ConversationOutput {
  if (!content.trim()) throw new AiRequestError("AI 本轮未返回内容，当前对话已保留，请重试本轮。");
  try {
    if (!content || content.trimStart().startsWith("```")) {
      throw new IncompatibleModelError("连续对话");
    }
    const raw = JSON.parse(content);
    if (
      (typeof raw?.message === "string" && raw.message.trim().length > 20_000) ||
      (typeof raw?.revisedText === "string" && raw.revisedText.trim().length > 20_000)
    ) {
      throw new AiRequestError("AI 回复长度超过 20000 字符，请要求分段回答或缩短本轮内容后重试。");
    }
    if (raw?.kind === "revision") {
      const { deliverableType, ...reply } = ConversationRevisionOutputSchema.parse(raw);
      return { reply, deliverableType };
    }
    return { reply: TextPolishAssistantReplySchema.parse(raw), deliverableType: null };
  } catch (error) {
    if (error instanceof IncompatibleModelError || error instanceof AiRequestError) throw error;
    throw new IncompatibleModelError("连续对话");
  }
}

type TextPolishSummaryOutput = Omit<TextPolishConversationSummary, "summaryId">;

function parseSummaryOutput(content: string): TextPolishSummaryOutput {
  if (!content.trim()) throw new AiRequestError("AI 本轮未返回摘要，原有对话已保留，请重试本轮。");
  try {
    return TextPolishSummaryOutputSchema.parse(JSON.parse(content));
  } catch {
    throw new AiRequestError("AI 本轮摘要格式或长度不符合要求，原有对话已保留，请重试本轮。");
  }
}

function mapContextWindowError(error: unknown): unknown {
  if (error instanceof ContextWindowExceededError) return error;
  if (error instanceof AiRequestError && error.reason === "context-window")
    return new ContextWindowExceededError();
  if (
    error instanceof Error &&
    /context(?:[_ -]?length| window)|maximum context|too many tokens|prompt is too long/iu.test(
      error.message,
    )
  ) {
    return new ContextWindowExceededError();
  }
  return error;
}

function emitBoundedDelta(delta: string, emit: (value: string) => void): void {
  let offset = 0;
  while (offset < delta.length) {
    let end = Math.min(offset + 4_000, delta.length);
    if (end < delta.length && /[\uD800-\uDBFF]/u.test(delta[end - 1] ?? "")) end -= 1;
    emit(delta.slice(offset, end));
    offset = end;
  }
}

export class OpenAiCompatibleProvider {
  constructor(
    private readonly postJson: PostJson,
    private readonly postSse?: PostSse,
    private readonly onCorrectionResponse?: (diagnostic: CorrectionResponseDiagnostic) => void,
  ) {}

  async converseTextPolish(input: {
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
  }): Promise<TextPolishAssistantReply> {
    input.signal.throwIfAborted();
    const startedAt = Date.now();
    const output = await this.#requestStructured({
      ...input,
      messages: buildTextPolishConversationMessages(input),
      operation: "连续对话",
      parse: parseConversationOutput,
    });
    input.signal.throwIfAborted();
    if (output.deliverableType !== "patent-abstract" || output.reply.kind !== "revision") {
      return output.reply;
    }
    const characterCount = countUnicodeCharacters(output.reply.revisedText);
    if (characterCount <= 300) return output.reply;

    const timeoutMs = input.timeoutMs - (Date.now() - startedAt);
    if (timeoutMs <= 0) throw new AiRequestError("AI 服务请求超时，未能完成摘要压缩，请重试本轮。");
    const instruction =
      "请只压缩下面本轮正式说明书摘要，全部文字包括标点不得超过300个Unicode字符。保留主要技术内容，不新增事实，不要截断，不返回其他章节。必须同时遵守本轮要求和仍有效的历史约束，历史要求按时间顺序提供，较新要求优先；不要因缩短而丢失用户明确要求保留的内容。返回 revision，deliverableType 必须为 patent-abstract；不要改成讨论稿或解释回答。";
    const userRequirements = input.messages.flatMap((message) =>
      message.role === "user" ? [message.text] : [],
    );
    const initialRequirement = input.source.kind === "generation" ? input.source.requirement : "";
    const requirementCharacters = [
      initialRequirement,
      ...userRequirements,
      input.instruction,
      ...(input.summary?.items.flatMap((item) => [item.text, ...item.evidenceQuotes]) ?? []),
    ].reduce((total, text) => total + text.length, 0);
    if (
      output.reply.revisedText.length + instruction.length + requirementCharacters >
      (input.maxUploadCharacters ?? 50_000)
    ) {
      throw new AiRequestError("摘要超过300字，压缩请求将超过上传上限；请缩短任务后重试。");
    }
    input.onPhase?.("structuring");
    const repaired = await this.#requestStructured({
      ...input,
      timeoutMs,
      messages: [
        buildTextPolishConversationMessages(input)[0],
        {
          role: "user",
          content: JSON.stringify({
            instruction,
            actualCharacters: characterCount,
            untrustedDraft: output.reply.revisedText,
            untrustedInitialRequirement: initialRequirement,
            untrustedUserRequirements: userRequirements,
            untrustedSummary: input.summary,
            untrustedCurrentInstruction: input.instruction,
          }),
        },
      ],
      operation: "连续对话",
      parse: parseConversationOutput,
    }).catch((error: unknown) => {
      // A compression overflow must not trigger the service's full-turn retry.
      if (error instanceof ContextWindowExceededError) {
        throw new AiRequestError("摘要压缩请求超过模型容量，当前对话已保留，请重试本轮。");
      }
      throw error;
    });
    input.signal.throwIfAborted();
    if (
      repaired.deliverableType !== "patent-abstract" ||
      repaired.reply.kind !== "revision" ||
      countUnicodeCharacters(repaired.reply.revisedText) > 300
    ) {
      throw new AiRequestError("摘要压缩后仍未满足300字要求，未截断文字，请重试本轮或调整需求。");
    }
    return repaired.reply;
  }

  async summarizeTextPolishConversation(input: {
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
  }): Promise<TextPolishSummaryOutput> {
    return await this.#requestStructured({
      ...input,
      messages: buildTextPolishSummaryMessages(input),
      operation: "会话摘要",
      parse: parseSummaryOutput,
    });
  }

  async #requestStructured<T>(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    messages: readonly { role: "system" | "user"; content: string }[];
    operation: "连续对话" | "会话摘要";
    parse: (content: string) => T;
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<T> {
    const endpoint = new URL(
      "chat/completions",
      input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
    );
    const commonBody = {
      model: input.model,
      response_format: { type: "json_object" },
      messages: input.messages,
    };
    if (input.providerId === "deepseek" && input.thinkingEnabled) {
      if (!this.postSse) throw new IncompatibleModelError(input.operation);
      let content = "";
      let finishReason: string | null | undefined;
      try {
        await this.postSse(
          endpoint,
          {
            authorization: `Bearer ${input.apiKey}`,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            body: {
              ...commonBody,
              stream: true,
              thinking: { type: "enabled" },
              reasoning_effort: "high",
              max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
            },
          },
          (data) => {
            const event = OpenAiStreamDeltaSchema.parse(data);
            for (const { delta, finish_reason } of event.choices) {
              if (finish_reason) finishReason = finish_reason;
              if (delta.reasoning_content) {
                input.onPhase?.("thinking");
                emitBoundedDelta(delta.reasoning_content, (value) =>
                  input.onReasoningDelta?.(value),
                );
              }
              if (delta.content) {
                input.onPhase?.("structuring");
                content += delta.content;
              }
            }
          },
        );
      } catch (error) {
        const mapped = mapContextWindowError(error);
        if (mapped !== error) throw mapped;
        if (error instanceof z.ZodError) {
          throw new IncompatibleModelError(input.operation);
        }
        throw error;
      }
      if (finishReason === "length") throw new IncompleteModelOutputError(input.operation);
      return input.parse(content);
    }

    let response: unknown;
    try {
      response = await this.postJson(endpoint, {
        authorization: `Bearer ${input.apiKey}`,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        body: {
          ...commonBody,
          stream: false,
          ...(input.providerId === "deepseek"
            ? { thinking: { type: "disabled" }, max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS }
            : {}),
        },
      });
    } catch (error) {
      throw mapContextWindowError(error);
    }
    try {
      const choice = OpenAiResponseSchema.parse(response).choices[0];
      if (choice?.finish_reason === "length") throw new IncompleteModelOutputError(input.operation);
      return input.parse(choice?.message.content ?? "");
    } catch (error) {
      if (
        error instanceof AiRequestError ||
        error instanceof IncompleteModelOutputError ||
        error instanceof IncompatibleModelError
      ) {
        throw error;
      }
      throw new IncompatibleModelError(input.operation);
    }
  }

  async polish(input: {
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
  }): Promise<string> {
    const operation = input.mode === "generation" ? "生成" : "润色";
    const endpoint = new URL(
      "chat/completions",
      input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
    );
    const commonBody = {
      model: input.model,
      response_format: { type: "json_object" },
      messages:
        input.mode === "generation"
          ? buildTextGenerationMessages(input.requirement)
          : buildTextPolishMessages(input.selectedText ?? "", input.requirement),
    };
    if (input.providerId === "deepseek" && input.thinkingEnabled) {
      if (!this.postSse) throw new IncompatibleModelError(operation);
      let content = "";
      let reasoningStarted = false;
      let contentStarted = false;
      let finishReason: string | null | undefined;
      await this.postSse(
        endpoint,
        {
          authorization: `Bearer ${input.apiKey}`,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          body: {
            ...commonBody,
            stream: true,
            thinking: { type: "enabled" },
            reasoning_effort: "high",
            max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
          },
        },
        (data) => {
          const event = OpenAiStreamDeltaSchema.parse(data);
          for (const { delta, finish_reason } of event.choices) {
            if (finish_reason) finishReason = finish_reason;
            if (delta.reasoning_content) {
              if (!reasoningStarted) {
                reasoningStarted = true;
                input.onPhase?.("thinking");
              }
              emitBoundedDelta(delta.reasoning_content, (value) => input.onReasoningDelta?.(value));
            }
            if (delta.content) {
              if (!contentStarted) {
                contentStarted = true;
                input.onPhase?.("structuring");
              }
              content += delta.content;
            }
          }
        },
      );
      if (finishReason === "length") throw new IncompleteModelOutputError(operation);
      return input.mode === "generation"
        ? parseTextGenerationOutput(content)
        : parseTextPolishOutput(content);
    }
    const response = await this.postJson(endpoint, {
      authorization: `Bearer ${input.apiKey}`,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      body: {
        ...commonBody,
        stream: false,
        ...(input.providerId === "deepseek"
          ? { thinking: { type: "disabled" }, max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS }
          : {}),
      },
    });
    try {
      const choice = OpenAiResponseSchema.parse(response).choices[0];
      if (choice?.finish_reason === "length") throw new IncompleteModelOutputError(operation);
      return input.mode === "generation"
        ? parseTextGenerationOutput(choice?.message.content ?? "")
        : parseTextPolishOutput(choice?.message.content ?? "");
    } catch (error) {
      if (
        error instanceof AiRequestError ||
        error instanceof IncompatibleModelError ||
        error instanceof IncompleteModelOutputError
      )
        throw error;
      throw new IncompatibleModelError(operation);
    }
  }

  async correct(input: {
    providerId: AiProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    thinkingEnabled: boolean;
    signal: AbortSignal;
    scopeKind: CorrectionPromptScopeKind;
    segments: readonly ProviderSegment[];
    onPhase?(phase: AiCorrectionPhase): void;
    onReasoningDelta?(delta: string): void;
  }): Promise<ProviderCorrectionResult> {
    const endpoint = new URL(
      "chat/completions",
      input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
    );
    const commonBody = {
      model: input.model,
      response_format: { type: "json_object" },
      messages: buildCorrectionMessages(input.scopeKind, input.segments),
    };
    if (input.providerId === "deepseek" && input.thinkingEnabled) {
      if (!this.postSse) throw new IncompatibleModelError();
      const deadline = Date.now() + input.timeoutMs;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        input.signal.throwIfAborted();
        if (attempt === 2) input.onPhase?.("retrying");
        input.signal.throwIfAborted();
        const remainingMs = attempt === 1 ? input.timeoutMs : deadline - Date.now();
        if (remainingMs <= 0)
          throw new AiRequestError("AI 本次检查已超时，未继续自动重试，请稍后重试。");
        let content = "";
        let reasoningCharacters = 0;
        let streamCompleted = false;
        let reasoningStarted = false;
        let contentStarted = false;
        let finishReason: string | null | undefined;
        try {
          await this.postSse(
            endpoint,
            {
              authorization: `Bearer ${input.apiKey}`,
              timeoutMs: remainingMs,
              signal: input.signal,
              body: {
                ...commonBody,
                stream: true,
                thinking: { type: "enabled" },
                reasoning_effort: "high",
                max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
              },
            },
            (data) => {
              const event = OpenAiStreamDeltaSchema.parse(data);
              for (const { delta, finish_reason } of event.choices) {
                if (finish_reason) finishReason = finish_reason;
                if (delta.reasoning_content) {
                  reasoningCharacters += delta.reasoning_content.length;
                  if (!reasoningStarted) {
                    reasoningStarted = true;
                    input.onPhase?.("thinking");
                  }
                  emitBoundedDelta(delta.reasoning_content, (value) =>
                    input.onReasoningDelta?.(value),
                  );
                }
                if (delta.content) {
                  if (!contentStarted) {
                    contentStarted = true;
                    input.onPhase?.("structuring");
                  }
                  content += delta.content;
                }
              }
            },
          );
          streamCompleted = true;
        } finally {
          this.onCorrectionResponse?.({
            attempt,
            finishReason: diagnosticFinishReason(finishReason),
            reasoningCharacters,
            contentCharacters: content.length,
            streamCompleted,
          });
        }
        input.signal.throwIfAborted();
        if (finishReason === "length") throw new IncompleteModelOutputError();
        if (!content.trim()) {
          if (attempt === 1 && finishReason === "stop") continue;
          throw new AiRequestError(
            `${reasoningCharacters > 0 ? "模型已输出思考过程，但未返回纠错结果。" : "AI 本次未返回纠错结果。"}${attempt === 2 ? "已自动重试一次，仍未收到正式纠错结果，请稍后重试。" : "未收到正常结束的正式答案，请稍后重试。"}`,
          );
        }
        return parseProviderOutput(content, input.segments);
      }
      throw new AiRequestError("AI 本次未返回纠错结果，请稍后重试。");
    }
    const response = await this.postJson(endpoint, {
      authorization: `Bearer ${input.apiKey}`,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      body: {
        ...commonBody,
        stream: false,
        ...(input.providerId === "deepseek"
          ? {
              thinking: { type: "disabled" },
              max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
            }
          : {}),
      },
    });
    try {
      const choice = OpenAiResponseSchema.parse(response).choices[0];
      if (choice?.finish_reason === "length") throw new IncompleteModelOutputError();
      const content = choice?.message.content;
      return parseProviderOutput(content ?? "", input.segments);
    } catch (error) {
      if (
        error instanceof AiRequestError ||
        error instanceof IncompatibleModelError ||
        error instanceof IncompleteModelOutputError
      )
        throw error;
      throw new IncompatibleModelError();
    }
  }
}
