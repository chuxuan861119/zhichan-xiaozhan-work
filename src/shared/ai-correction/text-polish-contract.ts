import { z } from "zod";
import { SessionIdSchema } from "../ipc/primitives.js";
import { LibraryPatentIdSchema, LibraryRevisionSchema } from "../library/model.js";
import { AiCorrectionBookKindSchema, AiCorrectionPhaseSchema, Sha256Schema } from "./contract.js";

export const TextPolishBlockSpanSchema = z
  .object({
    blockId: z.uuid(),
    blockType: z.enum(["paragraph", "heading", "object"]),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict()
  .refine((span) => span.endOffset >= span.startOffset, {
    message: "文本范围结束位置不能早于开始位置。",
    path: ["endOffset"],
  });
export type TextPolishBlockSpan = z.infer<typeof TextPolishBlockSpanSchema>;

export const TextPolishSelectionScopeSchema = z
  .object({
    kind: z.literal("selection"),
    formatVersion: z.literal(2).optional(),
    bookKind: AiCorrectionBookKindSchema,
    blocks: z.array(TextPolishBlockSpanSchema).min(1).max(1_000),
    selectedTextHash: Sha256Schema,
  })
  .strict()
  .refine((scope) => scope.blocks.some((span) => span.endOffset > span.startOffset), {
    message: "选中范围必须包含至少一个字符。",
    path: ["blocks"],
  });
export type TextPolishSelectionScope = z.infer<typeof TextPolishSelectionScopeSchema>;

export const TextPolishGenerationScopeSchema = z
  .object({
    kind: z.literal("generation"),
    bookKind: AiCorrectionBookKindSchema,
  })
  .strict();
export type TextPolishGenerationScope = z.infer<typeof TextPolishGenerationScopeSchema>;

export const TextPolishScopeSchema = z.discriminatedUnion("kind", [
  TextPolishSelectionScopeSchema,
  TextPolishGenerationScopeSchema,
]);
export type TextPolishScope = z.infer<typeof TextPolishScopeSchema>;

export const TextPolishStartRequestSchema = z
  .object({
    jobId: z.uuid(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
    scope: TextPolishScopeSchema,
    requirement: z.string().trim().max(2_000),
    uploadConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.scope.kind === "generation" && !request.requirement.trim()) {
      context.addIssue({
        code: "custom",
        message: "未选中正文时，请填写生成需求。",
        path: ["requirement"],
      });
    }
  });
export type TextPolishStartRequest = z.infer<typeof TextPolishStartRequestSchema>;

export const TextPolishStartResultSchema = z.object({ jobId: z.uuid() }).strict();
export type TextPolishStartResult = z.infer<typeof TextPolishStartResultSchema>;

export const TextPolishCancelRequestSchema = z.object({ jobId: z.uuid() }).strict();
export type TextPolishCancelRequest = z.infer<typeof TextPolishCancelRequestSchema>;

export const TextPolishAnchorSchema = z
  .object({
    formatVersion: z.literal(2).optional(),
    bookKind: AiCorrectionBookKindSchema,
    blocks: z.array(TextPolishBlockSpanSchema).min(1).max(1_000),
    originalText: z.string().min(1).max(20_000),
    originalTextHash: Sha256Schema,
  })
  .strict()
  .refine((anchor) => anchor.blocks.some((span) => span.endOffset > span.startOffset), {
    message: "文本范围必须包含至少一个字符。",
    path: ["blocks"],
  });
export type TextPolishAnchor = z.infer<typeof TextPolishAnchorSchema>;

export const TextPolishReplacementResultSchema = z
  .object({
    anchor: TextPolishAnchorSchema,
    polishedText: z.string().min(1).max(20_000),
  })
  .strict();
export type TextPolishReplacementResult = z.infer<typeof TextPolishReplacementResultSchema>;

export const TextPolishGeneratedResultSchema = z
  .object({
    kind: z.literal("generated"),
    generatedText: z.string().min(1).max(20_000),
  })
  .strict();
export type TextPolishGeneratedResult = z.infer<typeof TextPolishGeneratedResultSchema>;

export const TextPolishResultSchema = z.union([
  TextPolishReplacementResultSchema,
  TextPolishGeneratedResultSchema,
]);
export type TextPolishResult = z.infer<typeof TextPolishResultSchema>;

export const TextPolishCompletedEventSchema = z
  .object({
    type: z.literal("polish-completed"),
    jobId: z.uuid(),
    result: TextPolishResultSchema,
  })
  .strict();

export const TextPolishEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), jobId: z.uuid() }).strict(),
  z.object({ type: z.literal("phase"), jobId: z.uuid(), phase: AiCorrectionPhaseSchema }).strict(),
  z
    .object({
      type: z.literal("reasoning"),
      jobId: z.uuid(),
      delta: z.string().min(1).max(4_000),
    })
    .strict(),
  TextPolishCompletedEventSchema,
  z.object({ type: z.literal("failed"), jobId: z.uuid(), message: z.string().max(500) }).strict(),
  z.object({ type: z.literal("cancelled"), jobId: z.uuid() }).strict(),
]);
export type TextPolishEvent = z.infer<typeof TextPolishEventSchema>;

