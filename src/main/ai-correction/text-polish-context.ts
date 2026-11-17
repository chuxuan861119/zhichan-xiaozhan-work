import {
  TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES,
  type TextPolishConversationMessage,
  TextPolishConversationMessageSchema,
  type TextPolishConversationSource,
  TextPolishConversationSourceSchema,
  type TextPolishConversationSummary,
  TextPolishConversationSummarySchema,
} from "../../shared/ai-correction/text-polish-contract.js";
import { textPolishPromptSource } from "./text-polish-prompt.js";

const DEFAULT_MAX_ESTIMATED_CONTEXT_CHARACTERS = 80_000;
const DEFAULT_MAX_UPLOAD_CHARACTERS = 100_000;
const DEFAULT_SYSTEM_PROMPT_CHARACTERS = 4_000;
const DEFAULT_OUTPUT_RESERVE_CHARACTERS = 8_000;
const DEFAULT_RECENT_TURN_COUNT = 4;
const DEFAULT_MAX_SUMMARY_INPUT_CHARACTERS = 40_000;

export type TextPolishContextErrorCode =
  | "INVALID_SUMMARY"
  | "UPLOAD_LIMIT_EXCEEDED"
  | "CONTEXT_CAPACITY_EXCEEDED";

export class TextPolishContextError extends Error {
  readonly code: TextPolishContextErrorCode;

  constructor(code: TextPolishContextErrorCode, message: string) {
    super(message);
    this.name = "TextPolishContextError";
    this.code = code;
  }
}

export type TextPolishContextPackage = {
  referenceText?: string;
  source: TextPolishConversationSource;
  summary: TextPolishConversationSummary | null;
  latestValidDraft: string | null;
  messages: TextPolishConversationMessage[];
  instruction: string;
};

export type TextPolishContextBuildInput = {
  referenceText?: string;
  source: TextPolishConversationSource;
  messages: readonly TextPolishConversationMessage[];
  summary: TextPolishConversationSummary | null;
  latestValidDraft: string | null;
  instruction: string;
  activeTurnId?: string;
  maxEstimatedContextCharacters?: number;
  maxUploadCharacters?: number;
  systemPromptCharacters?: number;
  outputReserveCharacters?: number;
  recentTurnCount?: number;
  maxSummaryInputCharacters?: number;
  forceSummary?: boolean;
};

export type TextPolishContextBuildResult =
  | {
      kind: "ready";
      context: TextPolishContextPackage;
      estimatedContextCharacters: number;
    }
  | {
      kind: "needs-summary";
      context: TextPolishContextPackage;
      summaryMessages: TextPolishConversationMessage[];
      coveredThroughMessageId: string;
      estimatedContextCharacters: number;
    }
  | {
      kind: "upload-limit-exceeded";
      code: "UPLOAD_LIMIT_EXCEEDED";
      message: string;
    }
  | {
      kind: "capacity-failure";
      code: "CONTEXT_CAPACITY_EXCEEDED";
      message: string;
    };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function messageText(message: TextPolishConversationMessage): string {
  if (message.role === "user")
    return [message.text, message.referenceText ?? ""].filter(Boolean).join("\n");
  if (message.role === "system") return message.text;
  return [
    message.reply.message,
    ...(message.reply.kind === "revision" ? [message.reply.revisedText] : []),
  ].join("\n");
}

// Fragment only the temporary summary input. Persisted messages and their identities stay intact.
export function splitTextPolishSummaryMessages(
  messages: readonly TextPolishConversationMessage[],
  budget = 12_000,
): TextPolishConversationMessage[][] {
  if (!Number.isInteger(budget) || budget < 2) throw new Error("摘要分段预算无效。");
  const batches: TextPolishConversationMessage[][] = [];
  let batch: TextPolishConversationMessage[] = [];
  let size = 0;
  const push = (message: TextPolishConversationMessage, length: number) => {
    if (size + length > budget && batch.length) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(message);
    size += length;
  };
  for (const message of messages) {
    const text = messageText(message);
    if (text.length <= budget) {
      push(message, text.length);
      continue;
    }
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + budget, text.length);
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf("。", end - 1));
        if (boundary >= offset + Math.floor(budget / 2)) end = boundary + 1;
        else if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
      }
      const part = text.slice(offset, end);
      push(
        message.role === "assistant"
          ? { ...message, reply: { kind: "answer", message: part } }
          : message.role === "user"
            ? { role: "user", messageId: message.messageId, turnId: message.turnId, text: part }
            : { ...message, text: part },
        part.length,
      );
      offset = end;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function sourceText(source: TextPolishConversationSource): string {
  return source.kind === "generation" ? source.requirement : source.anchor.originalText;
}