export const TEXT_POLISH_MAX_TURN_COUNT = 100;
export const TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES = 2 * 1024 * 1024;
export const TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS = 2_000;
export const TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS = 20_000;
export const TEXT_POLISH_MAX_SUMMARY_ITEM_CHARACTERS = 500;
export const TEXT_POLISH_MAX_SUMMARY_CHARACTERS = 8_000;

export const TextPolishConversationIdentitySchema = z
  .object({
    conversationId: z.uuid(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    bookKind: AiCorrectionBookKindSchema,
  })
  .strict();
export type TextPolishConversationIdentity = z.infer<typeof TextPolishConversationIdentitySchema>;

export const TextPolishConversationModelSchema = z
  .object({
    profileId: z.uuid(),
    providerId: z.string().trim().min(1).max(40),
    displayName: z.string().trim().min(1).max(120),
    baseUrl: z.url().max(2_048),
    model: z.string().trim().min(1).max(120),
  })
  .strict();
export type TextPolishConversationModel = z.infer<typeof TextPolishConversationModelSchema>;

export const TextPolishConversationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), anchor: TextPolishAnchorSchema }).strict(),
  z
    .object({
      kind: z.literal("generation"),
      requirement: z.string().trim().min(1).max(TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS),
      bookKind: AiCorrectionBookKindSchema.optional(),
    })
    .strict(),
]);
export type TextPolishConversationSource = z.infer<typeof TextPolishConversationSourceSchema>;

export const TextPolishRevisionReplySchema = z
  .object({
    kind: z.literal("revision"),
    message: z.string().trim().min(1).max(TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS),
    revisedText: z.string().trim().min(1).max(20_000),
  })
  .strict();
export const TextPolishClarificationReplySchema = z
  .object({
    kind: z.literal("clarification"),
    message: z.string().trim().min(1).max(TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS),
  })
  .strict();
export const TextPolishAnswerReplySchema = z
  .object({
    kind: z.literal("answer"),
    message: z.string().trim().min(1).max(TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS),
  })
  .strict();
export const TextPolishAssistantReplySchema = z.discriminatedUnion("kind", [
  TextPolishRevisionReplySchema,
  TextPolishClarificationReplySchema,
  TextPolishAnswerReplySchema,
]);
export type TextPolishAssistantReply = z.infer<typeof TextPolishAssistantReplySchema>;

export const TextPolishSummaryItemSchema = z
  .object({
    kind: z.enum([
      "requirement",
      "term",
      "resolved-question",
      "open-question",
      "rejected-direction",
      "context",
    ]),
    text: z.string().trim().min(1).max(TEXT_POLISH_MAX_SUMMARY_ITEM_CHARACTERS),
    sourceMessageIds: z.array(z.uuid()).min(1).max(8),
    evidenceQuotes: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.evidenceQuotes.length > item.sourceMessageIds.length) {
      context.addIssue({
        code: "custom",
        message: "摘要证据数量不能超过来源消息数量。",
        path: ["evidenceQuotes"],
      });
    }
  });

export const TextPolishConversationSummarySchema = z
  .object({
    summaryId: z.uuid(),
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
export type TextPolishConversationSummary = z.infer<typeof TextPolishConversationSummarySchema>;

const TextPolishConversationUserMessageSchema = z
  .object({
    role: z.literal("user"),
    messageId: z.uuid(),
    turnId: z.uuid(),
    text: z.string().trim().min(1).max(TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS),
    referenceText: z.string().max(20_000).optional(),
  })
  .strict();

const TextPolishConversationAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    messageId: z.uuid(),
    turnId: z.uuid(),
    reply: TextPolishAssistantReplySchema,
  })
  .strict();

export const TextPolishConversationSystemMessageSchema = z
  .object({
    role: z.literal("system"),
    messageId: z.uuid(),
    code: z.literal("context-compacted"),
    summaryId: z.uuid(),
    text: z.string().trim().min(1).max(500),
  })
  .strict();

export const TextPolishConversationMessageSchema = z.discriminatedUnion("role", [
  TextPolishConversationUserMessageSchema,
  TextPolishConversationAssistantMessageSchema,
  TextPolishConversationSystemMessageSchema,
]);
export type TextPolishConversationMessage = z.infer<typeof TextPolishConversationMessageSchema>;

export const TextPolishConversationActiveTurnSchema = z
  .object({
    turnId: z.uuid(),
    clientRequestId: z.uuid(),
    instruction: z.string().trim().min(1).max(TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS),
    status: z.enum(["preparing", "summarizing", "running"]),
    summaryBatch: z.number().int().positive().optional(),
  })
  .strict();
export type TextPolishConversationActiveTurn = z.infer<
  typeof TextPolishConversationActiveTurnSchema
>;

export const TextPolishConversationTurnOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), turnId: z.uuid() }).strict(),
  z
    .object({
      status: z.literal("failed"),
      turnId: z.uuid(),
      message: z.string().trim().min(1).max(500),
      retryable: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal("cancelled"), turnId: z.uuid() }).strict(),
]);
export type TextPolishConversationTurnOutcome = z.infer<
  typeof TextPolishConversationTurnOutcomeSchema
>;

const TextPolishConversationSnapshotCoreSchema = z
  .object({
    reasoningByTurn: z
      .record(z.uuid(), z.object({ text: z.string().max(20_000), truncated: z.boolean() }).strict())
      .optional(),
    conversationId: z.uuid(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    bookKind: AiCorrectionBookKindSchema,
    conversationRevision: z.number().int().nonnegative(),
    source: TextPolishConversationSourceSchema,
    model: TextPolishConversationModelSchema,
    messages: z
      .array(TextPolishConversationMessageSchema)
      .max(TEXT_POLISH_MAX_TURN_COUNT * 2 + TEXT_POLISH_MAX_TURN_COUNT),
    latestValidDraft: z.string().trim().max(20_000).nullable(),
    summary: TextPolishConversationSummarySchema.nullable(),
    activeTurn: TextPolishConversationActiveTurnSchema.nullable(),
    lastTurnOutcome: TextPolishConversationTurnOutcomeSchema.nullable(),
  })
  .strict();

export function conversationTextBytes(snapshot: {
  messages: readonly TextPolishConversationMessage[];
  latestValidDraft: string | null;
}) {
  const text = snapshot.messages
    .flatMap((message) => {
      if (message.role === "user") return [message.text, message.referenceText ?? ""];
      if (message.role === "system") return [message.text];
      return [
        message.reply.message,
        ...(message.reply.kind === "revision" ? [message.reply.revisedText] : []),
      ];
    })
    .concat(snapshot.latestValidDraft ?? "")
    .join("");
  return new TextEncoder().encode(text).byteLength;
}

export const TextPolishConversationSnapshotSchema =
  TextPolishConversationSnapshotCoreSchema.superRefine((snapshot, context) => {
    if (conversationTextBytes(snapshot) > TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "对话历史超过内存上限。",
        path: ["messages"],
      });
    }
  });
export type TextPolishConversationSnapshot = z.infer<typeof TextPolishConversationSnapshotSchema>;

export const TextPolishConversationStartRequestSchema = z
  .object({
    clientRequestId: z.uuid(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedPatentRevision: LibraryRevisionSchema,
    scope: TextPolishScopeSchema,
    instruction: z.string().trim().max(TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS),
    uploadConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.scope.kind === "generation" && !request.instruction.trim()) {
      context.addIssue({
        code: "custom",
        message: "未选中正文时，请填写生成需求。",
        path: ["instruction"],
      });
    }
  });
export type TextPolishConversationStartRequest = z.infer<
  typeof TextPolishConversationStartRequestSchema
>;

const TextPolishConversationSendBaseSchema = z.object({
  identity: TextPolishConversationIdentitySchema,
  expectedConversationRevision: z.number().int().nonnegative(),
  clientRequestId: z.uuid(),
});