function serializeEstimateInput(input: {
  referenceText?: string;
  source: TextPolishConversationSource;
  summary: TextPolishConversationSummary | null;
  latestValidDraft: string | null;
  messages: readonly TextPolishConversationMessage[];
  instruction: string;
}): string {
  return JSON.stringify({
    source: textPolishPromptSource(input.source),
    summary: input.summary,
    latestValidDraft: input.latestValidDraft,
    messages: input.messages,
    instruction: input.instruction,
    referenceText: input.referenceText,
  });
}

export function estimateTextPolishContextCharacters(input: {
  referenceText?: string;
  source: TextPolishConversationSource;
  summary: TextPolishConversationSummary | null;
  latestValidDraft: string | null;
  messages: readonly TextPolishConversationMessage[];
  instruction: string;
}): number {
  // This is deliberately a conservative, deterministic byte-based estimate, not a tokenizer.
  return Math.ceil(utf8ByteLength(serializeEstimateInput(input)) / 2);
}

function estimateWithOverhead(
  input: TextPolishContextPackage,
  systemPromptCharacters: number,
  outputReserveCharacters: number,
): number {
  return (
    estimateTextPolishContextCharacters(input) + systemPromptCharacters + outputReserveCharacters
  );
}

function summaryCoverageIndex(
  summary: TextPolishConversationSummary | null,
  messages: readonly TextPolishConversationMessage[],
): number {
  if (!summary?.coveredThroughMessageId) return -1;
  return messages.findIndex((message) => message.messageId === summary.coveredThroughMessageId);
}

type TurnMessage = Exclude<TextPolishConversationMessage, { role: "system" }>;

function groupTurns(messages: readonly TurnMessage[]) {
  const groups: Array<{ turnId: string; messages: TurnMessage[] }> = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (previous && previous.turnId === message.turnId) previous.messages.push(message);
    else groups.push({ turnId: message.turnId, messages: [message] });
  }
  return groups;
}

function invalidSummary(message: string): never {
  throw new TextPolishContextError("INVALID_SUMMARY", message);
}

export function validateTextPolishConversationSummary(
  summary: TextPolishConversationSummary,
  messages: readonly TextPolishConversationMessage[],
): TextPolishConversationSummary {
  const parsed = TextPolishConversationSummarySchema.safeParse(summary);
  if (!parsed.success) return invalidSummary("会话摘要结构无效，未应用摘要。");
  const byId = new Map(messages.map((message, index) => [message.messageId, { message, index }]));
  if (parsed.data.items.length > 0 && !parsed.data.coveredThroughMessageId) {
    return invalidSummary("会话摘要缺少覆盖范围。");
  }
  const coveredIndex = parsed.data.coveredThroughMessageId
    ? byId.get(parsed.data.coveredThroughMessageId)?.index
    : -1;
  if (coveredIndex === undefined) return invalidSummary("会话摘要覆盖范围无效。");
  if (coveredIndex >= 0 && parsed.data.items.length === 0) {
    return invalidSummary("会话摘要为空，未替代原有上下文，请重试。");
  }

  const referencedIds = new Set<string>();
  for (const item of parsed.data.items) {
    const itemIds = new Set<string>();
    for (const sourceMessageId of item.sourceMessageIds) {
      if (itemIds.has(sourceMessageId) || referencedIds.has(sourceMessageId)) {
        return invalidSummary("会话摘要包含重复来源消息。");
      }
      itemIds.add(sourceMessageId);
      referencedIds.add(sourceMessageId);
      const source = byId.get(sourceMessageId);
      if (!source || source.index > coveredIndex) {
        return invalidSummary("会话摘要引用了未覆盖的消息。");
      }
    }
    for (const quote of item.evidenceQuotes) {
      const matchesSource = [...itemIds].some((sourceMessageId) => {
        const source = byId.get(sourceMessageId);
        return source ? messageText(source.message).includes(quote) : false;
      });
      if (!matchesSource) return invalidSummary("会话摘要引文不是来源消息中的连续原文。");
    }
  }
  return parsed.data;
}

function buildPackage(
  input: TextPolishContextBuildInput,
  messages: readonly TextPolishConversationMessage[],
): TextPolishContextPackage {
  // Model summaries may omit requirements. Keep covered user instructions verbatim,
  // in chronological order, and charge them against the same context/upload limits.
  const coveredIndex = summaryCoverageIndex(input.summary, input.messages);
  const retainedIds = new Set(messages.map((message) => message.messageId));
  const completedTurns = new Set(
    input.messages.flatMap((message) => (message.role === "assistant" ? [message.turnId] : [])),
  );
  const protectedMessages = input.messages.filter(
    (message, index) =>
      retainedIds.has(message.messageId) ||
      (index <= coveredIndex &&
        message.role === "user" &&
        completedTurns.has(message.turnId) &&
        message.turnId !== input.activeTurnId),
  );
  return {
    source: TextPolishConversationSourceSchema.parse(input.source),
    ...(input.referenceText ? { referenceText: input.referenceText } : {}),
    summary: input.summary ? TextPolishConversationSummarySchema.parse(input.summary) : null,
    latestValidDraft: input.latestValidDraft,
    messages: protectedMessages.map((message) => {
      const parsed = TextPolishConversationMessageSchema.parse(message);
      if (parsed.role === "user" && !retainedIds.has(parsed.messageId)) {
        const { referenceText: _referenceText, ...instructionOnly } = parsed;
        return instructionOnly;
      }
      if (
        parsed.role === "assistant" &&
        parsed.reply.kind === "revision" &&
        parsed.reply.revisedText === input.latestValidDraft
      ) {
        return {
          ...parsed,
          reply: {
            kind: "answer" as const,
            message: parsed.reply.message,
          },
        };
      }
      return parsed;
    }),
    instruction: input.instruction.trim(),
  };
}