export const TextPolishConversationSendRequestSchema = z.discriminatedUnion("kind", [
  TextPolishConversationSendBaseSchema.extend({
    kind: z.literal("new"),
    instruction: z.string().trim().min(1).max(TEXT_POLISH_MAX_USER_MESSAGE_CHARACTERS),
    referenceText: z.string().max(20_000).optional(),
  }).strict(),
  TextPolishConversationSendBaseSchema.extend({
    kind: z.literal("retry"),
    turnId: z.uuid(),
  }).strict(),
]);
export type TextPolishConversationSendRequest = z.infer<
  typeof TextPolishConversationSendRequestSchema
>;

export const TextPolishConversationStartResultSchema = z
  .object({
    conversationId: z.uuid(),
    turnId: z.uuid(),
    snapshot: TextPolishConversationSnapshotSchema,
  })
  .strict();
export type TextPolishConversationStartResult = z.infer<
  typeof TextPolishConversationStartResultSchema
>;

export const TextPolishConversationOperationResultSchema = z
  .object({ snapshot: TextPolishConversationSnapshotSchema })
  .strict();
export type TextPolishConversationOperationResult = z.infer<
  typeof TextPolishConversationOperationResultSchema
>;

export const TextPolishConversationCancelRequestSchema = z
  .object({
    identity: TextPolishConversationIdentitySchema,
    turnId: z.uuid(),
  })
  .strict();
export type TextPolishConversationCancelRequest = z.infer<
  typeof TextPolishConversationCancelRequestSchema
>;

export const TextPolishConversationResetRequestSchema = z
  .object({
    identity: TextPolishConversationIdentitySchema,
    expectedConversationRevision: z.number().int().nonnegative(),
  })
  .strict();
export type TextPolishConversationResetRequest = z.infer<
  typeof TextPolishConversationResetRequestSchema
>;

export const TextPolishConversationSnapshotRequestSchema = z
  .object({
    conversationId: z.uuid().optional(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    bookKind: AiCorrectionBookKindSchema,
  })
  .strict();
export type TextPolishConversationSnapshotRequest = z.infer<
  typeof TextPolishConversationSnapshotRequestSchema
>;

export const TextPolishInputDraftSchema = z
  .object({
    text: z.string().max(2_000),
    referenceText: z.string().max(20_000).optional(),
    presets: z.array(z.enum(["专业严谨", "精简表达", "通顺流畅", "统一术语", "消除歧义"])).max(5),
  })
  .strict();
export type TextPolishInputDraft = z.infer<typeof TextPolishInputDraftSchema>;
export const TextPolishWorkspaceRequestSchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    action: z.enum([
      "load",
      "open",
      "draft",
      "recover",
      "change-model",
      "rename",
      "delete",
      "stop",
      "continue-new",
    ]),
    conversationId: z.uuid().nullable(),
    draft: TextPolishInputDraftSchema.optional(),
    targetModel: TextPolishConversationModelSchema.optional(),
    expectedConversationRevision: z.number().int().nonnegative().optional(),
    title: z.string().trim().min(1).max(80).optional(),
    continuation: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type TextPolishWorkspaceRequest = z.infer<typeof TextPolishWorkspaceRequestSchema>;
export const TextPolishWorkspaceSchema = z
  .object({
    snapshot: TextPolishConversationSnapshotSchema.nullable(),
    draft: TextPolishInputDraftSchema,
    history: z.array(
      z
        .object({
          conversationId: z.uuid(),
          title: z.string(),
          updatedAt: z.string(),
          error: z.string().optional(),
          status: z.enum(["running", "completed", "failed", "cancelled", "idle"]).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type TextPolishWorkspace = z.infer<typeof TextPolishWorkspaceSchema>;

export const TextPolishConversationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      message: TextPolishConversationMessageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("summary"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      summary: TextPolishConversationSummarySchema,
      message: TextPolishConversationSystemMessageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("phase"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      turnId: z.uuid(),
      phase: AiCorrectionPhaseSchema,
      summaryBatch: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      turnId: z.uuid(),
      delta: z.string().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn-failed"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      turnId: z.uuid(),
      message: z.string().max(500),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn-cancelled"),
      conversationId: z.uuid(),
      conversationRevision: z.number().int().nonnegative(),
      turnId: z.uuid(),
    })
    .strict(),
]);
export type TextPolishConversationEvent = z.infer<typeof TextPolishConversationEventSchema>;