export function buildTextPolishContext(
  input: TextPolishContextBuildInput,
): TextPolishContextBuildResult {
  const source = TextPolishConversationSourceSchema.parse(input.source);
  const messages = input.messages.map((message) =>
    TextPolishConversationMessageSchema.parse(message),
  );
  const summary = input.summary
    ? validateTextPolishConversationSummary(input.summary, messages)
    : null;
  const instruction = input.instruction.trim();
  const activeTurnId = input.activeTurnId;
  const completedTurnIds = new Set(
    messages.flatMap((message) => (message.role === "assistant" ? [message.turnId] : [])),
  );
  const history: TurnMessage[] = messages.filter(
    (message): message is TurnMessage =>
      message.role !== "system" &&
      message.turnId !== activeTurnId &&
      completedTurnIds.has(message.turnId),
  );
  const maxUploadCharacters = input.maxUploadCharacters ?? DEFAULT_MAX_UPLOAD_CHARACTERS;
  const uploadCharacters = (context: TextPolishContextPackage) =>
    [
      sourceText(context.source),
      ...context.messages.map(messageText),
      context.latestValidDraft ?? "",
      context.instruction,
      context.referenceText ?? "",
      ...(context.summary?.items.flatMap((item) => [item.text, ...item.evidenceQuotes]) ?? []),
    ].reduce((total, text) => total + text.length, 0);

  const maxEstimatedContextCharacters =
    input.maxEstimatedContextCharacters ?? DEFAULT_MAX_ESTIMATED_CONTEXT_CHARACTERS;
  const systemPromptCharacters = input.systemPromptCharacters ?? DEFAULT_SYSTEM_PROMPT_CHARACTERS;
  const outputReserveCharacters =
    input.outputReserveCharacters ?? DEFAULT_OUTPUT_RESERVE_CHARACTERS;
  const coverageIndex = summaryCoverageIndex(summary, messages);
  const unsummarized = history.filter((message) => {
    const index = messages.findIndex((candidate) => candidate.messageId === message.messageId);
    return index > coverageIndex;
  });
  const fullPackage = buildPackage({ ...input, source, summary, instruction }, unsummarized);
  const fullEstimate = estimateWithOverhead(
    fullPackage,
    systemPromptCharacters,
    outputReserveCharacters,
  );
  if (
    !input.forceSummary &&
    fullEstimate <= maxEstimatedContextCharacters &&
    uploadCharacters(fullPackage) <= maxUploadCharacters
  ) {
    return { kind: "ready", context: fullPackage, estimatedContextCharacters: fullEstimate };
  }

  const groups = groupTurns(unsummarized);
  const recentTurnCount = Math.max(0, input.recentTurnCount ?? DEFAULT_RECENT_TURN_COUNT);
  const maxSummaryInputCharacters =
    input.maxSummaryInputCharacters ?? DEFAULT_MAX_SUMMARY_INPUT_CHARACTERS;
  let retainedGroups = recentTurnCount === 0 ? [] : groups.slice(-recentTurnCount);
  // Provider overflow is evidence that the estimate was optimistic. Always remove
  // at least one complete old turn, even when it fits our normal estimate.
  if (input.forceSummary && retainedGroups.length === groups.length) {
    retainedGroups = retainedGroups.slice(1);
  }
  while (retainedGroups.length > 0) {
    const retained = retainedGroups.flatMap((group) => group.messages);
    const retainedPackage = buildPackage({ ...input, source, summary, instruction }, retained);
    const retainedEstimate = estimateWithOverhead(
      retainedPackage,
      systemPromptCharacters,
      outputReserveCharacters,
    );
    if (
      retainedEstimate <= maxEstimatedContextCharacters &&
      uploadCharacters(retainedPackage) <= maxUploadCharacters
    )
      break;
    retainedGroups = retainedGroups.slice(1);
  }
  const retained = retainedGroups.flatMap((group) => group.messages);
  const retainedPackage = buildPackage({ ...input, source, summary, instruction }, retained);
  const retainedEstimate = estimateWithOverhead(
    retainedPackage,
    systemPromptCharacters,
    outputReserveCharacters,
  );
  if (uploadCharacters(retainedPackage) > maxUploadCharacters) {
    return {
      kind: "upload-limit-exceeded",
      code: "UPLOAD_LIMIT_EXCEEDED",
      message: "首次原文、最新稿、本轮要求与参考文字超过 AI 上传上限，请缩短材料或新建对话。",
    };
  }
  if (retainedEstimate > maxEstimatedContextCharacters) {
    return {
      kind: "capacity-failure",
      code: "CONTEXT_CAPACITY_EXCEEDED",
      message: "首次来源、本轮要求与参考文字无法安全放入模型上下文，请缩短材料或新建对话。",
    };
  }

  const retainedIds = new Set(retained.map((message) => message.messageId));
  const summaryCandidates = unsummarized.filter((message) => !retainedIds.has(message.messageId));
  const summaryGroups = groupTurns(summaryCandidates);
  const summaryMessages: TextPolishConversationMessage[] = [];
  for (const group of summaryGroups) {
    const candidate = [...summaryMessages, ...group.messages];
    const candidateCharacters = candidate.reduce(
      (total, message) => total + messageText(message).length,
      0,
    );
    const previousSummaryCharacters =
      summary?.items.reduce(
        (total, item) => total + item.text.length + item.evidenceQuotes.join("").length,
        0,
      ) ?? 0;
    // These are logical complete turns, not a single upload. The service splits
    // them and charges the evolving summary against each actual request budget.
    if (
      (summaryMessages.length > 0 || input.maxSummaryInputCharacters !== undefined) &&
      candidateCharacters + previousSummaryCharacters > maxSummaryInputCharacters
    )
      break;
    summaryMessages.push(...group.messages);
  }
  const coveredThroughMessageId = summaryMessages.at(-1)?.messageId;
  if (!coveredThroughMessageId) {
    return {
      kind: "capacity-failure",
      code: "CONTEXT_CAPACITY_EXCEEDED",
      message: "较早对话无法安全整理，请缩短任务或新建对话。",
    };
  }
  return {
    kind: "needs-summary",
    context: retainedPackage,
    summaryMessages,
    coveredThroughMessageId,
    estimatedContextCharacters: retainedEstimate,
  };
}

export const TEXT_POLISH_CONTEXT_MAX_BYTES = TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES;
